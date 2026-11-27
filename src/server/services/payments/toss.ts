import "server-only";
import { z } from "zod";
import { env } from "@/lib/env";
import { err } from "@/server/errors";
import {
  PaymentProviderError,
  type PaymentProviderAdapter,
  type ProviderPaymentState,
  type ProviderPaymentStatus,
} from "./provider";

/**
 * 토스페이먼츠 코어 API 연동(https://docs.tosspayments.com/reference).
 * - 인증: Basic base64("{시크릿 키}:")
 * - 승인·취소(POST)는 Idempotency-Key 로 멱등하게 보낸다(같은 키로 다시 보내면 첫 응답이 그대로 돌아온다).
 * 시크릿 키와 Authorization 헤더는 어디에도 기록하지 않는다.
 */

const BASE_URL = "https://api.tosspayments.com";
const CONFIRM_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;

// ── 오류 문구 ─────────────────────────────────────────

const MSG = {
  declined: "카드사에서 결제를 승인하지 않았어요. 카드사에 문의하거나 다른 카드로 결제해 주세요.",
  insufficient: "한도가 초과됐거나 잔액이 부족해요. 다른 결제 수단으로 다시 시도해 주세요.",
  cardInfo: "카드 정보를 다시 확인해 주세요.",
  cardBlocked: "사용할 수 없는 카드예요. 다른 카드로 결제해 주세요.",
  installment: "선택한 할부 조건으로는 결제할 수 없어요. 할부 개월을 바꿔 다시 시도해 주세요.",
  limit: "결제 한도를 넘었어요. 다른 결제 수단으로 다시 시도해 주세요.",
  minimum: "결제할 수 있는 최소 금액보다 적어요.",
  point: "포인트를 쓸 수 없는 카드예요. 포인트 사용을 끄고 다시 결제해 주세요.",
  account: "이 계좌로는 지금 결제할 수 없어요. 계좌를 다시 등록하거나 다른 결제 수단을 이용해 주세요.",
  serviceHours: "지금은 은행·카드사 서비스 시간이 아니에요. 잠시 후 다시 시도해 주세요.",
  auth: "결제 인증에 실패했어요. 처음부터 다시 결제해 주세요.",
  fds: "위험 거래로 감지돼 결제가 제한됐어요. 토스페이먼츠에서 보낸 문자의 안내에 따라 본인 확인을 한 뒤 다시 시도해 주세요.",
  expired: "결제 시간이 지났어요. 처음부터 다시 결제해 주세요.",
  processed: "이미 처리된 결제예요.",
  config: "결제 설정에 문제가 있어 지금은 결제할 수 없어요. 고객센터로 문의해 주세요.",
  request: "결제 요청 정보가 올바르지 않아요. 처음부터 다시 결제해 주세요.",
  temporary: "결제사에 일시적인 문제가 생겼어요. 잠시 후 다시 시도해 주세요.",
  unknown: "결제를 처리하지 못했어요. 다른 결제 수단으로 다시 시도해 주세요.",
  unsupported: "지원하지 않는 결제 수단이에요. 카드나 간편결제로 다시 결제해 주세요.",
  cancelled: "이미 취소된 결제예요.",
  cancelAmount: "취소할 수 있는 금액을 넘었어요.",
  notCancelable: "취소할 수 없는 결제예요.",
  partialCancel: "이 결제 수단은 부분 환불이 되지 않아요.",
  refundAccount: "환불받을 계좌에 문제가 있어 환불하지 못했어요.",
} as const;

const USER_MESSAGES: Record<string, string> = {
  // 결제 승인
  ALREADY_PROCESSED_PAYMENT: MSG.processed,
  PROVIDER_ERROR: MSG.temporary,
  EXCEED_MAX_CARD_INSTALLMENT_PLAN: MSG.installment,
  INVALID_REQUEST: MSG.request,
  NOT_ALLOWED_POINT_USE: MSG.point,
  INVALID_API_KEY: MSG.config,
  INVALID_REJECT_CARD: MSG.declined,
  BELOW_MINIMUM_AMOUNT: MSG.minimum,
  INVALID_CARD_EXPIRATION: MSG.cardInfo,
  INVALID_STOPPED_CARD: MSG.cardBlocked,
  EXCEED_MAX_DAILY_PAYMENT_COUNT: MSG.limit,
  NOT_SUPPORTED_INSTALLMENT_PLAN_CARD_OR_MERCHANT: MSG.installment,
  INVALID_CARD_INSTALLMENT_PLAN: MSG.installment,
  NOT_SUPPORTED_MONTHLY_INSTALLMENT_PLAN: MSG.installment,
  NOT_SUPPORTED_MONTHLY_INSTALLMENT_PLAN_BELOW_AMOUNT: MSG.installment,
  EXCEED_MAX_PAYMENT_AMOUNT: MSG.limit,
  EXCEED_MAX_MONTHLY_PAYMENT_AMOUNT: MSG.limit,
  NOT_FOUND_TERMINAL_ID: MSG.config,
  INVALID_AUTHORIZE_AUTH: MSG.auth,
  INVALID_CARD_LOST_OR_STOLEN: MSG.cardBlocked,
  RESTRICTED_TRANSFER_ACCOUNT: MSG.account,
  INVALID_CARD_NUMBER: MSG.cardInfo,
  INVALID_UNREGISTERED_SUBMALL: MSG.config,
  NOT_REGISTERED_BUSINESS: MSG.config,
  EXCEED_MAX_ONE_DAY_WITHDRAW_AMOUNT: MSG.limit,
  EXCEED_MAX_ONE_TIME_WITHDRAW_AMOUNT: MSG.limit,
  CARD_PROCESSING_ERROR: MSG.declined,
  EXCEED_MAX_AMOUNT: MSG.limit,
  INVALID_ACCOUNT_INFO_RE_REGISTER: MSG.account,
  NOT_AVAILABLE_PAYMENT: MSG.serviceHours,
  UNAPPROVED_ORDER_ID: MSG.expired,
  ALREADY_PROCESSING_REQUEST: MSG.temporary,
  UNAUTHORIZED_KEY: MSG.config,
  REJECT_ACCOUNT_PAYMENT: MSG.insufficient,
  REJECT_CARD_PAYMENT: MSG.insufficient,
  REJECT_CARD_COMPANY: MSG.declined,
  FORBIDDEN_REQUEST: MSG.config,
  REJECT_TOSSPAY_INVALID_ACCOUNT: MSG.account,
  EXCEED_MAX_AUTH_COUNT: MSG.auth,
  EXCEED_MAX_ONE_DAY_AMOUNT: MSG.limit,
  NOT_AVAILABLE_BANK: MSG.serviceHours,
  INVALID_PASSWORD: MSG.auth,
  INCORRECT_BASIC_AUTH_FORMAT: MSG.config,
  API_KEY_ACCESS_DENIED: MSG.config,
  FDS_ERROR: MSG.fds,
  NOT_FOUND_PAYMENT: MSG.expired,
  NOT_FOUND_PAYMENT_SESSION: MSG.expired,
  NOT_FOUND: MSG.expired,
  FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING: MSG.temporary,
  FAILED_INTERNAL_SYSTEM_PROCESSING: MSG.temporary,
  FAILED_CARD_COMPANY_RESPONSE: MSG.temporary,
  UNKNOWN_PAYMENT_ERROR: MSG.temporary,
  IDEMPOTENT_REQUEST_PROCESSING: MSG.temporary,
  FORBIDDEN_CONSECUTIVE_REQUEST: MSG.temporary,
  COMMON_ERROR: MSG.temporary,
  // 결제 취소
  ALREADY_CANCELED_PAYMENT: MSG.cancelled,
  ALREADY_REFUND_PAYMENT: MSG.cancelled,
  NOT_CANCELABLE_AMOUNT: MSG.cancelAmount,
  NOT_MATCHES_REFUNDABLE_AMOUNT: MSG.cancelAmount,
  EXCEED_CANCEL_LIMIT: MSG.cancelAmount,
  NOT_CANCELABLE_PAYMENT: MSG.notCancelable,
  NOT_CANCELABLE_PAYMENT_FOR_DORMANT_USER: MSG.notCancelable,
  EXCEED_MAX_REFUND_DUE: MSG.notCancelable,
  NOT_ALLOWED_PARTIAL_REFUND: MSG.partialCancel,
  NOT_ALLOWED_PARTIAL_REFUND_WAITING_DEPOSIT: MSG.partialCancel,
  EXCEED_CANCEL_AMOUNT_DISCOUNT_AMOUNT: MSG.partialCancel,
  INVALID_REFUND_ACCOUNT_INFO: MSG.refundAccount,
  INVALID_REFUND_ACCOUNT_NUMBER: MSG.refundAccount,
  INVALID_BANK: MSG.refundAccount,
  FORBIDDEN_BANK_REFUND_REQUEST: MSG.refundAccount,
  FAILED_CLOSED_ACCOUNT_REFUND: MSG.refundAccount,
  REFUND_REJECTED: MSG.refundAccount,
  FAILED_REFUND_PROCESS: MSG.temporary,
  FAILED_METHOD_HANDLING_CANCEL: MSG.temporary,
  FAILED_PARTIAL_REFUND: MSG.temporary,
};

/**
 * HTTP 4xx 이지만 결과를 단정할 수 없는 코드.
 * ALREADY_PROCESSED_PAYMENT 는 "이전 요청이 이미 승인됐다"는 뜻일 수 있어 조회로 확인해야 한다.
 */
const INDETERMINATE_CODES = new Set([
  "ALREADY_PROCESSED_PAYMENT",
  "ALREADY_PROCESSING_REQUEST",
  "IDEMPOTENT_REQUEST_PROCESSING",
  "PROVIDER_ERROR",
  "FORBIDDEN_CONSECUTIVE_REQUEST",
]);

/** 운영자가 바로 알아야 하는 연동 설정 오류 */
const CONFIG_CODES = new Set(["INVALID_API_KEY", "UNAUTHORIZED_KEY", "INCORRECT_BASIC_AUTH_FORMAT", "API_KEY_ACCESS_DENIED"]);

const errorBodySchema = z.object({ code: z.string().min(1).max(100), message: z.string().max(1000).optional() });

function toProviderError(status: number, body: unknown): PaymentProviderError {
  const parsed = errorBodySchema.safeParse(body);
  const code = parsed.success ? parsed.data.code : `HTTP_${status}`;
  const detail = parsed.success ? parsed.data.message : undefined;
  const retryable = status >= 500 || status === 408 || status === 429 || !parsed.success || INDETERMINATE_CODES.has(code);
  if (CONFIG_CODES.has(code)) console.error("[toss] 연동 키 설정을 확인해 주세요.", code);
  return new PaymentProviderError({
    code,
    userMessage: USER_MESSAGES[code] ?? (retryable ? MSG.temporary : MSG.unknown),
    retryable,
    detail,
  });
}

// ── HTTP ──────────────────────────────────────────────

function secretKey(): string {
  const key = env().TOSS_SECRET_KEY?.trim();
  if (!key) throw err.notConfigured("토스페이먼츠 결제 연동이 아직 설정되지 않았어요.");
  return key;
}

interface RequestOptions {
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  timeoutMs: number;
}

async function request(method: "GET" | "POST", path: string, options: RequestOptions): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${secretKey()}:`).toString("base64")}`,
  };
  if (options.body) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let status: number;
  let text: string;
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    status = res.status;
    text = await res.text();
  } catch {
    // 요청이 PG 에 닿았는지 알 수 없다. 원인 객체는 기록하지 않는다(요청 정보가 섞일 수 있음).
    throw new PaymentProviderError({
      code: controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
      userMessage: MSG.temporary,
      retryable: true,
      detail: controller.signal.aborted ? "토스페이먼츠 응답 시간 초과" : "토스페이먼츠 연결 실패",
    });
  } finally {
    clearTimeout(timer);
  }

  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (status >= 200 && status < 300) {
    if (json === undefined) {
      throw new PaymentProviderError({ code: "INVALID_RESPONSE", userMessage: MSG.temporary, retryable: true, detail: "응답을 해석할 수 없음" });
    }
    return json;
  }
  throw toProviderError(status, json);
}

// ── Payment 객체 ──────────────────────────────────────

const paymentSchema = z.object({
  paymentKey: z.string().min(1).max(200),
  orderId: z.string().min(1).max(64),
  status: z.string().max(50),
  totalAmount: z.number().int().nonnegative(),
  balanceAmount: z.number().int().nonnegative().nullish(),
  method: z.string().max(50).nullish(),
  approvedAt: z.string().max(64).nullish(),
  receipt: z.object({ url: z.string().max(500).nullish() }).nullish(),
  easyPay: z.object({ provider: z.string().max(30).nullish() }).nullish(),
  cancels: z
    .array(
      z.object({
        cancelAmount: z.number().int().nonnegative(),
        transactionKey: z.string().max(64).nullish(),
        cancelStatus: z.string().max(30).nullish(),
      }),
    )
    .nullish(),
});
type TossPayment = z.infer<typeof paymentSchema>;

function parsePayment(raw: unknown): TossPayment {
  const parsed = paymentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PaymentProviderError({ code: "INVALID_RESPONSE", userMessage: MSG.temporary, retryable: true, detail: "결제 응답 형식이 예상과 다름" });
  }
  return parsed.data;
}

/** 응답 원문에서 웹훅 검증용 secret 을 뺀다(DB 에 남기지 않는다). */
function sanitize(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const { secret: _secret, ...rest } = raw as Record<string, unknown>;
  return rest;
}

const KNOWN_STATUS: Record<string, ProviderPaymentStatus> = {
  DONE: "DONE",
  CANCELED: "CANCELED",
  PARTIAL_CANCELED: "PARTIAL_CANCELED",
  ABORTED: "ABORTED",
  EXPIRED: "EXPIRED",
  READY: "WAITING",
  IN_PROGRESS: "WAITING",
  WAITING_FOR_DEPOSIT: "WAITING",
};

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "카드", "간편결제 · 토스페이" */
function methodLabel(payment: TossPayment): string | null {
  const provider = payment.easyPay?.provider;
  if (provider && payment.method) return `${payment.method} · ${provider}`;
  return provider ?? payment.method ?? null;
}

function receiptUrl(payment: TossPayment): string | null {
  const url = payment.receipt?.url;
  return url && url.startsWith("https://") ? url : null;
}

function toState(payment: TossPayment, raw: unknown): ProviderPaymentState {
  const cancelled = (payment.cancels ?? []).reduce((sum, c) => sum + c.cancelAmount, 0);
  return {
    status: KNOWN_STATUS[payment.status] ?? "UNKNOWN",
    orderId: payment.orderId,
    totalAmount: payment.totalAmount,
    balanceAmount: payment.balanceAmount ?? Math.max(0, payment.totalAmount - cancelled),
    paymentKey: payment.paymentKey,
    method: methodLabel(payment),
    approvedAt: parseDate(payment.approvedAt),
    receiptUrl: receiptUrl(payment),
    raw: sanitize(raw),
  };
}

const cancelPath = (paymentKey: string) => `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`;

export const tossPaymentProvider: PaymentProviderAdapter = {
  name: "TOSS",

  async confirm({ paymentKey, orderId, amount }) {
    const raw = await request("POST", "/v1/payments/confirm", {
      body: { paymentKey, orderId, amount },
      idempotencyKey: orderId,
      timeoutMs: CONFIRM_TIMEOUT_MS,
    });
    const payment = parsePayment(raw);
    if (payment.status !== "DONE") {
      // 가상계좌(입금 대기)처럼 바로 승인되지 않는 수단은 좌석 홀드 시간 안에 끝나지 않는다.
      // 나중에 입금돼 주인 없는 결제가 생기지 않도록 발급된 결제를 취소하고 거절한다.
      try {
        await request("POST", cancelPath(payment.paymentKey), {
          body: { cancelReason: "지원하지 않는 결제 수단" },
          idempotencyKey: `void_${orderId}`,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });
      } catch (e) {
        console.error("[toss] 미지원 결제 수단의 결제를 취소하지 못했어요.", orderId, e instanceof PaymentProviderError ? e.code : "UNKNOWN");
      }
      throw new PaymentProviderError({ code: "UNSUPPORTED_PAYMENT_METHOD", userMessage: MSG.unsupported, retryable: false });
    }
    return {
      paymentKey: payment.paymentKey,
      orderId: payment.orderId,
      amount: payment.totalAmount,
      method: methodLabel(payment) ?? undefined,
      approvedAt: parseDate(payment.approvedAt) ?? new Date(),
      receiptUrl: receiptUrl(payment) ?? undefined,
      raw: sanitize(raw),
    };
  },

  async cancel({ paymentKey, amount, reason, idempotencyKey }) {
    const raw = await request("POST", cancelPath(paymentKey), {
      body: { cancelReason: reason.slice(0, 200), cancelAmount: amount },
      idempotencyKey,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    // 취소 내역은 시간순으로 쌓이므로 마지막 항목이 이번 요청의 결과다.
    const last = parsePayment(raw).cancels?.at(-1);
    if (!last || (last.cancelStatus && last.cancelStatus !== "DONE")) {
      throw new PaymentProviderError({ code: "CANCEL_NOT_COMPLETED", userMessage: MSG.temporary, retryable: true, detail: "취소가 완료 상태로 확인되지 않음" });
    }
    return { cancelledAmount: last.cancelAmount, providerRef: last.transactionKey ?? undefined, raw: sanitize(raw) };
  },

  async fetchByOrderId(orderId, paymentKey) {
    // 결제 키 조회는 모든 연동 키에서 되지만 주문번호 조회는 API 개별 연동 키(test_sk·live_sk)만 지원한다.
    const path = paymentKey ? `/v1/payments/${encodeURIComponent(paymentKey)}` : `/v1/payments/orders/${encodeURIComponent(orderId)}`;
    let raw: unknown;
    try {
      raw = await request("GET", path, { timeoutMs: DEFAULT_TIMEOUT_MS });
    } catch (e) {
      if (e instanceof PaymentProviderError && (e.code === "NOT_FOUND_PAYMENT" || e.code === "NOT_FOUND")) return null;
      throw e;
    }
    const payment = parsePayment(raw);
    // 다른 주문의 결제 키로 조회된 결과는 이 주문의 상태가 아니다.
    if (payment.orderId !== orderId) return null;
    return toState(payment, raw);
  },
};
