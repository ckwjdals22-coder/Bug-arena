import "server-only";
import { fmtDateTime } from "@/lib/time";
import { prisma } from "@/server/db";
import { confirmedCountBySeat } from "@/server/services/inventory";
import { notify } from "@/server/services/notifications";
import { notificationLinks, notifyBusinessMembers } from "@/server/services/notifications/events";
import { safely } from "./shared";

/**
 * 개최 확정(docs/02-architecture.md 6.7).
 * 좌석 유형별 최소 확정 인원(minCount)을 모두 채우면 goConfirmedAt 을 기록한다. 한 번 확정되면 되돌리지 않는다.
 */

export type GoStateKind = "NONE" | "GATHERING" | "CONFIRMED";

export interface GoStateInfo {
  /** NONE 최소 인원 조건 없음 · GATHERING 모으는 중 · CONFIRMED 개최 확정 */
  state: GoStateKind;
  /** 모으는 중일 때 확정까지 더 필요한 인원(좌석 유형별) */
  needs: { seatId: string; label: string; remaining: number }[];
  /** 개최 여부를 판정하는 시각. 조건이 없으면 null */
  decideAt: Date | null;
}

export interface GoSlotInput {
  decideAt: Date | null;
  goConfirmedAt: Date | null;
  seats: { id: string; label: string; minCount: number }[];
}

/**
 * 화면에 보여 줄 개최 상태("확정까지 여성 1명"). 조회 없이 계산만 한다.
 * confirmedCounts 는 좌석 유형별 확정 인원(confirmedCountBySeat 의 결과 또는 같은 모양의 객체)이다.
 */
export function getGoState(slot: GoSlotInput, confirmedCounts: ReadonlyMap<string, number> | Readonly<Record<string, number>>): GoStateInfo {
  if (slot.seats.every((seat) => seat.minCount <= 0)) return { state: "NONE", needs: [], decideAt: null };
  // 개최 확정은 기록된 시각으로만 판단한다 — 확정 뒤에 취소가 나와도 되돌리지 않는다.
  if (slot.goConfirmedAt) return { state: "CONFIRMED", needs: [], decideAt: slot.decideAt };
  const countOf = (seatId: string) => (confirmedCounts instanceof Map ? confirmedCounts.get(seatId) : (confirmedCounts as Readonly<Record<string, number>>)[seatId]) ?? 0;
  const needs = slot.seats
    .filter((seat) => seat.minCount > countOf(seat.id))
    .map((seat) => ({ seatId: seat.id, label: seat.label, remaining: seat.minCount - countOf(seat.id) }));
  return { state: "GATHERING", needs, decideAt: slot.decideAt };
}

/** 개최 확정 알림: 확정 예약 고객(앱 + 문자)과 사업장 구성원(앱). 같은 회차에 대해 한 번만 간다. */
async function notifyGoConfirmed(slotId: string): Promise<void> {
  const slot = await prisma.slot.findUnique({
    where: { id: slotId },
    select: {
      id: true,
      startAt: true,
      businessId: true,
      product: { select: { title: true } },
      business: { select: { name: true } },
      bookings: {
        where: { status: "CONFIRMED", userId: { not: null } },
        select: { id: true, code: true, userId: true, guestPhone: true, quantity: true },
      },
    },
  });
  if (!slot) return;
  const what = `${slot.product.title} · ${fmtDateTime(slot.startAt)}`;

  for (const booking of slot.bookings) {
    if (!booking.userId) continue;
    const key = `SLOT_GO_CONFIRMED:${slot.id}:${booking.id}`;
    await notify({
      userId: booking.userId,
      type: "SLOT_GO_CONFIRMED",
      title: "개최가 확정됐어요",
      body: `${what}\n최소 인원이 모여 예정대로 열려요. ${slot.business.name}에서 만나요.`,
      linkUrl: notificationLinks.customerBooking(booking.code),
      data: { bookingId: booking.id, code: booking.code, slotId: slot.id },
      dedupeKey: key,
      external: {
        channel: "SMS",
        templateKey: "PLATFORM_SLOT_GO_CONFIRMED",
        text: [`[남는자리] 개최가 확정됐어요.`, `${slot.business.name} · ${what}`, `예약번호 ${booking.code}`].join("\n"),
        dedupeKey: key,
        businessId: slot.businessId,
        recipient: booking.guestPhone || undefined,
      },
    });
  }

  await notifyBusinessMembers(slot.businessId, {
    type: "SLOT_GO_CONFIRMED",
    title: "개최가 확정됐어요",
    body: `${what}\n최소 인원이 모였어요. 예약 고객에게도 알렸어요.`,
    linkUrl: notificationLinks.sellerSlot(slot.id),
    data: { slotId: slot.id },
    dedupeKey: `SLOT_GO_CONFIRMED:${slot.id}:seller`,
  });
}

/**
 * 개최 확정을 기록한다(조건부 UPDATE — 동시에 불려도 한 번만 성공한다).
 * 취소된 회차와 이미 확정된 회차는 바꾸지 않는다. 이번 호출로 확정됐으면 true.
 * silent 면 알림을 보내지 않는다(최소 인원 조건이 사라진 회차를 정리할 때).
 */
export async function markGoConfirmed(slotId: string, now: Date, options: { silent?: boolean } = {}): Promise<boolean> {
  const updated = await prisma.slot.updateMany({
    where: { id: slotId, goConfirmedAt: null, status: { not: "CANCELLED" } },
    data: { goConfirmedAt: now },
  });
  if (updated.count !== 1) return false;
  if (!options.silent) await safely("개최 확정 알림", slotId, () => notifyGoConfirmed(slotId));
  return true;
}

/** 회차의 좌석 유형이 모두 최소 확정 인원을 채웠는지. hasMinimum 은 최소 인원 조건이 하나라도 있는지 */
export async function readGoProgress(slotId: string): Promise<{ hasMinimum: boolean; met: boolean } | null> {
  const seats = await prisma.slotSeat.findMany({ where: { slotId }, select: { id: true, minCount: true } });
  if (seats.length === 0) return null;
  const hasMinimum = seats.some((seat) => seat.minCount > 0);
  if (!hasMinimum) return { hasMinimum, met: true };
  const counts = await confirmedCountBySeat(slotId);
  return { hasMinimum, met: seats.every((seat) => (counts.get(seat.id) ?? 0) >= seat.minCount) };
}

/**
 * 예약이 확정될 때마다(트랜잭션이 끝난 뒤) 부른다. 최소 인원 조건이 있고 아직 확정 전인 회차에서
 * 모든 좌석 유형이 최소 인원을 채웠으면 개최를 확정하고 알린다. 이번 호출로 확정됐으면 true.
 * 예외를 던지지 않는다.
 */
export async function evaluateGoConfirmation(slotId: string): Promise<boolean> {
  try {
    const slot = await prisma.slot.findUnique({ where: { id: slotId }, select: { status: true, goConfirmedAt: true } });
    if (!slot || slot.status === "CANCELLED" || slot.goConfirmedAt) return false;
    const progress = await readGoProgress(slotId);
    if (!progress || !progress.hasMinimum || !progress.met) return false;
    return await markGoConfirmed(slotId, new Date());
  } catch (e) {
    console.error(`[booking] 개최 확정 판정 실패 slot=${slotId}`, e);
    return false;
  }
}
