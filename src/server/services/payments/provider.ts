import "server-only";
import { env } from "@/lib/env";
import { err } from "@/server/errors";
// mock.ts·toss.ts 가 이 파일의 타입과 오류 클래스를 다시 가져오지만(순환), 서로 함수 안에서만 참조하므로 안전하다.
import { mockPaymentProvider } from "./mock";
import { tossPaymentProvider } from "./toss";

/** Payment.provider 열과 같은 값 */
export type PaymentProviderName = "MOCK" | "TOSS";

/** PG 가 승인한 결제 한 건 */
export interface ProviderPaymentResult {
  paymentKey: string;
  orderId: string;
  /** PG 가 실제로 승인한 금액(원) — 우리 주문 금액과 반드시 대조한다. */
  amount: number;
  method?: string;
  approvedAt: Date;
  receiptUrl?: string;
  /** 민감 값을 걸러 낸 PG 응답 원문(Payment.raw 에 저장) */
  raw: unknown;
}

export interface ProviderCancelResult {
  /** 이번 요청으로 취소된 금액(원) */
  cancelledAmount: number;
  /** PG 의 취소 거래 식별자 */
  providerRef?: string;
  raw: unknown;
}

/**
 * PG 쪽 결제 상태.
 * WAITING = 아직 승인 전(결제창 진행 중·인증만 끝남·입금 대기), UNKNOWN = 우리가 모르는 상태값.
 */
export type ProviderPaymentStatus = "DONE" | "CANCELED" | "PARTIAL_CANCELED" | "WAITING" | "ABORTED" | "EXPIRED" | "UNKNOWN";

export interface ProviderPaymentState {
  status: ProviderPaymentStatus;
  orderId: string;
  /** 최초 승인 금액(취소해도 변하지 않는다) */
  totalAmount: number;
  /** 취소하고 남은 금액 */
  balanceAmount: number;
  paymentKey: string | null;
  method: string | null;
  approvedAt: Date | null;
  receiptUrl: string | null;
  raw: unknown;
}

export interface PaymentProviderAdapter {
  readonly name: PaymentProviderName;
  /** 결제 승인. 같은 orderId 로 다시 불러도 한 번만 청구된다. */
  confirm(input: { paymentKey: string; orderId: string; amount: number }): Promise<ProviderPaymentResult>;
  /** 전액·부분 취소. 같은 idempotencyKey 로 다시 부르면 한 번만 취소된다. */
  cancel(input: { paymentKey: string; amount: number; reason: string; idempotencyKey: string }): Promise<ProviderCancelResult>;
  /**
   * PG 에 남아 있는 결제 상태를 조회한다. 결제가 없으면 null.
   * paymentKey 를 알고 있으면 함께 넘긴다 — 토스의 주문서형·결제창형 연동 키는 주문번호 조회를 쓸 수 없어 결제 키로 조회한다.
   */
  fetchByOrderId(orderId: string, paymentKey?: string | null): Promise<ProviderPaymentState | null>;
}

/**
 * PG 가 돌려준 오류.
 * - retryable=false: PG 가 요청을 확정적으로 거절했다(청구·취소되지 않음).
 * - retryable=true : 결과를 단정할 수 없다(네트워크·시간 초과·5xx·처리 중). 조회로 확인하거나 같은 멱등 키로 다시 시도해야 한다.
 */
export class PaymentProviderError extends Error {
  readonly code: string;
  /** 고객에게 그대로 보여 줘도 되는 문구 */
  readonly userMessage: string;
  readonly retryable: boolean;

  constructor(init: { code: string; userMessage: string; retryable: boolean; detail?: string }) {
    super(init.detail ?? init.userMessage);
    this.name = "PaymentProviderError";
    this.code = init.code;
    this.userMessage = init.userMessage;
    this.retryable = init.retryable;
  }
}

/** 환경 변수로 선택된 결제사 이름 — 새 주문(Payment)에 기록한다. */
export function currentProviderName(): PaymentProviderName {
  return env().PAYMENT_PROVIDER === "toss" ? "TOSS" : "MOCK";
}

/** 이미 만들어진 결제는 그 결제를 만든 결제사로 처리해야 하므로 이름으로도 찾을 수 있게 한다. */
export function getPaymentProviderByName(name: PaymentProviderName): PaymentProviderAdapter {
  return name === "TOSS" ? tossPaymentProvider : mockPaymentProvider;
}

export function getPaymentProvider(): PaymentProviderAdapter {
  return getPaymentProviderByName(currentProviderName());
}

export interface PaymentClientConfig {
  provider: "mock" | "toss";
  /** 토스 클라이언트 키(공개 값). 테스트 결제이거나 미설정이면 null */
  clientKey: string | null;
  /** 실제 청구가 일어나지 않는 환경인지(테스트 결제 또는 토스 테스트 키) */
  isTest: boolean;
}

/** 브라우저로 내려보내도 되는 결제 설정. 시크릿 키는 절대 포함하지 않는다. */
export function getPaymentClientConfig(): PaymentClientConfig {
  if (currentProviderName() === "MOCK") return { provider: "mock", clientKey: null, isTest: true };
  const clientKey = env().TOSS_CLIENT_KEY?.trim() || null;
  return { provider: "toss", clientKey, isTest: clientKey?.startsWith("test_") ?? false };
}

/** 토스를 쓰도록 설정했는데 키가 비어 있으면 결제를 시작하기 전에 명시적으로 막는다. */
export function assertPaymentConfigured(): void {
  if (currentProviderName() !== "TOSS") return;
  if (!env().TOSS_CLIENT_KEY?.trim() || !env().TOSS_SECRET_KEY?.trim()) {
    throw err.notConfigured("토스페이먼츠 결제 연동이 아직 설정되지 않았어요.");
  }
}
