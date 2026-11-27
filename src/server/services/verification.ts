import "server-only";
import { z } from "zod";
import { env } from "@/lib/env";
import { isValidBusinessRegNo } from "@/lib/format";

/**
 * 사업자등록번호 확인 어댑터(입점 심사용).
 * - 번호 형식과 검증 숫자는 항상 확인한다.
 * - NTS_SERVICE_KEY 가 있으면 국세청 사업자등록 상태조회 API 로 "계속사업자" 인지까지 확인한다.
 *   조회에 실패하면(연결 실패·시간 초과·오류 응답) 형식 확인 결과만 돌려주고 note 에 그 사실을 적는다 — 심사를 막지 않는다.
 * 인증키는 주소에 들어가므로 주소·응답 원문을 로그에 남기지 않는다.
 * 호출 횟수 제한과 권한 확인은 호출부(운영자 심사 화면)가 맡는다.
 */

const NTS_STATUS_URL = "https://api.odcloud.kr/api/nts-businessman/v1/status";
const NTS_TIMEOUT_MS = 8_000;

export interface BusinessRegistrationCheck {
  /** API: 국세청 조회까지 마침 / CHECKSUM_ONLY: 번호 형식(검증 숫자)만 확인함 */
  checked: "API" | "CHECKSUM_ONLY";
  /**
   * API 로 확인했으면 "계속사업자" 일 때만 true(휴업·폐업·미등록은 false).
   * 형식만 확인했으면 검증 숫자가 맞는지 여부다 — 실제로 등록된 번호인지는 알 수 없다.
   */
  valid: boolean;
  /** 납세자 상태: "계속사업자" | "휴업자" | "폐업자" | "미등록" 등(API 로 확인했을 때만) */
  status?: string;
  /** 과세 유형(예: "부가가치세 일반과세자") */
  taxType?: string;
  /** 국세청 응답의 해당 사업자 항목(공개 정보). 심사 화면에서 자세히 볼 때 쓴다 */
  raw?: Record<string, unknown>;
  /** 형식만 확인하게 된 이유 등 심사자에게 보여 줄 안내 */
  note?: string;
}

const ntsResponseSchema = z.object({
  data: z
    .array(
      z.object({
        b_no: z.string().max(20),
        b_stt: z.string().max(40).nullish(),
        b_stt_cd: z.string().max(4).nullish(),
        tax_type: z.string().max(200).nullish(),
      }),
    )
    .min(1),
});

/** 공공데이터포털 인증키는 인코딩된 값(% 포함)과 원래 값 두 가지로 발급된다. 어느 쪽을 넣어도 주소에 맞게 넣는다. */
const encodeServiceKey = (key: string) => (key.includes("%") ? key : encodeURIComponent(key));

const NOTE_NO_KEY = "국세청 조회가 연결되지 않아 번호 형식만 확인했어요.";
const NOTE_API_FAILED = "국세청 조회에 실패해 번호 형식만 확인했어요. 잠시 후 다시 확인해 주세요.";

/** 사업자등록번호를 확인한다. 하이픈이 섞여 있어도 된다. 예외를 던지지 않는다. */
export async function verifyBusinessRegistration(regNo: string): Promise<BusinessRegistrationCheck> {
  const digits = typeof regNo === "string" ? regNo.replace(/\D/g, "").slice(0, 20) : "";
  if (!isValidBusinessRegNo(digits)) {
    return { checked: "CHECKSUM_ONLY", valid: false, note: "사업자등록번호 형식이 맞지 않아요(10자리, 검증 숫자 불일치)." };
  }
  const serviceKey = env().NTS_SERVICE_KEY?.trim();
  if (!serviceKey) return { checked: "CHECKSUM_ONLY", valid: true, note: NOTE_NO_KEY };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NTS_TIMEOUT_MS);
  let status: number;
  let json: unknown;
  try {
    const res = await fetch(`${NTS_STATUS_URL}?serviceKey=${encodeServiceKey(serviceKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ b_no: [digits] }),
      signal: controller.signal,
      cache: "no-store",
    });
    status = res.status;
    json = await res.json();
  } catch {
    console.error(`[verification] 국세청 조회 실패 — ${controller.signal.aborted ? "응답 시간 초과" : "연결 실패 또는 응답 형식 오류"}`);
    return { checked: "CHECKSUM_ONLY", valid: true, note: NOTE_API_FAILED };
  } finally {
    clearTimeout(timer);
  }

  const parsed = ntsResponseSchema.safeParse(json);
  const item = parsed.success ? parsed.data.data.find((row) => row.b_no.replace(/\D/g, "") === digits) : undefined;
  if (status !== 200 || !item) {
    console.error(`[verification] 국세청 조회 실패 — status=${status}`);
    return { checked: "CHECKSUM_ONLY", valid: true, note: NOTE_API_FAILED };
  }

  const raw = (json as { data: Record<string, unknown>[] }).data.find((row) => String(row.b_no).replace(/\D/g, "") === digits);
  const state = item.b_stt?.trim() ?? "";
  // 등록되지 않은 번호는 상태가 비어 있고 tax_type 자리에 안내 문구가 온다.
  if (!state) {
    return { checked: "API", valid: false, status: "미등록", note: item.tax_type?.trim() || "국세청에 등록되지 않은 사업자등록번호예요.", raw };
  }
  return {
    checked: "API",
    // 01 = 계속사업자, 02 = 휴업자, 03 = 폐업자
    valid: item.b_stt_cd === "01" || (!item.b_stt_cd && state === "계속사업자"),
    status: state,
    taxType: item.tax_type?.trim() || undefined,
    raw,
  };
}
