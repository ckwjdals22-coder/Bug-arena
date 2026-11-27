import "server-only";
import { formatKRW } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { prisma } from "@/server/db";
import { recalcCommissionForRetained } from "@/server/services/commission";
import { lockSeat } from "@/server/services/inventory";
import { notify } from "@/server/services/notifications";
import { notificationLinks } from "@/server/services/notifications/events";
import { getSettings } from "@/server/settings";
import { idSchema, parseInput, refundBookingPayment, runTx, safely, type RefundOutcome } from "./shared";

/**
 * 재판매 연동 환불(docs/02-architecture.md 6.4).
 * 환불율이 낮은 구간에 취소한 좌석이 시작 전에 다시 팔리면, 예약 때 저장해 둔 비율(resaleRefundRate)까지 더 돌려준다.
 *
 * "다시 팔렸다"의 기준: 같은 좌석 유형에서 새 예약(직접 입력 제외)이 확정된 뒤,
 *   unsold = capacity − reserved + withheld (아직 안 팔린 좌석: 빈자리 + 보류 좌석)
 *   P      = Σ resalePendingQty             (다시 팔리기를 기다리는 취소 좌석)
 *   매칭수량 = min(새 예약 수량, max(0, P − unsold))
 * 다른 빈자리가 남아 있거나 좌석이 보류 중인 동안에는 취소 좌석이 다시 팔린 것이 아니다.
 */

export interface ResaleSettlement {
  /** 추가 환불을 받는 취소 예약 */
  bookingId: string;
  matchedQty: number;
  extraAmount: number;
  refund: RefundOutcome;
}

interface PendingRow {
  id: string;
  quantity: number;
  payNowAmount: number;
  refundRate: number | null;
  refundAmount: number;
  resaleRefundRate: number | null;
  resalePendingQty: number;
  commissionRule: string | null;
  commissionBps: number;
}

interface Allocation {
  bookingId: string;
  matchedQty: number;
  extraAmount: number;
  totalRefund: number;
}

const RESALE_REFUND_REASON = "RESALE";

/** 추가 환불 안내(앱 + 문자). 같은 누적 환불액에 대해서는 한 번만 간다. */
async function notifyResaleRefund(allocation: Allocation): Promise<void> {
  const booking = await prisma.booking.findUnique({
    where: { id: allocation.bookingId },
    select: {
      id: true,
      code: true,
      userId: true,
      guestPhone: true,
      businessId: true,
      product: { select: { title: true } },
      slot: { select: { startAt: true } },
    },
  });
  if (!booking?.userId) return;
  const key = `RESALE_REFUND:${booking.id}:${allocation.totalRefund}`;
  const line = `취소하신 자리가 다시 예약되어 ${formatKRW(allocation.extraAmount)}을 더 돌려드려요.`;
  await notify({
    userId: booking.userId,
    type: "REFUND_DONE",
    title: "취소하신 자리가 다시 예약됐어요",
    body: `${line}\n${booking.product.title} · ${fmtDateTime(booking.slot.startAt)}\n결제 수단으로 돌려드리며, 카드사에 따라 영업일 기준 3~5일 걸릴 수 있어요.`,
    linkUrl: notificationLinks.customerBooking(booking.code),
    data: { bookingId: booking.id, code: booking.code, refundAmount: allocation.extraAmount, resale: true },
    dedupeKey: key,
    external: {
      channel: "SMS",
      templateKey: "PLATFORM_RESALE_REFUND",
      text: [`[남는자리] ${line}`, `${booking.product.title} · 예약번호 ${booking.code}`].join("\n"),
      dedupeKey: key,
      businessId: booking.businessId,
      recipient: booking.guestPhone || undefined,
    },
  });
}

/**
 * 새로 확정된 예약 한 건에 대해 재판매 매칭을 정산한다(예약 확정 직후 한 번, 직접 입력 예약 제외).
 * 한 트랜잭션에서: 새 예약을 점유(resaleMatchedAt)해 중복 매칭을 막고 → 좌석 행을 잠근 뒤 →
 * 취소가 빠른 건부터 매칭수량을 나눠 추가 환불액을 더하고 수수료를 남은 금액 기준으로 다시 계산한다.
 * 결제사 환불과 고객 알림은 트랜잭션이 끝난 뒤에 한다. 새 예약이 나중에 취소돼도 회수하지 않는다.
 */
export async function settleResaleFor(newBookingId: string): Promise<ResaleSettlement[]> {
  const bookingId = parseInput(idSchema, newBookingId);
  const settings = await getSettings();
  const now = new Date();

  const allocations = await runTx(async (tx): Promise<Allocation[]> => {
    const claimed = await tx.booking.updateMany({
      where: { id: bookingId, status: "CONFIRMED", resaleMatchedAt: null, channel: { not: "MANUAL" } },
      data: { resaleMatchedAt: now },
    });
    if (claimed.count !== 1) return [];
    const fresh = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { slotSeatId: true, quantity: true, slot: { select: { startAt: true, status: true } } },
    });
    // 회차가 시작됐거나 취소됐으면 재판매로 보지 않는다(남은 대기는 정리 작업이 0 으로 만든다).
    if (fresh.slot.status === "CANCELLED" || fresh.slot.startAt.getTime() <= now.getTime()) return [];

    const seat = await lockSeat(tx, fresh.slotSeatId);
    const pendings = await tx.$queryRaw<PendingRow[]>`
      SELECT "id", "quantity", "payNowAmount", "refundRate", "refundAmount", "resaleRefundRate", "resalePendingQty",
             "commissionRule", "commissionBps"
      FROM "Booking"
      WHERE "slotSeatId" = ${fresh.slotSeatId} AND "status" = 'CANCELLED' AND "resalePendingQty" > 0
      ORDER BY "cancelledAt" ASC, "id" ASC
      FOR UPDATE`;
    const pendingTotal = pendings.reduce((sum, row) => sum + Number(row.resalePendingQty), 0);
    const unsold = seat.capacity - seat.reserved + seat.withheld;
    let matched = Math.min(fresh.quantity, Math.max(0, pendingTotal - unsold));

    const result: Allocation[] = [];
    for (const row of pendings) {
      if (matched <= 0) break;
      const quantity = Number(row.quantity);
      const payNow = Number(row.payNowAmount);
      const refunded = Number(row.refundAmount);
      const n = Math.min(Number(row.resalePendingQty), matched);
      matched -= n;
      const rateGap = Math.max(0, Number(row.resaleRefundRate ?? 0) - Number(row.refundRate ?? 0));
      const totalRefund = Math.min(payNow, refunded + Math.floor((payNow * rateGap * n) / (100 * quantity)));
      const retained = payNow - totalRefund;
      const commission = recalcCommissionForRetained({
        rule: row.commissionRule,
        bps: Number(row.commissionBps),
        quantity,
        retainedTotal: retained,
        retainedOnline: retained,
        settings,
      });
      await tx.booking.update({
        where: { id: row.id },
        data: {
          resalePendingQty: { decrement: n },
          refundAmount: totalRefund,
          commissionAmount: commission.commissionAmount,
          pgFeeAmount: commission.pgFeeAmount,
        },
      });
      result.push({ bookingId: row.id, matchedQty: n, extraAmount: totalRefund - refunded, totalRefund });
    }
    return result;
  });

  const settlements: ResaleSettlement[] = [];
  for (const allocation of allocations) {
    const refund = await refundBookingPayment({
      bookingId: allocation.bookingId,
      amount: allocation.extraAmount,
      reason: RESALE_REFUND_REASON,
      requestedBy: "SYSTEM",
    });
    if (allocation.extraAmount > 0) await safely("재판매 환불 알림", allocation.bookingId, () => notifyResaleRefund(allocation));
    settlements.push({ bookingId: allocation.bookingId, matchedQty: allocation.matchedQty, extraAmount: allocation.extraAmount, refund });
  }
  return settlements;
}

/**
 * 주기 작업: 회차가 시작됐거나 취소된 예약의 재판매 환불 대기(resalePendingQty)를 0 으로 정리한다.
 * 정리한 예약 수를 돌려준다. 여러 번 실행해도 결과가 같다.
 */
export async function clearStaleResalePending(now: Date = new Date()): Promise<number> {
  const cleared = await prisma.booking.updateMany({
    where: { resalePendingQty: { gt: 0 }, slot: { OR: [{ startAt: { lte: now } }, { status: "CANCELLED" }] } },
    data: { resalePendingQty: 0 },
  });
  return cleared.count;
}
