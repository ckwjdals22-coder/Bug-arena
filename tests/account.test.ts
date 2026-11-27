import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { kstParts } from "@/lib/time";
import {
  MAX_FAILED_LOGINS,
  PASSWORD_RESET_TEMPLATE_KEY,
  authenticate,
  authenticateAdmin,
  beginTotpSetup,
  changePassword,
  disableTotp,
  enableTotp,
  getAccount,
  requestPasswordReset,
  resetPassword,
  signUp,
  updateConsents,
  updateProfile,
  withdrawAccount,
  type SignUpInput,
} from "@/server/auth/account";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { totpCode } from "@/server/auth/totp";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import { decrypt, sha256 } from "@/server/security/crypto";
import { createBusiness, createListing, createProduct, createSlot, createUser, resetDb } from "./helpers";

const PASSWORD = "Namneun!2026";
const NEW_PASSWORD = "Jari#Left2027";
const GENERIC = "이메일 또는 비밀번호가 맞지 않아요.";
const LOCKED = "로그인 시도가 많아 잠시 잠겼어요. 15분 뒤에 다시 시도해 주세요.";

// 해시 계산은 일부러 느리므로 한 번만 만들어 여러 테스트에서 같이 쓴다.
let PASSWORD_HASH: string;
beforeAll(async () => {
  PASSWORD_HASH = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await resetDb();
});

let ipSeq = 0;
/** 테스트끼리 IP 단위 요청 제한이 겹치지 않도록 호출마다 다른 주소를 쓴다. */
const nextIp = () => `10.1.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

/** 실패해야 하는 호출의 AppError 를 꺼낸다. */
async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("실패해야 하는 호출이 성공했어요.");
}

const member = (overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) => createUser({ passwordHash: PASSWORD_HASH, ...overrides });

const signUpInput = (overrides: Partial<SignUpInput> = {}): SignUpInput => ({
  email: "haneul@example.com",
  password: PASSWORD,
  name: "김하늘",
  agreeTerms: true,
  agreePrivacy: true,
  agreeAge14: true,
  ip: nextIp(),
  ...overrides,
});

const auditActions = async (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

async function createSessionRow(userId: string, isAdmin = false) {
  return prisma.authSession.create({
    data: { tokenHash: sha256(randomBytes(32).toString("hex")), userId, isAdmin, expiresAt: new Date(Date.now() + 3_600_000) },
  });
}

/** 잠금 시간과 요청 제한 창이 모두 지난 상황을 만든다. */
async function letLockExpire(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { lockedUntil: new Date(Date.now() - 1000) } });
  await prisma.rateLimit.deleteMany();
}

type Listing = Awaited<ReturnType<typeof createListing>>;

async function createBooking(userId: string, listing: Listing, overrides: Partial<Prisma.BookingUncheckedCreateInput> = {}) {
  return prisma.booking.create({
    data: {
      code: `NJ-${randomBytes(4).toString("hex").toUpperCase()}`,
      userId,
      businessId: listing.business.id,
      productId: listing.product.id,
      slotId: listing.slot.id,
      slotSeatId: listing.seat.id,
      quantity: 1,
      unitPrice: 30000,
      totalAmount: 30000,
      payNowAmount: 30000,
      status: "CONFIRMED",
      paymentMethod: "ONLINE",
      paymentState: "PAID",
      guestName: "김하늘",
      guestPhone: "01012345678",
      policySnapshot: [],
      checkinToken: randomBytes(16).toString("hex"),
      ...overrides,
    },
  });
}

describe("signUp", () => {
  it("가입하면 이메일·전화번호를 정리해 저장하고 동의 시각을 기록한다", async () => {
    const { userId } = await signUp(
      signUpInput({ email: "  Haneul@Example.COM ", phone: "010-1234-5678", gender: "FEMALE", birthYear: 1995, agreeMarketing: true }),
    );
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.email).toBe("haneul@example.com");
    expect(user.phone).toBe("01012345678");
    expect(user.gender).toBe("FEMALE");
    expect(user.birthYear).toBe(1995);
    expect(user.status).toBe("ACTIVE");
    expect(user.termsAgreedAt).toBeInstanceOf(Date);
    expect(user.privacyAgreedAt).toBeInstanceOf(Date);
    expect(user.marketingConsentAt).toBeInstanceOf(Date);
    expect(user.nightAlertConsentAt).toBeNull();
    // 비밀번호는 해시로만 저장된다.
    expect(user.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, user.passwordHash)).toBe(true);

    const [log] = await auditActions("auth.signup");
    expect(log).toMatchObject({ actorId: userId, actorType: "CUSTOMER", targetId: userId });
    expect(JSON.stringify(log)).not.toContain(PASSWORD);

    // 가입 직후 같은 비밀번호로 로그인할 수 있다.
    await expect(authenticate({ email: "HANEUL@example.com", password: PASSWORD, ip: nextIp() })).resolves.toEqual({ userId });
  });

  it("광고성 정보 수신에 동의하지 않으면 동의 시각을 남기지 않는다", async () => {
    const { userId } = await signUp(signUpInput());
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.marketingConsentAt).toBeNull();
    expect(user.phone).toBeNull();
  });

  it("형식·정책·필수 동의를 지키지 않은 가입을 거절한다", async () => {
    const thisYear = kstParts(new Date()).year;
    const cases: [Partial<SignUpInput>, string, RegExp][] = [
      [{ email: "not-an-email" }, "email", /이메일 주소를 확인/],
      [{ email: `${"a".repeat(250)}@example.com` }, "email", /너무 길어요/],
      [{ email: "someone@deleted.invalid" }, "email", /사용할 수 없는 이메일/],
      [{ password: "short1" }, "password", /8자 이상/],
      [{ password: "onlyletters" }, "password", /영문과 숫자/],
      [{ password: "password1" }, "password", /흔한 비밀번호/],
      [{ email: "haneul@example.com", password: "haneul2026!" }, "password", /이메일과 비슷한/],
      [{ name: "   " }, "name", /이름을 입력/],
      [{ name: "가".repeat(31) }, "name", /30자/],
      [{ phone: "02-123-4567" }, "phone", /휴대전화 번호/],
      [{ birthYear: thisYear - 10 }, "birthYear", /만 14세/],
      [{ birthYear: 1850 }, "birthYear", /출생 연도/],
      [{ agreeTerms: false }, "agreeTerms", /이용약관/],
      [{ agreePrivacy: false }, "agreePrivacy", /개인정보/],
      [{ agreeAge14: false }, "agreeAge14", /만 14세/],
    ];
    for (const [overrides, field, message] of cases) {
      const error = await failure(signUp(signUpInput(overrides)));
      expect(error.code, field).toBe("VALIDATION");
      expect(error.fieldErrors?.[field], field).toMatch(message);
    }
    expect(await prisma.user.count()).toBe(0);
  });

  it("이미 가입된 이메일은 대소문자가 달라도 거절한다", async () => {
    await createUser({ email: "haneul@example.com" });
    const error = await failure(signUp(signUpInput({ email: "Haneul@Example.com" })));
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toBe("이미 가입된 이메일이에요.");
    expect(await prisma.user.count()).toBe(1);
  });

  it("같은 IP 에서 한 시간에 10번을 넘는 가입 시도를 막는다", async () => {
    await createUser({ email: "haneul@example.com" });
    const ip = nextIp();
    for (let i = 0; i < 10; i++) {
      expect((await failure(signUp(signUpInput({ ip })))).code).toBe("CONFLICT");
    }
    // 새 이메일이어도 한도를 넘기면 막힌다.
    const error = await failure(signUp(signUpInput({ ip, email: "another@example.com" })));
    expect(error.code).toBe("RATE_LIMITED");
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("authenticate", () => {
  it("맞는 비밀번호면 로그인하고 실패 횟수를 지운다", async () => {
    const user = await member({ failedLoginCount: 3 });
    await expect(authenticate({ email: user.email, password: PASSWORD, ip: nextIp() })).resolves.toEqual({ userId: user.id });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
    expect(row.lastLoginAt).toBeInstanceOf(Date);
    expect(await auditActions("auth.login")).toHaveLength(1);
  });

  it("성공한 로그인은 시도 횟수에 남지 않아, 같은 IP·계정으로 여러 번 로그인해도 막히지 않는다", async () => {
    const user = await member();
    const ip = nextIp();
    // 실패한 시도는 남는다.
    await failure(authenticate({ email: user.email, password: "Wrong!pass99", ip }));
    for (let i = 0; i < 21; i++) {
      await expect(authenticate({ email: user.email, password: PASSWORD, ip })).resolves.toEqual({ userId: user.id });
    }
    const counters = await prisma.rateLimit.findMany({ where: { key: { startsWith: "login:" } } });
    expect(counters).toHaveLength(2);
    expect(counters.map((c) => c.count)).toEqual([1, 1]);
  });

  it("없는 이메일과 틀린 비밀번호를 같은 응답으로 돌려준다", async () => {
    const user = await member();
    const unknown = await failure(authenticate({ email: "nobody@example.com", password: PASSWORD, ip: nextIp() }));
    const wrong = await failure(authenticate({ email: user.email, password: "Wrong!pass99", ip: nextIp() }));
    expect(unknown.code).toBe("UNAUTHENTICATED");
    expect(unknown.message).toBe(GENERIC);
    expect({ code: wrong.code, message: wrong.message, fieldErrors: wrong.fieldErrors }).toEqual({
      code: unknown.code,
      message: unknown.message,
      fieldErrors: unknown.fieldErrors,
    });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginCount).toBe(1);
    const logs = await auditActions("auth.login_failed");
    expect(logs).toHaveLength(2);
    // 감사 기록에 비밀번호나 이메일 원문을 남기지 않는다.
    expect(JSON.stringify(logs)).not.toContain("Wrong!pass99");
    expect(JSON.stringify(logs)).not.toContain("nobody@example.com");
  });

  it("10번 틀리면 15분 동안 잠그고, 잠금이 풀리면 다시 로그인할 수 있다", async () => {
    const user = await member();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      const error = await failure(authenticate({ email: user.email, password: "Wrong!pass99", ip: nextIp() }));
      expect(error.message).toBe(GENERIC);
    }
    const locked = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(locked.failedLoginCount).toBe(MAX_FAILED_LOGINS);
    const lockMs = locked.lockedUntil!.getTime() - Date.now();
    expect(lockMs).toBeGreaterThan(14 * 60_000);
    expect(lockMs).toBeLessThanOrEqual(15 * 60_000);
    expect(await auditActions("auth.locked")).toHaveLength(1);

    // 이메일 단위 요청 제한도 잠금과 같은 문구로 막는다.
    const limited = await failure(authenticate({ email: user.email, password: PASSWORD, ip: nextIp() }));
    expect(limited.message).toBe(LOCKED);

    // 요청 제한 창이 지나도 잠금 시간 동안에는 맞는 비밀번호로도 들어갈 수 없다.
    await prisma.rateLimit.deleteMany();
    const stillLocked = await failure(authenticate({ email: user.email, password: PASSWORD, ip: nextIp() }));
    expect(stillLocked.code).toBe("RATE_LIMITED");
    expect(stillLocked.message).toBe(LOCKED);

    await letLockExpire(user.id);
    await expect(authenticate({ email: user.email, password: PASSWORD, ip: nextIp() })).resolves.toEqual({ userId: user.id });
    const unlocked = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(unlocked.failedLoginCount).toBe(0);
    expect(unlocked.lockedUntil).toBeNull();
  });

  it("잠금이 풀린 뒤의 첫 실패는 1부터 다시 센다", async () => {
    const user = await member({ failedLoginCount: MAX_FAILED_LOGINS, lockedUntil: new Date(Date.now() - 1000) });
    await failure(authenticate({ email: user.email, password: "Wrong!pass99", ip: nextIp() }));
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginCount).toBe(1);
    expect(row.lockedUntil).toBeNull();
  });

  it("정지된 계정은 비밀번호가 맞을 때만 정지 안내를 보여 준다", async () => {
    const user = await member({ status: "SUSPENDED", suspendedReason: "신고 누적" });
    const wrong = await failure(authenticate({ email: user.email, password: "Wrong!pass99", ip: nextIp() }));
    expect(wrong.message).toBe(GENERIC);

    const right = await failure(authenticate({ email: user.email, password: PASSWORD, ip: nextIp() }));
    expect(right.code).toBe("FORBIDDEN");
    expect(right.message).toBe("이용이 정지된 계정이에요. 고객센터로 문의해 주세요.");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).lastLoginAt).toBeNull();
  });

  it("탈퇴한 계정과 깨진 해시는 일반 오류로 실패한다", async () => {
    const withdrawn = await member({ status: "WITHDRAWN" });
    expect((await failure(authenticate({ email: withdrawn.email, password: PASSWORD, ip: nextIp() }))).message).toBe(GENERIC);

    const broken = await createUser({ passwordHash: "not-a-hash" });
    expect((await failure(authenticate({ email: broken.email, password: PASSWORD, ip: nextIp() }))).message).toBe(GENERIC);
  });

  it("빈 값은 검증 오류로, 지나치게 긴 값은 일반 오류로 돌려보낸다", async () => {
    const empty = await failure(authenticate({ email: " ", password: "", ip: nextIp() }));
    expect(empty.code).toBe("VALIDATION");
    const tooLong = await failure(authenticate({ email: "a@example.com", password: "x".repeat(500), ip: nextIp() }));
    expect(tooLong.message).toBe(GENERIC);
  });
});

describe("authenticateAdmin", () => {
  it("운영자가 아닌 회원은 비밀번호가 맞아도 없는 계정처럼 실패한다", async () => {
    const user = await member();
    const error = await failure(authenticateAdmin({ email: user.email, password: PASSWORD, ip: nextIp() }));
    expect(error.code).toBe("UNAUTHENTICATED");
    expect(error.message).toBe(GENERIC);

    const [log] = await auditActions("admin.login_failed");
    expect(log).toMatchObject({ actorId: user.id, actorType: "ADMIN" });
    expect(log!.meta).toMatchObject({ reason: "NOT_ADMIN" });
    // 운영자 로그인 창으로 일반 회원의 실패 횟수를 올릴 수 없다.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginCount).toBe(0);
  });

  it("2단계 인증을 아직 등록하지 않은 운영자는 등록이 필요하다고 알려 준다", async () => {
    const admin = await member({ adminRole: "OPS" });
    await expect(authenticateAdmin({ email: admin.email, password: PASSWORD, ip: nextIp() })).resolves.toEqual({
      status: "OK",
      userId: admin.id,
      mustSetupTotp: true,
    });
    expect(await auditActions("admin.login")).toHaveLength(1);

    const wrong = await failure(authenticateAdmin({ email: admin.email, password: "Wrong!pass99", ip: nextIp() }));
    expect(wrong.message).toBe(GENERIC);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).failedLoginCount).toBe(1);
  });

  it("인증 앱을 등록하면 코드 없이는 들어갈 수 없고, 틀린 코드와 재사용한 코드를 거절한다", async () => {
    const admin = await member({ adminRole: "FINANCE" });

    const { secret, uri } = await beginTotpSetup(admin.id);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    const pending = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    // 비밀키는 암호문으로만 저장되고, 코드를 확인하기 전에는 켜지지 않는다.
    expect(pending.totpEnabledAt).toBeNull();
    expect(pending.totpSecretEnc).not.toContain(secret);
    expect(decrypt(pending.totpSecretEnc!)).toBe(secret);

    const validNow = new Set([-1, 0, 1, 2].map((d) => totpCode(secret, Date.now() + d * 30_000)));
    const wrongCode = ["000000", "111111", "222222", "333333", "444444", "555555"].find((c) => !validNow.has(c))!;

    expect((await failure(enableTotp(admin.id, wrongCode))).code).toBe("VALIDATION");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).totpEnabledAt).toBeNull();
    await enableTotp(admin.id, totpCode(secret));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).totpEnabledAt).toBeInstanceOf(Date);
    // 켠 뒤에는 등록을 다시 시작할 수 없다(비밀키 바꿔치기 방지).
    expect((await failure(beginTotpSetup(admin.id))).code).toBe("CONFLICT");

    await expect(authenticateAdmin({ email: admin.email, password: PASSWORD, ip: nextIp() })).resolves.toEqual({ status: "TOTP_REQUIRED" });

    const invalid = await failure(authenticateAdmin({ email: admin.email, password: PASSWORD, totp: wrongCode, ip: nextIp() }));
    expect(invalid.code).toBe("UNAUTHENTICATED");
    expect(invalid.fieldErrors?.totp).toMatch(/인증 코드가 맞지 않아요/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).failedLoginCount).toBe(1);
    const failedLogs = await auditActions("admin.login_failed");
    expect(failedLogs.map((l) => l.meta)).toContainEqual({ reason: "TOTP" });

    const code = totpCode(secret);
    await expect(authenticateAdmin({ email: admin.email, password: PASSWORD, totp: code, ip: nextIp() })).resolves.toEqual({
      status: "OK",
      userId: admin.id,
      mustSetupTotp: false,
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).failedLoginCount).toBe(0);

    // 같은 코드는 유효 시간 안에도 두 번 쓸 수 없다.
    const replay = await failure(authenticateAdmin({ email: admin.email, password: PASSWORD, totp: code, ip: nextIp() }));
    expect(replay.code).toBe("UNAUTHENTICATED");
    expect(replay.message).toMatch(/방금 사용한 인증 코드/);

    // 비밀키·코드는 감사 기록에 남지 않는다.
    const logs = JSON.stringify(await prisma.auditLog.findMany());
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain(code);
  });

  it("틀린 인증 코드도 로그인 실패로 세어 계정을 잠근다", async () => {
    const admin = await member({ adminRole: "CS", failedLoginCount: MAX_FAILED_LOGINS - 1 });
    const { secret } = await beginTotpSetup(admin.id);
    await enableTotp(admin.id, totpCode(secret));
    const validNow = new Set([-1, 0, 1, 2].map((d) => totpCode(secret, Date.now() + d * 30_000)));
    const wrongCode = ["000000", "111111", "222222", "333333", "444444", "555555"].find((c) => !validNow.has(c))!;

    await failure(authenticateAdmin({ email: admin.email, password: PASSWORD, totp: wrongCode, ip: nextIp() }));
    const row = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    const locked = await failure(authenticateAdmin({ email: admin.email, password: PASSWORD, totp: totpCode(secret), ip: nextIp() }));
    expect(locked.message).toBe(LOCKED);
  });

  it("같은 IP 에서 10분에 5번 실패하면 운영자 로그인을 막고, 성공한 로그인은 횟수에 넣지 않는다", async () => {
    const ip = nextIp();
    const admin = await member({ adminRole: "SUPER" });
    const { secret } = await beginTotpSetup(admin.id);
    await enableTotp(admin.id, totpCode(secret));

    // 비밀번호 확인(TOTP_REQUIRED)과 성공한 로그인은 여러 번 해도 한도를 깎지 않는다.
    for (let i = 0; i < 6; i++) {
      await expect(authenticateAdmin({ email: admin.email, password: PASSWORD, ip })).resolves.toEqual({ status: "TOTP_REQUIRED" });
    }
    await expect(authenticateAdmin({ email: admin.email, password: PASSWORD, totp: totpCode(secret), ip })).resolves.toMatchObject({ status: "OK" });

    for (let i = 0; i < 5; i++) {
      expect((await failure(authenticateAdmin({ email: `ghost${i}@example.com`, password: PASSWORD, ip }))).message).toBe(GENERIC);
    }
    expect((await failure(authenticateAdmin({ email: admin.email, password: PASSWORD, ip }))).code).toBe("RATE_LIMITED");
  });

  it("운영자가 아니면 인증 앱을 등록할 수 없다", async () => {
    const user = await member();
    expect((await failure(beginTotpSetup(user.id))).code).toBe("FORBIDDEN");
    expect((await failure(enableTotp(user.id, "123456"))).code).toBe("FORBIDDEN");
  });

  it("2단계 인증 초기화는 최고 관리자만, 다른 운영자에게만 할 수 있다", async () => {
    const superAdmin = await member({ adminRole: "SUPER" });
    const ops = await member({ adminRole: "OPS" });
    const { secret } = await beginTotpSetup(ops.id);
    await enableTotp(ops.id, totpCode(secret));
    const adminSession = await createSessionRow(ops.id, true);
    const userSession = await createSessionRow(ops.id, false);

    expect((await failure(disableTotp(ops.id, superAdmin.id))).code).toBe("FORBIDDEN");
    expect((await failure(disableTotp(superAdmin.id, superAdmin.id))).code).toBe("FORBIDDEN");
    const customer = await member();
    expect((await failure(disableTotp(superAdmin.id, customer.id))).code).toBe("NOT_FOUND");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ops.id } })).totpEnabledAt).toBeInstanceOf(Date);

    await disableTotp(superAdmin.id, ops.id);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: ops.id } });
    expect(row.totpEnabledAt).toBeNull();
    expect(row.totpSecretEnc).toBeNull();
    // 운영자 세션만 끊고 회원 세션은 둔다.
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: adminSession.id } })).revokedAt).toBeInstanceOf(Date);
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: userSession.id } })).revokedAt).toBeNull();
    const [log] = await auditActions("admin.totp_disable");
    expect(log).toMatchObject({ actorId: superAdmin.id, actorType: "ADMIN", targetId: ops.id });
  });
});

describe("changePassword", () => {
  it("비밀번호를 바꾸면 지금 세션만 남기고 다른 세션을 모두 끊는다", async () => {
    const user = await member();
    const current = await createSessionRow(user.id);
    const other = await createSessionRow(user.id);
    const adminSession = await createSessionRow(user.id, true);

    await changePassword({ userId: user.id, currentPassword: PASSWORD, newPassword: NEW_PASSWORD, keepSessionId: current.id });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(NEW_PASSWORD, row.passwordHash)).toBe(true);
    expect(await verifyPassword(PASSWORD, row.passwordHash)).toBe(false);
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: current.id } })).revokedAt).toBeNull();
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: other.id } })).revokedAt).toBeInstanceOf(Date);
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: adminSession.id } })).revokedAt).toBeInstanceOf(Date);
    const [log] = await auditActions("auth.password_change");
    expect(JSON.stringify(log)).not.toContain(NEW_PASSWORD);
  });

  it("현재 비밀번호가 틀리거나 새 비밀번호가 정책에 맞지 않으면 바꾸지 않는다", async () => {
    const user = await member();
    const session = await createSessionRow(user.id);

    const wrong = await failure(changePassword({ userId: user.id, currentPassword: "Wrong!pass99", newPassword: NEW_PASSWORD }));
    expect(wrong.fieldErrors?.currentPassword).toMatch(/현재 비밀번호가 맞지 않아요/);
    const same = await failure(changePassword({ userId: user.id, currentPassword: PASSWORD, newPassword: PASSWORD }));
    expect(same.fieldErrors?.newPassword).toMatch(/달라야 해요/);
    const weak = await failure(changePassword({ userId: user.id, currentPassword: PASSWORD, newPassword: "abcdefgh" }));
    expect(weak.fieldErrors?.newPassword).toMatch(/영문과 숫자/);

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(PASSWORD_HASH);
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).toBeNull();
  });
});

describe("비밀번호 재설정", () => {
  const resetMails = () => prisma.messageOutbox.findMany({ where: { templateKey: PASSWORD_RESET_TEMPLATE_KEY }, orderBy: { createdAt: "asc" } });
  const tokenFrom = (body: string) => /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(body)![1]!;

  it("없는 이메일도 똑같이 끝나고 아무것도 만들지 않는다", async () => {
    const user = await member();
    const known = await requestPasswordReset({ email: user.email, ip: nextIp() });
    const unknown = await requestPasswordReset({ email: "nobody@example.com", ip: nextIp() });
    expect(unknown).toBe(known);
    expect(unknown).toBeUndefined();

    expect(await prisma.verificationToken.count()).toBe(1);
    expect(await resetMails()).toHaveLength(1);
  });

  it("메일로 받은 링크로 비밀번호를 한 번만 바꿀 수 있다", async () => {
    const user = await member({ failedLoginCount: MAX_FAILED_LOGINS, lockedUntil: new Date(Date.now() + 600_000) });
    const session = await createSessionRow(user.id);
    await requestPasswordReset({ email: user.email.toUpperCase(), ip: nextIp() });

    const [mail] = await resetMails();
    expect(mail).toMatchObject({ channel: "EMAIL", recipient: user.email, userId: user.id, status: "QUEUED", isAdvertising: false });
    expect(mail!.body).toContain("http://localhost:3000/reset-password?token=");
    const token = tokenFrom(mail!.body);

    const record = await prisma.verificationToken.findFirstOrThrow({ where: { userId: user.id } });
    // DB 에는 토큰의 해시만 있다.
    expect(record.tokenHash).toBe(sha256(token));
    expect(record.tokenHash).not.toBe(token);
    expect(record.type).toBe("PASSWORD_RESET");
    const ttl = record.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(token);

    // 정책에 걸린 비밀번호는 토큰을 쓰지 않는다.
    const weak = await failure(resetPassword({ token, newPassword: "weak" }));
    expect(weak.fieldErrors?.newPassword).toMatch(/8자 이상/);
    expect((await prisma.verificationToken.findUniqueOrThrow({ where: { id: record.id } })).usedAt).toBeNull();

    await resetPassword({ token, newPassword: NEW_PASSWORD });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(NEW_PASSWORD, row.passwordHash)).toBe(true);
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).toBeInstanceOf(Date);
    expect((await prisma.verificationToken.findUniqueOrThrow({ where: { id: record.id } })).usedAt).toBeInstanceOf(Date);
    expect(await auditActions("auth.password_reset")).toHaveLength(1);

    const reused = await failure(resetPassword({ token, newPassword: "Another#Pass77" }));
    expect(reused.code).toBe("VALIDATION");
    expect(reused.message).toMatch(/만료됐거나 이미 사용됐어요/);
    expect(await verifyPassword(NEW_PASSWORD, (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
  });

  it("만료된 링크, 새 요청으로 바뀐 예전 링크, 모르는 토큰을 거절한다", async () => {
    const user = await member();
    await requestPasswordReset({ email: user.email, ip: nextIp() });
    const first = tokenFrom((await resetMails())[0]!.body);
    await requestPasswordReset({ email: user.email, ip: nextIp() });
    const second = tokenFrom((await resetMails())[1]!.body);
    expect(second).not.toBe(first);
    expect(await prisma.verificationToken.count({ where: { userId: user.id } })).toBe(1);

    expect((await failure(resetPassword({ token: first, newPassword: NEW_PASSWORD }))).message).toMatch(/만료됐거나 이미 사용됐어요/);
    expect((await failure(resetPassword({ token: "x".repeat(43), newPassword: NEW_PASSWORD }))).message).toMatch(/만료됐거나/);
    expect((await failure(resetPassword({ token: "short", newPassword: NEW_PASSWORD }))).message).toMatch(/만료됐거나/);

    await prisma.verificationToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await failure(resetPassword({ token: second, newPassword: NEW_PASSWORD }))).message).toMatch(/만료됐거나 이미 사용됐어요/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(PASSWORD_HASH);
  });

  it("같은 이메일로는 가입 여부와 관계없이 한 시간에 3번까지만 요청할 수 있다", async () => {
    const user = await member();
    for (const email of [user.email, "nobody@example.com"]) {
      for (let i = 0; i < 3; i++) await requestPasswordReset({ email, ip: nextIp() });
      expect((await failure(requestPasswordReset({ email, ip: nextIp() }))).code).toBe("RATE_LIMITED");
    }
    expect(await resetMails()).toHaveLength(3);
  });

  it("정지된 계정에는 재설정 링크를 보내지 않는다", async () => {
    const user = await member({ status: "SUSPENDED" });
    await expect(requestPasswordReset({ email: user.email, ip: nextIp() })).resolves.toBeUndefined();
    expect(await prisma.verificationToken.count()).toBe(0);
    expect(await resetMails()).toHaveLength(0);
  });
});

describe("프로필 · 수신 동의", () => {
  it("getAccount 는 화면에 필요한 값만 돌려준다", async () => {
    const user = await member({ phoneVerifiedAt: new Date(), nickname: "하늘" });
    const account = await getAccount(user.id);
    expect(account).toMatchObject({ email: user.email, name: user.name, nickname: "하늘", phone: user.phone, phoneVerified: true, identityVerified: false });
    for (const key of ["id", "passwordHash", "totpSecretEnc", "adminRole", "failedLoginCount"]) {
      expect(account).not.toHaveProperty(key);
    }
    expect(JSON.stringify(account)).not.toContain(PASSWORD_HASH);
    expect((await failure(getAccount("missing-user"))).code).toBe("NOT_FOUND");
  });

  it("넘어온 항목만 바꾸고, 휴대전화 번호를 바꾸면 번호 인증을 푼다", async () => {
    const user = await member({ phone: "01011112222", phoneVerifiedAt: new Date(), gender: "MALE", birthYear: 1990 });

    const renamed = await updateProfile(user.id, { name: " 김바다 ", nickname: "바다" });
    expect(renamed).toMatchObject({ name: "김바다", nickname: "바다", phone: "01011112222", phoneVerified: true, gender: "MALE", birthYear: 1990 });

    const moved = await updateProfile(user.id, { phone: "010-3333-4444", nickname: "" });
    expect(moved).toMatchObject({ phone: "01033334444", phoneVerified: false, nickname: null });

    const bad = await failure(updateProfile(user.id, { phone: "12345" }));
    expect(bad.fieldErrors?.phone).toMatch(/휴대전화 번호/);
    const young = await failure(updateProfile(user.id, { birthYear: kstParts(new Date()).year - 5 }));
    expect(young.fieldErrors?.birthYear).toMatch(/만 14세/);
  });

  it("본인인증을 마친 계정은 이름·성별·출생 연도를 바꿀 수 없다", async () => {
    const user = await member({ name: "김하늘", gender: "FEMALE", birthYear: 1995, identityVerifiedAt: new Date() });

    const error = await failure(updateProfile(user.id, { name: "이하늘", gender: "MALE", birthYear: 1990 }));
    expect(error.code).toBe("VALIDATION");
    expect(Object.keys(error.fieldErrors ?? {}).sort()).toEqual(["birthYear", "gender", "name"]);

    // 값이 그대로면 함께 보내도 되고, 다른 항목은 바꿀 수 있다.
    const updated = await updateProfile(user.id, { name: "김하늘", gender: "FEMALE", birthYear: 1995, nickname: "하늘이" });
    expect(updated).toMatchObject({ name: "김하늘", nickname: "하늘이", identityVerified: true });
  });

  it("수신 동의를 켜고 끄면 시각을 기록하거나 지운다", async () => {
    const user = await member();

    const nightFirst = await failure(updateConsents(user.id, { nightAlert: true }));
    expect(nightFirst.code).toBe("VALIDATION");
    expect((await failure(updateConsents(user.id, {}))).code).toBe("VALIDATION");

    const on = await updateConsents(user.id, { marketing: true, nightAlert: true });
    expect(on.marketingConsentAt).toBeInstanceOf(Date);
    expect(on.nightAlertConsentAt).toBeInstanceOf(Date);

    // 광고 수신을 철회하면 야간 동의도 함께 풀린다.
    const off = await updateConsents(user.id, { marketing: false });
    expect(off).toEqual({ marketingConsentAt: null, nightAlertConsentAt: null });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.marketingConsentAt).toBeNull();
    expect(row.nightAlertConsentAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "user.marketing_consent", actorId: user.id } })).toBe(2);
  });
});

describe("withdrawAccount", () => {
  it("진행 중인 예약이 있으면 탈퇴할 수 없다", async () => {
    const user = await member();
    const listing = await createListing();
    const booking = await createBooking(user.id, listing);

    const error = await failure(withdrawAccount({ userId: user.id, password: PASSWORD }));
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toMatch(/^진행 중인 예약이 있어 탈퇴할 수 없어요/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("ACTIVE");

    // 좌석을 잡고 있는 결제 대기도 진행 중이고, 홀드가 끝난 결제 대기는 막지 않는다.
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_PAYMENT", holdExpiresAt: new Date(Date.now() + 60_000) } });
    expect((await failure(withdrawAccount({ userId: user.id, password: PASSWORD }))).code).toBe("CONFLICT");
    await prisma.booking.update({ where: { id: booking.id }, data: { holdExpiresAt: new Date(Date.now() - 60_000) } });
    await withdrawAccount({ userId: user.id, password: PASSWORD });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("WITHDRAWN");
  });

  it("비밀번호가 틀리면 탈퇴시키지 않는다", async () => {
    const user = await member();
    const error = await failure(withdrawAccount({ userId: user.id, password: "Wrong!pass99" }));
    expect(error.fieldErrors?.password).toMatch(/비밀번호가 맞지 않아요/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("ACTIVE");
  });

  it("운영자 계정은 탈퇴할 수 없다", async () => {
    const admin = await member({ adminRole: "SUPER" });
    expect((await failure(withdrawAccount({ userId: admin.id, password: PASSWORD }))).code).toBe("FORBIDDEN");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).status).toBe("ACTIVE");
  });

  it("탈퇴하면 개인정보를 지우고 예약 기록은 남긴다", async () => {
    const user = await member({
      email: "haneul@example.com",
      name: "김하늘",
      nickname: "하늘",
      phone: "01012345678",
      gender: "FEMALE",
      birthYear: 1995,
      marketingConsentAt: new Date(),
      nightAlertConsentAt: new Date(),
      notificationPrefs: { vacancySms: true },
    });
    const other = await createUser();
    // 이미 끝난 예약 — 기록으로 남아야 한다.
    const listing = await createListing([{ capacity: 4 }], { startsInHours: -48 });
    const booking = await createBooking(user.id, listing, { status: "COMPLETED" });
    const upcoming = await createSlot(listing.product, [{ label: "남성", capacity: 2 }, { label: "여성", capacity: 2 }], { status: "CLOSED" });
    const [seat, offeredSeat] = [upcoming.seats[0]!, upcoming.seats[1]!];

    await prisma.favorite.createMany({ data: [{ userId: user.id, productId: listing.product.id }, { userId: other.id, productId: listing.product.id }] });
    await prisma.product.update({ where: { id: listing.product.id }, data: { favoriteCount: 2 } });
    await prisma.follow.create({ data: { userId: user.id, businessId: listing.business.id } });
    await prisma.business.update({ where: { id: listing.business.id }, data: { followerCount: 1 } });
    await prisma.alertRule.create({ data: { userId: user.id, categorySlugs: ["meet"], areaSlugs: [], daysOfWeek: [] } });
    await prisma.notification.create({ data: { userId: user.id, type: "SYSTEM", title: "안내", body: "내용" } });
    await prisma.waitlistEntry.create({ data: { userId: user.id, slotId: upcoming.id, slotSeatId: seat.id } });
    const offered = await prisma.waitlistEntry.create({
      data: { userId: user.id, slotId: upcoming.id, slotSeatId: offeredSeat.id, status: "OFFERED", offerExpiresAt: new Date(Date.now() + 600_000) },
    });
    await prisma.verificationToken.create({
      data: { type: "PASSWORD_RESET", userId: user.id, target: user.email, tokenHash: sha256("t"), expiresAt: new Date(Date.now() + 600_000) },
    });
    const queued = await prisma.messageOutbox.create({
      data: { userId: user.id, channel: "SMS", recipient: "01012345678", templateKey: "VACANCY_ALERT", body: "빈자리 알림" },
    });
    const sent = await prisma.messageOutbox.create({
      data: { userId: user.id, channel: "EMAIL", recipient: "haneul@example.com", templateKey: "PLATFORM_NOTICE", body: "안내", status: "SENT" },
    });
    const session = await createSessionRow(user.id);

    await withdrawAccount({ userId: user.id, password: PASSWORD });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row).toMatchObject({
      email: `withdrawn+${user.id}@deleted.invalid`,
      name: "탈퇴한 회원",
      nickname: null,
      phone: null,
      gender: null,
      birthYear: null,
      status: "WITHDRAWN",
      marketingConsentAt: null,
      nightAlertConsentAt: null,
      notificationPrefs: null,
    });
    expect(row.withdrawnAt).toBeInstanceOf(Date);
    expect(row.passwordHash).not.toBe(PASSWORD_HASH);
    expect(await verifyPassword(PASSWORD, row.passwordHash)).toBe(false);

    expect(await prisma.favorite.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.follow.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.alertRule.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.verificationToken.count({ where: { userId: user.id } })).toBe(0);
    // 좌석을 잡고 있는 제안 중 대기는 남겨 만료 처리에 맡긴다.
    expect((await prisma.waitlistEntry.findMany({ where: { userId: user.id } })).map((w) => w.id)).toEqual([offered.id]);
    // 캐시된 집계도 함께 줄고, 다른 회원의 찜은 그대로다.
    expect((await prisma.product.findUniqueOrThrow({ where: { id: listing.product.id } })).favoriteCount).toBe(1);
    expect(await prisma.favorite.count({ where: { userId: other.id } })).toBe(1);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: listing.business.id } })).followerCount).toBe(0);

    // 예약 기록은 보관한다(전자상거래법).
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject({ userId: user.id, status: "COMPLETED" });
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).toBeInstanceOf(Date);
    expect(await prisma.messageOutbox.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: "SKIPPED", recipient: "탈퇴한 회원" });
    expect(await prisma.messageOutbox.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({ status: "SENT", recipient: "탈퇴한 회원" });

    const [log] = await auditActions("user.withdraw");
    expect(log).toMatchObject({ actorId: user.id, targetId: user.id });
    expect(JSON.stringify(log)).not.toContain("haneul@example.com");

    // 예전 이메일로는 더 이상 로그인할 수 없고, 같은 이메일로 다시 가입할 수 있다.
    expect((await failure(authenticate({ email: "haneul@example.com", password: PASSWORD, ip: nextIp() }))).message).toBe(GENERIC);
    expect(await prisma.user.findUnique({ where: { email: "haneul@example.com" } })).toBeNull();
    expect((await failure(withdrawAccount({ userId: user.id, password: PASSWORD }))).code).toBe("NOT_FOUND");
  });

  it("대표로 있는 사업장에 열린 회차나 진행 중인 예약이 있으면 탈퇴할 수 없고, 정리한 뒤에는 사업장 운영을 종료한다", async () => {
    const { business, owner } = await createBusiness();
    await prisma.user.update({ where: { id: owner.id }, data: { passwordHash: PASSWORD_HASH } });
    const manager = await createUser();
    await prisma.businessMember.create({ data: { businessId: business.id, userId: manager.id, role: "MANAGER" } });
    const product = await createProduct(business.id, business.categoryId);
    const slot = await createSlot(product, [{ capacity: 4 }]);

    const open = await failure(withdrawAccount({ userId: owner.id, password: PASSWORD }));
    expect(open.code).toBe("CONFLICT");
    expect(open.message).toMatch(/열려 있는 회차나 진행 중인 예약이 있어 탈퇴할 수 없어요/);

    // 판매를 마감해도 손님의 예약이 남아 있으면 탈퇴할 수 없다.
    await prisma.slot.update({ where: { id: slot.id }, data: { status: "CLOSED" } });
    const guest = await createUser();
    const booking = await createBooking(guest.id, { business, owner, product, slot, seat: slot.seats[0]! });
    expect((await failure(withdrawAccount({ userId: owner.id, password: PASSWORD }))).code).toBe("CONFLICT");

    await prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } });
    await withdrawAccount({ userId: owner.id, password: PASSWORD });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).status).toBe("WITHDRAWN");
    const closed = await prisma.business.findUniqueOrThrow({ where: { id: business.id } });
    expect(closed.status).toBe("SUSPENDED");
    expect(closed.suspendedReason).toMatch(/대표 회원이 탈퇴/);
    const members = await prisma.businessMember.findMany({ where: { businessId: business.id } });
    expect(members.map((m) => m.userId)).toEqual([manager.id]);
  });

  it("매니저·스태프는 사업장에 열린 회차가 있어도 탈퇴할 수 있고 소속만 정리된다", async () => {
    const { business } = await createBusiness();
    const product = await createProduct(business.id, business.categoryId);
    await createSlot(product, [{ capacity: 4 }]);
    const staff = await member();
    await prisma.businessMember.create({ data: { businessId: business.id, userId: staff.id, role: "STAFF" } });

    await withdrawAccount({ userId: staff.id, password: PASSWORD });
    expect(await prisma.businessMember.count({ where: { userId: staff.id } })).toBe(0);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: business.id } })).status).toBe("APPROVED");
  });
});
