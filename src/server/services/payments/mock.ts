import "server-only";
import { newToken } from "@/lib/ids";
import { prisma } from "@/server/db";
import {
  PaymentProviderError,
  type PaymentProviderAdapter,
  type ProviderPaymentState,
  type ProviderPaymentStatus,
} from "./provider";

/**
 * 개발·시연용 테스트 결제. 실제 청구는 일어나지 않으며 화면에는 "테스트 결제"로 표시된다.
 * 결제 키가 mock_fail_ 로 시작하면 거절 흐름을 재현한다.
 */

const FAIL_PREFIX = "mock_fail_";

/** 테스트 결제창이 PG 대신 발급하는 결제 키 */
export function newMockPaymentKey(): string {
  return `mock_${newToken(18)}`;
}

// 테스트 결제에는 외부 원장이 없으므로 우리 Payment 행이 곧 PG 상태다.
const STATUS_MAP: Record<string, ProviderPaymentStatus> = {
  READY: "WAITING",
  PAID: "DONE",
  PARTIAL_CANCELLED: "PARTIAL_CANCELED",
  CANCELLED: "CANCELED",
  FAILED: "ABORTED",
};

export const mockPaymentProvider: PaymentProviderAdapter = {
  name: "MOCK",

  async confirm({ paymentKey, orderId, amount }) {
    if (paymentKey.startsWith(FAIL_PREFIX)) {
      throw new PaymentProviderError({ code: "MOCK_DECLINED", userMessage: "테스트 결제가 거절됐어요.", retryable: false });
    }
    const approvedAt = new Date();
    return {
      paymentKey,
      orderId,
      amount,
      method: "테스트 결제",
      approvedAt,
      raw: { provider: "mock", paymentKey, orderId, amount, approvedAt: approvedAt.toISOString() },
    };
  },

  async cancel({ paymentKey, amount, reason, idempotencyKey }) {
    return {
      cancelledAmount: amount,
      providerRef: `mock_cancel_${idempotencyKey}`,
      raw: { provider: "mock", paymentKey, cancelAmount: amount, cancelReason: reason },
    };
  },

  async fetchByOrderId(orderId) {
    const payment = await prisma.payment.findUnique({ where: { orderId } });
    if (!payment) return null;
    const state: ProviderPaymentState = {
      status: STATUS_MAP[payment.status] ?? "UNKNOWN",
      orderId: payment.orderId,
      totalAmount: payment.amount,
      balanceAmount: payment.amount - payment.cancelledAmount,
      paymentKey: payment.paymentKey,
      method: payment.method,
      approvedAt: payment.approvedAt,
      receiptUrl: payment.receiptUrl,
      raw: { provider: "mock", orderId: payment.orderId, status: payment.status },
    };
    return state;
  },
};
