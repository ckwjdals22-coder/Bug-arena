import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { newToken } from "@/lib/ids";
import { DAY, HOUR, MINUTE } from "@/lib/time";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  abandonBooking,
  approveBooking,
  cancelBookingByCustomer,
  cancelBookingBySeller,
  checkInBooking,
  confirmBookingPayment,
  createBooking,
  expireHolds,
  markNoShow,
  rejectBooking,
  settleResaleFor,
  type CreateBookingInput,
  type CreateBookingResult,
} from "@/server/services/booking";
import { verifyInventoryIntegrity } from "@/server/services/inventory";
import { newMockPaymentKey } from "@/server/services/payments";
import { mockPaymentProvider } from "@/server/services/payments/mock";
import { cancelSlot, decideDueSlots, updateSeat } from "@/server/services/slots";
import { setWaitlistProcessor } from "@/server/services/vacancy";
import { DEFAULT_SETTINGS } from "@/server/settings";
import { createListing, createUser, resetDb, type SeatSpec } from "./helpers";

/**
 * 동시성 테스트. 모든 경쟁은 Promise.all 로 실제로 동시에 실행한다(가짜 타이머를 쓰지 않는다).
 * 어떤 순서로 끝나든 지켜져야 하는 불변식을 확인한다.
 */

type ListingOptions = Parameters<typeof createListing>[1];
type TestUser = Awaited<ReturnType<typeof createUser>>;

const PRICE = 30_000;
const S = DEFAULT_SETTINGS;

let phoneSeq = 0;
const nextPhone = () => `0108${String(++phoneSeq).padStart(7, "0")}`;
const customer = (overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) =>
  createUser({ gender: "MALE", birthYear: 1995, phone: nextPhone(), ...overrides });
const customers = (count: number) => Promise.all(Array.from({ length: count }, () => customer()));
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

function pay(user: TestUser, created: CreateBookingResult, paymentKey = newMockPaymentKey()) {
  if (!created.payment) throw new Error("결제할 주문이 없어요.");
  return confirmBookingPayment({ userId: user.id, orderId: created.payment.orderId, paymentKey, amount: created.payment.amount });
}

async function bookAndPay(user: TestUser, slotSeatId: string, overrides: Partial<CreateBookingInput> = {}) {
  const created = await book(user, slotSeatId, overrides);
  await pay(user, created);
  return prisma.booking.findUniqueOrThrow({ where: { id: created.booking.id } });
}

/** 성공·실패를 모아서 본다. 업무 오류(AppError)가 아닌 실패는 테스트를 바로 깨뜨린다. */
async function settle<T>(tasks: Promise<T>[]): Promise<{ ok: T[]; errors: AppError[] }> {
  const results = await Promise.allSettled(tasks);
  const ok: T[] = [];
  const errors: AppError[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") ok.push(result.value);
    else if (result.reason instanceof AppError) errors.push(result.reason);
    else throw result.reason;
  }
  return { ok, errors };
}

const loadBooking = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });
const loadSeat = (id: string) => prisma.slotSeat.findUniqueOrThrow({ where: { id } });
const paymentOf = (bookingId: string) => prisma.payment.findFirstOrThrow({ where: { bookingId } });
const refundsOf = (bookingId: string) => prisma.refund.findMany({ where: { bookingId } });

async function expectCleanInventory() {
  expect(await verifyInventoryIntegrity()).toEqual([]);
}

/** 이미 지난 것으로 만든다: 예약 직후 무료 취소 시간을 넘긴다. */
const pastGrace = (bookingId: string) =>
  prisma.booking.update({
    where: { id: bookingId },
    data: { confirmedAt: new Date(Date.now() - S.cancelGraceMinutes * MINUTE - MINUTE), createdAt: new Date(Date.now() - S.cancelGraceMinutes * MINUTE - MINUTE) },
  });

beforeEach(async () => {
  await resetDb();
  setWaitlistProcessor(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ───────────────────────── 좌석 확보 ─────────────────────────

describe("동시 예약", () => {
  it("30명이 마지막 3자리를 동시에 예약하면 정확히 3명만 성공하고 27명은 SOLD_OUT", async () => {
    const l = await listing([{ capacity: 3 }]);
    const users = await customers(30);

    const { ok, errors } = await settle(users.map((user) => book(user, l.seat.id)));

    expect(ok).toHaveLength(3);
    expect(errors).toHaveLength(27);
    expect(errors.every((e) => e.code === "SOLD_OUT")).toBe(true);
    expect((await loadSeat(l.seat.id)).reserved).toBe(3);
    expect(await prisma.booking.count({ where: { slotId: l.slot.id } })).toBe(3);
    expect(await prisma.payment.count()).toBe(3);
    // 실패한 예약의 동의 기록은 남지 않는다.
    expect(await prisma.consentRecord.count()).toBe(6);
    expect(new Set(ok.map((r) => r.booking.code)).size).toBe(3);
    await expectCleanInventory();
  });

  it("여러 명 예약이 섞여도 정원을 넘지 않는다(현장 결제 — 바로 확정·수수료 스냅샷·프로모션 차감)", async () => {
    const l = await listing([{ capacity: 7 }], { product: { paymentPolicy: "ONSITE" } });
    await prisma.business.update({ where: { id: l.business.id }, data: { launchPromoUntil: new Date(Date.now() + 30 * DAY), launchPromoRemaining: 2 } });
    const users = await customers(12);

    const { ok, errors } = await settle(users.map((user, i) => book(user, l.seat.id, { quantity: (i % 3) + 1 })));

    const seat = await loadSeat(l.seat.id);
    const bookings = await prisma.booking.findMany({ where: { slotId: l.slot.id } });
    expect(seat.reserved).toBeLessThanOrEqual(7);
    expect(bookings.reduce((sum, b) => sum + b.quantity, 0)).toBe(seat.reserved);
    expect(bookings).toHaveLength(ok.length);
    expect(bookings.every((b) => b.status === "CONFIRMED" && b.commissionRule !== null)).toBe(true);
    expect(errors.every((e) => e.code === "SOLD_OUT")).toBe(true);
    expect(ok.length + errors.length).toBe(12);
    // 프로모션은 남은 건수만큼만 적용된다.
    const promos = bookings.filter((b) => b.commissionRule === "PROMO").length;
    expect(promos).toBe(Math.min(2, bookings.length));
    expect((await prisma.business.findUniqueOrThrow({ where: { id: l.business.id } })).launchPromoRemaining).toBe(2 - promos);
    await expectCleanInventory();
  });

  it("같은 멱등 키로 동시에 여러 번 제출해도 예약은 하나다", async () => {
    const l = await listing([{ capacity: 5 }]);
    const user = await customer();
    const key = newToken(12);

    const { ok, errors } = await settle(Array.from({ length: 6 }, () => book(user, l.seat.id, { idempotencyKey: key })));

    expect(errors).toEqual([]);
    expect(new Set(ok.map((r) => r.booking.id)).size).toBe(1);
    expect(ok.every((r) => r.next === "PAY" && r.payment?.orderId === ok[0]?.payment?.orderId)).toBe(true);
    expect(await prisma.booking.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.consentRecord.count()).toBe(2);
    expect((await loadSeat(l.seat.id)).reserved).toBe(1);
    await expectCleanInventory();
  });

  it("같은 회원이 서로 다른 키로 동시에 예약하면 하나만 성공하고 나머지는 CONFLICT, 좌석은 새지 않는다", async () => {
    const l = await listing([{ label: "A", capacity: 5 }, { label: "B", capacity: 5 }]);
    const user = await customer();
    const seatIds = l.slot.seats.map((seat) => seat.id);

    const { ok, errors } = await settle(Array.from({ length: 4 }, (_, i) => book(user, seatIds[i % 2]!)));

    expect(ok).toHaveLength(1);
    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e.code === "CONFLICT" && e.message === "이미 이 회차를 예약하셨어요.")).toBe(true);
    expect(await prisma.booking.count()).toBe(1);
    const seats = await prisma.slotSeat.findMany({ where: { slotId: l.slot.id } });
    expect(seats.reduce((sum, seat) => sum + seat.reserved, 0)).toBe(1);
    await expectCleanInventory();
  });

  it("정원을 줄이는 요청과 예약이 겹쳐도 reserved 가 capacity 를 넘지 않는다", async () => {
    const l = await listing([{ capacity: 10 }]);
    const users = await customers(10);

    const [bookings, shrink] = await Promise.all([
      settle(users.map((user) => book(user, l.seat.id))),
      settle([updateSeat(l.owner.id, l.seat.id, { capacity: 4 })]),
    ]);

    const seat = await loadSeat(l.seat.id);
    expect(seat.reserved).toBeLessThanOrEqual(seat.capacity);
    expect(seat.reserved).toBe(bookings.ok.length);
    if (shrink.ok.length === 1) {
      expect(seat.capacity).toBe(4);
      expect(bookings.ok.length).toBeLessThanOrEqual(4);
      expect(bookings.errors.every((e) => e.code === "SOLD_OUT")).toBe(true);
    } else {
      // 이미 4명 넘게 예약한 뒤라 줄일 수 없었던 경우
      expect(shrink.errors[0]?.code).toBe("VALIDATION");
      expect(seat.capacity).toBe(10);
      expect(bookings.ok).toHaveLength(10);
    }
    await expectCleanInventory();
  });

  it("회차 취소와 예약이 겹쳐도 취소된 회차에 진행 중 예약이 남지 않는다", async () => {
    const l = await listing([{ capacity: 10 }], { product: { paymentPolicy: "ONSITE" } });
    const users = await customers(8);

    const [bookings, cancelled] = await Promise.all([
      settle(users.map((user) => book(user, l.seat.id))),
      cancelSlot({ type: "SELLER", userId: l.owner.id }, l.slot.id, "사정이 생겼어요"),
    ]);

    expect(cancelled.cancelled).toBe(true);
    expect(await prisma.booking.count({ where: { slotId: l.slot.id, status: { in: ["PENDING_PAYMENT", "PENDING_APPROVAL", "CONFIRMED"] } } })).toBe(0);
    expect(await prisma.booking.count({ where: { slotId: l.slot.id, status: "CANCELLED" } })).toBe(bookings.ok.length);
    expect(bookings.errors.every((e) => e.code === "CLOSED")).toBe(true);
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    await expectCleanInventory();
  });
});

// ───────────────────────── 결제·취소·만료 ─────────────────────────

describe("결제와 다른 전이의 경쟁", () => {
  it("결제 승인과 고객 취소가 겹쳐도 최종 상태가 일관된다(확정이면 결제 완료, 아니면 청구 없음·좌석 반환)", async () => {
    for (let round = 0; round < 8; round += 1) {
      const l = await listing([{ capacity: 1 }]);
      const user = await customer();
      const created = await book(user, l.seat.id);

      const { ok, errors } = await settle<unknown>([pay(user, created), cancelBookingByCustomer({ userId: user.id, bookingId: created.booking.id })]);
      expect(ok.length + errors.length).toBe(2);

      const booking = await loadBooking(created.booking.id);
      const payment = await paymentOf(booking.id);
      const seat = await loadSeat(l.seat.id);
      expect(seat.reserved).toBeGreaterThanOrEqual(0);
      if (booking.status === "CONFIRMED") {
        expect(payment.status).toBe("PAID");
        expect(booking.paymentState).toBe("PAID");
        expect(seat.reserved).toBe(1);
      } else if (booking.status === "CANCELLED") {
        // 확정된 뒤 취소가 처리된 경우: 예약 직후라 전액 환불된다.
        expect(payment.status).toBe("CANCELLED");
        expect(booking).toMatchObject({ refundAmount: PRICE, paymentState: "REFUNDED" });
        expect(seat.reserved).toBe(0);
      } else {
        expect(booking.status).toBe("EXPIRED");
        // 청구되지 않았거나, 청구됐다면 전부 환불됐다.
        expect(payment.amount - payment.cancelledAmount === PRICE ? payment.status : "CANCELLED").not.toBe("PAID");
        expect(payment.status === "PAID" || payment.status === "PARTIAL_CANCELLED").toBe(false);
        expect(seat.reserved).toBe(0);
      }
      const refunds = await refundsOf(booking.id);
      expect(refunds.reduce((sum, r) => sum + r.amount, 0)).toBeLessThanOrEqual(PRICE);
    }
    await expectCleanInventory();
  });

  it("같은 결제를 동시에 두 번 확인해도 승인·확정·뒤처리는 한 번이다", async () => {
    const l = await listing([{ capacity: 2 }]);
    const user = await customer();
    const created = await book(user, l.seat.id);
    const key = newMockPaymentKey();
    const confirmSpy = vi.spyOn(mockPaymentProvider, "confirm");

    const { ok, errors } = await settle([pay(user, created, key), pay(user, created, key), pay(user, created, key)]);

    expect(errors).toEqual([]);
    expect(ok.every((r) => r.status === "CONFIRMED")).toBe(true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(await loadBooking(created.booking.id)).toMatchObject({ status: "CONFIRMED", paymentState: "PAID" });
    expect((await prisma.businessCustomer.findFirstOrThrow({ where: { businessId: l.business.id } })).bookingCount).toBe(1);
    expect(await prisma.notification.count({ where: { userId: user.id, type: "BOOKING_CONFIRMED" } })).toBe(1);
    expect(await refundsOf(created.booking.id)).toHaveLength(0);
    expect((await loadSeat(l.seat.id)).reserved).toBe(1);
  });

  it("홀드 만료 작업 여러 개와 결제 승인이 겹쳐도 만료와 확정이 함께 일어나지 않는다", async () => {
    for (let round = 0; round < 8; round += 1) {
      const l = await listing([{ capacity: 1 }]);
      const user = await customer();
      const created = await book(user, l.seat.id);
      // 홀드가 막 지난 상태
      await prisma.booking.update({ where: { id: created.booking.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });

      const [, , , paid] = await Promise.all([expireHolds(), expireHolds(), expireHolds(), settle([pay(user, created)])]);

      const booking = await loadBooking(created.booking.id);
      const payment = await paymentOf(booking.id);
      const seat = await loadSeat(l.seat.id);
      if (paid.ok.length === 1) {
        expect(booking).toMatchObject({ status: "CONFIRMED", paymentState: "PAID" });
        expect(payment.status).toBe("PAID");
        expect(seat.reserved).toBe(1);
      } else {
        expect(booking.status).toBe("EXPIRED");
        expect(payment.status === "PAID" || payment.status === "PARTIAL_CANCELLED").toBe(false);
        expect(seat.reserved).toBe(0);
      }
    }
    await expectCleanInventory();
  });

  it("홀드 만료 작업을 동시에 여러 번 돌려도 예약마다 한 번만 만료된다", async () => {
    const l = await listing([{ capacity: 6 }]);
    const users = await customers(6);
    for (const user of users) await book(user, l.seat.id);
    await prisma.booking.updateMany({ data: { holdExpiresAt: new Date(Date.now() - 1000) } });

    const counts = await Promise.all([expireHolds(), expireHolds(), expireHolds(), expireHolds()]);

    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(6);
    expect(await prisma.booking.count({ where: { status: "EXPIRED" } })).toBe(6);
    expect(await prisma.payment.count({ where: { status: "CANCELLED" } })).toBe(6);
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    for (const user of users) expect(await prisma.notification.count({ where: { userId: user.id, type: "BOOKING_EXPIRED" } })).toBe(1);
    await expectCleanInventory();
  });

  it("고객 취소·사업자 취소가 겹쳐도 취소와 환불은 한 번이다", async () => {
    const l = await listing([{ capacity: 2 }], { startsInHours: 100 });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);

    const { ok, errors } = await settle<unknown>([
      cancelBookingByCustomer({ userId: user.id, bookingId: booking.id }),
      cancelBookingByCustomer({ userId: user.id, bookingId: booking.id }),
      cancelBookingBySeller(l.owner.id, booking.id, "사정이 생겼어요"),
    ]);

    expect(ok).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.code === "CONFLICT")).toBe(true);
    const after = await loadBooking(booking.id);
    expect(after).toMatchObject({ status: "CANCELLED", refundAmount: PRICE, paymentState: "REFUNDED" });
    expect(await refundsOf(booking.id)).toMatchObject([{ amount: PRICE, status: "DONE" }]);
    const seat = await loadSeat(l.seat.id);
    expect(seat.reserved - seat.withheld).toBe(0);
    await expectCleanInventory();
  });

  it("승인과 거절이 겹치면 하나만 적용된다", async () => {
    const l = await listing([{ capacity: 2 }], { product: { requiresApproval: true } });
    const user = await customer();
    const created = await book(user, l.seat.id);
    await pay(user, created);

    const { ok, errors } = await settle<unknown>([approveBooking(l.owner.id, created.booking.id), rejectBooking(l.owner.id, created.booking.id, "사정")]);

    expect(ok).toHaveLength(1);
    expect(errors).toHaveLength(1);
    const booking = await loadBooking(created.booking.id);
    const refunds = await refundsOf(booking.id);
    if (booking.status === "CONFIRMED") {
      expect(refunds).toHaveLength(0);
      expect(booking.commissionRule).not.toBeNull();
      expect((await loadSeat(l.seat.id)).reserved).toBe(1);
    } else {
      expect(booking.status).toBe("REJECTED");
      expect(refunds).toMatchObject([{ amount: PRICE, status: "DONE" }]);
      expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    }
    await expectCleanInventory();
  });

  it("결제를 그만두는 요청이 겹쳐도 좌석은 한 번만 반환된다", async () => {
    const l = await listing([{ capacity: 3 }]);
    const other = await customer();
    await book(other, l.seat.id);
    const user = await customer();
    const created = await book(user, l.seat.id);

    const results = await Promise.all(Array.from({ length: 4 }, () => abandonBooking({ userId: user.id, bookingId: created.booking.id })));

    expect(results.filter((r) => r.released)).toHaveLength(1);
    expect((await loadBooking(created.booking.id)).status).toBe("EXPIRED");
    expect((await loadSeat(l.seat.id)).reserved).toBe(1);
    await expectCleanInventory();
  });
});

// ───────────────────────── 체크인·노쇼 ─────────────────────────

describe("체크인·노쇼의 경쟁", () => {
  it("같은 예약을 동시에 두 번 체크인하면 한 번만 완료된다", async () => {
    const l = await listing([{ capacity: 2 }], { startsInHours: 1, deadlineMinBefore: 10 });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);
    const attempt = (codeOrToken: string) => checkInBooking(l.owner.id, { businessId: l.business.id, codeOrToken });

    const { ok, errors } = await settle([attempt(booking.code), attempt(booking.checkinToken), attempt(booking.code.toLowerCase())]);

    expect(ok).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.code === "CONFLICT")).toBe(true);
    expect((await loadBooking(booking.id)).status).toBe("COMPLETED");
    expect(await prisma.businessCustomer.findFirstOrThrow({ where: { businessId: l.business.id } })).toMatchObject({ completedCount: 1, totalSpent: PRICE });
  });

  it("체크인과 노쇼 처리가 겹치면 하나만 적용되고 노쇼 횟수도 그에 맞는다", async () => {
    const l = await listing([{ capacity: 2 }], { startsInHours: 1, deadlineMinBefore: 10 });
    const user = await customer();
    const booking = await bookAndPay(user, l.seat.id);
    await prisma.slot.update({ where: { id: l.slot.id }, data: { startAt: new Date(Date.now() - MINUTE), bookingDeadlineAt: new Date(Date.now() - 2 * MINUTE) } });

    const { ok, errors } = await settle<unknown>([
      checkInBooking(l.owner.id, { businessId: l.business.id, codeOrToken: booking.code }),
      markNoShow(l.owner.id, booking.id),
      markNoShow(l.owner.id, booking.id),
    ]);

    expect(ok).toHaveLength(1);
    expect(errors).toHaveLength(2);
    const after = await loadBooking(booking.id);
    const noShows = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).noShowCount;
    expect(["COMPLETED", "NO_SHOW"]).toContain(after.status);
    expect(noShows).toBe(after.status === "NO_SHOW" ? 1 : 0);
    expect(await prisma.notification.count({ where: { userId: user.id, type: "NO_SHOW_NOTICE" } })).toBe(noShows);
  });
});

// ───────────────────────── 재판매 환불 ─────────────────────────

describe("재판매 연동 환불의 경쟁", () => {
  const RESALE = 80;
  const EXTRA = Math.floor((PRICE * RESALE) / 100);

  /** 환불 불가 구간에서 취소돼 재판매를 기다리는 예약 count 건과, 빈자리를 모두 잡은 결제 대기 예약 holders 건 */
  async function setup(capacity: number, pendingCount: number, holderCount: number) {
    const l = await listing([{ capacity }], { startsInHours: 12, product: { resaleRefundRate: RESALE } });
    const cancelled: string[] = [];
    for (const user of await customers(pendingCount)) {
      const booking = await bookAndPay(user, l.seat.id);
      await pastGrace(booking.id);
      const result = await cancelBookingByCustomer({ userId: user.id, bookingId: booking.id });
      expect(result).toMatchObject({ refundRate: 0, refundAmount: 0, resaleRefundRate: RESALE });
      cancelled.push(booking.id);
    }
    const holders: { user: TestUser; created: CreateBookingResult }[] = [];
    for (const user of await customers(holderCount)) holders.push({ user, created: await book(user, l.seat.id) });
    return { l, cancelled, holders };
  }

  it("새 예약 여러 건이 동시에 확정돼도 취소 건마다 한 번씩만, 규칙이 허용하는 만큼만 환불한다", async () => {
    const { l, cancelled, holders } = await setup(3, 3, 3);

    await Promise.all(holders.map(({ user, created }) => pay(user, created)));
    // 같은 예약에 대해 정산을 다시(동시에) 불러도 더 주지 않는다.
    const again = await Promise.all(holders.flatMap(({ created }) => [settleResaleFor(created.booking.id), settleResaleFor(created.booking.id)]));

    expect(again.flat()).toEqual([]);
    for (const id of cancelled) {
      expect(await loadBooking(id)).toMatchObject({ resalePendingQty: 0, refundAmount: EXTRA, paymentState: "PARTIALLY_REFUNDED" });
      expect(await refundsOf(id)).toMatchObject([{ amount: EXTRA, reason: "RESALE", status: "DONE" }]);
    }
    expect(await prisma.refund.count()).toBe(3);
    expect((await loadSeat(l.seat.id)).reserved).toBe(3);
    await expectCleanInventory();
  });

  it("다시 팔린 좌석보다 새 예약이 많으면 기다리던 취소 건 수만큼만 환불한다", async () => {
    const { cancelled, holders } = await setup(6, 2, 6);

    await Promise.all(holders.map(({ user, created }) => pay(user, created)));

    const refunded = await prisma.booking.findMany({ where: { id: { in: cancelled } } });
    expect(refunded.every((b) => b.resalePendingQty === 0 && b.refundAmount === EXTRA)).toBe(true);
    const refunds = await prisma.refund.findMany();
    expect(refunds).toHaveLength(2);
    expect(refunds.reduce((sum, r) => sum + r.amount, 0)).toBe(EXTRA * 2);
    await expectCleanInventory();
  });

  it("빈자리가 남아 있는 동안에는 동시에 확정돼도 환불하지 않는다", async () => {
    // 정원 5, 취소 대기 2, 새 예약 3 → 확정 뒤에도 빈자리 2 = 대기 2 이므로 다시 팔린 좌석은 없다.
    const { l, cancelled, holders } = await setup(5, 2, 3);

    await Promise.all(holders.map(({ user, created }) => pay(user, created)));

    expect((await loadSeat(l.seat.id)).reserved).toBe(3);
    const pending = await prisma.booking.findMany({ where: { id: { in: cancelled } } });
    expect(pending.every((b) => b.resalePendingQty === 1 && b.refundAmount === 0)).toBe(true);
    expect(await prisma.refund.count()).toBe(0);

    // 남은 2자리가 동시에 팔리면 그때 2건 모두 환불된다.
    const last = await customers(2);
    const holds = await Promise.all(last.map((user) => book(user, l.seat.id)));
    await Promise.all(last.map((user, i) => pay(user, holds[i]!)));
    const done = await prisma.booking.findMany({ where: { id: { in: cancelled } } });
    expect(done.every((b) => b.resalePendingQty === 0 && b.refundAmount === EXTRA)).toBe(true);
    expect(await prisma.refund.count()).toBe(2);
    await expectCleanInventory();
  });
});

// ───────────────────────── 개최 판정 ─────────────────────────

describe("개최 판정 작업의 경쟁", () => {
  /** 최소 2명이 필요한 회차(판정 시각은 시작 24시간 전) */
  async function gathering(confirmedCount: number) {
    const l = await listing([{ capacity: 4 }], { startsInHours: 72 });
    await prisma.slotSeat.update({ where: { id: l.seat.id }, data: { minCount: 2 } });
    await prisma.slot.update({ where: { id: l.slot.id }, data: { decideAt: new Date(l.slot.startAt.getTime() - DAY) } });
    const users = await customers(confirmedCount);
    const bookings = [];
    for (const user of users) bookings.push(await bookAndPay(user, l.seat.id));
    return { l, users, bookings };
  }
  const afterDecide = () => new Date(Date.now() + 2 * DAY + HOUR);

  it("최소 인원 미달 회차는 동시에 여러 번 판정해도 한 번만 취소되고 환불도 한 번이다", async () => {
    const { l, users, bookings } = await gathering(1);
    const hold = await book(await customer(), l.seat.id);
    const now = afterDecide();

    const results = await Promise.all([decideDueSlots(now), decideDueSlots(now), decideDueSlots(now), decideDueSlots(now)]);

    expect(results.reduce((sum, r) => sum + r.cancelled, 0)).toBe(1);
    expect(results.reduce((sum, r) => sum + r.confirmed, 0)).toBe(0);
    expect(await prisma.slot.findUniqueOrThrow({ where: { id: l.slot.id } })).toMatchObject({ status: "CANCELLED", goConfirmedAt: null });
    expect(await loadBooking(bookings[0]!.id)).toMatchObject({ status: "CANCELLED", cancelledBy: "SYSTEM", refundAmount: PRICE, paymentState: "REFUNDED" });
    expect(await refundsOf(bookings[0]!.id)).toMatchObject([{ amount: PRICE, status: "DONE" }]);
    expect((await loadBooking(hold.booking.id)).status).toBe("CANCELLED");
    expect(await prisma.notification.count({ where: { userId: users[0]!.id, type: "SLOT_CANCELLED" } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: l.owner.id, type: "SLOT_CANCELLED" } })).toBe(1);
    expect((await loadSeat(l.seat.id)).reserved).toBe(0);
    await expectCleanInventory();
  });

  it("최소 인원을 채운 회차는 동시에 여러 번 판정해도 한 번만 확정되고 알림도 한 번이다", async () => {
    const { l, users, bookings } = await gathering(2);
    // 확정 기록이 누락된 상황을 만든다.
    await prisma.slot.update({ where: { id: l.slot.id }, data: { goConfirmedAt: null } });
    await prisma.notification.deleteMany({ where: { type: "SLOT_GO_CONFIRMED" } });
    const now = afterDecide();

    const results = await Promise.all([decideDueSlots(now), decideDueSlots(now), decideDueSlots(now), decideDueSlots(now)]);

    expect(results.reduce((sum, r) => sum + r.confirmed, 0)).toBe(1);
    expect(results.reduce((sum, r) => sum + r.cancelled, 0)).toBe(0);
    const slot = await prisma.slot.findUniqueOrThrow({ where: { id: l.slot.id } });
    expect(slot.status).toBe("OPEN");
    expect(slot.goConfirmedAt).toEqual(now);
    for (const booking of bookings) expect((await loadBooking(booking.id)).status).toBe("CONFIRMED");
    for (const user of users) expect(await prisma.notification.count({ where: { userId: user.id, type: "SLOT_GO_CONFIRMED" } })).toBe(1);
    expect(await prisma.refund.count()).toBe(0);
  });

  it("판정(취소)과 마지막 예약 확정이 겹쳐도 회차는 취소되거나 확정되거나 둘 중 하나로만 끝난다", async () => {
    for (let round = 0; round < 5; round += 1) {
      const { l, bookings } = await gathering(1);
      // 판정 시각이 이미 지난 상태에서 마지막 한 명이 결제를 마친다.
      await prisma.slot.update({ where: { id: l.slot.id }, data: { decideAt: new Date(Date.now() - MINUTE) } });
      const user = await customer();
      const created = await book(user, l.seat.id);

      await Promise.all([settle([pay(user, created)]), decideDueSlots(), decideDueSlots()]);
      // 처리 도중 끊긴 건이 있으면 다음 실행이 마저 정리한다.
      await decideDueSlots();

      const slot = await prisma.slot.findUniqueOrThrow({ where: { id: l.slot.id } });
      const first = await loadBooking(bookings[0]!.id);
      const second = await loadBooking(created.booking.id);
      if (slot.status === "CANCELLED") {
        expect(slot.goConfirmedAt).toBeNull();
        expect(first).toMatchObject({ status: "CANCELLED", refundAmount: PRICE });
        expect(["CANCELLED", "EXPIRED"]).toContain(second.status);
        // 두 번째 고객이 결제했다면 전부 환불됐다.
        const payment = await paymentOf(second.id);
        expect(payment.status === "PAID" || payment.status === "PARTIAL_CANCELLED").toBe(false);
        expect((await loadSeat(l.seat.id)).reserved).toBe(0);
      } else {
        expect(slot.goConfirmedAt).not.toBeNull();
        expect(first.status).toBe("CONFIRMED");
        expect(second.status).toBe("CONFIRMED");
        expect((await loadSeat(l.seat.id)).reserved).toBe(2);
      }
    }
    await expectCleanInventory();
  });
});
