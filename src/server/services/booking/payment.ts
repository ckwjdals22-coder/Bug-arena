import "server-only";
import { z } from "zod";
import type { BookingStatus } from "@/generated/prisma/client";
import { MINUTE } from "@/lib/time";
import { prisma } from "@/server/db";
import { err } from "@/server/errors";
import { reserveSeats } from "@/server/services/inventory";
import { confirmPayment, getPaymentByOrderId, listPaymentsNeedingReconcile, reconcilePayment, type ReconcileState } from "@/server/services/payments";
import { getSettings } from "@/server/settings";
import { afterHoldExpired, cancelBookingCore, expireBookingHold, finalizePaidBooking, settleOrphanPayments } from "./lifecycle";
import {
  JOB_BATCH,
  MSG_BOOKING_NOT_FOUND,
  PAYMENT_HOLD_EXTENSION_MS,
  idSchema,
  isUniqueViolation,
  parseInput,
  runTx,
  toBookingSummary,
  type BookingSummary,
} from "./shared";

/**
 * 결제와 예약 상태 잇기 — 결제 승인 뒤 확정, 결제 그만두기, 홀드 만료, 웹훅·대사.
 * 결제사와 통신하는 호출(confirmPayment·reconcilePayment·환불)은 모두 DB 트랜잭션 밖에서 한다.
 */

const MSG_HOLD_LAPSED = "결제 시간이 지나 자리가 풀렸어요. 다시 예약해 주세요.";
const MSG_PAYMENT_NOT_FOUND = "결제 정보를 찾을 수 없어요.";
const MSG_CHECKING = "결제 결과를 확인하고 있어요. 잠시 후 예약 내역에서 확인해 주세요.";
const MSG_REFUNDED = "예약을 확정하지 못해 결제를 바로 취소했어요. 자리가 남아 있으면 다시 예약해 주세요.";
const MSG_ALREADY_CLOSED = "이미 처리가 끝난 예약이에요. 예약 내역에서 확인해 주세요.";

const SETTLED: BookingStatus[] = ["CONFIRMED", "PENDING_APPROVAL", "COMPLETED", "NO_SHOW"];

const confirmSchema = z.object({
  userId: idSchema,
  orderId: z.string("주문번호를 확인해 주세요.").regex(/^[A-Za-z0-9_=-]{6,64}$/, "주문번호 형식이 올바르지 않아요."),
  paymentKey: z.string("결제 정보가 올바르지 않아요.").min(1, "결제 정보가 올바르지 않아요.").max(200, "결제 정보가 올바르지 않아요."),
  amount: z.number("결제 금액이 올바르지 않아요.").int("결제 금액이 올바르지 않아요.").min(0, "결제 금액이 올바르지 않아요.").max(1_000_000_000, "결제 금액이 올바르지 않아요."),
});

export interface ConfirmBookingPaymentResult {
  booking: BookingSummary;
  /** 확정됐는지, 승인제 상품이라 사업자 승인을 기다리는지 */
  status: "CONFIRMED" | "PENDING_APPROVAL";
  /** true 면 이전 요청에서 이미 처리된 결제다 */
  alreadyProcessed: boolean;
}

class Unrecoverable extends Error {}

/**
 * 결제 승인 요청 전에 좌석 홀드를 확보한다. 결제사 승인이 진행되는 동안 만료 작업이 예약을 풀지 못하게 하기 위해서다.
 * 1) 시간이 남은 홀드는 조건부 UPDATE 한 문장으로 늘린다(줄어들지는 않고, 처음 홀드 시간 + 승인 시간 한 번을 넘지 않는다).
 * 2) 시간이 지났지만 아직 좌석을 쥐고 있는 예약은 회차가 시작 전이면 그대로 이어 간다.
 * 3) 시간 초과로 이미 풀린 예약은 좌석을 다시 잡을 수 있을 때만 결제 대기로 되살린다(닫아 둔 주문도 다시 연다).
 * 고객이 직접 그만둔 예약, 취소·시작된 회차는 되살리지 않는다. 확보하지 못하면 false — 결제는 청구되지 않는다.
 */
async function secureHold(
  booking: { id: string; slotId: string; slotSeatId: string; quantity: number; createdAt: Date },
  orderId: string,
  holdMinutes: number,
  now: Date,
): Promise<boolean> {
  const until = new Date(now.getTime() + PAYMENT_HOLD_EXTENSION_MS);
  // 결제를 거듭 시도해 홀드를 끝없이 늘릴 수 없게, 늘어나는 한도를 "처음 홀드 시간 + 한 번의 승인 시간"으로 묶는다.
  const cap = new Date(Math.min(until.getTime(), booking.createdAt.getTime() + holdMinutes * MINUTE + PAYMENT_HOLD_EXTENSION_MS));
  const extended = await prisma.$executeRaw`
    UPDATE "Booking"
    SET "holdExpiresAt" = GREATEST("holdExpiresAt", ${cap}::timestamp), "updatedAt" = ${now}::timestamp
    WHERE "id" = ${booking.id} AND "status" = 'PENDING_PAYMENT' AND "holdExpiresAt" > ${now}::timestamp`;
  if (extended === 1) return true;

  try {
    return await runTx(async (tx) => {
      const slots = await tx.$queryRaw<{ status: string; startAt: Date }[]>`
        SELECT "status"::text AS "status", "startAt" FROM "Slot" WHERE "id" = ${booking.slotId} FOR SHARE`;
      const slot = slots[0];
      if (!slot || slot.status === "CANCELLED" || slot.startAt.getTime() <= now.getTime()) return false;
      const rows = await tx.$queryRaw<{ status: string; cancelledBy: string | null }[]>`
        SELECT "status"::text AS "status", "cancelledBy"::text AS "cancelledBy" FROM "Booking" WHERE "id" = ${booking.id} FOR UPDATE`;
      const current = rows[0];
      if (!current) return false;
      if (current.status === "PENDING_PAYMENT") {
        await tx.booking.update({ where: { id: booking.id }, data: { holdExpiresAt: until } });
        return true;
      }
      if (current.status !== "EXPIRED" || current.cancelledBy !== null || slot.status !== "OPEN") return false;
      if (!(await reserveSeats(tx, booking.slotSeatId, booking.quantity))) return false;
      // 홀드 만료 때 결제 없이 닫아 둔 주문만 다시 연다(결제사에 요청이 나간 적 없는 주문).
      const reopened = await tx.payment.updateMany({
        where: { bookingId: booking.id, orderId, status: "CANCELLED", approvedAt: null, paymentKey: null, failCode: null, cancelledAmount: 0 },
        data: { status: "READY" },
      });
      if (reopened.count !== 1) throw new Unrecoverable();
      await tx.booking.update({ where: { id: booking.id }, data: { status: "PENDING_PAYMENT", holdExpiresAt: until } });
      return true;
    });
  } catch (e) {
    // 그사이 같은 회차에 다른 예약을 만들었으면(진행 중 예약은 회차당 하나) 되살리지 않는다.
    if (e instanceof Unrecoverable || isUniqueViolation(e)) return false;
    throw e;
  }
}

/**
 * 결제창에서 돌아온 결제를 승인하고 예약을 확정한다.
 * - 본인 예약의 주문만 처리한다(남의 주문번호는 없는 것으로 답한다).
 * - 이미 확정된 예약 + 승인된 결제면 그대로 성공을 돌려준다(새로고침·중복 호출).
 * - 결제사 승인 전에 홀드를 확보한다. 자리가 이미 풀려 다시 잡을 수 없으면 청구 없이 CLOSED.
 * - 승인 뒤 예약을 확정하지 못하면 결제 금액을 바로 전액 환불하고 CLOSED 를 던진다.
 * - 결제가 거절되면(PAYMENT_FAILED 등) 홀드는 남은 시간 동안 그대로 둔다.
 */
export async function confirmBookingPayment(input: { userId: string; orderId: string; paymentKey: string; amount: number }): Promise<ConfirmBookingPaymentResult> {
  const data = parseInput(confirmSchema, input);
  const now = new Date();
  const payment = await getPaymentByOrderId(data.orderId);
  if (!payment) throw err.notFound(MSG_PAYMENT_NOT_FOUND);
  const booking = await prisma.booking.findUnique({ where: { id: payment.bookingId } });
  if (!booking || booking.userId !== data.userId) throw err.notFound(MSG_PAYMENT_NOT_FOUND);

  const paid = payment.status === "PAID" || payment.status === "PARTIAL_CANCELLED";
  if (paid && SETTLED.includes(booking.status)) {
    return { booking: toBookingSummary(booking), status: booking.status === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : "CONFIRMED", alreadyProcessed: true };
  }
  // 결제가 반영된 뒤 취소된 예약: 남은 결제 금액은 환불 기준에 따른 것이므로 건드리지 않는다.
  if (booking.paymentState !== "UNPAID") throw err.closed(MSG_ALREADY_CLOSED);

  if (!paid) {
    if (booking.status !== "PENDING_PAYMENT" && booking.status !== "EXPIRED") {
      throw err.closed(booking.status === "CANCELLED" ? "취소된 예약이에요. 다시 예약해 주세요." : MSG_HOLD_LAPSED);
    }
    // 이미 실패로 닫힌 주문으로는 홀드를 늘리지 않는다(같은 예약의 새 주문은 prepareBookingPayment 로 받는다).
    if (booking.status === "PENDING_PAYMENT" && payment.status !== "READY") {
      throw err.conflict("결제에 실패한 주문이에요. 예약 내역에서 다시 결제해 주세요.");
    }
    const { holdMinutes } = await getSettings();
    if (!(await secureHold(booking, payment.orderId, holdMinutes, now))) throw err.closed(MSG_HOLD_LAPSED);
    // 결제사 승인(최대 45초쯤). 거절·금액 불일치·확인 지연은 그대로 던진다 — 홀드는 남은 시간 동안 유지된다.
    await confirmPayment({ orderId: data.orderId, paymentKey: data.paymentKey, amount: data.amount });
  }

  const result = await finalizePaidBooking(booking.id);
  if (result.kind === "REFUNDED") throw err.closed(MSG_REFUNDED);
  if (result.kind === "CLOSED") throw err.closed(MSG_ALREADY_CLOSED);
  const latest = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  return { booking: toBookingSummary(latest), status: result.kind, alreadyProcessed: !result.changed };
}

// ── 결제 그만두기 ─────────────────────────────────────

/**
 * 고객이 결제를 그만둔다: PENDING_PAYMENT → EXPIRED, 좌석 반환, 주문 닫기(한 트랜잭션) 뒤 좌석 반환 뒤처리.
 * 결제 승인이 진행 중이거나 결과를 모르는 상태면 예약을 풀지 않고 CONFLICT("결제 결과를 확인하고 있어요")를 던진다
 * — 그 예약은 승인 결과에 따라 확정되거나 대사 작업이 정리한다.
 * 이미 결제 대기가 아닌 예약에는 아무 일도 하지 않는다(released: false).
 */
export async function abandonBooking(input: { userId: string; bookingId: string }): Promise<{ released: boolean; status: BookingStatus }> {
  const data = parseInput(z.object({ userId: idSchema, bookingId: idSchema }), input);
  const booking = await prisma.booking.findUnique({ where: { id: data.bookingId }, select: { id: true, userId: true, status: true } });
  if (!booking || booking.userId !== data.userId) throw err.notFound(MSG_BOOKING_NOT_FOUND);
  if (booking.status !== "PENDING_PAYMENT") return { released: false, status: booking.status };

  const result = await expireBookingHold(booking.id, "ABANDON", new Date());
  if (result.outcome === "PAYMENT_PAID") {
    // 결제는 이미 승인됐다: 예약 반영을 마저 끝내고, 취소는 확정된 예약에서 다시 하도록 안내한다.
    await finalizePaidBooking(booking.id);
    throw err.conflict("결제가 이미 승인됐어요. 예약 내역에서 확인한 뒤 취소해 주세요.");
  }
  if (result.outcome === "PAYMENT_UNKNOWN") throw err.conflict(MSG_CHECKING);
  if (result.outcome === "EXPIRED") {
    await afterHoldExpired(booking.id, result, { notifyCustomer: false });
    return { released: true, status: "EXPIRED" };
  }
  const latest = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id }, select: { status: true } });
  return { released: false, status: latest.status };
}

// ── 주기 작업 ─────────────────────────────────────────

/**
 * 주기 작업: 홀드 시간이 지난 결제 대기 예약을 EXPIRED 로 바꾸고 좌석을 반환한다. 만료한 건수를 돌려준다.
 * - 결제 승인이 진행 중이거나 결과를 모르는 예약은 건너뛴다(결제 대사 작업이 정리한다).
 * - 결제는 승인됐는데 예약 반영이 끊긴 예약은 여기서 확정(안 되면 환불)한다.
 * 동시에 여러 번 실행돼도 예약마다 한 번만 만료된다.
 */
export async function expireHolds(now: Date = new Date()): Promise<number> {
  const due = await prisma.booking.findMany({
    where: { status: "PENDING_PAYMENT", holdExpiresAt: { lt: now } },
    orderBy: { holdExpiresAt: "asc" },
    take: JOB_BATCH,
    select: { id: true },
  });
  let expired = 0;
  for (const { id } of due) {
    try {
      const result = await expireBookingHold(id, "TIMEOUT", now);
      if (result.outcome === "EXPIRED") {
        expired += 1;
        await afterHoldExpired(id, result, { notifyCustomer: true });
      } else if (result.outcome === "PAYMENT_PAID") {
        await finalizePaidBooking(id, now);
      }
    } catch (e) {
      console.error(`[booking] 홀드 만료 실패 id=${id}`, e);
    }
  }
  return expired;
}

export interface SyncBookingResult {
  /** 결제사 조회로 확인한 결제 상태 */
  paymentState: ReconcileState;
  bookingId: string;
  /** 이번 호출이 예약에 한 일 */
  action: "NONE" | "CONFIRMED" | "PENDING_APPROVAL" | "REFUNDED" | "CANCELLED" | "EXPIRED";
}

/**
 * 결제 웹훅과 대사 작업이 부른다. 결제사 조회로 결제 상태를 맞춘 뒤 예약을 그 상태에 맞춘다(결제사 승인을 다시 요청하지 않는다).
 * - 결제 승인(PAID) + 결제 대기(또는 시간 초과로 풀렸지만 좌석을 다시 잡을 수 있는) 예약 → 확정
 * - 결제 승인인데 예약을 더는 확정할 수 없음 → 전액 환불
 * - 결제사에서 직접 전액 취소된 결제 + 진행 중 예약 → 시스템 취소, 좌석 반환
 * - 결제되지 않고 끝난 주문 + 홀드 시간이 지난 결제 대기 예약 → 만료
 * 웹훅 본문은 믿지 않는다. paymentKey 는 결제사 조회 대상을 찾는 데만 쓴다.
 */
export async function syncBookingWithPayment(orderId: string, opts: { paymentKey?: string | null } = {}): Promise<SyncBookingResult> {
  const reconciled = await reconcilePayment(orderId, { paymentKey: opts.paymentKey });
  const { payment } = reconciled;
  const booking = await prisma.booking.findUnique({
    where: { id: payment.bookingId },
    select: { id: true, status: true, paymentState: true, holdExpiresAt: true },
  });
  if (!booking) throw err.notFound(MSG_BOOKING_NOT_FOUND);
  const base = { paymentState: reconciled.state, bookingId: booking.id };
  const now = new Date();

  if (reconciled.state === "PAID") {
    // 이미 결제가 반영된 예약(확정·승인 대기·이용 완료, 부분 환불로 취소된 예약 포함)은 그대로 둔다.
    if (booking.paymentState !== "UNPAID") return { ...base, action: "NONE" };
    const result = await finalizePaidBooking(booking.id, now);
    if (result.kind === "REFUNDED") return { ...base, action: "REFUNDED" };
    return { ...base, action: result.kind !== "CLOSED" && result.changed ? result.kind : "NONE" };
  }

  if (reconciled.state === "CANCELLED") {
    const cancelledOutside = payment.status === "CANCELLED" && payment.approvedAt !== null && booking.paymentState !== "UNPAID";
    if (cancelledOutside && (booking.status === "CONFIRMED" || booking.status === "PENDING_APPROVAL")) {
      await cancelBookingCore({
        bookingId: booking.id,
        by: "SYSTEM",
        reason: "결제가 결제사에서 취소되어 예약을 취소했어요",
        to: "CANCELLED",
        from: ["CONFIRMED", "PENDING_APPROVAL"],
        refund: "SETTLED",
        seats: "AUTO",
        releaseReason: "CANCELLATION",
        notify: "CANCELLED",
        now,
      });
      return { ...base, action: "CANCELLED" };
    }
    if (booking.status === "PENDING_PAYMENT" && booking.holdExpiresAt !== null && booking.holdExpiresAt.getTime() < now.getTime()) {
      const result = await expireBookingHold(booking.id, "TIMEOUT", now);
      if (result.outcome === "EXPIRED") {
        await afterHoldExpired(booking.id, result, { notifyCustomer: true });
        return { ...base, action: "EXPIRED" };
      }
    }
  }
  return { ...base, action: "NONE" };
}

/**
 * 주기 작업: 승인 도중 끊겼거나 결과를 확인하지 못한 결제를 결제사에 다시 조회해 예약을 확정하거나 환불·만료한다.
 * 결제는 승인됐는데 예약에 반영되지 않은 채 끝난 예약도 함께 정리한다(확정하거나 환불).
 * 처리한 건수를 돌려준다. 한 건이 실패해도 나머지는 계속 처리한다.
 */
export async function reconcileDuePayments(now: Date = new Date()): Promise<number> {
  const orderIds = await listPaymentsNeedingReconcile(JOB_BATCH);
  let checked = 0;
  for (const orderId of orderIds) {
    try {
      await syncBookingWithPayment(orderId);
      checked += 1;
    } catch (e) {
      console.error(`[booking] 결제 대사 실패 order=${orderId}`, e);
    }
  }
  return checked + (await settleOrphanPayments(now, JOB_BATCH));
}
