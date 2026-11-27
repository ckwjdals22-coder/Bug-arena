import "server-only";
import { z } from "zod";
import { Prisma, type Gender } from "@/generated/prisma/client";
import { env } from "@/lib/env";
import { maskEmail, normalizePhone } from "@/lib/format";
import { MINUTE, kstParts } from "@/lib/time";
import { audit } from "@/server/audit";
import { hashPassword, passwordPolicyError, verifyDummy, verifyPassword } from "@/server/auth/password";
import { revokeAllSessions } from "@/server/auth/session";
import { generateTotpSecret, totpCode, totpUri, verifyTotp } from "@/server/auth/totp";
import { prisma } from "@/server/db";
import { AppError, err, toActionError } from "@/server/errors";
import { decrypt, encrypt, randomToken, safeEqual, sha256 } from "@/server/security/crypto";
import { enforceRateLimit, refundRateLimit } from "@/server/security/rate-limit";
import { updateMarketingConsent } from "@/server/services/notifications";
import { enqueueMessage } from "@/server/services/notifications/outbox";

/**
 * 계정 서비스 — 가입·로그인·운영자 2단계 인증·비밀번호·프로필·탈퇴.
 * 쿠키·헤더를 읽지 않는다. 세션 발급과 IP 조회는 서버 액션(actions.ts)이 맡고, 여기서는 넘겨받은 값만 쓴다.
 * 로그인·재설정 요청은 계정이 있든 없든 같은 응답을 돌려준다(계정 존재 여부 추측 방지).
 */

export const MAX_FAILED_LOGINS = 10;
export const LOGIN_LOCK_MINUTES = 15;
export const PASSWORD_RESET_TTL_MINUTES = 30;
export const PASSWORD_RESET_TEMPLATE_KEY = "PLATFORM_PASSWORD_RESET";

const GENERIC_LOGIN_ERROR = "이메일 또는 비밀번호가 맞지 않아요.";
const LOCKED_ERROR = "로그인 시도가 많아 잠시 잠겼어요. 15분 뒤에 다시 시도해 주세요.";
const SUSPENDED_ERROR = "이용이 정지된 계정이에요. 고객센터로 문의해 주세요.";
const RESET_LINK_ERROR = "링크가 만료됐거나 이미 사용됐어요. 비밀번호 재설정을 다시 요청해 주세요.";
const TOTP_INVALID_ERROR = "인증 코드가 맞지 않아요. 인증 앱의 6자리 코드를 다시 확인해 주세요.";
const TOTP_STEP_MS = 30_000;
/** 재설정 요청의 최소 응답 시간 — 계정이 있을 때만 하는 작업이 소요 시간으로 드러나지 않게 한다. */
const RESET_REQUEST_MIN_MS = 300;

// ── 공통 ──────────────────────────────────────────────

/** zod 검증 실패를 필드별 메시지를 담은 VALIDATION 오류로 바꾼다. */
function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const { error } = toActionError(parsed.error);
  throw new AppError("VALIDATION", error.message, error.fieldErrors);
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** 계정 본인에 대한 인증 이벤트 감사 기록 */
const auditAccount = (actorType: "CUSTOMER" | "ADMIN", action: string, userId: string, meta?: Prisma.InputJsonObject) =>
  audit({ actorId: userId, actorType, action, targetType: "User", targetId: userId, meta });

/** 요청 제한 키에 넣을 IP. 알 수 없으면 한 묶음으로 센다. */
const clientKey = (ip: string) => (ip || "unknown").slice(0, 64);
/** 이메일은 요청 제한 키에 원문 대신 해시로 넣는다. */
const emailKey = (email: string) => sha256(email).slice(0, 32);

const currentKstYear = () => kstParts(new Date()).year;

const emailSchema = z
  .string("이메일을 입력해 주세요.")
  .trim()
  .toLowerCase()
  .min(1, "이메일을 입력해 주세요.")
  .max(254, "이메일 주소가 너무 길어요.")
  .pipe(z.email("이메일 주소를 확인해 주세요."));

const nameSchema = z
  .string("이름을 입력해 주세요.")
  .trim()
  .min(1, "이름을 입력해 주세요.")
  .max(30, "이름은 30자까지 쓸 수 있어요.")
  .regex(/^[^\p{Cc}]+$/u, "이름에 쓸 수 없는 문자가 있어요.");

/** 빈 문자열은 "번호 없음"(null)으로 본다. */
const phoneSchema = z
  .string("휴대전화 번호를 확인해 주세요.")
  .trim()
  .max(20, "휴대전화 번호를 확인해 주세요.")
  .transform((value, ctx) => {
    if (value === "") return null;
    const phone = normalizePhone(value);
    if (!phone) {
      ctx.addIssue({ code: "custom", message: "휴대전화 번호를 확인해 주세요." });
      return z.NEVER;
    }
    return phone;
  });

const genderSchema = z.enum(["MALE", "FEMALE"], "성별을 다시 골라 주세요.");

const birthYearSchema = z
  .number("출생 연도를 확인해 주세요.")
  .int("출생 연도를 확인해 주세요.")
  .refine((year) => year >= 1900 && year <= currentKstYear(), "출생 연도를 확인해 주세요.")
  .refine((year) => currentKstYear() - year >= 14, "만 14세 이상만 이용할 수 있어요.");

const passwordInputSchema = z.string("비밀번호를 입력해 주세요.").min(1, "비밀번호를 입력해 주세요.").max(200, "비밀번호는 72자 이하여야 해요.");

function assertPasswordPolicy(password: string, email: string, field: string): void {
  const reason = passwordPolicyError(password, { email });
  if (reason) throw err.validation(reason, { [field]: reason });
}

/** 저장된 해시가 깨져 있어도 예외 대신 불일치로 처리한다(계정마다 다른 오류가 새어 나가지 않게). */
async function passwordMatches(password: string, stored: string): Promise<boolean> {
  try {
    return await verifyPassword(password, stored);
  } catch {
    return false;
  }
}

// ── 가입 ──────────────────────────────────────────────

export interface SignUpInput {
  email: string;
  password: string;
  name: string;
  phone?: string | null;
  gender?: Gender | null;
  birthYear?: number | null;
  agreeTerms: boolean;
  agreePrivacy: boolean;
  /** 만 14세 이상 확인(개인정보 보호법상 법정대리인 동의 대상 제외) */
  agreeAge14: boolean;
  agreeMarketing?: boolean;
  ip: string;
}

const signUpSchema = z.object({
  email: emailSchema.refine((email) => !email.endsWith(".invalid"), "사용할 수 없는 이메일 주소예요."),
  password: passwordInputSchema,
  name: nameSchema,
  phone: phoneSchema.nullish(),
  gender: genderSchema.nullish(),
  birthYear: birthYearSchema.nullish(),
  agreeTerms: z.literal(true, "이용약관에 동의해 주세요."),
  agreePrivacy: z.literal(true, "개인정보 수집·이용에 동의해 주세요."),
  agreeAge14: z.literal(true, "만 14세 이상만 가입할 수 있어요."),
  agreeMarketing: z.boolean().optional(),
});

const duplicateEmail = () => new AppError("CONFLICT", "이미 가입된 이메일이에요.", { email: "이미 가입된 이메일이에요." });

export async function signUp(input: SignUpInput): Promise<{ userId: string }> {
  const data = parseInput(signUpSchema, input);
  assertPasswordPolicy(data.password, data.email, "password");
  // 형식 오류는 횟수에 넣지 않고, 가입 여부가 드러나는 중복 확인 앞에서 제한한다.
  await enforceRateLimit(`signup:ip:${clientKey(input.ip)}`, 10, 3600, "가입 시도가 너무 많아요. 잠시 후 다시 시도해 주세요.");

  const existing = await prisma.user.findUnique({ where: { email: data.email }, select: { id: true } });
  if (existing) throw duplicateEmail();

  const now = new Date();
  const passwordHash = await hashPassword(data.password);
  let userId: string;
  try {
    const user = await prisma.user.create({
      data: {
        email: data.email,
        passwordHash,
        name: data.name,
        phone: data.phone ?? null,
        gender: data.gender ?? null,
        birthYear: data.birthYear ?? null,
        termsAgreedAt: now,
        privacyAgreedAt: now,
        marketingConsentAt: data.agreeMarketing ? now : null,
      },
      select: { id: true },
    });
    userId = user.id;
  } catch (e) {
    // 같은 이메일로 동시에 들어온 가입
    if (isUniqueViolation(e)) throw duplicateEmail();
    throw e;
  }

  await auditAccount("CUSTOMER", "auth.signup", userId, { marketing: Boolean(data.agreeMarketing) });
  return { userId };
}

// ── 로그인 ────────────────────────────────────────────

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(200),
});

const invalidCredentials = () => new AppError("UNAUTHENTICATED", GENERIC_LOGIN_ERROR);
const accountLocked = () => new AppError("RATE_LIMITED", LOCKED_ERROR);

function parseCredentials(input: { email: unknown; password: unknown }): { email: string; password: string } {
  if (typeof input.email !== "string" || typeof input.password !== "string" || !input.email.trim() || !input.password) {
    throw err.validation("이메일과 비밀번호를 입력해 주세요.");
  }
  // 길이를 넘긴 값은 어차피 맞는 계정이 없으므로 같은 문구로 돌려보낸다.
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) throw invalidCredentials();
  return parsed.data;
}

const isLocked = (user: { lockedUntil: Date | null }, now: Date) => user.lockedUntil !== null && user.lockedUntil > now;

interface AttemptLimit {
  key: string;
  limit: number;
  windowSec: number;
  message?: string;
}

/**
 * 로그인 시도 제한. 검증 전에 먼저 세어 동시에 몰린 요청도 한도를 넘지 못하게 하고,
 * 로그인에 성공하면 돌려받은 함수로 이번 시도를 되돌려 실패한 시도만 횟수에 남긴다.
 * (같은 공유기·통신사 IP 를 쓰는 정상 로그인이 한도를 깎지 않게 하기 위함이다.)
 */
async function countLoginAttempt(limits: AttemptLimit[]): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  for (const l of limits) await enforceRateLimit(l.key, l.limit, l.windowSec, l.message);
  return async () => {
    for (const l of limits) await refundRateLimit(l.key, l.windowSec, startedAt);
  };
}

/**
 * 로그인 실패 1회를 기록하고, 한도에 이르면 계정을 잠근다. 이번 실패로 잠겼으면 true.
 * 지난 잠금이 풀린 뒤의 첫 실패는 1부터 다시 센다.
 */
async function recordFailedLogin(user: { id: string; lockedUntil: Date | null }, now: Date): Promise<boolean> {
  const lockExpired = user.lockedUntil !== null && user.lockedUntil <= now;
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: lockExpired ? { failedLoginCount: 1, lockedUntil: null } : { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  if (updated.failedLoginCount < MAX_FAILED_LOGINS) return false;
  await prisma.user.update({
    where: { id: user.id },
    data: { lockedUntil: new Date(now.getTime() + LOGIN_LOCK_MINUTES * MINUTE) },
  });
  return true;
}

async function recordLoginSuccess(userId: string, now: Date): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } });
}

/**
 * 회원 로그인 검증. 성공하면 회원 ID 를 돌려준다(세션 발급은 호출부).
 * - 없는 이메일·틀린 비밀번호·탈퇴 계정은 모두 같은 문구로 실패하고, 정지 안내는 비밀번호가 맞을 때만 보여 준다.
 * - 실패한 시도는 10분에 IP 당 20번·이메일당 10번까지, 한 계정에서 10번 틀리면 15분 동안 잠근다.
 */
export async function authenticate(input: { email: string; password: string; ip: string }): Promise<{ userId: string }> {
  const { email, password } = parseCredentials(input);
  const forgetAttempt = await countLoginAttempt([
    { key: `login:ip:${clientKey(input.ip)}`, limit: 20, windowSec: 600 },
    // 이메일 단위 제한은 계정이 있든 없든 잠금과 같은 문구로 막는다.
    { key: `login:email:${emailKey(email)}`, limit: 10, windowSec: 600, message: LOCKED_ERROR },
  ]);

  const now = new Date();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, status: true, lockedUntil: true },
  });

  if (!user || user.status === "WITHDRAWN") {
    await verifyDummy(password);
    await audit({ actorType: "CUSTOMER", action: "auth.login_failed", meta: { reason: "UNKNOWN_ACCOUNT", email: maskEmail(email) } });
    throw invalidCredentials();
  }
  if (isLocked(user, now)) throw accountLocked();

  if (!(await passwordMatches(password, user.passwordHash))) {
    const locked = await recordFailedLogin(user, now);
    await auditAccount("CUSTOMER", "auth.login_failed", user.id, { reason: "PASSWORD" });
    if (locked) await auditAccount("CUSTOMER", "auth.locked", user.id);
    throw invalidCredentials();
  }

  if (user.status === "SUSPENDED") {
    await auditAccount("CUSTOMER", "auth.login_failed", user.id, { reason: "SUSPENDED" });
    throw new AppError("FORBIDDEN", SUSPENDED_ERROR);
  }

  await recordLoginSuccess(user.id, now);
  await forgetAttempt();
  await auditAccount("CUSTOMER", "auth.login", user.id);
  return { userId: user.id };
}

// ── 운영자 로그인 · 2단계 인증 ────────────────────────

export type AdminAuthResult =
  /** 비밀번호는 맞았고, 인증 앱 코드를 함께 다시 보내야 한다. */
  | { status: "TOTP_REQUIRED" }
  /** mustSetupTotp 가 true 면 아직 2단계 인증을 등록하지 않은 계정이다(콘솔에서 등록을 강제해야 한다). */
  | { status: "OK"; userId: string; mustSetupTotp: boolean };

const totpInputSchema = z.string().trim().max(12).optional();

/** 유효한 코드면 그 코드가 속한 30초 구간 번호를, 아니면 null 을 돌려준다. */
function matchTotpStep(secret: string, code: string, at: number): number | null {
  if (!verifyTotp(secret, code, at)) return null;
  const normalized = code.replace(/\s/g, "");
  const current = Math.floor(at / TOTP_STEP_MS);
  for (const delta of [0, -1, 1]) {
    if (safeEqual(totpCode(secret, (current + delta) * TOTP_STEP_MS), normalized)) return current + delta;
  }
  return null;
}

/** 로그인에 쓴 코드 구간을 기록해 같은 코드의 재사용을 막는다. 처음 쓰는 구간이면 true (RFC 6238 §5.2) */
async function claimTotpStep(userId: string, step: number): Promise<boolean> {
  const result = await prisma.rateLimit.createMany({
    data: [{ key: `totp-used:${userId}`, windowStart: new Date(step * TOTP_STEP_MS), count: 1 }],
    skipDuplicates: true,
  });
  return result.count === 1;
}

/**
 * 운영자 로그인 검증. 운영자 권한이 없는 계정은 없는 계정과 똑같이 실패한다.
 * - 2단계 인증을 등록한 계정은 코드가 없으면 TOTP_REQUIRED 를 돌려주고, 코드가 틀리면 로그인 실패로 센다.
 * - 실패한 시도는 10분에 IP 당 5번·이메일당 10번까지. 계정 잠금은 회원 로그인과 같은 횟수를 함께 쓴다.
 */
export async function authenticateAdmin(input: { email: string; password: string; totp?: string; ip: string }): Promise<AdminAuthResult> {
  const { email, password } = parseCredentials(input);
  const totp = totpInputSchema.safeParse(input.totp);
  if (!totp.success) throw new AppError("UNAUTHENTICATED", TOTP_INVALID_ERROR, { totp: TOTP_INVALID_ERROR });
  const forgetAttempt = await countLoginAttempt([
    { key: `admin-login:ip:${clientKey(input.ip)}`, limit: 5, windowSec: 600 },
    { key: `admin-login:email:${emailKey(email)}`, limit: 10, windowSec: 600, message: LOCKED_ERROR },
  ]);

  const now = new Date();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, status: true, adminRole: true, lockedUntil: true, totpSecretEnc: true, totpEnabledAt: true },
  });

  if (!user || !user.adminRole || user.status !== "ACTIVE") {
    await verifyDummy(password);
    await audit({
      actorId: user?.id,
      actorType: "ADMIN",
      action: "admin.login_failed",
      meta: { reason: user ? "NOT_ADMIN" : "UNKNOWN_ACCOUNT", email: maskEmail(email) },
    });
    throw invalidCredentials();
  }
  if (isLocked(user, now)) throw accountLocked();

  const failed = async (reason: "PASSWORD" | "TOTP") => {
    const locked = await recordFailedLogin(user, now);
    await auditAccount("ADMIN", "admin.login_failed", user.id, { reason });
    if (locked) await auditAccount("ADMIN", "auth.locked", user.id);
  };

  if (!(await passwordMatches(password, user.passwordHash))) {
    await failed("PASSWORD");
    throw invalidCredentials();
  }

  // 등록을 끝낸(켜진) 비밀키가 있을 때만 2단계 인증을 요구한다.
  const totpSecretEnc = user.totpEnabledAt ? user.totpSecretEnc : null;
  const totpEnabled = totpSecretEnc !== null;
  if (totpSecretEnc) {
    if (!totp.data) {
      // 비밀번호는 맞았으므로 실패로 세지 않는다.
      await forgetAttempt();
      return { status: "TOTP_REQUIRED" };
    }
    const step = matchTotpStep(decrypt(totpSecretEnc), totp.data, now.getTime());
    if (step === null) {
      await failed("TOTP");
      throw new AppError("UNAUTHENTICATED", TOTP_INVALID_ERROR, { totp: TOTP_INVALID_ERROR });
    }
    if (!(await claimTotpStep(user.id, step))) {
      await auditAccount("ADMIN", "admin.login_failed", user.id, { reason: "TOTP_REUSED" });
      const message = "방금 사용한 인증 코드예요. 새 코드가 나오면 다시 입력해 주세요.";
      throw new AppError("UNAUTHENTICATED", message, { totp: message });
    }
  }

  await recordLoginSuccess(user.id, now);
  await forgetAttempt();
  await auditAccount("ADMIN", "admin.login", user.id, { role: user.adminRole, totp: totpEnabled });
  return { status: "OK", userId: user.id, mustSetupTotp: !totpEnabled };
}

async function loadActiveAdmin(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, status: true, adminRole: true, totpSecretEnc: true, totpEnabledAt: true },
  });
  if (!user || user.status !== "ACTIVE" || !user.adminRole) throw err.forbidden();
  return { ...user, adminRole: user.adminRole };
}

/**
 * 인증 앱 등록 시작: 새 비밀키를 암호화해 저장하고(아직 켜지지 않음) 등록용 값과 otpauth URI 를 돌려준다.
 * 비밀키 원문은 이 응답으로만 한 번 나가며 로그·감사 기록에 남기지 않는다.
 */
export async function beginTotpSetup(userId: string): Promise<{ secret: string; uri: string }> {
  await enforceRateLimit(`totp-setup:user:${userId}`, 10, 3600);
  const admin = await loadActiveAdmin(userId);
  if (admin.totpEnabledAt) {
    throw err.conflict("이미 2단계 인증을 쓰고 있어요. 다시 등록하려면 최고 관리자에게 초기화를 요청해 주세요.");
  }
  const secret = generateTotpSecret();
  const updated = await prisma.user.updateMany({
    where: { id: userId, totpEnabledAt: null },
    data: { totpSecretEnc: encrypt(secret) },
  });
  if (updated.count === 0) throw err.conflict("이미 2단계 인증을 쓰고 있어요.");
  await auditAccount("ADMIN", "admin.totp_setup", userId);
  return { secret, uri: totpUri(secret, admin.email) };
}

/** 인증 앱에 뜬 코드를 확인하고 2단계 인증을 켠다. */
export async function enableTotp(userId: string, code: string): Promise<void> {
  await enforceRateLimit(`totp-enable:user:${userId}`, 10, 600);
  const admin = await loadActiveAdmin(userId);
  if (admin.totpEnabledAt) throw err.conflict("이미 2단계 인증을 쓰고 있어요.");
  if (!admin.totpSecretEnc) throw err.validation("인증 앱 등록을 먼저 시작해 주세요.");
  if (typeof code !== "string" || code.length > 12 || !verifyTotp(decrypt(admin.totpSecretEnc), code)) {
    throw err.validation(TOTP_INVALID_ERROR, { code: TOTP_INVALID_ERROR });
  }
  // 확인하는 사이 비밀키가 바뀌었으면(등록을 다시 시작) 켜지 않는다.
  const updated = await prisma.user.updateMany({
    where: { id: userId, totpEnabledAt: null, totpSecretEnc: admin.totpSecretEnc },
    data: { totpEnabledAt: new Date() },
  });
  if (updated.count === 0) throw err.conflict("등록 정보가 바뀌었어요. 처음부터 다시 시도해 주세요.");
  await auditAccount("ADMIN", "admin.totp_enable", userId);
}

/**
 * 다른 운영자의 2단계 인증 초기화(기기 분실 등). 최고 관리자만 할 수 있고 본인 것은 풀 수 없다.
 * 대상의 운영자 세션을 모두 끊어, 다시 로그인해 새로 등록하게 한다.
 */
export async function disableTotp(adminId: string, targetUserId: string): Promise<void> {
  const actor = await loadActiveAdmin(adminId);
  if (actor.adminRole !== "SUPER") throw err.forbidden();
  if (adminId === targetUserId) {
    throw err.forbidden("본인의 2단계 인증은 직접 해제할 수 없어요. 다른 최고 관리자에게 요청해 주세요.");
  }
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, adminRole: true } });
  if (!target || !target.adminRole) throw err.notFound("운영자 계정을 찾을 수 없어요.");

  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({ where: { id: targetUserId }, data: { totpSecretEnc: null, totpEnabledAt: null } }),
    prisma.authSession.updateMany({ where: { userId: targetUserId, isAdmin: true, revokedAt: null }, data: { revokedAt: now } }),
  ]);
  await audit({ actorId: adminId, actorType: "ADMIN", action: "admin.totp_disable", targetType: "User", targetId: targetUserId });
}

// ── 비밀번호 ──────────────────────────────────────────

const changePasswordSchema = z.object({
  currentPassword: passwordInputSchema,
  newPassword: passwordInputSchema,
});

/** 비밀번호 변경. 지금 쓰는 세션(keepSessionId)만 남기고 다른 기기의 세션은 모두 끊는다. */
export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  keepSessionId?: string;
}): Promise<void> {
  const data = parseInput(changePasswordSchema, input);
  // 세션을 훔친 사람이 현재 비밀번호를 여러 번 넣어 보는 것을 막는다.
  await enforceRateLimit(`password-change:user:${input.userId}`, 10, 3600);

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, passwordHash: true, status: true },
  });
  if (!user || user.status !== "ACTIVE") throw err.notFound("회원 정보를 찾을 수 없어요.");
  if (!(await passwordMatches(data.currentPassword, user.passwordHash))) {
    throw err.validation("현재 비밀번호가 맞지 않아요.", { currentPassword: "현재 비밀번호가 맞지 않아요." });
  }
  if (data.newPassword.normalize("NFKC") === data.currentPassword.normalize("NFKC")) {
    const message = "새 비밀번호는 지금 쓰는 비밀번호와 달라야 해요.";
    throw err.validation(message, { newPassword: message });
  }
  assertPasswordPolicy(data.newPassword, user.email, "newPassword");

  const passwordHash = await hashPassword(data.newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } }),
    // 발급해 둔 재설정 링크도 함께 무효로 만든다.
    prisma.verificationToken.deleteMany({ where: { userId: user.id, type: "PASSWORD_RESET" } }),
  ]);
  await revokeAllSessions(user.id, input.keepSessionId);
  await auditAccount("CUSTOMER", "auth.password_change", user.id);
}

async function waitUntilElapsed(startedAt: number, minMs: number): Promise<void> {
  const remaining = minMs - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

/**
 * 비밀번호 재설정 메일 요청. 계정이 있든 없든 똑같이 끝난다(요청 제한도 입력한 이메일 기준이라 차이가 없다).
 * 계정이 있으면 이전 링크를 지우고 30분짜리 일회용 링크를 메일 대기열에 넣는다. DB 에는 토큰의 해시만 남긴다.
 */
export async function requestPasswordReset(input: { email: string; ip: string }): Promise<void> {
  const { email } = parseInput(z.object({ email: emailSchema }), input);
  const startedAt = Date.now();
  await enforceRateLimit(`password-reset:ip:${clientKey(input.ip)}`, 10, 3600);
  await enforceRateLimit(`password-reset:email:${emailKey(email)}`, 3, 3600);

  try {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true, status: true } });
    if (user && user.status === "ACTIVE") {
      const token = randomToken(32);
      await prisma.$transaction([
        prisma.verificationToken.deleteMany({ where: { userId: user.id, type: "PASSWORD_RESET" } }),
        prisma.verificationToken.create({
          data: {
            type: "PASSWORD_RESET",
            userId: user.id,
            target: email,
            tokenHash: sha256(token),
            expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * MINUTE),
          },
        }),
      ]);
      const link = `${env().APP_URL.replace(/\/+$/, "")}/reset-password?token=${token}`;
      await enqueueMessage({
        userId: user.id,
        channel: "EMAIL",
        recipient: email,
        templateKey: PASSWORD_RESET_TEMPLATE_KEY,
        subject: "[남는자리] 비밀번호 재설정 안내",
        body: [
          `${user.name}님, 비밀번호를 다시 설정하려면 아래 주소를 ${PASSWORD_RESET_TTL_MINUTES}분 안에 열어 주세요.`,
          link,
          "",
          "요청한 적이 없다면 이 메일은 무시해 주세요. 비밀번호는 바뀌지 않아요.",
        ].join("\n"),
      });
      await auditAccount("CUSTOMER", "auth.password_reset_request", user.id);
    }
  } catch (e) {
    // 계정이 있을 때만 생길 수 있는 오류이므로 응답으로 드러내지 않는다. 토큰·주소는 로그에 남기지 않는다.
    console.error("[auth] 비밀번호 재설정 메일 등록 실패", e instanceof Error ? e.name : "unknown");
  }
  await waitUntilElapsed(startedAt, RESET_REQUEST_MIN_MS);
}

const resetPasswordSchema = z.object({
  token: z.string(RESET_LINK_ERROR).min(20, RESET_LINK_ERROR).max(200, RESET_LINK_ERROR),
  newPassword: passwordInputSchema,
});

/**
 * 메일로 받은 링크의 토큰으로 새 비밀번호를 정한다. 토큰은 한 번만 쓸 수 있다.
 * 성공하면 로그인 잠금을 풀고 모든 기기에서 로그아웃시킨다.
 */
export async function resetPassword(input: { token: string; newPassword: string; ip?: string }): Promise<void> {
  const data = parseInput(resetPasswordSchema, input);
  if (input.ip !== undefined) await enforceRateLimit(`password-reset-confirm:ip:${clientKey(input.ip)}`, 10, 3600);

  const now = new Date();
  const record = await prisma.verificationToken.findUnique({
    where: { tokenHash: sha256(data.token) },
    select: { id: true, type: true, usedAt: true, expiresAt: true, user: { select: { id: true, email: true, status: true } } },
  });
  if (!record || record.type !== "PASSWORD_RESET" || record.usedAt || record.expiresAt <= now || record.user?.status !== "ACTIVE") {
    throw err.validation(RESET_LINK_ERROR);
  }
  const user = record.user;
  // 정책에 걸린 비밀번호로는 토큰을 쓰지 않는다(같은 링크로 다시 시도할 수 있게).
  assertPasswordPolicy(data.newPassword, user.email, "newPassword");

  const passwordHash = await hashPassword(data.newPassword);
  await prisma.$transaction(async (tx) => {
    // 동시에 들어온 두 요청 중 하나만 토큰을 차지한다.
    const claimed = await tx.verificationToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count === 0) throw err.validation(RESET_LINK_ERROR);
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
  });
  await revokeAllSessions(user.id);
  await auditAccount("CUSTOMER", "auth.password_reset", user.id);
}

// ── 프로필 · 수신 동의 ────────────────────────────────

export interface AccountProfile {
  email: string;
  name: string;
  nickname: string | null;
  phone: string | null;
  phoneVerified: boolean;
  gender: Gender | null;
  birthYear: number | null;
  /** 본인인증을 마쳤는지. true 면 이름·성별·출생 연도를 바꿀 수 없다. */
  identityVerified: boolean;
  marketingConsentAt: Date | null;
  nightAlertConsentAt: Date | null;
  noShowCount: number;
  bookingRestrictedUntil: Date | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

const accountSelect = {
  email: true,
  name: true,
  nickname: true,
  phone: true,
  phoneVerifiedAt: true,
  gender: true,
  birthYear: true,
  identityVerifiedAt: true,
  marketingConsentAt: true,
  nightAlertConsentAt: true,
  noShowCount: true,
  bookingRestrictedUntil: true,
  createdAt: true,
  lastLoginAt: true,
  status: true,
} satisfies Prisma.UserSelect;

type AccountRow = Prisma.UserGetPayload<{ select: typeof accountSelect }>;

function toAccountProfile(row: AccountRow): AccountProfile {
  return {
    email: row.email,
    name: row.name,
    nickname: row.nickname,
    phone: row.phone,
    phoneVerified: row.phoneVerifiedAt !== null,
    gender: row.gender,
    birthYear: row.birthYear,
    identityVerified: row.identityVerifiedAt !== null,
    marketingConsentAt: row.marketingConsentAt,
    nightAlertConsentAt: row.nightAlertConsentAt,
    noShowCount: row.noShowCount,
    bookingRestrictedUntil: row.bookingRestrictedUntil,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
  };
}

/** 내 정보 화면용 — 비밀번호 해시·인증 비밀키 같은 내부 값은 담지 않는다. */
export async function getAccount(userId: string): Promise<AccountProfile> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: accountSelect });
  if (!row || row.status === "WITHDRAWN") throw err.notFound("회원 정보를 찾을 수 없어요.");
  return toAccountProfile(row);
}

export interface ProfilePatch {
  name?: string;
  /** null 또는 빈 문자열이면 지운다. */
  nickname?: string | null;
  phone?: string | null;
  gender?: Gender | null;
  birthYear?: number | null;
}

const profileSchema = z
  .object({
    name: nameSchema,
    nickname: z
      .string("닉네임을 확인해 주세요.")
      .trim()
      .max(20, "닉네임은 20자까지 쓸 수 있어요.")
      .regex(/^[^\p{Cc}]*$/u, "닉네임에 쓸 수 없는 문자가 있어요.")
      .refine((v) => v.length === 0 || v.length >= 2, "닉네임은 2자 이상이어야 해요.")
      .nullable(),
    phone: phoneSchema.nullable(),
    gender: genderSchema.nullable(),
    birthYear: birthYearSchema.nullable(),
  })
  .partial();

const IDENTITY_LOCKED_ERROR = {
  name: "본인인증으로 확인한 이름은 바꿀 수 없어요.",
  gender: "본인인증으로 확인한 성별은 바꿀 수 없어요.",
  birthYear: "본인인증으로 확인한 출생 연도는 바꿀 수 없어요.",
} as const;

/**
 * 프로필 수정. 넘어온 항목만 바꾼다.
 * 본인인증을 마친 계정은 이름·성별·출생 연도를 바꿀 수 없고, 휴대전화 번호를 바꾸면 번호 인증이 풀린다.
 */
export async function updateProfile(userId: string, patch: ProfilePatch): Promise<AccountProfile> {
  const data = parseInput(profileSchema, patch);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true, name: true, phone: true, gender: true, birthYear: true, identityVerifiedAt: true },
  });
  if (!user || user.status !== "ACTIVE") throw err.notFound("회원 정보를 찾을 수 없어요.");

  if (user.identityVerifiedAt) {
    const fieldErrors: Record<string, string> = {};
    for (const field of ["name", "gender", "birthYear"] as const) {
      if (data[field] !== undefined && data[field] !== user[field]) {
        fieldErrors[field] = IDENTITY_LOCKED_ERROR[field];
      }
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw err.validation("본인인증을 마친 계정은 이름·성별·출생 연도를 바꿀 수 없어요.", fieldErrors);
    }
  }

  const update: Prisma.UserUpdateInput = {};
  if (data.name !== undefined) update.name = data.name;
  if (data.nickname !== undefined) update.nickname = data.nickname || null;
  if (data.gender !== undefined) update.gender = data.gender;
  if (data.birthYear !== undefined) update.birthYear = data.birthYear;
  if (data.phone !== undefined && data.phone !== user.phone) {
    update.phone = data.phone;
    update.phoneVerifiedAt = null;
  }
  const changed = Object.keys(update);
  if (changed.length === 0) return getAccount(userId);

  const row = await prisma.user.update({ where: { id: userId }, data: update, select: accountSelect });
  // 값은 남기지 않고 바뀐 항목 이름만 기록한다.
  await auditAccount("CUSTOMER", "user.profile_update", userId, { fields: changed });
  return toAccountProfile(row);
}

const consentsSchema = z
  .object({ marketing: z.boolean().optional(), nightAlert: z.boolean().optional() })
  .refine((v) => v.marketing !== undefined || v.nightAlert !== undefined, "바꿀 항목을 골라 주세요.");

/**
 * 광고성 정보·야간 알림 수신 동의 변경.
 * 실제 처리는 알림 모듈의 updateMarketingConsent 하나로 모은다 — 동의 시각 기록·철회 시 야간 동의와
 * 대기 중 광고 메시지 정리·처리 결과 통지·감사 기록(user.marketing_consent)이 그곳에서 함께 이뤄진다.
 */
export async function updateConsents(
  userId: string,
  input: { marketing?: boolean; nightAlert?: boolean },
): Promise<{ marketingConsentAt: Date | null; nightAlertConsentAt: Date | null }> {
  const data = parseInput(consentsSchema, input);
  const settings = await updateMarketingConsent(userId, {
    ...(data.marketing !== undefined ? { marketing: data.marketing } : {}),
    ...(data.nightAlert !== undefined ? { night: data.nightAlert } : {}),
  });
  return { marketingConsentAt: settings.marketingConsentAt, nightAlertConsentAt: settings.nightAlertConsentAt };
}

// ── 탈퇴 ──────────────────────────────────────────────

const WITHDRAWN_NAME = "탈퇴한 회원";

/**
 * 회원 탈퇴.
 * - 진행 중인 예약이 있거나, 대표로 있는 사업장에 열린 회차·진행 중인 예약이 있으면 거절한다.
 * - 개인정보는 지우고(이메일·이름·연락처·수신 동의·관심·알림), 예약·결제 기록은 전자상거래법 보관 의무에 따라 남긴다.
 * - 대표로 있던 사업장은 운영을 종료하고(심사 중이면 반려, 승인됐으면 이용 정지) 모든 사업장 소속을 정리한다.
 */
export async function withdrawAccount(input: { userId: string; password: string }): Promise<void> {
  const { password } = parseInput(z.object({ password: passwordInputSchema }), input);
  const userId = input.userId;
  await enforceRateLimit(`withdraw:user:${userId}`, 5, 3600);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true, status: true, adminRole: true },
  });
  if (!user || user.status !== "ACTIVE") throw err.notFound("회원 정보를 찾을 수 없어요.");
  if (!(await passwordMatches(password, user.passwordHash))) {
    throw err.validation("비밀번호가 맞지 않아요.", { password: "비밀번호가 맞지 않아요." });
  }
  if (user.adminRole) throw err.forbidden("운영자 계정은 탈퇴할 수 없어요. 최고 관리자에게 운영자 권한 해제를 먼저 요청해 주세요.");

  const now = new Date();
  const ownBooking = await prisma.booking.findFirst({
    where: {
      userId,
      slot: { endAt: { gt: now } },
      OR: [
        { status: { in: ["PENDING_APPROVAL", "CONFIRMED"] } },
        // 결제 대기는 좌석을 잡고 있는 동안만 진행 중으로 본다.
        { status: "PENDING_PAYMENT", OR: [{ holdExpiresAt: null }, { holdExpiresAt: { gt: now } }] },
      ],
    },
    select: { id: true },
  });
  if (ownBooking) {
    throw err.conflict("진행 중인 예약이 있어 탈퇴할 수 없어요. 예약을 이용하거나 취소한 뒤 다시 시도해 주세요.");
  }

  const owned = await prisma.businessMember.findMany({
    where: { userId, role: "OWNER" },
    select: { business: { select: { id: true, status: true } } },
  });
  const operatingIds = owned.filter((m) => m.business.status === "PENDING" || m.business.status === "APPROVED").map((m) => m.business.id);
  if (operatingIds.length > 0) {
    const [openSlot, liveBooking] = await Promise.all([
      prisma.slot.findFirst({ where: { businessId: { in: operatingIds }, status: "OPEN", endAt: { gt: now } }, select: { id: true } }),
      prisma.booking.findFirst({
        where: {
          businessId: { in: operatingIds },
          status: { in: ["PENDING_PAYMENT", "PENDING_APPROVAL", "CONFIRMED"] },
          slot: { endAt: { gt: now } },
        },
        select: { id: true },
      }),
    ]);
    if (openSlot || liveBooking) {
      throw err.conflict(
        "사업장에 열려 있는 회차나 진행 중인 예약이 있어 탈퇴할 수 없어요. 회차를 마감하고 예약을 정리한 뒤 다시 시도해 주세요.",
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.user.updateMany({
      where: { id: userId, status: "ACTIVE" },
      data: {
        email: `withdrawn+${userId}@deleted.invalid`,
        name: WITHDRAWN_NAME,
        nickname: null,
        phone: null,
        phoneVerifiedAt: null,
        gender: null,
        birthYear: null,
        identityVerifiedAt: null,
        // 어떤 비밀번호와도 맞지 않는 값
        passwordHash: `withdrawn$${randomToken(32)}`,
        totpSecretEnc: null,
        totpEnabledAt: null,
        marketingConsentAt: null,
        nightAlertConsentAt: null,
        notificationPrefs: Prisma.DbNull,
        failedLoginCount: 0,
        lockedUntil: null,
        status: "WITHDRAWN",
        withdrawnAt: now,
      },
    });
    if (claimed.count === 0) throw err.notFound("회원 정보를 찾을 수 없어요.");

    // 캐시된 찜·팔로워 수를 먼저 맞춘 뒤 행을 지운다.
    await tx.$executeRaw`
      UPDATE "Product" SET "favoriteCount" = GREATEST("favoriteCount" - 1, 0)
      WHERE "id" IN (SELECT "productId" FROM "Favorite" WHERE "userId" = ${userId})`;
    await tx.$executeRaw`
      UPDATE "Business" SET "followerCount" = GREATEST("followerCount" - 1, 0)
      WHERE "id" IN (SELECT "businessId" FROM "Follow" WHERE "userId" = ${userId})`;
    await tx.favorite.deleteMany({ where: { userId } });
    await tx.follow.deleteMany({ where: { userId } });
    await tx.alertRule.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });
    // 제안 중(OFFERED)인 대기는 좌석을 잡고 있으므로 지우지 않고 만료 처리에 맡긴다.
    await tx.waitlistEntry.deleteMany({ where: { userId, status: "WAITING" } });
    await tx.verificationToken.deleteMany({ where: { userId } });

    // 아직 보내지 않은 메시지는 보내지 않고, 발송 내역에 남은 연락처는 가린다.
    await tx.messageOutbox.updateMany({
      where: { userId, status: "QUEUED" },
      data: { status: "SKIPPED", error: "탈퇴한 회원이라 보내지 않았어요" },
    });
    await tx.messageOutbox.updateMany({ where: { userId }, data: { recipient: WITHDRAWN_NAME } });

    if (operatingIds.length > 0) {
      await tx.business.updateMany({
        where: { id: { in: operatingIds }, status: "PENDING" },
        data: { status: "REJECTED", rejectReason: "신청한 회원이 탈퇴했어요." },
      });
      await tx.business.updateMany({
        where: { id: { in: operatingIds }, status: "APPROVED" },
        data: { status: "SUSPENDED", suspendedReason: "대표 회원이 탈퇴해 운영을 종료했어요." },
      });
    }
    await tx.businessMember.deleteMany({ where: { userId } });
  });

  await revokeAllSessions(userId);
  await auditAccount("CUSTOMER", "user.withdraw", userId, { closedBusinessIds: operatingIds });
}
