import "server-only";
import { z } from "zod";
import { Prisma, type Gender } from "@/generated/prisma/client";
import { cookieSecure } from "@/lib/cookies";
import { env } from "@/lib/env";
import { MINUTE } from "@/lib/time";
import { audit } from "@/server/audit";
import { ACCOUNT_SUSPENDED_MESSAGE, signUpWithKakao } from "@/server/auth/account";
import { prisma } from "@/server/db";
import { AppError, type ErrorCode } from "@/server/errors";
import { decrypt, encrypt, randomToken, safeEqual } from "@/server/security/crypto";
import { notify } from "@/server/services/notifications";

/**
 * 카카오 로그인(외부 연동). KAKAO_CLIENT_ID 가 있을 때만 동작하고, 없으면 모든 진입점이 NOT_CONFIGURED 로 끝난다
 * (화면은 isKakaoEnabled() 가 false 면 버튼을 숨긴다).
 *
 * 흐름
 *   /api/auth/kakao/start    ─ state 쿠키 발급 ─▶ 카카오 동의 화면
 *   /api/auth/kakao/callback ─ state 확인 → 코드 교환 → 프로필 조회 → resolveKakaoLogin
 *        ├ 이미 연결된 회원 / 인증된 이메일이 같은 회원(연결) ─▶ 세션 발급
 *        └ 처음 온 카카오 계정 ─▶ 가입 대기 정보(암호화)를 쿠키에 담아 /signup/kakao 로
 *
 * 원칙
 * - 이메일은 카카오가 "유효하고 인증됨"으로 알려 준 것만 쓴다. 인증되지 않은 이메일로는 기존 회원에 연결하지도,
 *   새 회원을 만들지도 않는다(다른 사람의 이메일을 적어 계정을 선점하는 일을 막는다).
 * - 액세스 토큰·인가 코드·가입 대기 정보는 어디에도 기록하지 않는다(로그에는 상태 코드와 카카오 오류 코드만).
 * - 쿠키와 리다이렉트는 라우트 핸들러가 맡고, 이 파일의 함수는 넘겨받은 값만 쓴다.
 */

const AUTHORIZE_URL = "https://kauth.kakao.com/oauth/authorize";
const TOKEN_URL = "https://kauth.kakao.com/oauth/token";
const PROFILE_URL = "https://kapi.kakao.com/v2/user/me";
/** 동의 화면에서 요청하는 항목: 카카오계정 이메일, 닉네임 */
const SCOPES = "account_email,profile_nickname";
const REQUEST_TIMEOUT_MS = 10_000;

/** state 쿠키와 가입 대기 정보의 유효 시간(분) */
export const KAKAO_FLOW_TTL_MINUTES = 10;

// ── 실패 사유 ─────────────────────────────────────────

export const KAKAO_FAILURE_REASONS = [
  "not_configured",
  "cancelled",
  "state",
  "expired",
  "provider",
  "email_required",
  "suspended",
  "conflict",
  "rate_limited",
] as const;
export type KakaoFailureReason = (typeof KAKAO_FAILURE_REASONS)[number];

/** 로그인 화면에 그대로 보여 주는 안내. 콜백은 실패 사유를 /login?error=kakao_{사유} 로 넘긴다. */
export const KAKAO_FAILURE_MESSAGES: Record<KakaoFailureReason, string> = {
  not_configured: "카카오 로그인이 아직 연결되지 않았어요. 이메일로 로그인해 주세요.",
  cancelled: "카카오 로그인을 취소했어요. 다시 시도하거나 이메일로 로그인해 주세요.",
  state: "로그인 요청을 확인하지 못했어요. 카카오 로그인을 처음부터 다시 시도해 주세요.",
  expired: "로그인 시간이 지났어요. 카카오 로그인을 다시 시도해 주세요.",
  provider: "카카오 로그인 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.",
  email_required:
    "카카오 계정의 이메일을 확인하지 못했어요. 카카오에서 이메일 제공에 동의하고 이메일 인증을 마친 뒤 다시 시도하거나, 이메일로 가입해 주세요.",
  suspended: ACCOUNT_SUSPENDED_MESSAGE,
  conflict: "이 카카오 계정으로는 로그인할 수 없어요. 이메일과 비밀번호로 로그인해 주세요.",
  rate_limited: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
};

const FAILURE_CODE: Record<KakaoFailureReason, ErrorCode> = {
  not_configured: "NOT_CONFIGURED",
  cancelled: "VALIDATION",
  state: "VALIDATION",
  expired: "VALIDATION",
  provider: "INTERNAL",
  email_required: "VALIDATION",
  suspended: "FORBIDDEN",
  conflict: "CONFLICT",
  rate_limited: "RATE_LIMITED",
};

/** 카카오 로그인 실패. reason 은 화면 안내를 고르는 데 쓴다(AppError 이므로 서버 액션에서도 그대로 메시지가 나간다). */
export class KakaoAuthError extends AppError {
  readonly reason: KakaoFailureReason;

  constructor(reason: KakaoFailureReason, message: string = KAKAO_FAILURE_MESSAGES[reason]) {
    super(FAILURE_CODE[reason], message);
    this.reason = reason;
  }
}

/** 임의의 오류를 로그인 화면에 넘길 실패 사유로 바꾼다. */
export function kakaoFailureReason(e: unknown): KakaoFailureReason {
  if (e instanceof KakaoAuthError) return e.reason;
  if (e instanceof AppError) {
    if (e.code === "RATE_LIMITED") return "rate_limited";
    if (e.code === "NOT_CONFIGURED") return "not_configured";
    if (e.code === "CONFLICT") return "conflict";
  }
  return "provider";
}

/** 로그인 화면용: 주소의 error 값(kakao_{사유})에 해당하는 안내. 카카오 오류가 아니면 null */
export function kakaoFailureMessage(errorParam: string | null | undefined): string | null {
  if (!errorParam?.startsWith("kakao_")) return null;
  const reason = errorParam.slice("kakao_".length);
  return (KAKAO_FAILURE_REASONS as readonly string[]).includes(reason) ? KAKAO_FAILURE_MESSAGES[reason as KakaoFailureReason] : null;
}

// ── 설정 · 쿠키 ───────────────────────────────────────

export function isKakaoEnabled(): boolean {
  return Boolean(env().KAKAO_CLIENT_ID?.trim());
}

function clientId(): string {
  const id = env().KAKAO_CLIENT_ID?.trim();
  if (!id) throw new KakaoAuthError("not_configured");
  return id;
}

/** 카카오 디벨로퍼스에 등록해야 하는 Redirect URI. 요청의 Host 헤더가 아니라 APP_URL 로만 만든다. */
export function kakaoRedirectUri(): string {
  return `${env().APP_URL.replace(/\/+$/, "")}/api/auth/kakao/callback`;
}

/** 카카오 로그인 흐름에서 쓰는 쿠키 이름(HTTPS 에서는 __Host- 접두사) */
export function kakaoCookieNames(): { state: string; next: string; pending: string } {
  const prefix = cookieSecure() ? "__Host-" : "";
  return { state: `${prefix}nj_kakao_state`, next: `${prefix}nj_kakao_next`, pending: `${prefix}nj_kakao_pending` };
}

/** 위 쿠키의 공통 속성: HttpOnly, SameSite=Lax(카카오에서 돌아오는 최상위 이동에 실려야 한다), 10분 */
export function kakaoCookieOptions(): { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; maxAge: number } {
  return { httpOnly: true, secure: cookieSecure(), sameSite: "lax", path: "/", maxAge: KAKAO_FLOW_TTL_MINUTES * 60 };
}

// ── 카카오 API ────────────────────────────────────────

const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{20,200}$/);

/** 카카오 동의 화면 주소. state 는 호출부가 쿠키에 함께 심어 둔 무작위 값이어야 한다. */
export function buildKakaoAuthorizeUrl(input: { state: string; redirectUri: string }): string {
  const id = clientId();
  const state = stateSchema.safeParse(input.state);
  if (!state.success) throw new KakaoAuthError("state");
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state: state.data,
    scope: SCOPES,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface KakaoResponse {
  status: number;
  json: Record<string, unknown> | null;
}

/** 시간 제한이 있는 요청. 연결 실패·시간 초과는 provider 오류로 바꾼다(원인 객체에는 요청 정보가 섞일 수 있어 남기지 않는다). */
async function kakaoRequest(step: string, url: string, init: RequestInit): Promise<KakaoResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let status: number;
  let text: string;
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    status = res.status;
    text = await res.text();
  } catch {
    console.error(`[kakao] ${step} 요청 실패 — ${controller.signal.aborted ? "응답 시간 초과" : "연결 실패"}`);
    throw new KakaoAuthError("provider");
  } finally {
    clearTimeout(timer);
  }
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    // JSON 이 아닌 응답은 상태 코드만으로 판단한다.
  }
  return { status, json };
}

/** 로그에 남겨도 되는 카카오 오류 코드(예: invalid_grant, KOE320). 토큰·코드 값은 여기 들어오지 않는다. */
function kakaoErrorCode(json: Record<string, unknown> | null): string {
  const pick = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(value) ? value : null);
  return [pick(json?.error), pick(json?.error_code), typeof json?.code === "number" ? String(json.code) : null].filter(Boolean).join("/") || "-";
}

const tokenSchema = z.object({ access_token: z.string().min(1).max(4000) });

/** 인가 코드를 액세스 토큰으로 바꾼다. 코드가 만료됐거나 이미 쓰였으면 expired, 그 밖의 실패는 provider. */
export async function exchangeKakaoCode(code: string, redirectUri: string): Promise<string> {
  const id = clientId();
  if (typeof code !== "string" || code.length === 0 || code.length > 2000) throw new KakaoAuthError("expired");
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: id, redirect_uri: redirectUri, code });
  const secret = env().KAKAO_CLIENT_SECRET?.trim();
  if (secret) body.set("client_secret", secret);

  const res = await kakaoRequest("토큰 교환", TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: body.toString(),
  });
  const parsed = tokenSchema.safeParse(res.json);
  if (res.status === 200 && parsed.success) return parsed.data.access_token;

  console.error(`[kakao] 토큰 교환 실패 status=${res.status} code=${kakaoErrorCode(res.json)}`);
  throw new KakaoAuthError(res.json?.error === "invalid_grant" ? "expired" : "provider");
}

export interface KakaoProfile {
  /** 카카오 회원번호(숫자 문자열) */
  id: string;
  /** 카카오계정 이메일(소문자). 제공에 동의하지 않았으면 null */
  email: string | null;
  /** 카카오가 이 이메일을 유효하고 인증된 것으로 알려 줬는지 */
  emailVerified: boolean;
  nickname: string | null;
}

const kakaoMeSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^[0-9]{1,20}$/)]),
  kakao_account: z
    .object({
      email: z.string().max(254).nullish(),
      is_email_valid: z.boolean().nullish(),
      is_email_verified: z.boolean().nullish(),
      profile: z.object({ nickname: z.string().max(200).nullish() }).nullish(),
    })
    .nullish(),
  properties: z.object({ nickname: z.string().max(200).nullish() }).nullish(),
});

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** 액세스 토큰으로 카카오 회원번호·이메일(인증 여부)·닉네임을 읽는다. */
export async function fetchKakaoProfile(accessToken: string): Promise<KakaoProfile> {
  if (typeof accessToken !== "string" || accessToken.length === 0 || accessToken.length > 4000) throw new KakaoAuthError("provider");
  const res = await kakaoRequest("프로필 조회", PROFILE_URL, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } });
  const parsed = kakaoMeSchema.safeParse(res.json);
  if (res.status !== 200 || !parsed.success) {
    console.error(`[kakao] 프로필 조회 실패 status=${res.status} code=${kakaoErrorCode(res.json)}`);
    throw new KakaoAuthError("provider");
  }
  const account = parsed.data.kakao_account;
  const email = emailSchema.safeParse(account?.email ?? "");
  const nickname = (account?.profile?.nickname ?? parsed.data.properties?.nickname ?? "").trim();
  return {
    id: String(parsed.data.id),
    email: email.success ? email.data : null,
    emailVerified: email.success && account?.is_email_valid === true && account.is_email_verified === true,
    nickname: nickname ? nickname.slice(0, 100) : null,
  };
}

// ── 가입 대기 정보 ────────────────────────────────────

const pendingSchema = z.object({
  v: z.literal(1),
  kind: z.literal("kakao-signup"),
  kakaoId: z.string().regex(/^[0-9]{1,20}$/),
  email: z.email().max(254),
  nickname: z.string().max(100).nullable(),
  /** 만료 시각(ms) */
  exp: z.number().int().positive(),
});
type KakaoPending = z.infer<typeof pendingSchema>;

/** 가입 화면을 거치는 동안 브라우저(쿠키)에 맡겨 두는 값. AES-256-GCM 이라 내용을 읽거나 고칠 수 없다. */
function sealPending(data: Pick<KakaoPending, "kakaoId" | "email" | "nickname">): string {
  const payload: KakaoPending = { v: 1, kind: "kakao-signup", ...data, exp: Date.now() + KAKAO_FLOW_TTL_MINUTES * MINUTE };
  return encrypt(JSON.stringify(payload));
}

function openPending(token: unknown): KakaoPending | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 4000) return null;
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(decrypt(token)));
    return parsed.success && parsed.data.exp > Date.now() ? parsed.data : null;
  } catch {
    // 형식이 틀렸거나 변조된 값
    return null;
  }
}

/**
 * 가입 화면(/signup/kakao)에 미리 채워 줄 값. 대기 정보가 없거나 만료·변조됐으면 null(이때는 로그인 화면으로 돌려보낸다).
 * 카카오 회원번호는 내보내지 않는다.
 */
export function peekKakaoPending(pendingToken: string | null | undefined): { email: string; nickname: string | null; expiresAt: Date } | null {
  const pending = openPending(pendingToken);
  return pending ? { email: pending.email, nickname: pending.nickname, expiresAt: new Date(pending.exp) } : null;
}

// ── 로그인 판정 ───────────────────────────────────────

export type KakaoLoginResult =
  /** 로그인할 회원이 정해졌다. linked 가 true 면 이번에 기존 회원에 카카오 계정을 연결했다. */
  | { needsSignup: false; userId: string; linked: boolean }
  /** 처음 온 카카오 계정. pending 을 HttpOnly 쿠키에 담고 가입 화면으로 보낸다. */
  | { needsSignup: true; pending: string };

const profileSchema = z.object({
  id: z.string().regex(/^[0-9]{1,20}$/),
  email: emailSchema.nullable(),
  emailVerified: z.boolean(),
  nickname: z.string().max(100).nullable(),
});

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

interface LoginCandidate {
  id: string;
  status: string;
}

const auditLogin = (action: string, userId: string, meta: Prisma.InputJsonObject) =>
  audit({ actorId: userId, actorType: "CUSTOMER", action, targetType: "User", targetId: userId, meta });

/** 정지된 계정은 비밀번호 로그인과 같은 문구로 거절한다. */
async function assertCanLogin(user: LoginCandidate): Promise<void> {
  if (user.status === "ACTIVE") return;
  await auditLogin("auth.login_failed", user.id, { reason: user.status, method: "kakao" });
  throw new KakaoAuthError("suspended");
}

/** 로그인 성공 기록 */
async function finishLogin(user: LoginCandidate): Promise<string> {
  await assertCanLogin(user);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await auditLogin("auth.login", user.id, { method: "kakao" });
  return user.id;
}

/**
 * 인증된 이메일이 같은 기존 회원에 카카오 계정을 연결한다.
 * 연결은 "이 이메일의 주인임을 카카오가 확인했다"는 뜻이므로 비밀번호 재설정과 같은 무게로 다룬다:
 * 가입 때 이메일을 확인하지 않은 기존 비밀번호와 로그인돼 있던 세션을 모두 없앤다
 * (누군가 이 이메일로 미리 만들어 둔 계정에 주인이 연결되더라도, 먼저 만든 사람이 계속 드나들 수 없게 한다).
 * 비밀번호는 로그인 화면의 비밀번호 재설정으로 다시 만들 수 있다.
 */
async function linkExistingAccount(userId: string, kakaoId: string): Promise<boolean> {
  const now = new Date();
  const linked = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: userId, kakaoId: null, status: "ACTIVE", adminRole: null },
      data: { kakaoId, passwordHash: `social$${randomToken(32)}`, failedLoginCount: 0, lockedUntil: null },
    });
    if (updated.count === 0) return false;
    await tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await tx.verificationToken.deleteMany({ where: { userId, type: "PASSWORD_RESET" } });
    return true;
  });
  if (!linked) return false;

  await auditLogin("auth.kakao_link", userId, { passwordCleared: true });
  await notify({
    userId,
    type: "SYSTEM",
    title: "카카오 계정이 연결됐어요",
    body: [
      "이제 카카오로 로그인할 수 있어요.",
      "안전을 위해 예전 비밀번호는 더 이상 쓸 수 없고, 다른 기기에서는 로그아웃됐어요.",
      "비밀번호로도 로그인하려면 로그인 화면의 '비밀번호 재설정'으로 새 비밀번호를 만들어 주세요.",
    ].join("\n"),
    linkUrl: "/my",
    external: { channel: "EMAIL", templateKey: "PLATFORM_KAKAO_LINKED", essential: true },
  });
  return true;
}

/**
 * 카카오 프로필로 로그인할 회원을 정한다.
 * 1) 카카오 회원번호가 연결된 회원 → 그 회원
 * 2) 카카오가 유효·인증됨으로 알려 준 이메일과 같은 이메일의 회원 → 카카오 계정을 연결하고 그 회원
 *    (운영자 계정, 이미 다른 카카오 계정이 연결된 회원에는 연결하지 않는다)
 * 3) 그 밖 → 가입 대기 정보(10분, 암호화)를 돌려준다
 * 인증된 이메일이 없는 카카오 계정은 1)에 해당하지 않으면 email_required 로 거절한다.
 * 정지된 계정은 비밀번호 로그인과 같은 문구로 거절한다.
 */
export async function resolveKakaoLogin(input: KakaoProfile): Promise<KakaoLoginResult> {
  if (!isKakaoEnabled()) throw new KakaoAuthError("not_configured");
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) throw new KakaoAuthError("provider");
  const profile = parsed.data;

  const byKakao = await prisma.user.findUnique({ where: { kakaoId: profile.id }, select: { id: true, status: true } });
  if (byKakao) {
    if (byKakao.status !== "WITHDRAWN") return { needsSignup: false, userId: await finishLogin(byKakao), linked: false };
    // 탈퇴하면 연결을 끊으므로 남아 있을 수 없는 값이다. 남아 있다면 지우고 처음 온 계정으로 다룬다.
    await prisma.user.updateMany({ where: { id: byKakao.id, status: "WITHDRAWN" }, data: { kakaoId: null } });
  }

  if (!profile.email || !profile.emailVerified) throw new KakaoAuthError("email_required");

  const byEmail = await prisma.user.findUnique({
    where: { email: profile.email },
    select: { id: true, status: true, kakaoId: true, adminRole: true },
  });
  if (!byEmail) {
    return { needsSignup: true, pending: sealPending({ kakaoId: profile.id, email: profile.email, nickname: profile.nickname }) };
  }
  await assertCanLogin(byEmail);
  if (byEmail.adminRole) {
    throw new KakaoAuthError("conflict", "운영자 계정에는 카카오 로그인을 연결할 수 없어요. 이메일과 비밀번호로 로그인해 주세요.");
  }
  // 같은 카카오 계정의 로그인이 동시에 들어와 방금 연결이 끝난 경우
  if (byEmail.kakaoId === profile.id) return { needsSignup: false, userId: await finishLogin(byEmail), linked: false };
  if (byEmail.kakaoId) {
    throw new KakaoAuthError("conflict", "이 이메일은 다른 카카오 계정과 연결돼 있어요. 이메일과 비밀번호로 로그인해 주세요.");
  }

  let linked: boolean;
  try {
    linked = await linkExistingAccount(byEmail.id, profile.id);
  } catch (e) {
    // 같은 카카오 계정이 그사이 다른 회원에 연결됐다(동시에 들어온 로그인).
    if (!isUniqueViolation(e)) throw e;
    linked = false;
  }
  if (!linked) {
    const current = await prisma.user.findUnique({ where: { kakaoId: profile.id }, select: { id: true, status: true } });
    if (current && current.status !== "WITHDRAWN") return { needsSignup: false, userId: await finishLogin(current), linked: false };
    throw new KakaoAuthError("conflict");
  }
  return { needsSignup: false, userId: await finishLogin(byEmail), linked: true };
}

// ── 가입 완료 ─────────────────────────────────────────

export interface KakaoSignupInput {
  name: string;
  phone?: string | null;
  gender?: Gender | null;
  birthYear?: number | null;
  agreeTerms: boolean;
  agreePrivacy: boolean;
  /** 만 14세 이상 확인 — 이메일 가입과 똑같이 필수다 */
  agreeAge14: boolean;
  agreeMarketing?: boolean;
  agreeNightAlert?: boolean;
  ip: string;
}

/**
 * 가입 화면에서 받은 값으로 카카오 회원 가입을 끝낸다. 이메일과 카카오 회원번호는 화면 입력이 아니라
 * 가입 대기 정보(pendingToken)에서만 꺼낸다. 비밀번호 대신 쓸 수 없는 임의 값이 저장되고 동의 기록이 함께 남는다.
 * 대기 정보가 없거나 10분이 지났으면 expired 로 거절한다(카카오 로그인을 다시 하면 된다).
 */
export async function completeKakaoSignup(pendingToken: string, input: KakaoSignupInput): Promise<{ userId: string }> {
  if (!isKakaoEnabled()) throw new KakaoAuthError("not_configured");
  const pending = openPending(pendingToken);
  if (!pending) throw new KakaoAuthError("expired", "가입 시간이 지났어요. 카카오 로그인을 다시 시도해 주세요.");

  const { userId } = await signUpWithKakao({
    kakaoId: pending.kakaoId,
    email: pending.email,
    name: input.name,
    phone: input.phone,
    gender: input.gender,
    birthYear: input.birthYear,
    agreeTerms: input.agreeTerms,
    agreePrivacy: input.agreePrivacy,
    agreeAge14: input.agreeAge14,
    agreeMarketing: input.agreeMarketing,
    agreeNightAlert: input.agreeNightAlert,
    ip: input.ip,
  });
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  return { userId };
}

// ── 라우트 핸들러용 묶음 ──────────────────────────────

/** 로그인 시작: 무작위 state 와 카카오 동의 화면 주소. state 는 호출부가 HttpOnly 쿠키에 심는다. */
export function beginKakaoLogin(): { state: string; authorizeUrl: string } {
  const state = randomToken(24);
  return { state, authorizeUrl: buildKakaoAuthorizeUrl({ state, redirectUri: kakaoRedirectUri() }) };
}

export interface KakaoCallbackInput {
  /** 콜백 주소의 code */
  code: string | null;
  /** 콜백 주소의 state */
  state: string | null;
  /** 시작할 때 쿠키에 심어 둔 state */
  expectedState: string | null;
  /** 콜백 주소의 error(동의 화면에서 취소하면 access_denied) */
  error?: string | null;
}

/**
 * 카카오에서 돌아온 요청을 처리한다: state 확인(상수 시간 비교) → 코드 교환 → 프로필 조회 → 로그인 판정.
 * state 가 쿠키의 값과 다르면 어떤 외부 요청도 보내지 않고 거절한다(남이 만든 로그인 요청을 내 브라우저에서 끝내게 하는 공격 방지).
 */
export async function finishKakaoLogin(input: KakaoCallbackInput): Promise<KakaoLoginResult> {
  if (!isKakaoEnabled()) throw new KakaoAuthError("not_configured");
  const state = stateSchema.safeParse(input.state);
  const expected = stateSchema.safeParse(input.expectedState);
  if (!state.success || !expected.success || !safeEqual(state.data, expected.data)) throw new KakaoAuthError("state");
  if (input.error) throw new KakaoAuthError(input.error === "access_denied" ? "cancelled" : "provider");
  if (!input.code) throw new KakaoAuthError("expired");

  const accessToken = await exchangeKakaoCode(input.code, kakaoRedirectUri());
  const profile = await fetchKakaoProfile(accessToken);
  return resolveKakaoLogin(profile);
}
