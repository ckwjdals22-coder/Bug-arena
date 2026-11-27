import "server-only";
import { z } from "zod";
import type { BookingStatus } from "@/generated/prisma/client";
import { BOOKING_STATUS_LABEL } from "@/lib/domain";
import { DAY, HOUR, fmtDateTime } from "@/lib/time";
import { audit } from "@/server/audit";
import { assertBusinessAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { err } from "@/server/errors";
import { recordBookingEvent } from "@/server/services/crm";
import { notify } from "@/server/services/notifications";
import { notificationLinks, sendReviewRequest } from "@/server/services/notifications/events";
import { getSettings, type PlatformSettings } from "@/server/settings";
import {
  JOB_BATCH,
  MSG_BOOKING_NOT_FOUND,
  MSG_STATE_CHANGED,
  assertAdminRole,
  idSchema,
  parseInput,
  reasonSchema,
  runTx,
  safely,
  type AdminActor,
} from "./shared";

/**
 * 참석 확인·체크인·노쇼·자동 완료(docs/02-architecture.md 6.8).
 */

/** 체크인할 수 있는 시간: 시작 3시간 전부터 종료 3시간 뒤까지 */
const CHECKIN_WINDOW_MS = 3 * HOUR;
/** 사업자가 노쇼를 되돌릴 수 있는 시간 */
const NO_SHOW_REVERT_MS = 48 * HOUR;
/** 고객이 노쇼에 이의를 제기할 수 있는 시간(안내 문구용) */
const NO_SHOW_APPEAL_HOURS = 72;

const crmSelect = {
  id: true,
  code: true,
  businessId: true,
  userId: true,
  guestName: true,
  guestPhone: true,
  channel: true,
  totalAmount: true,
  createdAt: true,
  slot: { select: { startAt: true, endAt: true } },
} as const;

// ── 참석 확정 ─────────────────────────────────────────

/** 리마인드에서 고객이 '참석 확정'을 눌렀을 때. 확정 예약이고 시작 전일 때만 기록하며, 다시 눌러도 처음 시각을 유지한다. */
export async function confirmAttendance(input: { userId: string; bookingId: string }): Promise<{ attendanceConfirmedAt: Date }> {
  const data = parseInput(z.object({ userId: idSchema, bookingId: idSchema }), input);
  const booking = await prisma.booking.findUnique({
    where: { id: data.bookingId },
    select: { id: true, userId: true, status: true, attendanceConfirmedAt: true, slot: { select: { startAt: true } } },
  });
  if (!booking || booking.userId !== data.userId) throw err.notFound(MSG_BOOKING_NOT_FOUND);
  if (booking.status !== "CONFIRMED") throw err.conflict(`${BOOKING_STATUS_LABEL[booking.status]} 상태의 예약이라 참석을 확정할 수 없어요.`);
  const now = new Date();
  if (now.getTime() >= booking.slot.startAt.getTime()) throw err.closed("이미 시작한 회차예요. 현장에서 체크인해 주세요.");
  if (booking.attendanceConfirmedAt) return { attendanceConfirmedAt: booking.attendanceConfirmedAt };

  await prisma.booking.updateMany({ where: { id: booking.id, status: "CONFIRMED", attendanceConfirmedAt: null }, data: { attendanceConfirmedAt: now } });
  const latest = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id }, select: { attendanceConfirmedAt: true } });
  if (!latest.attendanceConfirmedAt) throw err.conflict(MSG_STATE_CHANGED);
  return { attendanceConfirmedAt: latest.attendanceConfirmedAt };
}

// ── 체크인 ────────────────────────────────────────────

const checkInSchema = z.object({
  businessId: idSchema,
  codeOrToken: z.string("예약번호를 입력해 주세요.").trim().min(4, "예약번호를 확인해 주세요.").max(100, "예약번호를 확인해 주세요."),
});

export interface CheckInResult {
  bookingId: string;
  code: string;
  guestName: string;
  quantity: number;
  seatLabel: string;
  checkedInAt: Date;
  /** 현장에서 받을 금액(현장 결제·예약금 잔액). 받을 것이 없으면 0 */
  payOnsiteAmount: number;
}

const alreadyCheckedIn = (at: Date | null) => err.conflict(at ? `이미 ${fmtDateTime(at)}에 체크인한 예약이에요.` : "이미 이용 완료로 처리된 예약이에요.");

/**
 * 체크인(스태프 이상). 예약번호(대소문자 무관) 또는 QR 의 체크인 토큰으로 찾는다.
 * 그 사업장의 확정 예약이어야 하고, 시작 3시간 전부터 종료 3시간 뒤까지만 가능하다.
 * 성공하면 COMPLETED(이용 완료)가 되고 고객 카드에 반영된다. 이미 체크인했으면 그 시각을 알려 주는 CONFLICT.
 */
export async function checkInBooking(actorUserId: string, input: { businessId: string; codeOrToken: string }): Promise<CheckInResult> {
  const data = parseInput(checkInSchema, input);
  await assertBusinessAccess(actorUserId, data.businessId, "STAFF");

  const booking = await prisma.booking.findFirst({
    where: { businessId: data.businessId, OR: [{ code: data.codeOrToken.toUpperCase() }, { checkinToken: data.codeOrToken }] },
    select: {
      ...crmSelect,
      status: true,
      quantity: true,
      payOnsiteAmount: true,
      paymentMethod: true,
      paymentState: true,
      checkedInAt: true,
      slotSeat: { select: { label: true } },
    },
  });
  // 다른 사업장의 예약은 없는 것으로 답한다.
  if (!booking) throw err.notFound("예약을 찾을 수 없어요. 예약번호를 다시 확인해 주세요.");
  if (booking.status === "COMPLETED") throw alreadyCheckedIn(booking.checkedInAt);
  if (booking.status !== "CONFIRMED") throw err.conflict(`${BOOKING_STATUS_LABEL[booking.status]} 상태의 예약이라 체크인할 수 없어요.`);

  const now = new Date();
  if (now.getTime() < booking.slot.startAt.getTime() - CHECKIN_WINDOW_MS) {
    throw err.validation(`체크인은 시작 3시간 전부터 할 수 있어요. 이 예약은 ${fmtDateTime(booking.slot.startAt)}에 시작해요.`);
  }
  if (now.getTime() > booking.slot.endAt.getTime() + CHECKIN_WINDOW_MS) {
    throw err.closed("체크인할 수 있는 시간이 지났어요. 종료 3시간 뒤까지만 체크인할 수 있어요.");
  }

  const updated = await prisma.booking.updateMany({
    where: { id: booking.id, status: "CONFIRMED" },
    data: { status: "COMPLETED", checkedInAt: now, completedAt: now },
  });
  if (updated.count !== 1) {
    const latest = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id }, select: { status: true, checkedInAt: true } });
    if (latest.status === "COMPLETED") throw alreadyCheckedIn(latest.checkedInAt);
    throw err.conflict(MSG_STATE_CHANGED);
  }
  await safely("고객 카드 반영", booking.id, () => recordBookingEvent(booking, "COMPLETED"));

  return {
    bookingId: booking.id,
    code: booking.code,
    guestName: booking.guestName,
    quantity: booking.quantity,
    seatLabel: booking.slotSeat.label,
    checkedInAt: now,
    // 직접 입력 예약에서 이미 받았다고 표시한 현장 결제분은 다시 받지 않는다.
    payOnsiteAmount: booking.paymentMethod === "ONSITE" && booking.paymentState === "PAID" ? 0 : booking.payOnsiteAmount,
  };
}

// ── 노쇼 ──────────────────────────────────────────────

type NoShowSettings = Pick<PlatformSettings, "noShowLimit" | "noShowWindowDays" | "noShowRestrictDays">;

export interface NoShowResult {
  /** 회차가 아직 끝나지 않아 그 자리를 노쇼 공석으로 다시 올릴 수 있는지 */
  canRelist: boolean;
  /** 최근 기간 안의 노쇼 횟수(이번 건 포함). 회원 예약이 아니면 0 */
  recentNoShows: number;
  /** 이번 처리로 걸린(또는 유지되는) 예약 제한 기한 */
  restrictedUntil: Date | null;
}

async function notifyNoShow(
  booking: { id: string; code: string; userId: string | null; slot: { startAt: Date } },
  productTitle: string,
  recent: number,
  restrictedUntil: Date | null,
  settings: NoShowSettings,
): Promise<void> {
  if (!booking.userId) return;
  const what = `${productTitle} · ${fmtDateTime(booking.slot.startAt)}`;
  const count = `최근 ${settings.noShowWindowDays}일 동안 노쇼 ${recent}회예요.`;
  const next = restrictedUntil
    ? `노쇼가 ${settings.noShowLimit}회에 이르러 ${fmtDateTime(restrictedUntil)}까지 새 예약이 제한돼요. 이미 확정된 예약은 그대로 이용할 수 있어요.`
    : `${settings.noShowLimit}회가 되면 ${settings.noShowRestrictDays}일 동안 새 예약이 제한돼요.`;
  const appeal = `참석하셨거나 사정이 있었다면 ${NO_SHOW_APPEAL_HOURS}시간 안에 예약 내역에서 이의를 제기해 주세요.`;
  await notify({
    userId: booking.userId,
    type: "NO_SHOW_NOTICE",
    title: restrictedUntil ? "노쇼가 누적되어 예약이 제한됐어요" : "노쇼로 처리된 예약이 있어요",
    body: [what, count, next, appeal].join("\n"),
    linkUrl: notificationLinks.customerBooking(booking.code),
    data: { bookingId: booking.id, code: booking.code, recentNoShows: recent, restrictedUntil: restrictedUntil ? restrictedUntil.toISOString() : null },
    dedupeKey: `NO_SHOW_NOTICE:${booking.id}:${recent}`,
  });
}

/**
 * 노쇼 처리(스태프 이상). 확정 예약이고 회차가 시작된 뒤에만 가능하다. 환불은 없다.
 * 회원 예약이면 노쇼 횟수를 올리고, 최근 noShowWindowDays 안의 노쇼가 noShowLimit 에 이르면
 * noShowRestrictDays 동안 새 예약을 제한한다(영구 정지는 하지 않는다). 고객에게 횟수·이의제기 방법·다음 단계를 알린다.
 */
export async function markNoShow(actorUserId: string, bookingId: string): Promise<NoShowResult> {
  const id = parseInput(idSchema, bookingId);
  const booking = await prisma.booking.findUnique({ where: { id }, select: { ...crmSelect, status: true, product: { select: { title: true } } } });
  if (!booking) throw err.notFound(MSG_BOOKING_NOT_FOUND);
  await assertBusinessAccess(actorUserId, booking.businessId, "STAFF");
  if (booking.status !== "CONFIRMED") throw err.conflict(`${BOOKING_STATUS_LABEL[booking.status]} 상태의 예약이라 노쇼로 처리할 수 없어요.`);
  const now = new Date();
  if (now.getTime() < booking.slot.startAt.getTime()) throw err.validation("노쇼는 회차가 시작된 뒤에 처리할 수 있어요.");
  const settings = await getSettings();

  const outcome = await runTx(async (tx) => {
    const updated = await tx.booking.updateMany({ where: { id, status: "CONFIRMED" }, data: { status: "NO_SHOW", noShowAt: now } });
    if (updated.count !== 1) throw err.conflict(MSG_STATE_CHANGED);
    if (!booking.userId) return { recent: 0, restrictedUntil: null as Date | null };
    // 같은 회원의 노쇼 처리는 줄 세워 횟수와 제한을 정확히 계산한다.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${booking.userId} FOR UPDATE`;
    const recent = await tx.booking.count({
      where: { userId: booking.userId, status: "NO_SHOW", noShowAt: { gte: new Date(now.getTime() - settings.noShowWindowDays * DAY) } },
    });
    const user = await tx.user.findUniqueOrThrow({ where: { id: booking.userId }, select: { bookingRestrictedUntil: true } });
    let restrictedUntil = user.bookingRestrictedUntil && user.bookingRestrictedUntil.getTime() > now.getTime() ? user.bookingRestrictedUntil : null;
    if (recent >= settings.noShowLimit) {
      const until = new Date(now.getTime() + settings.noShowRestrictDays * DAY);
      if (!restrictedUntil || restrictedUntil.getTime() < until.getTime()) restrictedUntil = until;
    }
    await tx.user.update({
      where: { id: booking.userId },
      data: { noShowCount: { increment: 1 }, ...(recent >= settings.noShowLimit ? { bookingRestrictedUntil: restrictedUntil } : {}) },
    });
    return { recent, restrictedUntil: recent >= settings.noShowLimit ? restrictedUntil : null };
  });

  await safely("고객 카드 반영", id, () => recordBookingEvent(booking, "NO_SHOW"));
  await safely("노쇼 안내", id, () => notifyNoShow(booking, booking.product.title, outcome.recent, outcome.restrictedUntil, settings));
  return { canRelist: now.getTime() < booking.slot.endAt.getTime(), recentNoShows: outcome.recent, restrictedUntil: outcome.restrictedUntil };
}

/**
 * 노쇼 되돌리기의 공통 구현: NO_SHOW → COMPLETED(체크인한 것으로), 회원의 노쇼 횟수를 내리고,
 * 남은 노쇼로는 제한 기준에 못 미치면 예약 제한을 푼다.
 */
async function revertNoShowCore(bookingId: string, actor: { type: "SELLER" | "ADMIN"; id: string }, timeLimitMs: number | null): Promise<{ status: BookingStatus }> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: { ...crmSelect, status: true, noShowAt: true, product: { select: { title: true } } } });
  if (!booking) throw err.notFound(MSG_BOOKING_NOT_FOUND);
  if (actor.type === "SELLER") await assertBusinessAccess(actor.id, booking.businessId, "STAFF");
  if (booking.status !== "NO_SHOW") throw err.conflict(`${BOOKING_STATUS_LABEL[booking.status]} 상태의 예약이라 노쇼를 되돌릴 수 없어요.`);
  const now = new Date();
  if (timeLimitMs !== null && booking.noShowAt && now.getTime() - booking.noShowAt.getTime() > timeLimitMs) {
    throw err.closed("노쇼는 처리한 뒤 48시간 안에만 되돌릴 수 있어요. 그 뒤에는 고객센터로 문의해 주세요.");
  }
  const settings = await getSettings();

  await runTx(async (tx) => {
    const updated = await tx.booking.updateMany({
      where: { id: bookingId, status: "NO_SHOW" },
      data: { status: "COMPLETED", noShowAt: null, checkedInAt: booking.noShowAt ?? now, completedAt: now },
    });
    if (updated.count !== 1) throw err.conflict(MSG_STATE_CHANGED);
    if (!booking.userId) return;
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${booking.userId} FOR UPDATE`;
    const remaining = await tx.booking.count({
      where: { userId: booking.userId, status: "NO_SHOW", noShowAt: { gte: new Date(now.getTime() - settings.noShowWindowDays * DAY) } },
    });
    await tx.$executeRaw`
      UPDATE "User" SET "noShowCount" = GREATEST("noShowCount" - 1, 0), "updatedAt" = ${now}::timestamp WHERE "id" = ${booking.userId}`;
    if (remaining < settings.noShowLimit) await tx.user.updateMany({ where: { id: booking.userId, bookingRestrictedUntil: { not: null } }, data: { bookingRestrictedUntil: null } });
  });

  await safely("고객 카드 반영", bookingId, async () => {
    await recordBookingEvent(booking, "NO_SHOW_REVERTED");
    await recordBookingEvent(booking, "COMPLETED");
  });
  if (booking.userId) {
    const userId = booking.userId;
    await safely("노쇼 취소 안내", bookingId, () =>
      notify({
        userId,
        type: "NO_SHOW_NOTICE",
        title: "노쇼 처리가 취소됐어요",
        body: `${booking.product.title} · ${fmtDateTime(booking.slot.startAt)}\n이용 완료로 바로잡았어요. 노쇼 횟수에서도 빠졌어요.`,
        linkUrl: notificationLinks.customerBooking(booking.code),
        data: { bookingId: booking.id, code: booking.code, reverted: true },
        dedupeKey: `NO_SHOW_REVERTED:${booking.id}:${booking.noShowAt?.getTime() ?? 0}`,
      }),
    );
  }
  return { status: "COMPLETED" };
}

/** 사업자가 노쇼를 되돌린다(스태프 이상, 처리 뒤 48시간 안). 이용 완료(체크인)로 바뀐다. */
export async function revertNoShow(actorUserId: string, bookingId: string): Promise<{ status: BookingStatus }> {
  return revertNoShowCore(parseInput(idSchema, bookingId), { type: "SELLER", id: actorUserId }, NO_SHOW_REVERT_MS);
}

/** 운영자가 이의제기를 받아들여 노쇼를 되돌린다(CS·SUPER, 기한 없음). 사유는 감사 로그에 남는다. */
export async function adminRevertNoShow(admin: AdminActor, bookingId: string, reason: string): Promise<{ status: BookingStatus }> {
  await assertAdminRole(admin, ["CS"]);
  const id = parseInput(idSchema, bookingId);
  const why = parseInput(reasonSchema(200), reason);
  const result = await revertNoShowCore(id, { type: "ADMIN", id: admin.id }, null);
  await audit({ actorId: admin.id, actorType: "ADMIN", action: "booking.no_show_revert", targetType: "Booking", targetId: id, meta: { reason: why } });
  return result;
}

// ── 자동 완료 ─────────────────────────────────────────

/**
 * 주기 작업: 회차가 끝나고 autoCompleteAfterHours 가 지난 확정 예약을 이용 완료로 바꾼다
 * (체크인은 안 했지만 노쇼로 신고되지도 않은 예약). 고객 카드에 반영하고 후기를 요청한다.
 * 체크인으로 이미 완료된 예약에도 회차가 끝난 뒤 후기 요청을 한 번 보낸다. 완료 처리한 건수를 돌려준다.
 */
export async function completeDueBookings(now: Date = new Date()): Promise<number> {
  const settings = await getSettings();
  const cutoff = new Date(now.getTime() - settings.autoCompleteAfterHours * HOUR);
  const due = await prisma.booking.findMany({
    where: { status: "CONFIRMED", slot: { endAt: { lt: cutoff }, status: { not: "CANCELLED" } } },
    orderBy: { slot: { endAt: "asc" } },
    take: JOB_BATCH,
    select: crmSelect,
  });
  let completed = 0;
  for (const booking of due) {
    const updated = await prisma.booking.updateMany({ where: { id: booking.id, status: "CONFIRMED" }, data: { status: "COMPLETED", completedAt: now } });
    if (updated.count !== 1) continue;
    completed += 1;
    await safely("고객 카드 반영", booking.id, () => recordBookingEvent(booking, "COMPLETED"));
    if (booking.userId) await sendReviewRequest(booking.id);
  }

  // 체크인으로 완료된 예약: 회차가 끝난 뒤, 후기 작성 기간 안에서 한 번 요청한다.
  const checkedIn = await prisma.booking.findMany({
    where: {
      status: "COMPLETED",
      userId: { not: null },
      reviewRequestedAt: null,
      review: { is: null },
      slot: { endAt: { lt: now, gt: new Date(now.getTime() - settings.reviewWindowDays * DAY) } },
    },
    orderBy: { slot: { endAt: "asc" } },
    take: JOB_BATCH,
    select: { id: true },
  });
  for (const { id } of checkedIn) await sendReviewRequest(id);
  return completed;
}
