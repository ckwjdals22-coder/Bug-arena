import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidBusinessRegNo } from "@/lib/format";
import { MIN_SIGNUP_AGE } from "@/lib/policy";
import { kstParts } from "@/lib/time";
import { updateProfile } from "@/server/auth/account";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  completeIdentityVerification,
  completeMockIdentity,
  getIdentityProvider,
  getIdentityStatus,
  getRealIdentityProvider,
  startIdentityVerification,
} from "@/server/services/identity";
import { verifyBusinessRegistration } from "@/server/services/verification";
import { createUser, resetDb } from "./helpers";

type IdentityModule = typeof import("@/server/services/identity");
type VerificationModule = typeof import("@/server/services/verification");

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("실패해야 하는 호출이 성공했어요.");
}

/** 환경 변수를 바꾼 새 모듈을 불러온다(env 는 처음 읽을 때 고정된다). */
async function loadWithEnv<T>(env: Record<string, string>, path: "identity" | "verification"): Promise<T> {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  return (path === "identity" ? import("@/server/services/identity") : import("@/server/services/verification")) as Promise<T>;
}

/** 운영 환경에서 env() 가 요구하는 값 */
const PRODUCTION_ENV = {
  NODE_ENV: "production",
  APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  CRON_SECRET: "cron-secret-for-tests",
  PAYMENT_PROVIDER: "toss",
  TOSS_CLIENT_KEY: "test_ck_xxxxxxxx",
  TOSS_SECRET_KEY: "test_sk_xxxxxxxx",
  DEMO_MODE: "",
};

// ───────────────────────── 본인확인 ─────────────────────────

describe("본인확인 어댑터", () => {
  it("운영 환경에서는 연결된 본인확인이 없고(none), 시연 배포와 개발 환경에서만 가짜 본인확인(mock)을 쓴다", async () => {
    expect(getIdentityProvider()).toBe("mock");

    const production = await loadWithEnv<IdentityModule>(PRODUCTION_ENV, "identity");
    expect(production.getIdentityProvider()).toBe("none");
    const user = await createUser();
    expect(await production.getIdentityStatus(user.id)).toEqual({ verified: false, verifiedAt: null, provider: "none", canVerify: false, isMock: false });
    // 가짜 본인확인은 운영 환경에서 쓸 수 없다.
    await expect(production.completeMockIdentity(user.id, { name: "김하늘", birthYear: 1995, gender: "FEMALE" })).rejects.toMatchObject({
      name: "AppError",
      code: "NOT_CONFIGURED",
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).identityVerifiedAt).toBeNull();

    const demo = await loadWithEnv<IdentityModule>({ ...PRODUCTION_ENV, PAYMENT_PROVIDER: "mock", DEMO_MODE: "1" }, "identity");
    expect(demo.getIdentityProvider()).toBe("mock");
  });

  it("실제 본인확인 기관은 아직 연결되지 않아, 호출하면 안내와 함께 NOT_CONFIGURED 로 끝난다", async () => {
    const user = await createUser();
    const provider = getRealIdentityProvider();
    for (const run of [
      () => provider.start(user.id),
      () => provider.complete({ token: "anything" }),
      () => startIdentityVerification(user.id),
      () => completeIdentityVerification(user.id, { token: "anything" }),
    ]) {
      const error = await failure(run());
      expect(error.code).toBe("NOT_CONFIGURED");
      expect(error.message).toMatch(/본인확인 서비스가 아직 연결되지 않았어요/);
    }
    expect((await failure(startIdentityVerification("missing-user"))).code).toBe("NOT_FOUND");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).identityVerifiedAt).toBeNull();
  });

  it("가짜 본인확인을 마치면 확인된 이름·출생 연도·성별이 저장되고, 이후 프로필에서 바꿀 수 없다", async () => {
    const user = await createUser({ name: "하늘이", gender: null, birthYear: null });
    expect(await getIdentityStatus(user.id)).toEqual({ verified: false, verifiedAt: null, provider: "mock", canVerify: true, isMock: true });

    const status = await completeMockIdentity(user.id, { name: " 김하늘 ", birthYear: 1995, gender: "FEMALE" });
    expect(status).toMatchObject({ verified: true, provider: "mock", canVerify: false, isMock: true });
    expect(status.verifiedAt).toBeInstanceOf(Date);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row).toMatchObject({ name: "김하늘", birthYear: 1995, gender: "FEMALE" });
    expect(row.identityVerifiedAt).toEqual(status.verifiedAt);
    expect(await getIdentityStatus(user.id)).toEqual(status);

    // 감사 기록에는 확인 방법만 남고 값은 남지 않는다.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "user.identity_verify", targetId: user.id } });
    expect(log).toMatchObject({ actorId: user.id, actorType: "CUSTOMER" });
    expect(log.meta).toEqual({ via: "mock" });
    expect(JSON.stringify(log)).not.toContain("김하늘");

    // 확인된 값은 고정된다: 성별·출생 연도·이름은 바꿀 수 없고 다른 항목은 바꿀 수 있다.
    for (const patch of [{ gender: "MALE" as const }, { birthYear: 1990 }, { name: "이하늘" }, { gender: null }, { birthYear: null }]) {
      const error = await failure(updateProfile(user.id, patch));
      expect(error.code).toBe("VALIDATION");
      expect(Object.keys(error.fieldErrors ?? {})).toEqual(Object.keys(patch));
    }
    expect(await updateProfile(user.id, { nickname: "하늘", gender: "FEMALE", birthYear: 1995 })).toMatchObject({ nickname: "하늘", identityVerified: true });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ name: "김하늘", birthYear: 1995, gender: "FEMALE" });

    // 본인확인은 한 번만 할 수 있다.
    const again = await failure(completeMockIdentity(user.id, { name: "박하늘", birthYear: 1980, gender: "MALE" }));
    expect(again.code).toBe("CONFLICT");
    expect(again.message).toMatch(/이미 본인확인을 마쳤어요/);
    expect((await failure(startIdentityVerification(user.id))).code).toBe("CONFLICT");
  });

  it("확인할 값의 형식과 나이를 검증하고, 없는 회원·정지된 회원은 거절한다", async () => {
    const user = await createUser();
    const thisYear = kstParts(new Date()).year;
    const cases: [{ name: string; birthYear: number; gender: "MALE" | "FEMALE" }, string][] = [
      [{ name: "  ", birthYear: 1995, gender: "FEMALE" }, "name"],
      [{ name: "김하늘", birthYear: thisYear - MIN_SIGNUP_AGE + 1, gender: "FEMALE" }, "birthYear"],
      [{ name: "김하늘", birthYear: 1850, gender: "FEMALE" }, "birthYear"],
      [{ name: "김하늘", birthYear: 1995, gender: "OTHER" as "MALE" }, "gender"],
    ];
    for (const [input, field] of cases) {
      const error = await failure(completeMockIdentity(user.id, input));
      expect(error.code, field).toBe("VALIDATION");
      expect(error.fieldErrors?.[field], field).toBeTruthy();
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).identityVerifiedAt).toBeNull();

    const suspended = await createUser({ status: "SUSPENDED" });
    for (const id of ["missing-user", suspended.id]) {
      expect((await failure(completeMockIdentity(id, { name: "김하늘", birthYear: 1995, gender: "FEMALE" }))).code).toBe("NOT_FOUND");
      expect((await failure(getIdentityStatus(id))).code).toBe("NOT_FOUND");
    }
  });

  it("동시에 들어온 본인확인은 하나만 반영된다", async () => {
    const user = await createUser();
    const names = ["김하나", "김두리", "김세찌", "김네찌"];
    const settled = await Promise.allSettled(names.map((name, i) => completeMockIdentity(user.id, { name, birthYear: 1990 + i, gender: "FEMALE" })));

    const winners = settled.flatMap((s, i) => (s.status === "fulfilled" ? [i] : []));
    expect(winners).toHaveLength(1);
    for (const s of settled) {
      if (s.status === "rejected") expect(s.reason).toMatchObject({ code: "CONFLICT" });
    }
    // 저장된 값은 성공한 요청의 것 그대로다(다른 요청의 값과 섞이지 않는다).
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row).toMatchObject({ name: names[winners[0]!], birthYear: 1990 + winners[0]! });
    expect(await prisma.auditLog.count({ where: { action: "user.identity_verify" } })).toBe(1);
  });
});

// ───────────────────────── 사업자등록번호 확인 ─────────────────────────

/** 앞 9자리로 검증 숫자가 맞는 사업자등록번호를 만든다. */
function regNo(base9: string): string {
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(base9[i]) * weights[i]!;
  sum += Math.floor((Number(base9[8]) * 5) / 10);
  return `${base9}${(10 - (sum % 10)) % 10}`;
}

const VALID = regNo("123456789");
const NTS_URL = "https://api.odcloud.kr/api/nts-businessman/v1/status";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** 국세청 상태조회 응답 한 건 */
const ntsItem = (overrides: Record<string, string> = {}) => ({
  b_no: VALID,
  b_stt: "계속사업자",
  b_stt_cd: "01",
  tax_type: "부가가치세 일반과세자",
  tax_type_cd: "01",
  end_dt: "",
  utcc_yn: "N",
  tax_type_change_dt: "",
  invoice_apply_dt: "",
  rbf_tax_type: "해당없음",
  rbf_tax_type_cd: "99",
  ...overrides,
});
const ntsOk = (item: Record<string, string>) => json(200, { status_code: "OK", match_cnt: 1, request_cnt: 1, data: [item] });

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(respond: () => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return respond();
    }),
  );
  return calls;
}

describe("verifyBusinessRegistration", () => {
  it("검증 숫자가 틀린 번호는 조회하지 않고 바로 틀렸다고 알려 준다", async () => {
    const { verifyBusinessRegistration: verify } = await loadWithEnv<VerificationModule>({ NTS_SERVICE_KEY: "service-key" }, "verification");
    const calls = stubFetch(() => ntsOk(ntsItem()));
    const wrong = `${VALID.slice(0, 9)}${(Number(VALID[9]) + 1) % 10}`;
    expect(isValidBusinessRegNo(wrong)).toBe(false);

    for (const input of [wrong, "123", "", "abcdefghij", `${VALID}1`]) {
      const result = await verify(input);
      expect(result).toMatchObject({ checked: "CHECKSUM_ONLY", valid: false });
      expect(result.note).toMatch(/형식이 맞지 않아요/);
    }
    expect(calls).toHaveLength(0);
  });

  it("인증키가 없으면 번호 형식만 확인하고 그 사실을 알려 준다", async () => {
    const calls = stubFetch(() => ntsOk(ntsItem()));
    const result = await verifyBusinessRegistration(`${VALID.slice(0, 3)}-${VALID.slice(3, 5)}-${VALID.slice(5)}`);
    expect(result).toEqual({ checked: "CHECKSUM_ONLY", valid: true, note: expect.stringMatching(/연결되지 않아 번호 형식만 확인/) });
    expect(calls).toHaveLength(0);
  });

  it("인증키가 있으면 국세청 상태조회로 계속사업자인지 확인한다(요청 형식 포함)", async () => {
    const key = "abc+def/ghi==";
    const { verifyBusinessRegistration: verify } = await loadWithEnv<VerificationModule>({ NTS_SERVICE_KEY: key }, "verification");
    const calls = stubFetch(() => ntsOk(ntsItem()));

    const result = await verify(`${VALID.slice(0, 3)}-${VALID.slice(3, 5)}-${VALID.slice(5)}`);
    expect(result).toEqual({ checked: "API", valid: true, status: "계속사업자", taxType: "부가가치세 일반과세자", raw: ntsItem() });

    expect(calls).toHaveLength(1);
    // 인증키는 주소에 맞게 인코딩해 넣는다.
    expect(calls[0]!.url).toBe(`${NTS_URL}?serviceKey=${encodeURIComponent(key)}`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ b_no: [VALID] });
    expect((calls[0]!.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("이미 인코딩된 인증키(% 포함)는 다시 인코딩하지 않는다", async () => {
    const encoded = "abc%2Bdef%2Fghi%3D%3D";
    const { verifyBusinessRegistration: verify } = await loadWithEnv<VerificationModule>({ NTS_SERVICE_KEY: encoded }, "verification");
    const calls = stubFetch(() => ntsOk(ntsItem()));
    await verify(VALID);
    expect(calls[0]!.url).toBe(`${NTS_URL}?serviceKey=${encoded}`);
  });

  it("휴업·폐업·미등록 번호는 유효하지 않다고 알려 준다", async () => {
    const { verifyBusinessRegistration: verify } = await loadWithEnv<VerificationModule>({ NTS_SERVICE_KEY: "service-key" }, "verification");

    stubFetch(() => ntsOk(ntsItem({ b_stt: "휴업자", b_stt_cd: "02" })));
    expect(await verify(VALID)).toMatchObject({ checked: "API", valid: false, status: "휴업자", taxType: "부가가치세 일반과세자" });

    stubFetch(() => ntsOk(ntsItem({ b_stt: "폐업자", b_stt_cd: "03", end_dt: "20240131" })));
    const closed = await verify(VALID);
    expect(closed).toMatchObject({ checked: "API", valid: false, status: "폐업자" });
    expect(closed.raw).toMatchObject({ end_dt: "20240131" });

    stubFetch(() => ntsOk(ntsItem({ b_stt: "", b_stt_cd: "", tax_type: "국세청에 등록되지 않은 사업자등록번호입니다." })));
    const unknown = await verify(VALID);
    expect(unknown).toMatchObject({ checked: "API", valid: false, status: "미등록", note: "국세청에 등록되지 않은 사업자등록번호입니다." });
    expect(unknown.taxType).toBeUndefined();
  });

  it("조회에 실패하면 번호 형식 확인으로 내려가고, 인증키를 로그에 남기지 않는다", async () => {
    const key = "super-secret-service-key";
    const { verifyBusinessRegistration: verify } = await loadWithEnv<VerificationModule>({ NTS_SERVICE_KEY: key }, "verification");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const failures: (() => Response | Promise<Response>)[] = [
      () => {
        throw new TypeError(`fetch failed: ${NTS_URL}?serviceKey=${key}`);
      },
      () => json(500, { code: -5, msg: "internal error" }),
      () => new Response("<html>Service Unavailable</html>", { status: 503 }),
      () => json(401, { code: -401, msg: "등록되지 않은 인증키 입니다." }),
      () => json(200, { status_code: "OK", data: [] }),
      // 다른 번호의 결과만 돌아온 경우
      () => ntsOk(ntsItem({ b_no: regNo("987654321") })),
    ];
    for (const respond of failures) {
      stubFetch(respond);
      const result = await verify(VALID);
      expect(result).toMatchObject({ checked: "CHECKSUM_ONLY", valid: true });
      expect(result.note).toMatch(/국세청 조회에 실패해 번호 형식만 확인했어요/);
      expect(result.status).toBeUndefined();
    }
    expect(log).toHaveBeenCalledTimes(failures.length);
    expect(JSON.stringify(log.mock.calls)).not.toContain(key);
  });

  it("응답이 없으면 시간 제한에 걸려 번호 형식 확인으로 내려간다", async () => {
    const { verifyBusinessRegistration: verify } = await loadWithEnv<VerificationModule>({ NTS_SERVICE_KEY: "service-key" }, "verification");
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
    const pending = verify(VALID);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toMatchObject({ checked: "CHECKSUM_ONLY", valid: true });
    vi.useRealTimers();
  });
});
