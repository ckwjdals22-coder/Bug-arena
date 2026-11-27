import "server-only";
import { randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { hmacSha256 } from "@/server/security/crypto";
import { asString, describeNetworkError, isRetryableStatus, postJson, shortError, type ProviderResult } from "./shared";

/**
 * SOLAPI 문자 발송 어댑터.
 * - 인증: https://solapi.com/developers/api/authentication-api-key
 * - 발송: https://solapi.com/developers/api/messages (POST /messages/v4/send-many/detail)
 *
 * 실제 발송에는 SOLAPI 계정의 API 키·시크릿과, 통신사에 사전 등록한 발신번호(SOLAPI_SENDER)가 필요하다.
 */
const SOLAPI_SEND_URL = "https://api.solapi.com/messages/v4/send-many/detail";
const PROVIDER = "solapi";
const SMS_MAX_BYTES = 90;
const LMS_MAX_BYTES = 2000;
const SUBJECT_MAX_BYTES = 40;
const DEFAULT_SUBJECT = "남는자리";

export interface SolapiConfig {
  apiKey: string;
  apiSecret: string;
  sender: string;
}

/** 환경 변수로 구성한 연동 정보. 하나라도 빠졌으면 null */
export function solapiConfig(): SolapiConfig | null {
  const e = env();
  const sender = (e.SOLAPI_SENDER ?? "").replace(/\D/g, "");
  if (!e.SOLAPI_API_KEY || !e.SOLAPI_API_SECRET || !sender) return null;
  return { apiKey: e.SOLAPI_API_KEY, apiSecret: e.SOLAPI_API_SECRET, sender };
}

/**
 * 인증 헤더: HMAC-SHA256 apiKey=<키>, date=<ISO 8601>, salt=<무작위 hex>, signature=<hex HMAC-SHA256(secret, date + salt)>
 * 같은 서명은 15분 안에 다시 쓸 수 없으므로 요청마다 salt 를 새로 만든다.
 */
export function buildSolapiAuthHeader(
  apiKey: string,
  apiSecret: string,
  date: Date = new Date(),
  salt: string = randomBytes(16).toString("hex"),
): string {
  const iso = date.toISOString();
  const signature = hmacSha256(apiSecret, iso + salt);
  return `HMAC-SHA256 apiKey=${apiKey}, date=${iso}, salt=${salt}, signature=${signature}`;
}

/** 통신사 과금 기준 바이트 수: 영문·숫자·공백·줄바꿈은 1바이트, 한글 등은 2바이트 */
export function smsByteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) bytes += (ch.codePointAt(0) ?? 0) <= 0x7f ? 1 : 2;
  return bytes;
}

function truncateBytes(text: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    bytes += (ch.codePointAt(0) ?? 0) <= 0x7f ? 1 : 2;
    if (bytes > maxBytes) break;
    out += ch;
  }
  return out;
}

export interface SolapiMessage {
  /** 숫자만 있는 수신 번호 */
  to: string;
  text: string;
  /** 장문(LMS) 제목. 없으면 서비스 이름 */
  subject?: string | null;
  channel?: "SMS" | "ALIMTALK";
}

const firstOf = (value: unknown): Record<string, unknown> | null =>
  Array.isArray(value) && typeof value[0] === "object" && value[0] !== null ? (value[0] as Record<string, unknown>) : null;

export async function sendSolapiMessage(message: SolapiMessage): Promise<ProviderResult> {
  const config = solapiConfig();
  if (!config) {
    return {
      ok: false,
      provider: PROVIDER,
      retryable: false,
      error: "문자 발송 연동 정보가 빠졌어요(SOLAPI_API_KEY · SOLAPI_API_SECRET · SOLAPI_SENDER)",
    };
  }

  const bytes = smsByteLength(message.text);
  if (bytes > LMS_MAX_BYTES) {
    return { ok: false, provider: PROVIDER, retryable: false, error: "문자 길이가 장문 한도(2,000바이트)를 넘었어요" };
  }

  // 알림톡(ALIMTALK)은 카카오에 템플릿을 등록하고 심사를 통과해야 보낼 수 있다.
  // 템플릿 심사 전에는 발신 프로필(SOLAPI_KAKAO_PFID)이 설정돼 있어도 같은 내용을 일반 문자로 보낸다.
  // 본문이 90바이트를 넘으면 장문(LMS)으로 보낸다.
  const isLong = bytes > SMS_MAX_BYTES;
  const payload = {
    messages: [
      {
        to: message.to,
        from: config.sender,
        text: message.text,
        type: isLong ? "LMS" : "SMS",
        ...(isLong ? { subject: truncateBytes(message.subject?.trim() || DEFAULT_SUBJECT, SUBJECT_MAX_BYTES) } : {}),
      },
    ],
    showMessageList: true,
  };

  try {
    const res = await postJson(SOLAPI_SEND_URL, { Authorization: buildSolapiAuthHeader(config.apiKey, config.apiSecret) }, payload);
    if (!res.ok) {
      const code = asString(res.json?.errorCode);
      const detail = asString(res.json?.errorMessage);
      return {
        ok: false,
        provider: PROVIDER,
        retryable: isRetryableStatus(res.status),
        error: shortError(`SOLAPI ${res.status}${code ? ` ${code}` : ""}${detail ? `: ${detail}` : ""}`),
      };
    }

    // 요청은 받아들여졌지만 접수 단계에서 걸러진 메시지(미등록 발신번호·잘못된 수신번호 등)는 failedMessageList 로 온다.
    const failed = firstOf(res.json?.failedMessageList);
    if (failed) {
      const code = asString(failed.statusCode);
      const detail = asString(failed.statusMessage);
      return {
        ok: false,
        provider: PROVIDER,
        retryable: false,
        error: shortError(`SOLAPI 접수 실패${code ? ` ${code}` : ""}${detail ? `: ${detail}` : ""}`),
      };
    }

    const groupInfo = res.json?.groupInfo;
    const groupId = typeof groupInfo === "object" && groupInfo !== null ? asString((groupInfo as Record<string, unknown>).groupId) : null;
    return { ok: true, provider: PROVIDER, messageId: asString(firstOf(res.json?.messageList)?.messageId) ?? groupId };
  } catch (e) {
    return { ok: false, provider: PROVIDER, retryable: true, error: shortError(`SOLAPI ${describeNetworkError(e)}`) };
  }
}
