import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { env } from "@/lib/env";
import { formatKRW } from "@/lib/money";
import { HOUR, MINUTE, fmtDateTime, fmtDayLabel, fmtTime, isNightKst, kstDayDiff } from "@/lib/time";
import { prisma } from "@/server/db";
import { getNotificationPrefs, isExternalAllowed, notify, notifyMany, type NotificationType } from "./index";
import { enqueueMessageDetailed, nextMorningKst } from "./outbox";
import {
  DEFAULT_TEMPLATES,
  bookingPublicUrl,
  buildBookingTemplateVars,
  getBusinessTemplate,
  renderTemplate,
  type SellerTemplateKey,
} from "./templates";

/**
 * 예약 엔진·대기·심사 흐름이 부르는 알림 이벤트.
 * 모두 트랜잭션이 끝난 뒤 호출하며, 실패해도 예외를 던지지 않는다(로그만 남김).
 * 같은 이벤트를 두 번 불러도 알림이 겹치지 않도록 앱 내 알림·문자 모두 중복 방지 키를 쓴다.
 *
 * 문자 원칙
 * - 예약 확정·사업장/운영 사정 취소: 사업자 템플릿이 켜져 있으면 그 문구(사업자 월 한도 포함)로,
 *   꺼져 있거나 한도를 넘겼으면 남는자리 기본 안내로 보낸다. 고객은 어느 경우든 한 통을 받는다.
 * - 리마인드·후기 요청: 사업자 자동 문자 기능이다. 템플릿이 켜져 있고 한도가 남았을 때만 문자를 보낸다(앱 알림은 항상).
 */

export const notificationLinks = {
  customerBooking: (code: string) => `/my/bookings/${code}`,
  sellerBooking: (bookingId: string) => `/seller/bookings/${bookingId}`,
  sellerSlot: (slotId: string) => `/seller/slots/${slotId}`,
  sellerHome: () => "/seller",
  slot: (slotId: string) => `/slots/${slotId}`,
  waitlistOffer: (slotId: string) => `/slots/${slotId}?offer=1`,
} as const;

const absoluteUrl = (path: string) => `${env().APP_URL.replace(/\/+$/, "")}${path}`;

async function safely<T>(event: string, id: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    console.error(`[notify] ${event} 처리 실패 id=${id}`, e);
    return fallback;
  }
}

// ── 예약 불러오기 ─────────────────────────────────────

const bookingInclude = {
  user: { select: { id: true, phone: true, status: true, notificationPrefs: true } },
  business: {
    select: { id: true, name: true, slug: true, address: true, members: { select: { userId: true } } },
  },
  product: { select: { id: true, title: true, placeName: true, address: true } },
  slot: { select: { id: true, startAt: true } },
} satisfies Prisma.BookingInclude;

type LoadedBooking = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;

const loadBooking = (bookingId: string) => prisma.booking.findUnique({ where: { id: bookingId }, include: bookingInclude });

/** "금요 와인 소셜 · 11월 27일 (금) 19:30 · 2명" */
const bookingLine = (b: LoadedBooking) => `${b.product.title} · ${fmtDateTime(b.slot.startAt)} · ${b.quantity}명`;

// ── 사업장 구성원에게 ─────────────────────────────────

export interface MemberNotification {
  type: NotificationType;
  title: string;
  body: string;
  linkUrl?: string;
  data?: Prisma.InputJsonObject;
  /** 구성원별로 한 번만 보내려면 지정한다(구성원 ID 가 뒤에 붙는다). */
  dedupeKey?: string;
  excludeUserIds?: string[];
}

/** 사업장의 모든 구성원에게 앱 내 알림을 보낸다. 보낸 사람 수를 돌려준다. */
export async function notifyBusinessMembers(businessId: string, message: MemberNotification): Promise<number> {
  return safely("notifyBusinessMembers", businessId, 0, async () => {
    const members = await prisma.businessMember.findMany({ where: { businessId }, select: { userId: true } });
    return (await sendToMembers(members, message)).length;
  });
}

async function sendToMembers(members: { userId: string }[], message: MemberNotification) {
  const excluded = new Set(message.excludeUserIds ?? []);
  return notifyMany(
    members
      .filter((m) => !excluded.has(m.userId))
      .map((m) => ({
        userId: m.userId,
        type: message.type,
        title: message.title,
        body: message.body,
        linkUrl: message.linkUrl,
        data: message.data,
        dedupeKey: message.dedupeKey ? `${message.dedupeKey}:${m.userId}` : undefined,
      })),
  );
}

// ── 고객에게 ──────────────────────────────────────────

interface CustomerSms {
  /** 사업자 템플릿. 켜져 있으면 이 문구로 보내고 사업자 월 한도에 포함한다. */
  sellerTemplate?: SellerTemplateKey;
  /** 남는자리 기본 안내. null 이면 사업자 템플릿으로만 보낸다. dedupeKey 기본값은 "<templateKey>:<예약 ID>" */
  platform: { templateKey: string; text: string; dedupeKey?: string } | null;
  /** 수신 설정과 무관하게 보내는 필수 안내 */
  essential?: boolean;
  /** 문자 발송 시각을 늦출 때(야간을 피하는 안내). 생략하면 바로 보낸다. */
  scheduledAt?: Date;
}

interface CustomerMessage {
  type: NotificationType;
  title: string;
  body: string;
  linkUrl?: string;
  data?: Prisma.InputJsonObject;
  dedupeKey: string;
  sms?: CustomerSms;
}

/**
 * 예약 고객에게 앱 내 알림(회원 예약)과 문자(예약 시 남긴 연락처)를 보낸다.
 * 이번 호출로 새로 전달된 것이 있으면 true.
 */
async function notifyCustomer(booking: LoadedBooking, message: CustomerMessage): Promise<boolean> {
  let delivered = false;

  if (booking.userId) {
    const res = await notify({
      userId: booking.userId,
      type: message.type,
      title: message.title,
      body: message.body,
      linkUrl: message.linkUrl ?? notificationLinks.customerBooking(booking.code),
      data: { bookingId: booking.id, code: booking.code, slotId: booking.slotId, ...message.data },
      dedupeKey: message.dedupeKey,
    });
    delivered = res.created;
  }

  const sms = message.sms;
  if (!sms) return delivered;
  if (booking.user) {
    if (booking.user.status === "WITHDRAWN") return delivered;
    if (!isExternalAllowed(getNotificationPrefs(booking.user), message.type, { essential: sms.essential })) return delivered;
  }
  const recipient = booking.guestPhone || booking.user?.phone;
  if (!recipient) return delivered;

  if (sms.sellerTemplate) {
    const template = await getBusinessTemplate(booking.businessId, sms.sellerTemplate);
    if (template.isEnabled) {
      const queued = await enqueueMessageDetailed({
        userId: booking.userId,
        businessId: booking.businessId,
        channel: template.channel,
        recipient,
        templateKey: sms.sellerTemplate,
        body: renderTemplate(template.body, buildBookingTemplateVars(booking)),
        dedupeKey: `${sms.sellerTemplate}:${booking.id}`,
        scheduledAt: sms.scheduledAt,
      });
      // 한도 초과(SKIPPED)면 아래 기본 안내로 넘어간다.
      if (queued.row && queued.row.status !== "SKIPPED") return delivered || queued.created;
    }
  }

  if (sms.platform) {
    const queued = await enqueueMessageDetailed({
      userId: booking.userId,
      businessId: booking.businessId,
      channel: "SMS",
      recipient,
      templateKey: sms.platform.templateKey,
      body: sms.platform.text,
      dedupeKey: sms.platform.dedupeKey ?? `${sms.platform.templateKey}:${booking.id}`,
      scheduledAt: sms.scheduledAt,
    });
    return delivered || queued.created;
  }
  return delivered;
}

const smsLines = (...lines: (string | null | false | undefined)[]) => lines.filter(Boolean).join("\n");

// ── 예약 이벤트 ───────────────────────────────────────

/**
 * 예약 확정. approved 가 true 면 승인제 예약을 사업자가 승인한 경우다
 * (고객 문구가 달라지고, 방금 승인한 사업자에게는 새 예약 알림을 보내지 않는다).
 */
export async function onBookingConfirmed(bookingId: string, options: { approved?: boolean } = {}): Promise<void> {
  await safely("onBookingConfirmed", bookingId, undefined, async () => {
    const booking = await loadBooking(bookingId);
    // 호출 사이에 상태가 바뀐 예약(곧바로 취소된 경우 등)에는 확정 알림을 보내지 않는다.
    if (!booking || (booking.status !== "CONFIRMED" && booking.status !== "COMPLETED")) return;
    const approved = options.approved === true;

    await notifyCustomer(booking, {
      type: approved ? "BOOKING_APPROVED" : "BOOKING_CONFIRMED",
      title: approved ? "예약이 승인됐어요" : "예약이 확정됐어요",
      body: `${bookingLine(booking)}\n${booking.business.name}에서 만나요.`,
      dedupeKey: `BOOKING_CONFIRMED:${booking.id}`,
      sms: {
        sellerTemplate: "BOOKING_CONFIRMED",
        platform: {
          templateKey: "PLATFORM_BOOKING_CONFIRMED",
          text: smsLines(
            "[남는자리] 예약이 확정됐어요.",
            `${booking.business.name} · ${booking.product.title}`,
            `${fmtDateTime(booking.slot.startAt)} · ${booking.quantity}명`,
            `예약번호 ${booking.code}`,
            bookingPublicUrl(booking),
          ),
        },
      },
    });

    // 사업자가 직접 넣었거나 방금 승인한 예약은 사업자에게 다시 알리지 않는다.
    if (approved || booking.channel === "MANUAL") return;
    await sendToMembers(booking.business.members, {
      type: "SELLER_NEW_BOOKING",
      title: "새 예약이 들어왔어요",
      body: `${booking.guestName}님 · ${bookingLine(booking)}`,
      linkUrl: notificationLinks.sellerBooking(booking.id),
      data: { bookingId: booking.id, slotId: booking.slotId },
      dedupeKey: `SELLER_NEW_BOOKING:${booking.id}`,
    });
  });
}

/** 승인제 예약을 사업자가 승인했을 때 */
export async function onBookingApproved(bookingId: string): Promise<void> {
  await onBookingConfirmed(bookingId, { approved: true });
}

export async function onBookingPendingApproval(bookingId: string): Promise<void> {
  await safely("onBookingPendingApproval", bookingId, undefined, async () => {
    const booking = await loadBooking(bookingId);
    if (!booking || booking.status !== "PENDING_APPROVAL") return;

    await notifyCustomer(booking, {
      type: "BOOKING_PENDING_APPROVAL",
      title: "예약 요청을 보냈어요",
      body: `${bookingLine(booking)}\n${booking.business.name}에서 확인하면 바로 알려 드릴게요.`,
      dedupeKey: `BOOKING_PENDING_APPROVAL:${booking.id}`,
    });

    await sendToMembers(booking.business.members, {
      type: "SELLER_APPROVAL_NEEDED",
      title: "승인을 기다리는 예약이 있어요",
      body: `${booking.guestName}님 · ${bookingLine(booking)}\n확인하고 승인하거나 거절해 주세요.`,
      linkUrl: notificationLinks.sellerBooking(booking.id),
      data: { bookingId: booking.id, slotId: booking.slotId },
      dedupeKey: `SELLER_APPROVAL_NEEDED:${booking.id}`,
    });
  });
}

/** 결제한 금액이 있을 때의 환불 안내 한 줄 */
function fullRefundLine(booking: LoadedBooking): string | null {
  const paid = booking.paymentState !== "UNPAID" && booking.payNowAmount > 0;
  if (!paid) return null;
  const amount = booking.refundAmount > 0 ? booking.refundAmount : booking.payNowAmount;
  return `결제하신 ${formatKRW(amount)}은 전액 환불돼요.`;
}

export async function onBookingRejected(bookingId: string): Promise<void> {
  await safely("onBookingRejected", bookingId, undefined, async () => {
    const booking = await loadBooking(bookingId);
    if (!booking || booking.status !== "REJECTED") return;
    const refund = fullRefundLine(booking);

    await notifyCustomer(booking, {
      type: "BOOKING_REJECTED",
      title: "예약 요청이 승인되지 않았어요",
      body: smsLines(bookingLine(booking), `${booking.business.name} 사정으로 이번 예약은 진행하지 못했어요.`, refund),
      dedupeKey: `BOOKING_REJECTED:${booking.id}`,
      sms: {
        platform: {
          templateKey: "PLATFORM_BOOKING_REJECTED",
          text: smsLines(
            "[남는자리] 예약 요청이 승인되지 않았어요.",
            `${booking.business.name} · ${booking.product.title}`,
            fmtDateTime(booking.slot.startAt),
            refund,
            bookingPublicUrl(booking),
          ),
        },
      },
    });
  });
}

export async function onBookingExpired(bookingId: string): Promise<void> {
  await safely("onBookingExpired", bookingId, undefined, async () => {
    const booking = await loadBooking(bookingId);
    if (!booking || booking.status !== "EXPIRED") return;

    await notifyCustomer(booking, {
      type: "BOOKING_EXPIRED",
      title: "결제 시간이 지나 예약이 취소됐어요",
      body: `${bookingLine(booking)}\n자리가 남아 있으면 다시 예약할 수 있어요.`,
      linkUrl: notificationLinks.slot(booking.slotId),
      dedupeKey: `BOOKING_EXPIRED:${booking.id}`,
    });
  });
}

/** 취소 알림. 누가 취소했는지(booking.cancelledBy)에 따라 문구와 받는 사람이 달라진다. */
export async function onBookingCancelled(bookingId: string): Promise<void> {
  await safely("onBookingCancelled", bookingId, undefined, async () => {
    const booking = await loadBooking(bookingId);
    if (!booking || booking.status !== "CANCELLED") return;
    const by = booking.cancelledBy ?? "SYSTEM";
    const sellerData = { bookingId: booking.id, slotId: booking.slotId };

    if (by === "CUSTOMER") {
      const paid = booking.paymentState !== "UNPAID" && booking.payNowAmount > 0;
      const refund =
        booking.refundAmount > 0
          ? `환불 금액은 ${formatKRW(booking.refundAmount)}이에요. 결제 수단으로 돌려드려요.`
          : paid
            ? "취소·환불 규정에 따라 환불 금액은 없어요."
            : null;
      await notifyCustomer(booking, {
        type: "BOOKING_CANCELLED",
        title: "예약을 취소했어요",
        body: smsLines(bookingLine(booking), refund),
        data: { cancelledBy: by, refundAmount: booking.refundAmount },
        dedupeKey: `BOOKING_CANCELLED:${booking.id}`,
      });
      await sendToMembers(booking.business.members, {
        type: "SELLER_BOOKING_CANCELLED",
        title: "고객이 예약을 취소했어요",
        body: `${booking.guestName}님 · ${bookingLine(booking)}`,
        linkUrl: notificationLinks.sellerBooking(booking.id),
        data: sellerData,
        dedupeKey: `SELLER_BOOKING_CANCELLED:${booking.id}`,
      });
      return;
    }

    const refund = fullRefundLine(booking);
    const reason = booking.cancelReason?.trim() ? `사유: ${booking.cancelReason.trim().slice(0, 120)}` : null;
    const bySeller = by === "SELLER";
    await notifyCustomer(booking, {
      type: "BOOKING_CANCELLED",
      title: bySeller ? "사업장 사정으로 예약이 취소됐어요" : "예약이 취소됐어요",
      // 운영자가 남긴 사유는 내부 메모일 수 있어 고객에게는 보여 주지 않는다.
      body: smsLines(bookingLine(booking), by === "ADMIN" ? null : reason, refund),
      data: { cancelledBy: by, refundAmount: booking.refundAmount },
      dedupeKey: `BOOKING_CANCELLED:${booking.id}`,
      sms: {
        // 고객이 헛걸음하지 않도록 수신 설정과 무관하게 보낸다.
        essential: true,
        sellerTemplate: bySeller ? "BOOKING_CANCELLED_BY_SELLER" : undefined,
        platform: {
          templateKey: "PLATFORM_BOOKING_CANCELLED",
          text: smsLines(
            bySeller ? "[남는자리] 사업장 사정으로 예약이 취소됐어요." : "[남는자리] 예약이 취소됐어요.",
            `${booking.business.name} · ${booking.product.title}`,
            `${fmtDateTime(booking.slot.startAt)} · 예약번호 ${booking.code}`,
            refund,
            bookingPublicUrl(booking),
          ),
        },
      },
    });

    // 사업자가 직접 취소한 건은 사업자에게 다시 알리지 않는다.
    if (bySeller) return;
    await sendToMembers(booking.business.members, {
      type: "SELLER_BOOKING_CANCELLED",
      title: by === "ADMIN" ? "운영자가 예약을 취소했어요" : "예약이 자동으로 취소됐어요",
      body: smsLines(`${booking.guestName}님 · ${bookingLine(booking)}`, reason),
      linkUrl: notificationLinks.sellerBooking(booking.id),
      data: sellerData,
      dedupeKey: `SELLER_BOOKING_CANCELLED:${booking.id}`,
    });
  });
}

/** PG 환불이 끝났을 때. amount 는 이번에 환불된 금액 */
export async function onRefundDone(bookingId: string, amount: number): Promise<void> {
  await safely("onRefundDone", bookingId, undefined, async () => {
    if (!Number.isInteger(amount) || amount <= 0) return;
    const booking = await loadBooking(bookingId);
    if (!booking) return;
    const key = `REFUND_DONE:${booking.id}:${amount}:${booking.refundAmount}`;

    await notifyCustomer(booking, {
      type: "REFUND_DONE",
      title: "환불이 완료됐어요",
      body: `${formatKRW(amount)}을 결제 수단으로 돌려드렸어요. 카드사에 따라 반영까지 영업일 기준 3~5일 걸릴 수 있어요.\n${booking.product.title} · 예약번호 ${booking.code}`,
      data: { refundAmount: amount },
      dedupeKey: key,
      sms: {
        platform: {
          templateKey: "PLATFORM_REFUND_DONE",
          dedupeKey: key,
          text: smsLines(
            `[남는자리] ${formatKRW(amount)} 환불이 완료됐어요.`,
            `${booking.product.title} · 예약번호 ${booking.code}`,
            "카드사에 따라 반영까지 영업일 기준 3~5일 걸릴 수 있어요.",
          ),
        },
      },
    });
  });
}

// ── 대기 ──────────────────────────────────────────────

const waitlistInclude = {
  slot: {
    select: {
      id: true,
      startAt: true,
      businessId: true,
      product: { select: { title: true } },
      business: { select: { name: true } },
    },
  },
} satisfies Prisma.WaitlistEntryInclude;

/** 제안 마감 시각을 읽기 쉽게: 오늘이면 "19:50", 날짜가 바뀌면 "내일 00:10" */
function offerDeadlineLabel(expiresAt: Date, now: Date): string {
  return kstDayDiff(expiresAt, now) === 0 ? fmtTime(expiresAt) : `${fmtDayLabel(expiresAt, now)} ${fmtTime(expiresAt)}`;
}

/** 대기자에게 자리를 제안한다(앱 + 문자). 제안 시간이 있으면 마감 시각을 함께 알린다. */
export async function onWaitlistOffer(waitlistEntryId: string): Promise<void> {
  await safely("onWaitlistOffer", waitlistEntryId, undefined, async () => {
    const entry = await prisma.waitlistEntry.findUnique({ where: { id: waitlistEntryId }, include: waitlistInclude });
    if (!entry || (entry.status !== "OFFERED" && entry.status !== "WAITING")) return;
    const { slot } = entry;
    const now = new Date();
    const hasDeadline = entry.offerExpiresAt !== null && entry.offerExpiresAt.getTime() > now.getTime();
    const deadline = hasDeadline
      ? `${offerDeadlineLabel(entry.offerExpiresAt!, now)}까지 예약하면 자리가 확정돼요.`
      : "먼저 예약하는 분께 자리가 돌아가요. 지금 확인해 보세요.";
    const what = `${slot.business.name} · ${slot.product.title}`;
    const when = `${fmtDateTime(slot.startAt)} · ${entry.quantity}명`;
    const key = `WAITLIST_OFFER:${entry.id}:${entry.offeredAt?.getTime() ?? 0}`;
    const link = notificationLinks.waitlistOffer(slot.id);

    await notify({
      userId: entry.userId,
      type: "WAITLIST_OFFER",
      title: "기다리던 자리가 났어요",
      body: smsLines(what, when, deadline),
      linkUrl: link,
      data: {
        waitlistEntryId: entry.id,
        slotId: slot.id,
        offerExpiresAt: hasDeadline ? entry.offerExpiresAt!.toISOString() : null,
      },
      dedupeKey: key,
      external: {
        channel: "SMS",
        templateKey: "PLATFORM_WAITLIST_OFFER",
        text: smsLines("[남는자리] 기다리던 자리가 났어요.", what, when, deadline, absoluteUrl(link)),
        dedupeKey: key,
        businessId: slot.businessId,
      },
    });
  });
}

/** 제안 시간이 지나 자리가 넘어갔을 때 */
export async function onWaitlistExpired(waitlistEntryId: string): Promise<void> {
  await safely("onWaitlistExpired", waitlistEntryId, undefined, async () => {
    const entry = await prisma.waitlistEntry.findUnique({ where: { id: waitlistEntryId }, include: waitlistInclude });
    if (!entry) return;
    const { slot } = entry;

    await notify({
      userId: entry.userId,
      type: "WAITLIST_EXPIRED",
      title: "자리 제안 시간이 지났어요",
      body: `${slot.business.name} · ${slot.product.title}\n${fmtDateTime(slot.startAt)} 자리는 다음 분께 넘어갔어요. 자리가 다시 나면 확인해 보세요.`,
      linkUrl: notificationLinks.slot(slot.id),
      data: { waitlistEntryId: entry.id, slotId: slot.id },
      dedupeKey: `WAITLIST_EXPIRED:${entry.id}:${entry.offeredAt?.getTime() ?? 0}`,
    });
  });
}

// ── 사업자 ────────────────────────────────────────────

/** 자동 재등록을 꺼 둔 사업장에 취소석이 생겼을 때: 다시 올릴지 묻는다. */
export async function onSeatReleasedForSeller(slotId: string, quantity: number): Promise<void> {
  await safely("onSeatReleasedForSeller", slotId, undefined, async () => {
    const seats = Math.max(1, Math.floor(quantity));
    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
      select: {
        id: true,
        startAt: true,
        product: { select: { title: true } },
        business: { select: { members: { select: { userId: true } } } },
      },
    });
    if (!slot) return;

    await sendToMembers(slot.business.members, {
      type: "SELLER_SEAT_RELEASED",
      title: `취소로 ${seats}자리가 생겼어요. 다시 올릴까요?`,
      body: `${slot.product.title} · ${fmtDateTime(slot.startAt)}\n자동 재등록이 꺼져 있어 지금은 닫혀 있어요.`,
      linkUrl: notificationLinks.sellerSlot(slot.id),
      data: { slotId: slot.id, quantity: seats },
    });
  });
}

/** 입점 심사 결과를 사업장 구성원 모두에게 알린다(앱 + 이메일). */
export async function onBusinessReviewed(businessId: string, approved: boolean, reason?: string): Promise<void> {
  await safely("onBusinessReviewed", businessId, undefined, async () => {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { name: true, reviewedAt: true, members: { select: { userId: true } } },
    });
    if (!business) return;
    const why = reason?.trim().slice(0, 300);
    const title = approved ? `${business.name} 입점이 승인됐어요` : `${business.name} 입점 심사 결과를 확인해 주세요`;
    const body = approved
      ? "이제 상품과 회차를 올리고 예약을 받을 수 있어요."
      : smsLines("이번 심사에서는 승인되지 않았어요.", why ? `사유: ${why}` : null, "내용을 보완해 다시 신청할 수 있어요.");
    const link = notificationLinks.sellerHome();
    // 재심사가 있을 수 있어 심사 시각까지 키에 넣는다. 심사 시각이 없으면 중복 방지를 하지 않는다.
    const stamp = business.reviewedAt?.getTime();

    for (const member of business.members) {
      const key = stamp ? `BUSINESS_REVIEWED:${businessId}:${approved ? "Y" : "N"}:${stamp}:${member.userId}` : undefined;
      await notify({
        userId: member.userId,
        type: approved ? "SELLER_BUSINESS_APPROVED" : "SELLER_BUSINESS_REJECTED",
        title,
        body,
        linkUrl: link,
        data: { businessId, approved },
        dedupeKey: key,
        external: {
          channel: "EMAIL",
          templateKey: approved ? "PLATFORM_BUSINESS_APPROVED" : "PLATFORM_BUSINESS_REJECTED",
          subject: `[남는자리] ${title}`,
          text: smsLines(title, "", body, "", absoluteUrl(link)),
          dedupeKey: key,
          businessId,
        },
      });
    }
  });
}

// ── 리마인드 · 후기 요청 ──────────────────────────────

export type ReminderKind = "DAY_BEFORE" | "HOURS_BEFORE";

const REMINDER_TEMPLATE: Record<ReminderKind, "REMINDER_DAY_BEFORE" | "REMINDER_HOURS_BEFORE"> = {
  DAY_BEFORE: "REMINDER_DAY_BEFORE",
  HOURS_BEFORE: "REMINDER_HOURS_BEFORE",
};

/**
 * 예약 리마인드(종류별로 예약당 한 번). 확정 상태이고 아직 시작 전인 예약에만 보낸다.
 * 언제 부를지는 호출부(주기 작업)가 정한다 — 사업자별 발송 시점까지 반영하려면 sendDueReminders 를 쓴다.
 * 이번 호출로 새로 보낸 것이 있으면 true.
 */
export async function sendBookingReminder(bookingId: string, kind: ReminderKind): Promise<boolean> {
  return safely("sendBookingReminder", bookingId, false, async () => {
    const booking = await loadBooking(bookingId);
    const now = new Date();
    if (!booking || booking.status !== "CONFIRMED" || booking.slot.startAt.getTime() <= now.getTime()) return false;
    const place = buildBookingTemplateVars(booking).장소;
    // 전날 리마인드 문자는 급하지 않으므로 한밤중이면 아침 8시로 미룬다(그래도 시작 2시간 전에는 도착해야 한다).
    const morning = kind === "DAY_BEFORE" && isNightKst(now) ? nextMorningKst(now) : null;
    const smsAt = morning && morning.getTime() <= booking.slot.startAt.getTime() - 2 * HOUR ? morning : undefined;

    const delivered = await notifyCustomer(booking, {
      type: "BOOKING_REMINDER",
      title: kind === "DAY_BEFORE" ? `${fmtDayLabel(booking.slot.startAt, now)} 예약이 있어요` : "곧 예약 시간이에요",
      body: smsLines(bookingLine(booking), place ? `장소: ${place}` : null, "못 오시게 되면 미리 취소해 주세요."),
      data: { kind },
      dedupeKey: `REMINDER:${kind}:${booking.id}`,
      sms: { sellerTemplate: REMINDER_TEMPLATE[kind], platform: null, scheduledAt: smsAt },
    });
    await prisma.booking.updateMany({ where: { id: booking.id }, data: { reminderSentAt: now } });
    return delivered;
  });
}

/**
 * 이용 후 후기 요청(예약당 한 번). 이용 완료된 회원 예약이고 아직 후기가 없을 때만 보낸다.
 * 앱 내 요청은 항상, 문자는 사업자가 후기 요청 템플릿을 켰고 고객이 후기 요청 수신을 켠 경우에만 보낸다.
 */
export async function sendReviewRequest(bookingId: string): Promise<boolean> {
  return safely("sendReviewRequest", bookingId, false, async () => {
    const booking = await loadBooking(bookingId);
    if (!booking || !booking.userId || booking.status !== "COMPLETED") return false;
    const review = await prisma.review.findUnique({ where: { bookingId: booking.id }, select: { id: true } });
    if (review) return false;
    // 자동 완료 처리가 새벽에 돌 수 있으므로 후기 요청 문자는 야간을 피해 보낸다.
    const now = new Date();
    const smsAt = isNightKst(now) ? nextMorningKst(now) : undefined;

    const delivered = await notifyCustomer(booking, {
      type: "REVIEW_REQUEST",
      title: `${booking.product.title}, 어떠셨어요?`,
      body: `${booking.business.name}에서 보낸 시간을 들려주세요. 다음 분이 자리를 고르는 데 큰 도움이 돼요.`,
      dedupeKey: `REVIEW_REQUEST:${booking.id}`,
      sms: { sellerTemplate: "REVIEW_REQUEST", platform: null, scheduledAt: smsAt },
    });
    await prisma.booking.updateMany({ where: { id: booking.id, reviewRequestedAt: null }, data: { reviewRequestedAt: now } });
    return delivered;
  });
}

/** 발송 시점이 이만큼 지나도록 못 보낸 리마인드는 건너뛴다(뒤늦은 안내 방지). */
const REMINDER_GRACE_MS: Record<ReminderKind, number> = { DAY_BEFORE: 6 * HOUR, HOURS_BEFORE: HOUR };
/** 시작이 가까운 리마인드부터 본다 — 둘 다 밀려 있으면 당일 리마인드 하나만 보낸다. */
const REMINDER_KINDS: ReminderKind[] = ["HOURS_BEFORE", "DAY_BEFORE"];

interface ReminderGroup {
  kind: ReminderKind;
  offsetMs: number;
  /** 이 발송 시점을 쓰는 사업장. null 이면 기본 시점을 쓰는 나머지 전부 */
  businessIds: string[] | null;
  /** 기본 시점 묶음에서 빼야 하는 사업장(직접 정한 시점이 있는 곳) */
  excludeBusinessIds: string[];
}

/**
 * 지금 보낼 차례인 리마인드를 찾아 보낸다(주기 작업용, 여러 번 불러도 결과가 같다).
 * - 발송 시점 = 회차 시작 − 사업자가 정한 N분(프로 플랜에서 변경 가능. 기본: 전날 1440분, 당일 180분)
 * - 발송 시점보다 늦게 확정된 예약(임박 예약)에는 그 리마인드를 보내지 않는다.
 * - 한 번에 최대 limit 건까지 처리하고, 남은 건은 다음 호출에서 이어 간다.
 */
export async function sendDueReminders(now: Date = new Date(), limit = 200): Promise<{ sent: number }> {
  return safely("sendDueReminders", "-", { sent: 0 }, async () => {
    const max = Math.min(1000, Math.max(1, Math.floor(limit)));
    const custom = await prisma.messageTemplate.findMany({
      where: { key: { in: Object.values(REMINDER_TEMPLATE) }, offsetMinutes: { not: null }, business: { plan: "PRO" } },
      select: { businessId: true, key: true, offsetMinutes: true },
    });

    const groups: ReminderGroup[] = [];
    for (const kind of REMINDER_KINDS) {
      const key = REMINDER_TEMPLATE[kind];
      const defaultMin = DEFAULT_TEMPLATES[key].offsetMinutes ?? 0;
      const byOffset = new Map<number, string[]>();
      for (const t of custom) {
        if (t.key !== key || t.offsetMinutes === null || t.offsetMinutes === defaultMin) continue;
        byOffset.set(t.offsetMinutes, [...(byOffset.get(t.offsetMinutes) ?? []), t.businessId]);
      }
      groups.push({ kind, offsetMs: defaultMin * MINUTE, businessIds: null, excludeBusinessIds: [...byOffset.values()].flat() });
      for (const [minutes, businessIds] of byOffset) {
        groups.push({ kind, offsetMs: minutes * MINUTE, businessIds, excludeBusinessIds: [] });
      }
    }

    let sent = 0;
    let processed = 0;
    const handled = new Set<string>();
    for (const group of groups) {
      if (processed >= max) break;
      // 발송 시점(시작 − N분)이 [now − 유예, now] 에 들어오는 회차만 본다.
      const latestStart = new Date(now.getTime() + group.offsetMs);
      const earliestStart = new Date(Math.max(now.getTime(), latestStart.getTime() - REMINDER_GRACE_MS[group.kind]));
      const candidates = await prisma.booking.findMany({
        where: {
          status: "CONFIRMED",
          businessId: group.businessIds
            ? { in: group.businessIds }
            : group.excludeBusinessIds.length > 0
              ? { notIn: group.excludeBusinessIds }
              : undefined,
          slot: { status: { not: "CANCELLED" }, startAt: { gt: earliestStart, lte: latestStart } },
        },
        select: { id: true, createdAt: true, confirmedAt: true, reminderSentAt: true, slot: { select: { startAt: true } } },
        orderBy: { slot: { startAt: "asc" } },
      });

      for (const booking of candidates) {
        if (processed >= max) break;
        if (handled.has(booking.id)) continue;
        const dueAt = booking.slot.startAt.getTime() - group.offsetMs;
        if ((booking.confirmedAt ?? booking.createdAt).getTime() > dueAt) continue;
        // 이 리마인드의 발송 시점 이후에 처리한 기록이 있으면 이미 끝난 건이다.
        if (booking.reminderSentAt && booking.reminderSentAt.getTime() >= dueAt) continue;
        handled.add(booking.id);
        processed += 1;
        if (await sendBookingReminder(booking.id, group.kind)) sent += 1;
      }
    }
    return { sent };
  });
}
