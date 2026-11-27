import "server-only";
import type { ActorType, BookingStatus } from "@/generated/prisma/client";
import { BOOKING_STATUS_LABEL, computeRefundRate, parseCancellationTiers } from "@/lib/domain";
import { formatKRW } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { prisma } from "@/server/db";
import { err } from "@/server/errors";
import { recalcCommissionForRetained, snapshotCommission } from "@/server/services/commission";
import { recordBookingEvent } from "@/server/services/crm";
import { releaseSeats, reserveSeats } from "@/server/services/inventory";
import { notify } from "@/server/services/notifications";
import {
  notificationLinks,
  onBookingCancelled,
  onBookingConfirmed,
  onBookingExpired,
  onBookingPendingApproval,
  onBookingRejected,
} from "@/server/services/notifications/events";
import { enqueueMessageDetailed } from "@/server/services/notifications/outbox";
import { getPaymentForBooking, markPaymentAbandoned } from "@/server/services/payments";
import { afterSeatsReleased, type SeatReleaseReason } from "@/server/services/vacancy";
import { getSettings, type PlatformSettings } from "@/server/settings";
import { evaluateGoConfirmation } from "./go";
import { settleResaleFor } from "./resale";
import {
  MSG_BOOKING_NOT_FOUND,
  MSG_STATE_CHANGED,
  isPaidOnline,
  isUniqueViolation,
  refundBookingPayment,
  runTx,
  safely,
  syncBookingPaymentState,
  type RefundOutcome,
  type Tx,
} from "./shared";

/**
 * 예약 상태 전이의 공통 구현 — 확정 뒤처리, 취소, 홀드 만료, 결제 완료 반영.
 * 고객·사업자·운영자·주기 작업·회차 취소가 모두 여기 함수를 거친다.
 *
 * 잠금 순서(교착 방지): Slot → Booking → SlotSeat. 결제 행은 예약 행을 잡은 뒤에만 건드린다.
 */

// ── 확정 뒤처리 ───────────────────────────────────────

/**
 * 예약이 CONFIRMED 가 된 직후(트랜잭션이 끝난 뒤) 경로와 상관없이 한 번 부른다. 예외를 던지지 않는다.
 * 고객 카드 반영 → 확정 알림 → 개최 확정 판정 → 재판매 환불 정산(직접 입력 예약 제외).
 */
export async function afterBookingConfirmed(bookingId: string, options: { approved?: boolean; notifyCustomer?: boolean } = {}): Promise<void> {
  await safely("확정 뒤처리", bookingId, async () => {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        businessId: true,
        userId: true,
        guestName: true,
        guestPhone: true,
        channel: true,
        totalAmount: true,
        createdAt: true,
        slotId: true,
        slot: { select: { startAt: true } },
      },
    });
    if (!booking) return;
    await safely("고객 카드 반영", bookingId, () => recordBookingEvent(booking, "BOOKED"));
    if (options.notifyCustomer !== false) await onBookingConfirmed(bookingId, { approved: options.approved });
    await evaluateGoConfirmation(booking.slotId);
    if (booking.channel !== "MANUAL") await safely("재판매 환불 정산", bookingId, () => settleResaleFor(bookingId));
  });
}

// ── 취소 ──────────────────────────────────────────────

export interface CancelBookingOptions {
  bookingId: string;
  by: ActorType;
  byId?: string | null;
  reason?: string | null;
  /** 바꿀 상태: 취소 또는 승인 거절 */
  to: "CANCELLED" | "REJECTED";
  /** 취소할 수 있는 현재 상태 */
  from: BookingStatus[];
  /**
   * FULL 전액 환불 · POLICY 예약 때 저장한 환불 기준 · amount 운영자가 정한 금액 ·
   * SETTLED 결제사에서 이미 전액 취소된 결제(환불을 다시 요청하지 않는다)
   */
  refund: "FULL" | "POLICY" | "SETTLED" | { amount: number };
  /** 좌석 반환: PUBLIC 바로 공개 · WITHHOLD 보류 · AUTO 사업자의 자동 재등록 설정에 따름 */
  seats: "PUBLIC" | "WITHHOLD" | "AUTO";
  /** 좌석 반환 뒤처리에 넘길 사유. null 이면 뒤처리를 하지 않는다(회차 취소) */
  releaseReason: SeatReleaseReason | null;
  /** 고객 알림: CANCELLED·REJECTED 는 기본 알림, slotCancelled 는 회차 취소 안내(사유 포함), NONE 은 보내지 않음 */
  notify: "CANCELLED" | "REJECTED" | "NONE" | { slotCancelled: string };
  now?: Date;
}

export interface CancelBookingResult {
  bookingId: string;
  previousStatus: BookingStatus;
  refundRate: number;
  refundAmount: number;
  refund: RefundOutcome;
  /** 재판매 연동 환불을 기다리는 좌석 수(없으면 0) */
  resalePendingQty: number;
  resaleRefundRate: number | null;
  /** 좌석이 보류(withheld)로 닫혔는지 */
  withheld: boolean;
}

const statusConflict = (status: BookingStatus) => err.conflict(`${BOOKING_STATUS_LABEL[status]} 상태의 예약이라 처리할 수 없어요.`);

/** 회차 취소 안내: 회원에게는 앱 알림 + 문자, 직접 입력 예약(비회원)에는 남긴 번호로 문자만 보낸다. */
async function notifySlotCancelled(bookingId: string, reason: string): Promise<void> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      code: true,
      userId: true,
      guestPhone: true,
      businessId: true,
      quantity: true,
      refundAmount: true,
      slotId: true,
      product: { select: { title: true } },
      business: { select: { name: true } },
      slot: { select: { startAt: true } },
    },
  });
  if (!booking) return;
  const what = `${booking.product.title} · ${fmtDateTime(booking.slot.startAt)} · ${booking.quantity}명`;
  const why = `사유: ${reason.trim().slice(0, 120)}`;
  const refund = booking.refundAmount > 0 ? `결제하신 ${formatKRW(booking.refundAmount)}은 전액 환불돼요.` : null;
  const key = `SLOT_CANCELLED:${booking.id}`;
  const text = ["[남는자리] 예약하신 회차가 취소됐어요.", `${booking.business.name} · ${what}`, why, refund, `예약번호 ${booking.code}`]
    .filter(Boolean)
    .join("\n");

  if (booking.userId) {
    await notify({
      userId: booking.userId,
      type: "SLOT_CANCELLED",
      title: "예약하신 회차가 취소됐어요",
      body: [what, why, refund].filter(Boolean).join("\n"),
      linkUrl: notificationLinks.customerBooking(booking.code),
      data: { bookingId: booking.id, code: booking.code, slotId: booking.slotId, refundAmount: booking.refundAmount },
      dedupeKey: key,
      // 고객이 헛걸음하지 않도록 수신 설정과 무관하게 보낸다.
      external: {
        channel: "SMS",
        templateKey: "PLATFORM_SLOT_CANCELLED",
        text,
        dedupeKey: key,
        businessId: booking.businessId,
        recipient: booking.guestPhone || undefined,
        essential: true,
      },
    });
    return;
  }
  if (!booking.guestPhone) return;
  await enqueueMessageDetailed({
    businessId: booking.businessId,
    channel: "SMS",
    recipient: booking.guestPhone,
    templateKey: "PLATFORM_SLOT_CANCELLED",
    body: text,
    dedupeKey: key,
  });
}

function decideRefund(
  options: CancelBookingOptions,
  booking: {
    payNowAmount: number;
    refundAmount: number;
    policySnapshot: unknown;
    confirmedAt: Date | null;
    createdAt: Date;
    slot: { startAt: Date };
  },
  paidOnline: boolean,
  settings: PlatformSettings,
  now: Date,
): { rate: number; amount: number } {
  const refundable = paidOnline ? booking.payNowAmount - booking.refundAmount : 0;
  if (options.refund === "FULL" || options.refund === "SETTLED") return { rate: 100, amount: refundable };
  if (options.refund === "POLICY") {
    const rate = computeRefundRate({
      tiers: parseCancellationTiers(booking.policySnapshot),
      startAt: booking.slot.startAt,
      bookedAt: booking.confirmedAt ?? booking.createdAt,
      now,
      graceMinutes: settings.cancelGraceMinutes,
      graceMinLeadMinutes: settings.cancelGraceMinLeadMinutes,
    });
    return { rate, amount: paidOnline ? Math.min(refundable, Math.floor((booking.payNowAmount * rate) / 100)) : 0 };
  }
  const amount = options.refund.amount;
  if (!Number.isInteger(amount) || amount < 0 || amount > refundable) {
    throw err.validation(
      refundable > 0 ? `환불 금액은 0원부터 ${formatKRW(refundable)}까지 정할 수 있어요.` : "온라인으로 결제한 금액이 없어 환불 금액을 정할 수 없어요.",
    );
  }
  return { rate: booking.payNowAmount > 0 && paidOnline ? Math.floor((amount * 100) / booking.payNowAmount) : 100, amount };
}

/**
 * 예약 취소·거절의 단일 구현.
 * 트랜잭션: 조건부 상태 전이(읽은 상태 그대로일 때만) + 환불율·환불액·수수료 재계산 기록 + 좌석 반환.
 * 트랜잭션 뒤: 결제사 환불 → 결제 상태 반영 → 늦은 취소 횟수·고객 카드 → 알림 → 좌석 반환 뒤처리.
 * 뒤처리는 실패해도 취소를 되돌리지 않는다(환불 실패는 FAILED 환불로 남는다).
 */
export async function cancelBookingCore(options: CancelBookingOptions): Promise<CancelBookingResult> {
  const now = options.now ?? new Date();
  const settings = await getSettings();
  const booking = await prisma.booking.findUnique({
    where: { id: options.bookingId },
    include: { slot: { select: { startAt: true, status: true } }, business: { select: { autoRelist: true } } },
  });
  if (!booking) throw err.notFound(MSG_BOOKING_NOT_FOUND);
  if (!options.from.includes(booking.status)) throw statusConflict(booking.status);

  const paidOnline = isPaidOnline(booking);
  const { rate, amount } = decideRefund(options, booking, paidOnline, settings, now);
  const totalRefund = booking.refundAmount + amount;
  const wasConfirmed = booking.status === "CONFIRMED";
  const byCustomer = options.by === "CUSTOMER";
  const resalePendingQty =
    byCustomer && options.to === "CANCELLED" && wasConfirmed && paidOnline && booking.resaleRefundRate !== null && booking.resaleRefundRate > rate
      ? booking.quantity
      : 0;
  const retained = paidOnline ? booking.payNowAmount - totalRefund : 0;
  const commission = recalcCommissionForRetained({
    rule: booking.commissionRule,
    bps: booking.commissionBps,
    quantity: booking.quantity,
    retainedTotal: retained,
    retainedOnline: retained,
    settings,
  });
  const withheld =
    booking.slot.status !== "CANCELLED" && (options.seats === "WITHHOLD" || (options.seats === "AUTO" && !booking.business.autoRelist));

  await runTx(async (tx) => {
    const updated = await tx.booking.updateMany({
      where: { id: booking.id, status: booking.status, refundAmount: booking.refundAmount },
      data: {
        status: options.to,
        cancelledBy: options.by,
        cancelledAt: now,
        cancelReason: options.reason?.trim().slice(0, 200) || null,
        refundRate: rate,
        refundAmount: totalRefund,
        resalePendingQty,
        commissionAmount: commission.commissionAmount,
        pgFeeAmount: commission.pgFeeAmount,
      },
    });
    if (updated.count !== 1) throw err.conflict(MSG_STATE_CHANGED);
    if (booking.status === "PENDING_PAYMENT") await closeUnpaidOrders(tx, booking.id);
    if (!(await releaseSeats(tx, booking.slotSeatId, booking.quantity, { withhold: withheld }))) {
      throw new Error(`좌석 재고와 예약이 어긋났습니다: booking=${booking.id}`);
    }
  });

  // ── 트랜잭션 뒤 ──
  let refund: RefundOutcome = { status: "NONE", amount: 0, refundId: null };
  if (options.refund === "SETTLED") {
    await safely("결제 상태 반영", booking.id, () => syncBookingPaymentState(booking.id));
    if (amount > 0) refund = { status: "DONE", amount, refundId: null };
  } else if (amount > 0) {
    refund = await refundBookingPayment({
      bookingId: booking.id,
      amount,
      reason: options.reason?.trim() || (options.to === "REJECTED" ? "예약 거절" : "예약 취소"),
      requestedBy: options.by,
      requestedById: options.byId ?? null,
    });
  }

  if (byCustomer && wasConfirmed) {
    if (rate < 100 && booking.userId) {
      const userId = booking.userId;
      await safely("늦은 취소 횟수", booking.id, () => prisma.user.updateMany({ where: { id: userId }, data: { lateCancelCount: { increment: 1 } } }));
    }
    // 고객 카드의 취소 수는 고객이 직접 취소한 건만 센다(사업장·운영 사정 취소는 고객의 이력이 아니다).
    await safely("고객 카드 반영", booking.id, () => recordBookingEvent(booking, "CANCELLED"));
  }

  if (options.notify === "CANCELLED") await onBookingCancelled(booking.id);
  else if (options.notify === "REJECTED") await onBookingRejected(booking.id);
  else if (options.notify !== "NONE") {
    const slotReason = options.notify.slotCancelled;
    await safely("회차 취소 알림", booking.id, () => notifySlotCancelled(booking.id, slotReason));
  }

  if (options.releaseReason) {
    await afterSeatsReleased(booking.slotSeatId, {
      reason: options.releaseReason,
      quantity: booking.quantity,
      withheld,
      excludeUserIds: booking.userId ? [booking.userId] : undefined,
    });
  }

  return {
    bookingId: booking.id,
    previousStatus: booking.status,
    refundRate: rate,
    refundAmount: amount,
    refund,
    resalePendingQty,
    resaleRefundRate: resalePendingQty > 0 ? booking.resaleRefundRate : null,
    withheld,
  };
}

/** 결제 전인 주문을 닫는다. 승인이 진행 중인 주문은 닫히지 않으며, 그 결제는 승인 뒤 확정 실패로 바로 환불된다. */
async function closeUnpaidOrders(tx: Tx, bookingId: string): Promise<void> {
  const orders = await tx.payment.findMany({ where: { bookingId, status: "READY" }, select: { orderId: true } });
  for (const order of orders) await markPaymentAbandoned(order.orderId, tx);
}

// ── 홀드 만료 ─────────────────────────────────────────

/**
 * EXPIRED: 만료하고 좌석을 반환했다 · SKIPPED: 이미 다른 상태이거나 아직 시간이 남았다 ·
 * PAYMENT_PAID: 결제가 승인돼 있어 만료하지 않았다(확정 처리 대상) ·
 * PAYMENT_UNKNOWN: 결제 승인이 진행 중이거나 결과를 몰라 만료하지 않았다(대사 대상)
 */
export type ExpireOutcome = "EXPIRED" | "SKIPPED" | "PAYMENT_PAID" | "PAYMENT_UNKNOWN";

export interface ExpireResult {
  outcome: ExpireOutcome;
  slotSeatId?: string;
  quantity?: number;
  userId?: string | null;
}

class HoldKept extends Error {
  constructor(readonly outcome: "PAYMENT_PAID" | "PAYMENT_UNKNOWN") {
    super(outcome);
  }
}

/**
 * 결제 대기 예약 한 건을 만료한다(좌석 반환·주문 닫기를 한 트랜잭션으로).
 * - TIMEOUT: 홀드 시간이 지난 예약만(주기 작업·예약 시점 회수)
 * - ABANDON: 고객이 결제를 그만둔 경우(시간과 무관, 고객이 그만둔 사실을 남겨 뒤늦은 결제로 되살리지 않는다)
 * 결제가 승인됐거나 승인 결과를 모르는 주문이 있으면 아무것도 바꾸지 않는다.
 * 좌석 반환 뒤처리와 알림은 호출한 쪽에서 한다.
 */
export async function expireBookingHold(bookingId: string, mode: "TIMEOUT" | "ABANDON", now: Date): Promise<ExpireResult> {
  try {
    return await runTx(async (tx): Promise<ExpireResult> => {
      const updated = await tx.booking.updateMany({
        where: { id: bookingId, status: "PENDING_PAYMENT", ...(mode === "TIMEOUT" ? { holdExpiresAt: { lt: now } } : {}) },
        data: { status: "EXPIRED", ...(mode === "ABANDON" ? { cancelledBy: "CUSTOMER" as const, cancelledAt: now } : {}) },
      });
      if (updated.count !== 1) return { outcome: "SKIPPED" };
      const booking = await tx.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { slotSeatId: true, quantity: true, userId: true },
      });
      const payments = await tx.payment.findMany({ where: { bookingId }, select: { orderId: true, status: true } });
      for (const payment of payments) {
        if (payment.status === "PAID" || payment.status === "PARTIAL_CANCELLED") throw new HoldKept("PAYMENT_PAID");
        if (payment.status === "READY" && !(await markPaymentAbandoned(payment.orderId, tx))) throw new HoldKept("PAYMENT_UNKNOWN");
      }
      if (!(await releaseSeats(tx, booking.slotSeatId, booking.quantity, { withhold: false }))) {
        throw new Error(`좌석 재고와 예약이 어긋났습니다: booking=${bookingId}`);
      }
      return { outcome: "EXPIRED", ...booking };
    });
  } catch (e) {
    if (e instanceof HoldKept) return { outcome: e.outcome };
    throw e;
  }
}

/** 만료 뒤처리: 좌석 반환 흐름(대기자·빈자리 알림)과 고객 알림. 고객이 직접 그만둔 경우에는 알림을 보내지 않는다. */
export async function afterHoldExpired(bookingId: string, result: ExpireResult, options: { notifyCustomer: boolean }): Promise<void> {
  if (result.outcome !== "EXPIRED" || !result.slotSeatId || !result.quantity) return;
  if (options.notifyCustomer) await onBookingExpired(bookingId);
  await afterSeatsReleased(result.slotSeatId, {
    reason: "EXPIRED",
    quantity: result.quantity,
    withheld: false,
    excludeUserIds: result.userId ? [result.userId] : undefined,
  });
}

/**
 * 홀드 시간이 지난 결제 대기 예약을 바로 회수한다(예약·조회 시점용 — 정합성을 주기 작업에 맡기지 않는다).
 * 회원 또는 좌석 유형으로 범위를 좁혀 부른다. 회수한 예약 수를 돌려준다.
 */
export async function reclaimExpiredHolds(scope: { userId: string } | { slotSeatId: string }, now: Date): Promise<number> {
  const stale = await prisma.booking.findMany({
    where: { ...scope, status: "PENDING_PAYMENT", holdExpiresAt: { lt: now } },
    select: { id: true },
    take: 20,
  });
  let reclaimed = 0;
  for (const { id } of stale) {
    const result = await expireBookingHold(id, "TIMEOUT", now);
    if (result.outcome !== "EXPIRED") continue;
    reclaimed += 1;
    await afterHoldExpired(id, result, { notifyCustomer: true });
  }
  return reclaimed;
}

// ── 결제 완료 반영 ────────────────────────────────────

export type FinalizeResult =
  /** 예약이 확정(또는 승인 대기)됐다. changed=false 면 이미 반영돼 있었다. */
  | { kind: "CONFIRMED" | "PENDING_APPROVAL"; changed: boolean }
  /** 예약을 확정할 수 없어 결제 금액을 전부 환불했다(환불 실패면 refund.status = FAILED). */
  | { kind: "REFUNDED"; refund: RefundOutcome }
  /** 결제가 반영된 뒤 이미 끝난 예약(취소 등)이라 할 일이 없다. */
  | { kind: "CLOSED" };

const SETTLED_STATUSES: BookingStatus[] = ["CONFIRMED", "PENDING_APPROVAL", "COMPLETED", "NO_SHOW"];

/** 결제가 이미 반영된 예약이면 그 결과를, 아직 반영 전(UNPAID)이면 null 을 돌려준다. */
function alreadyApplied(booking: { status: BookingStatus; paymentState: string }): FinalizeResult | null {
  if (booking.paymentState === "UNPAID") return null;
  if (!SETTLED_STATUSES.includes(booking.status)) return { kind: "CLOSED" };
  return { kind: booking.status === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : "CONFIRMED", changed: false };
}

class NotConfirmable extends Error {}

/**
 * 결제가 승인된(PAID) 예약을 확정한다. 결제 승인 직후, 웹훅·대사, 홀드 만료 작업이 함께 쓴다.
 * - PENDING_PAYMENT → CONFIRMED(승인제 상품은 PENDING_APPROVAL), 결제 상태 PAID, 확정이면 수수료 스냅샷
 * - EXPIRED(시간 초과로 풀린 예약)는 좌석을 다시 잡을 수 있을 때만 되살려 확정한다
 * - 결제가 아직 반영되지 않은 예약을 어떤 이유로든 확정하지 못하면 결제 금액을 바로 전액 환불한다
 * - 결제가 이미 반영된 예약은 건드리지 않는다(정책에 따라 일부만 환불된 취소 예약의 남은 금액을 돌려주지 않는다)
 * 확정되면 알림과 확정 뒤처리까지 여기서 한다.
 */
export async function finalizePaidBooking(bookingId: string, now: Date = new Date()): Promise<FinalizeResult> {
  const settings = await getSettings();
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { product: { select: { requiresApproval: true } } },
  });
  if (!booking) throw err.notFound(MSG_BOOKING_NOT_FOUND);
  const applied = alreadyApplied(booking);
  if (applied) return applied;

  const target = booking.product.requiresApproval ? "PENDING_APPROVAL" : "CONFIRMED";
  let confirmed = false;
  try {
    await runTx(async (tx) => {
      if (booking.status === "EXPIRED") {
        // 고객이 직접 그만둔 예약은 되살리지 않는다.
        if (booking.cancelledBy !== null) throw new NotConfirmable();
        const slots = await tx.$queryRaw<{ status: string; startAt: Date }[]>`
          SELECT "status"::text AS "status", "startAt" FROM "Slot" WHERE "id" = ${booking.slotId} FOR SHARE`;
        const slot = slots[0];
        if (!slot || slot.status !== "OPEN" || slot.startAt.getTime() <= now.getTime()) throw new NotConfirmable();
      } else if (booking.status !== "PENDING_PAYMENT") {
        throw new NotConfirmable();
      }
      const updated = await tx.booking.updateMany({
        where: { id: booking.id, status: booking.status, paymentState: "UNPAID" },
        data: { status: target, paymentState: "PAID", confirmedAt: target === "CONFIRMED" ? now : null },
      });
      if (updated.count !== 1) throw new NotConfirmable();
      if (booking.status === "EXPIRED" && !(await reserveSeats(tx, booking.slotSeatId, booking.quantity))) throw new NotConfirmable();
      if (target === "CONFIRMED") {
        const snap = await snapshotCommission(tx, booking, { settings, now });
        await tx.booking.update({
          where: { id: booking.id },
          data: {
            commissionRule: snap.rule,
            commissionBps: snap.bps,
            commissionAmount: snap.commissionAmount,
            pgFeeAmount: snap.pgFeeAmount,
            isNewCustomer: snap.isNewCustomer,
          },
        });
      }
    });
    confirmed = true;
  } catch (e) {
    // 되살리는 사이 같은 회차에 다른 예약이 생긴 경우(유니크 위반)도 확정할 수 없는 경우다.
    if (!(e instanceof NotConfirmable) && !isUniqueViolation(e)) console.error(`[booking] 결제 완료 반영 실패 id=${bookingId}`, e);
  }

  if (confirmed) {
    if (target === "CONFIRMED") await afterBookingConfirmed(booking.id);
    else await onBookingPendingApproval(booking.id);
    return { kind: target, changed: true };
  }

  // 같은 결제를 처리하던 다른 요청이 먼저 반영했을 수 있다.
  const latest = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true, paymentState: true } });
  return alreadyApplied(latest) ?? { kind: "REFUNDED", refund: await refundUnconfirmable(bookingId) };
}

/**
 * 확정하지 못한 예약의 결제 금액을 전부 돌려주고, 예약에 환불액과 결제 상태를 남긴다.
 * 환불이 실패하면 결제 상태는 PAID 로 남고 FAILED 환불이 운영자 콘솔에 보인다.
 */
async function refundUnconfirmable(bookingId: string): Promise<RefundOutcome> {
  let amount = 0;
  try {
    const payment = await getPaymentForBooking(bookingId);
    if (payment && (payment.status === "PAID" || payment.status === "PARTIAL_CANCELLED")) amount = payment.amount - payment.cancelledAmount;
  } catch (e) {
    console.error(`[booking] 환불할 결제 조회 실패 id=${bookingId}`, e);
  }
  const outcome = await refundBookingPayment({
    bookingId,
    amount,
    reason: "예약을 확정하지 못해 결제를 취소했어요",
    requestedBy: "SYSTEM",
  });
  if (amount > 0) {
    await safely("환불 기록", bookingId, async () => {
      await prisma.booking.updateMany({
        where: { id: bookingId, refundAmount: 0, payNowAmount: { gte: amount }, status: { in: ["PENDING_PAYMENT", "EXPIRED", "CANCELLED", "REJECTED"] } },
        data: { refundAmount: amount, refundRate: 100 },
      });
      await syncBookingPaymentState(bookingId);
    });
  }
  return outcome;
}

/**
 * 결제는 승인됐는데 예약에 반영되지 않은 채 끝난 예약(처리 도중 끊긴 경우)을 찾아 마저 처리한다(확정하거나 환불).
 * 결제 대사 작업이 함께 부른다. 처리한 건수를 돌려준다.
 */
export async function settleOrphanPayments(now: Date, limit: number): Promise<number> {
  const orphans = await prisma.payment.findMany({
    where: {
      status: { in: ["PAID", "PARTIAL_CANCELLED"] },
      booking: { paymentState: "UNPAID", status: { in: ["EXPIRED", "CANCELLED", "REJECTED"] } },
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { bookingId: true },
  });
  let settled = 0;
  for (const { bookingId } of orphans) {
    try {
      await finalizePaidBooking(bookingId, now);
      settled += 1;
    } catch (e) {
      console.error(`[booking] 반영되지 않은 결제 처리 실패 id=${bookingId}`, e);
    }
  }
  return settled;
}
