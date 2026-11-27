import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { CANCELLATION_PRESETS } from "@/lib/domain";
import { newToken } from "@/lib/ids";
import { applyBps } from "@/lib/money";
import { DAY, HOUR, MINUTE } from "@/lib/time";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  abandonBooking,
  adminRevertNoShow,
  approveBooking,
  cancelBookingByAdmin,
  cancelBookingByCustomer,
  cancelBookingBySeller,
  checkBookingEligibility,
  checkInBooking,
  clearStaleResalePending,
  completeDueBookings,
  confirmAttendance,
  confirmBookingPayment,
  createBooking,
  createManualBooking,
  expireHolds,
  expireStaleApprovals,
  getBookingForCustomer,
  getBookingForSeller,
  getBookingQuote,
  getBookingTicket,
  listCustomerBookings,
  listResumableHolds,
  listSellerBookings,
  markNoShow,
  prepareBookingPayment,
  previewCancellation,
  reconcileDuePayments,
  rejectBooking,
  revertNoShow,
  settleResaleFor,
  syncBookingWithPayment,
  updateSellerMemo,
  type CreateBookingInput,
  type CreateBookingResult,
} from "@/server/services/booking";
import { verifyInventoryIntegrity } from "@/server/services/inventory";
import { PaymentProviderError, newMockPaymentKey } from "@/server/services/payments";
import { mockPaymentProvider } from "@/server/services/payments/mock";
import { cancelSlot, confirmSlotGo, decideDueSlots, getGoState, markExternalSale, relistSeats, undoExternalSale } from "@/server/services/slots";
import { setWaitlistProcessor } from "@/server/services/vacancy";
import { DEFAULT_SETTINGS } from "@/server/settings";
import { createListing, createUser, resetDb, type SeatSpec } from "./helpers";

// ── 공통 도우미 ───────────────────────────────────────

type ListingOptions = Parameters<typeof createListing>[1];
type TestUser = Awaited<ReturnType<typeof createUser>>;

const PRICE = 30_000;
const S = DEFAULT_SETTINGS;

let phoneSeq = 0;
/** 테스트마다 겹치지 않는 휴대전화 번호 */
const nextPhone = () => `0107${String(++phoneSeq).padStart(7, "0")}`;

/** 예약 자격을 모두 갖춘 회원(성별·출생 연도 있음) */
const customer = (overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) =>
  createUser({ gender: "MALE", birthYear: 1995, phone: nextPhone(), ...overrides });

const listing = (seats: SeatSpec[] = [{ capacity: 4 }], options: ListingOptions = {}) => createListing(seats, options);

function input(user: TestUser, slotSeatId: string, overrides: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    userId: user.id,
    slotSeatId,
    quantity: 1,
    guestName: user.name,
    guestPhone: user.phone ?? nextPhone(),
    idempotencyKey: newToken(12),
    agreePolicy: true,
    agreeThirdParty: true,
    ...overrides,
  };
}

const book = (user: TestUser, slotSeatId: string, overrides: Partial<CreateBookingInput> = {}) => createBooking(input(user, slotSeatId, overrides));

/** 결제창에서 돌아온 것처럼 테스트 결제를 승인한다. */
async function pay(user: TestUser, created: CreateBookingResult, paymentKey = newMockPaymentKey()) {
  if (!created.payment) throw new Error("결제할 주문이 없어요.");
  return confirmBookingPayment({ userId: user.id, orderId: created.payment.orderId, paymentKey, amount: created.payment.amount });
}

/** 온라인 결제까지 끝낸 확정 예약 */
async function bookAndPay(user: TestUser, slotSeatId: string, overrides: Partial<CreateBookingInput> = {}) {
  const created = await book(user, slotSeatId, overrides);
  await pay(user, created);
  return loadBooking(created.booking.id);
}

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("오류가 나야 하는데 성공했어요.");
}

const loadBooking = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });
const loadSeat = (id: string) => prisma.slotSeat.findUniqueOrThrow({ where: { id } });
const loadSlot = (id: string) => prisma.slot.findUniqueOrThrow({ where: { id } });
const loadUser = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });
const paymentOf = (bookingId: string) => prisma.payment.findFirstOrThrow({ where: { bookingId }, orderBy: { createdAt: "desc" } });
const refundsOf = (bookingId: string) => prisma.refund.findMany({ where: { bookingId }, orderBy: { createdAt: "asc" } });
const notificationsOf = (userId: string, type: string) => prisma.notification.findMany({ where: { userId, type } });

/** 시각을 앞으로 돌린다(Date 만 가짜로 바꾼다 — DB 통신은 그대로). */
function travel(ms: number): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

async function admin(role: "SUPER" | "OPS" | "CS" | "FINANCE") {
  const user = await createUser({ adminRole: role });
  return { id: user.id, role };
}

async function staffOf(businessId: string, role: "MANAGER" | "STAFF") {
  const user = await createUser();
  await prisma.businessMember.create({ data: { businessId, userId: user.id, role } });
  return user;
}

async function expectCleanInventory() {
  expect(await verifyInventoryIntegrity()).toEqual([]);
}

beforeEach(async () => {
  await resetDb();
  setWaitlistProcessor(null);
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setWaitlistProcessor(null);
});

// ───────────────────────── 견적·금액 ─────────────────────────

describe("예약 전 견적과 금액 계산", () => {
  it("전액 선결제: 총액을 지금 결제하고 고객 수수료는 없다", async () => {
    const l = await listing([{ capacity: 4, price: PRICE }]);
    const user = await customer();

    const quote = await getBookingQuote({ userId: user.id, slotSeatId: l.seat.id, quantity: 2 });

    expect(quote).toMatchObject({
      unitPrice: PRICE,
      totalAmount: PRICE * 2,
      payNowAmount: PRICE * 2,
      payOnsiteAmount: 0,
      paymentMethod: "ONLINE",
      remaining: 4,
      maxQuantity: Math.min(l.product.maxPerBooking, 4),
      holdMinutes: S.holdMinutes,
      graceMinutes: S.cancelGraceMinutes,
      eligibility: { ok: true },
    });
    expect(quote.go.state).toBe("NONE");
    expect(quote.seller.name).toBe(l.business.name);
    expect(quote.policy.tiers).toEqual(CANCELLATION_PRESETS.STANDARD.tiers);
  });

  it("예약금 결제: min(예약금 × 인원, 총액)만 지금 내고 나머지는 현장에서 낸다", async () => {
    const l = await listing([{ capacity: 4, price: PRICE }], { product: { paymentPolicy: "DEPOSIT", depositAmount: 10_000 } });
    const user = await customer();

    const quote = await getBookingQuote({ userId: user.id, slotSeatId: l.seat.id, quantity: 2 });
    expect(quote).toMatchObject({ totalAmount: 60_000, payNowAmount: 20_000, payOnsiteAmount: 40_000, paymentMethod: "ONLINE" });

    const created = await book(user, l.seat.id, { quantity: 2 });
    expect(created.next).toBe("PAY");
    expect(created.payment?.amount).toBe(20_000);
    expect(created.booking).toMatchObject({ status: "PENDING_PAYMENT", totalAmount: 60_000, payNowAmount: 20_000, payOnsiteAmount: 40_000 });
  });

  it("예약금이 좌석 가격보다 크면 총액까지만 받는다", async () => {
    const l = await listing([{ capacity: 4, price: 5_000 }], { product: { paymentPolicy: "DEPOSIT", depositAmount: 10_000 } });
    const quote = await getBookingQuote({ userId: (await customer()).id, slotSeatId: l.seat.id, quantity: 1 });
    expect(quote).toMatchObject({ totalAmount: 5_000, payNowAmount: 5_000, payOnsiteAmount: 0, paymentMethod: "ONLINE" });
  });

  it("현장 결제: 지금 낼 돈이 없고 바로 확정된다", async () => {
    const l = await listing([{ capacity: 4, price: PRICE }], { product: { paymentPolicy: "ONSITE" } });
    const user = await customer();

    const quote = await getBookingQuote({ userId: user.id, slotSeatId: l.seat.id, quantity: 1 });
    expect(quote).toMatchObject({ totalAmount: PRICE, payNowAmount: 0, payOnsiteAmount: PRICE, paymentMethod: "ONSITE", resaleRefundRate: null });

    const created = await book(user, l.seat.id);
    expect(created).toMatchObject({ next: "DONE", booking: { status: "CONFIRMED", paymentMethod: "ONSITE", paymentState: "UNPAID" } });
    expect(created.payment).toBeUndefined();
    expect(await prisma.payment.count()).toBe(0);
  });

  it("무료: 결제 없이 바로 확정된다", async () => {
    const l = await listing([{ capacity: 4, price: 0 }]);
    const user = await customer();

    const created = await book(user, l.seat.id, { quantity: 2 });

    expect(created).toMatchObject({ next: "DONE", booking: { status: "CONFIRMED", paymentMethod: "FREE", totalAmount: 0, payNowAmount: 0 } });
    expect((await loadSeat(l.seat.id)).reserved).toBe(2);
  });

  it("시작이 임박한 회차에는 무료 취소 시간이 적용되지 않는다고 알려 준다", async () => {
    const lead = S.cancelGraceMinLeadMinutes * MINUTE;
    const near = await listing([{ capacity: 4 }], { startsInHours: (lead - 10 * MINUTE) / HOUR, deadlineMinBefore: 5 });
    const far = await listing([{ capacity: 4 }], { startsInHours: (lead + 10 * MINUTE) / HOUR, deadlineMinBefore: 5 });
    const user = await customer();

    expect((await getBookingQuote({ userId: user.id, slotSeatId: near.seat.id, quantity: 1 })).graceMinutes).toBe(0);
    expect((await getBookingQuote({ userId: user.id, slotSeatId: far.seat.id, quantity: 1 })).graceMinutes).toBe(S.cancelGraceMinutes);
  });

  it("로그인하지 않았거나 예약할 수 없으면 이유를 eligibility 로 알려 준다", async () => {
    const l = await listing([{ capacity: 1 }]);
    const guest = await getBookingQuote({ slotSeatId: l.seat.id, quantity: 1 });
    expect(guest.eligibility).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });

    const first = await customer();
    await book(first, l.seat.id);
    const second = await customer();
    const soldOut = await getBookingQuote({ userId: second.id, slotSeatId: l.seat.id, quantity: 1 });
    expect(soldOut).toMatchObject({ remaining: 0, maxQuantity: 0, eligibility: { ok: false, code: "SOLD_OUT" } });

    const mine = await getBookingQuote({ userId: first.id, slotSeatId: l.seat.id, quantity: 1 });
    expect(mine.eligibility).toMatchObject({ ok: false, code: "CONFLICT", reason: "이미 이 회차를 예약하셨어요." });
  });

  it("없는 좌석은 NOT_FOUND, 인원이 범위를 벗어나면 VALIDATION", async () => {
    const l = await listing();
    expect((await appError(getBookingQuote({ slotSeatId: "missing", quantity: 1 }))).code).toBe("NOT_FOUND");
    expect((await appError(getBookingQuote({ slotSeatId: l.seat.id, quantity: 0 }))).code).toBe("VALIDATION");
    expect((await appError(getBookingQuote({ slotSeatId: l.seat.id, quantity: 21 }))).code).toBe("VALIDATION");
  });
});

// ───────────────────────── 예약 자격 ─────────────────────────

describe("예약 자격", () => {
  it("성별 좌석: 성별을 설정하지 않았으면 안내하고, 다르면 막는다", async () => {
    const l = await listing([{ label: "여성", gender: "FEMALE", capacity: 2 }]);
    const unset = await customer({ gender: null });
    const male = await customer({ gender: "MALE" });
    const female = await customer({ gender: "FEMALE" });

    const needGender = await appError(book(unset, l.seat.id));
    expect(needGender).toMatchObject({ code: "VALIDATION", message: "프로필에서 성별을 먼저 설정해 주세요." });
    expect((await appError(book(male, l.seat.id))).code).toBe("VALIDATION");
    expect((await book(female, l.seat.id)).booking.status).toBe("PENDING_PAYMENT");
    expect((await loadSeat(l.seat.id)).reserved).toBe(1);
  });

  it("나이 조건: 출생 연도가 없으면 안내하고, 연 나이로 판정한다", async () => {
    vi.setSystemTime(new Date("2026-11-27T03:00:00Z"));
    const l = await listing([{ capacity: 4 }], { product: { minAge: 25, maxAge: 35 } });

    const noBirth = await appError(book(await customer({ birthYear: null }), l.seat.id));
    expect(noBirth.code).toBe("VALIDATION");
    expect(noBirth.message).toContain("출생 연도");
    // 2026년 기준 연 나이: 2002년생 24세, 2001년생 25세, 1991년생 35세, 1990년생 36세
    expect((await appError(book(await customer({ birthYear: 2002 }), l.seat.id))).message).toContain("25세부터");
    expect((await appError(book(await customer({ birthYear: 1990 }), l.seat.id))).message).toContain("35세까지");
    expect((await book(await customer({ birthYear: 2001 }), l.seat.id)).booking.status).toBe("PENDING_PAYMENT");
    expect((await book(await customer({ birthYear: 1991 }), l.seat.id)).booking.status).toBe("PENDING_PAYMENT");
  });

  it("본인확인이 필요한 상품은 본인확인을 마친 회원만 예약할 수 있다", async () => {
    const l = await listing([{ capacity: 4 }], { product: { requiresIdentity: true } });

    const blocked = await appError(book(await customer(), l.seat.id));
    expect(blocked).toMatchObject({ code: "VALIDATION", message: "본인확인을 마친 뒤 예약할 수 있어요." });
    expect((await book(await customer({ identityVerifiedAt: new Date() }), l.seat.id)).booking.status).toBe("PENDING_PAYMENT");
  });

  it("노쇼 누적으로 제한된 회원과 정지된 회원은 예약할 수 없다", async () => {
    const l = await listing();
    const restricted = await customer({ bookingRestrictedUntil: new Date(Date.now() + 3 * DAY) });
    const lifted = await customer({ bookingRestrictedUntil: new Date(Date.now() - MINUTE) });
    const suspended = await customer({ status: "SUSPENDED" });

    const e = await appError(book(restricted, l.seat.id));
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toMatch(/^노쇼가 누적되어 .+까지 예약이 제한돼요\.$/);
    expect((await appError(book(suspended, l.seat.id))).code).toBe("FORBIDDEN");
    expect((await book(lifted, l.seat.id)).booking.status).toBe("PENDING_PAYMENT");
  });

  it("사업자가 차단한 고객은 회원 ID 로도, 전화번호로도 막힌다", async () => {
    const l = await listing();
    const byUser = await customer();
    const byPhone = await customer();
    const blockedPhone = nextPhone();
    await prisma.businessCustomer.create({ data: { businessId: l.business.id, userId: byUser.id, name: "차단", phone: nextPhone(), isBlocked: true } });
    await prisma.businessCustomer.create({ data: { businessId: l.business.id, name: "차단", phone: blockedPhone, isBlocked: true } });

    expect((await appError(book(byUser, l.seat.id))).code).toBe("FORBIDDEN");
    expect((await appError(book(byPhone, l.seat.id, { guestPhone: blockedPhone }))).code).toBe("FORBIDDEN");
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
  });

  it("사업장 구성원은 자기 사업장의 자리를 예약할 수 없다", async () => {
    const l = await listing();
    await prisma.user.update({ where: { id: l.owner.id }, data: { gender: "MALE", birthYear: 1990 } });

    const e = await appError(book(await loadUser(l.owner.id), l.seat.id));
    expect(e).toMatchObject({ code: "FORBIDDEN", message: "내 사업장의 자리는 직접 입력으로 등록해 주세요." });
  });

  it("예약 마감·시작·판매 마감·회차 취소·상품 중지·미승인 사업장이면 CLOSED", async () => {
    const user = await customer();

    const deadlinePassed = await listing([{ capacity: 4 }], { startsInHours: 1, deadlineMinBefore: 90 });
    expect((await appError(book(user, deadlinePassed.seat.id))).code).toBe("CLOSED");

    const started = await listing([{ capacity: 4 }], { startsInHours: -1, deadlineMinBefore: 0 });
    expect((await appError(book(user, started.seat.id))).code).toBe("CLOSED");

    const closed = await listing([{ capacity: 4 }], { status: "CLOSED" });
    expect((await appError(book(user, closed.seat.id))).code).toBe("CLOSED");

    const cancelled = await listing([{ capacity: 4 }], { status: "CANCELLED" });
    expect((await appError(book(user, cancelled.seat.id))).code).toBe("CLOSED");

    const paused = await listing([{ capacity: 4 }], { product: { status: "PAUSED" } });
    expect((await appError(book(user, paused.seat.id))).code).toBe("CLOSED");

    const pending = await listing();
    await prisma.business.update({ where: { id: pending.business.id }, data: { status: "PENDING" } });
    expect((await appError(book(user, pending.seat.id))).code).toBe("CLOSED");

    expect(await prisma.booking.count()).toBe(0);
    await expectCleanInventory();
  });

  it("한 번에 예약할 수 있는 인원(maxPerBooking)을 넘으면 VALIDATION", async () => {
    const l = await listing([{ capacity: 10 }], { product: { maxPerBooking: 2 } });
    const user = await customer();

    const e = await appError(book(user, l.seat.id, { quantity: 3 }));
    expect(e).toMatchObject({ code: "VALIDATION", message: "한 번에 2명까지 예약할 수 있어요." });
    expect((await book(user, l.seat.id, { quantity: 2 })).booking.quantity).toBe(2);
  });

  it("결제 대기 예약은 동시에 3건까지만 가질 수 있다", async () => {
    const user = await customer();
    for (let i = 0; i < 3; i += 1) await book(user, (await listing()).seat.id);

    const fourth = await listing();
    const e = await appError(book(user, fourth.seat.id));
    expect(e.code).toBe("CONFLICT");
    expect((await loadSeat(fourth.seat.id)).reserved).toBe(0);

    // 하나를 그만두면 다시 예약할 수 있다.
    const first = await prisma.booking.findFirstOrThrow({ where: { userId: user.id } });
    await abandonBooking({ userId: user.id, bookingId: first.id });
    expect((await book(user, fourth.seat.id)).booking.status).toBe("PENDING_PAYMENT");
  });

  it("10분에 20번 넘게 시도하면 RATE_LIMITED", async () => {
    const l = await listing([{ capacity: 1 }]);
    await book(await customer(), l.seat.id);
    const user = await customer();
    for (let i = 0; i < 20; i += 1) expect((await appError(book(user, l.seat.id))).code).toBe("SOLD_OUT");

    expect((await appError(book(user, l.seat.id))).code).toBe("RATE_LIMITED");
  });

  it("checkBookingEligibility 는 예외 대신 결과를 돌려준다(대기 모듈이 함께 쓴다)", async () => {
    const l = await listing([{ label: "여성", gender: "FEMALE", capacity: 2 }]);
    const ctx = { slot: l.slot, product: l.product, business: l.business, seat: { gender: l.seat.gender } };

    expect(await checkBookingEligibility(await customer({ gender: "FEMALE" }), ctx)).toEqual({ ok: true });
    expect(await checkBookingEligibility(await customer({ gender: "MALE" }), ctx)).toMatchObject({ ok: false, issue: "GENDER_MISMATCH", code: "VALIDATION" });
    expect(await checkBookingEligibility(await customer({ gender: "FEMALE" }), ctx, { now: new Date(l.slot.startAt.getTime() + 1) })).toMatchObject({
      ok: false,
      issue: "STARTED",
      code: "CLOSED",
    });
  });
});

// ───────────────────────── 예약 생성 ─────────────────────────

describe("예약 생성", () => {
  it("온라인 결제 예약: 좌석을 잡고 결제 주문을 만든다(홀드 시간은 운영 설정)", async () => {
    const l = await listing([{ capacity: 4 }]);
    const user = await customer();
    const before = Date.now();

    const created = await book(user, l.seat.id, { quantity: 2, requestNote: "  창가 자리 부탁드려요  ", source: "search" });

    expect(created.next).toBe("PAY");
    const booking = await loadBooking(created.booking.id);
    expect(booking).toMatchObject({
      userId: user.id,
      businessId: l.business.id,
      slotId: l.slot.id,
      status: "PENDING_PAYMENT",
      channel: "MARKETPLACE",
      source: "search",
      quantity: 2,
      unitPrice: PRICE,
      totalAmount: PRICE * 2,
      payNowAmount: PRICE * 2,
      paymentState: "UNPAID",
      requestNote: "창가 자리 부탁드려요",
      commissionRule: null,
      confirmedAt: null,
    });
    expect(booking.code).toMatch(/^NJ-[2-9A-Z]{6}$/);
    expect(booking.holdExpiresAt?.getTime()).toBe(before + S.holdMinutes * MINUTE);
    expect(booking.policySnapshot).toEqual(CANCELLATION_PRESETS.STANDARD.tiers);
    const payment = await paymentOf(booking.id);
    expect(payment).toMatchObject({ status: "READY", amount: PRICE * 2, orderId: created.payment?.orderId });
    expect((await loadSeat(l.seat.id)).reserved).toBe(2);
    await expectCleanInventory();
  });

  it("홀드는 회차 시작 시각을 넘지 않는다", async () => {
    const l = await listing([{ capacity: 4 }], { startsInHours: (S.holdMinutes * MINUTE) / HOUR / 2, deadlineMinBefore: 0 });
    const created = await book(await customer(), l.seat.id);
    expect(created.booking.holdExpiresAt).toEqual(l.slot.startAt);
  });

  it("동의 기록: 판매자 제공과 환불 기준 동의가 예약과 함께 남는다", async () => {
    const l = await listing();
    const user = await customer();

    const created = await book(user, l.seat.id, { ip: "203.0.113.7" });

    const booking = await loadBooking(created.booking.id);
    expect(booking.policyAgreedAt).not.toBeNull();
    expect(booking.thirdPartyConsentAt).not.toBeNull();
    const consents = await prisma.consentRecord.findMany({ where: { bookingId: booking.id }, orderBy: { kind: "asc" } });
    expect(consents.map((c) => c.kind).sort()).toEqual(["REFUND_POLICY", "THIRD_PARTY"]);
    expect(consents.every((c) => c.userId === user.id && c.agreed && c.ip === "203.0.113.7")).toBe(true);
    expect(consents.find((c) => c.kind === "THIRD_PARTY")?.detail).toBe(l.business.name);
  });

  it("동의하지 않으면 예약하지 않는다", async () => {
    const l = await listing();
    const user = await customer();
    const base = input(user, l.seat.id);

    expect((await appError(createBooking({ ...base, agreePolicy: false } as unknown as CreateBookingInput))).code).toBe("VALIDATION");
    expect((await appError(createBooking({ ...base, agreeThirdParty: false } as unknown as CreateBookingInput))).code).toBe("VALIDATION");
    expect(await prisma.booking.count()).toBe(0);
    expect(await prisma.consentRecord.count()).toBe(0);
  });

  it("입력 검증: 이름·전화번호·요청 사항·멱등 키·유입 경로", async () => {
    const l = await listing();
    const user = await customer();
    const bad = async (overrides: Partial<CreateBookingInput>) => (await appError(book(user, l.seat.id, overrides))).code;

    expect(await bad({ guestName: "" })).toBe("VALIDATION");
    expect(await bad({ guestName: "가".repeat(31) })).toBe("VALIDATION");
    expect(await bad({ guestPhone: "02-123-4567" })).toBe("VALIDATION");
    expect(await bad({ requestNote: "가".repeat(301) })).toBe("VALIDATION");
    expect(await bad({ idempotencyKey: "short" })).toBe("VALIDATION");
    expect(await bad({ idempotencyKey: "k".repeat(65) })).toBe("VALIDATION");
    expect(await bad({ source: "Has Space" })).toBe("VALIDATION");
    expect(await bad({ source: "a".repeat(41) })).toBe("VALIDATION");
    expect(await bad({ quantity: 1.5 })).toBe("VALIDATION");
    expect(await prisma.booking.count()).toBe(0);
  });

  it("같은 멱등 키로 다시 부르면 처음 만든 예약을 그대로 돌려준다", async () => {
    const l = await listing();
    const user = await customer();
    const key = newToken(12);

    const first = await book(user, l.seat.id, { idempotencyKey: key });
    const again = await book(user, l.seat.id, { idempotencyKey: key });

    expect(again.booking.id).toBe(first.booking.id);
    expect(again).toMatchObject({ next: "PAY", payment: first.payment });
    expect(await prisma.booking.count()).toBe(1);
    expect((await loadSeat(l.seat.id)).reserved).toBe(1);
  });

  it("같은 회차에 진행 중 예약이 있으면 CONFLICT, 좌석은 새지 않는다", async () => {
    const l = await listing([{ label: "A", capacity: 2 }, { label: "B", capacity: 2 }]);
    const user = await customer();
    await book(user, l.seat.id);

    const e = await appError(book(user, l.slot.seats[1]!.id));

    expect(e).toMatchObject({ code: "CONFLICT", message: "이미 이 회차를 예약하셨어요." });
    expect((await loadSeat(l.slot.seats[1]!.id)).reserved).toBe(0);
    await expectCleanInventory();
  });

  it("매진이면 SOLD_OUT 이고 아무것도 남기지 않는다", async () => {
    const l = await listing([{ capacity: 2 }]);
    await book(await customer(), l.seat.id, { quantity: 2 });

    const e = await appError(book(await customer(), l.seat.id));

    expect(e.code).toBe("SOLD_OUT");
    expect(await prisma.booking.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.consentRecord.count()).toBe(2);
    expect((await loadSeat(l.seat.id)).reserved).toBe(2);
  });

  it("시간이 지난 홀드가 좌석을 잡고 있으면 주기 작업을 기다리지 않고 바로 회수해 예약한다", async () => {
    const l = await listing([{ capacity: 1 }]);
    const stale = await book(await customer(), l.seat.id);
    travel(S.holdMinutes * MINUTE + 1000);

    const created = await book(await customer(), l.seat.id);

    expect(created.booking.status).toBe("PENDING_PAYMENT");
    expect((await loadBooking(stale.booking.id)).status).toBe("EXPIRED");
    expect((await loadSeat(l.seat.id)).reserved).toBe(1);
    await expectCleanInventory();
  });

  it("화면에 보여 준 총액과 실제 가격이 다르면 예약하지 않는다", async () => {
    const l = await listing([{ capacity: 2, price: PRICE }]);
    const user = await customer();
    await prisma.slotSeat.update({ where: { id: l.seat.id }, data: { price: PRICE + 5_000 } });

    expect((await appError(book(user, l.seat.id, { expectedTotalAmount: PRICE }))).code).toBe("CONFLICT");
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    const created = await book(user, l.seat.id, { expectedTotalAmount: PRICE + 5_000 });
    expect(created.booking.totalAmount).toBe(PRICE + 5_000);
  });

  it("자리 제안을 수락하면 잡혀 있던 좌석으로 예약하고 채널을 WAITLIST 로 남긴다", async () => {
    const l = await listing([{ capacity: 2 }]);
    const other = await customer();
    await book(other, l.seat.id);
    const user = await customer();
    // 제안: 좌석 2개를 잡아 둔 상태(1 예약 + 2 제안 → 정원 3 으로 맞춘다)
    await prisma.slotSeat.update({ where: { id: l.seat.id }, data: { capacity: 3, reserved: 3 } });
    const entry = await prisma.waitlistEntry.create({
      data: { userId: user.id, slotId: l.slot.id, slotSeatId: l.seat.id, quantity: 2, status: "OFFERED", offeredAt: new Date(), offerExpiresAt: new Date(Date.now() + 30 * MINUTE) },
    });

    // 공개된 남은 자리는 0 이지만 제안받은 회원은 예약할 수 있다.
    expect((await appError(book(await customer(), l.seat.id))).code).toBe("SOLD_OUT");
    const quote = await getBookingQuote({ userId: user.id, slotSeatId: l.seat.id, quantity: 1 });
    expect(quote).toMatchObject({ remaining: 2, offer: { entryId: entry.id, quantity: 2 }, eligibility: { ok: true } });

    const created = await book(user, l.seat.id, { quantity: 1, waitlistEntryId: entry.id });

    expect(created.booking).toMatchObject({ status: "PENDING_PAYMENT", channel: "WAITLIST", quantity: 1 });
    expect((await loadBooking(created.booking.id)).source).toBe("waitlist_offer");
    expect(await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ status: "CONVERTED", bookingId: created.booking.id });
    // 제안 2석 중 1석만 썼으므로 남은 1석은 돌려놓는다.
    expect((await loadSeat(l.seat.id)).reserved).toBe(2);
    await expectCleanInventory();
  });

  it("자리 제안: 남의 제안·만료된 제안·다른 좌석의 제안으로는 예약할 수 없다", async () => {
    const l = await listing([{ label: "A", capacity: 1 }, { label: "B", capacity: 1 }]);
    const owner = await customer();
    const thief = await customer();
    await prisma.slotSeat.update({ where: { id: l.seat.id }, data: { reserved: 1 } });
    const entry = await prisma.waitlistEntry.create({
      data: { userId: owner.id, slotId: l.slot.id, slotSeatId: l.seat.id, quantity: 1, status: "OFFERED", offeredAt: new Date(), offerExpiresAt: new Date(Date.now() + 10 * MINUTE) },
    });

    expect((await appError(book(thief, l.seat.id, { waitlistEntryId: entry.id }))).code).toBe("NOT_FOUND");
    expect((await appError(book(owner, l.slot.seats[1]!.id, { waitlistEntryId: entry.id }))).code).toBe("VALIDATION");
    travel(11 * MINUTE);
    expect((await appError(book(owner, l.seat.id, { waitlistEntryId: entry.id }))).code).toBe("CLOSED");
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe("OFFERED");
    expect(await prisma.booking.count()).toBe(0);
  });

  it("예약하면 같은 회차에 걸어 둔 다른 대기는 정리된다(제안 중이던 좌석은 반환)", async () => {
    const l = await listing([{ label: "A", capacity: 2 }, { label: "B", capacity: 2 }]);
    const user = await customer();
    const seatB = l.slot.seats[1]!;
    const sameSeat = await prisma.waitlistEntry.create({ data: { userId: user.id, slotId: l.slot.id, slotSeatId: l.seat.id, status: "WAITING" } });
    await prisma.slotSeat.update({ where: { id: seatB.id }, data: { reserved: 1 } });
    const otherSeat = await prisma.waitlistEntry.create({
      data: { userId: user.id, slotId: l.slot.id, slotSeatId: seatB.id, quantity: 1, status: "OFFERED", offeredAt: new Date(), offerExpiresAt: new Date(Date.now() + 30 * MINUTE) },
    });

    await book(user, l.seat.id);

    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: sameSeat.id } })).status).toBe("CONVERTED");
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: otherSeat.id } })).status).toBe("CANCELLED");
    expect((await loadSeat(seatB.id)).reserved).toBe(0);
    await expectCleanInventory();
  });

  it("DIRECT 채널(사업자 자체 링크)로 들어온 예약은 채널을 그대로 남긴다", async () => {
    const l = await listing([{ capacity: 2, price: PRICE }], { product: { paymentPolicy: "ONSITE" } });
    const created = await book(await customer(), l.seat.id, { channel: "DIRECT", source: "biz_link" });
    expect(await loadBooking(created.booking.id)).toMatchObject({ channel: "DIRECT", source: "biz_link", commissionRule: "DIRECT", commissionAmount: 0 });
  });
});

// ───────────────────────── 결제 ─────────────────────────

describe("결제 승인과 홀드", () => {
  it("결제를 승인하면 확정되고 수수료 스냅샷이 남는다", async () => {
    const l = await listing([{ capacity: 4 }]);
    const user = await customer();
    const created = await book(user, l.seat.id);

    const result = await pay(user, created);

    expect(result).toMatchObject({ status: "CONFIRMED", alreadyProcessed: false, booking: { status: "CONFIRMED", paymentState: "PAID" } });
    const booking = await loadBooking(created.booking.id);
    const expected = Math.min(applyBps(PRICE, S.commissionNewCustomerBps), S.commissionCapPerSeat > 0 ? S.commissionCapPerSeat : Infinity);
    expect(booking).toMatchObject({
      status: "CONFIRMED",
      paymentState: "PAID",
      commissionRule: "MARKET_NEW",
      commissionBps: S.commissionNewCustomerBps,
      commissionAmount: expected,
      pgFeeAmount: 0,
      isNewCustomer: true,
    });
    expect(booking.confirmedAt).not.toBeNull();
    expect((await paymentOf(booking.id)).status).toBe("PAID");
    expect(await notificationsOf(user.id, "BOOKING_CONFIRMED")).toHaveLength(1);
    expect(await notificationsOf(l.owner.id, "SELLER_NEW_BOOKING")).toHaveLength(1);
    // 고객 카드: 확정될 때 한 번
    expect(await prisma.businessCustomer.findFirstOrThrow({ where: { businessId: l.business.id } })).toMatchObject({ bookingCount: 1, source: "MARKETPLACE" });
  });

  it("같은 결제를 다시 확인해도 한 번만 처리된다", async () => {
    const l = await listing();
    const user = await customer();
    const created = await book(user, l.seat.id);
    const key = newMockPaymentKey();
    await pay(user, created, key);

    const again = await pay(user, created, key);

    expect(again).toMatchObject({ status: "CONFIRMED", alreadyProcessed: true });
    expect(await notificationsOf(user.id, "BOOKING_CONFIRMED")).toHaveLength(1);
    expect((await prisma.businessCustomer.findFirstOrThrow({ where: { businessId: l.business.id } })).bookingCount).toBe(1);
    expect(await refundsOf(created.booking.id)).toHaveLength(0);
  });

  it("남의 주문번호로는 결제를 확인할 수 없다", async () => {
    const l = await listing();
    const user = await customer();
    const created = await book(user, l.seat.id);
    const confirmSpy = vi.spyOn(mockPaymentProvider, "confirm");

    const e = await appError(pay(await customer(), created));

    expect(e.code).toBe("NOT_FOUND");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect((await loadBooking(created.booking.id)).status).toBe("PENDING_PAYMENT");
  });

  it("결제 금액이 주문 금액과 다르면 승인하지 않는다", async () => {
    const l = await listing();
    const user = await customer();
    const created = await book(user, l.seat.id);
    const confirmSpy = vi.spyOn(mockPaymentProvider, "confirm");

    const e = await appError(confirmBookingPayment({ userId: user.id, orderId: created.payment!.orderId, paymentKey: newMockPaymentKey(), amount: 100 }));

    expect(e.code).toBe("VALIDATION");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect((await loadBooking(created.booking.id)).status).toBe("PENDING_PAYMENT");
  });

  it("결제가 거절되면 홀드는 남은 시간 동안 유지되고, 시간이 지나면 풀린다", async () => {
    const l = await listing([{ capacity: 1 }]);
    const user = await customer();
    const created = await book(user, l.seat.id);
    const hold = created.booking.holdExpiresAt!;

    const e = await appError(pay(user, created, `mock_fail_${newToken(6)}`));

    expect(e.code).toBe("PAYMENT_FAILED");
    const held = await loadBooking(created.booking.id);
    expect(held.status).toBe("PENDING_PAYMENT");
    // 승인 요청 때문에 홀드가 줄어들지 않는다.
    expect(held.holdExpiresAt?.getTime()).toBeGreaterThanOrEqual(hold.getTime());
    expect((await loadSeat(l.seat.id)).reserved).toBe(1);
    expect((await paymentOf(held.id)).status).toBe("FAILED");

    // 실패로 닫힌 주문을 다시 확인해도 홀드는 늘어나지 않는다.
    expect((await appError(pay(user, created))).code).toBe("CONFLICT");
    expect((await loadBooking(held.id)).holdExpiresAt).toEqual(held.holdExpiresAt);

    // 같은 예약으로 새 주문을 받아 다시 결제할 수 있다.
    const ticket = await prepareBookingPayment({ userId: user.id, bookingId: held.id });
    expect(ticket.orderId).not.toBe(created.payment!.orderId);
    expect(ticket.amount).toBe(PRICE);

    travel(S.holdMinutes * MINUTE + 4 * MINUTE);
    expect(await expireHolds()).toBe(1);
    expect((await loadBooking(held.id)).status).toBe("EXPIRED");
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    await expectCleanInventory();
  });

  it("결제를 거듭 시도해도 홀드는 처음 홀드 시간 + 승인 시간 한 번까지만 늘어난다", async () => {
    const l = await listing([{ capacity: 1 }]);
    const user = await customer();
    const created = await book(user, l.seat.id);
    const bookedAt = Date.now();
    const limit = bookedAt + S.holdMinutes * MINUTE + 3 * MINUTE;
    let orderId = created.payment!.orderId;

    // 홀드가 끝나기 직전부터 1분마다 거절되는 결제를 시도한다.
    travel(S.holdMinutes * MINUTE - 30_000);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const booking = await loadBooking(created.booking.id);
      if (booking.status !== "PENDING_PAYMENT" || booking.holdExpiresAt!.getTime() <= Date.now()) break;
      await appError(confirmBookingPayment({ userId: user.id, orderId, paymentKey: `mock_fail_${newToken(6)}`, amount: PRICE }));
      expect((await loadBooking(created.booking.id)).holdExpiresAt!.getTime()).toBeLessThanOrEqual(limit);
      orderId = (await prepareBookingPayment({ userId: user.id, bookingId: created.booking.id })).orderId;
      travel(MINUTE);
    }

    expect((await loadBooking(created.booking.id)).holdExpiresAt!.getTime()).toBe(limit);
    travel(3 * MINUTE);
    expect(await expireHolds()).toBe(1);
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    await expectCleanInventory();
  });

  it("홀드 만료: 좌석을 반환하고 주문을 닫고 고객에게 알린다. 다시 돌려도 결과가 같다", async () => {
    const l = await listing([{ capacity: 2 }]);
    const user = await customer();
    const created = await book(user, l.seat.id, { quantity: 2 });

    expect(await expireHolds()).toBe(0);
    travel(S.holdMinutes * MINUTE + 1000);
    expect(await expireHolds()).toBe(1);
    expect(await expireHolds()).toBe(0);

    expect((await loadBooking(created.booking.id)).status).toBe("EXPIRED");
    expect((await paymentOf(created.booking.id)).status).toBe("CANCELLED");
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    expect(await notificationsOf(user.id, "BOOKING_EXPIRED")).toHaveLength(1);
    await expectCleanInventory();
  });

  it("결제 결과를 모르는 예약은 만료하지 않고 대사에 맡긴다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const l = await listing([{ capacity: 1 }]);
    const user = await customer();
    const created = await book(user, l.seat.id);
    // 결제사 승인 요청과 조회가 모두 시간 초과 → 결과를 알 수 없다.
    vi.spyOn(mockPaymentProvider, "confirm").mockRejectedValueOnce(new PaymentProviderError({ code: "TIMEOUT", userMessage: "지연", retryable: true }));
    vi.spyOn(mockPaymentProvider, "fetchByOrderId").mockRejectedValueOnce(new Error("network"));

    expect((await appError(pay(user, created))).code).toBe("PAYMENT_FAILED");
    travel(S.holdMinutes * MINUTE + 5 * MINUTE);

    expect(await expireHolds()).toBe(0);
    expect((await loadBooking(created.booking.id)).status).toBe("PENDING_PAYMENT");
    expect((await loadSeat(l.seat.id)).reserved).toBe(1);
    // 고객이 그만두려 해도 결과를 확인하는 중이라고 안내한다.
    const e = await appError(abandonBooking({ userId: user.id, bookingId: created.booking.id }));
    expect(e).toMatchObject({ code: "CONFLICT" });
    expect(e.message).toContain("결제 결과를 확인하고 있어요");

    // 대사: 결제사에 승인 기록이 없으므로 주문을 정리한 뒤 만료한다.
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reconcileDuePayments()).toBeGreaterThanOrEqual(1);
    await expireHolds();
    expect((await loadBooking(created.booking.id)).status).toBe("EXPIRED");
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    await expectCleanInventory();
  });

  it("결제 결과를 몰랐는데 실제로는 승인돼 있었다면 대사에서 확정한다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const l = await listing([{ capacity: 1 }]);
    const user = await customer();
    const created = await book(user, l.seat.id);
    const key = newMockPaymentKey();
    vi.spyOn(mockPaymentProvider, "confirm").mockRejectedValueOnce(new PaymentProviderError({ code: "TIMEOUT", userMessage: "지연", retryable: true }));
    vi.spyOn(mockPaymentProvider, "fetchByOrderId").mockRejectedValueOnce(new Error("network"));
    expect((await appError(pay(user, created, key))).code).toBe("PAYMENT_FAILED");

    // 결제사에는 승인된 것으로 남아 있다.
    vi.spyOn(mockPaymentProvider, "fetchByOrderId").mockResolvedValue({
      status: "DONE",
      orderId: created.payment!.orderId,
      totalAmount: PRICE,
      balanceAmount: PRICE,
      paymentKey: key,
      method: "카드",
      approvedAt: new Date(),
      receiptUrl: null,
      raw: {},
    });
    const synced = await syncBookingWithPayment(created.payment!.orderId);

    expect(synced).toMatchObject({ paymentState: "PAID", action: "CONFIRMED" });
    expect(await loadBooking(created.booking.id)).toMatchObject({ status: "CONFIRMED", paymentState: "PAID", commissionRule: "MARKET_NEW" });
    // 다시 불러도 그대로다.
    expect((await syncBookingWithPayment(created.payment!.orderId)).action).toBe("NONE");
    expect(await notificationsOf(user.id, "BOOKING_CONFIRMED")).toHaveLength(1);
    await expectCleanInventory();
  });

  it("시간 초과로 풀린 뒤 결제하면: 자리가 남아 있으면 되살려 확정한다", async () => {
    const l = await listing([{ capacity: 1 }]);
    const user = await customer();
    const created = await book(user, l.seat.id);
    travel(S.holdMinutes * MINUTE + 1000);
    await expireHolds();
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);

    const result = await pay(user, created);

    expect(result.status).toBe("CONFIRMED");
    expect(await loadBooking(created.booking.id)).toMatchObject({ status: "CONFIRMED", paymentState: "PAID" });
    expect((await loadSeat(l.seat.id)).reserved).toBe(1);
    expect((await paymentOf(created.booking.id)).status).toBe("PAID");
    await expectCleanInventory();
  });

  it("시간 초과로 풀린 뒤 다른 사람이 자리를 가져갔으면: 청구 없이 CLOSED", async () => {
    const l = await listing([{ capacity: 1 }]);
    const user = await customer();
    const created = await book(user, l.seat.id);
    travel(S.holdMinutes * MINUTE + 1000);
    await expireHolds();
    await book(await customer(), l.seat.id);
    const confirmSpy = vi.spyOn(mockPaymentProvider, "confirm");

    const e = await appError(pay(user, created));

    expect(e).toMatchObject({ code: "CLOSED", message: "결제 시간이 지나 자리가 풀렸어요. 다시 예약해 주세요." });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect((await loadBooking(created.booking.id)).status).toBe("EXPIRED");
    expect((await paymentOf(created.booking.id)).status).toBe("CANCELLED");
    expect((await loadSeat(l.seat.id)).reserved).toBe(1);
    await expectCleanInventory();
  });

  it("고객이 직접 그만둔 예약은 뒤늦은 결제로 되살리지 않는다", async () => {
    const l = await listing([{ capacity: 1 }]);
    const user = await customer();
    const created = await book(user, l.seat.id);

    expect(await abandonBooking({ userId: user.id, bookingId: created.booking.id })).toEqual({ released: true, status: "EXPIRED" });
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    expect(await notificationsOf(user.id, "BOOKING_EXPIRED")).toHaveLength(0);
    const confirmSpy = vi.spyOn(mockPaymentProvider, "confirm");

    expect((await appError(pay(user, created))).code).toBe("CLOSED");
    expect(confirmSpy).not.toHaveBeenCalled();
    // 다시 그만두기를 눌러도 아무 일도 일어나지 않는다.
    expect(await abandonBooking({ userId: user.id, bookingId: created.booking.id })).toEqual({ released: false, status: "EXPIRED" });
    await expectCleanInventory();
  });

  it("결제는 승인됐는데 예약을 확정할 수 없으면 바로 전액 환불한다", async () => {
    const l = await listing([{ capacity: 1 }]);
    const user = await customer();
    const created = await book(user, l.seat.id);
    // 결제사 승인이 진행되는 사이 회차가 취소된 상황
    const original = mockPaymentProvider.confirm.bind(mockPaymentProvider);
    vi.spyOn(mockPaymentProvider, "confirm").mockImplementationOnce(async (args) => {
      await cancelSlot({ type: "SYSTEM" }, l.slot.id, "사정이 생겨 열지 못하게 됐어요");
      return original(args);
    });

    const e = await appError(pay(user, created));

    expect(e.code).toBe("CLOSED");
    const booking = await loadBooking(created.booking.id);
    expect(booking).toMatchObject({ status: "CANCELLED", paymentState: "REFUNDED", refundAmount: PRICE });
    expect(await refundsOf(booking.id)).toMatchObject([{ amount: PRICE, status: "DONE", requestedBy: "SYSTEM" }]);
    expect((await paymentOf(booking.id)).status).toBe("CANCELLED");
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    await expectCleanInventory();
  });

  it("결제는 승인됐는데 예약 반영이 끊긴 경우: 홀드 만료 작업이 마저 확정한다", async () => {
    const l = await listing([{ capacity: 1 }]);
    const user = await customer();
    const created = await book(user, l.seat.id);
    // 결제 승인만 기록되고 예약 반영 전에 서버가 죽은 상황을 만든다.
    await prisma.payment.update({ where: { orderId: created.payment!.orderId }, data: { status: "PAID", paymentKey: newMockPaymentKey(), approvedAt: new Date() } });
    travel(S.holdMinutes * MINUTE + 1000);

    expect(await expireHolds()).toBe(0);

    expect(await loadBooking(created.booking.id)).toMatchObject({ status: "CONFIRMED", paymentState: "PAID" });
    expect((await loadSeat(l.seat.id)).reserved).toBe(1);
    await expectCleanInventory();
  });

  it("이어서 결제: 결제 대기 중인 내 예약만, 시간이 남아 있을 때만", async () => {
    const l = await listing();
    const user = await customer();
    const created = await book(user, l.seat.id);

    expect(await listResumableHolds(user.id)).toMatchObject([{ bookingId: created.booking.id, payNowAmount: PRICE, quantity: 1 }]);
    expect(await prepareBookingPayment({ userId: user.id, bookingId: created.booking.id })).toMatchObject({ orderId: created.payment!.orderId, amount: PRICE });
    expect((await appError(prepareBookingPayment({ userId: (await customer()).id, bookingId: created.booking.id }))).code).toBe("NOT_FOUND");

    travel(S.holdMinutes * MINUTE + 1000);
    expect(await listResumableHolds(user.id)).toEqual([]);
    expect((await appError(prepareBookingPayment({ userId: user.id, bookingId: created.booking.id }))).code).toBe("CLOSED");
  });

  it("결제사에서 직접 전액 취소된 결제는 예약을 시스템 취소하고 좌석을 돌려놓는다", async () => {
    const l = await listing([{ capacity: 1 }]);
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);
    const payment = await paymentOf(booking.id);
    vi.spyOn(mockPaymentProvider, "fetchByOrderId").mockResolvedValue({
      status: "CANCELED",
      orderId: payment.orderId,
      totalAmount: PRICE,
      balanceAmount: 0,
      paymentKey: payment.paymentKey,
      method: "카드",
      approvedAt: payment.approvedAt,
      receiptUrl: null,
      raw: {},
    });

    const synced = await syncBookingWithPayment(payment.orderId);

    expect(synced).toMatchObject({ paymentState: "CANCELLED", action: "CANCELLED" });
    expect(await loadBooking(booking.id)).toMatchObject({ status: "CANCELLED", cancelledBy: "SYSTEM", refundAmount: PRICE, paymentState: "REFUNDED", commissionAmount: 0 });
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    // 결제사에서 이미 취소됐으므로 환불을 다시 요청하지 않는다(결제 모듈이 남긴 반영 기록 한 건뿐).
    expect(await refundsOf(booking.id)).toMatchObject([{ amount: PRICE, status: "DONE" }]);
    expect((await syncBookingWithPayment(payment.orderId)).action).toBe("NONE");
    await expectCleanInventory();
  });
});

// ───────────────────────── 승인제 ─────────────────────────

describe("승인제 상품", () => {
  it("현장 결제 + 승인제: 승인 대기로 만들어지고, 승인하면 확정·수수료 스냅샷·알림", async () => {
    const l = await listing([{ capacity: 2 }], { product: { requiresApproval: true, paymentPolicy: "ONSITE" } });
    const user = await customer();

    const created = await book(user, l.seat.id);

    expect(created).toMatchObject({ next: "DONE", booking: { status: "PENDING_APPROVAL" } });
    expect((await loadBooking(created.booking.id)).commissionRule).toBeNull();
    expect((await loadSeat(l.seat.id)).reserved).toBe(1);
    expect(await notificationsOf(user.id, "BOOKING_PENDING_APPROVAL")).toHaveLength(1);
    expect(await notificationsOf(l.owner.id, "SELLER_APPROVAL_NEEDED")).toHaveLength(1);
    expect(await prisma.businessCustomer.count()).toBe(0);

    expect(await approveBooking(l.owner.id, created.booking.id)).toEqual({ status: "CONFIRMED" });

    const booking = await loadBooking(created.booking.id);
    expect(booking).toMatchObject({ status: "CONFIRMED", commissionRule: "MARKET_NEW", commissionAmount: applyBps(PRICE, S.commissionNewCustomerBps) });
    expect(booking.confirmedAt).not.toBeNull();
    expect(await notificationsOf(user.id, "BOOKING_APPROVED")).toHaveLength(1);
    expect((await prisma.businessCustomer.findFirstOrThrow()).bookingCount).toBe(1);
    expect((await appError(approveBooking(l.owner.id, created.booking.id))).code).toBe("CONFLICT");
  });

  it("온라인 결제 + 승인제: 결제 뒤 승인 대기, 거절하면 전액 환불하고 좌석을 바로 다시 연다", async () => {
    const l = await listing([{ capacity: 1 }], { product: { requiresApproval: true } });
    const user = await customer();
    const created = await book(user, l.seat.id);

    const paid = await pay(user, created);
    expect(paid.status).toBe("PENDING_APPROVAL");
    expect(await loadBooking(created.booking.id)).toMatchObject({ status: "PENDING_APPROVAL", paymentState: "PAID", commissionRule: null, confirmedAt: null });

    const result = await rejectBooking(l.owner.id, created.booking.id, "정원이 맞지 않아요");

    expect(result).toEqual({ refundAmount: PRICE, refundStatus: "DONE", withheld: false });
    expect(await loadBooking(created.booking.id)).toMatchObject({
      status: "REJECTED",
      cancelledBy: "SELLER",
      cancelReason: "정원이 맞지 않아요",
      refundRate: 100,
      refundAmount: PRICE,
      paymentState: "REFUNDED",
      commissionAmount: 0,
    });
    expect(await refundsOf(created.booking.id)).toMatchObject([{ amount: PRICE, status: "DONE", requestedBy: "SELLER" }]);
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    expect(await notificationsOf(user.id, "BOOKING_REJECTED")).toHaveLength(1);
    expect((await appError(rejectBooking(l.owner.id, created.booking.id))).code).toBe("CONFLICT");
    await expectCleanInventory();
  });

  it("승인 대기 중에 고객이 취소하면 전액 환불", async () => {
    const l = await listing([{ capacity: 1 }], { product: { requiresApproval: true } });
    const user = await customer();
    const created = await book(user, l.seat.id);
    await pay(user, created);

    const result = await cancelBookingByCustomer({ userId: user.id, bookingId: created.booking.id });

    expect(result).toEqual({ refundRate: 100, refundAmount: PRICE, refundStatus: "DONE" });
    expect(await loadBooking(created.booking.id)).toMatchObject({ status: "CANCELLED", cancelledBy: "CUSTOMER", paymentState: "REFUNDED", resalePendingQty: 0 });
    expect((await loadUser(user.id)).lateCancelCount).toBe(0);
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
  });

  it("사업자가 기한 안에 확인하지 않으면 자동으로 거절하고 전액 환불한다(24시간 경과 / 시작 2시간 이내)", async () => {
    const old = await listing([{ capacity: 2 }], { product: { requiresApproval: true }, startsInHours: 100 });
    const u1 = await customer();
    const paidOld = await book(u1, old.seat.id);
    await pay(u1, paidOld);

    expect(await expireStaleApprovals()).toBe(0);
    travel(24 * HOUR + MINUTE);
    const soon = await listing([{ capacity: 2 }], { product: { requiresApproval: true, paymentPolicy: "ONSITE" }, startsInHours: 2.5, deadlineMinBefore: 30 });
    const fresh = await listing([{ capacity: 2 }], { product: { requiresApproval: true, paymentPolicy: "ONSITE" }, startsInHours: 100 });
    const nearStart = await book(await customer(), soon.seat.id);
    const late = await book(await customer(), fresh.seat.id);

    // 예약한 지 24시간이 지난 건만 대상이다(시작까지 2시간 반 남은 건은 아직 아니다).
    expect(await expireStaleApprovals()).toBe(1);
    expect(await loadBooking(paidOld.booking.id)).toMatchObject({
      status: "REJECTED",
      cancelledBy: "SYSTEM",
      cancelReason: "사업자가 기한 안에 확인하지 못해 자동 취소됐어요",
      refundAmount: PRICE,
      paymentState: "REFUNDED",
    });
    expect(await notificationsOf(u1.id, "BOOKING_REJECTED")).toHaveLength(1);
    expect((await loadBooking(nearStart.booking.id)).status).toBe("PENDING_APPROVAL");

    // 시작까지 2시간이 안 남으면 대상이 된다.
    travel(31 * MINUTE);
    expect(await expireStaleApprovals()).toBe(1);
    expect(await loadBooking(nearStart.booking.id)).toMatchObject({ status: "REJECTED", cancelledBy: "SYSTEM" });
    expect((await loadBooking(late.booking.id)).status).toBe("PENDING_APPROVAL");
    expect(await expireStaleApprovals()).toBe(0);
    expect(await refundsOf(paidOld.booking.id)).toHaveLength(1);
    await expectCleanInventory();
  });

  it("이미 시작한 회차의 승인 대기는 승인할 수 없다", async () => {
    const l = await listing([{ capacity: 2 }], { product: { requiresApproval: true, paymentPolicy: "ONSITE" }, startsInHours: 3 });
    const created = await book(await customer(), l.seat.id);
    travel(3 * HOUR + MINUTE);

    expect((await appError(approveBooking(l.owner.id, created.booking.id))).code).toBe("CLOSED");
    expect((await loadBooking(created.booking.id)).status).toBe("PENDING_APPROVAL");
  });
});

// ───────────────────────── 취소·환불 ─────────────────────────

describe("고객 취소와 환불", () => {
  /** 표준 정책(3일 전 100%, 24시간 전 50%, 그 뒤 0%)의 구간별 회차 */
  const paidBooking = async (startsInHours: number, options: ListingOptions = {}) => {
    const l = await listing([{ capacity: 2 }], { startsInHours, ...options });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);
    // 예약 직후 무료 취소 시간을 지나게 한다.
    travel(S.cancelGraceMinutes * MINUTE + MINUTE);
    return { l, user, booking };
  };

  it("전액 환불 구간: 결제 금액을 모두 돌려주고 수수료는 0 이 된다", async () => {
    const { l, user, booking } = await paidBooking(100);

    const result = await cancelBookingByCustomer({ userId: user.id, bookingId: booking.id, reason: "일정이 바뀌었어요" });

    expect(result).toEqual({ refundRate: 100, refundAmount: PRICE, refundStatus: "DONE" });
    expect(await loadBooking(booking.id)).toMatchObject({
      status: "CANCELLED",
      cancelledBy: "CUSTOMER",
      cancelReason: "일정이 바뀌었어요",
      refundRate: 100,
      refundAmount: PRICE,
      paymentState: "REFUNDED",
      commissionAmount: 0,
      pgFeeAmount: 0,
      resalePendingQty: 0,
    });
    expect((await loadUser(user.id)).lateCancelCount).toBe(0);
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    await expectCleanInventory();
  });

  it("50% 구간: 절반을 환불하고, 남은 금액 기준으로 수수료를 다시 계산하고, 늦은 취소 횟수를 올린다", async () => {
    const { l, user, booking } = await paidBooking(48);
    expect((await previewCancellation({ userId: user.id, bookingId: booking.id })).refundAmount).toBe(PRICE / 2);

    const result = await cancelBookingByCustomer({ userId: user.id, bookingId: booking.id });

    expect(result).toEqual({ refundRate: 50, refundAmount: PRICE / 2, refundStatus: "DONE" });
    expect(await loadBooking(booking.id)).toMatchObject({
      status: "CANCELLED",
      refundRate: 50,
      refundAmount: PRICE / 2,
      paymentState: "PARTIALLY_REFUNDED",
      commissionAmount: applyBps(PRICE / 2, S.commissionNewCustomerBps),
    });
    expect(await refundsOf(booking.id)).toMatchObject([{ amount: PRICE / 2, status: "DONE", requestedBy: "CUSTOMER", requestedById: user.id }]);
    expect((await paymentOf(booking.id)).status).toBe("PARTIAL_CANCELLED");
    expect((await loadUser(user.id)).lateCancelCount).toBe(1);
    // 좌석은 바로 다시 공개되고(자동 재등록), 회차는 취소석으로 표시된다.
    expect(await loadSeat(l.seat.id)).toMatchObject({ reserved: 0, withheld: 0 });
    expect((await loadSlot(l.slot.id)).origin).toBe("CANCELLATION");
    expect((await prisma.businessCustomer.findFirstOrThrow({ where: { businessId: l.business.id } })).cancelCount).toBe(1);
    expect(await notificationsOf(user.id, "BOOKING_CANCELLED")).toHaveLength(1);
    expect(await notificationsOf(l.owner.id, "SELLER_BOOKING_CANCELLED")).toHaveLength(1);
  });

  it("환불 불가 구간: 환불 없이 취소되고 결제 상태는 그대로다", async () => {
    const { user, booking } = await paidBooking(12);

    const result = await cancelBookingByCustomer({ userId: user.id, bookingId: booking.id });

    expect(result).toEqual({ refundRate: 0, refundAmount: 0, refundStatus: "NONE" });
    expect(await loadBooking(booking.id)).toMatchObject({
      status: "CANCELLED",
      refundAmount: 0,
      paymentState: "PAID",
      commissionAmount: applyBps(PRICE, S.commissionNewCustomerBps),
    });
    expect(await refundsOf(booking.id)).toHaveLength(0);
    expect((await loadUser(user.id)).lateCancelCount).toBe(1);
  });

  it("예약 직후 무료 취소: 시작이 충분히 남은 예약은 환불 불가 구간이어도 전액 환불", async () => {
    const leadHours = (S.cancelGraceMinLeadMinutes * MINUTE + 20 * MINUTE) / HOUR;
    const l = await listing([{ capacity: 2 }], { startsInHours: leadHours, deadlineMinBefore: 5 });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);

    const preview = await previewCancellation({ userId: user.id, bookingId: booking.id });
    expect(preview).toMatchObject({ cancellable: true, refundRate: 100, refundAmount: PRICE, retained: 0 });
    expect(preview.graceUntil?.getTime()).toBe(booking.confirmedAt!.getTime() + S.cancelGraceMinutes * MINUTE);

    travel(S.cancelGraceMinutes * MINUTE - MINUTE);
    expect(await cancelBookingByCustomer({ userId: user.id, bookingId: booking.id })).toEqual({ refundRate: 100, refundAmount: PRICE, refundStatus: "DONE" });
    expect((await loadUser(user.id)).lateCancelCount).toBe(0);
  });

  it("무료 취소 시간이 지나면 환불 기준 구간을 따른다", async () => {
    const leadHours = (S.cancelGraceMinLeadMinutes * MINUTE + 60 * MINUTE) / HOUR;
    const l = await listing([{ capacity: 2 }], { startsInHours: leadHours, deadlineMinBefore: 5 });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);
    travel(S.cancelGraceMinutes * MINUTE + MINUTE);

    const preview = await previewCancellation({ userId: user.id, bookingId: booking.id });
    expect(preview).toMatchObject({ refundRate: 0, refundAmount: 0, retained: PRICE });
    expect(preview.graceUntil).toBeUndefined();
    expect((await cancelBookingByCustomer({ userId: user.id, bookingId: booking.id })).refundRate).toBe(0);
  });

  it("임박 예약(예약 시점에 시작까지 기준 시간 미만)에는 무료 취소 시간을 주지 않는다", async () => {
    const leadHours = (S.cancelGraceMinLeadMinutes * MINUTE - 20 * MINUTE) / HOUR;
    const l = await listing([{ capacity: 2 }], { startsInHours: leadHours, deadlineMinBefore: 5 });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);

    const preview = await previewCancellation({ userId: user.id, bookingId: booking.id });
    expect(preview).toMatchObject({ refundRate: 0, refundAmount: 0 });
    expect(preview.graceUntil).toBeUndefined();
    // 예약 직후 바로 취소해도 환불 기준(환불 불가 구간)을 따른다.
    expect(await cancelBookingByCustomer({ userId: user.id, bookingId: booking.id })).toEqual({ refundRate: 0, refundAmount: 0, refundStatus: "NONE" });
  });

  it("환불 기준은 예약 시점의 스냅샷을 쓴다(나중에 상품 정책을 바꿔도 그대로)", async () => {
    const { l, user, booking } = await paidBooking(48);
    await prisma.product.update({ where: { id: l.product.id }, data: { cancellationTiers: [{ hoursBefore: 0, refundRate: 0 }] } });

    expect((await cancelBookingByCustomer({ userId: user.id, bookingId: booking.id })).refundRate).toBe(50);
  });

  it("결제 대기 예약을 취소하면 결제를 그만둔 것으로 처리한다", async () => {
    const l = await listing([{ capacity: 1 }]);
    const user = await customer();
    const created = await book(user, l.seat.id);

    expect(await cancelBookingByCustomer({ userId: user.id, bookingId: created.booking.id })).toEqual({ refundRate: 100, refundAmount: 0, refundStatus: "NONE" });
    expect((await loadBooking(created.booking.id)).status).toBe("EXPIRED");
    expect((await paymentOf(created.booking.id)).status).toBe("CANCELLED");
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
  });

  it("현장 결제 예약 취소: 환불할 돈이 없고 수수료는 0 이 된다", async () => {
    const l = await listing([{ capacity: 2 }], { product: { paymentPolicy: "ONSITE" }, startsInHours: 12 });
    const user = await customer();
    const created = await book(user, l.seat.id);
    expect((await loadBooking(created.booking.id)).commissionAmount).toBeGreaterThan(0);
    travel(S.cancelGraceMinutes * MINUTE + MINUTE);

    expect(await cancelBookingByCustomer({ userId: user.id, bookingId: created.booking.id })).toEqual({ refundRate: 0, refundAmount: 0, refundStatus: "NONE" });
    expect(await loadBooking(created.booking.id)).toMatchObject({ status: "CANCELLED", commissionAmount: 0, resalePendingQty: 0 });
  });

  it("이미 시작한 회차와 이미 끝난 예약은 취소할 수 없다", async () => {
    const { user, booking } = await paidBooking(2);
    travel(2 * HOUR);
    expect((await appError(cancelBookingByCustomer({ userId: user.id, bookingId: booking.id }))).code).toBe("CLOSED");
    expect((await loadBooking(booking.id)).status).toBe("CONFIRMED");

    const other = await paidBooking(100);
    await cancelBookingByCustomer({ userId: other.user.id, bookingId: other.booking.id });
    expect((await appError(cancelBookingByCustomer({ userId: other.user.id, bookingId: other.booking.id }))).code).toBe("CONFLICT");
    expect(await refundsOf(other.booking.id)).toHaveLength(1);
  });

  it("결제사 환불이 실패해도 취소는 끝나고, 실패한 환불이 남아 결제 상태는 그대로다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { l, user, booking } = await paidBooking(100);
    vi.spyOn(mockPaymentProvider, "cancel").mockRejectedValueOnce(new PaymentProviderError({ code: "PG_DOWN", userMessage: "지연", retryable: true }));

    const result = await cancelBookingByCustomer({ userId: user.id, bookingId: booking.id });

    expect(result).toEqual({ refundRate: 100, refundAmount: PRICE, refundStatus: "FAILED" });
    expect(await loadBooking(booking.id)).toMatchObject({ status: "CANCELLED", refundAmount: PRICE, paymentState: "PAID" });
    expect(await refundsOf(booking.id)).toMatchObject([{ amount: PRICE, status: "FAILED" }]);
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
  });

  it("자동 재등록을 꺼 둔 사업장: 취소 좌석은 보류로 닫히고, 사업자가 다시 올려야 공개된다", async () => {
    const { l, user, booking } = await paidBooking(48);
    await prisma.business.update({ where: { id: l.business.id }, data: { autoRelist: false } });

    await cancelBookingByCustomer({ userId: user.id, bookingId: booking.id });

    expect(await loadSeat(l.seat.id)).toMatchObject({ reserved: 1, withheld: 1 });
    expect((await loadSlot(l.slot.id)).origin).toBe("REGULAR");
    expect(await notificationsOf(l.owner.id, "SELLER_SEAT_RELEASED")).toHaveLength(1);
    const quote = await getBookingQuote({ userId: (await customer()).id, slotSeatId: l.seat.id, quantity: 1 });
    expect(quote.remaining).toBe(1);
    await expectCleanInventory();

    const relisted = await relistSeats(l.owner.id, l.seat.id);

    expect(relisted).toEqual({ relisted: 1, remaining: 2 });
    expect(await loadSeat(l.seat.id)).toMatchObject({ reserved: 0, withheld: 0 });
    expect((await loadSlot(l.slot.id)).origin).toBe("CANCELLATION");
    expect((await appError(relistSeats(l.owner.id, l.seat.id))).code).toBe("VALIDATION");
    await expectCleanInventory();
  });
});

describe("사업자·운영자 취소", () => {
  it("사업자 취소: 환불 불가 구간이어도 전액 환불하고 좌석은 보류한다", async () => {
    const l = await listing([{ capacity: 2 }], { startsInHours: 12 });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);
    travel(S.cancelGraceMinutes * MINUTE + MINUTE);

    const result = await cancelBookingBySeller(l.owner.id, booking.id, "강사 사정으로 진행이 어려워요");

    expect(result).toEqual({ refundAmount: PRICE, refundStatus: "DONE", withheld: true });
    expect(await loadBooking(booking.id)).toMatchObject({
      status: "CANCELLED",
      cancelledBy: "SELLER",
      cancelReason: "강사 사정으로 진행이 어려워요",
      refundRate: 100,
      refundAmount: PRICE,
      paymentState: "REFUNDED",
      commissionAmount: 0,
      resalePendingQty: 0,
    });
    expect(await loadSeat(l.seat.id)).toMatchObject({ reserved: 1, withheld: 1 });
    expect((await loadUser(user.id)).lateCancelCount).toBe(0);
    // 고객의 취소 이력으로 세지 않는다.
    expect((await prisma.businessCustomer.findFirstOrThrow({ where: { businessId: l.business.id } })).cancelCount).toBe(0);
    expect(await notificationsOf(user.id, "BOOKING_CANCELLED")).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: "booking.cancel_by_seller", targetId: booking.id } })).toBe(1);
    await expectCleanInventory();
  });

  it("사업자 취소: 사유가 필요하고, 매니저 이상만, 회차 시작 전까지만", async () => {
    const l = await listing([{ capacity: 2 }], { startsInHours: 5 });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);
    const staff = await staffOf(l.business.id, "STAFF");
    const manager = await staffOf(l.business.id, "MANAGER");

    expect((await appError(cancelBookingBySeller(l.owner.id, booking.id, "  "))).code).toBe("VALIDATION");
    expect((await appError(cancelBookingBySeller(l.owner.id, booking.id, "가".repeat(201)))).code).toBe("VALIDATION");
    expect((await appError(cancelBookingBySeller(staff.id, booking.id, "사유"))).code).toBe("FORBIDDEN");
    travel(5 * HOUR + MINUTE);
    expect((await appError(cancelBookingBySeller(manager.id, booking.id, "사유"))).code).toBe("CLOSED");
    expect((await loadBooking(booking.id)).status).toBe("CONFIRMED");
  });

  it("운영자 취소: CS·SUPER 만, 환불액을 정할 수 있고 감사 로그에 남는다", async () => {
    const l = await listing([{ capacity: 3 }], { startsInHours: 12 });
    const u1 = await customer();
    const u2 = await customer();
    const b1 = await bookAndPay(u1, l.seat.id);
    const b2 = await bookAndPay(u2, l.seat.id);
    const cs = await admin("CS");
    const finance = await admin("FINANCE");

    expect((await appError(cancelBookingByAdmin(finance, b1.id, { reason: "분쟁 조정" }))).code).toBe("FORBIDDEN");
    // 역할을 속여도 계정의 실제 역할로 판단한다.
    expect((await appError(cancelBookingByAdmin({ id: finance.id, role: "CS" }, b1.id, { reason: "분쟁 조정" }))).code).toBe("FORBIDDEN");
    expect((await appError(cancelBookingByAdmin({ id: u1.id, role: "SUPER" }, b1.id, { reason: "분쟁 조정" }))).code).toBe("FORBIDDEN");
    expect((await appError(cancelBookingByAdmin(cs, b1.id, { reason: "분쟁 조정", refundAmount: PRICE + 1 }))).code).toBe("VALIDATION");
    expect((await loadBooking(b1.id)).status).toBe("CONFIRMED");

    const partial = await cancelBookingByAdmin(cs, b1.id, { reason: "분쟁 조정", refundAmount: 10_000 });
    expect(partial).toMatchObject({ refundAmount: 10_000, refundStatus: "DONE" });
    expect(await loadBooking(b1.id)).toMatchObject({ status: "CANCELLED", cancelledBy: "ADMIN", refundAmount: 10_000, paymentState: "PARTIALLY_REFUNDED" });

    const full = await cancelBookingByAdmin(await admin("SUPER"), b2.id, { reason: "사업장 귀책" });
    expect(full).toEqual({ refundRate: 100, refundAmount: PRICE, refundStatus: "DONE" });
    expect(await prisma.auditLog.count({ where: { action: "booking.cancel_by_admin" } })).toBe(2);
    await expectCleanInventory();
  });
});

// ───────────────────────── 재판매 연동 환불 ─────────────────────────

describe("재판매 연동 환불", () => {
  const RESALE = 80;
  /** 환불 불가 구간(시작 12시간 전)의 회차. 재판매되면 80%까지 환불하는 상품 */
  const resaleListing = (capacity: number, options: ListingOptions = {}) =>
    listing([{ capacity }], { startsInHours: 12, ...options, product: { resaleRefundRate: RESALE, ...options.product } });
  const passGrace = () => travel(S.cancelGraceMinutes * MINUTE + MINUTE);

  it("다른 빈자리가 먼저 팔리는 동안에는 환불하지 않고, 모두 팔려 취소 좌석이 다시 팔리면 추가 환불한다", async () => {
    const l = await resaleListing(3);
    const a = await customer();
    const bookingA = await bookAndPay(a, l.seat.id);
    await bookAndPay(await customer(), l.seat.id);
    passGrace();

    const cancelled = await cancelBookingByCustomer({ userId: a.id, bookingId: bookingA.id });
    expect(cancelled).toEqual({ refundRate: 0, refundAmount: 0, refundStatus: "NONE", resaleRefundRate: RESALE });
    expect(await loadBooking(bookingA.id)).toMatchObject({ resalePendingQty: 1, resaleRefundRate: RESALE, refundAmount: 0, paymentState: "PAID" });
    expect((await previewCancellation({ userId: a.id, bookingId: bookingA.id })).cancellable).toBe(false);

    // 빈자리 2석(원래 남아 있던 1석 + 취소된 1석) 중 첫 예약: 아직 다른 빈자리가 팔린 것이다.
    const c = await customer();
    const bookingC = await bookAndPay(c, l.seat.id);
    expect(await loadBooking(bookingA.id)).toMatchObject({ resalePendingQty: 1, refundAmount: 0 });
    expect((await loadBooking(bookingC.id)).resaleMatchedAt).not.toBeNull();

    // 마지막 자리까지 팔리면 취소 좌석이 다시 팔린 것이다.
    const bookingD = await bookAndPay(await customer(), l.seat.id);
    const extra = Math.floor((PRICE * RESALE) / 100);
    expect(await loadBooking(bookingA.id)).toMatchObject({
      status: "CANCELLED",
      resalePendingQty: 0,
      refundRate: 0,
      refundAmount: extra,
      paymentState: "PARTIALLY_REFUNDED",
      commissionAmount: applyBps(PRICE - extra, S.commissionNewCustomerBps),
    });
    expect(await refundsOf(bookingA.id)).toMatchObject([{ amount: extra, reason: "RESALE", status: "DONE", requestedBy: "SYSTEM" }]);
    const notices = await notificationsOf(a.id, "REFUND_DONE");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain("취소하신 자리가 다시 예약되어");

    // 새 예약이 나중에 취소돼도 회수하지 않고, 다시 정산해도 더 주지 않는다.
    expect(await settleResaleFor(bookingD.id)).toEqual([]);
    await cancelBookingBySeller(l.owner.id, bookingD.id, "사정");
    expect((await loadBooking(bookingA.id)).refundAmount).toBe(extra);
    expect(await refundsOf(bookingA.id)).toHaveLength(1);
    await expectCleanInventory();
  });

  it("보류 중인 좌석은 팔린 것으로 치지 않는다(다시 올린 뒤 팔려야 환불)", async () => {
    const l = await resaleListing(3);
    await prisma.business.update({ where: { id: l.business.id }, data: { autoRelist: false } });
    const a = await customer();
    const bookingA = await bookAndPay(a, l.seat.id);
    await bookAndPay(await customer(), l.seat.id);
    passGrace();
    await cancelBookingByCustomer({ userId: a.id, bookingId: bookingA.id });
    expect(await loadSeat(l.seat.id)).toMatchObject({ reserved: 2, withheld: 1 });

    // 공개된 마지막 자리가 팔려도 취소 좌석은 보류 중이라 팔린 것이 아니다.
    await bookAndPay(await customer(), l.seat.id);
    expect(await loadSeat(l.seat.id)).toMatchObject({ reserved: 3, withheld: 1 });
    expect(await loadBooking(bookingA.id)).toMatchObject({ resalePendingQty: 1, refundAmount: 0 });

    await relistSeats(l.owner.id, l.seat.id);
    await bookAndPay(await customer(), l.seat.id);

    expect(await loadBooking(bookingA.id)).toMatchObject({ resalePendingQty: 0, refundAmount: Math.floor((PRICE * RESALE) / 100) });
    await expectCleanInventory();
  });

  it("여러 명 예약은 다시 팔린 좌석 수만큼 나눠서 환불한다", async () => {
    const l = await resaleListing(2);
    const a = await customer();
    const bookingA = await bookAndPay(a, l.seat.id, { quantity: 2 });
    passGrace();
    await cancelBookingByCustomer({ userId: a.id, bookingId: bookingA.id });
    expect((await loadBooking(bookingA.id)).resalePendingQty).toBe(2);
    const perSeat = Math.floor((PRICE * 2 * RESALE * 1) / (100 * 2));

    await bookAndPay(await customer(), l.seat.id);
    // 취소 2석 중 1석은 아직 비어 있다 → 다시 팔린 것은 0석이 아니라… 남은 빈자리 1 < 대기 2 이므로 1석이 팔린 것이다.
    expect(await loadBooking(bookingA.id)).toMatchObject({ resalePendingQty: 1, refundAmount: perSeat });

    await bookAndPay(await customer(), l.seat.id);
    expect(await loadBooking(bookingA.id)).toMatchObject({ resalePendingQty: 0, refundAmount: perSeat * 2 });
    expect((await refundsOf(bookingA.id)).map((r) => r.amount)).toEqual([perSeat, perSeat]);
  });

  it("일부 환불 구간에서 취소했으면 차이만큼만 더 환불한다", async () => {
    const l = await resaleListing(1, { startsInHours: 48 });
    const a = await customer();
    const bookingA = await bookAndPay(a, l.seat.id);
    passGrace();

    const cancelled = await cancelBookingByCustomer({ userId: a.id, bookingId: bookingA.id });
    expect(cancelled).toEqual({ refundRate: 50, refundAmount: PRICE / 2, refundStatus: "DONE", resaleRefundRate: RESALE });
    expect((await previewCancellation({ userId: a.id, bookingId: bookingA.id })).resale).toBeUndefined();

    await bookAndPay(await customer(), l.seat.id);

    const extra = Math.floor((PRICE * (RESALE - 50)) / 100);
    expect(await loadBooking(bookingA.id)).toMatchObject({ refundAmount: PRICE / 2 + extra, resalePendingQty: 0, paymentState: "PARTIALLY_REFUNDED" });
    expect((await refundsOf(bookingA.id)).map((r) => r.amount)).toEqual([PRICE / 2, extra]);
  });

  it("취소 전 미리보기는 재판매 때 더 받을 수 있는 금액을 알려 준다", async () => {
    const l = await resaleListing(2);
    const a = await customer();
    const bookingA = await bookAndPay(a, l.seat.id);
    passGrace();

    const preview = await previewCancellation({ userId: a.id, bookingId: bookingA.id });
    expect(preview).toMatchObject({ refundRate: 0, refundAmount: 0, retained: PRICE, resale: { rate: RESALE, extraAmount: Math.floor((PRICE * RESALE) / 100) } });
  });

  it("전액 환불 구간·현장 결제·사업자 취소에는 재판매 대기를 걸지 않는다", async () => {
    const full = await resaleListing(2, { startsInHours: 100 });
    const u1 = await customer();
    const b1 = await bookAndPay(u1, full.seat.id);
    passGrace();
    const r1 = await cancelBookingByCustomer({ userId: u1.id, bookingId: b1.id });
    expect(r1.resaleRefundRate).toBeUndefined();
    expect((await loadBooking(b1.id)).resalePendingQty).toBe(0);

    const onsite = await resaleListing(2, { product: { paymentPolicy: "ONSITE" } });
    const u2 = await customer();
    const b2 = await book(u2, onsite.seat.id);
    passGrace();
    await cancelBookingByCustomer({ userId: u2.id, bookingId: b2.booking.id });
    expect((await loadBooking(b2.booking.id)).resalePendingQty).toBe(0);

    const seller = await resaleListing(2);
    const b3 = await bookAndPay(await customer(), seller.seat.id);
    await cancelBookingBySeller(seller.owner.id, b3.id, "사정");
    expect((await loadBooking(b3.id)).resalePendingQty).toBe(0);
  });

  it("직접 입력 예약으로 자리가 차도 재판매로 치지 않는다", async () => {
    const l = await resaleListing(1);
    const a = await customer();
    const bookingA = await bookAndPay(a, l.seat.id);
    passGrace();
    await cancelBookingByCustomer({ userId: a.id, bookingId: bookingA.id });

    const manual = await createManualBooking(l.owner.id, l.business.id, { slotSeatId: l.seat.id, quantity: 1, guestName: "전화 손님", guestPhone: nextPhone() });

    expect(await loadBooking(bookingA.id)).toMatchObject({ resalePendingQty: 1, refundAmount: 0 });
    expect((await loadBooking(manual.id)).resaleMatchedAt).toBeNull();
    expect(await settleResaleFor(manual.id)).toEqual([]);
  });

  it("회차가 시작되면 남은 재판매 대기를 정리한다(여러 번 돌려도 같다)", async () => {
    const l = await resaleListing(2);
    const a = await customer();
    const bookingA = await bookAndPay(a, l.seat.id);
    passGrace();
    await cancelBookingByCustomer({ userId: a.id, bookingId: bookingA.id });

    expect(await clearStaleResalePending()).toBe(0);
    travel(12 * HOUR);
    expect(await clearStaleResalePending()).toBe(1);
    expect(await clearStaleResalePending()).toBe(0);
    expect(await loadBooking(bookingA.id)).toMatchObject({ resalePendingQty: 0, refundAmount: 0 });
    await expectCleanInventory();
  });
});

// ───────────────────────── 회차 취소·개최 확정 ─────────────────────────

describe("회차 취소", () => {
  it("결제 대기·승인 대기·확정 예약을 모두 전액 환불로 취소하고, 대기를 닫고, 사유와 함께 알린다", async () => {
    const l = await listing([{ label: "A", capacity: 4 }, { label: "B", capacity: 4, price: 0 }], { startsInHours: 12 });
    const seatB = l.slot.seats[1]!;
    const paidUser = await customer();
    const paid = await bookAndPay(paidUser, l.seat.id);
    const holdUser = await customer();
    const hold = await book(holdUser, l.seat.id);
    const freeUser = await customer();
    const free = await book(freeUser, seatB.id);
    const manual = await createManualBooking(l.owner.id, l.business.id, { slotSeatId: l.seat.id, quantity: 1, guestName: "전화 손님", guestPhone: nextPhone() });
    const waiting = await prisma.waitlistEntry.create({ data: { userId: (await customer()).id, slotId: l.slot.id, slotSeatId: seatB.id, status: "WAITING" } });
    await prisma.slotSeat.update({ where: { id: seatB.id }, data: { reserved: { increment: 1 } } });
    const offered = await prisma.waitlistEntry.create({
      data: { userId: (await customer()).id, slotId: l.slot.id, slotSeatId: seatB.id, status: "OFFERED", offeredAt: new Date(), offerExpiresAt: new Date(Date.now() + HOUR) },
    });
    travel(S.cancelGraceMinutes * MINUTE + MINUTE);

    const result = await cancelSlot({ type: "SELLER", userId: l.owner.id }, l.slot.id, "장소 대관이 취소됐어요");

    expect(result).toEqual({ cancelled: true, cancelledBookings: 4, refundFailures: 0 });
    expect(await loadSlot(l.slot.id)).toMatchObject({ status: "CANCELLED", cancelReason: "장소 대관이 취소됐어요" });
    // 환불 불가 구간이어도 전액 환불
    expect(await loadBooking(paid.id)).toMatchObject({ status: "CANCELLED", cancelledBy: "SELLER", refundRate: 100, refundAmount: PRICE, paymentState: "REFUNDED", commissionAmount: 0 });
    expect(await loadBooking(hold.booking.id)).toMatchObject({ status: "CANCELLED", cancelledBy: "SELLER", refundAmount: 0, paymentState: "UNPAID" });
    expect((await paymentOf(hold.booking.id)).status).toBe("CANCELLED");
    expect((await loadBooking(free.booking.id)).status).toBe("CANCELLED");
    expect((await loadBooking(manual.id)).status).toBe("CANCELLED");
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe("CLOSED");
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: offered.id } })).status).toBe("CLOSED");
    expect(await loadSeat(l.seat.id)).toMatchObject({ reserved: 0, withheld: 0 });
    expect(await loadSeat(seatB.id)).toMatchObject({ reserved: 0, withheld: 0 });

    for (const user of [paidUser, holdUser, freeUser]) {
      const notices = await notificationsOf(user.id, "SLOT_CANCELLED");
      expect(notices).toHaveLength(1);
      expect(notices[0]?.body).toContain("장소 대관이 취소됐어요");
    }
    expect((await notificationsOf(paidUser.id, "SLOT_CANCELLED"))[0]?.body).toContain("전액 환불");
    // 고객의 취소 이력으로 세지 않는다.
    expect((await loadUser(paidUser.id)).lateCancelCount).toBe(0);
    expect(await prisma.businessCustomer.count({ where: { cancelCount: { gt: 0 } } })).toBe(0);
    // 취소된 회차에는 새 예약을 받을 수 없다.
    expect((await appError(book(await customer(), l.seat.id))).code).toBe("CLOSED");
    expect((await appError(cancelSlot({ type: "SELLER", userId: l.owner.id }, l.slot.id, "다시"))).code).toBe("CONFLICT");
    expect(await refundsOf(paid.id)).toHaveLength(1);
    await expectCleanInventory();
  });

  it("사업자는 매니저 이상만, 회차 시작 전까지만 취소할 수 있다. 운영자는 OPS·CS·SUPER", async () => {
    const l = await listing([{ capacity: 2 }], { startsInHours: 2 });
    const staff = await staffOf(l.business.id, "STAFF");
    const other = await listing();

    expect((await appError(cancelSlot({ type: "SELLER", userId: staff.id }, l.slot.id, "사유"))).code).toBe("FORBIDDEN");
    expect((await appError(cancelSlot({ type: "SELLER", userId: other.owner.id }, l.slot.id, "사유"))).code).toBe("FORBIDDEN");
    expect((await appError(cancelSlot({ type: "ADMIN", admin: await admin("FINANCE") }, l.slot.id, "사유"))).code).toBe("FORBIDDEN");
    expect((await appError(cancelSlot({ type: "SELLER", userId: l.owner.id }, l.slot.id, ""))).code).toBe("VALIDATION");
    travel(2 * HOUR + MINUTE);
    expect((await appError(cancelSlot({ type: "SELLER", userId: l.owner.id }, l.slot.id, "사유"))).code).toBe("CLOSED");
    expect((await loadSlot(l.slot.id)).status).toBe("OPEN");

    const result = await cancelSlot({ type: "ADMIN", admin: await admin("OPS") }, l.slot.id, "운영 정책 위반");
    expect(result.cancelled).toBe(true);
    expect(await notificationsOf(l.owner.id, "SLOT_CANCELLED")).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: "slot.cancel", targetId: l.slot.id } })).toBe(1);
  });
});

describe("개최 확정(최소 인원)", () => {
  /** 남성 최소 2명·여성 최소 1명, 판정은 시작 24시간 전. 현장 결제라 예약하면 바로 확정된다. */
  const gathering = async (options: ListingOptions = {}) => {
    const l = await listing(
      [
        { label: "남성", gender: "MALE", capacity: 3 },
        { label: "여성", gender: "FEMALE", capacity: 3 },
      ],
      { startsInHours: 72, ...options, product: { paymentPolicy: "ONSITE", ...options.product } },
    );
    const [male, female] = l.slot.seats;
    await prisma.slotSeat.update({ where: { id: male!.id }, data: { minCount: 2 } });
    await prisma.slotSeat.update({ where: { id: female!.id }, data: { minCount: 1 } });
    await prisma.slot.update({ where: { id: l.slot.id }, data: { decideAt: new Date(l.slot.startAt.getTime() - DAY) } });
    return { ...l, male: male!, female: female! };
  };
  const man = () => customer({ gender: "MALE" });
  const woman = () => customer({ gender: "FEMALE" });

  it("getGoState: 조건 없음 / 모으는 중(좌석별 남은 인원) / 확정", () => {
    const decideAt = new Date();
    const seats = [
      { id: "m", label: "남성", minCount: 2 },
      { id: "f", label: "여성", minCount: 1 },
    ];
    expect(getGoState({ decideAt, goConfirmedAt: null, seats: seats.map((s) => ({ ...s, minCount: 0 })) }, {})).toEqual({ state: "NONE", needs: [], decideAt: null });
    expect(getGoState({ decideAt, goConfirmedAt: null, seats }, new Map([["m", 1]]))).toEqual({
      state: "GATHERING",
      needs: [
        { seatId: "m", label: "남성", remaining: 1 },
        { seatId: "f", label: "여성", remaining: 1 },
      ],
      decideAt,
    });
    expect(getGoState({ decideAt, goConfirmedAt: null, seats }, { m: 2, f: 1 })).toEqual({ state: "GATHERING", needs: [], decideAt });
    expect(getGoState({ decideAt, goConfirmedAt: new Date(), seats }, {})).toEqual({ state: "CONFIRMED", needs: [], decideAt });
  });

  it("모든 좌석 유형이 최소 인원을 채우는 순간 개최가 확정되고, 이후 취소가 나와도 되돌리지 않는다", async () => {
    const l = await gathering();
    const m1 = await man();
    const f1 = await woman();
    const m2 = await man();

    const first = await book(m1, l.male.id);
    const quote = await getBookingQuote({ userId: f1.id, slotSeatId: l.female.id, quantity: 1 });
    expect(quote.go).toMatchObject({
      state: "GATHERING",
      needs: [
        { seatId: l.male.id, label: "남성", remaining: 1 },
        { seatId: l.female.id, label: "여성", remaining: 1 },
      ],
    });
    await book(f1, l.female.id);
    expect((await loadSlot(l.slot.id)).goConfirmedAt).toBeNull();

    await book(m2, l.male.id);

    expect((await loadSlot(l.slot.id)).goConfirmedAt).not.toBeNull();
    for (const user of [m1, f1, m2]) {
      const notices = await notificationsOf(user.id, "SLOT_GO_CONFIRMED");
      expect(notices).toHaveLength(1);
      expect(notices[0]?.title).toBe("개최가 확정됐어요");
    }
    expect(await notificationsOf(l.owner.id, "SLOT_GO_CONFIRMED")).toHaveLength(1);
    expect((await getBookingForCustomer(m1.id, first.booking.code)).go.state).toBe("CONFIRMED");

    // 확정 뒤 취소가 나와도 그대로이고, 판정 작업도 취소하지 않는다.
    await cancelBookingByCustomer({ userId: m2.id, bookingId: (await prisma.booking.findFirstOrThrow({ where: { userId: m2.id } })).id });
    travel(2 * DAY + MINUTE);
    expect(await decideDueSlots()).toEqual({ confirmed: 0, cancelled: 0 });
    expect(await loadSlot(l.slot.id)).toMatchObject({ status: "OPEN" });
    expect((await loadSlot(l.slot.id)).goConfirmedAt).not.toBeNull();
    expect(await notificationsOf(m1.id, "SLOT_GO_CONFIRMED")).toHaveLength(1);
  });

  it("직접 입력 예약도 확정 인원에 들어간다", async () => {
    const l = await gathering();
    await book(await woman(), l.female.id);

    await createManualBooking(l.owner.id, l.business.id, { slotSeatId: l.male.id, quantity: 2, guestName: "단골 손님", guestPhone: nextPhone() });

    expect((await loadSlot(l.slot.id)).goConfirmedAt).not.toBeNull();
  });

  it("판정 시각까지 못 채우면 회차를 취소하고 전액 환불한다. 다시 돌려도 결과가 같다", async () => {
    const l = await gathering({ product: { paymentPolicy: "PREPAY" } });
    const m1 = await man();
    const f1 = await woman();
    const paidM = await bookAndPay(m1, l.male.id);
    const paidF = await bookAndPay(f1, l.female.id);

    expect(await decideDueSlots()).toEqual({ confirmed: 0, cancelled: 0 });
    travel(2 * DAY + MINUTE);
    expect(await decideDueSlots()).toEqual({ confirmed: 0, cancelled: 1 });
    expect(await decideDueSlots()).toEqual({ confirmed: 0, cancelled: 0 });

    expect(await loadSlot(l.slot.id)).toMatchObject({ status: "CANCELLED", cancelReason: "최소 인원이 모이지 않아 열리지 않게 됐어요", goConfirmedAt: null });
    for (const booking of [paidM, paidF]) {
      expect(await loadBooking(booking.id)).toMatchObject({ status: "CANCELLED", cancelledBy: "SYSTEM", refundRate: 100, refundAmount: PRICE, paymentState: "REFUNDED" });
      expect(await refundsOf(booking.id)).toMatchObject([{ amount: PRICE, status: "DONE" }]);
    }
    const notices = await notificationsOf(m1.id, "SLOT_CANCELLED");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain("최소 인원이 모이지 않아");
    expect(await notificationsOf(l.owner.id, "SLOT_CANCELLED")).toHaveLength(1);
    await expectCleanInventory();
  });

  it("판정 시각에 최소 인원을 채웠는데 확정 기록이 없으면 그때 확정한다", async () => {
    const l = await gathering();
    // 확정 판정이 누락된 상황: 예약을 직접 넣어 최소 인원만 채운다.
    for (const [user, seat] of [[await man(), l.male], [await man(), l.male], [await woman(), l.female]] as const) await book(user, seat.id);
    await prisma.slot.update({ where: { id: l.slot.id }, data: { goConfirmedAt: null } });
    travel(2 * DAY + MINUTE);

    expect(await decideDueSlots()).toEqual({ confirmed: 1, cancelled: 0 });
    expect(await loadSlot(l.slot.id)).toMatchObject({ status: "OPEN" });
    expect((await loadSlot(l.slot.id)).goConfirmedAt).not.toBeNull();
  });

  it("사업자가 직접 확정하면(매니저 이상) 최소 인원을 못 채워도 열린다", async () => {
    const l = await gathering();
    const m1 = await man();
    await book(m1, l.male.id);
    const staff = await staffOf(l.business.id, "STAFF");

    expect((await appError(confirmSlotGo(staff.id, l.slot.id))).code).toBe("FORBIDDEN");
    const result = await confirmSlotGo(l.owner.id, l.slot.id);

    expect(result.goConfirmedAt).toBeInstanceOf(Date);
    expect(await notificationsOf(m1.id, "SLOT_GO_CONFIRMED")).toHaveLength(1);
    expect((await appError(confirmSlotGo(l.owner.id, l.slot.id))).code).toBe("CONFLICT");
    travel(2 * DAY + MINUTE);
    expect(await decideDueSlots()).toEqual({ confirmed: 0, cancelled: 0 });
    expect((await loadSlot(l.slot.id)).status).toBe("OPEN");

    const plain = await listing();
    expect((await appError(confirmSlotGo(plain.owner.id, plain.slot.id))).code).toBe("VALIDATION");
  });
});

// ───────────────────────── 참석·체크인·노쇼 ─────────────────────────

describe("참석 확정과 체크인", () => {
  it("참석 확정: 확정 예약이고 시작 전일 때만, 다시 눌러도 처음 시각을 유지한다", async () => {
    const l = await listing([{ capacity: 3 }], { startsInHours: 30 });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);
    const pendingUser = await customer();
    const pending = await book(pendingUser, l.seat.id);

    const first = await confirmAttendance({ userId: user.id, bookingId: booking.id });
    travel(HOUR);
    const again = await confirmAttendance({ userId: user.id, bookingId: booking.id });

    expect(again.attendanceConfirmedAt).toEqual(first.attendanceConfirmedAt);
    expect((await loadBooking(booking.id)).attendanceConfirmedAt).toEqual(first.attendanceConfirmedAt);
    expect((await appError(confirmAttendance({ userId: (await customer()).id, bookingId: booking.id }))).code).toBe("NOT_FOUND");
    // 결제 대기 중인 예약은 아직 확정이 아니다.
    expect((await appError(confirmAttendance({ userId: pendingUser.id, bookingId: pending.booking.id }))).code).toBe("CONFLICT");
    travel(30 * HOUR);
    const late = await bookAndPayStarted();
    expect((await appError(confirmAttendance({ userId: late.user.id, bookingId: late.booking.id }))).code).toBe("CLOSED");
  });

  /** 이미 시작한 회차의 확정 예약 */
  async function bookAndPayStarted() {
    const l = await listing([{ capacity: 3 }], { startsInHours: 2 });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);
    travel(2 * HOUR + MINUTE);
    return { l, user, booking };
  }

  it("예약번호(대소문자 무관)나 QR 토큰으로 체크인하면 이용 완료가 되고 고객 카드에 반영된다", async () => {
    const l = await listing([{ capacity: 3 }], { startsInHours: 2, product: { paymentPolicy: "DEPOSIT", depositAmount: 10_000 } });
    const u1 = await customer();
    const u2 = await customer();
    const b1 = await bookAndPay(u1, l.seat.id);
    const b2 = await bookAndPay(u2, l.seat.id);
    const staff = await staffOf(l.business.id, "STAFF");

    const byCode = await checkInBooking(staff.id, { businessId: l.business.id, codeOrToken: b1.code.toLowerCase() });
    const byToken = await checkInBooking(l.owner.id, { businessId: l.business.id, codeOrToken: b2.checkinToken });

    expect(byCode).toMatchObject({ bookingId: b1.id, code: b1.code, quantity: 1, payOnsiteAmount: PRICE - 10_000 });
    expect(byToken.bookingId).toBe(b2.id);
    const done = await loadBooking(b1.id);
    expect(done).toMatchObject({ status: "COMPLETED" });
    expect(done.checkedInAt).toEqual(byCode.checkedInAt);
    expect(done.completedAt).not.toBeNull();
    const card = await prisma.businessCustomer.findFirstOrThrow({ where: { businessId: l.business.id, userId: u1.id } });
    expect(card).toMatchObject({ bookingCount: 1, completedCount: 1, totalSpent: PRICE });

    const again = await appError(checkInBooking(staff.id, { businessId: l.business.id, codeOrToken: b1.code }));
    expect(again.code).toBe("CONFLICT");
    expect(again.message).toMatch(/^이미 .+에 체크인한 예약이에요\.$/);
    expect((await prisma.businessCustomer.findFirstOrThrow({ where: { id: card.id } })).completedCount).toBe(1);
  });

  it("체크인은 시작 3시간 전부터 종료 3시간 뒤까지만 할 수 있다", async () => {
    const l = await listing([{ capacity: 3 }], { startsInHours: 5, durationMin: 60 });
    const booking = await bookAndPay(await customer(), l.seat.id);
    const attempt = () => checkInBooking(l.owner.id, { businessId: l.business.id, codeOrToken: booking.code });

    expect((await appError(attempt())).code).toBe("VALIDATION");
    travel(5 * HOUR + 60 * MINUTE + 3 * HOUR + MINUTE);
    expect((await appError(attempt())).code).toBe("CLOSED");
    expect((await loadBooking(booking.id)).status).toBe("CONFIRMED");
    travel(-2 * MINUTE);
    expect((await attempt()).bookingId).toBe(booking.id);
  });

  it("다른 사업장의 예약은 찾을 수 없고, 구성원이 아니면 체크인할 수 없다. 확정이 아닌 예약도 안 된다", async () => {
    const l = await listing([{ capacity: 3 }], { startsInHours: 2 });
    const other = await listing();
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);
    const pending = await book(await customer(), l.seat.id);

    expect((await appError(checkInBooking(other.owner.id, { businessId: other.business.id, codeOrToken: booking.code }))).code).toBe("NOT_FOUND");
    expect((await appError(checkInBooking(other.owner.id, { businessId: other.business.id, codeOrToken: booking.checkinToken }))).code).toBe("NOT_FOUND");
    expect((await appError(checkInBooking(other.owner.id, { businessId: l.business.id, codeOrToken: booking.code }))).code).toBe("FORBIDDEN");
    expect((await appError(checkInBooking(user.id, { businessId: l.business.id, codeOrToken: booking.code }))).code).toBe("FORBIDDEN");
    expect((await appError(checkInBooking(l.owner.id, { businessId: l.business.id, codeOrToken: pending.booking.code }))).code).toBe("CONFLICT");
    expect((await appError(checkInBooking(l.owner.id, { businessId: l.business.id, codeOrToken: "NJ-ZZZZZZ" }))).code).toBe("NOT_FOUND");
    expect((await loadBooking(booking.id)).status).toBe("CONFIRMED");
  });
});

describe("노쇼", () => {
  /** 이미 시작한 회차의 확정 예약을 만든다(같은 회원으로 여러 번 부를 수 있다). */
  async function startedBooking(user: TestUser) {
    const l = await listing([{ capacity: 3 }], { startsInHours: 2 });
    const booking = await bookAndPay(user, l.seat.id);
    travel(2 * HOUR + MINUTE);
    return { l, booking };
  }

  it("회차가 시작된 뒤에만 처리할 수 있고, 처리하면 횟수·이의제기 방법을 고객에게 알린다", async () => {
    const l = await listing([{ capacity: 3 }], { startsInHours: 2, durationMin: 120 });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);
    const staff = await staffOf(l.business.id, "STAFF");

    expect((await appError(markNoShow(staff.id, booking.id))).code).toBe("VALIDATION");
    travel(2 * HOUR + MINUTE);
    const result = await markNoShow(staff.id, booking.id);

    expect(result.canRelist).toBe(true);
    expect(result.recentNoShows).toBe(1);
    const after = await loadBooking(booking.id);
    expect(after).toMatchObject({ status: "NO_SHOW", refundAmount: 0, paymentState: "PAID" });
    expect(after.noShowAt).not.toBeNull();
    expect((await loadUser(user.id)).noShowCount).toBe(1);
    expect((await prisma.businessCustomer.findFirstOrThrow({ where: { businessId: l.business.id } })).noShowCount).toBe(1);
    // 노쇼 좌석은 여전히 재고에 잡혀 있다.
    expect((await loadSeat(l.seat.id)).reserved).toBe(1);
    const notices = await notificationsOf(user.id, "NO_SHOW_NOTICE");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain(`노쇼 1회`);
    expect(notices[0]?.body).toContain("72시간 안에");
    expect((await appError(markNoShow(staff.id, booking.id))).code).toBe("CONFLICT");
    expect((await loadUser(user.id)).noShowCount).toBe(1);
    await expectCleanInventory();
  });

  it("회차가 끝난 뒤 처리하면 다시 올릴 수 없다고 알려 준다", async () => {
    const l = await listing([{ capacity: 3 }], { startsInHours: 2, durationMin: 60 });
    const booking = await bookAndPay(await customer(), l.seat.id);
    travel(4 * HOUR);
    expect((await markNoShow(l.owner.id, booking.id)).canRelist).toBe(false);
  });

  it("노쇼가 기준 횟수에 이르면 예약을 제한하고, 되돌리면 횟수와 제한이 풀린다", async () => {
    const user = await customer();
    let last: Awaited<ReturnType<typeof startedBooking>> | undefined;
    for (let i = 1; i <= S.noShowLimit; i += 1) {
      last = await startedBooking(user);
      const result = await markNoShow(last.l.owner.id, last.booking.id);
      expect(result.recentNoShows).toBe(i);
      if (i < S.noShowLimit) {
        expect(result.restrictedUntil).toBeNull();
        expect((await loadUser(user.id)).bookingRestrictedUntil).toBeNull();
      } else {
        expect(result.restrictedUntil?.getTime()).toBe(Date.now() + S.noShowRestrictDays * DAY);
      }
    }
    if (!last) throw new Error("노쇼 기준 횟수가 1 이상이어야 해요.");

    const restricted = await loadUser(user.id);
    expect(restricted.noShowCount).toBe(S.noShowLimit);
    expect(restricted.bookingRestrictedUntil?.getTime()).toBe(Date.now() + S.noShowRestrictDays * DAY);
    const notices = await notificationsOf(user.id, "NO_SHOW_NOTICE");
    expect(notices).toHaveLength(S.noShowLimit);
    expect(notices.some((n) => n.title === "노쇼가 누적되어 예약이 제한됐어요")).toBe(true);
    const blocked = await appError(book(user, (await listing()).seat.id));
    expect(blocked.code).toBe("FORBIDDEN");
    expect(blocked.message).toContain("노쇼가 누적되어");

    // 사업자가 48시간 안에 되돌린다.
    expect(await revertNoShow(last.l.owner.id, last.booking.id)).toEqual({ status: "COMPLETED" });

    const reverted = await loadBooking(last.booking.id);
    expect(reverted).toMatchObject({ status: "COMPLETED", noShowAt: null });
    expect(reverted.checkedInAt).not.toBeNull();
    const freed = await loadUser(user.id);
    expect(freed.noShowCount).toBe(S.noShowLimit - 1);
    expect(freed.bookingRestrictedUntil).toBeNull();
    expect(await prisma.businessCustomer.findFirstOrThrow({ where: { businessId: last.l.business.id } })).toMatchObject({ noShowCount: 0, completedCount: 1 });
    expect((await book(user, (await listing()).seat.id)).booking.status).toBe("PENDING_PAYMENT");
    expect((await appError(revertNoShow(last.l.owner.id, last.booking.id))).code).toBe("CONFLICT");
  });

  it("사업자는 48시간 안에만 되돌릴 수 있고, 운영자(CS·SUPER)는 기한 없이 되돌릴 수 있다", async () => {
    const user = await customer();
    const { l, booking } = await startedBooking(user);
    await markNoShow(l.owner.id, booking.id);
    travel(48 * HOUR + MINUTE);

    expect((await appError(revertNoShow(l.owner.id, booking.id))).code).toBe("CLOSED");
    expect((await appError(adminRevertNoShow(await admin("OPS"), booking.id, "이의제기 인정"))).code).toBe("FORBIDDEN");
    expect((await appError(adminRevertNoShow(await admin("CS"), booking.id, ""))).code).toBe("VALIDATION");
    expect((await loadBooking(booking.id)).status).toBe("NO_SHOW");

    expect(await adminRevertNoShow(await admin("CS"), booking.id, "이의제기 인정")).toEqual({ status: "COMPLETED" });
    expect((await loadUser(user.id)).noShowCount).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "booking.no_show_revert", targetId: booking.id } })).toBe(1);
  });

  it("직접 입력 예약(비회원)의 노쇼는 회원 횟수 없이 예약만 바뀐다", async () => {
    const l = await listing([{ capacity: 3 }], { startsInHours: 2 });
    const manual = await createManualBooking(l.owner.id, l.business.id, { slotSeatId: l.seat.id, quantity: 1, guestName: "전화 손님", guestPhone: nextPhone() });
    travel(2 * HOUR + MINUTE);

    const result = await markNoShow(l.owner.id, manual.id);

    expect(result).toMatchObject({ recentNoShows: 0, restrictedUntil: null });
    expect((await loadBooking(manual.id)).status).toBe("NO_SHOW");
    expect((await prisma.businessCustomer.findFirstOrThrow({ where: { businessId: l.business.id } })).noShowCount).toBe(1);
  });
});

describe("자동 완료", () => {
  it("회차가 끝나고 정해진 시간이 지난 확정 예약을 이용 완료로 바꾸고 후기를 요청한다(멱등)", async () => {
    const l = await listing([{ capacity: 4 }], { startsInHours: 2, durationMin: 60 });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);
    const checkedInUser = await customer();
    const checkedIn = await bookAndPay(checkedInUser, l.seat.id);
    travel(2 * HOUR);
    await checkInBooking(l.owner.id, { businessId: l.business.id, codeOrToken: checkedIn.code });

    travel(HOUR + S.autoCompleteAfterHours * HOUR - MINUTE);
    expect(await completeDueBookings()).toBe(0);
    expect((await loadBooking(booking.id)).status).toBe("CONFIRMED");
    // 체크인한 고객에게는 회차가 끝난 뒤 후기 요청이 한 번 간다.
    expect(await notificationsOf(checkedInUser.id, "REVIEW_REQUEST")).toHaveLength(1);

    travel(2 * MINUTE);
    expect(await completeDueBookings()).toBe(1);
    expect(await completeDueBookings()).toBe(0);

    const done = await loadBooking(booking.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.checkedInAt).toBeNull();
    expect(done.completedAt).not.toBeNull();
    expect(await notificationsOf(user.id, "REVIEW_REQUEST")).toHaveLength(1);
    expect(await notificationsOf(checkedInUser.id, "REVIEW_REQUEST")).toHaveLength(1);
    expect(await prisma.businessCustomer.findFirstOrThrow({ where: { businessId: l.business.id, userId: user.id } })).toMatchObject({ completedCount: 1, totalSpent: PRICE });
    await expectCleanInventory();
  });

  it("취소된 회차의 예약과 확정이 아닌 예약은 건드리지 않는다", async () => {
    const l = await listing([{ capacity: 4 }], { startsInHours: 2, durationMin: 60 });
    const noShow = await bookAndPay(await customer(), l.seat.id);
    travel(2 * HOUR + MINUTE);
    await markNoShow(l.owner.id, noShow.id);
    travel((S.autoCompleteAfterHours + 2) * HOUR);

    expect(await completeDueBookings()).toBe(0);
    expect((await loadBooking(noShow.id)).status).toBe("NO_SHOW");
  });
});

// ───────────────────────── 직접 입력·외부 판매 ─────────────────────────

describe("직접 입력 예약과 외부 판매", () => {
  it("직접 입력 예약: 바로 확정되고 수수료가 없으며 고객 카드에 '직접 등록'으로 남는다", async () => {
    const l = await listing([{ capacity: 3, price: PRICE }]);
    const staff = await staffOf(l.business.id, "STAFF");
    const phone = nextPhone();

    const summary = await createManualBooking(staff.id, l.business.id, { slotSeatId: l.seat.id, quantity: 2, guestName: " 인스타 손님 ", guestPhone: phone, memo: "DM 예약" });

    const booking = await loadBooking(summary.id);
    expect(booking).toMatchObject({
      status: "CONFIRMED",
      channel: "MANUAL",
      source: "manual",
      userId: null,
      guestName: "인스타 손님",
      guestPhone: phone,
      sellerMemo: "DM 예약",
      quantity: 2,
      totalAmount: PRICE * 2,
      payNowAmount: 0,
      payOnsiteAmount: PRICE * 2,
      paymentMethod: "ONSITE",
      paymentState: "UNPAID",
      commissionRule: "MANUAL",
      commissionBps: 0,
      commissionAmount: 0,
      pgFeeAmount: 0,
    });
    expect(booking.confirmedAt).not.toBeNull();
    expect((await loadSeat(l.seat.id)).reserved).toBe(2);
    expect(await prisma.businessCustomer.findFirstOrThrow({ where: { businessId: l.business.id } })).toMatchObject({ phone, source: "MANUAL", bookingCount: 1 });
    // 기본은 고객에게 문자를 보내지 않는다.
    expect(await prisma.messageOutbox.count()).toBe(0);
    await expectCleanInventory();
  });

  it("연락처를 몰라도 넣을 수 있고, 현장에서 이미 받았으면 결제 완료로 남긴다. 판매 마감·예약 마감과 무관하다", async () => {
    const l = await listing([{ capacity: 3 }, { label: "무료", capacity: 2, price: 0 }], { status: "CLOSED", startsInHours: 0.5, deadlineMinBefore: 20 });

    const walkIn = await createManualBooking(l.owner.id, l.business.id, { slotSeatId: l.seat.id, quantity: 1, guestName: "현장 손님", guestPhone: "", paidOnsite: true });
    const free = await createManualBooking(l.owner.id, l.business.id, { slotSeatId: l.slot.seats[1]!.id, quantity: 1, guestName: "초대 손님", guestPhone: "" });

    expect(await loadBooking(walkIn.id)).toMatchObject({ guestPhone: "", paymentMethod: "ONSITE", paymentState: "PAID" });
    expect(await loadBooking(free.id)).toMatchObject({ paymentMethod: "FREE", totalAmount: 0 });
    expect(await prisma.businessCustomer.count()).toBe(0);
  });

  it("남은 자리보다 많이 넣을 수 없고, 다른 사업장의 좌석·취소된 회차·잘못된 입력은 거절한다", async () => {
    const l = await listing([{ capacity: 1 }]);
    const other = await listing();
    const cancelled = await listing([{ capacity: 2 }], { status: "CANCELLED" });
    const base = { slotSeatId: l.seat.id, quantity: 1, guestName: "손님", guestPhone: nextPhone() };

    expect((await appError(createManualBooking(l.owner.id, l.business.id, { ...base, quantity: 2 }))).code).toBe("SOLD_OUT");
    expect((await appError(createManualBooking(l.owner.id, l.business.id, { ...base, slotSeatId: other.seat.id }))).code).toBe("NOT_FOUND");
    expect((await appError(createManualBooking(other.owner.id, l.business.id, base))).code).toBe("FORBIDDEN");
    expect((await appError(createManualBooking(cancelled.owner.id, cancelled.business.id, { ...base, slotSeatId: cancelled.seat.id }))).code).toBe("CLOSED");
    expect((await appError(createManualBooking(l.owner.id, l.business.id, { ...base, guestPhone: "1234" }))).code).toBe("VALIDATION");
    expect((await appError(createManualBooking(l.owner.id, l.business.id, { ...base, guestName: "" }))).code).toBe("VALIDATION");
    expect((await appError(createManualBooking(l.owner.id, l.business.id, { ...base, quantity: 21 }))).code).toBe("VALIDATION");
    expect(await prisma.booking.count()).toBe(0);
    await expectCleanInventory();
  });

  it("외부 판매 −1: 금액 0원의 확정 예약으로 기록하고, 되돌리면 자리가 바로 다시 열린다", async () => {
    const l = await listing([{ capacity: 3 }]);
    const staff = await staffOf(l.business.id, "STAFF");

    const sold = await markExternalSale(staff.id, l.seat.id, 2, "네이버 예약");

    expect(sold).toMatchObject({ quantity: 2, remaining: 1 });
    expect(await loadBooking(sold.bookingId)).toMatchObject({
      status: "CONFIRMED",
      channel: "MANUAL",
      source: "external",
      userId: null,
      guestName: "외부 예약",
      guestPhone: "",
      paymentMethod: "ONSITE",
      unitPrice: 0,
      totalAmount: 0,
      payNowAmount: 0,
      payOnsiteAmount: 0,
      commissionRule: "MANUAL",
      commissionAmount: 0,
      sellerMemo: "네이버 예약",
    });
    expect(await prisma.businessCustomer.count()).toBe(0);
    expect((await appError(markExternalSale(staff.id, l.seat.id, 2))).code).toBe("SOLD_OUT");

    expect(await undoExternalSale(staff.id, sold.bookingId)).toEqual({ remaining: 3 });
    expect(await loadBooking(sold.bookingId)).toMatchObject({ status: "CANCELLED", cancelledBy: "SELLER" });
    expect(await loadSeat(l.seat.id)).toMatchObject({ reserved: 0, withheld: 0 });
    expect((await appError(undoExternalSale(staff.id, sold.bookingId))).code).toBe("CONFLICT");
    await expectCleanInventory();
  });

  it("외부 판매 기록이 아닌 예약은 되돌리기로 취소할 수 없고, 다른 사업장은 접근할 수 없다", async () => {
    const l = await listing([{ capacity: 3 }]);
    const other = await listing();
    const manual = await createManualBooking(l.owner.id, l.business.id, { slotSeatId: l.seat.id, quantity: 1, guestName: "손님", guestPhone: nextPhone() });
    const sold = await markExternalSale(l.owner.id, l.seat.id, 1);

    expect((await appError(undoExternalSale(l.owner.id, manual.id))).code).toBe("VALIDATION");
    expect((await appError(undoExternalSale(other.owner.id, sold.bookingId))).code).toBe("FORBIDDEN");
    expect((await appError(markExternalSale(other.owner.id, l.seat.id, 1))).code).toBe("FORBIDDEN");
    expect((await appError(markExternalSale(l.owner.id, l.seat.id, 0))).code).toBe("VALIDATION");
    expect((await loadSeat(l.seat.id)).reserved).toBe(2);
  });
});

// ───────────────────────── 수수료 ─────────────────────────

describe("수수료 스냅샷(규칙별)", () => {
  it("입점 프로모션: 남은 건수를 1 차감하고 중개 수수료 없이 결제 실비만 남긴다. 소진되면 일반 요율", async () => {
    const l = await listing([{ capacity: 4 }]);
    await prisma.business.update({ where: { id: l.business.id }, data: { launchPromoUntil: new Date(Date.now() + 30 * DAY), launchPromoRemaining: 1 } });

    const first = await bookAndPay(await customer(), l.seat.id);
    const second = await bookAndPay(await customer(), l.seat.id);

    expect(first).toMatchObject({ commissionRule: "PROMO", commissionBps: 0, commissionAmount: 0, pgFeeAmount: applyBps(PRICE, S.pgFeeBps) });
    expect(second).toMatchObject({ commissionRule: "MARKET_NEW", commissionAmount: applyBps(PRICE, S.commissionNewCustomerBps), pgFeeAmount: 0 });
    expect((await prisma.business.findUniqueOrThrow({ where: { id: l.business.id } })).launchPromoRemaining).toBe(0);
  });

  it("결제 대기에서 끝난 예약은 프로모션 건수를 쓰지 않는다", async () => {
    const l = await listing([{ capacity: 4 }]);
    await prisma.business.update({ where: { id: l.business.id }, data: { launchPromoUntil: new Date(Date.now() + 30 * DAY), launchPromoRemaining: 1 } });
    const user = await customer();
    const created = await book(user, l.seat.id);
    await abandonBooking({ userId: user.id, bookingId: created.booking.id });

    expect((await prisma.business.findUniqueOrThrow({ where: { id: l.business.id } })).launchPromoRemaining).toBe(1);
  });

  it("사업자가 미리 가져온 고객은 '내 고객' 규칙(중개 수수료 0, 결제 실비)", async () => {
    const l = await listing([{ capacity: 4 }]);
    const user = await customer();
    await prisma.businessCustomer.create({
      data: { businessId: l.business.id, name: "단골", phone: user.phone!, source: "IMPORTED", createdAt: new Date(Date.now() - DAY) },
    });

    const booking = await bookAndPay(user, l.seat.id);

    expect(booking).toMatchObject({ commissionRule: "OWN_CUSTOMER", commissionAmount: 0, pgFeeAmount: applyBps(PRICE, S.pgFeeBps) });
  });

  it("이용 이력이 있는 고객이 남는자리로 다시 예약하면 재방문 요율", async () => {
    const first = await listing([{ capacity: 4 }], { startsInHours: 2 });
    const user = await customer();
    const b1 = await bookAndPay(user, first.seat.id);
    travel(2 * HOUR);
    await checkInBooking(first.owner.id, { businessId: first.business.id, codeOrToken: b1.code });
    const next = await prisma.slot.create({
      data: {
        productId: first.product.id,
        businessId: first.business.id,
        startAt: new Date(Date.now() + 2 * DAY),
        endAt: new Date(Date.now() + 2 * DAY + 2 * HOUR),
        bookingDeadlineAt: new Date(Date.now() + 2 * DAY - HOUR),
        seats: { create: [{ label: "일반", capacity: 4, price: PRICE }] },
      },
      include: { seats: true },
    });

    const b2 = await bookAndPay(user, next.seats[0]!.id);

    expect(b1).toMatchObject({ commissionRule: "MARKET_NEW", isNewCustomer: true });
    expect(b2).toMatchObject({
      commissionRule: "MARKET_RETURNING",
      isNewCustomer: false,
      commissionBps: S.commissionReturningBps,
      commissionAmount: applyBps(PRICE, S.commissionReturningBps),
    });
  });

  it("좌석당 상한과 사업자 자체 링크(DIRECT) 온라인 결제", async () => {
    const price = 400_000;
    const l = await listing([{ capacity: 4, price }]);

    const market = await bookAndPay(await customer(), l.seat.id, { quantity: 2 });
    const direct = await bookAndPay(await customer(), l.seat.id, { channel: "DIRECT", source: "qr" });

    const raw = applyBps(price * 2, S.commissionNewCustomerBps);
    expect(market.commissionAmount).toBe(S.commissionCapPerSeat > 0 ? Math.min(raw, S.commissionCapPerSeat * 2) : raw);
    expect(direct).toMatchObject({
      commissionRule: "DIRECT",
      commissionBps: S.commissionDirectBps,
      pgFeeAmount: applyBps(price, S.pgFeeBps),
    });
  });
});

// ───────────────────────── 조회 ─────────────────────────

describe("고객 조회", () => {
  const ADDRESS = "대전 서구 둔산로 100";

  it("정확한 주소는 확정·이용 완료 상태일 때만 보이고, 판매자 신원정보는 항상 보인다", async () => {
    const l = await listing([{ capacity: 3 }], { startsInHours: 2, product: { address: ADDRESS, placeName: "둔산 라운지", lat: 36.35, lng: 127.38 } });
    await prisma.business.update({ where: { id: l.business.id }, data: { representativeName: "김대표", businessRegNo: "1234567890", phone: "0421234567", address: "대전 유성구" } });
    const user = await customer();
    const created = await book(user, l.seat.id);
    const view = () => getBookingForCustomer(user.id, created.booking.code);

    const pending = await view();
    expect(pending.status).toBe("PENDING_PAYMENT");
    expect(pending.place).toEqual({ placeName: "둔산 라운지", area: null, addressDisclosed: false, address: null, lat: null, lng: null });
    expect(pending.seller).toMatchObject({ name: l.business.name, representativeName: "김대표", businessRegNo: "1234567890", phone: "0421234567", address: "대전 유성구" });
    expect(pending.holdExpiresAt).toEqual(created.booking.holdExpiresAt);

    await pay(user, created);
    const confirmed = await view();
    expect(confirmed.place).toMatchObject({ addressDisclosed: true, address: ADDRESS, lat: 36.35, lng: 127.38 });
    expect(confirmed.payment).toMatchObject({ status: "PAID" });
    expect(confirmed.canConfirmAttendance).toBe(true);
    expect(confirmed.cancellation).toMatchObject({ cancellable: true });
    // 내부 값은 돌려주지 않는다.
    expect(confirmed).not.toHaveProperty("checkinToken");
    expect(confirmed).not.toHaveProperty("sellerMemo");
    expect(confirmed).not.toHaveProperty("commissionAmount");

    travel(2 * HOUR);
    await checkInBooking(l.owner.id, { businessId: l.business.id, codeOrToken: created.booking.code });
    expect((await view()).place.address).toBe(ADDRESS);
    // 예약번호는 대소문자를 가리지 않는다.
    expect((await getBookingForCustomer(user.id, created.booking.code.toLowerCase())).id).toBe(created.booking.id);
  });

  it("승인 대기·취소·거절 상태에서는 주소를 보여 주지 않는다", async () => {
    const l = await listing([{ capacity: 3 }], { startsInHours: 100, product: { address: ADDRESS, requiresApproval: true, paymentPolicy: "ONSITE" } });
    const user = await customer();
    const created = await book(user, l.seat.id);

    expect((await getBookingForCustomer(user.id, created.booking.code)).place.address).toBeNull();
    await approveBooking(l.owner.id, created.booking.id);
    expect((await getBookingForCustomer(user.id, created.booking.code)).place.address).toBe(ADDRESS);
    await cancelBookingByCustomer({ userId: user.id, bookingId: created.booking.id });
    const cancelled = await getBookingForCustomer(user.id, created.booking.code);
    expect(cancelled.place).toMatchObject({ addressDisclosed: false, address: null });
    expect(cancelled.cancellation.cancellable).toBe(false);
  });

  it("상품에 장소가 없으면 사업장 주소를 쓴다", async () => {
    const l = await listing([{ capacity: 3 }], { product: { paymentPolicy: "ONSITE" } });
    await prisma.business.update({ where: { id: l.business.id }, data: { address: "대전 중구 중앙로 1", addressDetail: "3층" } });
    const user = await customer();
    const created = await book(user, l.seat.id);

    expect((await getBookingForCustomer(user.id, created.booking.code)).place.address).toBe("대전 중구 중앙로 1 3층");
  });

  it("남의 예약은 볼 수 없다(상세·입장권·취소 미리보기)", async () => {
    const l = await listing([{ capacity: 3 }], { product: { paymentPolicy: "ONSITE" } });
    const user = await customer();
    const created = await book(user, l.seat.id);
    const stranger = await customer();

    expect((await appError(getBookingForCustomer(stranger.id, created.booking.code))).code).toBe("NOT_FOUND");
    expect((await appError(getBookingTicket(stranger.id, created.booking.code))).code).toBe("NOT_FOUND");
    expect((await appError(previewCancellation({ userId: stranger.id, bookingId: created.booking.id }))).code).toBe("NOT_FOUND");
    expect((await appError(getBookingForCustomer(user.id, "NJ-NOPE99"))).code).toBe("NOT_FOUND");
  });

  it("입장권은 확정된 예약에만 발급한다", async () => {
    const l = await listing([{ capacity: 3 }], { product: { address: ADDRESS } });
    const user = await customer();
    const created = await book(user, l.seat.id);

    expect((await appError(getBookingTicket(user.id, created.booking.code))).code).toBe("CONFLICT");
    await pay(user, created);
    const ticket = await getBookingTicket(user.id, created.booking.code);
    expect(ticket.checkinToken).toBe((await loadBooking(created.booking.id)).checkinToken);
    expect(ticket).toMatchObject({ code: created.booking.code, quantity: 1, businessName: l.business.name });
    expect(ticket.place.address).toBe(ADDRESS);

    await cancelBookingByCustomer({ userId: user.id, bookingId: created.booking.id });
    expect((await appError(getBookingTicket(user.id, created.booking.code))).code).toBe("CONFLICT");
  });

  it("내 예약 목록: 다가오는 예약 / 지난 예약 / 취소한 예약", async () => {
    const user = await customer();
    const soon = await listing([{ capacity: 3 }], { startsInHours: 30 });
    const later = await listing([{ capacity: 3 }], { startsInHours: 60 });
    const past = await listing([{ capacity: 3 }], { startsInHours: 2, durationMin: 60 });
    const gone = await listing([{ capacity: 3 }], { startsInHours: 90 });
    const bLater = await bookAndPay(user, later.seat.id);
    const bSoon = await bookAndPay(user, soon.seat.id);
    const bPast = await bookAndPay(user, past.seat.id);
    const bGone = await bookAndPay(user, gone.seat.id);
    const hold = await book(user, (await listing()).seat.id);
    await cancelBookingByCustomer({ userId: user.id, bookingId: bGone.id });
    await bookAndPay(await customer(), soon.seat.id);
    travel(4 * HOUR);

    const upcoming = await listCustomerBookings(user.id, { tab: "upcoming" });
    // 결제 대기는 홀드 시간이 지나 빠지고, 시작이 빠른 순으로 나온다.
    expect(upcoming.items.map((b) => b.id)).toEqual([bSoon.id, bLater.id]);
    expect(upcoming.nextCursor).toBeNull();
    expect((await listCustomerBookings(user.id, { tab: "past" })).items.map((b) => b.id)).toEqual([bPast.id]);
    const cancelled = await listCustomerBookings(user.id, { tab: "cancelled" });
    expect(cancelled.items.map((b) => b.id).sort()).toEqual([bGone.id].sort());
    expect(hold.booking.status).toBe("PENDING_PAYMENT");

    const page1 = await listCustomerBookings(user.id, { tab: "upcoming", limit: 1 });
    expect(page1.items.map((b) => b.id)).toEqual([bSoon.id]);
    const page2 = await listCustomerBookings(user.id, { tab: "upcoming", limit: 1, cursor: page1.nextCursor! });
    expect(page2.items.map((b) => b.id)).toEqual([bLater.id]);
    expect(page2.nextCursor).toBeNull();
    expect((await appError(listCustomerBookings(user.id, { tab: "all" as never }))).code).toBe("VALIDATION");
  });
});

describe("사업자 조회", () => {
  it("예약 목록: 전화번호는 가려서 주고, 이름·번호·예약번호로 찾고 상태로 거른다", async () => {
    const l = await listing([{ capacity: 5 }]);
    const u1 = await customer({ name: "홍길동" });
    const u2 = await customer({ name: "성춘향" });
    const b1 = await bookAndPay(u1, l.seat.id);
    const b2 = await book(u2, l.seat.id);
    const staff = await staffOf(l.business.id, "STAFF");
    const other = await listing();
    await bookAndPay(await customer(), other.seat.id);

    const all = await listSellerBookings(staff.id, l.business.id);
    expect(all.total).toBe(2);
    expect(all.items.map((b) => b.id).sort()).toEqual([b1.id, b2.booking.id].sort());
    const item = all.items.find((b) => b.id === b1.id)!;
    expect(item.phoneMasked).toBe(`${u1.phone!.slice(0, 3)}-****-${u1.phone!.slice(-4)}`);
    expect(item).not.toHaveProperty("guestPhone");

    expect((await listSellerBookings(staff.id, l.business.id, { q: "길동" })).items.map((b) => b.id)).toEqual([b1.id]);
    expect((await listSellerBookings(staff.id, l.business.id, { q: u2.phone!.slice(-4) })).items.map((b) => b.id)).toEqual([b2.booking.id]);
    expect((await listSellerBookings(staff.id, l.business.id, { q: b1.code.toLowerCase() })).items.map((b) => b.id)).toEqual([b1.id]);
    expect((await listSellerBookings(staff.id, l.business.id, { status: "PENDING_PAYMENT" })).items.map((b) => b.id)).toEqual([b2.booking.id]);
    expect((await listSellerBookings(staff.id, l.business.id, { status: ["CONFIRMED", "COMPLETED"], slotId: l.slot.id })).items.map((b) => b.id)).toEqual([b1.id]);
    expect((await listSellerBookings(staff.id, l.business.id, { from: new Date(Date.now() + 10 * DAY) })).total).toBe(0);
    expect((await appError(listSellerBookings(other.owner.id, l.business.id))).code).toBe("FORBIDDEN");
    expect((await appError(listSellerBookings(u1.id, l.business.id))).code).toBe("FORBIDDEN");
  });

  it("예약 상세: 예약자 연락처와 수수료 규칙 설명을 주고, 회차가 끝나고 30일이 지나면 연락처를 가린다", async () => {
    const l = await listing([{ capacity: 5 }], { startsInHours: 2, durationMin: 60 });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);
    const other = await listing();

    const detail = await getBookingForSeller(l.owner.id, booking.id);
    expect(detail).toMatchObject({ guestPhone: user.phone, phoneMasked: false, isMember: true, status: "CONFIRMED" });
    expect(detail.commission).toMatchObject({
      rule: "MARKET_NEW",
      ruleLabel: "남는자리 신규 고객",
      commissionAmount: applyBps(PRICE, S.commissionNewCustomerBps),
      payoutAmount: PRICE - applyBps(PRICE, S.commissionNewCustomerBps),
    });
    expect(detail.thirdPartyConsentAt).not.toBeNull();
    expect(detail).not.toHaveProperty("checkinToken");
    expect((await appError(getBookingForSeller(other.owner.id, booking.id))).code).toBe("FORBIDDEN");
    expect((await appError(getBookingForSeller(user.id, booking.id))).code).toBe("FORBIDDEN");
    expect((await appError(getBookingForSeller(l.owner.id, "missing"))).code).toBe("NOT_FOUND");

    travel(3 * HOUR + 30 * DAY + MINUTE);
    const old = await getBookingForSeller(l.owner.id, booking.id);
    expect(old.phoneMasked).toBe(true);
    expect(old.guestPhone).toBe(`${user.phone!.slice(0, 3)}-****-${user.phone!.slice(-4)}`);
  });

  it("사업자 메모: 스태프 이상이 남기고 지울 수 있다(500자), 고객에게는 보이지 않는다", async () => {
    const l = await listing([{ capacity: 5 }], { product: { paymentPolicy: "ONSITE" } });
    const user = await customer();
    const created = await book(user, l.seat.id);
    const staff = await staffOf(l.business.id, "STAFF");
    const other = await listing();

    expect(await updateSellerMemo(staff.id, created.booking.id, "  창가 요청  ")).toEqual({ sellerMemo: "창가 요청" });
    expect((await getBookingForSeller(staff.id, created.booking.id)).sellerMemo).toBe("창가 요청");
    expect((await appError(updateSellerMemo(staff.id, created.booking.id, "가".repeat(501)))).code).toBe("VALIDATION");
    expect((await appError(updateSellerMemo(other.owner.id, created.booking.id, "메모"))).code).toBe("FORBIDDEN");
    expect((await appError(updateSellerMemo(user.id, created.booking.id, "메모"))).code).toBe("FORBIDDEN");
    expect(await updateSellerMemo(staff.id, created.booking.id, "")).toEqual({ sellerMemo: null });
  });
});

// ───────────────────────── 권한 ─────────────────────────

describe("권한: 남의 예약·다른 사업장", () => {
  it("고객 기능은 본인 예약에만 쓸 수 있다", async () => {
    const l = await listing([{ capacity: 3 }]);
    const owner = await customer();
    const stranger = await customer();
    const held = await book(owner, l.seat.id);
    const other = await listing([{ capacity: 3 }]);
    const confirmed = await bookAndPay(owner, other.seat.id);
    const asStranger = { userId: stranger.id, bookingId: confirmed.id };

    expect((await appError(abandonBooking({ userId: stranger.id, bookingId: held.booking.id }))).code).toBe("NOT_FOUND");
    expect((await appError(cancelBookingByCustomer({ userId: stranger.id, bookingId: held.booking.id }))).code).toBe("NOT_FOUND");
    expect((await appError(prepareBookingPayment({ userId: stranger.id, bookingId: held.booking.id }))).code).toBe("NOT_FOUND");
    expect((await appError(cancelBookingByCustomer(asStranger))).code).toBe("NOT_FOUND");
    expect((await appError(previewCancellation(asStranger))).code).toBe("NOT_FOUND");
    expect((await appError(confirmAttendance(asStranger))).code).toBe("NOT_FOUND");
    expect(await listResumableHolds(stranger.id)).toEqual([]);
    expect((await listCustomerBookings(stranger.id, { tab: "upcoming" })).items).toEqual([]);

    expect((await loadBooking(held.booking.id)).status).toBe("PENDING_PAYMENT");
    expect(await loadBooking(confirmed.id)).toMatchObject({ status: "CONFIRMED", attendanceConfirmedAt: null });
  });

  it("사업자 기능은 그 예약의 사업장 구성원만 쓸 수 있다", async () => {
    const l = await listing([{ capacity: 3 }], { startsInHours: 2, product: { requiresApproval: true, paymentPolicy: "ONSITE" } });
    const other = await listing();
    const outsider = other.owner.id;
    const pending = await book(await customer(), l.seat.id);
    const second = await book(await customer(), l.seat.id);
    await approveBooking(l.owner.id, second.booking.id);
    const staff = await staffOf(l.business.id, "STAFF");

    for (const actor of [outsider, (await customer()).id]) {
      expect((await appError(approveBooking(actor, pending.booking.id))).code).toBe("FORBIDDEN");
      expect((await appError(rejectBooking(actor, pending.booking.id, "사유"))).code).toBe("FORBIDDEN");
      expect((await appError(cancelBookingBySeller(actor, second.booking.id, "사유"))).code).toBe("FORBIDDEN");
      expect((await appError(markNoShow(actor, second.booking.id))).code).toBe("FORBIDDEN");
      expect((await appError(revertNoShow(actor, second.booking.id))).code).toBe("FORBIDDEN");
      expect((await appError(relistSeats(actor, l.seat.id))).code).toBe("FORBIDDEN");
      expect((await appError(cancelSlot({ type: "SELLER", userId: actor }, l.slot.id, "사유"))).code).toBe("FORBIDDEN");
    }
    // 스태프는 승인·거절·취소를 할 수 없다(매니저 이상).
    expect((await appError(approveBooking(staff.id, pending.booking.id))).code).toBe("FORBIDDEN");
    expect((await appError(rejectBooking(staff.id, pending.booking.id))).code).toBe("FORBIDDEN");

    expect((await loadBooking(pending.booking.id)).status).toBe("PENDING_APPROVAL");
    expect((await loadBooking(second.booking.id)).status).toBe("CONFIRMED");
    expect((await loadSlot(l.slot.id)).status).toBe("OPEN");
  });
});

// ───────────────────────── 주기 작업 ─────────────────────────

describe("주기 작업은 여러 번 실행해도 결과가 같다", () => {
  it("할 일이 없는 상태에서 모든 작업을 돌려도 아무것도 바뀌지 않는다", async () => {
    const l = await listing([{ capacity: 4 }]);
    const user = await customer();
    const confirmed = await bookAndPay(user, l.seat.id);
    const hold = await book(await customer(), l.seat.id);
    const snapshot = async () => ({
      bookings: await prisma.booking.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, refundAmount: true, paymentState: true } }),
      seat: await loadSeat(l.seat.id),
      slot: await loadSlot(l.slot.id),
      refunds: await prisma.refund.count(),
      notifications: await prisma.notification.count(),
    });
    const before = await snapshot();

    for (let round = 0; round < 2; round += 1) {
      expect(await expireHolds()).toBe(0);
      expect(await expireStaleApprovals()).toBe(0);
      expect(await completeDueBookings()).toBe(0);
      expect(await clearStaleResalePending()).toBe(0);
      expect(await reconcileDuePayments()).toBe(0);
      expect(await decideDueSlots()).toEqual({ confirmed: 0, cancelled: 0 });
    }

    expect(await snapshot()).toEqual(before);
    expect((await loadBooking(confirmed.id)).status).toBe("CONFIRMED");
    expect((await loadBooking(hold.booking.id)).status).toBe("PENDING_PAYMENT");
  });
});
