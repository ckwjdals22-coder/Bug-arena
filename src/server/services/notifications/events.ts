import "server-only";
import { HELP_FACTS } from "@/content/help/faq";
import { BOOKING_SAFETY_TIPS } from "@/content/help/safety";
import type { Prisma } from "@/generated/prisma/client";
import { computeRefundRate, type CancellationTier } from "@/lib/domain";
import { env } from "@/lib/env";
import { formatKRW } from "@/lib/money";
import { HOUR, MINUTE, fmtDate, fmtDateTime, fmtDayLabel, fmtTime, isNightKst, kstDayDiff } from "@/lib/time";
import { prisma } from "@/server/db";
import { getSettings } from "@/server/settings";
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

/** 처음 만나는 사람들과의 자리이므로 확정 안내에 한 줄 넣는 안전 수칙(도움말의 문구를 그대로 쓴다) */
const SAFETY_LINE = BOOKING_SAFETY_TIPS[0] ?? null;

// ── 환불 안내 문구 ────────────────────────────────────

/**
 * 예약 시점의 정책 스냅샷에서 환불 구간을 꺼낸다(구간 배열 그대로이거나 { tiers: [...] } 형태).
 * 읽을 수 없으면 null — 기본 정책으로 추측한 환불율을 고객에게 보여 주지 않기 위함이다.
 */
function snapshotTiers(snapshot: unknown): CancellationTier[] | null {
  const nested = typeof snapshot === "object" && snapshot !== null ? (snapshot as { tiers?: unknown }).tiers : undefined;
  const raw: unknown = Array.isArray(snapshot) ? snapshot : nested;
  if (!Array.isArray(raw)) return null;
  const tiers: CancellationTier[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) return null;
    const { hoursBefore, refundRate } = item as { hoursBefore?: unknown; refundRate?: unknown };
    if (typeof hoursBefore !== "number" || typeof refundRate !== "number" || hoursBefore < 0 || refundRate < 0 || refundRate > 100) return null;
    tiers.push({ hoursBefore, refundRate: Math.round(refundRate) });
  }
  return tiers.length > 0 ? tiers : null;
}

/**
 * "지금 취소하면 얼마나 환불되는지" 한 줄. 예약 엔진과 같은 계산(computeRefundRate)을 쓴다.
 * 온라인으로 결제한 금액이 없거나 정책을 읽을 수 없으면 null.
 */
async function currentRefundLine(booking: LoadedBooking, now: Date): Promise<string | null> {
  if (booking.paymentMethod !== "ONLINE" || booking.paymentState === "UNPAID" || booking.payNowAmount <= 0) return null;
  const tiers = snapshotTiers(booking.policySnapshot);
  if (!tiers) return null;
  const settings = await getSettings();
  const rate = computeRefundRate({
    tiers,
    startAt: booking.slot.startAt,
    bookedAt: booking.createdAt,
    now,
    graceMinutes: settings.cancelGraceMinutes,
    graceMinLeadMinutes: settings.cancelGraceMinLeadMinutes,
  });
  if (rate >= 100) return "지금 취소하면 결제 금액을 전액 돌려드려요.";
  const resale =
    booking.resaleRefundRate !== null && booking.resaleRefundRate > rate
      ? ` 자리가 다시 예약되면 ${booking.resaleRefundRate}%까지 돌려드려요.`
      : "";
  return rate > 0 ? `지금 취소하면 결제 금액의 ${rate}%를 돌려드려요.${resale}` : `지금은 취소해도 환불되지 않아요.${resale}`;
}

/**
 * 재판매 연동 환불 대기 중인 취소 건의 안내 한 줄(docs/02-architecture.md 6.4).
 * 실제 추가 환불은 회차 시작 시각에 다시 팔린 좌석 수로 정해지므로 "최대" 금액으로 알린다.
 */
function resalePendingLine(booking: LoadedBooking): string | null {
  const { resalePendingQty, resaleRefundRate, refundRate, payNowAmount, quantity } = booking;
  if (resalePendingQty <= 0 || resaleRefundRate === null || refundRate === null || resaleRefundRate <= refundRate) return null;
  const extra = Math.floor((payNowAmount * (resaleRefundRate - refundRate) * resalePendingQty) / (100 * quantity));
  return extra > 0 ? `자리가 다시 예약되면 회차 시작 후 최대 ${formatKRW(extra)}을 더 돌려드려요.` : null;
}

// ── 예약 이벤트 ───────────────────────────────────────

/**
 * 예약 확정. approved 가 true 면 승인제 예약을 사업자가 승인한 경우다
 * (고객 문구가 달라지고, 방금 승인한 사업자에게는 새 예약 알림을 보내지 않는다).
 * 확정 안내에는 판매자 이름·일시·장소와 오프라인 모임 안전 수칙 한 줄이 들어간다.
 * 정확한 주소는 확정된 고객에게만 보여 주는 정보이므로(6.10) 이 안내에서 처음 알려 준다.
 */
export async function onBookingConfirmed(bookingId: string, options: { approved?: boolean } = {}): Promise<void> {
  await safely("onBookingConfirmed", bookingId, undefined, async () => {
    const booking = await loadBooking(bookingId);
    // 호출 사이에 상태가 바뀐 예약(곧바로 취소된 경우 등)에는 확정 알림을 보내지 않는다.
    if (!booking || (booking.status !== "CONFIRMED" && booking.status !== "COMPLETED")) return;
    const approved = options.approved === true;
    const place = buildBookingTemplateVars(booking).장소;

    await notifyCustomer(booking, {
      type: approved ? "BOOKING_APPROVED" : "BOOKING_CONFIRMED",
      title: approved ? "예약이 승인됐어요" : "예약이 확정됐어요",
      body: smsLines(bookingLine(booking), `${booking.business.name}에서 만나요.`, place ? `장소: ${place}` : null, SAFETY_LINE),
      dedupeKey: `BOOKING_CONFIRMED:${booking.id}`,
      sms: {
        sellerTemplate: "BOOKING_CONFIRMED",
        platform: {
          templateKey: "PLATFORM_BOOKING_CONFIRMED",
          text: smsLines(
            "[남는자리] 예약이 확정됐어요.",
            `${booking.business.name} · ${booking.product.title}`,
            `${fmtDateTime(booking.slot.startAt)} · ${booking.quantity}명`,
            place ? `장소: ${place}` : null,
            `예약번호 ${booking.code}`,
            SAFETY_LINE,
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

const cancelReasonLine = (reason: string | null | undefined) => (reason?.trim() ? `사유: ${reason.trim().slice(0, 120)}` : null);

interface ForcedCancelMessage {
  type: NotificationType;
  title: string;
  /** 남는자리 기본 문자의 첫 줄 */
  smsHead: string;
  /** "사유: …" 한 줄(없으면 null) */
  reason: string | null;
}

/**
 * 고객이 아닌 쪽(사업자·운영자·시스템)의 취소를 예약 고객에게 알린다. 결제한 금액이 있으면 전액 환불 안내를 붙인다.
 * 예약 취소(onBookingCancelled)와 회차 취소(onSlotCancelled)가 같은 중복 방지 키를 쓰므로,
 * 두 이벤트가 모두 불려도 고객은 먼저 온 안내 하나만 받는다.
 */
async function notifyForcedCancel(booking: LoadedBooking, message: ForcedCancelMessage): Promise<boolean> {
  const by = booking.cancelledBy ?? "SYSTEM";
  const refund = fullRefundLine(booking);
  return notifyCustomer(booking, {
    type: message.type,
    title: message.title,
    // 운영자가 남긴 사유는 내부 메모일 수 있어 고객에게는 보여 주지 않는다.
    body: smsLines(bookingLine(booking), by === "ADMIN" ? null : message.reason, refund),
    data: { cancelledBy: by, refundAmount: booking.refundAmount },
    dedupeKey: `BOOKING_CANCELLED:${booking.id}`,
    sms: {
      // 고객이 헛걸음하지 않도록 수신 설정과 무관하게 보낸다.
      essential: true,
      sellerTemplate: by === "SELLER" ? "BOOKING_CANCELLED_BY_SELLER" : undefined,
      platform: {
        templateKey: "PLATFORM_BOOKING_CANCELLED",
        text: smsLines(
          message.smsHead,
          `${booking.business.name} · ${booking.product.title}`,
          `${fmtDateTime(booking.slot.startAt)} · 예약번호 ${booking.code}`,
          refund,
          bookingPublicUrl(booking),
        ),
      },
    },
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
        body: smsLines(bookingLine(booking), refund, resalePendingLine(booking)),
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

    const reason = cancelReasonLine(booking.cancelReason);
    const bySeller = by === "SELLER";
    await notifyForcedCancel(booking, {
      type: "BOOKING_CANCELLED",
      title: bySeller ? "사업장 사정으로 예약이 취소됐어요" : "예약이 취소됐어요",
      smsHead: bySeller ? "[남는자리] 사업장 사정으로 예약이 취소됐어요." : "[남는자리] 예약이 취소됐어요.",
      reason,
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

/**
 * 재판매 연동 환불이 확정됐을 때(회차 시작 시각의 판정에서 취소한 자리가 다시 팔린 것으로 정해진 뒤, 6.4).
 * extraAmount 는 이번 판정으로 더 돌려주는 금액. 취소된 예약에만 알리고, 같은 누적 환불액에 대해서는 한 번만 간다
 * (추가 환불액을 예약에 반영한 트랜잭션이 끝난 뒤에 부른다). PG 환불이 끝났을 때의 안내는 onRefundDone 이 따로 맡는다.
 */
export async function onResaleRefund(bookingId: string, extraAmount: number): Promise<void> {
  await safely("onResaleRefund", bookingId, undefined, async () => {
    if (!Number.isInteger(extraAmount) || extraAmount <= 0) return;
    const booking = await loadBooking(bookingId);
    if (!booking || booking.status !== "CANCELLED") return;
    const key = `RESALE_REFUND:${booking.id}:${booking.refundAmount}`;
    const what = `${booking.product.title} · 예약번호 ${booking.code}`;
    const total = booking.refundAmount >= extraAmount ? `이 예약의 환불 금액은 모두 ${formatKRW(booking.refundAmount)}이에요.` : null;

    await notifyCustomer(booking, {
      type: "REFUND_DONE",
      title: "취소한 자리가 다시 예약돼 더 돌려드려요",
      body: smsLines(what, `${formatKRW(extraAmount)}을 결제 수단으로 더 돌려드릴게요.`, total, "환불이 끝나면 다시 알려 드려요."),
      data: { kind: "RESALE", extraAmount, refundAmount: booking.refundAmount },
      dedupeKey: key,
      sms: {
        platform: {
          templateKey: "PLATFORM_RESALE_REFUND",
          dedupeKey: key,
          text: smsLines("[남는자리] 취소한 자리가 다시 예약됐어요.", what, `${formatKRW(extraAmount)}을 결제 수단으로 더 돌려드릴게요.`, total),
        },
      },
    });
  });
}

// ── 회차 이벤트 ───────────────────────────────────────

/**
 * 개최 확정(6.7): 최소 인원을 채웠거나 사업자가 직접 확정했을 때, 그 회차의 확정 예약 고객과 사업장 구성원에게 알린다.
 * 개최가 확정된(goConfirmedAt) 시작 전 회차에만 보낸다. 최소 인원 조건이 없는 회차는 고객 화면에
 * "모으는 중" 표시가 없었으므로 알리지 않는다. 사업자가 직접 넣은 예약(MANUAL)의 손님에게는 보내지 않는다.
 */
export async function onSlotGoConfirmed(slotId: string): Promise<void> {
  await safely("onSlotGoConfirmed", slotId, undefined, async () => {
    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
      select: {
        id: true,
        status: true,
        startAt: true,
        goConfirmedAt: true,
        seats: { select: { minCount: true } },
        product: { select: { title: true } },
        business: { select: { name: true, members: { select: { userId: true } } } },
      },
    });
    if (!slot || slot.status === "CANCELLED" || !slot.goConfirmedAt || slot.startAt.getTime() <= Date.now()) return;
    if (!slot.seats.some((seat) => seat.minCount > 0)) return;

    const bookings = await prisma.booking.findMany({
      where: { slotId: slot.id, status: "CONFIRMED", channel: { not: "MANUAL" } },
      include: bookingInclude,
      orderBy: { createdAt: "asc" },
    });
    for (const booking of bookings) {
      const key = `SLOT_GO_CONFIRMED:${slot.id}:${booking.id}`;
      await notifyCustomer(booking, {
        type: "SLOT_GO_CONFIRMED",
        title: "개최가 확정됐어요",
        body: smsLines(bookingLine(booking), `${booking.business.name}에서 예정대로 열려요. 그날 만나요.`),
        dedupeKey: key,
        sms: {
          platform: {
            templateKey: "PLATFORM_SLOT_GO_CONFIRMED",
            dedupeKey: key,
            text: smsLines(
              "[남는자리] 개최가 확정됐어요.",
              `${booking.business.name} · ${booking.product.title}`,
              `${fmtDateTime(booking.slot.startAt)} · ${booking.quantity}명`,
              "예정대로 열려요. 그날 만나요.",
              bookingPublicUrl(booking),
            ),
          },
        },
      });
    }

    await sendToMembers(slot.business.members, {
      type: "SLOT_GO_CONFIRMED",
      title: "개최가 확정됐어요",
      body: `${slot.product.title} · ${fmtDateTime(slot.startAt)}\n예약한 고객에게도 알렸어요.`,
      linkUrl: notificationLinks.sellerSlot(slot.id),
      data: { slotId: slot.id },
      dedupeKey: `SLOT_GO_CONFIRMED:${slot.id}:seller`,
    });
  });
}

/**
 * 회차 취소(사업자·운영자 취소, 최소 인원 미달 등). 취소된(CANCELLED) 회차에만 보낸다.
 * - 회차와 함께 취소된 예약의 고객: 사유와 전액 환불 안내(앱 + 문자, 수신 설정과 무관).
 *   예약별로 onBookingCancelled 를 함께 불러도 안내는 한 번만 나간다.
 * - 그 회차를 기다리던 대기자: 대기가 끝났다는 앱 알림
 * - 사업장 구성원: 취소 사유와 함께 취소된 예약 수. options.excludeUserId 로 직접 취소한 구성원은 뺄 수 있다.
 * reason 은 고객에게 보이는 사유다(운영자가 취소한 예약에는 보여 주지 않는다).
 */
export async function onSlotCancelled(slotId: string, reason: string, options: { excludeUserId?: string } = {}): Promise<void> {
  await safely("onSlotCancelled", slotId, undefined, async () => {
    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
      select: {
        id: true,
        status: true,
        startAt: true,
        cancelledAt: true,
        cancelReason: true,
        product: { select: { title: true } },
        business: { select: { name: true, members: { select: { userId: true } } } },
      },
    });
    if (!slot || slot.status !== "CANCELLED") return;
    const why = cancelReasonLine(typeof reason === "string" && reason.trim() ? reason : slot.cancelReason);
    const what = `${slot.product.title} · ${fmtDateTime(slot.startAt)}`;

    // 회차 취소와 함께 취소된 예약만 고른다(그 전에 따로 취소된 예약은 이미 안내를 받았다).
    const bookings = await prisma.booking.findMany({
      where: {
        slotId: slot.id,
        status: "CANCELLED",
        cancelledBy: { in: ["SELLER", "ADMIN", "SYSTEM"] },
        ...(slot.cancelledAt ? { cancelledAt: { gte: new Date(slot.cancelledAt.getTime() - MINUTE) } } : {}),
      },
      include: bookingInclude,
      orderBy: { createdAt: "asc" },
    });
    for (const booking of bookings) {
      await notifyForcedCancel(booking, {
        type: "SLOT_CANCELLED",
        title: "회차가 취소돼 예약도 함께 취소됐어요",
        smsHead: "[남는자리] 회차가 취소돼 예약도 함께 취소됐어요.",
        reason: why,
      });
    }

    const waiters = await prisma.waitlistEntry.findMany({
      where: { slotId: slot.id, status: { in: ["WAITING", "OFFERED", "CLOSED"] } },
      select: { userId: true },
      distinct: ["userId"],
    });
    await notifyMany(
      waiters.map((w) => ({
        userId: w.userId,
        type: "SLOT_CANCELLED" as const,
        title: "기다리던 회차가 취소됐어요",
        body: `${slot.business.name} · ${what}\n대기는 자동으로 끝났어요. 다른 날짜의 자리를 살펴보세요.`,
        linkUrl: notificationLinks.slot(slot.id),
        data: { slotId: slot.id },
        dedupeKey: `SLOT_CANCELLED:${slot.id}:waitlist:${w.userId}`,
      })),
    );

    await sendToMembers(slot.business.members, {
      type: "SLOT_CANCELLED",
      title: "회차가 취소됐어요",
      body: smsLines(what, why, bookings.length > 0 ? `예약 ${bookings.length}건이 함께 취소됐고, 결제한 금액은 전액 환불돼요.` : null),
      linkUrl: notificationLinks.sellerSlot(slot.id),
      data: { slotId: slot.id, cancelledBookings: bookings.length },
      dedupeKey: `SLOT_CANCELLED:${slot.id}:seller`,
      excludeUserIds: options.excludeUserId ? [options.excludeUserId] : undefined,
    });
  });
}

// ── 노쇼 ──────────────────────────────────────────────

export interface NoShowNotice {
  /** 이번 노쇼로 예약이 제한됐다면 그 기한 */
  restrictedUntil?: Date | null;
  /** 최근 noShowWindowDays 동안의 노쇼 횟수(이번 건 포함) */
  countInWindow: number;
  /** 예약이 제한되는 횟수(noShowLimit) */
  limit: number;
}

/**
 * 노쇼 처리 안내(6.8). 노쇼(NO_SHOW) 상태인 회원 예약에만 보낸다.
 * - 한도 전이면 경고(몇 회가 되면 얼마 동안 제한되는지), 제한이 걸렸으면 기한을 알린다. 제한 안내 문자는 수신 설정과 무관하게 보낸다.
 * - 잘못 처리된 경우를 위해 이의제기 기한(72시간)을 함께 알린다.
 * 사업자가 노쇼를 되돌렸다가 다시 처리하면(noShowAt 이 달라짐) 새로 알린다.
 */
export async function onNoShowMarked(bookingId: string, info: NoShowNotice): Promise<void> {
  await safely("onNoShowMarked", bookingId, undefined, async () => {
    const booking = await loadBooking(bookingId);
    // 사업자가 직접 넣은 비회원 예약에는 계정 제한이 없으므로 알리지 않는다.
    if (!booking || booking.status !== "NO_SHOW" || !booking.userId) return;
    const now = new Date();
    const settings = await getSettings();
    const count = Math.max(1, Math.floor(Number(info.countInWindow) || 1));
    const limit = Math.max(1, Math.floor(Number(info.limit) || settings.noShowLimit));
    const restrictedUntil = info.restrictedUntil instanceof Date && info.restrictedUntil.getTime() > now.getTime() ? info.restrictedUntil : null;
    const markedAt = booking.noShowAt ?? now;
    const disputeUntil = new Date(markedAt.getTime() + HELP_FACTS.noShowDisputeHours * HOUR);

    const status = restrictedUntil
      ? `최근 ${settings.noShowWindowDays}일 동안 노쇼가 ${count}회가 되어 ${fmtDate(restrictedUntil)}까지 새 예약을 할 수 없어요.`
      : count < limit
        ? `최근 ${settings.noShowWindowDays}일 동안 노쇼 ${count}회예요. ${limit}회가 되면 ${settings.noShowRestrictDays}일 동안 새 예약이 제한돼요.`
        : `최근 ${settings.noShowWindowDays}일 동안 노쇼 ${count}회예요.`;
    const dispute = `참석하셨거나 처리가 잘못됐다면 ${HELP_FACTS.noShowDisputeHours}시간 안에 예약 상세에서 이의를 제기해 주세요.`;
    const key = `NO_SHOW:${booking.id}:${markedAt.getTime()}`;

    await notifyCustomer(booking, {
      type: "NO_SHOW_NOTICE",
      title: restrictedUntil ? "노쇼로 처리돼 새 예약이 잠시 제한돼요" : "예약이 노쇼로 처리됐어요",
      body: smsLines(bookingLine(booking), status, dispute),
      data: {
        countInWindow: count,
        limit,
        restrictedUntil: restrictedUntil ? restrictedUntil.toISOString() : null,
        disputeUntil: disputeUntil.toISOString(),
      },
      dedupeKey: key,
      sms: {
        essential: restrictedUntil !== null,
        platform: {
          templateKey: "PLATFORM_NO_SHOW_NOTICE",
          dedupeKey: key,
          text: smsLines(
            "[남는자리] 예약이 노쇼로 처리됐어요.",
            `${booking.business.name} · ${booking.product.title}`,
            fmtDateTime(booking.slot.startAt),
            status,
            dispute,
            bookingPublicUrl(booking),
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

/** 리마인드에 넣는 이른 취소 권유 — 사업자 기본 문자 템플릿(templates.ts)과 같은 문장이다. */
const CANCEL_EARLY_LINE = "못 오시게 되면 미리 취소해 주세요. 다른 분이 자리를 이어받을 수 있어요.";

/**
 * 예약 리마인드(종류별로 예약당 한 번). 확정 상태이고 아직 시작 전인 예약에만 보낸다.
 * 언제 부를지는 호출부(주기 작업)가 정한다 — 사업자별 발송 시점까지 반영하려면 sendDueReminders 를 쓴다.
 * 앱 알림에는 참석 확정 권유(아직 확정하지 않았을 때), 이른 취소 권유, 지금 취소할 때의 환불 기준을 함께 넣는다(6.8).
 * 알림을 누르면 예약 상세로 가고, 그 화면에서 참석 확정·취소를 한다(data.attendanceConfirmed 로 버튼 상태를 정한다).
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

    const attendanceConfirmed = booking.attendanceConfirmedAt !== null;

    const delivered = await notifyCustomer(booking, {
      type: "BOOKING_REMINDER",
      title: kind === "DAY_BEFORE" ? `${fmtDayLabel(booking.slot.startAt, now)} 예약이 있어요` : "곧 예약 시간이에요",
      body: smsLines(
        bookingLine(booking),
        place ? `장소: ${place}` : null,
        attendanceConfirmed ? null : "오실 수 있다면 '참석 확정'을 눌러 주세요.",
        CANCEL_EARLY_LINE,
        await currentRefundLine(booking, now),
      ),
      data: { kind, attendanceConfirmed },
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
