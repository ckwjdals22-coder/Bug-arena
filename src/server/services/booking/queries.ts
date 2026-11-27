import "server-only";
import { z } from "zod";
import type {
  ActorType,
  BookingChannel,
  BookingStatus,
  PaymentMethod,
  PaymentState,
  PaymentStatus,
  Prisma,
  RefundStatus,
  SeatGender,
  SlotStatus,
} from "@/generated/prisma/client";
import { BOOKING_STATUSES, describeCancellationTiers, parseCancellationTiers, type CancellationTier } from "@/lib/domain";
import { maskPhone } from "@/lib/format";
import { DAY } from "@/lib/time";
import { assertBusinessAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { err } from "@/server/errors";
import { describeCommission, type CommissionDescription } from "@/server/services/commission";
import { confirmedCountBySeat } from "@/server/services/inventory";
import { getPaymentForBooking } from "@/server/services/payments";
import { getSettings } from "@/server/settings";
import { computeCancellationPreview, type CancellationPreview } from "./cancel";
import { toSellerIdentity, type SellerIdentityBlock } from "./create";
import { getGoState, type GoStateInfo, type GoStateKind } from "./go";
import { MSG_BOOKING_NOT_FOUND, idSchema, parseInput } from "./shared";

/**
 * 예약 조회 — 고객(내 예약)과 사업자(예약 관리).
 * 고객 조회는 본인 예약만, 사업자 조회는 그 사업장 구성원만 볼 수 있다.
 */

/** 정확한 주소를 볼 수 있는 예약 상태 — "예약이 확정된 고객"(docs 6.10) */
const ADDRESS_STATUSES: BookingStatus[] = ["CONFIRMED", "COMPLETED"];
/** 회차가 끝나고 이 기간이 지나면 사업자 화면에서 예약자 연락처를 가린다 */
const CONTACT_RETENTION_MS = 30 * DAY;

const codeSchema = z.string("예약번호를 확인해 주세요.").trim().min(4, "예약번호를 확인해 주세요.").max(20, "예약번호를 확인해 주세요.");
const offsetCursor = z
  .string()
  .regex(/^\d{1,7}$/, "목록 위치가 올바르지 않아요. 처음부터 다시 불러와 주세요.")
  .optional();

// ── 고객: 예약 상세 ───────────────────────────────────

export interface BookingPlace {
  placeName: string | null;
  area: { slug: string; name: string; district: string; city: string } | null;
  /** 정확한 주소를 볼 수 있는 상태인지(확정·이용 완료) */
  addressDisclosed: boolean;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

export interface CustomerBookingDetail {
  id: string;
  code: string;
  status: BookingStatus;
  channel: BookingChannel;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  payNowAmount: number;
  payOnsiteAmount: number;
  paymentMethod: PaymentMethod;
  paymentState: PaymentState;
  guestName: string;
  guestPhone: string;
  requestNote: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  /** 결제 대기 중일 때 좌석을 잡아 두는 기한 */
  holdExpiresAt: Date | null;
  attendanceConfirmedAt: Date | null;
  checkedInAt: Date | null;
  completedAt: Date | null;
  noShowAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: ActorType | null;
  /** 취소 사유(운영자가 남긴 내부 사유는 보여 주지 않는다) */
  cancelReason: string | null;
  refundRate: number | null;
  refundAmount: number;
  /** 재판매 연동 환불: 약속한 비율과 아직 다시 팔리기를 기다리는 좌석 수 */
  resale: { rate: number; pendingQty: number } | null;
  refunds: { amount: number; status: RefundStatus; createdAt: Date; processedAt: Date | null }[];
  payment: { status: PaymentStatus; method: string | null; receiptUrl: string | null; approvedAt: Date | null } | null;
  slot: { id: string; startAt: Date; endAt: Date; status: SlotStatus; cancelReason: string | null };
  seat: { id: string; label: string; gender: SeatGender };
  product: { id: string; title: string; image: string | null };
  business: { id: string; slug: string; name: string };
  /** 판매자 신원정보(법정 표시 사항) */
  seller: SellerIdentityBlock;
  place: BookingPlace;
  go: GoStateInfo;
  policy: { tiers: CancellationTier[]; lines: { when: string; refund: string }[] };
  /** 지금 취소하면 어떻게 되는지(취소 확인 화면용) */
  cancellation: CancellationPreview;
  /** 리마인드의 '참석 확정'을 누를 수 있는지 */
  canConfirmAttendance: boolean;
  hasReview: boolean;
}

const customerDetailInclude = {
  slotSeat: { select: { id: true, label: true, gender: true } },
  review: { select: { id: true } },
  refunds: { select: { amount: true, status: true, createdAt: true, processedAt: true }, orderBy: { createdAt: "asc" } },
  slot: {
    select: {
      id: true,
      startAt: true,
      endAt: true,
      status: true,
      cancelReason: true,
      decideAt: true,
      goConfirmedAt: true,
      seats: { select: { id: true, label: true, minCount: true }, orderBy: { sort: "asc" } },
    },
  },
  product: {
    select: {
      id: true,
      title: true,
      images: true,
      placeName: true,
      address: true,
      lat: true,
      lng: true,
      area: { select: { slug: true, name: true, district: true, city: true } },
    },
  },
  business: {
    select: {
      id: true,
      slug: true,
      name: true,
      representativeName: true,
      businessRegNo: true,
      mailOrderRegNo: true,
      phone: true,
      address: true,
      addressDetail: true,
      lat: true,
      lng: true,
      area: { select: { slug: true, name: true, district: true, city: true } },
    },
  },
} satisfies Prisma.BookingInclude;

type CustomerDetailRow = Prisma.BookingGetPayload<{ include: typeof customerDetailInclude }>;

/** 장소. 상품에 장소가 따로 없으면 사업장 주소를 쓴다. 정확한 주소·좌표는 공개 대상 상태일 때만 담는다. */
function toPlace(row: Pick<CustomerDetailRow, "status" | "product" | "business">): BookingPlace {
  const disclosed = ADDRESS_STATUSES.includes(row.status);
  const ownPlace = row.product.address !== null;
  const address = ownPlace ? row.product.address : [row.business.address, row.business.addressDetail].filter(Boolean).join(" ") || null;
  return {
    placeName: row.product.placeName,
    area: row.product.area ?? row.business.area,
    addressDisclosed: disclosed,
    address: disclosed ? address : null,
    lat: disclosed ? (ownPlace ? row.product.lat : row.business.lat) : null,
    lng: disclosed ? (ownPlace ? row.product.lng : row.business.lng) : null,
  };
}

async function loadOwnBooking(userId: string, code: string): Promise<CustomerDetailRow> {
  const parsedUser = parseInput(idSchema, userId);
  const parsedCode = parseInput(codeSchema, code).toUpperCase();
  const row = await prisma.booking.findUnique({ where: { code: parsedCode }, include: customerDetailInclude });
  // 남의 예약번호는 없는 것으로 답한다.
  if (!row || row.userId !== parsedUser) throw err.notFound(MSG_BOOKING_NOT_FOUND);
  return row;
}

/**
 * 내 예약 상세(예약번호로 조회). 정확한 주소는 확정·이용 완료 상태일 때만 들어 있다.
 * 개최 상태, 지금 취소할 때의 환불 미리보기, 판매자 신원정보를 함께 준다.
 */
export async function getBookingForCustomer(userId: string, code: string): Promise<CustomerBookingDetail> {
  const row = await loadOwnBooking(userId, code);
  const now = new Date();
  const [settings, counts, payment] = await Promise.all([getSettings(), confirmedCountBySeat(row.slotId), getPaymentForBooking(row.id)]);
  const tiers = parseCancellationTiers(row.policySnapshot);
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    channel: row.channel,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    totalAmount: row.totalAmount,
    payNowAmount: row.payNowAmount,
    payOnsiteAmount: row.payOnsiteAmount,
    paymentMethod: row.paymentMethod,
    paymentState: row.paymentState,
    guestName: row.guestName,
    guestPhone: row.guestPhone,
    requestNote: row.requestNote,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    holdExpiresAt: row.status === "PENDING_PAYMENT" ? row.holdExpiresAt : null,
    attendanceConfirmedAt: row.attendanceConfirmedAt,
    checkedInAt: row.checkedInAt,
    completedAt: row.completedAt,
    noShowAt: row.noShowAt,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelledBy === "ADMIN" ? null : row.cancelReason,
    refundRate: row.refundRate,
    refundAmount: row.refundAmount,
    resale: row.status === "CANCELLED" && row.resaleRefundRate !== null && row.resalePendingQty > 0 ? { rate: row.resaleRefundRate, pendingQty: row.resalePendingQty } : null,
    refunds: row.refunds,
    payment: payment ? { status: payment.status, method: payment.method, receiptUrl: payment.receiptUrl, approvedAt: payment.approvedAt } : null,
    slot: { id: row.slot.id, startAt: row.slot.startAt, endAt: row.slot.endAt, status: row.slot.status, cancelReason: row.slot.cancelReason },
    seat: row.slotSeat,
    product: { id: row.product.id, title: row.product.title, image: row.product.images[0] ?? null },
    business: { id: row.business.id, slug: row.business.slug, name: row.business.name },
    seller: toSellerIdentity(row.business),
    place: toPlace(row),
    go: getGoState(row.slot, counts),
    policy: { tiers, lines: describeCancellationTiers(tiers) },
    cancellation: computeCancellationPreview(row, settings, now),
    canConfirmAttendance: row.status === "CONFIRMED" && row.attendanceConfirmedAt === null && now.getTime() < row.slot.startAt.getTime(),
    hasReview: row.review !== null,
  };
}

// ── 고객: 입장권 ──────────────────────────────────────

export interface BookingTicket {
  code: string;
  /** 체크인 QR 에 담는 비밀 토큰 */
  checkinToken: string;
  guestName: string;
  quantity: number;
  seatLabel: string;
  productTitle: string;
  businessName: string;
  startAt: Date;
  endAt: Date;
  place: BookingPlace;
  attendanceConfirmedAt: Date | null;
}

/** 입장권(체크인 QR). 확정된 내 예약에만 발급한다. */
export async function getBookingTicket(userId: string, code: string): Promise<BookingTicket> {
  const row = await loadOwnBooking(userId, code);
  if (row.status !== "CONFIRMED") throw err.conflict("확정된 예약에서만 입장권을 볼 수 있어요.");
  return {
    code: row.code,
    checkinToken: row.checkinToken,
    guestName: row.guestName,
    quantity: row.quantity,
    seatLabel: row.slotSeat.label,
    productTitle: row.product.title,
    businessName: row.business.name,
    startAt: row.slot.startAt,
    endAt: row.slot.endAt,
    place: toPlace(row),
    attendanceConfirmedAt: row.attendanceConfirmedAt,
  };
}

// ── 고객: 예약 목록 ───────────────────────────────────

export const CUSTOMER_BOOKING_TABS = ["upcoming", "past", "cancelled"] as const;
export type CustomerBookingTab = (typeof CUSTOMER_BOOKING_TABS)[number];

const customerListSchema = z.object({
  tab: z.enum(CUSTOMER_BOOKING_TABS, "목록 종류를 다시 골라 주세요."),
  cursor: offsetCursor,
  limit: z.number().int().min(1).max(50).default(20),
});

export interface CustomerBookingItem {
  id: string;
  code: string;
  status: BookingStatus;
  quantity: number;
  totalAmount: number;
  payNowAmount: number;
  paymentMethod: PaymentMethod;
  paymentState: PaymentState;
  holdExpiresAt: Date | null;
  refundAmount: number;
  cancelledAt: Date | null;
  attendanceConfirmedAt: Date | null;
  seatLabel: string;
  slot: { id: string; startAt: Date; endAt: Date; status: SlotStatus };
  product: { id: string; title: string; image: string | null; placeName: string | null };
  business: { slug: string; name: string };
  /** 개최 상태(최소 인원 조건이 없으면 NONE) */
  go: GoStateKind;
  hasReview: boolean;
}

export interface CustomerBookingPage {
  items: CustomerBookingItem[];
  /** 다음 쪽이 있으면 그대로 cursor 로 넘긴다 */
  nextCursor: string | null;
}

/**
 * 내 예약 목록.
 * - upcoming: 결제 대기(시간이 남은 것)·승인 대기·확정이고 회차가 아직 끝나지 않은 예약, 시작이 빠른 순
 * - past: 이용 완료·노쇼, 그리고 회차가 끝난 확정 예약, 최근 순
 * - cancelled: 취소·거절·시간 초과, 최근 순
 */
export async function listCustomerBookings(
  userId: string,
  query: { tab: CustomerBookingTab; cursor?: string; limit?: number },
): Promise<CustomerBookingPage> {
  const owner = parseInput(idSchema, userId);
  const { tab, cursor, limit } = parseInput(customerListSchema, query);
  const now = new Date();

  let where: Prisma.BookingWhereInput;
  let orderBy: Prisma.BookingOrderByWithRelationInput[];
  if (tab === "upcoming") {
    where = {
      userId: owner,
      OR: [
        { status: { in: ["PENDING_APPROVAL", "CONFIRMED"] }, slot: { endAt: { gt: now } } },
        { status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } },
      ],
    };
    orderBy = [{ slot: { startAt: "asc" } }, { id: "asc" }];
  } else if (tab === "past") {
    where = { userId: owner, OR: [{ status: { in: ["COMPLETED", "NO_SHOW"] } }, { status: "CONFIRMED", slot: { endAt: { lte: now } } }] };
    orderBy = [{ slot: { startAt: "desc" } }, { id: "desc" }];
  } else {
    where = { userId: owner, status: { in: ["CANCELLED", "REJECTED", "EXPIRED"] } };
    orderBy = [{ createdAt: "desc" }, { id: "desc" }];
  }

  const offset = cursor ? Number(cursor) : 0;
  const rows = await prisma.booking.findMany({
    where,
    orderBy,
    skip: offset,
    take: limit + 1,
    select: {
      id: true,
      code: true,
      status: true,
      quantity: true,
      totalAmount: true,
      payNowAmount: true,
      paymentMethod: true,
      paymentState: true,
      holdExpiresAt: true,
      refundAmount: true,
      cancelledAt: true,
      attendanceConfirmedAt: true,
      slotSeat: { select: { label: true } },
      review: { select: { id: true } },
      slot: { select: { id: true, startAt: true, endAt: true, status: true, goConfirmedAt: true, seats: { select: { minCount: true } } } },
      product: { select: { id: true, title: true, images: true, placeName: true } },
      business: { select: { slug: true, name: true } },
    },
  });
  return {
    items: rows.slice(0, limit).map((b) => ({
      id: b.id,
      code: b.code,
      status: b.status,
      quantity: b.quantity,
      totalAmount: b.totalAmount,
      payNowAmount: b.payNowAmount,
      paymentMethod: b.paymentMethod,
      paymentState: b.paymentState,
      holdExpiresAt: b.status === "PENDING_PAYMENT" ? b.holdExpiresAt : null,
      refundAmount: b.refundAmount,
      cancelledAt: b.cancelledAt,
      attendanceConfirmedAt: b.attendanceConfirmedAt,
      seatLabel: b.slotSeat.label,
      slot: { id: b.slot.id, startAt: b.slot.startAt, endAt: b.slot.endAt, status: b.slot.status },
      product: { id: b.product.id, title: b.product.title, image: b.product.images[0] ?? null, placeName: b.product.placeName },
      business: b.business,
      go: b.slot.seats.every((seat) => seat.minCount <= 0) ? "NONE" : b.slot.goConfirmedAt ? "CONFIRMED" : "GATHERING",
      hasReview: b.review !== null,
    })),
    nextCursor: rows.length > limit ? String(offset + limit) : null,
  };
}

// ── 고객: 이어서 결제 ─────────────────────────────────

export interface ResumableHoldItem {
  bookingId: string;
  code: string;
  slotId: string;
  title: string;
  seatLabel: string;
  quantity: number;
  payNowAmount: number;
  /** 이 시각까지 좌석을 잡아 둔다 */
  holdExpiresAt: Date;
  startAt: Date;
}

/** 결제를 마치지 않아 아직 좌석을 잡아 둔 내 예약("이어서 결제"). 결제창을 열 때는 prepareBookingPayment 를 부른다. */
export async function listResumableHolds(userId: string): Promise<ResumableHoldItem[]> {
  const owner = parseInput(idSchema, userId);
  const now = new Date();
  const rows = await prisma.booking.findMany({
    where: { userId: owner, status: "PENDING_PAYMENT", holdExpiresAt: { gt: now }, slot: { status: { not: "CANCELLED" }, startAt: { gt: now } } },
    orderBy: { holdExpiresAt: "asc" },
    select: {
      id: true,
      code: true,
      slotId: true,
      quantity: true,
      payNowAmount: true,
      holdExpiresAt: true,
      slotSeat: { select: { label: true } },
      slot: { select: { startAt: true } },
      product: { select: { title: true } },
    },
  });
  return rows.flatMap((b) =>
    b.holdExpiresAt
      ? [
          {
            bookingId: b.id,
            code: b.code,
            slotId: b.slotId,
            title: b.product.title,
            seatLabel: b.slotSeat.label,
            quantity: b.quantity,
            payNowAmount: b.payNowAmount,
            holdExpiresAt: b.holdExpiresAt,
            startAt: b.slot.startAt,
          },
        ]
      : [],
  );
}

// ── 사업자: 예약 목록 ─────────────────────────────────

const sellerListSchema = z.object({
  status: z.union([z.enum(BOOKING_STATUSES), z.array(z.enum(BOOKING_STATUSES)).min(1).max(BOOKING_STATUSES.length)]).optional(),
  slotId: idSchema.optional(),
  q: z.string().trim().max(40, "검색어는 40자까지 쓸 수 있어요.").optional(),
  from: z.date("기간을 다시 골라 주세요.").optional(),
  to: z.date("기간을 다시 골라 주세요.").optional(),
  cursor: offsetCursor,
  limit: z.number().int().min(1).max(100).default(30),
});

export type SellerBookingQuery = z.input<typeof sellerListSchema>;

export interface SellerBookingItem {
  id: string;
  code: string;
  status: BookingStatus;
  channel: BookingChannel;
  source: string | null;
  guestName: string;
  /** 목록에서는 가운데를 가린 번호만 준다: 010-****-5678 (번호가 없으면 빈 문자열) */
  phoneMasked: string;
  quantity: number;
  totalAmount: number;
  payNowAmount: number;
  payOnsiteAmount: number;
  paymentMethod: PaymentMethod;
  paymentState: PaymentState;
  seatLabel: string;
  productTitle: string;
  slot: { id: string; startAt: Date; endAt: Date };
  createdAt: Date;
  attendanceConfirmedAt: Date | null;
  checkedInAt: Date | null;
  hasMemo: boolean;
  hasRequestNote: boolean;
  isNewCustomer: boolean;
}

export interface SellerBookingPage {
  items: SellerBookingItem[];
  nextCursor: string | null;
  /** 조건에 맞는 전체 예약 수 */
  total: number;
}

/**
 * 사업장 예약 목록(스태프 이상), 최근 예약 순.
 * q 는 예약자 이름·전화번호 일부·예약번호, from/to 는 회차 시작 시각 범위(from 이상, to 미만).
 */
export async function listSellerBookings(actorUserId: string, businessId: string, query: SellerBookingQuery = {}): Promise<SellerBookingPage> {
  const bizId = parseInput(idSchema, businessId);
  await assertBusinessAccess(actorUserId, bizId, "STAFF");
  const { status, slotId, q, from, to, cursor, limit } = parseInput(sellerListSchema, query);

  const where: Prisma.BookingWhereInput = { businessId: bizId };
  if (status) where.status = Array.isArray(status) ? { in: status } : status;
  if (slotId) where.slotId = slotId;
  if (from || to) where.slot = { startAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } };
  if (q) {
    const digits = q.replace(/\D/g, "");
    where.OR = [
      { guestName: { contains: q, mode: "insensitive" } },
      { code: { contains: q.toUpperCase() } },
      ...(digits.length >= 3 ? [{ guestPhone: { contains: digits } }] : []),
    ];
  }

  const offset = cursor ? Number(cursor) : 0;
  const [rows, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: offset,
      take: limit + 1,
      select: {
        id: true,
        code: true,
        status: true,
        channel: true,
        source: true,
        guestName: true,
        guestPhone: true,
        quantity: true,
        totalAmount: true,
        payNowAmount: true,
        payOnsiteAmount: true,
        paymentMethod: true,
        paymentState: true,
        createdAt: true,
        attendanceConfirmedAt: true,
        checkedInAt: true,
        sellerMemo: true,
        requestNote: true,
        isNewCustomer: true,
        slotSeat: { select: { label: true } },
        product: { select: { title: true } },
        slot: { select: { id: true, startAt: true, endAt: true } },
      },
    }),
    prisma.booking.count({ where }),
  ]);
  return {
    items: rows.slice(0, limit).map((b) => ({
      id: b.id,
      code: b.code,
      status: b.status,
      channel: b.channel,
      source: b.source,
      guestName: b.guestName,
      phoneMasked: b.guestPhone ? maskPhone(b.guestPhone) : "",
      quantity: b.quantity,
      totalAmount: b.totalAmount,
      payNowAmount: b.payNowAmount,
      payOnsiteAmount: b.payOnsiteAmount,
      paymentMethod: b.paymentMethod,
      paymentState: b.paymentState,
      seatLabel: b.slotSeat.label,
      productTitle: b.product.title,
      slot: b.slot,
      createdAt: b.createdAt,
      attendanceConfirmedAt: b.attendanceConfirmedAt,
      checkedInAt: b.checkedInAt,
      hasMemo: Boolean(b.sellerMemo),
      hasRequestNote: Boolean(b.requestNote),
      isNewCustomer: b.isNewCustomer,
    })),
    nextCursor: rows.length > limit ? String(offset + limit) : null,
    total,
  };
}

// ── 사업자: 예약 상세 ─────────────────────────────────

export interface SellerBookingDetail {
  id: string;
  code: string;
  status: BookingStatus;
  channel: BookingChannel;
  source: string | null;
  /** 회원 예약인지(직접 입력 예약은 false) */
  isMember: boolean;
  guestName: string;
  /** 예약자 연락처(고객이 판매자 제공에 동의한 정보). 회차가 끝나고 30일이 지나면 가린 번호만 준다 */
  guestPhone: string;
  phoneMasked: boolean;
  requestNote: string | null;
  sellerMemo: string | null;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  payNowAmount: number;
  payOnsiteAmount: number;
  paymentMethod: PaymentMethod;
  paymentState: PaymentState;
  createdAt: Date;
  confirmedAt: Date | null;
  holdExpiresAt: Date | null;
  attendanceConfirmedAt: Date | null;
  checkedInAt: Date | null;
  completedAt: Date | null;
  noShowAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: ActorType | null;
  cancelReason: string | null;
  refundRate: number | null;
  refundAmount: number;
  resalePendingQty: number;
  /** 개인정보 제3자 제공·환불 기준 동의 시각(증빙) */
  thirdPartyConsentAt: Date | null;
  policyAgreedAt: Date | null;
  seat: { id: string; label: string; gender: SeatGender };
  slot: { id: string; startAt: Date; endAt: Date; status: SlotStatus };
  product: { id: string; title: string };
  commission: CommissionDescription & {
    rule: string | null;
    bps: number;
    commissionAmount: number;
    pgFeeAmount: number;
    isNewCustomer: boolean;
    /** 이 예약에서 사업자가 받을 금액 = 온라인 결제 잔액 − 중개 수수료 − 결제 실비(현장 결제분은 포함하지 않는다) */
    payoutAmount: number;
  };
  refunds: { amount: number; status: RefundStatus; reason: string; createdAt: Date; processedAt: Date | null }[];
  policy: { tiers: CancellationTier[]; lines: { when: string; refund: string }[] };
}

/**
 * 사업장 예약 상세(스태프 이상). 예약자 연락처 전체와 적용된 수수료 규칙 설명을 준다.
 * 다른 사업장의 예약은 FORBIDDEN.
 */
export async function getBookingForSeller(actorUserId: string, bookingId: string): Promise<SellerBookingDetail> {
  const row = await prisma.booking.findUnique({
    where: { id: parseInput(idSchema, bookingId) },
    include: {
      slotSeat: { select: { id: true, label: true, gender: true } },
      slot: { select: { id: true, startAt: true, endAt: true, status: true } },
      product: { select: { id: true, title: true } },
      refunds: { select: { amount: true, status: true, reason: true, createdAt: true, processedAt: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!row) throw err.notFound(MSG_BOOKING_NOT_FOUND);
  await assertBusinessAccess(actorUserId, row.businessId, "STAFF");

  const masked = Date.now() - row.slot.endAt.getTime() > CONTACT_RETENTION_MS;
  const onlineRetained = row.paymentMethod === "ONLINE" && row.paymentState !== "UNPAID" ? row.payNowAmount - row.refundAmount : 0;
  const tiers = parseCancellationTiers(row.policySnapshot);
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    channel: row.channel,
    source: row.source,
    isMember: row.userId !== null,
    guestName: row.guestName,
    guestPhone: row.guestPhone && masked ? maskPhone(row.guestPhone) : row.guestPhone,
    phoneMasked: Boolean(row.guestPhone) && masked,
    requestNote: row.requestNote,
    sellerMemo: row.sellerMemo,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    totalAmount: row.totalAmount,
    payNowAmount: row.payNowAmount,
    payOnsiteAmount: row.payOnsiteAmount,
    paymentMethod: row.paymentMethod,
    paymentState: row.paymentState,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    holdExpiresAt: row.status === "PENDING_PAYMENT" ? row.holdExpiresAt : null,
    attendanceConfirmedAt: row.attendanceConfirmedAt,
    checkedInAt: row.checkedInAt,
    completedAt: row.completedAt,
    noShowAt: row.noShowAt,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelReason,
    refundRate: row.refundRate,
    refundAmount: row.refundAmount,
    resalePendingQty: row.resalePendingQty,
    thirdPartyConsentAt: row.thirdPartyConsentAt,
    policyAgreedAt: row.policyAgreedAt,
    seat: row.slotSeat,
    slot: row.slot,
    product: row.product,
    commission: {
      ...describeCommission(row),
      rule: row.commissionRule,
      bps: row.commissionBps,
      commissionAmount: row.commissionAmount,
      pgFeeAmount: row.pgFeeAmount,
      isNewCustomer: row.isNewCustomer,
      payoutAmount: onlineRetained - row.commissionAmount - row.pgFeeAmount,
    },
    refunds: row.refunds,
    policy: { tiers, lines: describeCancellationTiers(tiers) },
  };
}

const memoSchema = z
  .string("메모를 입력해 주세요.")
  .trim()
  .max(500, "메모는 500자까지 쓸 수 있어요.")
  .transform((value) => value || null);

/** 예약에 사업자 메모를 남긴다(스태프 이상, 500자). 빈 문자열이면 메모를 지운다. 고객에게는 보이지 않는다. */
export async function updateSellerMemo(actorUserId: string, bookingId: string, memo: string): Promise<{ sellerMemo: string | null }> {
  const id = parseInput(idSchema, bookingId);
  const sellerMemo = parseInput(memoSchema, memo);
  const booking = await prisma.booking.findUnique({ where: { id }, select: { businessId: true } });
  if (!booking) throw err.notFound(MSG_BOOKING_NOT_FOUND);
  await assertBusinessAccess(actorUserId, booking.businessId, "STAFF");
  await prisma.booking.update({ where: { id }, data: { sellerMemo } });
  return { sellerMemo };
}
