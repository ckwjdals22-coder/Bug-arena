import "server-only";

/** 발송 어댑터 공통 결과. 실패 시 retryable 이 false 면 다시 시도해도 소용없는 오류(설정·형식 오류)다. */
export type ProviderResult =
  | { ok: true; provider: string; messageId: string | null }
  | { ok: false; provider: string; error: string; retryable: boolean };

export const PROVIDER_TIMEOUT_MS = 10_000;
const ERROR_MAX = 200;

/** 일시적인 장애로 볼 수 있는 HTTP 상태(다시 시도할 가치가 있음) */
export const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

/**
 * 오류 문구를 저장·로그용으로 다듬는다.
 * 발송 사업자가 응답에 수신 번호·주소를 되돌려 주는 경우가 있어 연락처로 보이는 부분은 가린다.
 */
export function shortError(message: string): string {
  return message
    .replace(/\s+/g, " ")
    .replace(/(?:\+?82[- ]?|0)1[016789][- ]?\d{3,4}[- ]?\d{4}/g, "***")
    .replace(/\d{9,}/g, "***")
    .replace(/[^\s@<>"':]+@[^\s@<>"']+\.[^\s@<>"']+/g, "***")
    .trim()
    .slice(0, ERROR_MAX);
}

export interface JsonResponse {
  status: number;
  ok: boolean;
  json: Record<string, unknown> | null;
}

/** JSON POST + 시간 제한. 네트워크 오류·시간 초과는 예외로 던진다(호출부에서 재시도 대상으로 처리). */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number = PROVIDER_TIMEOUT_MS,
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = text ? JSON.parse(text) : null;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch {
      // JSON 이 아닌 응답(게이트웨이 오류 페이지 등)은 상태 코드만으로 판단한다.
    }
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

/** fetch 가 던진 예외를 짧은 오류 문구로 */
export function describeNetworkError(e: unknown): string {
  if (e instanceof Error && e.name === "AbortError") return "응답 시간 초과";
  return e instanceof Error ? `네트워크 오류: ${e.message}` : "네트워크 오류";
}

export const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
