import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_SIGNUP_AGE, POLICY_VERSIONS } from "@/lib/policy";
import { kstParts } from "@/lib/time";
import { hashPassword } from "@/server/auth/password";
import { prisma } from "@/server/db";
import { sha256 } from "@/server/security/crypto";
import { createUser, resetDb } from "./helpers";

type KakaoModule = typeof import("@/server/auth/kakao");
type AccountModule = typeof import("@/server/auth/account");

// 라우트 핸들러·서버 액션이 쓰는 쿠키 저장소와 요청 헤더를 가짜로 바꾼다(서비스 함수는 쿠키를 읽지 않는다).
const jar = vi.hoisted(() => {
  const store = new Map<string, { value: string; options: Record<string, unknown> }>();
  return {
    store,
    api: {
      get: (name: string) => {
        const entry = store.get(name);
        return entry ? { name, value: entry.value } : undefined;
      },
      set: (name: string, value: string, options: Record<string, unknown> = {}) => {
        // 브라우저처럼 maxAge 0 은 삭제로 다룬다.
        if (options.maxAge === 0) store.delete(name);
        else store.set(name, { value, options });
      },
    },
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => jar.api,
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.50", "user-agent": "vitest" }),
}));

const CLIENT_ID = "kakao-rest-api-key";
const TOKEN_URL = "https://kauth.kakao.com/oauth/token";
const ME_URL = "https://kapi.kakao.com/v2/user/me";
const ACCESS_TOKEN = "ACCESS-TOKEN-do-not-log";
const AUTH_CODE = "AUTH-CODE-do-not-log";
const STATE = "st4te-".padEnd(32, "x");
const KAKAO_ID = "4242424242";
const EMAIL = "haneul@example.com";

const ENV_KEYS = ["KAKAO_CLIENT_ID", "KAKAO_CLIENT_SECRET"] as const;
const savedEnv = new Map<string, string | undefined>();

/** 연동 설정을 바꾼 새 모듈을 불러온다(env 는 처음 읽을 때 고정되므로 모듈을 다시 올린다). */
async function load(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = { KAKAO_CLIENT_ID: CLIENT_ID }): Promise<{ kakao: KakaoModule; account: AccountModule }> {
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  return { kakao: await import("@/server/auth/kakao"), account: await import("@/server/auth/account") };
}

interface Failure {
  name: string;
  code: string;
  message: string;
  reason?: string;
  fieldErrors?: Record<string, string>;
}

/** 실패해야 하는 호출의 오류를 꺼낸다(모듈을 다시 불러와 클래스가 달라지므로 이름으로 확인한다). */
async function failure(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
  } catch (e) {
    const error = e as Failure;
    expect(error.name).toBe("AppError");
    return error;
  }
  throw new Error("실패해야 하는 호출이 성공했어요.");
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface KakaoMe {
  id?: number | string;
  email?: string | null;
  valid?: boolean;
  verified?: boolean;
  nickname?: string | null;
}

/** 카카오 사용자 정보 응답(https://kapi.kakao.com/v2/user/me) */
function kakaoMe(me: KakaoMe = {}) {
  const email = me.email === undefined ? EMAIL : me.email;
  const nickname = me.nickname === undefined ? "하늘" : me.nickname;
  return {
    id: me.id ?? Number(KAKAO_ID),
    connected_at: "2026-11-27T02:00:00Z",
    properties: nickname ? { nickname } : {},
    kakao_account: {
      profile_nickname_needs_agreement: false,
      profile: nickname ? { nickname } : {},
      has_email: email !== null,
      email_needs_agreement: false,
      ...(email !== null ? { email, is_email_valid: me.valid ?? true, is_email_verified: me.verified ?? true } : {}),
    },
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** 카카오 API 를 흉내 낸다. 기본값은 토큰 발급 성공 + 인증된 이메일의 프로필 */
function stubKakao(handlers: { token?: (call: Call) => Response | Promise<Response>; me?: (call: Call) => Response | Promise<Response> } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? init.body : "",
      };
      calls.push(call);
      if (call.url === TOKEN_URL) return (handlers.token ?? (() => json(200, { token_type: "bearer", access_token: ACCESS_TOKEN, expires_in: 21599 })))(call);
      if (call.url === ME_URL) return (handlers.me ?? (() => json(200, kakaoMe())))(call);
      return new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

const callback = (overrides: Partial<Parameters<KakaoModule["finishKakaoLogin"]>[0]> = {}) => ({
  code: AUTH_CODE,
  state: STATE,
  expectedState: STATE,
  ...overrides,
});

let ipSeq = 0;
const nextIp = () => `10.9.0.${(ipSeq++ % 250) + 1}`;

const signupForm = (overrides: Partial<Parameters<KakaoModule["completeKakaoSignup"]>[1]> = {}) => ({
  name: "김하늘",
  agreeTerms: true,
  agreePrivacy: true,
  agreeAge14: true,
  ip: nextIp(),
  ...overrides,
});

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

beforeEach(async () => {
  await resetDb();
  jar.store.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

// ───────────────────────── 연동 설정 ─────────────────────────

describe("연동 설정", () => {
  it("KAKAO_CLIENT_ID 가 없으면 모든 진입점이 NOT_CONFIGURED 로 끝나고 카카오에 아무 요청도 보내지 않는다", async () => {
    const { kakao } = await load({});
    const calls = stubKakao();
    expect(kakao.isKakaoEnabled()).toBe(false);

    for (const run of [
      () => Promise.resolve().then(() => kakao.buildKakaoAuthorizeUrl({ state: STATE, redirectUri: kakao.kakaoRedirectUri() })),
      () => Promise.resolve().then(() => kakao.beginKakaoLogin()),
      () => kakao.exchangeKakaoCode(AUTH_CODE, kakao.kakaoRedirectUri()),
      () => kakao.finishKakaoLogin(callback()),
      () => kakao.resolveKakaoLogin({ id: KAKAO_ID, email: EMAIL, emailVerified: true, nickname: null }),
      () => kakao.completeKakaoSignup("anything", signupForm()),
    ]) {
      const error = await failure(run());
      expect(error.code).toBe("NOT_CONFIGURED");
      expect(error.reason).toBe("not_configured");
      expect(error.message).toMatch(/카카오 로그인이 아직 연결되지 않았어요/);
    }
    expect(calls).toHaveLength(0);
    expect(await prisma.user.count()).toBe(0);
  });

  it("동의 화면 주소에 REST API 키·돌아올 주소·state·요청 항목을 담는다", async () => {
    const { kakao } = await load();
    expect(kakao.isKakaoEnabled()).toBe(true);
    expect(kakao.kakaoRedirectUri()).toBe("http://localhost:3000/api/auth/kakao/callback");

    const url = new URL(kakao.buildKakaoAuthorizeUrl({ state: STATE, redirectUri: kakao.kakaoRedirectUri() }));
    expect(`${url.origin}${url.pathname}`).toBe("https://kauth.kakao.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: "http://localhost:3000/api/auth/kakao/callback",
      response_type: "code",
      state: STATE,
      scope: "account_email,profile_nickname",
    });
    // 형식이 틀린 state 로는 주소를 만들지 않는다.
    expect((await failure(Promise.resolve().then(() => kakao.buildKakaoAuthorizeUrl({ state: "short", redirectUri: "x" })))).reason).toBe("state");

    // 시작할 때마다 새 state 를 만든다.
    const [a, b] = [kakao.beginKakaoLogin(), kakao.beginKakaoLogin()];
    expect(a.state).not.toBe(b.state);
    expect(a.state.length).toBeGreaterThanOrEqual(20);
    expect(new URL(a.authorizeUrl).searchParams.get("state")).toBe(a.state);

    expect(kakao.kakaoFailureMessage("kakao_state")).toBe(kakao.KAKAO_FAILURE_MESSAGES.state);
    expect(kakao.kakaoFailureMessage("kakao_nope")).toBeNull();
    expect(kakao.kakaoFailureMessage("other_error")).toBeNull();
    expect(kakao.kakaoFailureMessage(null)).toBeNull();
  });

  it("코드 교환은 폼 형식 POST(Client Secret 포함), 프로필 조회는 Bearer 토큰으로 보낸다", async () => {
    const { kakao } = await load({ KAKAO_CLIENT_ID: CLIENT_ID, KAKAO_CLIENT_SECRET: "client-secret-value" });
    const calls = stubKakao({ me: () => json(200, kakaoMe({ email: " Haneul@Example.COM ", nickname: "  하늘  " })) });

    const token = await kakao.exchangeKakaoCode(AUTH_CODE, kakao.kakaoRedirectUri());
    expect(token).toBe(ACCESS_TOKEN);
    const profile = await kakao.fetchKakaoProfile(token);
    expect(profile).toEqual({ id: KAKAO_ID, email: EMAIL, emailVerified: true, nickname: "하늘" });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ url: TOKEN_URL, method: "POST" });
    expect(calls[0]!.headers["Content-Type"]).toMatch(/^application\/x-www-form-urlencoded/);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "http://localhost:3000/api/auth/kakao/callback",
      code: AUTH_CODE,
      client_secret: "client-secret-value",
    });
    expect(calls[1]).toMatchObject({ url: ME_URL, method: "GET", headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  });

  it("프로필의 이메일은 카카오가 유효하고 인증됐다고 한 경우에만 인증된 것으로 본다", async () => {
    const { kakao } = await load();
    const cases: [KakaoMe, { email: string | null; emailVerified: boolean }][] = [
      [{}, { email: EMAIL, emailVerified: true }],
      [{ verified: false }, { email: EMAIL, emailVerified: false }],
      [{ valid: false }, { email: EMAIL, emailVerified: false }],
      [{ email: null }, { email: null, emailVerified: false }],
      [{ email: "not-an-email" }, { email: null, emailVerified: false }],
    ];
    for (const [me, expected] of cases) {
      stubKakao({ me: () => json(200, kakaoMe(me)) });
      expect(await kakao.fetchKakaoProfile(ACCESS_TOKEN)).toMatchObject(expected);
    }
    // 회원번호가 문자열로 와도 받는다.
    stubKakao({ me: () => json(200, kakaoMe({ id: "9876543210" })) });
    expect((await kakao.fetchKakaoProfile(ACCESS_TOKEN)).id).toBe("9876543210");
  });
});

// ───────────────────────── 로그인 판정 ─────────────────────────

describe("카카오 로그인", () => {
  it("이미 연결된 회원: 그 회원으로 로그인하고 마지막 로그인 시각과 감사 기록을 남긴다", async () => {
    const { kakao } = await load();
    const user = await createUser({ kakaoId: KAKAO_ID, email: "other-address@example.com" });
    const calls = stubKakao();

    const result = await kakao.finishKakaoLogin(callback());
    expect(result).toEqual({ needsSignup: false, userId: user.id, linked: false });
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, ME_URL]);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.lastLoginAt).toBeInstanceOf(Date);
    // 연결돼 있던 회원의 이메일은 카카오 이메일로 바꾸지 않는다.
    expect(row.email).toBe("other-address@example.com");
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "auth.login", targetId: user.id } });
    expect(log.meta).toEqual({ method: "kakao" });
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(ACCESS_TOKEN);
  });

  it("연결된 회원은 카카오 이메일이 인증되지 않았거나 없어도 로그인할 수 있다", async () => {
    const { kakao } = await load();
    const user = await createUser({ kakaoId: KAKAO_ID });
    for (const me of [{ verified: false }, { email: null }]) {
      stubKakao({ me: () => json(200, kakaoMe(me)) });
      expect(await kakao.finishKakaoLogin(callback())).toMatchObject({ needsSignup: false, userId: user.id });
    }
  });

  it("인증된 이메일이 같은 기존 회원: 카카오 계정을 연결하고, 예전 비밀번호와 세션을 없앤 뒤 알린다", async () => {
    const { kakao, account } = await load();
    const password = "Namneun!2026";
    const user = await createUser({ email: EMAIL, passwordHash: await hashPassword(password), failedLoginCount: 3 });
    const session = await prisma.authSession.create({
      data: { tokenHash: sha256("old-session-token"), userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    await prisma.verificationToken.create({
      data: { type: "PASSWORD_RESET", userId: user.id, target: EMAIL, tokenHash: sha256("old-reset-token"), expiresAt: new Date(Date.now() + 600_000) },
    });
    stubKakao();

    const result = await kakao.finishKakaoLogin(callback());
    expect(result).toEqual({ needsSignup: false, userId: user.id, linked: true });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row).toMatchObject({ kakaoId: KAKAO_ID, failedLoginCount: 0, lockedUntil: null });
    expect(row.lastLoginAt).toBeInstanceOf(Date);
    // 가입 때 이메일을 확인하지 않은 예전 비밀번호는 더 이상 통하지 않고, 로그인돼 있던 기기는 로그아웃된다.
    expect((await failure(account.authenticate({ email: EMAIL, password, ip: nextIp() }))).code).toBe("UNAUTHENTICATED");
    expect(await account.getAccount(user.id)).toMatchObject({ hasPassword: false, kakaoLinked: true });
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).toBeInstanceOf(Date);
    expect(await prisma.verificationToken.count({ where: { userId: user.id } })).toBe(0);

    // 본인에게 앱 알림과 메일로 알린다.
    const notice = await prisma.notification.findFirstOrThrow({ where: { userId: user.id } });
    expect(notice).toMatchObject({ type: "SYSTEM", title: "카카오 계정이 연결됐어요" });
    expect(notice.body).toContain("비밀번호 재설정");
    expect(await prisma.messageOutbox.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({
      channel: "EMAIL",
      recipient: EMAIL,
      templateKey: "PLATFORM_KAKAO_LINKED",
    });
    expect(await prisma.auditLog.count({ where: { action: "auth.kakao_link", targetId: user.id } })).toBe(1);

    // 다음 로그인부터는 연결된 회원으로 바로 들어간다(다시 연결하지 않는다).
    expect(await kakao.finishKakaoLogin(callback())).toEqual({ needsSignup: false, userId: user.id, linked: false });
    expect(await prisma.auditLog.count({ where: { action: "auth.kakao_link" } })).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });

  it("인증되지 않은 이메일로는 기존 회원에 절대 연결하지 않고, 새 회원도 만들지 않는다", async () => {
    const { kakao } = await load();
    const password = "Namneun!2026";
    const passwordHash = await hashPassword(password);
    const victim = await createUser({ email: EMAIL, passwordHash });

    for (const me of [{ verified: false }, { valid: false }, { valid: false, verified: false }, { email: null }]) {
      stubKakao({ me: () => json(200, kakaoMe(me)) });
      const error = await failure(kakao.finishKakaoLogin(callback()));
      expect(error.reason).toBe("email_required");
      expect(error.code).toBe("VALIDATION");
      expect(error.message).toMatch(/이메일/);
    }
    // 서비스 함수를 직접 불러도 같다.
    expect((await failure(kakao.resolveKakaoLogin({ id: KAKAO_ID, email: EMAIL, emailVerified: false, nickname: "하늘" }))).reason).toBe("email_required");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(row).toMatchObject({ kakaoId: null, passwordHash, lastLoginAt: null });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: { in: ["auth.login", "auth.kakao_link"] } } })).toBe(0);
  });

  it("정지된 계정은 비밀번호 로그인과 같은 문구로 거절한다(연결된 계정이든 이메일이 같은 계정이든)", async () => {
    const { kakao, account } = await load();
    const linked = await createUser({ kakaoId: KAKAO_ID, status: "SUSPENDED" });
    stubKakao();
    const first = await failure(kakao.finishKakaoLogin(callback()));
    expect(first).toMatchObject({ code: "FORBIDDEN", reason: "suspended", message: account.ACCOUNT_SUSPENDED_MESSAGE });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: linked.id } })).lastLoginAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "auth.login_failed", targetId: linked.id } })).toBe(1);

    const byEmail = await createUser({ email: "suspended@example.com", status: "SUSPENDED" });
    stubKakao({ me: () => json(200, kakaoMe({ id: 777000111, email: "suspended@example.com" })) });
    const second = await failure(kakao.finishKakaoLogin(callback()));
    expect(second).toMatchObject({ reason: "suspended", message: account.ACCOUNT_SUSPENDED_MESSAGE });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: byEmail.id } })).kakaoId).toBeNull();
  });

  it("운영자 계정과, 이미 다른 카카오 계정이 연결된 회원에는 연결하지 않는다", async () => {
    const { kakao } = await load();
    const admin = await createUser({ email: "ops@example.com", adminRole: "OPS" });
    stubKakao({ me: () => json(200, kakaoMe({ email: "ops@example.com" })) });
    const adminError = await failure(kakao.finishKakaoLogin(callback()));
    expect(adminError).toMatchObject({ code: "CONFLICT", reason: "conflict" });
    expect(adminError.message).toMatch(/운영자 계정/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).kakaoId).toBeNull();

    const taken = await createUser({ email: "taken@example.com", kakaoId: "1111111111" });
    stubKakao({ me: () => json(200, kakaoMe({ email: "taken@example.com" })) });
    const takenError = await failure(kakao.finishKakaoLogin(callback()));
    expect(takenError).toMatchObject({ code: "CONFLICT", reason: "conflict" });
    expect(takenError.message).toMatch(/다른 카카오 계정/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: taken.id } })).kakaoId).toBe("1111111111");
  });

  it("같은 카카오 계정의 로그인이 동시에 들어와도 한 회원에 한 번만 연결된다", async () => {
    const { kakao } = await load();
    const user = await createUser({ email: EMAIL });
    stubKakao();

    const results = await Promise.all(Array.from({ length: 5 }, () => kakao.finishKakaoLogin(callback())));
    expect(results.every((r) => !r.needsSignup && r.userId === user.id)).toBe(true);
    expect(results.filter((r) => !r.needsSignup && r.linked)).toHaveLength(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).kakaoId).toBe(KAKAO_ID);
    expect(await prisma.auditLog.count({ where: { action: "auth.kakao_link" } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);
  });
});

// ───────────────────────── 콜백 검증 · 카카오 오류 ─────────────────────────

describe("콜백 검증과 카카오 오류", () => {
  it("state 가 쿠키의 값과 다르면 카카오에 아무 요청도 보내지 않고 거절한다", async () => {
    const { kakao } = await load();
    await createUser({ kakaoId: KAKAO_ID });
    const calls = stubKakao();

    const cases = [
      callback({ state: `${STATE.slice(0, -1)}y` }),
      callback({ expectedState: null }),
      callback({ state: null }),
      callback({ state: "", expectedState: "" }),
      callback({ state: "short", expectedState: "short" }),
      callback({ state: STATE, expectedState: `${STATE}x` }),
      // 남이 만든 요청이면 취소 표시(error)가 붙어 있어도 state 부터 확인한다.
      callback({ state: "x".repeat(32), error: "access_denied" }),
    ];
    for (const input of cases) {
      const error = await failure(kakao.finishKakaoLogin(input));
      expect(error.reason).toBe("state");
      expect(error.code).toBe("VALIDATION");
    }
    expect(calls).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { action: "auth.login" } })).toBe(0);
  });

  it("동의 화면에서 취소했거나 코드가 없으면 그에 맞는 안내로 끝난다", async () => {
    const { kakao } = await load();
    const calls = stubKakao();
    expect((await failure(kakao.finishKakaoLogin(callback({ code: null, error: "access_denied" })))).reason).toBe("cancelled");
    expect((await failure(kakao.finishKakaoLogin(callback({ code: null, error: "server_error" })))).reason).toBe("provider");
    expect((await failure(kakao.finishKakaoLogin(callback({ code: null })))).reason).toBe("expired");
    expect(calls).toHaveLength(0);
  });

  it("카카오 오류: 만료된 코드는 다시 시도 안내, 그 밖의 실패는 일반 안내로 바꾸고 토큰·코드를 로그에 남기지 않는다", async () => {
    const { kakao } = await load();
    const user = await createUser({ kakaoId: KAKAO_ID });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const cases: [Parameters<typeof stubKakao>[0], string][] = [
      [{ token: () => json(400, { error: "invalid_grant", error_description: "authorization code not found", error_code: "KOE320" }) }, "expired"],
      [{ token: () => json(401, { error: "invalid_client", error_description: "Bad client credentials", error_code: "KOE010" }) }, "provider"],
      [{ token: () => json(500, { msg: "internal error" }) }, "provider"],
      [{ token: () => new Response("<html>bad gateway</html>", { status: 502 }) }, "provider"],
      [{ token: () => json(200, { token_type: "bearer" }) }, "provider"],
      [
        {
          token: () => {
            throw new TypeError(`fetch failed for code=${AUTH_CODE}`);
          },
        },
        "provider",
      ],
      [{ me: () => json(401, { msg: "this access token does not exist", code: -401 }) }, "provider"],
      [{ me: () => json(200, { kakao_account: { email: EMAIL } }) }, "provider"],
      [
        {
          me: () => {
            throw new TypeError(`fetch failed with ${ACCESS_TOKEN}`);
          },
        },
        "provider",
      ],
    ];
    for (const [handlers, reason] of cases) {
      stubKakao(handlers);
      const error = await failure(kakao.finishKakaoLogin(callback()));
      expect(error.reason).toBe(reason);
      expect(error.message).not.toContain(ACCESS_TOKEN);
      expect(error.message).not.toContain(AUTH_CODE);
    }

    expect(log).toHaveBeenCalled();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(ACCESS_TOKEN);
    expect(logged).not.toContain(AUTH_CODE);
    // 카카오 오류 코드는 남겨 원인을 찾을 수 있게 한다.
    expect(logged).toContain("KOE320");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).lastLoginAt).toBeNull();
  });

  it("응답이 없으면 시간 제한에 걸려 일반 안내로 끝난다", async () => {
    const { kakao } = await load();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );
    const pending = failure(kakao.exchangeKakaoCode(AUTH_CODE, kakao.kakaoRedirectUri()));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).reason).toBe("provider");
  });
});

// ───────────────────────── 가입 ─────────────────────────

describe("카카오 가입", () => {
  async function startSignup(kakao: KakaoModule, me: KakaoMe = {}) {
    stubKakao({ me: () => json(200, kakaoMe(me)) });
    const result = await kakao.finishKakaoLogin(callback());
    if (!result.needsSignup) throw new Error("가입 대기 정보가 나와야 해요.");
    return result.pending;
  }

  it("처음 온 카카오 계정: 가입 대기 정보를 돌려주고, 가입을 마치면 쓸 수 없는 비밀번호와 동의 기록으로 회원을 만든다", async () => {
    const { kakao, account } = await load();
    const pending = await startSignup(kakao);
    expect(await prisma.user.count()).toBe(0);

    // 가입 화면에 미리 채울 값만 꺼낼 수 있고, 내용은 암호화돼 있다.
    const draft = kakao.peekKakaoPending(pending);
    expect(draft).toMatchObject({ email: EMAIL, nickname: "하늘" });
    const minutesLeft = (draft!.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(kakao.KAKAO_FLOW_TTL_MINUTES - 1);
    expect(minutesLeft).toBeLessThanOrEqual(kakao.KAKAO_FLOW_TTL_MINUTES);
    expect(draft).not.toHaveProperty("kakaoId");
    expect(pending).not.toContain(EMAIL);
    expect(pending).not.toContain(KAKAO_ID);

    const ip = nextIp();
    const { userId } = await kakao.completeKakaoSignup(
      pending,
      signupForm({ name: " 김하늘 ", phone: "010-1234-5678", gender: "FEMALE", birthYear: 1995, agreeMarketing: true, agreeNightAlert: true, ip }),
    );
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user).toMatchObject({ email: EMAIL, kakaoId: KAKAO_ID, name: "김하늘", phone: "01012345678", gender: "FEMALE", birthYear: 1995, status: "ACTIVE", nickname: null });
    expect(user.termsAgreedAt).toBeInstanceOf(Date);
    expect(user.marketingConsentAt).toBeInstanceOf(Date);
    expect(user.nightAlertConsentAt).toBeInstanceOf(Date);
    expect(user.lastLoginAt).toBeInstanceOf(Date);

    // 비밀번호 로그인은 쓸 수 없다.
    expect(user.passwordHash.startsWith("scrypt$")).toBe(false);
    expect(await account.getAccount(userId)).toMatchObject({ hasPassword: false, kakaoLinked: true });
    expect((await failure(account.authenticate({ email: EMAIL, password: "Any-Password-1", ip: nextIp() }))).code).toBe("UNAUTHENTICATED");

    const consents = await prisma.consentRecord.findMany({ where: { userId } });
    expect(consents.map((c) => c.kind).sort()).toEqual(["MARKETING", "NIGHT_ALERT", "PRIVACY", "TERMS"]);
    expect(consents.every((c) => c.agreed && c.ip === ip && c.version === POLICY_VERSIONS[c.kind])).toBe(true);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "auth.signup", targetId: userId } });
    expect(log.meta).toMatchObject({ method: "kakao", marketing: true });

    // 같은 대기 정보로 다시 가입할 수 없고, 이후에는 카카오로 바로 로그인된다.
    const again = await failure(kakao.completeKakaoSignup(pending, signupForm()));
    expect(again.code).toBe("CONFLICT");
    expect(again.message).toMatch(/이미 가입된 카카오 계정/);
    stubKakao();
    expect(await kakao.finishKakaoLogin(callback())).toEqual({ needsSignup: false, userId, linked: false });
    expect(await prisma.user.count()).toBe(1);
  });

  it("가입 화면의 값은 이메일 가입과 같은 규칙으로 확인하고, 이메일·카카오 계정은 화면에서 바꿀 수 없다", async () => {
    const { kakao } = await load();
    const pending = await startSignup(kakao);
    const thisYear = kstParts(new Date()).year;

    const cases: [Record<string, unknown>, string, RegExp][] = [
      [{ name: "  " }, "name", /이름을 입력/],
      [{ phone: "02-123-4567" }, "phone", /휴대전화 번호/],
      [{ birthYear: thisYear - MIN_SIGNUP_AGE + 1 }, "birthYear", /세 이상/],
      [{ agreeTerms: false }, "agreeTerms", /이용약관/],
      [{ agreePrivacy: false }, "agreePrivacy", /개인정보/],
      [{ agreeAge14: false }, "agreeAge14", /세 이상/],
      [{ agreeNightAlert: true }, "agreeNightAlert", /광고성 정보 수신/],
    ];
    for (const [overrides, field, message] of cases) {
      const error = await failure(kakao.completeKakaoSignup(pending, signupForm(overrides)));
      expect(error.code, field).toBe("VALIDATION");
      expect(error.fieldErrors?.[field], field).toMatch(message);
    }
    expect(await prisma.user.count()).toBe(0);

    // 입력에 이메일·카카오 회원번호를 끼워 넣어도 대기 정보의 값만 쓴다.
    const smuggled = { ...signupForm(), email: "attacker@example.com", kakaoId: "999" } as Parameters<KakaoModule["completeKakaoSignup"]>[1];
    const { userId } = await kakao.completeKakaoSignup(pending, smuggled);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({ email: EMAIL, kakaoId: KAKAO_ID });
  });

  it("대기 정보가 없거나, 변조됐거나, 10분이 지났으면 가입할 수 없다", async () => {
    const { kakao } = await load();
    const pending = await startSignup(kakao);
    const tampered = `${pending.slice(0, -4)}${pending.endsWith("AAAA") ? "BBBB" : "AAAA"}`;

    for (const token of ["", "not-a-token", "v1.aaaa.bbbb.cccc", tampered]) {
      expect(kakao.peekKakaoPending(token)).toBeNull();
      const error = await failure(kakao.completeKakaoSignup(token, signupForm()));
      expect(error.reason).toBe("expired");
      expect(error.message).toMatch(/카카오 로그인을 다시 시도/);
    }
    expect(kakao.peekKakaoPending(null)).toBeNull();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + kakao.KAKAO_FLOW_TTL_MINUTES * 60_000 + 1000);
    expect(kakao.peekKakaoPending(pending)).toBeNull();
    expect((await failure(kakao.completeKakaoSignup(pending, signupForm()))).reason).toBe("expired");
    expect(await prisma.user.count()).toBe(0);
  });

  it("같은 대기 정보로 동시에 가입을 마치려 해도 회원은 한 명만 만들어진다", async () => {
    const { kakao } = await load();
    const pending = await startSignup(kakao);

    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => kakao.completeKakaoSignup(pending, signupForm())));
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    for (const s of settled) {
      if (s.status === "rejected") expect(s.reason).toMatchObject({ name: "AppError", code: "CONFLICT" });
    }
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.consentRecord.count()).toBe(2);
  });

  it("가입을 기다리는 사이 같은 이메일로 다른 계정이 생기면 가입을 거절한다", async () => {
    const { kakao } = await load();
    const pending = await startSignup(kakao);
    await createUser({ email: EMAIL });
    const error = await failure(kakao.completeKakaoSignup(pending, signupForm()));
    expect(error.code).toBe("CONFLICT");
    expect(error.fieldErrors?.email).toMatch(/이미 가입된 이메일/);
    expect(await prisma.user.count()).toBe(1);
  });

  it("탈퇴하면 카카오 연결이 끊겨, 같은 카카오 계정으로 다시 가입할 수 있다", async () => {
    const { kakao, account } = await load();
    const first = await kakao.completeKakaoSignup(await startSignup(kakao), signupForm());
    await account.withdrawAccount({ userId: first.userId, confirmText: account.WITHDRAW_CONFIRM_TEXT });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: first.userId } })).toMatchObject({ status: "WITHDRAWN", kakaoId: null });

    const second = await kakao.completeKakaoSignup(await startSignup(kakao), signupForm());
    expect(second.userId).not.toBe(first.userId);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: second.userId } })).toMatchObject({ email: EMAIL, kakaoId: KAKAO_ID, status: "ACTIVE" });
  });
});

// ───────────────────────── 라우트 핸들러 · 서버 액션 ─────────────────────────

describe("라우트 핸들러", () => {
  async function loadRoutes(env?: Parameters<typeof load>[0]) {
    const modules = await load(env);
    const start = await import("@/app/api/auth/kakao/start/route");
    const cb = await import("@/app/api/auth/kakao/callback/route");
    const actions = await import("@/server/auth/actions");
    return { ...modules, start, cb, actions };
  }
  const startUrl = (query = "") => new Request(`http://localhost:3000/api/auth/kakao/start${query}`);
  const callbackUrl = (params: Record<string, string>) => new Request(`http://localhost:3000/api/auth/kakao/callback?${new URLSearchParams(params)}`);
  const cookie = (name: string) => jar.store.get(name);

  it("시작: state 와 돌아갈 경로를 HttpOnly·SameSite=Lax 쿠키(10분)에 심고 카카오로 보낸다", async () => {
    const { start, kakao } = await loadRoutes();
    const names = kakao.kakaoCookieNames();

    const res = await start.GET(startUrl("?next=%2Fmy%2Fbookings%3Ftab%3Dupcoming"));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(`${location.origin}${location.pathname}`).toBe("https://kauth.kakao.com/oauth/authorize");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const state = cookie(names.state)!;
    expect(location.searchParams.get("state")).toBe(state.value);
    expect(state.value.length).toBeGreaterThanOrEqual(20);
    expect(state.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: kakao.KAKAO_FLOW_TTL_MINUTES * 60 });
    expect(cookie(names.next)).toMatchObject({ value: "/my/bookings?tab=upcoming", options: { httpOnly: true, sameSite: "lax" } });

    // 다른 사이트로 보내는 경로는 받지 않는다.
    for (const next of ["//evil.example", "https://evil.example/path", `/${"a".repeat(600)}`]) {
      await start.GET(startUrl(`?next=${encodeURIComponent(next)}`));
      expect(cookie(names.next)!.value).toBe("/");
    }
  });

  it("시작·콜백: 연동 키가 없으면 로그인 화면으로 돌려보낸다", async () => {
    const { start, cb, kakao } = await loadRoutes({});
    const calls = stubKakao();
    const started = await start.GET(startUrl());
    expect(started.headers.get("Location")).toBe("http://localhost:3000/login?error=kakao_not_configured");
    expect(jar.store.size).toBe(0);

    jar.api.set(kakao.kakaoCookieNames().state, STATE, kakao.kakaoCookieOptions());
    const returned = await cb.GET(callbackUrl({ code: AUTH_CODE, state: STATE }));
    expect(returned.headers.get("Location")).toBe("http://localhost:3000/login?error=kakao_not_configured");
    expect(calls).toHaveLength(0);
  });

  it("콜백: 연결된 회원이면 세션을 발급하고 원래 가려던 경로로 보낸다", async () => {
    const { start, cb, kakao } = await loadRoutes();
    const names = kakao.kakaoCookieNames();
    const user = await createUser({ kakaoId: KAKAO_ID });
    await start.GET(startUrl("?next=%2Fmy%2Fbookings"));
    const state = cookie(names.state)!.value;
    stubKakao();

    const res = await cb.GET(callbackUrl({ code: AUTH_CODE, state }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://localhost:3000/my/bookings");

    // 세션 쿠키가 심기고 DB 에는 해시만 남는다. 흐름에 쓴 쿠키는 지운다.
    const session = cookie("nj_session")!;
    expect(session.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    const row = await prisma.authSession.findUniqueOrThrow({ where: { tokenHash: sha256(session.value) } });
    expect(row).toMatchObject({ userId: user.id, isAdmin: false, revokedAt: null });
    expect(cookie(names.state)).toBeUndefined();
    expect(cookie(names.next)).toBeUndefined();
    expect(cookie(names.pending)).toBeUndefined();

    // state 는 한 번만 쓸 수 있다: 같은 주소를 다시 열면 거절된다.
    const replay = await cb.GET(callbackUrl({ code: AUTH_CODE, state }));
    expect(replay.headers.get("Location")).toBe("http://localhost:3000/login?error=kakao_state");
    expect(await prisma.authSession.count()).toBe(1);
  });

  it("콜백: state 가 쿠키와 다르면 카카오에 요청하지 않고 로그인 화면으로 보낸다(세션 없음)", async () => {
    const { start, cb, kakao } = await loadRoutes();
    const names = kakao.kakaoCookieNames();
    await createUser({ kakaoId: KAKAO_ID });
    await start.GET(startUrl("?next=%2Fmy"));
    const calls = stubKakao();

    const res = await cb.GET(callbackUrl({ code: AUTH_CODE, state: "attacker-chosen-state-value-000000" }));
    expect(res.headers.get("Location")).toBe("http://localhost:3000/login?error=kakao_state&next=%2Fmy");
    expect(calls).toHaveLength(0);
    expect(cookie("nj_session")).toBeUndefined();
    expect(cookie(names.state)).toBeUndefined();
    expect(await prisma.authSession.count()).toBe(0);

    // 쿠키 없이 콜백만 열어도 같다.
    jar.store.clear();
    const bare = await cb.GET(callbackUrl({ code: AUTH_CODE, state: STATE }));
    expect(bare.headers.get("Location")).toBe("http://localhost:3000/login?error=kakao_state");
  });

  it("콜백: 카카오 오류와 취소는 사유를 담아 로그인 화면으로 보낸다", async () => {
    const { cb, kakao } = await loadRoutes();
    const names = kakao.kakaoCookieNames();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const open = async (params: Record<string, string>) => {
      jar.api.set(names.state, STATE, kakao.kakaoCookieOptions());
      return (await cb.GET(callbackUrl({ state: STATE, ...params }))).headers.get("Location");
    };

    stubKakao({ token: () => json(500, {}) });
    expect(await open({ code: AUTH_CODE })).toBe("http://localhost:3000/login?error=kakao_provider");
    stubKakao({ token: () => json(400, { error: "invalid_grant", error_code: "KOE320" }) });
    expect(await open({ code: AUTH_CODE })).toBe("http://localhost:3000/login?error=kakao_expired");
    stubKakao();
    expect(await open({ error: "access_denied" })).toBe("http://localhost:3000/login?error=kakao_cancelled");
    stubKakao({ me: () => json(200, kakaoMe({ verified: false })) });
    expect(await open({ code: AUTH_CODE })).toBe("http://localhost:3000/login?error=kakao_email_required");
    await createUser({ kakaoId: KAKAO_ID, status: "SUSPENDED" });
    stubKakao();
    expect(await open({ code: AUTH_CODE })).toBe("http://localhost:3000/login?error=kakao_suspended");
    expect(await prisma.authSession.count()).toBe(0);
  });

  it("콜백 → 가입 화면 → 가입 완료 액션: 대기 정보는 HttpOnly 쿠키로만 오가고, 가입하면 바로 로그인된다", async () => {
    const { start, cb, actions, kakao } = await loadRoutes();
    const names = kakao.kakaoCookieNames();
    await start.GET(startUrl("?next=%2Fslots%2Fabc"));
    stubKakao();

    const res = await cb.GET(callbackUrl({ code: AUTH_CODE, state: cookie(names.state)!.value }));
    expect(res.headers.get("Location")).toBe("http://localhost:3000/signup/kakao");
    const pending = cookie(names.pending)!;
    expect(pending.options).toMatchObject({ httpOnly: true, sameSite: "lax", maxAge: kakao.KAKAO_FLOW_TTL_MINUTES * 60 });
    expect(kakao.peekKakaoPending(pending.value)).toMatchObject({ email: EMAIL, nickname: "하늘" });
    expect(cookie("nj_session")).toBeUndefined();
    expect(await prisma.user.count()).toBe(0);

    // 필수 동의가 빠지면 가입되지 않고 대기 정보는 남는다.
    const rejected = await actions.completeKakaoSignupAction({ name: "김하늘", agreeTerms: true, agreePrivacy: false, agreeAge14: true });
    expect(rejected).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(cookie(names.pending)).toBeDefined();

    const done = await actions.completeKakaoSignupAction({ name: "김하늘", agreeTerms: true, agreePrivacy: true, agreeAge14: true, agreeMarketing: true });
    expect(done).toEqual({ ok: true, data: { redirectTo: "/slots/abc" } });
    const user = await prisma.user.findFirstOrThrow({ where: { kakaoId: KAKAO_ID } });
    expect(user).toMatchObject({ email: EMAIL, name: "김하늘" });
    const session = cookie("nj_session")!;
    expect(await prisma.authSession.findUniqueOrThrow({ where: { tokenHash: sha256(session.value) } })).toMatchObject({ userId: user.id });
    expect(cookie(names.pending)).toBeUndefined();
    expect(cookie(names.next)).toBeUndefined();
    // 동의 기록에는 요청의 IP 가 남는다.
    expect((await prisma.consentRecord.findMany({ where: { userId: user.id } })).every((c) => c.ip === "203.0.113.50")).toBe(true);

    // 대기 정보 없이 액션만 부르면 실패한다.
    const bare = await actions.completeKakaoSignupAction({ name: "김하늘", agreeTerms: true, agreePrivacy: true, agreeAge14: true });
    expect(bare).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(await prisma.user.count()).toBe(1);
  });
});
