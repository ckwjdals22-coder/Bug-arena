import "server-only";
import { env } from "@/lib/env";
import { asString, describeNetworkError, isRetryableStatus, postJson, shortError, type ProviderResult } from "./shared";

/**
 * Resend 이메일 발송 어댑터.
 * 문서: https://resend.com/docs/api-reference/emails/send-email
 *
 * 실제 발송에는 RESEND_API_KEY 와, Resend 에서 도메인 인증을 마친 발신 주소(EMAIL_FROM)가 필요하다.
 */
const RESEND_SEND_URL = "https://api.resend.com/emails";
const PROVIDER = "resend";

export const isResendConfigured = () => Boolean(env().RESEND_API_KEY);

export interface ResendEmail {
  to: string;
  subject: string;
  text: string;
  /** 같은 키로 다시 보내면 Resend 가 중복 발송을 막는다(24시간). 재시도 시 같은 값을 넣는다. */
  idempotencyKey?: string;
}

export async function sendResendEmail(email: ResendEmail): Promise<ProviderResult> {
  const e = env();
  if (!e.RESEND_API_KEY) {
    return { ok: false, provider: PROVIDER, retryable: false, error: "이메일 발송 연동 정보가 빠졌어요(RESEND_API_KEY)" };
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${e.RESEND_API_KEY}` };
  if (email.idempotencyKey) headers["Idempotency-Key"] = email.idempotencyKey;

  try {
    const res = await postJson(RESEND_SEND_URL, headers, {
      from: e.EMAIL_FROM,
      to: [email.to],
      subject: email.subject,
      text: email.text,
    });
    if (res.ok) return { ok: true, provider: PROVIDER, messageId: asString(res.json?.id) };
    const name = asString(res.json?.name);
    const detail = asString(res.json?.message);
    return {
      ok: false,
      provider: PROVIDER,
      retryable: isRetryableStatus(res.status),
      error: shortError(`Resend ${res.status}${name ? ` ${name}` : ""}${detail ? `: ${detail}` : ""}`),
    };
  } catch (err) {
    return { ok: false, provider: PROVIDER, retryable: true, error: shortError(`Resend ${describeNetworkError(err)}`) };
  }
}
