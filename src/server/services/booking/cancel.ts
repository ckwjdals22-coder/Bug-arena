import "server-only";
import { z } from "zod";
import type { BookingStatus, PaymentMethod, PaymentState } from "@/generated/prisma/client";
import { BOOKING_STATUS_LABEL, computeRefundRate, parseCancellationTiers } from "@/lib/domain";
import { DAY, HOUR, MINUTE } from "@/lib/time";
import { audit } from "@/server/audit";
import { assertBusinessAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { AppError, err } from "@/server/errors";
import { snapshotCommission } from "@/server/services/commission";
import { getSettings, type PlatformSettings } from "@/server/settings";
import { afterBookingConfirmed, cancelBookingCore } from "./lifecycle";
import { abandonBooking } from "./payment";
import {
  JOB_BATCH,
  MSG_BOOKING_NOT_FOUND,
  MSG_STATE_CHANGED,
  assertAdminRole,
  idSchema,
  isPaidOnline,
  optionalText,
  parseInput,
  reasonSchema,
  runTx,
  type AdminActor,
  type RefundOutcome,
} from "./shared";

/**
 * 예약 취소(고객·사업자·운영자)와 승인제 예약의 승인·거절.
 * 실제 상태 전이·환불·좌석 반환은 lifecycle.ts 의 cancelBookingCore 하나가 한다.
 */

/** 승인 대기를 자동으로 거절하는 기준: 예약 뒤 24시간이 지났거나 시작까지 2시간이 안 남았을 때 */
const APPROVAL_TIMEOUT_MS = DAY;
const APPROVAL_MIN_LEAD_MS = 2 * HOUR;
const AUTO_REJECT_REASON = "사업자가 기한 안에 확인하지 못해 자동 취소됐어요";

// ── 취소 미리보기 ─────────────────────────────────────

export interface CancellationPreview {
  status: BookingStatus;
  /** 지금 고객이 직접 취소할 수 있는지 */
  cancellable: boolean;
  /** 지금 취소하면 적용되는 환불율(%) */
  refundRate: number;
  /** 지금 취소하면 돌려받는 금액(온라인 결제분 기준, 현장 결제·무료 예약은 0) */
  refundAmount: number;
  /** 환불되지 않고 남는 금액 */
  retained: number;
  /** 이 시각까지 취소하면 전액 환불(예약 직후 무료 취소). 적용되지 않거나 지났으면 없다 */
  graceUntil?: Date;
  /** 취소한 자리가 시작 전에 다시 팔리면 이 비율까지, 최대 extraAmount 를 더 돌려받는다 */
  resale?: { rate: number; extraAmount: number };
}

export interface PreviewSource {
  status: BookingStatus;
  paymentMethod: PaymentMethod;
  paymentState: PaymentState;
  payNowAmount: number;
  refundAmount: number;
  policySnapshot: unknown;
  resaleRefundRate: number | null;
  confirmedAt: Date | null;
  createdAt: Date;
  slot: { startAt: Date };
}

type GraceSettings = Pick<PlatformSettings, "cancelGraceMinutes" | "cancelGraceMinLeadMinutes">;

/** 취소 확인 화면("지금 취소하면 ○원 환불")에 보여 줄 값. 조회 없이 계산만 한다. */
export function computeCancellationPreview(booking: PreviewSource, settings: GraceSettings, now: Date = new Date()): CancellationPreview {
  const paidOnline = isPaidOnline(booking);
  const refundable = paidOnline ? booking.payNowAmount - booking.refundAmount : 0;
  const beforeStart = now.getTime() < booking.slot.startAt.getTime();

  if (booking.status === "PENDING_PAYMENT" || booking.status === "PENDING_APPROVAL") {
    return { status: booking.status, cancellable: true, refundRate: 100, refundAmount: refundable, retained: 0 };
  }
  if (booking.status !== "CONFIRMED") {
    return { status: booking.status, cancellable: false, refundRate: 0, refundAmount: 0, retained: refundable };
  }

  const bookedAt = booking.confirmedAt ?? booking.createdAt;
  const refundRate = computeRefundRate({
    tiers: parseCancellationTiers(booking.policySnapshot),
    startAt: booking.slot.startAt,
    bookedAt,
    now,
    graceMinutes: settings.cancelGraceMinutes,
    graceMinLeadMinutes: settings.cancelGraceMinLeadMinutes,
  });
  const refundAmount = paidOnline ? Math.min(refundable, Math.floor((booking.payNowAmount * refundRate) / 100)) : 0;
  const preview: CancellationPreview = { status: booking.status, cancellable: beforeStart, refundRate, refundAmount, retained: refundable - refundAmount };

  const graceApplies =
    settings.cancelGraceMinutes > 0 && booking.slot.startAt.getTime() - bookedAt.getTime() >= settings.cancelGraceMinLeadMinutes * MINUTE;
  const graceUntil = new Date(Math.min(bookedAt.getTime() + settings.cancelGraceMinutes * MINUTE, booking.slot.startAt.getTime()));
  if (graceApplies && now.getTime() <= graceUntil.getTime() && beforeStart) preview.graceUntil = graceUntil;

  if (beforeStart && paidOnline && booking.resaleRefundRate !== null && booking.resaleRefundRate > refundRate) {
    preview.resale = {
      rate: booking.resaleRefundRate,
      extraAmount: Math.floor((booking.payNowAmount * (booking.resaleRefundRate - refundRate)) / 100),
    };
  }
  return preview;
}

const ownBookingSchema = z.object({ userId: idSchema, bookingId: idSchema });

/** 내 예약을 지금 취소하면 얼마를 돌려받는지 미리 보여 준다. */
export async function previewCancellation(input: { userId: string; bookingId: string }): Promise<CancellationPreview> {
  const data = parseInput(ownBookingSchema, input);
  const [booking, settings] = await Promise.all([
    prisma.booking.findUnique({ where: { id: data.bookingId }, include: { slot: { select: { startAt: true } } } }),
    getSettings(),
  ]);
  if (!booking || booking.userId !== data.userId) throw err.notFound(MSG_BOOKING_NOT_FOUND);
  return computeCancellationPreview(booking, settings);
}

// ── 고객 취소 ─────────────────────────────────────────

export interface CustomerCancelResult {
  refundRate: number;
  refundAmount: number;
  /** NONE 환불할 금액 없음 · DONE 환불 완료 · FAILED 환불이 지연되고 있음(운영자가 다시 처리한다) */
  refundStatus: RefundOutcome["status"];
  /** 재판매 연동 환불을 기다리는 경우: 자리가 다시 팔리면 이 비율까지 환불된다 */
  resaleRefundRate?: number;
}

const customerCancelSchema = ownBookingSchema.extend({ reason: optionalText(200, "취소 사유는 200자까지 쓸 수 있어요.") });

/**
 * 고객 취소.
 * - 결제 대기: 결제를 그만둔 것으로 처리한다(abandonBooking 과 같다).
 * - 승인 대기: 전액 환불.
 * - 확정(회차 시작 전): 예약 때 저장한 환불 기준 + 예약 직후 무료 취소 시간으로 환불율을 정한다.
 *   환불율이 재판매 연동 환불율보다 낮고 온라인 결제분이 있으면 재판매 환불 대기(resalePendingQty)를 건다.
 *   좌석은 사업자의 자동 재등록 설정에 따라 바로 공개하거나 보류한다.
 */
export async function cancelBookingByCustomer(input: { userId: string; bookingId: string; reason?: string | null }): Promise<CustomerCancelResult> {
  const data = parseInput(customerCancelSchema, input);
  const booking = await prisma.booking.findUnique({
    where: { id: data.bookingId },
    select: { id: true, userId: true, status: true, slot: { select: { startAt: true } } },
  });
  if (!booking || booking.userId !== data.userId) throw err.notFound(MSG_BOOKING_NOT_FOUND);

  if (booking.status === "PENDING_PAYMENT") {
    const abandoned = await abandonBooking({ userId: data.userId, bookingId: booking.id });
    if (!abandoned.released) throw err.conflict(MSG_STATE_CHANGED);
    return { refundRate: 100, refundAmount: 0, refundStatus: "NONE" };
  }
  if (booking.status !== "PENDING_APPROVAL" && booking.status !== "CONFIRMED") {
    throw err.conflict(`${BOOKING_STATUS_LABEL[booking.status]} 상태의 예약이라 취소할 수 없어요.`);
  }
  const now = new Date();
  if (booking.status === "CONFIRMED" && now.getTime() >= booking.slot.startAt.getTime()) {
    throw err.closed("이미 시작한 회차는 취소할 수 없어요. 도움이 필요하면 사업장에 문의해 주세요.");
  }

  const confirmed = booking.status === "CONFIRMED";
  const result = await cancelBookingCore({
    bookingId: booking.id,
    by: "CUSTOMER",
    byId: data.userId,
    reason: data.reason,
    to: "CANCELLED",
    from: [booking.status],
    refund: confirmed ? "POLICY" : "FULL",
    seats: confirmed ? "AUTO" : "PUBLIC",
    // 승인 전에 거둔 예약은 팔린 적 없는 자리라 취소석으로 표시하지 않는다.
    releaseReason: confirmed ? "CANCELLATION" : "REJECTED",
    notify: "CANCELLED",
    now,
  });
  return {
    refundRate: result.refundRate,
    refundAmount: result.refundAmount,
    refundStatus: result.refund.status,
    ...(result.resaleRefundRate !== null ? { resaleRefundRate: result.resaleRefundRate } : {}),
  };
}

// ── 사업자 ────────────────────────────────────────────

const sellerSelect = {
  id: true,
  businessId: true,
  status: true,
  channel: true,
  slot: { select: { startAt: true, endAt: true, status: true } },
} as const;

async function loadForSeller(actorUserId: string, bookingId: string, minRole: "STAFF" | "MANAGER") {
  const booking = await prisma.booking.findUnique({ where: { id: parseInput(idSchema, bookingId) }, select: sellerSelect });
  if (!booking) throw err.notFound(MSG_BOOKING_NOT_FOUND);
  await assertBusinessAccess(actorUserId, booking.businessId, minRole);
  return booking;
}

export interface SellerCancelResult {
  refundAmount: number;
  refundStatus: RefundOutcome["status"];
  /** 좌석이 보류로 닫혔는지(다시 올리려면 relistSeats) */
  withheld: boolean;
}

/**
 * 승인제 예약 승인(매니저 이상): PENDING_APPROVAL → CONFIRMED, 수수료 스냅샷, 확정 뒤처리.
 * 취소됐거나 이미 시작한 회차의 예약은 승인할 수 없다(거절하면 전액 환불된다).
 */
export async function approveBooking(actorUserId: string, bookingId: string): Promise<{ status: "CONFIRMED" }> {
  const booking = await loadForSeller(actorUserId, bookingId, "MANAGER");
  if (booking.status !== "PENDING_APPROVAL") throw err.conflict(`${BOOKING_STATUS_LABEL[booking.status]} 상태의 예약이라 승인할 수 없어요.`);
  const now = new Date();
  if (booking.slot.status === "CANCELLED" || booking.slot.startAt.getTime() <= now.getTime()) {
    throw err.closed("이미 시작했거나 취소된 회차라 승인할 수 없어요. 거절하면 전액 환불돼요.");
  }
  const settings = await getSettings();

  await runTx(async (tx) => {
    const updated = await tx.booking.updateMany({ where: { id: booking.id, status: "PENDING_APPROVAL" }, data: { status: "CONFIRMED", confirmedAt: now } });
    if (updated.count !== 1) throw err.conflict(MSG_STATE_CHANGED);
    const row = await tx.booking.findUniqueOrThrow({ where: { id: booking.id } });
    const snap = await snapshotCommission(tx, row, { settings, now });
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
  });

  await audit({ actorId: actorUserId, actorType: "SELLER", action: "booking.approve", targetType: "Booking", targetId: booking.id });
  await afterBookingConfirmed(booking.id, { approved: true });
  return { status: "CONFIRMED" };
}

/** 승인제 예약 거절(매니저 이상): PENDING_APPROVAL → REJECTED, 전액 환불, 좌석은 바로 다시 공개된다. */
export async function rejectBooking(actorUserId: string, bookingId: string, reason?: string | null): Promise<SellerCancelResult> {
  const booking = await loadForSeller(actorUserId, bookingId, "MANAGER");
  const why = parseInput(optionalText(200, "거절 사유는 200자까지 쓸 수 있어요."), reason);
  const result = await cancelBookingCore({
    bookingId: booking.id,
    by: "SELLER",
    byId: actorUserId,
    reason: why,
    to: "REJECTED",
    from: ["PENDING_APPROVAL"],
    refund: "FULL",
    seats: "PUBLIC",
    releaseReason: "REJECTED",
    notify: "REJECTED",
  });
  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "booking.reject",
    targetType: "Booking",
    targetId: booking.id,
    meta: { refundAmount: result.refundAmount, refundStatus: result.refund.status },
  });
  return { refundAmount: result.refundAmount, refundStatus: result.refund.status, withheld: result.withheld };
}

/**
 * 사업자 취소(매니저 이상): 확정 예약을 사업장 사정으로 취소한다. 항상 전액 환불이고 사유가 필요하다.
 * 좌석은 보류로 닫힌다(사업자가 일부러 취소한 자리이므로, 다시 팔려면 relistSeats 로 올린다).
 * 고객 예약은 회차 시작 전까지만 취소할 수 있다. 직접 입력 예약은 회차가 끝나기 전까지 고칠 수 있다.
 */
export async function cancelBookingBySeller(actorUserId: string, bookingId: string, reason: string): Promise<SellerCancelResult> {
  const booking = await loadForSeller(actorUserId, bookingId, "MANAGER");
  const why = parseInput(reasonSchema(200), reason);
  if (booking.status === "PENDING_APPROVAL") throw err.conflict("승인 대기 중인 예약은 거절로 처리해 주세요. 전액 환불돼요.");
  if (booking.status !== "CONFIRMED") throw err.conflict(`${BOOKING_STATUS_LABEL[booking.status]} 상태의 예약이라 취소할 수 없어요.`);
  const now = new Date();
  const limit = booking.channel === "MANUAL" ? booking.slot.endAt : booking.slot.startAt;
  if (now.getTime() >= limit.getTime()) {
    throw err.closed(
      booking.channel === "MANUAL" ? "이미 끝난 회차의 예약은 취소할 수 없어요." : "이미 시작한 회차의 예약은 취소할 수 없어요. 환불이 필요하면 고객센터로 문의해 주세요.",
    );
  }

  const result = await cancelBookingCore({
    bookingId: booking.id,
    by: "SELLER",
    byId: actorUserId,
    reason: why,
    to: "CANCELLED",
    from: ["CONFIRMED"],
    refund: "FULL",
    seats: "WITHHOLD",
    releaseReason: "CANCELLATION",
    notify: "CANCELLED",
    now,
  });
  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "booking.cancel_by_seller",
    targetType: "Booking",
    targetId: booking.id,
    meta: { refundAmount: result.refundAmount, refundStatus: result.refund.status },
  });
  return { refundAmount: result.refundAmount, refundStatus: result.refund.status, withheld: result.withheld };
}

// ── 운영자 ────────────────────────────────────────────

const adminCancelSchema = z.object({
  reason: reasonSchema(200),
  refundAmount: z
    .number("환불 금액을 숫자로 입력해 주세요.")
    .int("환불 금액은 원 단위 정수로 입력해 주세요.")
    .min(0, "환불 금액은 0원 이상이어야 해요.")
    .max(1_000_000_000, "환불 금액을 확인해 주세요.")
    .optional(),
});

export interface AdminCancelResult {
  refundRate: number;
  refundAmount: number;
  refundStatus: RefundOutcome["status"];
}

/**
 * 운영자 취소(CS·SUPER). 결제 대기·승인 대기·확정 예약을 취소한다.
 * 환불액을 주지 않으면 전액 환불, 주면 그 금액만 환불한다(0원 ~ 온라인 결제액 − 이미 환불한 금액).
 * 사유와 금액은 감사 로그에 남는다.
 */
export async function cancelBookingByAdmin(admin: AdminActor, bookingId: string, input: { reason: string; refundAmount?: number }): Promise<AdminCancelResult> {
  await assertAdminRole(admin, ["CS"]);
  const id = parseInput(idSchema, bookingId);
  const data = parseInput(adminCancelSchema, input);
  const booking = await prisma.booking.findUnique({ where: { id }, select: { status: true } });
  if (!booking) throw err.notFound(MSG_BOOKING_NOT_FOUND);

  const result = await cancelBookingCore({
    bookingId: id,
    by: "ADMIN",
    byId: admin.id,
    reason: data.reason,
    to: "CANCELLED",
    from: ["PENDING_PAYMENT", "PENDING_APPROVAL", "CONFIRMED"],
    refund: data.refundAmount === undefined ? "FULL" : { amount: data.refundAmount },
    seats: "AUTO",
    releaseReason: booking.status === "CONFIRMED" ? "CANCELLATION" : "REJECTED",
    notify: "CANCELLED",
  });
  await audit({
    actorId: admin.id,
    actorType: "ADMIN",
    action: "booking.cancel_by_admin",
    targetType: "Booking",
    targetId: id,
    meta: { reason: data.reason, refundAmount: result.refundAmount, refundStatus: result.refund.status, previousStatus: result.previousStatus },
  });
  return { refundRate: result.refundRate, refundAmount: result.refundAmount, refundStatus: result.refund.status };
}

// ── 주기 작업 ─────────────────────────────────────────

/**
 * 주기 작업: 사업자가 기한 안에 확인하지 않은 승인 대기 예약을 자동으로 거절하고 전액 환불한다.
 * 기준: 예약한 지 24시간이 지났거나, 회차 시작까지 2시간이 안 남았을 때. 처리한 건수를 돌려준다.
 * 동시에 여러 번 실행돼도 예약마다 한 번만 처리된다.
 */
export async function expireStaleApprovals(now: Date = new Date()): Promise<number> {
  const stale = await prisma.booking.findMany({
    where: {
      status: "PENDING_APPROVAL",
      OR: [{ createdAt: { lt: new Date(now.getTime() - APPROVAL_TIMEOUT_MS) } }, { slot: { startAt: { lt: new Date(now.getTime() + APPROVAL_MIN_LEAD_MS) } } }],
    },
    orderBy: { createdAt: "asc" },
    take: JOB_BATCH,
    select: { id: true },
  });
  let rejected = 0;
  for (const { id } of stale) {
    try {
      await cancelBookingCore({
        bookingId: id,
        by: "SYSTEM",
        reason: AUTO_REJECT_REASON,
        to: "REJECTED",
        from: ["PENDING_APPROVAL"],
        refund: "FULL",
        seats: "PUBLIC",
        releaseReason: "REJECTED",
        notify: "REJECTED",
        now,
      });
      rejected += 1;
    } catch (e) {
      // 같은 작업이 동시에 돌았거나 그사이 사업자가 처리한 건은 건너뛴다.
      if (!(e instanceof AppError)) console.error(`[booking] 승인 대기 자동 거절 실패 id=${id}`, e);
    }
  }
  return rejected;
}
