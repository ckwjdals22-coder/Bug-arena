import "server-only";
import { z } from "zod";
import type { Booking, BookingChannel, BookingStatus, PaymentMethod, PaymentPolicy, Prisma, SeatGender, SlotStatus } from "@/generated/prisma/client";
import { ACTIVE_BOOKING_STATUSES, describeCancellationTiers, parseCancellationTiers, type CancellationTier } from "@/lib/domain";
import { normalizePhone } from "@/lib/format";
import { newBookingCode, newToken } from "@/lib/ids";
import { formatKRW } from "@/lib/money";
import { MINUTE } from "@/lib/time";
import { assertBusinessAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { AppError, err, type ErrorCode } from "@/server/errors";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { snapshotCommission } from "@/server/services/commission";
import { recordConsents } from "@/server/services/consent";
import { confirmedCountBySeat, releaseSeats, reserveSeats } from "@/server/services/inventory";
import { onBookingPendingApproval } from "@/server/services/notifications/events";
import { createPaymentOrder } from "@/server/services/payments";
import { afterSeatsReleased } from "@/server/services/vacancy";
import { getSettings, type PlatformSettings } from "@/server/settings";
import { assertBookingEligibility, checkBookingEligibility, checkSlotBookable, type EligibilityUser } from "./eligibility";
import { getGoState, type GoStateInfo } from "./go";
import { afterBookingConfirmed, finalizePaidBooking, reclaimExpiredHolds } from "./lifecycle";
import {
  MAX_PENDING_PAYMENTS,
  MSG_BOOKING_NOT_FOUND,
  computeAmounts,
  guestNameSchema,
  guestPhoneSchema,
  idSchema,
  isUniqueViolation,
  lockKey,
  optionalText,
  parseInput,
  quantitySchema,
  runTx,
  safely,
  toBookingSummary,
  type BookingSummary,
  type Tx,
} from "./shared";

/**
 * 예약 만들기 — 예약 전 견적, 고객 예약, 사업자 직접 입력 예약, 이어서 결제.
 * 좌석 확보·예약 생성·동의 기록·결제 주문 생성은 하나의 트랜잭션이다.
 */

const MSG_ALREADY_BOOKED = "이미 이 회차를 예약하셨어요.";
const MSG_SEAT_NOT_FOUND = "자리를 찾을 수 없어요. 목록에서 다시 골라 주세요.";
const MSG_PENDING_CAP = `결제를 기다리는 예약이 ${MAX_PENDING_PAYMENTS}건 있어요. 먼저 결제를 마치거나 취소해 주세요.`;
/** 예약번호·체크인 토큰이 드물게 겹쳤을 때 다시 시도하는 횟수 */
const CODE_RETRIES = 3;

// ── 좌석·회차·상품·사업장 불러오기 ────────────────────

const seatContextInclude = {
  slot: {
    include: {
      seats: { select: { id: true, label: true, minCount: true }, orderBy: { sort: "asc" } },
      product: {
        select: {
          id: true,
          title: true,
          status: true,
          images: true,
          placeName: true,
          minAge: true,
          maxAge: true,
          requiresIdentity: true,
          requiresApproval: true,
          maxPerBooking: true,
          resaleRefundRate: true,
          paymentPolicy: true,
          depositAmount: true,
          cancellationTiers: true,
        },
      },
      business: {
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          representativeName: true,
          businessRegNo: true,
          mailOrderRegNo: true,
          phone: true,
          address: true,
          addressDetail: true,
        },
      },
    },
  },
} satisfies Prisma.SlotSeatInclude;

type SeatContext = Prisma.SlotSeatGetPayload<{ include: typeof seatContextInclude }>;

async function loadSeatContext(slotSeatId: string): Promise<SeatContext> {
  const seat = await prisma.slotSeat.findUnique({ where: { id: slotSeatId }, include: seatContextInclude });
  if (!seat) throw err.notFound(MSG_SEAT_NOT_FOUND);
  return seat;
}

const eligibilityUserSelect = {
  id: true,
  status: true,
  gender: true,
  birthYear: true,
  identityVerifiedAt: true,
  bookingRestrictedUntil: true,
} satisfies Prisma.UserSelect;

const toEligibilityContext = (seat: SeatContext) => ({
  slot: seat.slot,
  product: seat.slot.product,
  business: seat.slot.business,
  seat: { gender: seat.gender },
});

/** 판매자 신원정보 — 통신판매중개의 법정 표시 사항(결제 전 화면에 항상 보여 준다) */
export interface SellerIdentityBlock {
  name: string;
  representativeName: string | null;
  businessRegNo: string | null;
  mailOrderRegNo: string | null;
  phone: string | null;
  /** 사업장 소재지(등록 주소) */
  address: string | null;
}

export function toSellerIdentity(business: {
  name: string;
  representativeName: string | null;
  businessRegNo: string | null;
  mailOrderRegNo: string | null;
  phone: string | null;
  address: string | null;
  addressDetail: string | null;
}): SellerIdentityBlock {
  return {
    name: business.name,
    representativeName: business.representativeName,
    businessRegNo: business.businessRegNo,
    mailOrderRegNo: business.mailOrderRegNo,
    phone: business.phone,
    address: [business.address, business.addressDetail].filter(Boolean).join(" ") || null,
  };
}

/** 이 회원이 이 좌석에서 받은, 아직 응답 시간이 남은 자리 제안 */
async function findActiveOffer(db: Tx | typeof prisma, userId: string, slotSeatId: string, now: Date) {
  return db.waitlistEntry.findFirst({
    where: { userId, slotSeatId, status: "OFFERED", offerExpiresAt: { gt: now } },
    select: { id: true, quantity: true, offerExpiresAt: true },
  });
}

// ── 예약 전 견적 ──────────────────────────────────────

const quoteSchema = z.object({
  userId: idSchema.nullish(),
  slotSeatId: idSchema,
  quantity: quantitySchema,
  waitlistEntryId: idSchema.nullish(),
});

export interface BookingQuote {
  serverTime: Date;
  slot: { id: string; startAt: Date; endAt: Date; bookingDeadlineAt: Date; status: SlotStatus; note: string | null };
  product: {
    id: string;
    title: string;
    image: string | null;
    placeName: string | null;
    requiresApproval: boolean;
    requiresIdentity: boolean;
    paymentPolicy: PaymentPolicy;
    minAge: number | null;
    maxAge: number | null;
  };
  seat: { id: string; label: string; gender: SeatGender; price: number; originalPrice: number | null };
  business: { id: string; slug: string; name: string };
  seller: SellerIdentityBlock;
  quantity: number;
  unitPrice: number;
  /** 고객이 내는 총액. 고객에게 붙는 수수료는 없다 */
  totalAmount: number;
  payNowAmount: number;
  payOnsiteAmount: number;
  paymentMethod: PaymentMethod;
  policy: { tiers: CancellationTier[]; lines: { when: string; refund: string }[] };
  /** 이 예약에 적용되는 예약 직후 무료 취소 시간(분). 시작이 임박해 적용되지 않으면 0 */
  graceMinutes: number;
  /** 재판매 연동 환불율(%). 상품이 쓰지 않거나 온라인 결제가 아니면 null */
  resaleRefundRate: number | null;
  /** 결제 대기 중 좌석을 잡아 두는 시간(분) */
  holdMinutes: number;
  /** 지금 이 회원이 예약할 수 있는 좌석 수(공개된 남은 자리 + 본인에게 제안된 자리) */
  remaining: number;
  /** 한 번에 예약할 수 있는 최대 인원 = min(상품의 1회 최대 인원, remaining) */
  maxQuantity: number;
  go: GoStateInfo;
  /** 본인에게 온 자리 제안(있으면 이 좌석이 잡혀 있다) */
  offer: { entryId: string; quantity: number; expiresAt: Date } | null;
  eligibility: { ok: boolean; reason?: string; code?: ErrorCode };
}

/**
 * 결제 화면에 필요한 값을 한 번에 돌려준다. 금액은 모두 DB 값으로 계산한다.
 * 예약할 수 없는 사유는 예외가 아니라 eligibility 로 알려 준다(없는 좌석만 NOT_FOUND).
 */
export async function getBookingQuote(input: { userId?: string | null; slotSeatId: string; quantity: number; waitlistEntryId?: string | null }): Promise<BookingQuote> {
  const data = parseInput(quoteSchema, input);
  const now = new Date();
  const [seat, settings] = await Promise.all([loadSeatContext(data.slotSeatId), getSettings()]);
  const { slot } = seat;
  const { product, business } = slot;
  const user = data.userId ? await prisma.user.findUnique({ where: { id: data.userId }, select: eligibilityUserSelect }) : null;

  const offer = user ? await findActiveOffer(prisma, user.id, seat.id, now) : null;
  const usableOffer = offer && (!data.waitlistEntryId || data.waitlistEntryId === offer.id) ? offer : null;
  const remaining = Math.max(0, seat.capacity - seat.reserved) + (usableOffer?.quantity ?? 0);
  const maxQuantity = Math.min(product.maxPerBooking, remaining);
  const amounts = computeAmounts(product, seat.price, data.quantity);
  const tiers = parseCancellationTiers(product.cancellationTiers);
  const leadMs = slot.startAt.getTime() - now.getTime();

  let eligibility: BookingQuote["eligibility"];
  if (!user) {
    const bookable = checkSlotBookable(toEligibilityContext(seat), now);
    eligibility = bookable.ok ? { ok: false, code: "UNAUTHENTICATED", reason: "로그인한 뒤 예약할 수 있어요." } : { ok: false, code: bookable.code, reason: bookable.reason };
  } else {
    const result = await checkBookingEligibility(user, toEligibilityContext(seat), { now });
    if (!result.ok) eligibility = { ok: false, code: result.code, reason: result.reason };
    else eligibility = await checkQuoteLimits(user.id, slot.id, data.quantity, product.maxPerBooking, remaining, now);
  }

  return {
    serverTime: now,
    slot: { id: slot.id, startAt: slot.startAt, endAt: slot.endAt, bookingDeadlineAt: slot.bookingDeadlineAt, status: slot.status, note: slot.note },
    product: {
      id: product.id,
      title: product.title,
      image: product.images[0] ?? null,
      placeName: product.placeName,
      requiresApproval: product.requiresApproval,
      requiresIdentity: product.requiresIdentity,
      paymentPolicy: product.paymentPolicy,
      minAge: product.minAge,
      maxAge: product.maxAge,
    },
    seat: {
      id: seat.id,
      label: seat.label,
      gender: seat.gender,
      price: seat.price,
      originalPrice: seat.originalPrice !== null && seat.originalPrice > seat.price ? seat.originalPrice : null,
    },
    business: { id: business.id, slug: business.slug, name: business.name },
    seller: toSellerIdentity(business),
    quantity: data.quantity,
    unitPrice: seat.price,
    ...amounts,
    policy: { tiers, lines: describeCancellationTiers(tiers) },
    graceMinutes: leadMs >= settings.cancelGraceMinLeadMinutes * MINUTE ? settings.cancelGraceMinutes : 0,
    resaleRefundRate: amounts.paymentMethod === "ONLINE" ? product.resaleRefundRate : null,
    holdMinutes: settings.holdMinutes,
    remaining,
    maxQuantity,
    go: getGoState(slot, await confirmedCountBySeat(slot.id)),
    offer: usableOffer ? { entryId: usableOffer.id, quantity: usableOffer.quantity, expiresAt: usableOffer.offerExpiresAt ?? now } : null,
    eligibility,
  };
}

async function checkQuoteLimits(
  userId: string,
  slotId: string,
  quantity: number,
  maxPerBooking: number,
  remaining: number,
  now: Date,
): Promise<BookingQuote["eligibility"]> {
  const active = await prisma.booking.findFirst({
    where: {
      userId,
      slotId,
      OR: [{ status: { in: ["PENDING_APPROVAL", "CONFIRMED"] } }, { status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } }],
    },
    select: { id: true },
  });
  if (active) return { ok: false, code: "CONFLICT", reason: MSG_ALREADY_BOOKED };
  if (quantity > maxPerBooking) return { ok: false, code: "VALIDATION", reason: `한 번에 ${maxPerBooking}명까지 예약할 수 있어요.` };
  if (remaining === 0) return { ok: false, code: "SOLD_OUT", reason: "방금 자리가 마감됐어요." };
  if (quantity > remaining) return { ok: false, code: "SOLD_OUT", reason: `남은 자리가 ${remaining}석이에요. 인원을 줄여 주세요.` };
  const pending = await prisma.booking.count({ where: { userId, status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } } });
  if (pending >= MAX_PENDING_PAYMENTS) return { ok: false, code: "CONFLICT", reason: MSG_PENDING_CAP };
  return { ok: true };
}

// ── 고객 예약 ─────────────────────────────────────────

const createSchema = z.object({
  userId: idSchema,
  slotSeatId: idSchema,
  quantity: quantitySchema,
  guestName: guestNameSchema,
  guestPhone: guestPhoneSchema,
  requestNote: optionalText(300, "요청 사항은 300자까지 쓸 수 있어요."),
  idempotencyKey: z
    .string("요청을 다시 시도해 주세요.")
    .regex(/^[A-Za-z0-9_.:-]{8,64}$/, "요청 정보가 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요."),
  channel: z.enum(["MARKETPLACE", "DIRECT"]).default("MARKETPLACE"),
  source: z
    .string()
    .regex(/^[a-z0-9_:-]{1,40}$/, "유입 경로 값이 올바르지 않아요.")
    .nullish(),
  waitlistEntryId: idSchema.nullish(),
  /** 화면에 보여 준 총액(선택). 그사이 가격이 바뀌었으면 예약하지 않는다 */
  expectedTotalAmount: z.number().int().min(0).max(1_000_000_000).nullish(),
  agreePolicy: z.literal(true, "취소·환불 기준을 확인하고 동의해 주세요."),
  agreeThirdParty: z.literal(true, "판매자에게 예약 정보를 제공하는 데 동의해 주세요."),
  ip: z.string().max(64).nullish(),
});

export type CreateBookingInput = z.input<typeof createSchema>;

export interface CreateBookingResult {
  booking: BookingSummary;
  /** PAY: 결제창으로 이동 · DONE: 더 할 일이 없다(확정됐거나 승인 대기) */
  next: "PAY" | "DONE";
  /** next 가 PAY 일 때 결제창에 넘길 주문번호와 금액 */
  payment?: { orderId: string; amount: number };
}

/** 결제창을 열 수 있는 주문(결제사에 승인을 요청한 적 없는 READY 주문) */
async function findPayableOrder(bookingId: string): Promise<{ orderId: string; amount: number } | null> {
  return prisma.payment.findFirst({
    where: { bookingId, status: "READY", paymentKey: null, failCode: null },
    orderBy: { createdAt: "desc" },
    select: { orderId: true, amount: true },
  });
}

async function toCreateResult(booking: Booking, now: Date): Promise<CreateBookingResult> {
  const summary = toBookingSummary(booking);
  const holding = booking.status === "PENDING_PAYMENT" && booking.holdExpiresAt !== null && booking.holdExpiresAt.getTime() > now.getTime();
  const payment = holding ? await findPayableOrder(booking.id) : null;
  return payment ? { booking: summary, next: "PAY", payment } : { booking: summary, next: "DONE" };
}

interface CreatedBooking {
  kind: "CREATED";
  booking: Booking;
  /** 제안받은 좌석 중 쓰지 않고 돌려놓은 수 */
  offerLeftover: number;
}

type CreateOutcome = CreatedBooking | { kind: "EXISTING"; booking: Booking };

function assertSameRequest(existing: Booking, slotSeatId: string): void {
  if (existing.slotSeatId !== slotSeatId) {
    throw err.conflict("이미 처리된 요청이에요. 화면을 새로고침한 뒤 다시 시도해 주세요.");
  }
}

/** 예약 트랜잭션 안에서 회차 행을 공유 잠금으로 읽는다 — 회차 취소·좌석 삭제가 진행 중인 예약이 끝나기를 기다리게 한다. */
async function lockSlotShared(tx: Tx, slotId: string): Promise<{ status: SlotStatus; startAt: Date; endAt: Date; bookingDeadlineAt: Date }> {
  const rows = await tx.$queryRaw<{ status: SlotStatus; startAt: Date; endAt: Date; bookingDeadlineAt: Date }[]>`
    SELECT "status"::text AS "status", "startAt", "endAt", "bookingDeadlineAt" FROM "Slot" WHERE "id" = ${slotId} FOR SHARE`;
  const row = rows[0];
  if (!row) throw err.notFound(MSG_SEAT_NOT_FOUND);
  return row;
}

async function createInTx(
  tx: Tx,
  data: z.output<typeof createSchema>,
  seat: SeatContext,
  settings: PlatformSettings,
  now: Date,
): Promise<CreateOutcome> {
  const { slot } = seat;
  const { product, business } = slot;

  // 같은 회원의 예약 생성은 줄 세운다: 이중 제출·동시 예약·결제 대기 건수 제한을 정확히 판단하기 위해서다.
  await lockKey(tx, `booking:user:${data.userId}`);
  const duplicate = await tx.booking.findUnique({ where: { userId_idempotencyKey: { userId: data.userId, idempotencyKey: data.idempotencyKey } } });
  if (duplicate) {
    assertSameRequest(duplicate, data.slotSeatId);
    return { kind: "EXISTING", booking: duplicate };
  }
  const active = await tx.booking.findFirst({
    where: { userId: data.userId, slotId: slot.id, status: { in: ACTIVE_BOOKING_STATUSES } },
    select: { id: true },
  });
  if (active) throw err.conflict(MSG_ALREADY_BOOKED);
  const pending = await tx.booking.count({ where: { userId: data.userId, status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } } });
  if (pending >= MAX_PENDING_PAYMENTS) throw err.conflict(MSG_PENDING_CAP);

  const current = await lockSlotShared(tx, slot.id);
  if (current.status !== "OPEN") throw err.closed(current.status === "CANCELLED" ? "취소된 회차예요. 다른 자리를 찾아봐 주세요." : "판매가 마감된 회차예요. 다른 자리를 찾아봐 주세요.");
  if (current.startAt.getTime() <= now.getTime() || current.bookingDeadlineAt.getTime() <= now.getTime()) {
    throw err.closed("예약 마감 시간이 지났어요. 다른 자리를 찾아봐 주세요.");
  }

  // 좌석: 받은 제안이 있으면 이미 잡혀 있는 좌석을 쓰고, 모자라는 만큼만 새로 확보한다.
  let offerLeftover = 0;
  let convertedEntryId: string | null = null;
  const offer = data.waitlistEntryId ? await loadOffer(tx, data.waitlistEntryId, data.userId, seat.id, now) : await findActiveOffer(tx, data.userId, seat.id, now);
  let toReserve = data.quantity;
  if (offer) {
    const claimed = await tx.waitlistEntry.updateMany({
      where: { id: offer.id, status: "OFFERED", offerExpiresAt: { gt: now } },
      data: { status: "CONVERTED" },
    });
    if (claimed.count !== 1) throw err.conflict("이미 처리된 자리 제안이에요. 화면을 새로고침해 주세요.");
    convertedEntryId = offer.id;
    toReserve = Math.max(0, data.quantity - offer.quantity);
    offerLeftover = Math.max(0, offer.quantity - data.quantity);
    if (offerLeftover > 0 && !(await releaseSeats(tx, seat.id, offerLeftover, { withhold: false }))) {
      throw new Error(`좌석 재고와 자리 제안이 어긋났습니다: entry=${offer.id}`);
    }
  }
  if (toReserve > 0 && !(await reserveSeats(tx, seat.id, toReserve))) throw err.soldOut();

  // 가격은 좌석을 잡은 뒤의 최신 값으로 계산한다(잡은 뒤에는 이 트랜잭션이 끝날 때까지 바뀌지 않는다).
  const priced = await tx.slotSeat.findUniqueOrThrow({ where: { id: seat.id }, select: { price: true } });
  const amounts = computeAmounts(product, priced.price, data.quantity);
  if (data.expectedTotalAmount != null && data.expectedTotalAmount !== amounts.totalAmount) {
    throw err.conflict(`그사이 가격이 바뀌었어요. 총 ${formatKRW(amounts.totalAmount)}인지 확인한 뒤 다시 예약해 주세요.`);
  }

  const status: BookingStatus = amounts.paymentMethod === "ONLINE" ? "PENDING_PAYMENT" : product.requiresApproval ? "PENDING_APPROVAL" : "CONFIRMED";
  const holdUntil = new Date(Math.min(now.getTime() + settings.holdMinutes * MINUTE, current.startAt.getTime()));
  const channel: BookingChannel = offer ? "WAITLIST" : data.channel;

  let booking = await tx.booking.create({
    data: {
      code: newBookingCode(),
      userId: data.userId,
      businessId: business.id,
      productId: product.id,
      slotId: slot.id,
      slotSeatId: seat.id,
      quantity: data.quantity,
      unitPrice: priced.price,
      ...amounts,
      status,
      channel,
      source: data.source ?? (offer ? "waitlist_offer" : null),
      paymentState: "UNPAID",
      guestName: data.guestName,
      guestPhone: data.guestPhone,
      requestNote: data.requestNote,
      policySnapshot: parseCancellationTiers(product.cancellationTiers) as unknown as Prisma.InputJsonValue,
      policyAgreedAt: now,
      thirdPartyConsentAt: now,
      resaleRefundRate: product.resaleRefundRate,
      holdExpiresAt: status === "PENDING_PAYMENT" ? holdUntil : null,
      confirmedAt: status === "CONFIRMED" ? now : null,
      checkinToken: newToken(),
      idempotencyKey: data.idempotencyKey,
      createdAt: now,
    },
  });

  if (convertedEntryId) await tx.waitlistEntry.update({ where: { id: convertedEntryId }, data: { bookingId: booking.id } });

  await recordConsents(
    [
      { userId: data.userId, kind: "THIRD_PARTY", agreed: true, bookingId: booking.id, detail: business.name, ip: data.ip },
      { userId: data.userId, kind: "REFUND_POLICY", agreed: true, bookingId: booking.id, ip: data.ip },
    ],
    tx,
  );

  if (status === "PENDING_PAYMENT") {
    await createPaymentOrder(tx, { bookingId: booking.id, amount: amounts.payNowAmount });
  } else if (status === "CONFIRMED") {
    const snap = await snapshotCommission(tx, booking, { settings, now });
    booking = await tx.booking.update({
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
  return { kind: "CREATED", booking, offerLeftover };
}

/** 고객이 지정한 자리 제안을 확인한다: 본인 것이고, 제안 중이며, 시간이 남아 있고, 같은 좌석이어야 한다. */
async function loadOffer(tx: Tx, entryId: string, userId: string, slotSeatId: string, now: Date) {
  const entry = await tx.waitlistEntry.findUnique({
    where: { id: entryId },
    select: { id: true, userId: true, slotSeatId: true, status: true, quantity: true, offerExpiresAt: true },
  });
  if (!entry || entry.userId !== userId) throw err.notFound("자리 제안을 찾을 수 없어요.");
  if (entry.slotSeatId !== slotSeatId) throw err.validation("다른 좌석에 대한 자리 제안이에요. 제안받은 좌석으로 예약해 주세요.");
  if (entry.status !== "OFFERED") throw err.conflict("이미 처리된 자리 제안이에요. 화면을 새로고침해 주세요.");
  if (!entry.offerExpiresAt || entry.offerExpiresAt.getTime() <= now.getTime()) {
    throw err.closed("자리 제안 시간이 지났어요. 자리가 남아 있으면 바로 예약하거나 다시 대기해 주세요.");
  }
  return entry;
}

/**
 * 예약이 생긴 뒤 같은 회차에 남아 있는 이 회원의 다른 대기를 정리한다.
 * 같은 좌석 유형의 대기는 예약으로 이어진 것으로(CONVERTED), 다른 좌석 유형의 대기는 취소로(CANCELLED) 닫는다.
 * 제안 중이던 대기는 잡아 둔 좌석을 돌려놓고 다음 대기자에게 넘긴다.
 */
async function closeOtherWaitlistEntries(booking: Booking): Promise<void> {
  if (!booking.userId) return;
  const entries = await prisma.waitlistEntry.findMany({
    where: { userId: booking.userId, slotId: booking.slotId, status: { in: ["WAITING", "OFFERED"] } },
    select: { id: true, slotSeatId: true, status: true, quantity: true },
  });
  for (const entry of entries) {
    const status = entry.slotSeatId === booking.slotSeatId ? "CONVERTED" : "CANCELLED";
    if (entry.status === "WAITING") {
      await prisma.waitlistEntry.updateMany({ where: { id: entry.id, status: "WAITING" }, data: { status } });
      continue;
    }
    const released = await runTx(async (tx) => {
      const updated = await tx.waitlistEntry.updateMany({ where: { id: entry.id, status: "OFFERED" }, data: { status } });
      if (updated.count !== 1) return false;
      if (!(await releaseSeats(tx, entry.slotSeatId, entry.quantity, { withhold: false }))) {
        throw new Error(`좌석 재고와 자리 제안이 어긋났습니다: entry=${entry.id}`);
      }
      return true;
    });
    if (released) {
      await afterSeatsReleased(entry.slotSeatId, { reason: "OFFER_EXPIRED", quantity: entry.quantity, withheld: false, excludeUserIds: [booking.userId] });
    }
  }
}

/**
 * 고객 예약. 자격 확인 → (트랜잭션) 좌석 확보·예약 생성·동의 기록·결제 주문 → (뒤처리) 대기 정리·알림·확정 뒤처리.
 * - 같은 (userId, idempotencyKey) 로 다시 부르면 처음 만든 예약을 그대로 돌려준다.
 * - 온라인 결제면 PENDING_PAYMENT(좌석 홀드) + 결제 주문, 승인제면 PENDING_APPROVAL, 그 밖에는 바로 CONFIRMED.
 * - 받은 자리 제안이 있으면(waitlistEntryId 를 주지 않아도) 잡혀 있는 좌석으로 예약하고 채널을 WAITLIST 로 남긴다.
 * 오류: SOLD_OUT(매진), CLOSED(마감·취소), CONFLICT(이미 예약함·결제 대기 3건), VALIDATION·FORBIDDEN(자격), RATE_LIMITED.
 */
export async function createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
  const data = parseInput(createSchema, input);
  const now = new Date();

  const replay = await prisma.booking.findUnique({ where: { userId_idempotencyKey: { userId: data.userId, idempotencyKey: data.idempotencyKey } } });
  if (replay) {
    assertSameRequest(replay, data.slotSeatId);
    return toCreateResult(replay, now);
  }

  await enforceRateLimit(`booking:user:${data.userId}`, 20, 600, "예약 시도가 너무 많아요. 10분쯤 뒤에 다시 시도해 주세요.");

  const [seat, user, settings] = await Promise.all([
    loadSeatContext(data.slotSeatId),
    prisma.user.findUnique({ where: { id: data.userId }, select: eligibilityUserSelect }),
    getSettings(),
  ]);
  if (!user) throw err.unauthenticated();
  await assertBookingEligibility(user as EligibilityUser, toEligibilityContext(seat), { now, guestPhone: data.guestPhone });
  if (data.quantity > seat.slot.product.maxPerBooking) {
    throw err.validation(`한 번에 ${seat.slot.product.maxPerBooking}명까지 예약할 수 있어요.`, { quantity: `${seat.slot.product.maxPerBooking}명까지 예약할 수 있어요.` });
  }
  // 시간이 지난 내 결제 대기는 주기 작업을 기다리지 않고 바로 정리한다.
  await reclaimExpiredHolds({ userId: data.userId }, now);

  let outcome: CreateOutcome | null = null;
  let reclaimedForSeat = false;
  for (let attempt = 0; outcome === null; attempt += 1) {
    try {
      outcome = await runTx((tx) => createInTx(tx, data, seat, settings, now));
    } catch (e) {
      if (e instanceof AppError && e.code === "SOLD_OUT" && !reclaimedForSeat) {
        // 매진처럼 보여도 시간이 지난 홀드가 좌석을 잡고 있을 수 있다. 회수한 좌석이 있으면 한 번 더 시도한다.
        reclaimedForSeat = true;
        if ((await reclaimExpiredHolds({ slotSeatId: seat.id }, new Date())) > 0) continue;
      }
      if (!isUniqueViolation(e)) throw e;
      // 유니크 위반: 이중 제출(같은 키) → 처음 만든 예약 / 같은 회차의 진행 중 예약 → 충돌 / 예약번호 충돌 → 다시 시도
      const same = await prisma.booking.findUnique({ where: { userId_idempotencyKey: { userId: data.userId, idempotencyKey: data.idempotencyKey } } });
      if (same) {
        assertSameRequest(same, data.slotSeatId);
        return toCreateResult(same, now);
      }
      const active = await prisma.booking.findFirst({
        where: { userId: data.userId, slotId: seat.slotId, status: { in: ACTIVE_BOOKING_STATUSES } },
        select: { id: true },
      });
      if (active) throw err.conflict(MSG_ALREADY_BOOKED);
      if (attempt + 1 >= CODE_RETRIES) throw e;
    }
  }
  if (outcome.kind === "EXISTING") return toCreateResult(outcome.booking, now);

  // ── 트랜잭션 뒤 ──
  const { booking, offerLeftover } = outcome;
  if (offerLeftover > 0) {
    await afterSeatsReleased(booking.slotSeatId, { reason: "OFFER_EXPIRED", quantity: offerLeftover, withheld: false, excludeUserIds: [data.userId] });
  }
  await safely("남은 대기 정리", booking.id, () => closeOtherWaitlistEntries(booking));
  if (booking.status === "CONFIRMED") await afterBookingConfirmed(booking.id);
  else if (booking.status === "PENDING_APPROVAL") await onBookingPendingApproval(booking.id);

  return toCreateResult(booking, now);
}

// ── 이어서 결제 ───────────────────────────────────────

export interface BookingPaymentTicket {
  bookingId: string;
  code: string;
  orderId: string;
  amount: number;
  holdExpiresAt: Date;
}

/**
 * 결제 대기 중인 내 예약의 결제를 다시 시작할 때("이어서 결제") 결제창에 넘길 주문을 돌려준다.
 * 이전 주문이 결제 실패로 닫혔으면 같은 예약에 새 주문을 만든다. 홀드 시간이 지났으면 CLOSED.
 */
export async function prepareBookingPayment(input: { userId: string; bookingId: string }): Promise<BookingPaymentTicket> {
  const data = parseInput(z.object({ userId: idSchema, bookingId: idSchema }), input);
  const now = new Date();
  const booking = await prisma.booking.findUnique({ where: { id: data.bookingId } });
  if (!booking || booking.userId !== data.userId) throw err.notFound(MSG_BOOKING_NOT_FOUND);
  if (booking.status !== "PENDING_PAYMENT") throw err.conflict("결제를 기다리는 예약이 아니에요. 예약 내역에서 상태를 확인해 주세요.");
  if (!booking.holdExpiresAt || booking.holdExpiresAt.getTime() <= now.getTime()) {
    throw err.closed("결제 시간이 지나 자리가 풀렸어요. 다시 예약해 주세요.");
  }
  const holdExpiresAt = booking.holdExpiresAt;

  const payments = await prisma.payment.findMany({ where: { bookingId: booking.id }, select: { status: true, paymentKey: true, failCode: true } });
  if (payments.some((p) => p.status === "PAID" || p.status === "PARTIAL_CANCELLED")) {
    // 결제는 끝났는데 예약 반영이 안 된 상태: 여기서 마저 반영한다.
    await finalizePaidBooking(booking.id, now);
    throw err.conflict("이미 결제가 끝난 예약이에요. 예약 내역에서 확인해 주세요.");
  }
  if (payments.some((p) => p.status === "READY" && (p.paymentKey !== null || p.failCode !== null))) {
    throw err.conflict("결제 결과를 확인하고 있어요. 잠시 후 예약 내역에서 확인해 주세요.");
  }
  const existing = await findPayableOrder(booking.id);
  if (existing) return { bookingId: booking.id, code: booking.code, ...existing, holdExpiresAt };

  const created = await runTx(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS "status" FROM "Booking" WHERE "id" = ${booking.id} FOR UPDATE`;
    if (rows[0]?.status !== "PENDING_PAYMENT") throw err.conflict("결제를 기다리는 예약이 아니에요. 예약 내역에서 상태를 확인해 주세요.");
    const open = await tx.payment.findFirst({ where: { bookingId: booking.id, status: "READY" }, select: { orderId: true, amount: true, paymentKey: true, failCode: true } });
    if (open) {
      if (open.paymentKey !== null || open.failCode !== null) throw err.conflict("결제 결과를 확인하고 있어요. 잠시 후 예약 내역에서 확인해 주세요.");
      return { orderId: open.orderId, amount: open.amount };
    }
    const order = await createPaymentOrder(tx, { bookingId: booking.id, amount: booking.payNowAmount });
    return { orderId: order.orderId, amount: order.amount };
  });
  return { bookingId: booking.id, code: booking.code, ...created, holdExpiresAt };
}

// ── 사업자 직접 입력 예약 ─────────────────────────────

const EXTERNAL_GUEST_NAME = "외부 예약";

export interface SellerBookingSpec {
  slotSeatId: string;
  quantity: number;
  guestName: string;
  /** 숫자만 있는 휴대전화 번호. 모르면 빈 문자열 */
  guestPhone: string;
  memo: string | null;
  /** MANUAL: 전화·DM·현장 예약을 직접 입력 · EXTERNAL: 다른 채널에서 팔린 자리(금액 0원) */
  kind: "MANUAL" | "EXTERNAL";
  paidOnsite: boolean;
}

/**
 * 사업자가 넣는 예약의 공통 구현(권한은 호출한 쪽에서 확인한다).
 * 채널 MANUAL, 회원 없음, 바로 CONFIRMED, 수수료 규칙 MANUAL(0원). 좌석은 고객 예약과 같은 조건부 UPDATE 로 확보한다.
 * 취소된 회차와 이미 끝난 회차에는 넣을 수 없다(판매 마감·예약 마감과는 무관).
 */
export async function createSellerBooking(spec: SellerBookingSpec): Promise<Booking> {
  const now = new Date();
  const settings = await getSettings();
  const seat = await prisma.slotSeat.findUnique({
    where: { id: spec.slotSeatId },
    select: {
      id: true,
      slotId: true,
      slot: { select: { businessId: true, productId: true, product: { select: { cancellationTiers: true, paymentPolicy: true, depositAmount: true } } } },
    },
  });
  if (!seat) throw err.notFound(MSG_SEAT_NOT_FOUND);

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runTx(async (tx) => {
        const slot = await lockSlotShared(tx, seat.slotId);
        if (slot.status === "CANCELLED") throw err.closed("취소된 회차에는 예약을 넣을 수 없어요.");
        if (slot.endAt.getTime() <= now.getTime()) throw err.closed("이미 끝난 회차에는 예약을 넣을 수 없어요.");
        if (!(await reserveSeats(tx, seat.id, spec.quantity))) throw err.soldOut("남은 자리가 모자라요. 정원을 늘리거나 인원을 줄여 주세요.");

        const priced = await tx.slotSeat.findUniqueOrThrow({ where: { id: seat.id }, select: { price: true } });
        const unitPrice = spec.kind === "EXTERNAL" ? 0 : priced.price;
        const totalAmount = unitPrice * spec.quantity;
        const paymentMethod: PaymentMethod = spec.kind === "MANUAL" && totalAmount === 0 ? "FREE" : "ONSITE";
        const booking = await tx.booking.create({
          data: {
            code: newBookingCode(),
            userId: null,
            businessId: seat.slot.businessId,
            productId: seat.slot.productId,
            slotId: seat.slotId,
            slotSeatId: seat.id,
            quantity: spec.quantity,
            unitPrice,
            totalAmount,
            payNowAmount: 0,
            payOnsiteAmount: totalAmount,
            status: "CONFIRMED",
            channel: "MANUAL",
            source: spec.kind === "EXTERNAL" ? "external" : "manual",
            paymentMethod,
            paymentState: spec.paidOnsite && totalAmount > 0 ? "PAID" : "UNPAID",
            guestName: spec.guestName,
            guestPhone: spec.guestPhone,
            sellerMemo: spec.memo,
            policySnapshot: parseCancellationTiers(seat.slot.product.cancellationTiers) as unknown as Prisma.InputJsonValue,
            confirmedAt: now,
            checkinToken: newToken(),
            createdAt: now,
          },
        });
        const snap = await snapshotCommission(tx, booking, { settings, now });
        return tx.booking.update({
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
    } catch (e) {
      // 예약번호·체크인 토큰이 겹친 경우만 다시 시도한다.
      if (!isUniqueViolation(e) || attempt + 1 >= CODE_RETRIES) throw e;
    }
  }
}

const manualSchema = z.object({
  slotSeatId: idSchema,
  quantity: quantitySchema,
  guestName: guestNameSchema,
  guestPhone: z
    .string("휴대전화 번호를 확인해 주세요.")
    .max(30, "휴대전화 번호를 확인해 주세요.")
    .transform((value, ctx) => {
      if (value.trim() === "") return "";
      const phone = normalizePhone(value);
      if (!phone) {
        ctx.addIssue({ code: "custom", message: "휴대전화 번호를 확인해 주세요. (예: 010-1234-5678) 모르면 비워 두세요." });
        return z.NEVER;
      }
      return phone;
    }),
  memo: optionalText(500, "메모는 500자까지 쓸 수 있어요."),
  paidOnsite: z.boolean().default(false),
  notifyGuest: z.boolean().default(false),
});

export type ManualBookingInput = z.input<typeof manualSchema>;

/**
 * 사업자 직접 입력 예약(스태프 이상) — 전화·인스타그램 DM·현장 예약을 한곳에서 관리한다.
 * 바로 확정되고 수수료는 없다. 연락처를 모르면 guestPhone 을 비워 둘 수 있다(고객 카드에는 반영되지 않는다).
 * notifyGuest 가 true 면 남긴 번호로 확정 안내 문자를 보낸다(기본은 보내지 않는다).
 */
export async function createManualBooking(actorUserId: string, businessId: string, input: ManualBookingInput): Promise<BookingSummary> {
  await assertBusinessAccess(actorUserId, parseInput(idSchema, businessId), "STAFF");
  const data = parseInput(manualSchema, input);
  const seat = await prisma.slotSeat.findUnique({ where: { id: data.slotSeatId }, select: { slot: { select: { businessId: true } } } });
  // 다른 사업장의 좌석은 없는 것으로 답한다.
  if (!seat || seat.slot.businessId !== businessId) throw err.notFound(MSG_SEAT_NOT_FOUND);

  const booking = await createSellerBooking({
    slotSeatId: data.slotSeatId,
    quantity: data.quantity,
    guestName: data.guestName,
    guestPhone: data.guestPhone,
    memo: data.memo,
    kind: "MANUAL",
    paidOnsite: data.paidOnsite,
  });
  await afterBookingConfirmed(booking.id, { notifyCustomer: data.notifyGuest && data.guestPhone !== "" });
  return toBookingSummary(booking);
}

/** 외부 판매 자리(다른 채널에서 팔린 좌석)를 예약으로 기록한다. 권한은 호출한 쪽(회차 서비스)에서 확인한다. */
export async function createExternalSaleBooking(slotSeatId: string, quantity: number, memo: string | null): Promise<Booking> {
  const booking = await createSellerBooking({
    slotSeatId,
    quantity,
    guestName: EXTERNAL_GUEST_NAME,
    guestPhone: "",
    memo,
    kind: "EXTERNAL",
    paidOnsite: false,
  });
  await afterBookingConfirmed(booking.id, { notifyCustomer: false });
  return booking;
}
