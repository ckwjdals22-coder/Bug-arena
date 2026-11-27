import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { newBookingCode, newToken } from "@/lib/ids";
import { prisma } from "@/server/db";
import {
  PaymentProviderError,
  REFUND_REJECTED_TAG,
  confirmPayment,
  createPaymentOrder,
  getPaymentByOrderId,
  getPaymentClientConfig,
  getPaymentForBooking,
  getRefundsForBooking,
  listFailedRefunds,
  listPaymentsNeedingReconcile,
  markPaymentAbandoned,
  newMockPaymentKey,
  reconcilePayment,
  refundIdempotencyKey,
  refundPayment,
  retryRefund,
} from "@/server/services/payments";
import { mockPaymentProvider } from "@/server/services/payments/mock";
import { createListing, createUser, resetDb } from "./helpers";

type PaymentsModule = typeof import("@/server/services/payments");
type ProviderModule = typeof import("@/server/services/payments/provider");
type TossModule = typeof import("@/server/services/payments/toss");

// ── 공통 도우미 ───────────────────────────────────────

/** 결제 대기 중인 예약 한 건(온라인 전액 결제) */
async function createBooking(amount = 30_000) {
  const { business, product, slot, seat } = await createListing();
  const user = await createUser();
  return prisma.booking.create({
    data: {
      code: newBookingCode(),
      userId: user.id,
      businessId: business.id,
      productId: product.id,
      slotId: slot.id,
      slotSeatId: seat.id,
      quantity: 1,
      unitPrice: amount,
      totalAmount: amount,
      payNowAmount: amount,
      payOnsiteAmount: 0,
      status: "PENDING_PAYMENT",
      paymentMethod: "ONLINE",
      guestName: user.name,
      guestPhone: user.phone ?? "01012345678",
      policySnapshot: product.cancellationTiers as Prisma.InputJsonValue,
      checkinToken: newToken(),
    },
  });
}

async function createOrder(amount = 30_000, mod: Pick<PaymentsModule, "createPaymentOrder"> = { createPaymentOrder }) {
  const booking = await createBooking(amount);
  const order = await prisma.$transaction((tx) => mod.createPaymentOrder(tx, { bookingId: booking.id, amount }));
  return { booking, order };
}

/** 테스트 결제로 승인까지 끝낸 예약 */
async function createPaidBooking(amount = 30_000) {
  const { booking, order } = await createOrder(amount);
  const { payment } = await confirmPayment({ orderId: order.orderId, paymentKey: newMockPaymentKey(), amount });
  return { booking, payment };
}

/** 던져진 AppError 의 코드·메시지를 돌려준다(모듈을 다시 불러온 뒤에도 쓸 수 있게 instanceof 대신 이름으로 확인). */
async function appError(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    const error = e as { name?: string; code?: string; message?: string };
    expect(error.name).toBe("AppError");
    return { code: String(error.code), message: String(error.message) };
  }
  throw new Error("오류가 나야 하는데 성공했어요.");
}

const findPayment = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 테스트 결제(mock) ─────────────────────────────────

describe("결제 주문과 승인 — 테스트 결제", () => {
  it("예약 트랜잭션 안에서 READY 주문을 만든다", async () => {
    const { booking, order } = await createOrder(42_000);
    expect(order).toMatchObject({ bookingId: booking.id, provider: "MOCK", amount: 42_000, status: "READY", paymentKey: null, cancelledAmount: 0 });
    expect(order.orderId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
  });

  it("결제 금액이 0원 이하면 주문을 만들지 않는다", async () => {
    const booking = await createBooking();
    await expect(prisma.$transaction((tx) => createPaymentOrder(tx, { bookingId: booking.id, amount: 0 }))).rejects.toThrow();
    await expect(prisma.$transaction((tx) => createPaymentOrder(tx, { bookingId: booking.id, amount: -1000 }))).rejects.toThrow();
    expect(await prisma.payment.count()).toBe(0);
  });

  it("승인되면 PAID 로 바뀌고 결제 정보가 기록된다", async () => {
    const { order } = await createOrder();
    const paymentKey = newMockPaymentKey();
    const result = await confirmPayment({ orderId: order.orderId, paymentKey, amount: 30_000 });

    expect(result.alreadyProcessed).toBe(false);
    expect(result.payment).toMatchObject({ id: order.id, status: "PAID", paymentKey, method: "테스트 결제", failCode: null });
    expect(result.payment.approvedAt).toBeInstanceOf(Date);
    expect((await findPayment(order.id)).status).toBe("PAID");
  });

  it("없는 주문번호는 NOT_FOUND", async () => {
    const error = await appError(confirmPayment({ orderId: "nj_unknown_order", paymentKey: newMockPaymentKey(), amount: 1000 }));
    expect(error.code).toBe("NOT_FOUND");
  });

  it("금액이 주문과 다르면 PG 를 부르지 않고 FAILED 로 남긴다", async () => {
    const confirmSpy = vi.spyOn(mockPaymentProvider, "confirm");
    const { order } = await createOrder(30_000);
    const error = await appError(confirmPayment({ orderId: order.orderId, paymentKey: newMockPaymentKey(), amount: 1_000 }));

    expect(error).toEqual({ code: "VALIDATION", message: "결제 금액이 주문 금액과 달라요." });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await findPayment(order.id)).toMatchObject({ status: "FAILED", failCode: "AMOUNT_MISMATCH", paymentKey: null });

    // 실패한 주문은 올바른 금액으로도 다시 승인할 수 없다.
    const retry = await appError(confirmPayment({ orderId: order.orderId, paymentKey: newMockPaymentKey(), amount: 30_000 }));
    expect(retry.code).toBe("CONFLICT");
  });

  it("같은 결제를 두 번 승인 요청해도 한 번만 처리된다(순차)", async () => {
    const confirmSpy = vi.spyOn(mockPaymentProvider, "confirm");
    const { order } = await createOrder();
    const paymentKey = newMockPaymentKey();

    const first = await confirmPayment({ orderId: order.orderId, paymentKey, amount: 30_000 });
    const second = await confirmPayment({ orderId: order.orderId, paymentKey, amount: 30_000 });

    expect(first.alreadyProcessed).toBe(false);
    expect(second.alreadyProcessed).toBe(true);
    expect(second.payment).toMatchObject({ id: order.id, status: "PAID", paymentKey });
    expect(confirmSpy).toHaveBeenCalledTimes(1);

    // 다른 결제 키로 같은 주문을 다시 승인하려 하면 충돌
    const other = await appError(confirmPayment({ orderId: order.orderId, paymentKey: newMockPaymentKey(), amount: 30_000 }));
    expect(other.code).toBe("CONFLICT");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });

  it("동시에 들어온 두 승인 요청은 PG 를 한 번만 부르고 같은 결과로 끝난다", async () => {
    const confirmSpy = vi.spyOn(mockPaymentProvider, "confirm");
    const { order } = await createOrder();
    const input = { orderId: order.orderId, paymentKey: newMockPaymentKey(), amount: 30_000 };

    const results = await Promise.all([confirmPayment(input), confirmPayment(input), confirmPayment(input)]);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result.payment).toMatchObject({ id: order.id, status: "PAID", paymentKey: input.paymentKey });
    expect(results.filter((r) => !r.alreadyProcessed)).toHaveLength(1);
  });

  it("거절된 결제는 FAILED 로 남기고 PAYMENT_FAILED 를 던진다", async () => {
    const { order } = await createOrder();
    const paymentKey = `mock_fail_${newToken(8)}`;
    const error = await appError(confirmPayment({ orderId: order.orderId, paymentKey, amount: 30_000 }));

    expect(error).toEqual({ code: "PAYMENT_FAILED", message: "테스트 결제가 거절됐어요." });
    expect(await findPayment(order.id)).toMatchObject({ status: "FAILED", failCode: "MOCK_DECLINED", failMessage: "테스트 결제가 거절됐어요.", approvedAt: null });
  });

  it("한 예약에 주문이 둘이어도 결제는 한 번만 승인된다", async () => {
    const confirmSpy = vi.spyOn(mockPaymentProvider, "confirm");
    const { booking, order: first } = await createOrder();
    const second = await prisma.$transaction((tx) => createPaymentOrder(tx, { bookingId: booking.id, amount: 30_000 }));

    await confirmPayment({ orderId: first.orderId, paymentKey: newMockPaymentKey(), amount: 30_000 });
    const error = await appError(confirmPayment({ orderId: second.orderId, paymentKey: newMockPaymentKey(), amount: 30_000 }));

    expect(error.code).toBe("CONFLICT");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect((await findPayment(second.id)).status).toBe("READY");
  });

  it("한 예약의 두 주문을 동시에 승인해도 하나만 결제된다", async () => {
    const confirmSpy = vi.spyOn(mockPaymentProvider, "confirm");
    const { booking, order: first } = await createOrder();
    const second = await prisma.$transaction((tx) => createPaymentOrder(tx, { bookingId: booking.id, amount: 30_000 }));

    const settled = await Promise.allSettled([
      confirmPayment({ orderId: first.orderId, paymentKey: newMockPaymentKey(), amount: 30_000 }),
      confirmPayment({ orderId: second.orderId, paymentKey: newMockPaymentKey(), amount: 30_000 }),
    ]);

    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(await prisma.payment.count({ where: { bookingId: booking.id, status: "PAID" } })).toBe(1);
  });

  it("다른 주문에서 이미 쓴 결제 키로는 승인할 수 없다", async () => {
    const { payment } = await createPaidBooking();
    const { order } = await createOrder();
    const error = await appError(confirmPayment({ orderId: order.orderId, paymentKey: payment.paymentKey!, amount: 30_000 }));

    expect(error.code).toBe("CONFLICT");
    expect(await findPayment(order.id)).toMatchObject({ status: "READY", paymentKey: null });
  });

  it("결제 없이 홀드가 끝난 주문은 CANCELLED 로 닫히고 다시 승인되지 않는다", async () => {
    const { order } = await createOrder();
    expect(await markPaymentAbandoned(order.orderId)).toBe(true);
    expect((await findPayment(order.id)).status).toBe("CANCELLED");
    expect(await markPaymentAbandoned(order.orderId)).toBe(false);

    const error = await appError(confirmPayment({ orderId: order.orderId, paymentKey: newMockPaymentKey(), amount: 30_000 }));
    expect(error.code).toBe("CONFLICT");
  });

  it("승인된 결제와 승인 진행 중인 주문은 닫지 않는다", async () => {
    const { payment } = await createPaidBooking();
    expect(await markPaymentAbandoned(payment.orderId)).toBe(false);
    expect((await findPayment(payment.id)).status).toBe("PAID");

    // 다른 요청이 점유하고 PG 승인을 진행 중인 주문(호출자의 트랜잭션 안에서 불러도 같다)
    const { order } = await createOrder();
    await prisma.payment.update({ where: { id: order.id }, data: { paymentKey: newMockPaymentKey() } });
    expect(await prisma.$transaction((tx) => markPaymentAbandoned(order.orderId, tx))).toBe(false);
    expect((await findPayment(order.id)).status).toBe("READY");
  });
});

describe("환불 — 테스트 결제", () => {
  it("전액 환불하면 Refund DONE · Payment CANCELLED", async () => {
    const { booking, payment } = await createPaidBooking(30_000);
    const refund = await refundPayment({ bookingId: booking.id, amount: 30_000, reason: "고객 요청", requestedBy: "CUSTOMER", requestedById: booking.userId });

    expect(refund).toMatchObject({ paymentId: payment.id, bookingId: booking.id, amount: 30_000, status: "DONE", requestedBy: "CUSTOMER", error: null });
    expect(refund?.processedAt).toBeInstanceOf(Date);
    expect(refund?.providerRef).toBe(`mock_cancel_${refund?.id}`);
    expect(await findPayment(payment.id)).toMatchObject({ status: "CANCELLED", cancelledAmount: 30_000 });

    const log = await prisma.auditLog.findFirst({ where: { action: "payment.refund", targetId: refund!.id } });
    expect(log).toMatchObject({ actorType: "CUSTOMER", actorId: booking.userId });
  });

  it("부분 환불은 PARTIAL_CANCELLED, 나머지까지 환불하면 CANCELLED", async () => {
    const { booking, payment } = await createPaidBooking(30_000);

    const first = await refundPayment({ bookingId: booking.id, amount: 12_000, reason: "부분 환불", requestedBy: "SELLER" });
    expect(first?.status).toBe("DONE");
    expect(await findPayment(payment.id)).toMatchObject({ status: "PARTIAL_CANCELLED", cancelledAmount: 12_000 });

    const second = await refundPayment({ bookingId: booking.id, amount: 18_000, reason: "잔액 환불", requestedBy: "ADMIN" });
    expect(second?.status).toBe("DONE");
    expect(await findPayment(payment.id)).toMatchObject({ status: "CANCELLED", cancelledAmount: 30_000 });
    expect(await prisma.refund.count({ where: { paymentId: payment.id, status: "DONE" } })).toBe(2);
  });

  it("남은 금액보다 많이 환불하려 하면 거부한다", async () => {
    const { booking, payment } = await createPaidBooking(30_000);
    const tooMuch = await appError(refundPayment({ bookingId: booking.id, amount: 30_001, reason: "초과", requestedBy: "ADMIN" }));
    expect(tooMuch.code).toBe("CONFLICT");

    await refundPayment({ bookingId: booking.id, amount: 20_000, reason: "부분", requestedBy: "ADMIN" });
    const overRemaining = await appError(refundPayment({ bookingId: booking.id, amount: 10_001, reason: "초과", requestedBy: "ADMIN" }));
    expect(overRemaining.code).toBe("CONFLICT");

    expect(await findPayment(payment.id)).toMatchObject({ status: "PARTIAL_CANCELLED", cancelledAmount: 20_000 });
    expect(await prisma.refund.count({ where: { paymentId: payment.id } })).toBe(1);
  });

  it("환불할 금액이 없거나 승인된 결제가 없으면 null", async () => {
    const { booking } = await createPaidBooking();
    expect(await refundPayment({ bookingId: booking.id, amount: 0, reason: "0원", requestedBy: "SYSTEM" })).toBeNull();
    expect(await refundPayment({ bookingId: booking.id, amount: -500, reason: "음수", requestedBy: "SYSTEM" })).toBeNull();

    const { booking: unpaid } = await createOrder();
    expect(await refundPayment({ bookingId: unpaid.id, amount: 10_000, reason: "미결제", requestedBy: "SYSTEM" })).toBeNull();
    expect(await prisma.refund.count()).toBe(0);
  });

  it("동시에 들어온 환불은 결제 금액을 넘지 못한다", async () => {
    const { booking, payment } = await createPaidBooking(30_000);
    const request = () => refundPayment({ bookingId: booking.id, amount: 20_000, reason: "동시 환불", requestedBy: "ADMIN" });

    const settled = await Promise.allSettled([request(), request(), request()]);
    const done = settled.filter((s) => s.status === "fulfilled" && s.value?.status === "DONE");
    const rejected = settled.filter((s) => s.status === "rejected");

    expect(done).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect((r as PromiseRejectedResult).reason).toMatchObject({ name: "AppError", code: "CONFLICT" });
    expect(await findPayment(payment.id)).toMatchObject({ status: "PARTIAL_CANCELLED", cancelledAmount: 20_000 });
  });

  it("동시에 들어온 부분 환불 여러 건도 합계가 결제 금액에서 멈춘다", async () => {
    const { booking, payment } = await createPaidBooking(30_000);
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => refundPayment({ bookingId: booking.id, amount: 10_000, reason: "동시 부분 환불", requestedBy: "ADMIN" })),
    );

    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(3);
    expect(await findPayment(payment.id)).toMatchObject({ status: "CANCELLED", cancelledAmount: 30_000 });
    const sum = await prisma.refund.aggregate({ where: { paymentId: payment.id, status: "DONE" }, _sum: { amount: true } });
    expect(sum._sum.amount).toBe(30_000);
  });

  it("실패한 환불 금액은 재시도될 때까지 잡아 두고, 권한 있는 운영자만 재시도할 수 있다", async () => {
    const { booking, payment } = await createPaidBooking(30_000);
    const failed = await prisma.refund.create({
      data: { paymentId: payment.id, bookingId: booking.id, amount: 20_000, reason: "고객 취소", status: "FAILED", error: "[TIMEOUT] 응답 없음", requestedBy: "CUSTOMER" },
    });

    // 실패 건 20,000원이 잡혀 있으므로 새 환불은 10,000원까지만 가능
    const error = await appError(refundPayment({ bookingId: booking.id, amount: 10_001, reason: "추가 환불", requestedBy: "ADMIN" }));
    expect(error.code).toBe("CONFLICT");

    const listed = await listFailedRefunds();
    expect(listed.map((r) => r.id)).toEqual([failed.id]);
    expect(listed[0]).toMatchObject({ payment: { orderId: payment.orderId, amount: 30_000 }, booking: { code: booking.code } });

    const customer = await createUser();
    const opsAdmin = await createUser({ adminRole: "OPS" });
    const csAdmin = await createUser({ adminRole: "CS" });
    expect((await appError(retryRefund(failed.id, { type: "ADMIN", adminId: customer.id }))).code).toBe("FORBIDDEN");
    expect((await appError(retryRefund(failed.id, { type: "ADMIN", adminId: opsAdmin.id }))).code).toBe("FORBIDDEN");
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("FAILED");

    const retried = await retryRefund(failed.id, { type: "ADMIN", adminId: csAdmin.id });
    expect(retried).toMatchObject({ id: failed.id, status: "DONE", error: null });
    expect(await findPayment(payment.id)).toMatchObject({ status: "PARTIAL_CANCELLED", cancelledAmount: 20_000 });
    expect(await listFailedRefunds()).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { action: "payment.refund_retry", actorId: csAdmin.id, targetId: failed.id } })).toBe(1);

    // 끝난 환불을 다시 재시도해도 금액이 두 번 빠지지 않는다.
    expect((await retryRefund(failed.id)).status).toBe("DONE");
    expect((await findPayment(payment.id)).cancelledAmount).toBe(20_000);
    expect((await appError(retryRefund("no-such-refund"))).code).toBe("NOT_FOUND");
  });

  it("처리 도중 끊겨 REQUESTED 로 남은 환불은 시간이 지나면 재시도 대상이 된다", async () => {
    const { booking, payment } = await createPaidBooking(30_000);
    const stuck = await prisma.refund.create({
      data: { paymentId: payment.id, bookingId: booking.id, amount: 30_000, reason: "회차 취소", status: "REQUESTED", requestedBy: "SELLER" },
    });

    // 방금 요청된 환불은 아직 처리 중일 수 있으므로 건드리지 않는다.
    expect(await listFailedRefunds()).toHaveLength(0);
    expect((await appError(retryRefund(stuck.id))).code).toBe("CONFLICT");

    await prisma.refund.update({ where: { id: stuck.id }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    expect((await listFailedRefunds()).map((r) => r.id)).toEqual([stuck.id]);
    // 결과를 모르는 요청이었으므로 같은 멱등 키(환불 ID)로 다시 보내고, 시도 횟수는 올리지 않는다.
    expect(await retryRefund(stuck.id)).toMatchObject({ status: "DONE", providerRef: `mock_cancel_${stuck.id}`, attempts: 0 });
    expect(await findPayment(payment.id)).toMatchObject({ status: "CANCELLED", cancelledAmount: 30_000 });
  });

  it("PG 가 확정적으로 거절한 환불은 재시도할 때 시도 횟수를 올리고 새 멱등 키로 요청한다", async () => {
    const { booking, payment } = await createPaidBooking(30_000);
    const keys: string[] = [];
    const reject = () => new PaymentProviderError({ code: "INVALID_REFUND_ACCOUNT_INFO", userMessage: "환불 계좌를 확인해 주세요.", retryable: false });
    const cancelSpy = vi.spyOn(mockPaymentProvider, "cancel");
    cancelSpy.mockImplementation(async ({ idempotencyKey }) => {
      keys.push(idempotencyKey);
      throw reject();
    });

    const failed = await refundPayment({ bookingId: booking.id, amount: 30_000, reason: "고객 취소", requestedBy: "CUSTOMER" });
    expect(failed).toMatchObject({ status: "FAILED", attempts: 0, providerRef: null, processedAt: null });
    // 확정 거절은 오류 문구 앞에 표시가 붙는다(다음 재시도에 새 키가 필요하다는 뜻).
    expect(failed?.error).toBe(`${REFUND_REJECTED_TAG} [INVALID_REFUND_ACCOUNT_INFO] 환불 계좌를 확인해 주세요.`);
    expect(keys).toEqual([failed!.id]);
    expect(refundIdempotencyKey(failed!)).toBe(failed!.id);

    // 다시 거절돼도 시도마다 키가 달라진다.
    const again = await retryRefund(failed!.id);
    expect(again).toMatchObject({ status: "FAILED", attempts: 1, processedAt: null });
    expect(again.error?.startsWith(REFUND_REJECTED_TAG)).toBe(true);
    expect(refundIdempotencyKey(again)).toBe(`${failed!.id}-r1`);
    expect(keys).toEqual([failed!.id, `${failed!.id}-r1`]);

    // 원인이 풀린 뒤의 재시도: 세 번째 키로 성공한다.
    cancelSpy.mockRestore();
    const realCancel = vi.spyOn(mockPaymentProvider, "cancel");
    const done = await retryRefund(failed!.id);
    expect(done).toMatchObject({ status: "DONE", attempts: 2, error: null, providerRef: `mock_cancel_${failed!.id}-r2` });
    expect(realCancel).toHaveBeenCalledTimes(1);
    expect(realCancel.mock.calls[0]![0]).toMatchObject({ idempotencyKey: `${failed!.id}-r2`, amount: 30_000 });
    expect(await findPayment(payment.id)).toMatchObject({ status: "CANCELLED", cancelledAmount: 30_000 });

    const log = await prisma.auditLog.findFirst({ where: { action: "payment.refund_retry", targetId: failed!.id }, orderBy: { createdAt: "desc" } });
    expect(log?.meta).toMatchObject({ status: "DONE", attempts: 2, newKey: true });
  });

  it("결과를 모르는 실패와 우리 쪽 확인에서 걸린 실패는 재시도해도 같은 멱등 키를 쓴다(이중 환불 방지)", async () => {
    const { booking, payment } = await createPaidBooking(30_000);
    const keys: string[] = [];
    const cancelSpy = vi.spyOn(mockPaymentProvider, "cancel");

    // 1) 시간 초과: PG 에서는 처리됐을 수도 있다.
    cancelSpy.mockImplementationOnce(async ({ idempotencyKey }) => {
      keys.push(idempotencyKey);
      throw new PaymentProviderError({ code: "TIMEOUT", userMessage: "잠시 후 다시 시도해 주세요.", retryable: true });
    });
    const unknown = await refundPayment({ bookingId: booking.id, amount: 10_000, reason: "부분 환불", requestedBy: "ADMIN" });
    expect(unknown).toMatchObject({ status: "FAILED", attempts: 0, processedAt: null });
    expect(unknown?.error).not.toContain(REFUND_REJECTED_TAG);

    // 2) 요청과 다른 금액이 취소됐다는 응답: PG 에서는 무언가 취소됐으므로 새 키로 다시 보내면 안 된다.
    cancelSpy.mockImplementationOnce(async ({ idempotencyKey }) => {
      keys.push(idempotencyKey);
      return { cancelledAmount: 4_000, providerRef: "odd", raw: {} };
    });
    const mismatch = await retryRefund(unknown!.id);
    expect(mismatch).toMatchObject({ status: "FAILED", attempts: 0, processedAt: null });
    expect(mismatch.error).toContain("CANCEL_AMOUNT_MISMATCH");
    expect(mismatch.error).not.toContain(REFUND_REJECTED_TAG);

    cancelSpy.mockImplementation(async ({ idempotencyKey, amount }) => {
      keys.push(idempotencyKey);
      return { cancelledAmount: amount, providerRef: `mock_cancel_${idempotencyKey}`, raw: {} };
    });
    const done = await retryRefund(unknown!.id);
    expect(done).toMatchObject({ status: "DONE", attempts: 0, providerRef: `mock_cancel_${unknown!.id}` });
    expect(keys).toEqual([unknown!.id, unknown!.id, unknown!.id]);
    expect(await findPayment(payment.id)).toMatchObject({ status: "PARTIAL_CANCELLED", cancelledAmount: 10_000 });
  });

  it("확정 거절된 환불을 동시에 재시도해도 키는 한 번만 바뀌고 금액은 한 번만 빠진다", async () => {
    const { booking, payment } = await createPaidBooking(30_000);
    const failed = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        bookingId: booking.id,
        amount: 12_000,
        reason: "고객 취소",
        status: "FAILED",
        error: `${REFUND_REJECTED_TAG} [REFUND_REJECTED] 환불 거절`,
        requestedBy: "CUSTOMER",
        // 오래된 요청이라, 새 키를 차지하지 못한 재시도도 "끊긴 요청 이어받기"로 같은 키를 쓴다.
        createdAt: new Date(Date.now() - 30 * 60_000),
      },
    });
    const cancelSpy = vi.spyOn(mockPaymentProvider, "cancel");

    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => retryRefund(failed.id)));
    for (const s of settled) {
      if (s.status === "rejected") expect(s.reason).toMatchObject({ name: "AppError", code: "CONFLICT" });
      else expect(s.value).toMatchObject({ id: failed.id, status: "DONE" });
    }
    expect(settled.some((s) => s.status === "fulfilled")).toBe(true);

    const row = await prisma.refund.findUniqueOrThrow({ where: { id: failed.id } });
    expect(row).toMatchObject({ status: "DONE", attempts: 1, error: null });
    // PG 로 나간 요청은 모두 같은 새 키였다.
    expect(new Set(cancelSpy.mock.calls.map((c) => c[0].idempotencyKey))).toEqual(new Set([`${failed.id}-r1`]));
    expect(await findPayment(payment.id)).toMatchObject({ status: "PARTIAL_CANCELLED", cancelledAmount: 12_000 });
  });

  it("getRefundsForBooking 은 그 예약의 환불만 요청한 순서로 돌려준다", async () => {
    const { booking } = await createPaidBooking(30_000);
    const { booking: other } = await createPaidBooking(20_000);
    const first = await refundPayment({ bookingId: booking.id, amount: 5_000, reason: "부분 환불", requestedBy: "SELLER" });
    const second = await refundPayment({ bookingId: booking.id, amount: 7_000, reason: "재판매 연동 환불", requestedBy: "SYSTEM" });
    await refundPayment({ bookingId: other.id, amount: 20_000, reason: "회차 취소", requestedBy: "SELLER" });

    const refunds = await getRefundsForBooking(booking.id);
    expect(refunds.map((r) => r.id)).toEqual([first!.id, second!.id]);
    expect(refunds.map((r) => [r.amount, r.status, r.attempts])).toEqual([
      [5_000, "DONE", 0],
      [7_000, "DONE", 0],
    ]);
    expect(await getRefundsForBooking("no-such-booking")).toEqual([]);
  });
});

describe("조회와 대사 — 테스트 결제", () => {
  it("getPaymentForBooking 은 예약의 대표 결제와 환불 내역을 돌려준다", async () => {
    const { booking, order } = await createOrder();
    expect(await getPaymentForBooking(booking.id)).toMatchObject({ id: order.id, status: "READY", refunds: [] });
    expect(await getPaymentByOrderId(order.orderId)).toMatchObject({ id: order.id, bookingId: booking.id });
    expect(await getPaymentByOrderId("nj_unknown_order")).toBeNull();
    expect(await getPaymentByOrderId("잘못된 주문번호")).toBeNull();

    // 거절된 주문 뒤에 새 주문으로 결제한 경우 승인된 결제가 대표다.
    await appError(confirmPayment({ orderId: order.orderId, paymentKey: "mock_fail_1", amount: 30_000 }));
    const retry = await prisma.$transaction((tx) => createPaymentOrder(tx, { bookingId: booking.id, amount: 30_000 }));
    await confirmPayment({ orderId: retry.orderId, paymentKey: newMockPaymentKey(), amount: 30_000 });
    await refundPayment({ bookingId: booking.id, amount: 5_000, reason: "부분 환불", requestedBy: "SELLER" });

    const found = await getPaymentForBooking(booking.id);
    expect(found).toMatchObject({ id: retry.id, status: "PARTIAL_CANCELLED", cancelledAmount: 5_000 });
    expect(found?.refunds).toHaveLength(1);
    expect(await getPaymentForBooking("no-such-booking")).toBeNull();
  });

  it("reconcilePayment 는 결제 상태를 구분해 돌려준다", async () => {
    const { order } = await createOrder();
    expect(await reconcilePayment(order.orderId)).toMatchObject({ state: "PENDING", payment: { id: order.id, status: "READY" } });

    const { booking, payment } = await createPaidBooking();
    expect(await reconcilePayment(payment.orderId)).toMatchObject({ state: "PAID", payment: { id: payment.id } });

    await refundPayment({ bookingId: booking.id, amount: 30_000, reason: "전액 환불", requestedBy: "ADMIN" });
    expect(await reconcilePayment(payment.orderId)).toMatchObject({ state: "CANCELLED" });

    expect((await appError(reconcilePayment("nj_unknown_order"))).code).toBe("NOT_FOUND");
  });

  it("승인 도중 끊겨 점유만 남은 주문은 대사에서 풀려 다시 결제할 수 있다", async () => {
    const { order } = await createOrder();
    const paymentKey = newMockPaymentKey();
    // 점유 직후 프로세스가 죽은 상황: 방금 점유한 것은 진행 중으로 본다.
    await prisma.payment.update({ where: { id: order.id }, data: { paymentKey } });
    expect(await listPaymentsNeedingReconcile()).toEqual([]);
    expect((await appError(confirmPayment({ orderId: order.orderId, paymentKey: newMockPaymentKey(), amount: 30_000 }))).code).toBe("CONFLICT");

    // 오래된 점유는 대사 대상이 되고, PG 가 승인 전이라고 하면 점유를 푼다.
    await prisma.payment.update({ where: { id: order.id }, data: { updatedAt: new Date(Date.now() - 5 * 60_000) } });
    expect(await listPaymentsNeedingReconcile()).toEqual([order.orderId]);
    expect(await reconcilePayment(order.orderId)).toMatchObject({ state: "PENDING", payment: { status: "READY", paymentKey: null } });
    expect(await listPaymentsNeedingReconcile()).toEqual([]);

    const result = await confirmPayment({ orderId: order.orderId, paymentKey: newMockPaymentKey(), amount: 30_000 });
    expect(result.payment.status).toBe("PAID");
  });

  it("같은 결제 키의 오래된 점유는 재요청이 이어받아 승인한다", async () => {
    const { order } = await createOrder();
    const paymentKey = newMockPaymentKey();
    await prisma.payment.update({ where: { id: order.id }, data: { paymentKey, updatedAt: new Date(Date.now() - 5 * 60_000) } });

    const result = await confirmPayment({ orderId: order.orderId, paymentKey, amount: 30_000 });
    expect(result).toMatchObject({ alreadyProcessed: false, payment: { status: "PAID", paymentKey } });
  });

  it("테스트 결제 설정은 클라이언트 키 없이 테스트 환경으로 표시된다", () => {
    expect(getPaymentClientConfig()).toEqual({ provider: "mock", clientKey: null, isTest: true });
  });
});

// ── 토스페이먼츠 ──────────────────────────────────────

const SECRET_KEY = "test_sk_SECRET0000000000000000";
const CLIENT_KEY = "test_ck_CLIENT0000000000000000";
const TOSS = "https://api.tosspayments.com";
const ENV_KEYS = ["PAYMENT_PROVIDER", "TOSS_SECRET_KEY", "TOSS_CLIENT_KEY"] as const;

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };
type FetchHandler = (call: FetchCall, init: RequestInit) => Response | Promise<Response>;

/** 전역 fetch 를 가로채 토스 API 응답을 흉내 낸다. 호출 내역은 calls 로 확인한다. */
function stubFetch(handler: FetchHandler) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const call: FetchCall = {
        url: String(input),
        method: init.method ?? "GET",
        headers: { ...(init.headers as Record<string, string>) },
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return handler(call, init);
    }),
  );
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function tossPayment(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    version: "2022-11-16",
    paymentKey: "tpk_default",
    orderId,
    status: "DONE",
    totalAmount: 30_000,
    balanceAmount: 30_000,
    method: "카드",
    approvedAt: "2026-11-27T19:30:00+09:00",
    receipt: { url: "https://dashboard.tosspayments.com/receipt/redirection?transactionId=t1" },
    secret: "ps_webhook_secret_value",
    cancels: null,
    ...overrides,
  };
}

const isConfirm = (call: FetchCall) => call.method === "POST" && call.url === `${TOSS}/v1/payments/confirm`;
const isCancel = (call: FetchCall, paymentKey: string) => call.method === "POST" && call.url === `${TOSS}/v1/payments/${paymentKey}/cancel`;
const isLookup = (call: FetchCall, paymentKey: string) => call.method === "GET" && call.url === `${TOSS}/v1/payments/${paymentKey}`;

describe("토스페이먼츠", () => {
  const savedEnv = new Map<string, string | undefined>();
  let payments: PaymentsModule;
  let provider: ProviderModule;
  let toss: TossModule;

  /** 환경 변수를 바꾼 뒤 모듈을 새로 불러온다(env() 가 값을 캐시하기 때문). */
  async function loadModules(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}) {
    const values = { PAYMENT_PROVIDER: "toss", TOSS_SECRET_KEY: SECRET_KEY, TOSS_CLIENT_KEY: CLIENT_KEY, ...overrides };
    for (const key of ENV_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    payments = await import("@/server/services/payments");
    provider = await import("@/server/services/payments/provider");
    toss = await import("@/server/services/payments/toss");
  }

  beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  });

  beforeEach(async () => {
    await loadModules();
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  });

  /** 토스 주문을 만들고 승인까지 끝낸다. */
  async function createTossPaid(paymentKey: string, amount = 30_000) {
    const { booking, order } = await createOrder(amount, payments);
    stubFetch((call) => (isConfirm(call) ? json(200, tossPayment(order.orderId, { paymentKey, totalAmount: amount, balanceAmount: amount })) : json(500, {})));
    const { payment } = await payments.confirmPayment({ orderId: order.orderId, paymentKey, amount });
    vi.unstubAllGlobals();
    return { booking, payment };
  }

  describe("어댑터 — 요청 형식", () => {
    it("승인: POST /v1/payments/confirm, Basic 인증, 주문번호를 멱등 키로 보낸다", async () => {
      const calls = stubFetch(() => json(200, tossPayment("nj_order_0001", { paymentKey: "tpk_1", easyPay: { provider: "토스페이" }, method: "간편결제" })));
      const result = await toss.tossPaymentProvider.confirm({ paymentKey: "tpk_1", orderId: "nj_order_0001", amount: 30_000 });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: `${TOSS}/v1/payments/confirm`, method: "POST", body: { paymentKey: "tpk_1", orderId: "nj_order_0001", amount: 30_000 } });
      expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from(`${SECRET_KEY}:`).toString("base64")}`);
      expect(calls[0]!.headers["Idempotency-Key"]).toBe("nj_order_0001");
      expect(calls[0]!.headers["Content-Type"]).toBe("application/json");

      expect(result).toMatchObject({
        paymentKey: "tpk_1",
        orderId: "nj_order_0001",
        amount: 30_000,
        method: "간편결제 · 토스페이",
        receiptUrl: "https://dashboard.tosspayments.com/receipt/redirection?transactionId=t1",
      });
      expect(result.approvedAt.toISOString()).toBe("2026-11-27T10:30:00.000Z");
      // 웹훅 검증용 secret 은 저장용 원문에서 뺀다.
      expect(JSON.stringify(result.raw)).not.toContain("ps_webhook_secret_value");
    });

    it("취소: POST /v1/payments/{paymentKey}/cancel, 금액·사유와 멱등 키를 보낸다", async () => {
      const calls = stubFetch(() =>
        json(200, tossPayment("nj_order_0002", { status: "PARTIAL_CANCELED", balanceAmount: 18_000, cancels: [{ cancelAmount: 12_000, transactionKey: "txn_cancel_1", cancelStatus: "DONE" }] })),
      );
      const result = await toss.tossPaymentProvider.cancel({ paymentKey: "tpk/2", amount: 12_000, reason: "고객 요청", idempotencyKey: "refund_abc" });

      expect(calls[0]).toMatchObject({ url: `${TOSS}/v1/payments/tpk%2F2/cancel`, method: "POST", body: { cancelReason: "고객 요청", cancelAmount: 12_000 } });
      expect(calls[0]!.headers["Idempotency-Key"]).toBe("refund_abc");
      expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from(`${SECRET_KEY}:`).toString("base64")}`);
      expect(result).toMatchObject({ cancelledAmount: 12_000, providerRef: "txn_cancel_1" });
    });

    it("조회: 주문번호 또는 결제 키로 GET 하고 상태를 우리 형식으로 바꾼다", async () => {
      const calls = stubFetch((call) => {
        if (call.url === `${TOSS}/v1/payments/orders/nj_order_0003`) return json(200, tossPayment("nj_order_0003", { paymentKey: "tpk_3", status: "IN_PROGRESS", approvedAt: null }));
        if (call.url === `${TOSS}/v1/payments/tpk_3`) return json(200, tossPayment("nj_order_0003", { paymentKey: "tpk_3", status: "CANCELED", balanceAmount: 0 }));
        return json(404, { code: "NOT_FOUND_PAYMENT", message: "존재하지 않는 결제 정보 입니다." });
      });

      expect(await toss.tossPaymentProvider.fetchByOrderId("nj_order_0003")).toMatchObject({ status: "WAITING", orderId: "nj_order_0003", totalAmount: 30_000, approvedAt: null });
      expect(await toss.tossPaymentProvider.fetchByOrderId("nj_order_0003", "tpk_3")).toMatchObject({ status: "CANCELED", balanceAmount: 0, paymentKey: "tpk_3" });
      expect(await toss.tossPaymentProvider.fetchByOrderId("nj_order_none")).toBeNull();
      // 다른 주문의 결제 키로 조회된 결과는 이 주문의 상태로 쓰지 않는다.
      expect(await toss.tossPaymentProvider.fetchByOrderId("nj_order_other", "tpk_3")).toBeNull();

      expect(calls.every((c) => c.method === "GET" && c.headers.Authorization?.startsWith("Basic "))).toBe(true);
      expect(calls.every((c) => c.headers["Idempotency-Key"] === undefined)).toBe(true);
    });
  });

  describe("어댑터 — 오류 변환", () => {
    const confirm = () => toss.tossPaymentProvider.confirm({ paymentKey: "tpk_err", orderId: "nj_order_err1", amount: 30_000 });

    it("토스 오류 코드를 한국어 안내와 재시도 가능 여부로 바꾼다", async () => {
      stubFetch(() => json(403, { code: "REJECT_CARD_PAYMENT", message: "한도초과 혹은 잔액부족으로 결제에 실패했습니다." }));
      await expect(confirm()).rejects.toMatchObject({
        name: "PaymentProviderError",
        code: "REJECT_CARD_PAYMENT",
        retryable: false,
        userMessage: "한도가 초과됐거나 잔액이 부족해요. 다른 결제 수단으로 다시 시도해 주세요.",
      });

      stubFetch(() => json(404, { code: "NOT_FOUND_PAYMENT_SESSION", message: "결제 시간이 만료되어 결제 진행 데이터가 존재하지 않습니다." }));
      await expect(confirm()).rejects.toMatchObject({ code: "NOT_FOUND_PAYMENT_SESSION", retryable: false, userMessage: "결제 시간이 지났어요. 처음부터 다시 결제해 주세요." });

      stubFetch(() => json(401, { code: "UNAUTHORIZED_KEY", message: "인증되지 않은 시크릿 키 혹은 클라이언트 키 입니다." }));
      vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(confirm()).rejects.toMatchObject({ code: "UNAUTHORIZED_KEY", retryable: false });

      stubFetch(() => json(400, { code: "SOME_NEW_CODE", message: "새로 생긴 오류" }));
      await expect(confirm()).rejects.toMatchObject({ code: "SOME_NEW_CODE", retryable: false, userMessage: "결제를 처리하지 못했어요. 다른 결제 수단으로 다시 시도해 주세요." });
    });

    it("5xx · 처리 중 · 네트워크 오류 · 해석할 수 없는 응답은 결과를 알 수 없는(retryable) 오류다", async () => {
      stubFetch(() => json(500, { code: "FAILED_INTERNAL_SYSTEM_PROCESSING", message: "내부 시스템 처리 작업이 실패했습니다." }));
      await expect(confirm()).rejects.toMatchObject({ code: "FAILED_INTERNAL_SYSTEM_PROCESSING", retryable: true });

      stubFetch(() => json(409, { code: "IDEMPOTENT_REQUEST_PROCESSING", message: "이전 멱등 요청이 처리중입니다." }));
      await expect(confirm()).rejects.toMatchObject({ code: "IDEMPOTENT_REQUEST_PROCESSING", retryable: true });

      stubFetch(() => json(400, { code: "ALREADY_PROCESSED_PAYMENT", message: "이미 처리된 결제 입니다." }));
      await expect(confirm()).rejects.toMatchObject({ code: "ALREADY_PROCESSED_PAYMENT", retryable: true });

      stubFetch(() => new Response("<html>Bad Gateway</html>", { status: 502 }));
      await expect(confirm()).rejects.toMatchObject({ code: "HTTP_502", retryable: true });

      stubFetch(() => {
        throw new TypeError("fetch failed");
      });
      await expect(confirm()).rejects.toMatchObject({ code: "NETWORK_ERROR", retryable: true });

      stubFetch(() => new Response("not json", { status: 200 }));
      await expect(confirm()).rejects.toMatchObject({ code: "INVALID_RESPONSE", retryable: true });
    });

    it("응답이 없으면 승인은 30초, 그 밖의 요청은 15초 뒤에 끊고 retryable TIMEOUT 을 던진다", async () => {
      vi.useFakeTimers();
      // 응답하지 않다가 요청이 중단되면 실패하는 서버
      stubFetch(
        (_call, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
          }),
      );

      let settled = false;
      const confirming = confirm().catch((e: unknown) => {
        settled = true;
        return e;
      });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await confirming).toMatchObject({ name: "PaymentProviderError", code: "TIMEOUT", retryable: true });

      const cancelling = toss.tossPaymentProvider.cancel({ paymentKey: "tpk_err", amount: 1_000, reason: "환불", idempotencyKey: "r1" }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await cancelling).toMatchObject({ code: "TIMEOUT", retryable: true });
    });

    it("바로 승인되지 않는 결제 수단(입금 대기)은 발급된 결제를 취소하고 거절한다", async () => {
      const calls = stubFetch((call) =>
        isConfirm(call)
          ? json(200, tossPayment("nj_order_err1", { paymentKey: "tpk_err", status: "WAITING_FOR_DEPOSIT", method: "가상계좌", approvedAt: null }))
          : json(200, tossPayment("nj_order_err1", { paymentKey: "tpk_err", status: "CANCELED", balanceAmount: 0 })),
      );
      await expect(confirm()).rejects.toMatchObject({ code: "UNSUPPORTED_PAYMENT_METHOD", retryable: false });
      expect(calls.filter((c) => isCancel(c, "tpk_err"))).toHaveLength(1);
    });
  });

  describe("연동 설정", () => {
    it("브라우저로 보내는 설정에는 클라이언트 키만 있고 시크릿 키는 없다", async () => {
      const config = provider.getPaymentClientConfig();
      expect(config).toEqual({ provider: "toss", clientKey: CLIENT_KEY, isTest: true });
      expect(JSON.stringify(config)).not.toContain(SECRET_KEY);
      expect(JSON.stringify(config)).not.toContain("_sk_");

      await loadModules({ TOSS_CLIENT_KEY: "live_ck_REALCLIENTKEY", TOSS_SECRET_KEY: "live_sk_REALSECRETKEY" });
      const live = provider.getPaymentClientConfig();
      expect(live).toEqual({ provider: "toss", clientKey: "live_ck_REALCLIENTKEY", isTest: false });
      expect(JSON.stringify(live)).not.toContain("live_sk_REALSECRETKEY");

      await loadModules({ PAYMENT_PROVIDER: "mock" });
      const mock = provider.getPaymentClientConfig();
      expect(mock).toEqual({ provider: "mock", clientKey: null, isTest: true });
      expect(JSON.stringify(mock)).not.toContain(SECRET_KEY);
    });

    it("토스 키가 없으면 NOT_CONFIGURED 로 명시적으로 실패하고 PG 를 부르지 않는다", async () => {
      await loadModules({ TOSS_SECRET_KEY: undefined, TOSS_CLIENT_KEY: undefined });
      const calls = stubFetch(() => json(200, {}));

      expect(provider.getPaymentClientConfig()).toEqual({ provider: "toss", clientKey: null, isTest: false });
      const adapter = provider.getPaymentProvider();
      expect(adapter.name).toBe("TOSS");
      expect((await appError(adapter.confirm({ paymentKey: "tpk_1", orderId: "nj_order_0001", amount: 1_000 }))).code).toBe("NOT_CONFIGURED");
      expect((await appError(adapter.cancel({ paymentKey: "tpk_1", amount: 1_000, reason: "환불", idempotencyKey: "r1" }))).code).toBe("NOT_CONFIGURED");
      expect((await appError(adapter.fetchByOrderId("nj_order_0001"))).code).toBe("NOT_CONFIGURED");

      // 결제를 시작하기 전에(주문 생성 단계에서) 막는다.
      const booking = await createBooking();
      const creating = prisma.$transaction((tx) => payments.createPaymentOrder(tx, { bookingId: booking.id, amount: 30_000 }));
      expect((await appError(creating)).code).toBe("NOT_CONFIGURED");
      expect(await prisma.payment.count()).toBe(0);
      expect(calls).toHaveLength(0);
    });

    it("주문을 만든 뒤 키가 빠지면 승인은 NOT_CONFIGURED 로 실패하고 주문은 그대로 남는다", async () => {
      const { order } = await createOrder(30_000, payments);
      await loadModules({ TOSS_SECRET_KEY: undefined });
      const calls = stubFetch(() => json(200, {}));

      const error = await appError(payments.confirmPayment({ orderId: order.orderId, paymentKey: "tpk_nokey", amount: 30_000 }));
      expect(error.code).toBe("NOT_CONFIGURED");
      expect(await findPayment(order.id)).toMatchObject({ status: "READY", paymentKey: null, failCode: null });
      expect(calls).toHaveLength(0);
    });

    it("키가 빠진 상태의 환불은 성공으로 꾸미지 않고 FAILED 로 남는다", async () => {
      const { booking, payment } = await createTossPaid("tpk_cfg");
      await loadModules({ TOSS_SECRET_KEY: undefined });
      const calls = stubFetch(() => json(200, {}));

      const refund = await payments.refundPayment({ bookingId: booking.id, amount: 30_000, reason: "환불", requestedBy: "ADMIN" });
      expect(refund).toMatchObject({ status: "FAILED", error: "토스페이먼츠 결제 연동이 아직 설정되지 않았어요." });
      expect(await findPayment(payment.id)).toMatchObject({ status: "PAID", cancelledAmount: 0 });
      expect(calls).toHaveLength(0);
    });
  });

  describe("결제 승인 흐름", () => {
    it("승인 응답을 PAID 로 기록한다(영수증·결제수단 포함, secret 제외)", async () => {
      const { order } = await createOrder(30_000, payments);
      expect(order.provider).toBe("TOSS");
      const calls = stubFetch(() => json(200, tossPayment(order.orderId, { paymentKey: "tpk_ok" })));

      const result = await payments.confirmPayment({ orderId: order.orderId, paymentKey: "tpk_ok", amount: 30_000 });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toEqual({ paymentKey: "tpk_ok", orderId: order.orderId, amount: 30_000 });
      expect(result.payment).toMatchObject({
        status: "PAID",
        paymentKey: "tpk_ok",
        method: "카드",
        receiptUrl: "https://dashboard.tosspayments.com/receipt/redirection?transactionId=t1",
      });
      expect(result.payment.approvedAt?.toISOString()).toBe("2026-11-27T10:30:00.000Z");
      expect(JSON.stringify(result.payment.raw)).not.toContain("ps_webhook_secret_value");
    });

    it("카드 거절은 FAILED 로 남기고 안내 문구와 함께 PAYMENT_FAILED 를 던진다", async () => {
      const { order } = await createOrder(30_000, payments);
      stubFetch(() => json(403, { code: "REJECT_CARD_COMPANY", message: "결제 승인이 거절되었습니다." }));

      const error = await appError(payments.confirmPayment({ orderId: order.orderId, paymentKey: "tpk_no", amount: 30_000 }));

      expect(error).toEqual({ code: "PAYMENT_FAILED", message: "카드사에서 결제를 승인하지 않았어요. 카드사에 문의하거나 다른 카드로 결제해 주세요." });
      expect(await findPayment(order.id)).toMatchObject({ status: "FAILED", failCode: "REJECT_CARD_COMPANY", paymentKey: "tpk_no" });
    });

    it("승인 요청이 시간 초과되면 조회로 결과를 확인해 승인 건을 놓치지 않는다", async () => {
      const { order } = await createOrder(30_000, payments);
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const calls = stubFetch((call, init) => {
        // 승인 요청은 응답이 없다가 중단되고, 조회에서는 승인 완료로 확인된다.
        if (isConfirm(call)) {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
          });
        }
        if (isLookup(call, "tpk_slow")) return json(200, tossPayment(order.orderId, { paymentKey: "tpk_slow" }));
        return json(500, {});
      });

      const confirming = payments.confirmPayment({ orderId: order.orderId, paymentKey: "tpk_slow", amount: 30_000 });
      while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await confirming;

      expect(result).toMatchObject({ alreadyProcessed: false, payment: { status: "PAID", paymentKey: "tpk_slow", failCode: null } });
      expect(calls.filter(isConfirm)).toHaveLength(1);
      expect(calls.filter((c) => isLookup(c, "tpk_slow"))).toHaveLength(1);
    });

    it("결과를 끝내 알 수 없으면 점유를 풀고 대사 대상으로 남기며, 같은 결제로 다시 시도할 수 있다", async () => {
      const { booking, order } = await createOrder(30_000, payments);
      vi.spyOn(console, "error").mockImplementation(() => {});
      let confirmResponse = () => json(500, { code: "FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING", message: "결제가 완료되지 않았어요." });
      const calls = stubFetch((call) => {
        if (isConfirm(call)) return confirmResponse();
        if (isLookup(call, "tpk_unknown")) return json(200, tossPayment(order.orderId, { paymentKey: "tpk_unknown", status: "IN_PROGRESS", approvedAt: null }));
        return json(500, {});
      });

      const error = await appError(payments.confirmPayment({ orderId: order.orderId, paymentKey: "tpk_unknown", amount: 30_000 }));
      expect(error).toEqual({ code: "PAYMENT_FAILED", message: "결제 확인이 지연되고 있어요. 잠시 후 다시 시도해 주세요." });
      expect(await findPayment(order.id)).toMatchObject({ status: "READY", paymentKey: null, failCode: "CONFIRM_UNKNOWN" });

      // 결과가 확정될 때까지: 홀드 만료로 닫지 않고, 같은 예약의 새 주문 결제를 막고, 크론 대사 대상에 올린다.
      expect(await payments.markPaymentAbandoned(order.orderId)).toBe(false);
      expect(await payments.listPaymentsNeedingReconcile()).toEqual([order.orderId]);
      const second = await prisma.$transaction((tx) => payments.createPaymentOrder(tx, { bookingId: booking.id, amount: 30_000 }));
      expect((await appError(payments.confirmPayment({ orderId: second.orderId, paymentKey: "tpk_second", amount: 30_000 }))).code).toBe("CONFLICT");
      expect(calls.filter(isConfirm)).toHaveLength(1);

      // 같은 결제 키로 다시 시도하면 승인된다(주문번호 멱등 키는 그대로).
      confirmResponse = () => json(200, tossPayment(order.orderId, { paymentKey: "tpk_unknown" }));
      const retried = await payments.confirmPayment({ orderId: order.orderId, paymentKey: "tpk_unknown", amount: 30_000 });
      expect(retried).toMatchObject({ alreadyProcessed: false, payment: { status: "PAID", paymentKey: "tpk_unknown", failCode: null, failMessage: null } });
      expect(calls.filter(isConfirm).map((c) => c.headers["Idempotency-Key"])).toEqual([order.orderId, order.orderId]);
      expect(await payments.listPaymentsNeedingReconcile()).toEqual([]);
    });

    it('"이미 처리된 결제" 응답은 조회로 확인해 승인 건이면 성공으로 처리한다', async () => {
      const { order } = await createOrder(30_000, payments);
      vi.spyOn(console, "error").mockImplementation(() => {});
      stubFetch((call) => {
        if (isConfirm(call)) return json(400, { code: "ALREADY_PROCESSED_PAYMENT", message: "이미 처리된 결제 입니다." });
        if (isLookup(call, "tpk_again")) return json(200, tossPayment(order.orderId, { paymentKey: "tpk_again" }));
        return json(500, {});
      });

      const result = await payments.confirmPayment({ orderId: order.orderId, paymentKey: "tpk_again", amount: 30_000 });
      expect(result.payment).toMatchObject({ status: "PAID", paymentKey: "tpk_again" });
    });

    it("PG 승인 금액이 주문 금액과 다르면 자동 취소하고 결제를 실패 처리한다", async () => {
      const { order } = await createOrder(30_000, payments);
      const calls = stubFetch((call) => {
        if (isConfirm(call)) return json(200, tossPayment(order.orderId, { paymentKey: "tpk_diff", totalAmount: 3_000, balanceAmount: 3_000 }));
        if (isCancel(call, "tpk_diff")) {
          return json(200, tossPayment(order.orderId, { paymentKey: "tpk_diff", status: "CANCELED", totalAmount: 3_000, balanceAmount: 0, cancels: [{ cancelAmount: 3_000, transactionKey: "txn_rev", cancelStatus: "DONE" }] }));
        }
        return json(500, {});
      });

      const error = await appError(payments.confirmPayment({ orderId: order.orderId, paymentKey: "tpk_diff", amount: 30_000 }));

      expect(error.code).toBe("PAYMENT_FAILED");
      expect(calls.filter((c) => isCancel(c, "tpk_diff")).map((c) => c.body)).toEqual([{ cancelReason: "주문 금액 불일치로 자동 취소", cancelAmount: 3_000 }]);
      expect(await findPayment(order.id)).toMatchObject({ status: "FAILED", failCode: "PROVIDER_AMOUNT_MISMATCH", approvedAt: null });
      expect(await prisma.auditLog.count({ where: { action: "payment.auto_reversal", targetId: order.id } })).toBe(1);
    });

    it("PG 응답이 늦는 동안 들어온 같은 승인 요청은 PG 를 다시 부르지 않고 같은 결과를 받는다", async () => {
      const { order } = await createOrder(30_000, payments);
      const calls = stubFetch(async (call) => {
        if (!isConfirm(call)) return json(500, {});
        await new Promise((resolve) => setTimeout(resolve, 400));
        return json(200, tossPayment(order.orderId, { paymentKey: "tpk_twice" }));
      });
      const input = { orderId: order.orderId, paymentKey: "tpk_twice", amount: 30_000 };

      const first = payments.confirmPayment(input);
      while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      // 첫 요청이 PG 응답을 기다리는 중에 두 번째 요청이 들어온다.
      const second = payments.confirmPayment(input);
      const [a, b] = await Promise.all([first, second]);

      expect(calls.filter(isConfirm)).toHaveLength(1);
      expect(a).toMatchObject({ alreadyProcessed: false, payment: { status: "PAID", paymentKey: "tpk_twice" } });
      expect(b).toMatchObject({ alreadyProcessed: true, payment: { status: "PAID", paymentKey: "tpk_twice" } });
    });

    it("테스트 결제로 만든 주문은 실제 결제 환경에서 승인되지 않는다", async () => {
      const { order } = await createOrder(30_000);
      expect(order.provider).toBe("MOCK");
      const calls = stubFetch(() => json(200, {}));

      const error = await appError(payments.confirmPayment({ orderId: order.orderId, paymentKey: newMockPaymentKey(), amount: 30_000 }));
      expect(error.code).toBe("CONFLICT");
      expect((await findPayment(order.id)).status).toBe("READY");
      expect(calls).toHaveLength(0);
    });
  });

  describe("환불 흐름", () => {
    it("부분 환불: 환불 ID 를 멱등 키로 PG 부분 취소를 요청하고 결과를 기록한다", async () => {
      const { booking, payment } = await createTossPaid("tpk_part");
      const calls = stubFetch(() =>
        json(200, tossPayment(payment.orderId, { paymentKey: "tpk_part", status: "PARTIAL_CANCELED", balanceAmount: 20_000, cancels: [{ cancelAmount: 10_000, transactionKey: "txn_part_1", cancelStatus: "DONE" }] })),
      );

      const refund = await payments.refundPayment({ bookingId: booking.id, amount: 10_000, reason: "고객 요청 부분 환불", requestedBy: "SELLER" });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: `${TOSS}/v1/payments/tpk_part/cancel`, body: { cancelReason: "고객 요청 부분 환불", cancelAmount: 10_000 } });
      expect(calls[0]!.headers["Idempotency-Key"]).toBe(refund!.id);
      expect(refund).toMatchObject({ status: "DONE", providerRef: "txn_part_1", amount: 10_000 });
      expect(await findPayment(payment.id)).toMatchObject({ status: "PARTIAL_CANCELLED", cancelledAmount: 10_000 });
    });

    it("PG 취소가 실패하면 던지지 않고 FAILED 로 남기며, 재시도하면 같은 멱등 키로 요청해 완료한다", async () => {
      const { booking, payment } = await createTossPaid("tpk_refund");
      let cancelResponse = () => json(500, { code: "FAILED_REFUND_PROCESS", message: "은행 응답시간 지연이나 일시적인 오류로 환불요청에 실패했습니다." });
      const calls = stubFetch((call) => (isCancel(call, "tpk_refund") ? cancelResponse() : json(500, {})));

      const failed = await payments.refundPayment({ bookingId: booking.id, amount: 30_000, reason: "사업자 취소", requestedBy: "SELLER" });

      expect(failed).toMatchObject({ status: "FAILED", providerRef: null, processedAt: null });
      expect(failed?.error).toContain("FAILED_REFUND_PROCESS");
      expect(await findPayment(payment.id)).toMatchObject({ status: "PAID", cancelledAmount: 0 });
      expect((await payments.listFailedRefunds()).map((r) => r.id)).toEqual([failed!.id]);
      expect(await prisma.auditLog.count({ where: { action: "payment.refund_failed", targetId: failed!.id } })).toBe(1);

      cancelResponse = () =>
        json(200, tossPayment(payment.orderId, { paymentKey: "tpk_refund", status: "CANCELED", balanceAmount: 0, cancels: [{ cancelAmount: 30_000, transactionKey: "txn_full_1", cancelStatus: "DONE" }] }));
      const retried = await payments.retryRefund(failed!.id);

      expect(retried).toMatchObject({ id: failed!.id, status: "DONE", providerRef: "txn_full_1", error: null });
      expect(retried.processedAt).toBeInstanceOf(Date);
      expect(await findPayment(payment.id)).toMatchObject({ status: "CANCELLED", cancelledAmount: 30_000 });
      expect(calls.filter((c) => isCancel(c, "tpk_refund")).map((c) => c.headers["Idempotency-Key"])).toEqual([failed!.id, failed!.id]);
      expect(await payments.listFailedRefunds()).toHaveLength(0);
    });

    it("PG 가 확정적으로 거절한 환불은 재시도 때 새 멱등 키(환불ID-r1)로 요청한다", async () => {
      const { booking, payment } = await createTossPaid("tpk_reject");
      let cancelResponse = () => json(400, { code: "INVALID_REFUND_ACCOUNT_INFO", message: "환불 계좌번호와 예금주명이 일치하지 않습니다." });
      const calls = stubFetch((call) => (isCancel(call, "tpk_reject") ? cancelResponse() : json(500, {})));

      const failed = await payments.refundPayment({ bookingId: booking.id, amount: 30_000, reason: "회차 취소", requestedBy: "SELLER" });
      expect(failed).toMatchObject({ status: "FAILED", attempts: 0, providerRef: null, processedAt: null });
      expect(failed?.error?.startsWith(payments.REFUND_REJECTED_TAG)).toBe(true);
      expect(failed?.error).toContain("INVALID_REFUND_ACCOUNT_INFO");
      expect(await findPayment(payment.id)).toMatchObject({ status: "PAID", cancelledAmount: 0 });

      // 같은 키로 다시 보내면 PG 는 처음의 거절 응답을 되돌려 줄 뿐이므로 새 키로 보낸다.
      cancelResponse = () =>
        json(200, tossPayment(payment.orderId, { paymentKey: "tpk_reject", status: "CANCELED", balanceAmount: 0, cancels: [{ cancelAmount: 30_000, transactionKey: "txn_retry_1", cancelStatus: "DONE" }] }));
      const retried = await payments.retryRefund(failed!.id);

      expect(retried).toMatchObject({ id: failed!.id, status: "DONE", attempts: 1, providerRef: "txn_retry_1", error: null });
      expect(calls.filter((c) => isCancel(c, "tpk_reject")).map((c) => c.headers["Idempotency-Key"])).toEqual([failed!.id, `${failed!.id}-r1`]);
      expect(await findPayment(payment.id)).toMatchObject({ status: "CANCELLED", cancelledAmount: 30_000 });
    });

    it("PG 가 요청과 다른 금액을 취소했다고 답하면 완료로 처리하지 않는다", async () => {
      const { booking, payment } = await createTossPaid("tpk_odd");
      stubFetch(() =>
        json(200, tossPayment(payment.orderId, { paymentKey: "tpk_odd", status: "PARTIAL_CANCELED", balanceAmount: 25_000, cancels: [{ cancelAmount: 5_000, transactionKey: "txn_odd", cancelStatus: "DONE" }] })),
      );

      const refund = await payments.refundPayment({ bookingId: booking.id, amount: 10_000, reason: "부분 환불", requestedBy: "ADMIN" });
      expect(refund?.status).toBe("FAILED");
      expect(refund?.error).toContain("CANCEL_AMOUNT_MISMATCH");
      expect(await findPayment(payment.id)).toMatchObject({ status: "PAID", cancelledAmount: 0 });
    });
  });

  describe("대사", () => {
    it("결과를 몰라 풀어 둔 주문이 PG 에서 승인돼 있으면 PAID 로 맞춘다(결제 키로 조회)", async () => {
      const { order } = await createOrder(30_000, payments);
      vi.spyOn(console, "error").mockImplementation(() => {});
      let lookupFails = true;
      const calls = stubFetch((call) => {
        if (isConfirm(call)) throw new TypeError("fetch failed");
        if (isLookup(call, "tpk_lost")) return lookupFails ? json(500, {}) : json(200, tossPayment(order.orderId, { paymentKey: "tpk_lost" }));
        return json(404, { code: "NOT_FOUND_PAYMENT", message: "존재하지 않는 결제 정보 입니다." });
      });
      await appError(payments.confirmPayment({ orderId: order.orderId, paymentKey: "tpk_lost", amount: 30_000 }));
      expect(await findPayment(order.id)).toMatchObject({ status: "READY", paymentKey: null, failCode: "CONFIRM_UNKNOWN" });

      // PG 조회가 계속 실패하는 동안에는 상태를 바꾸지 않는다.
      expect(await payments.reconcilePayment(order.orderId)).toMatchObject({ state: "UNKNOWN", payment: { status: "READY" } });

      lookupFails = false;
      const result = await payments.reconcilePayment(order.orderId);
      expect(result).toMatchObject({ state: "PAID", payment: { status: "PAID", paymentKey: "tpk_lost", failCode: null } });
      expect(calls.at(-1)).toMatchObject({ method: "GET", url: `${TOSS}/v1/payments/tpk_lost` });
      expect(await prisma.auditLog.count({ where: { action: "payment.reconcile", targetId: order.id } })).toBe(1);
      // 다시 불러도 결과가 같다.
      expect((await payments.reconcilePayment(order.orderId)).state).toBe("PAID");
    });

    it("결과를 몰라 풀어 둔 주문이 PG 에서 승인 실패·만료로 끝났으면 FAILED 로 닫는다", async () => {
      const { order } = await createOrder(30_000, payments);
      vi.spyOn(console, "error").mockImplementation(() => {});
      let lookupStatus = "IN_PROGRESS";
      stubFetch((call) => {
        if (isConfirm(call)) throw new TypeError("fetch failed");
        return json(200, tossPayment(order.orderId, { paymentKey: "tpk_dead", status: lookupStatus, approvedAt: null }));
      });
      await appError(payments.confirmPayment({ orderId: order.orderId, paymentKey: "tpk_dead", amount: 30_000 }));

      expect(await payments.reconcilePayment(order.orderId)).toMatchObject({ state: "PENDING", payment: { status: "READY", failCode: "CONFIRM_UNKNOWN" } });

      lookupStatus = "EXPIRED";
      expect(await payments.reconcilePayment(order.orderId)).toMatchObject({ state: "CANCELLED", payment: { status: "FAILED", failCode: "PROVIDER_EXPIRED" } });
      expect(await payments.listPaymentsNeedingReconcile()).toEqual([]);
    });

    it("웹훅으로 알게 된 결제 키는 조회에만 쓰고, 결제 전인 주문은 PG 가 승인했다고 할 때만 바꾼다", async () => {
      const { order } = await createOrder(30_000, payments);
      let status = "IN_PROGRESS";
      const calls = stubFetch((call) =>
        isLookup(call, "tpk_hook") ? json(200, tossPayment(order.orderId, { paymentKey: "tpk_hook", status, approvedAt: status === "DONE" ? "2026-11-27T19:30:00+09:00" : null })) : json(500, {}),
      );

      expect(await payments.reconcilePayment(order.orderId, { paymentKey: "tpk_hook" })).toMatchObject({ state: "PENDING", payment: { status: "READY", paymentKey: null } });

      // 고객이 결제창에서 실패했더라도(ABORTED) 우리가 승인을 요청한 적 없는 주문은 다시 결제할 수 있게 둔다.
      status = "ABORTED";
      expect(await payments.reconcilePayment(order.orderId, { paymentKey: "tpk_hook" })).toMatchObject({ state: "PENDING", payment: { status: "READY" } });

      status = "DONE";
      expect(await payments.reconcilePayment(order.orderId, { paymentKey: "tpk_hook" })).toMatchObject({ state: "PAID", payment: { status: "PAID", paymentKey: "tpk_hook" } });
      expect(calls.every((c) => c.method === "GET")).toBe(true);
    });

    it("PG 에서 직접 전액 취소된 결제는 CANCELLED 로 맞추고 열린 환불을 닫는다", async () => {
      const { booking, payment } = await createTossPaid("tpk_console");
      vi.spyOn(console, "error").mockImplementation(() => {});
      // 10,000원 환불은 PG 오류로 실패해 있고, 그 뒤 PG 관리자 화면에서 전액 취소된 상황
      stubFetch(() => json(500, { code: "FAILED_REFUND_PROCESS", message: "환불요청에 실패했습니다." }));
      const failed = await payments.refundPayment({ bookingId: booking.id, amount: 10_000, reason: "부분 환불", requestedBy: "SELLER" });
      expect(failed?.status).toBe("FAILED");

      stubFetch(() => json(200, tossPayment(payment.orderId, { paymentKey: "tpk_console", status: "CANCELED", balanceAmount: 0, cancels: [{ cancelAmount: 30_000, transactionKey: "txn_console", cancelStatus: "DONE" }] })));
      const result = await payments.reconcilePayment(payment.orderId);

      expect(result).toMatchObject({ state: "CANCELLED", payment: { status: "CANCELLED", cancelledAmount: 30_000 } });
      const refunds = await prisma.refund.findMany({ where: { paymentId: payment.id }, orderBy: { amount: "asc" } });
      expect(refunds.map((r) => [r.amount, r.status, r.requestedBy])).toEqual([
        [10_000, "DONE", "SELLER"],
        [20_000, "DONE", "SYSTEM"],
      ]);
      expect(await payments.listFailedRefunds()).toHaveLength(0);
    });

    it("같은 예약에 이미 승인된 결제가 있는데 다른 주문이 PG 에서 승인돼 있으면 자동 취소한다", async () => {
      const { booking, payment: paid } = await createTossPaid("tpk_first");
      const stray = await prisma.$transaction((tx) => payments.createPaymentOrder(tx, { bookingId: booking.id, amount: 30_000 }));
      const calls = stubFetch((call) => {
        if (call.method === "GET") return json(200, tossPayment(stray.orderId, { paymentKey: "tpk_stray" }));
        if (isCancel(call, "tpk_stray")) {
          return json(200, tossPayment(stray.orderId, { paymentKey: "tpk_stray", status: "CANCELED", balanceAmount: 0, cancels: [{ cancelAmount: 30_000, transactionKey: "txn_dup", cancelStatus: "DONE" }] }));
        }
        return json(500, {});
      });

      const result = await payments.reconcilePayment(stray.orderId);

      expect(result).toMatchObject({ state: "CANCELLED", payment: { status: "FAILED", failCode: "DUPLICATE_PAYMENT" } });
      expect(calls[0]).toMatchObject({ method: "GET", url: `${TOSS}/v1/payments/orders/${stray.orderId}` });
      expect(calls.filter((c) => isCancel(c, "tpk_stray")).map((c) => c.body)).toEqual([{ cancelReason: "중복 결제 자동 취소", cancelAmount: 30_000 }]);
      expect(await findPayment(paid.id)).toMatchObject({ status: "PAID", cancelledAmount: 0 });
    });

    it("자동 취소가 실패하면 다음 대사에서 다시 시도한다", async () => {
      const { booking } = await createTossPaid("tpk_first2");
      const stray = await prisma.$transaction((tx) => payments.createPaymentOrder(tx, { bookingId: booking.id, amount: 30_000 }));
      vi.spyOn(console, "error").mockImplementation(() => {});
      let cancelWorks = false;
      const calls = stubFetch((call) => {
        if (call.method === "GET") return json(200, tossPayment(stray.orderId, { paymentKey: "tpk_stray2" }));
        if (isCancel(call, "tpk_stray2") && cancelWorks) {
          return json(200, tossPayment(stray.orderId, { paymentKey: "tpk_stray2", status: "CANCELED", balanceAmount: 0, cancels: [{ cancelAmount: 30_000, transactionKey: "txn_dup2", cancelStatus: "DONE" }] }));
        }
        return json(500, { code: "FAILED_INTERNAL_SYSTEM_PROCESSING", message: "내부 시스템 처리 작업이 실패했습니다." });
      });

      expect(await payments.reconcilePayment(stray.orderId)).toMatchObject({
        state: "UNKNOWN",
        payment: { status: "READY", paymentKey: "tpk_stray2", failCode: "DUPLICATE_REVERSAL_PENDING" },
      });
      expect(await payments.listPaymentsNeedingReconcile()).toEqual([stray.orderId]);

      cancelWorks = true;
      expect(await payments.reconcilePayment(stray.orderId)).toMatchObject({ state: "CANCELLED", payment: { status: "FAILED", failCode: "DUPLICATE_PAYMENT" } });
      // 전액 취소는 시도마다 다른 멱등 키로 보낸다(실패 응답이 되풀이되지 않게).
      const keys = calls.filter((c) => isCancel(c, "tpk_stray2")).map((c) => c.headers["Idempotency-Key"]);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
      expect(await payments.listPaymentsNeedingReconcile()).toEqual([]);
    });
  });
});
