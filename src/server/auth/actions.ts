"use server";

import "server-only";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import QRCode from "qrcode";
import { z } from "zod";
import { safeNextPath } from "@/lib/cookies";
import {
  authenticate,
  authenticateAdmin,
  beginTotpSetup,
  changePassword,
  enableTotp,
  requestPasswordReset,
  resetPassword,
  signUp,
  updateConsents,
  updateProfile,
  withdrawAccount,
  type AccountProfile,
} from "@/server/auth/account";
import { requireAdminOrThrow, requireUserOrThrow } from "@/server/auth/guards";
import { completeKakaoSignup, kakaoCookieNames, kakaoCookieOptions } from "@/server/auth/kakao";
import { createSession, destroySession, readSession } from "@/server/auth/session";
import { err, runAction, type ActionResult } from "@/server/errors";
import { getClientIp } from "@/server/request";
import { completeMockIdentity, type IdentityStatus } from "@/server/services/identity";

/**
 * 계정 관련 서버 액션 — 쿠키(세션)와 요청 정보(IP)는 여기서만 다루고, 검증·규칙은 account.ts 서비스가 맡는다.
 * 응답에는 화면에 필요한 값만 담는다(내부 ID·해시·토큰은 돌려주지 않는다).
 */

// 여기서는 값의 모양과 크기만 확인한다. 형식·정책 검증과 항목별 안내는 서비스가 한다.
const text = (max: number) => z.string().max(max);
const optionalText = (max: number) => text(max).nullish();

function parseShape<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw err.validation("입력값을 확인해 주세요.");
  return parsed.data;
}

const loginSchema = z.object({ email: text(254), password: text(200), next: optionalText(2000) });

/** 로그인. 성공하면 세션 쿠키를 심고 돌아갈 경로를 알려 준다. */
export async function loginAction(input: unknown): Promise<ActionResult<{ redirectTo: string }>> {
  return runAction(async () => {
    const data = parseShape(loginSchema, input);
    const { userId } = await authenticate({ email: data.email, password: data.password, ip: await getClientIp() });
    // 이전 세션을 끊고 새 토큰을 발급한다(세션 고정 방지).
    await destroySession("user");
    await createSession(userId, "user");
    return { redirectTo: safeNextPath(data.next) };
  });
}

const signupSchema = z.object({
  email: text(254),
  password: text(200),
  name: text(100),
  phone: optionalText(40),
  gender: z.enum(["MALE", "FEMALE"]).nullish(),
  birthYear: z.number().nullish(),
  agreeTerms: z.boolean(),
  agreePrivacy: z.boolean(),
  agreeAge14: z.boolean(),
  agreeMarketing: z.boolean().optional(),
  agreeNightAlert: z.boolean().optional(),
  next: optionalText(2000),
});

/** 가입. 성공하면 바로 로그인된 상태가 된다. */
export async function signupAction(input: unknown): Promise<ActionResult<{ redirectTo: string }>> {
  return runAction(async () => {
    const { next, ...data } = parseShape(signupSchema, input);
    const { userId } = await signUp({ ...data, ip: await getClientIp() });
    await destroySession("user");
    await createSession(userId, "user");
    return { redirectTo: safeNextPath(next) };
  });
}

const kakaoSignupSchema = z.object({
  name: text(100),
  phone: optionalText(40),
  gender: z.enum(["MALE", "FEMALE"]).nullish(),
  birthYear: z.number().nullish(),
  agreeTerms: z.boolean(),
  agreePrivacy: z.boolean(),
  agreeAge14: z.boolean(),
  agreeMarketing: z.boolean().optional(),
  agreeNightAlert: z.boolean().optional(),
});

/**
 * 카카오 가입 완료(/signup/kakao 화면의 제출). 이메일·카카오 계정은 콜백이 쿠키에 담아 둔 가입 대기 정보에서만 읽는다.
 * 성공하면 바로 로그인된 상태가 되고, 카카오 로그인을 시작할 때 가려던 경로를 돌려준다.
 * 대기 정보가 없거나 10분이 지났으면 실패한다 — 카카오 로그인을 다시 시작하도록 안내한다.
 */
export async function completeKakaoSignupAction(input: unknown): Promise<ActionResult<{ redirectTo: string }>> {
  return runAction(async () => {
    const data = parseShape(kakaoSignupSchema, input);
    const jar = await cookies();
    const names = kakaoCookieNames();
    const { userId } = await completeKakaoSignup(jar.get(names.pending)?.value ?? "", { ...data, ip: await getClientIp() });
    const redirectTo = safeNextPath(jar.get(names.next)?.value);
    const expired = { ...kakaoCookieOptions(), maxAge: 0 };
    jar.set(names.pending, "", expired);
    jar.set(names.next, "", expired);
    await destroySession("user");
    await createSession(userId, "user");
    return { redirectTo };
  });
}

export async function logoutAction(): Promise<ActionResult> {
  return runAction(async () => {
    await destroySession("user");
    return undefined;
  });
}

// ── 운영자 ────────────────────────────────────────────

const adminLoginSchema = z.object({ email: text(254), password: text(200), totp: optionalText(12) });

/**
 * 운영자 로그인.
 * - TOTP_REQUIRED: 비밀번호는 맞았다. 인증 앱 코드를 받아 같은 값에 totp 를 더해 다시 호출한다(세션은 아직 없다).
 * - OK: 운영자 세션을 발급했다. mustSetupTotp 가 true 면 2단계 인증 등록 화면으로 보내야 한다.
 */
export async function adminLoginAction(
  input: unknown,
): Promise<ActionResult<{ status: "OK" | "TOTP_REQUIRED"; mustSetupTotp: boolean }>> {
  return runAction(async () => {
    const data = parseShape(adminLoginSchema, input);
    const result = await authenticateAdmin({
      email: data.email,
      password: data.password,
      totp: data.totp ?? undefined,
      ip: await getClientIp(),
    });
    if (result.status === "TOTP_REQUIRED") return { status: "TOTP_REQUIRED" as const, mustSetupTotp: false };
    await destroySession("admin");
    await createSession(result.userId, "admin");
    return { status: "OK" as const, mustSetupTotp: result.mustSetupTotp };
  });
}

export async function adminLogoutAction(): Promise<ActionResult> {
  return runAction(async () => {
    await destroySession("admin");
    return undefined;
  });
}

/** 인증 앱 등록 시작. 직접 입력용 비밀키, otpauth 주소, 화면에 그대로 띄울 QR 이미지(data URL)를 돌려준다. */
export async function adminBeginTotpSetupAction(): Promise<ActionResult<{ secret: string; uri: string; qrDataUrl: string }>> {
  return runAction(async () => {
    const admin = await requireAdminOrThrow(undefined, { allowPendingTotp: true });
    const { secret, uri } = await beginTotpSetup(admin.user.id);
    const qrDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 2, width: 240 });
    return { secret, uri, qrDataUrl };
  });
}

const totpCodeSchema = z.object({ code: text(12) });

export async function adminEnableTotpAction(input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const admin = await requireAdminOrThrow(undefined, { allowPendingTotp: true });
    const { code } = parseShape(totpCodeSchema, input);
    await enableTotp(admin.user.id, code);
    revalidatePath("/admin", "layout");
    return undefined;
  });
}

// ── 비밀번호 ──────────────────────────────────────────

const resetRequestSchema = z.object({ email: text(254) });

/** 비밀번호 재설정 메일 요청. 가입 여부와 관계없이 같은 결과를 돌려준다. */
export async function requestPasswordResetAction(input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const { email } = parseShape(resetRequestSchema, input);
    await requestPasswordReset({ email, ip: await getClientIp() });
    return undefined;
  });
}

const resetSchema = z.object({ token: text(200), newPassword: text(200) });

/** 메일의 링크로 새 비밀번호 설정. 성공하면 모든 기기에서 로그아웃되므로 다시 로그인해야 한다. */
export async function resetPasswordAction(input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const data = parseShape(resetSchema, input);
    await resetPassword({ token: data.token, newPassword: data.newPassword, ip: await getClientIp() });
    return undefined;
  });
}

const changePasswordSchema = z.object({ currentPassword: text(200), newPassword: text(200) });

/** 비밀번호 변경. 지금 쓰는 세션만 남기고 다른 기기는 모두 로그아웃된다. */
export async function changePasswordAction(input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    // 운영자 콘솔에서 바꾸는 경우에는 운영자 세션을 남긴다.
    const session = (await readSession("user")) ?? (await readSession("admin"));
    if (!session) throw err.unauthenticated();
    const data = parseShape(changePasswordSchema, input);
    await changePassword({
      userId: session.user.id,
      currentPassword: data.currentPassword,
      newPassword: data.newPassword,
      keepSessionId: session.sessionId,
    });
    return undefined;
  });
}

// ── 프로필 · 동의 · 탈퇴 ──────────────────────────────

const profileSchema = z
  .object({
    name: text(100),
    nickname: text(100).nullable(),
    phone: text(40).nullable(),
    gender: z.enum(["MALE", "FEMALE"]).nullable(),
    birthYear: z.number().nullable(),
  })
  .partial();

export async function updateProfileAction(input: unknown): Promise<ActionResult<AccountProfile>> {
  return runAction(async () => {
    const user = await requireUserOrThrow();
    const profile = await updateProfile(user.id, parseShape(profileSchema, input));
    revalidatePath("/my", "layout");
    return profile;
  });
}

const consentsSchema = z.object({ marketing: z.boolean().optional(), nightAlert: z.boolean().optional() });

export async function updateConsentsAction(
  input: unknown,
): Promise<ActionResult<{ marketingConsentAt: Date | null; nightAlertConsentAt: Date | null }>> {
  return runAction(async () => {
    const user = await requireUserOrThrow();
    // 동의·철회 기록에 요청 IP 를 함께 남긴다.
    const consents = await updateConsents(user.id, parseShape(consentsSchema, input), { ip: await getClientIp() });
    revalidatePath("/my", "layout");
    return consents;
  });
}

const mockIdentitySchema = z.object({ name: text(100), birthYear: z.number(), gender: z.enum(["MALE", "FEMALE"]) });

/**
 * 시연·개발용 가짜 본인확인 완료. 실제 본인확인 기관이 연결되지 않은 동안 본인확인이 필요한 흐름을 보여 주는 데만 쓴다.
 * 운영 환경(시연 배포 제외)에서는 NOT_CONFIGURED 로 실패한다.
 */
export async function completeMockIdentityAction(input: unknown): Promise<ActionResult<IdentityStatus>> {
  return runAction(async () => {
    const user = await requireUserOrThrow();
    const status = await completeMockIdentity(user.id, parseShape(mockIdentitySchema, input));
    revalidatePath("/my", "layout");
    return status;
  });
}

const withdrawSchema = z.object({ password: text(200).optional(), confirmText: text(40).optional() });

/**
 * 회원 탈퇴. 성공하면 세션 쿠키도 지운다.
 * 비밀번호가 있는 계정은 password 를, 카카오로만 가입한 계정(AccountProfile.hasPassword = false)은
 * confirmText 에 확인 문구(WITHDRAW_CONFIRM_TEXT)를 보낸다.
 */
export async function withdrawAction(input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUserOrThrow();
    const { password, confirmText } = parseShape(withdrawSchema, input);
    await withdrawAccount({ userId: user.id, password, confirmText });
    await destroySession("user");
    return undefined;
  });
}
