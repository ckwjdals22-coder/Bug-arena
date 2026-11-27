import "server-only";
import { z } from "zod";
import type { Gender } from "@/generated/prisma/client";
import { env } from "@/lib/env";
import { audit } from "@/server/audit";
import { accountFieldSchemas } from "@/server/auth/account";
import { prisma } from "@/server/db";
import { AppError, err, toActionError } from "@/server/errors";
import { enforceRateLimit } from "@/server/security/rate-limit";

/**
 * 본인확인(외부 연동) 어댑터. 실제 본인확인 기관은 아직 연결돼 있지 않다.
 * - "none": 연결 안 됨. 본인확인을 시작할 수 없고, 화면에는 "준비 중"으로 표시한다.
 * - "mock": 시연·개발용 가짜 본인확인. 입력한 값을 그대로 확인된 값으로 저장한다(실제 확인이 아니다).
 *           운영 환경에서는 시연 배포(DEMO_MODE=1)일 때만 켜진다.
 * 본인확인을 마치면 identityVerifiedAt 이 채워지고 이름·성별·출생 연도가 확인된 값으로 고정된다
 * (이후 프로필 수정에서 바꿀 수 없다 — account.ts updateProfile).
 */

export type IdentityProviderName = "none" | "mock";

export function getIdentityProvider(): IdentityProviderName {
  const e = env();
  return e.DEMO_MODE === "1" || e.NODE_ENV !== "production" ? "mock" : "none";
}

/** 본인확인 기관이 확인해 준 값 */
export interface VerifiedIdentity {
  name: string;
  birthYear: number;
  gender: Gender;
}

/**
 * 실제 본인확인 기관 연동이 구현해야 하는 모양.
 * start 는 인증 창 주소를, complete 는 기관이 돌려준 값을 검증해 확인된 신원을 돌려준다.
 */
export interface IdentityProvider {
  start(userId: string): Promise<{ redirectUrl: string }>;
  complete(payload: unknown): Promise<VerifiedIdentity>;
}

const NOT_CONNECTED = "본인확인 서비스가 아직 연결되지 않았어요. 연결되면 이 화면에서 바로 인증할 수 있어요.";

/** 연결된 기관이 없는 동안의 자리 채움 — 어떤 호출이든 NOT_CONFIGURED 로 끝난다. */
const unconnectedProvider: IdentityProvider = {
  async start() {
    throw err.notConfigured(NOT_CONNECTED);
  },
  async complete() {
    throw err.notConfigured(NOT_CONNECTED);
  },
};

/** 실제 본인확인 기관 어댑터. 지금은 연결된 기관이 없어 호출하면 NOT_CONFIGURED 오류가 난다. */
export function getRealIdentityProvider(): IdentityProvider {
  return unconnectedProvider;
}

// ── 조회 ──────────────────────────────────────────────

export interface IdentityStatus {
  /** 본인확인을 마쳤는지 */
  verified: boolean;
  verifiedAt: Date | null;
  provider: IdentityProviderName;
  /** 지금 본인확인을 시작할 수 있는지(연결된 방법이 있고 아직 마치지 않았을 때) */
  canVerify: boolean;
  /** 가짜 본인확인인지 — 화면에 "시연용" 임을 반드시 표시한다 */
  isMock: boolean;
}

async function loadActiveUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true, identityVerifiedAt: true } });
  if (!user || user.status !== "ACTIVE") throw err.notFound("회원 정보를 찾을 수 없어요.");
  return user;
}

function toStatus(verifiedAt: Date | null): IdentityStatus {
  const provider = getIdentityProvider();
  return { verified: verifiedAt !== null, verifiedAt, provider, canVerify: provider !== "none" && verifiedAt === null, isMock: provider === "mock" };
}

/** 마이 > 본인확인 화면용 */
export async function getIdentityStatus(userId: string): Promise<IdentityStatus> {
  return toStatus((await loadActiveUser(userId)).identityVerifiedAt);
}

// ── 확인된 신원 반영 ──────────────────────────────────

const identitySchema = z.object({
  name: accountFieldSchemas.name,
  birthYear: accountFieldSchemas.birthYear,
  gender: accountFieldSchemas.gender,
});

const ALREADY_VERIFIED = "이미 본인확인을 마쳤어요.";

/**
 * 확인된 이름·출생 연도·성별을 회원 정보에 저장하고 고정한다. 본인확인은 계정당 한 번만 할 수 있다.
 * 감사 기록에는 값이 아니라 어떤 방법으로 확인했는지만 남긴다.
 */
async function applyVerifiedIdentity(userId: string, identity: VerifiedIdentity, via: "mock" | "provider"): Promise<IdentityStatus> {
  const parsed = identitySchema.safeParse(identity);
  if (!parsed.success) {
    const { error } = toActionError(parsed.error);
    throw new AppError("VALIDATION", error.message, error.fieldErrors);
  }
  const now = new Date();
  // 동시에 들어온 두 요청 중 하나만 반영한다.
  const updated = await prisma.user.updateMany({
    where: { id: userId, status: "ACTIVE", identityVerifiedAt: null },
    data: { identityVerifiedAt: now, name: parsed.data.name, birthYear: parsed.data.birthYear, gender: parsed.data.gender },
  });
  if (updated.count === 0) throw err.conflict(ALREADY_VERIFIED);

  await audit({ actorId: userId, actorType: "CUSTOMER", action: "user.identity_verify", targetType: "User", targetId: userId, meta: { via } });
  return toStatus(now);
}

// ── 가짜 본인확인(시연·개발) ──────────────────────────

/**
 * 가짜 본인확인을 끝낸다(provider 가 "mock" 일 때만). 입력한 이름·출생 연도·성별을 확인된 값으로 저장하고 고정한다.
 * 이미 본인확인을 마친 계정은 다시 할 수 없다.
 */
export async function completeMockIdentity(userId: string, input: { name: string; birthYear: number; gender: Gender }): Promise<IdentityStatus> {
  if (getIdentityProvider() !== "mock") throw err.notConfigured(NOT_CONNECTED);
  await enforceRateLimit(`identity-mock:user:${userId}`, 10, 3600);
  const user = await loadActiveUser(userId);
  if (user.identityVerifiedAt) throw err.conflict(ALREADY_VERIFIED);
  return applyVerifiedIdentity(userId, { name: input.name, birthYear: input.birthYear, gender: input.gender }, "mock");
}

// ── 실제 본인확인(미연결) ─────────────────────────────

/** 본인확인 기관의 인증 창으로 보낼 주소를 받는다. 연결된 기관이 없으면 NOT_CONFIGURED */
export async function startIdentityVerification(userId: string): Promise<{ redirectUrl: string }> {
  const user = await loadActiveUser(userId);
  if (user.identityVerifiedAt) throw err.conflict(ALREADY_VERIFIED);
  return getRealIdentityProvider().start(userId);
}

/** 본인확인 기관이 돌려준 값으로 본인확인을 끝낸다. 연결된 기관이 없으면 NOT_CONFIGURED */
export async function completeIdentityVerification(userId: string, payload: unknown): Promise<IdentityStatus> {
  await loadActiveUser(userId);
  const identity = await getRealIdentityProvider().complete(payload);
  return applyVerifiedIdentity(userId, identity, "provider");
}
