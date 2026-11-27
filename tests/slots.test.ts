import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { newToken } from "@/lib/ids";
import { DAY, HOUR, MINUTE } from "@/lib/time";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import { createBooking, createManualBooking } from "@/server/services/booking";
import { verifyInventoryIntegrity } from "@/server/services/inventory";
import {
  addSeatType,
  closeSlot,
  createSlots,
  duplicateSlot,
  getSlotForSeller,
  getSlotGoState,
  getSlotPublicLink,
  listSlotsForSeller,
  quickPostVacancy,
  relistSeats,
  removeSeatType,
  reopenSlot,
  updateSeat,
  updateSlot,
  type CreateSlotsInput,
  type QuickPostInput,
} from "@/server/services/slots";
import { setWaitlistProcessor } from "@/server/services/vacancy";
import { createBusiness, createListing, createProduct, createUser, resetDb, type SeatSpec } from "./helpers";

// ── 공통 도우미 ───────────────────────────────────────

type ListingOptions = Parameters<typeof createListing>[1];

const PRICE = 30_000;
let phoneSeq = 0;
const nextPhone = () => `0109${String(++phoneSeq).padStart(7, "0")}`;

const customer = (overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) =>
  createUser({ gender: "MALE", birthYear: 1995, phone: nextPhone(), ...overrides });

const listing = (seats: SeatSpec[] = [{ capacity: 4 }], options: ListingOptions = {}) => createListing(seats, options);

/** 승인된 사업장 + 판매 중인 상품(좌석 구성: 남성 4석 35,000원 / 여성 4석 30,000원, 정가 40,000원) */
async function shop(productOverrides: Partial<Prisma.ProductUncheckedCreateInput> = {}) {
  const { business, owner } = await createBusiness();
  const product = await createProduct(business.id, business.categoryId, {
    basePrice: 40_000,
    durationMin: 90,
    seatTemplates: [
      { label: "남성", gender: "MALE", capacity: 4, price: 35_000 },
      { label: "여성", gender: "FEMALE", capacity: 4, price: 30_000 },
    ],
    ...productOverrides,
  });
  return { business, owner, product };
}

const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);

async function member(businessId: string, role: "MANAGER" | "STAFF") {
  const user = await createUser();
  await prisma.businessMember.create({ data: { businessId, userId: user.id, role } });
  return user;
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

const loadSeat = (id: string) => prisma.slotSeat.findUniqueOrThrow({ where: { id } });
const loadSlot = (id: string) => prisma.slot.findUniqueOrThrow({ where: { id }, include: { seats: { orderBy: { sort: "asc" } } } });

function travel(ms: number): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

/** 현장 결제 상품의 좌석을 바로 확정 예약한다. */
async function bookOnsite(slotSeatId: string, quantity = 1, overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  const user = await customer(overrides);
  const created = await createBooking({
    userId: user.id,
    slotSeatId,
    quantity,
    guestName: user.name,
    guestPhone: user.phone!,
    idempotencyKey: newToken(12),
    agreePolicy: true,
    agreeThirdParty: true,
  });
  return { user, booking: created.booking };
}

/** 좌석 반환 뒤처리가 어떤 좌석에 대해 불렸는지 기록한다(대기 처리기 대역). */
function watchReleases() {
  const calls: string[] = [];
  setWaitlistProcessor(async (slotSeatId) => {
    calls.push(slotSeatId);
    const seat = await loadSeat(slotSeatId);
    return { offered: 0, broadcast: 0, remainingPublic: Math.max(0, seat.capacity - seat.reserved) };
  });
  return calls;
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

// ───────────────────────── 회차 만들기 ─────────────────────────

describe("createSlots", () => {
  it("상품의 기본 좌석 구성과 사업장 기본 예약 마감으로 여러 회차를 한 번에 만든다", async () => {
    const { business, owner, product } = await shop();
    const starts = [inHours(48), inHours(72), inHours(96)];

    const slots = await createSlots(owner.id, business.id, { productId: product.id, starts });

    expect(slots).toHaveLength(3);
    for (const [i, slot] of slots.entries()) {
      expect(slot).toMatchObject({ productId: product.id, businessId: business.id, status: "OPEN", origin: "REGULAR", note: null, decideAt: null, goConfirmedAt: null });
      expect(slot.startAt).toEqual(starts[i]);
      expect(slot.endAt.getTime()).toBe(starts[i]!.getTime() + product.durationMin * MINUTE);
      expect(slot.bookingDeadlineAt.getTime()).toBe(starts[i]!.getTime() - business.defaultDeadlineMin * MINUTE);
      expect(slot.seats.map((s) => ({ label: s.label, gender: s.gender, capacity: s.capacity, price: s.price, reserved: s.reserved, withheld: s.withheld, minCount: s.minCount }))).toEqual([
        { label: "남성", gender: "MALE", capacity: 4, price: 35_000, reserved: 0, withheld: 0, minCount: 0 },
        { label: "여성", gender: "FEMALE", capacity: 4, price: 30_000, reserved: 0, withheld: 0, minCount: 0 },
      ]);
    }
    expect(await prisma.slot.count()).toBe(3);
  });

  it("좌석·진행 시간·마감·공석 종류·메모를 직접 정할 수 있다", async () => {
    const { business, owner, product } = await shop();
    const start = inHours(48);

    const [slot] = await createSlots(owner.id, business.id, {
      productId: product.id,
      starts: [start],
      durationMin: 120,
      deadlineMinBefore: 0,
      origin: "UNSOLD",
      note: "  와인 한 잔 포함  ",
      seats: [{ label: "일반", capacity: 6, price: 20_000, originalPrice: 40_000 }],
    });

    expect(slot).toMatchObject({ origin: "UNSOLD", note: "와인 한 잔 포함" });
    expect(slot!.endAt.getTime()).toBe(start.getTime() + 120 * MINUTE);
    expect(slot!.bookingDeadlineAt).toEqual(start);
    expect(slot!.seats).toMatchObject([{ label: "일반", gender: "ANY", capacity: 6, price: 20_000, originalPrice: 40_000, minCount: 0 }]);
  });

  it("승인된 사업장의 새 회차는 팔로워에게 알리고, 심사 중인 사업장은 알리지 않는다", async () => {
    const approved = await shop();
    const pending = await shop();
    await prisma.business.update({ where: { id: pending.business.id }, data: { status: "PENDING" } });
    const fan = await customer();
    await prisma.follow.createMany({
      data: [
        { userId: fan.id, businessId: approved.business.id },
        { userId: fan.id, businessId: pending.business.id },
      ],
    });

    const [slot] = await createSlots(approved.owner.id, approved.business.id, { productId: approved.product.id, starts: [inHours(48)] });
    await createSlots(pending.owner.id, pending.business.id, { productId: pending.product.id, starts: [inHours(48)] });

    const alerts = await prisma.notification.findMany({ where: { userId: fan.id, type: "VACANCY_ALERT" } });
    expect(alerts).toHaveLength(1);
    expect((alerts[0]?.data as { slotId?: string } | null)?.slotId).toBe(slot!.id);
  });

  it("매니저 이상만 만들 수 있고, 다른 사업장의 상품·판매 중이 아닌 상품에는 만들 수 없다", async () => {
    const { business, owner, product } = await shop();
    const other = await shop();
    const staff = await member(business.id, "STAFF");
    const manager = await member(business.id, "MANAGER");
    const draft = await createProduct(business.id, business.categoryId, { status: "DRAFT" });
    const base = { productId: product.id, starts: [inHours(48)] };

    expect((await appError(createSlots(staff.id, business.id, base))).code).toBe("FORBIDDEN");
    expect((await appError(createSlots(other.owner.id, business.id, base))).code).toBe("FORBIDDEN");
    expect((await appError(createSlots((await customer()).id, business.id, base))).code).toBe("FORBIDDEN");
    expect((await appError(createSlots(owner.id, business.id, { ...base, productId: other.product.id }))).code).toBe("NOT_FOUND");
    expect((await appError(createSlots(owner.id, business.id, { ...base, productId: draft.id }))).code).toBe("VALIDATION");
    expect(await prisma.slot.count()).toBe(0);

    expect(await createSlots(manager.id, business.id, base)).toHaveLength(1);
  });

  it("시작 시각 검증: 1~60개, 모두 미래, 중복 없음, 같은 시각의 기존 회차와 겹치지 않음", async () => {
    const { business, owner, product } = await shop();
    const start = inHours(48);
    const attempt = (input: Partial<CreateSlotsInput>) => appError(createSlots(owner.id, business.id, { productId: product.id, starts: [start], ...input }));

    expect((await attempt({ starts: [] })).code).toBe("VALIDATION");
    expect((await attempt({ starts: Array.from({ length: 61 }, (_, i) => inHours(48 + i)) })).code).toBe("VALIDATION");
    expect((await attempt({ starts: [new Date(Date.now() - MINUTE)] })).code).toBe("VALIDATION");
    expect((await attempt({ starts: [start, new Date(start.getTime())] })).code).toBe("VALIDATION");
    expect((await attempt({ starts: [new Date("invalid")] })).code).toBe("VALIDATION");
    expect(await prisma.slot.count()).toBe(0);

    const [first] = await createSlots(owner.id, business.id, { productId: product.id, starts: [start] });
    const clash = await attempt({ starts: [inHours(72), start] });
    expect(clash.code).toBe("VALIDATION");
    expect(clash.message).toContain("이미 회차가 있어요");
    // 겹치는 것이 하나라도 있으면 아무것도 만들지 않는다.
    expect(await prisma.slot.count()).toBe(1);

    // 취소된 회차와는 겹쳐도 된다. 다른 상품의 같은 시각도 된다.
    await prisma.slot.update({ where: { id: first!.id }, data: { status: "CANCELLED" } });
    expect(await createSlots(owner.id, business.id, { productId: product.id, starts: [start] })).toHaveLength(1);
    const second = await createProduct(business.id, business.categoryId);
    expect(await createSlots(owner.id, business.id, { productId: second.id, starts: [start] })).toHaveLength(1);
  });

  it("60개까지는 한 번에 만든다", async () => {
    const { business, owner, product } = await shop();
    const slots = await createSlots(owner.id, business.id, { productId: product.id, starts: Array.from({ length: 60 }, (_, i) => inHours(48 + i * 3)) });
    expect(slots).toHaveLength(60);
    expect(await prisma.slotSeat.count()).toBe(120);
  });

  it("예약 마감·진행 시간·메모·좌석 입력 범위", async () => {
    const { business, owner, product } = await shop();
    const attempt = async (input: Partial<CreateSlotsInput>) =>
      (await appError(createSlots(owner.id, business.id, { productId: product.id, starts: [inHours(48)], ...input }))).code;
    const seat = { label: "일반", capacity: 4, price: PRICE };

    expect(await attempt({ deadlineMinBefore: -1 })).toBe("VALIDATION");
    expect(await attempt({ deadlineMinBefore: 1441 })).toBe("VALIDATION");
    expect(await attempt({ durationMin: 5 })).toBe("VALIDATION");
    expect(await attempt({ durationMin: 1441 })).toBe("VALIDATION");
    expect(await attempt({ note: "가".repeat(81) })).toBe("VALIDATION");
    expect(await attempt({ note: "첫째 줄\n둘째 줄" })).toBe("VALIDATION");
    expect(await attempt({ seats: [] })).toBe("VALIDATION");
    expect(await attempt({ seats: Array.from({ length: 7 }, (_, i) => ({ ...seat, label: `좌석${i}` })) })).toBe("VALIDATION");
    expect(await attempt({ seats: [seat, { ...seat }] })).toBe("VALIDATION");
    expect(await attempt({ seats: [{ ...seat, capacity: 0 }] })).toBe("VALIDATION");
    expect(await attempt({ seats: [{ ...seat, capacity: 501 }] })).toBe("VALIDATION");
    expect(await attempt({ seats: [{ ...seat, price: -1 }] })).toBe("VALIDATION");
    expect(await attempt({ seats: [{ ...seat, label: "가".repeat(13) }] })).toBe("VALIDATION");
    expect(await attempt({ origin: "FLASH" as never })).toBe("VALIDATION");
    // 예약 마감이 이미 지난 시각이 되는 회차는 만들지 않는다.
    expect(await attempt({ starts: [inHours(1)], deadlineMinBefore: 120 })).toBe("VALIDATION");
    expect(await prisma.slot.count()).toBe(0);
  });

  it("메모와 좌석 이름에 금칙어를 쓸 수 없다", async () => {
    const { business, owner, product } = await shop();
    const base = { productId: product.id, starts: [inHours(48)] };

    const note = await appError(createSlots(owner.id, business.id, { ...base, note: "오늘만 땡처리 합니다" }));
    expect(note.code).toBe("VALIDATION");
    expect(note.message).toContain("땡처리");
    expect((await appError(createSlots(owner.id, business.id, { ...base, note: "100% 매칭 보장" }))).code).toBe("VALIDATION");
    expect((await appError(createSlots(owner.id, business.id, { ...base, seats: [{ label: "떨이석", capacity: 2, price: PRICE }] }))).code).toBe("VALIDATION");
    expect(await prisma.slot.count()).toBe(0);
    expect(await createSlots(owner.id, business.id, { ...base, note: "취소로 생긴 자리예요" })).toHaveLength(1);
  });
});

describe("기준가(originalPrice) 규칙", () => {
  const MSG = "기준가는 이 상품의 정가를 넘을 수 없어요.";

  it("기준가는 판매 가격보다 높아야 하고, 같은 이름 좌석의 정가(없으면 상품 정가)를 넘을 수 없다", async () => {
    const { business, owner, product } = await shop();
    const attempt = (seat: { label: string; price: number; originalPrice: number }) =>
      createSlots(owner.id, business.id, { productId: product.id, starts: [inHours(48 + Math.random() * 1000)], seats: [{ capacity: 2, ...seat }] });

    // 좌석 구성에 있는 이름: 그 좌석의 가격(남성 35,000원)이 상한
    expect(await appError(attempt({ label: "남성", price: 25_000, originalPrice: 35_001 }))).toMatchObject({ code: "VALIDATION", message: MSG });
    expect((await attempt({ label: "남성", price: 25_000, originalPrice: 35_000 }))[0]!.seats[0]).toMatchObject({ price: 25_000, originalPrice: 35_000 });
    // 좌석 구성에 없는 이름: 상품 정가(40,000원)가 상한
    expect(await appError(attempt({ label: "커플", price: 30_000, originalPrice: 40_001 }))).toMatchObject({ code: "VALIDATION", message: MSG });
    expect((await attempt({ label: "커플", price: 30_000, originalPrice: 40_000 }))[0]!.seats[0]).toMatchObject({ originalPrice: 40_000 });
    // 판매 가격 이하인 기준가는 할인이 아니다.
    const notDiscount = await appError(attempt({ label: "여성", price: 30_000, originalPrice: 30_000 }));
    expect(notDiscount.code).toBe("VALIDATION");
    expect(notDiscount.message).not.toBe(MSG);
  });

  it("빠른 등록·좌석 수정·좌석 추가에도 같은 규칙이 적용된다", async () => {
    const { business, owner, product } = await shop();
    const quick = (originalPrice: number) =>
      quickPostVacancy(owner.id, business.id, {
        productId: product.id,
        startAt: inHours(3 + Math.random() * 100),
        origin: "CANCELLATION",
        seats: [{ label: "여성", capacity: 1, price: 20_000, originalPrice }],
      });
    expect(await appError(quick(30_001))).toMatchObject({ code: "VALIDATION", message: MSG });
    const slot = await quick(30_000);
    const seat = slot.seats[0]!;

    expect(await appError(updateSeat(owner.id, seat.id, { originalPrice: 30_001 }))).toMatchObject({ code: "VALIDATION", message: MSG });
    // 가격을 기준가 이상으로 올리면 기준가가 의미 없어지므로 함께 고치게 한다.
    expect((await appError(updateSeat(owner.id, seat.id, { price: 30_000 }))).code).toBe("VALIDATION");
    expect(await updateSeat(owner.id, seat.id, { price: 30_000, originalPrice: null })).toMatchObject({ price: 30_000, originalPrice: null });
    // 이름을 바꾸면 그 이름의 정가가 기준이 된다.
    await updateSeat(owner.id, seat.id, { price: 20_000, originalPrice: 30_000 });
    expect(await updateSeat(owner.id, seat.id, { label: "남성", originalPrice: 35_000 })).toMatchObject({ label: "남성", originalPrice: 35_000 });

    expect(await appError(addSeatType(owner.id, slot.id, { label: "여성", capacity: 2, price: 10_000, originalPrice: 30_001 }))).toMatchObject({ message: MSG });
    expect(await addSeatType(owner.id, slot.id, { label: "여성", capacity: 2, price: 10_000, originalPrice: 30_000 })).toMatchObject({ originalPrice: 30_000 });
  });
});

describe("최소 인원과 개최 판정 시각", () => {
  it("최소 인원이 있으면 판정 시점이 필요하고, decideAt = 시작 − 판정 시점(분)", async () => {
    const { business, owner, product } = await shop();
    const start = inHours(100);
    const seats = [
      { label: "남성", gender: "MALE" as const, capacity: 4, price: 35_000, minCount: 2 },
      { label: "여성", gender: "FEMALE" as const, capacity: 4, price: 30_000, minCount: 2 },
    ];
    const base = { productId: product.id, starts: [start], seats };

    const missing = await appError(createSlots(owner.id, business.id, base));
    expect(missing.code).toBe("VALIDATION");
    expect(missing.fieldErrors).toHaveProperty("decideMinBefore");
    expect((await appError(createSlots(owner.id, business.id, { ...base, decideMinBefore: 59 }))).code).toBe("VALIDATION");
    expect((await appError(createSlots(owner.id, business.id, { ...base, decideMinBefore: 10_081 }))).code).toBe("VALIDATION");
    // 판정 시각이 이미 지난 경우
    expect((await appError(createSlots(owner.id, business.id, { ...base, starts: [inHours(10)], decideMinBefore: 24 * 60 }))).code).toBe("VALIDATION");
    expect((await appError(createSlots(owner.id, business.id, { ...base, decideMinBefore: 1440, seats: [{ ...seats[0]!, minCount: 5 }] }))).code).toBe("VALIDATION");
    expect(await prisma.slot.count()).toBe(0);

    const [slot] = await createSlots(owner.id, business.id, { ...base, decideMinBefore: 1440 });
    expect(slot!.decideAt?.getTime()).toBe(start.getTime() - DAY);
    expect(slot!.seats.map((s) => s.minCount)).toEqual([2, 2]);
    expect(await getSlotGoState(slot!.id)).toMatchObject({
      state: "GATHERING",
      needs: [
        { label: "남성", remaining: 2 },
        { label: "여성", remaining: 2 },
      ],
    });
  });

  it("상품 좌석 구성에 최소 인원이 있으면 그대로 쓰고, 최소 인원이 없으면 판정 시각을 두지 않는다", async () => {
    const withMin = await shop({ seatTemplates: [{ label: "일반", gender: "ANY", capacity: 6, price: PRICE, minCount: 4 }] });
    const [gathering] = await createSlots(withMin.owner.id, withMin.business.id, { productId: withMin.product.id, starts: [inHours(100)], decideMinBefore: 2880 });
    expect(gathering!.seats[0]!.minCount).toBe(4);
    expect(gathering!.decideAt).not.toBeNull();

    const plain = await shop();
    const [slot] = await createSlots(plain.owner.id, plain.business.id, { productId: plain.product.id, starts: [inHours(100)], decideMinBefore: 2880 });
    expect(slot!.decideAt).toBeNull();
    expect(await getSlotGoState(slot!.id)).toEqual({ state: "NONE", needs: [], decideAt: null });
  });

  it("좌석 수정: 개최 확정 뒤에는 최소 인원을 바꿀 수 없고, 낮춰서 조건이 채워지면 바로 확정된다", async () => {
    const { business, owner, product } = await shop({ paymentPolicy: "ONSITE", seatTemplates: [{ label: "일반", gender: "ANY", capacity: 6, price: PRICE, minCount: 3 }] });
    const [slot] = await createSlots(owner.id, business.id, { productId: product.id, starts: [inHours(100)], decideMinBefore: 1440 });
    const seat = slot!.seats[0]!;
    await bookOnsite(seat.id, 2);
    expect((await loadSlot(slot!.id)).goConfirmedAt).toBeNull();
    expect((await appError(updateSeat(owner.id, seat.id, { minCount: 7 }))).code).toBe("VALIDATION");

    expect(await updateSeat(owner.id, seat.id, { minCount: 2 })).toMatchObject({ minCount: 2 });

    expect((await loadSlot(slot!.id)).goConfirmedAt).not.toBeNull();
    expect((await appError(updateSeat(owner.id, seat.id, { minCount: 1 }))).code).toBe("CONFLICT");
    // 최소 인원이 그대로면 다른 값은 계속 고칠 수 있다.
    expect(await updateSeat(owner.id, seat.id, { minCount: 2, price: 25_000 })).toMatchObject({ price: 25_000 });
  });

  it("판정 시각이 없는 회차에는 최소 인원을 새로 정할 수 없다", async () => {
    const l = await listing([{ capacity: 4 }]);
    expect((await appError(updateSeat(l.owner.id, l.seat.id, { minCount: 2 }))).code).toBe("VALIDATION");
    expect((await appError(addSeatType(l.owner.id, l.slot.id, { label: "추가", capacity: 2, price: PRICE, minCount: 1 }))).code).toBe("VALIDATION");
    expect((await loadSeat(l.seat.id)).minCount).toBe(0);
  });
});

// ───────────────────────── 빠른 등록·복제 ─────────────────────────

describe("quickPostVacancy", () => {
  const quickInput = (productId: string, overrides: Partial<QuickPostInput> = {}): QuickPostInput => ({
    productId,
    startAt: inHours(6),
    origin: "CANCELLATION",
    seats: [{ label: "여성", gender: "FEMALE", capacity: 1, price: 30_000 }],
    ...overrides,
  });

  it("스태프도 회차 하나를 바로 올릴 수 있고, 올린 자리는 곧바로 예약할 수 있다", async () => {
    const { business, product } = await shop({ paymentPolicy: "ONSITE" });
    const staff = await member(business.id, "STAFF");

    const slot = await quickPostVacancy(staff.id, business.id, quickInput(product.id, { note: "방금 취소된 자리예요", origin: "NO_SHOW" }));

    expect(slot).toMatchObject({ status: "OPEN", origin: "NO_SHOW", note: "방금 취소된 자리예요", decideAt: null });
    expect(slot.seats).toMatchObject([{ label: "여성", gender: "FEMALE", capacity: 1, reserved: 0, minCount: 0 }]);
    expect(slot.endAt.getTime()).toBe(slot.startAt.getTime() + product.durationMin * MINUTE);
    expect(slot.bookingDeadlineAt.getTime()).toBe(slot.startAt.getTime() - business.defaultDeadlineMin * MINUTE);
    const { booking } = await bookOnsite(slot.seats[0]!.id, 1, { gender: "FEMALE" });
    expect(booking.status).toBe("CONFIRMED");
  });

  it("예약 마감이 과거가 되지 않게 당긴다: 기준 시각이 이미 지났으면 시작 시각까지 예약을 받는다", async () => {
    const { business, owner, product } = await shop({ paymentPolicy: "ONSITE" });
    expect(business.defaultDeadlineMin).toBeGreaterThan(30);

    const slot = await quickPostVacancy(owner.id, business.id, quickInput(product.id, { startAt: new Date(Date.now() + 30 * MINUTE) }));

    expect(slot.bookingDeadlineAt).toEqual(slot.startAt);
    expect(slot.bookingDeadlineAt.getTime()).toBeGreaterThan(Date.now());
    expect((await bookOnsite(slot.seats[0]!.id, 1, { gender: "FEMALE" })).booking.status).toBe("CONFIRMED");

    const explicit = await quickPostVacancy(owner.id, business.id, quickInput(product.id, { startAt: inHours(5), deadlineMinBefore: 30 }));
    expect(explicit.bookingDeadlineAt.getTime()).toBe(explicit.startAt.getTime() - 30 * MINUTE);
  });

  it("시작까지 5분이 안 남았으면 올릴 수 없다", async () => {
    const { business, owner, product } = await shop();

    expect((await appError(quickPostVacancy(owner.id, business.id, quickInput(product.id, { startAt: new Date(Date.now() + 4 * MINUTE) })))).code).toBe("VALIDATION");
    expect((await appError(quickPostVacancy(owner.id, business.id, quickInput(product.id, { startAt: new Date(Date.now() - MINUTE) })))).code).toBe("VALIDATION");
    expect(await prisma.slot.count()).toBe(0);
    expect((await quickPostVacancy(owner.id, business.id, quickInput(product.id, { startAt: new Date(Date.now() + 6 * MINUTE) }))).status).toBe("OPEN");
  });

  it("공석 종류는 취소·노쇼·미판매만, 좌석은 하나 이상, 금칙어 불가, 구성원만", async () => {
    const { business, owner, product } = await shop();
    const other = await shop();

    expect((await appError(quickPostVacancy(owner.id, business.id, quickInput(product.id, { origin: "REGULAR" as never })))).code).toBe("VALIDATION");
    expect((await appError(quickPostVacancy(owner.id, business.id, quickInput(product.id, { seats: [] })))).code).toBe("VALIDATION");
    expect((await appError(quickPostVacancy(owner.id, business.id, quickInput(product.id, { note: "마감세일" })))).code).toBe("VALIDATION");
    expect((await appError(quickPostVacancy(other.owner.id, business.id, quickInput(product.id)))).code).toBe("FORBIDDEN");
    expect((await appError(quickPostVacancy(owner.id, business.id, quickInput(other.product.id)))).code).toBe("NOT_FOUND");
    expect(await prisma.slot.count()).toBe(0);
  });
});

describe("duplicateSlot", () => {
  it("좌석·가격·최소 인원·시간 간격을 그대로 복제하고 재고는 새로 시작한다", async () => {
    const { business, owner, product } = await shop({ paymentPolicy: "ONSITE" });
    const start = inHours(100);
    const [source] = await createSlots(owner.id, business.id, {
      productId: product.id,
      starts: [start],
      durationMin: 150,
      deadlineMinBefore: 45,
      decideMinBefore: 2880,
      origin: "UNSOLD",
      note: "루프탑에서 진행해요",
      seats: [
        { label: "남성", gender: "MALE", capacity: 4, price: 30_000, originalPrice: 35_000, minCount: 2 },
        { label: "여성", gender: "FEMALE", capacity: 3, price: 25_000, minCount: 1 },
      ],
    });
    await bookOnsite(source!.seats[0]!.id, 2);
    const starts = [inHours(200), inHours(300)];

    const copies = await duplicateSlot(owner.id, source!.id, starts);

    expect(copies).toHaveLength(2);
    for (const [i, copy] of copies.entries()) {
      expect(copy.id).not.toBe(source!.id);
      expect(copy).toMatchObject({ status: "OPEN", origin: "REGULAR", note: "루프탑에서 진행해요", goConfirmedAt: null });
      expect(copy.startAt).toEqual(starts[i]);
      expect(copy.endAt.getTime()).toBe(starts[i]!.getTime() + 150 * MINUTE);
      expect(copy.bookingDeadlineAt.getTime()).toBe(starts[i]!.getTime() - 45 * MINUTE);
      expect(copy.decideAt?.getTime()).toBe(starts[i]!.getTime() - 2880 * MINUTE);
      expect(copy.seats.map((s) => ({ label: s.label, gender: s.gender, capacity: s.capacity, price: s.price, originalPrice: s.originalPrice, minCount: s.minCount, reserved: s.reserved, withheld: s.withheld }))).toEqual([
        { label: "남성", gender: "MALE", capacity: 4, price: 30_000, originalPrice: 35_000, minCount: 2, reserved: 0, withheld: 0 },
        { label: "여성", gender: "FEMALE", capacity: 3, price: 25_000, originalPrice: null, minCount: 1, reserved: 0, withheld: 0 },
      ]);
    }
    expect((await loadSlot(source!.id)).seats[0]!.reserved).toBe(2);
  });

  it("시작 시각 규칙과 권한은 회차 만들기와 같다", async () => {
    const l = await listing([{ capacity: 4 }]);
    const other = await listing();
    const staff = await member(l.business.id, "STAFF");

    expect((await appError(duplicateSlot(l.owner.id, l.slot.id, [l.slot.startAt]))).code).toBe("VALIDATION");
    expect((await appError(duplicateSlot(l.owner.id, l.slot.id, [new Date(Date.now() - HOUR)]))).code).toBe("VALIDATION");
    expect((await appError(duplicateSlot(l.owner.id, l.slot.id, []))).code).toBe("VALIDATION");
    expect((await appError(duplicateSlot(staff.id, l.slot.id, [inHours(200)]))).code).toBe("FORBIDDEN");
    expect((await appError(duplicateSlot(other.owner.id, l.slot.id, [inHours(200)]))).code).toBe("FORBIDDEN");
    expect((await appError(duplicateSlot(l.owner.id, "missing", [inHours(200)]))).code).toBe("NOT_FOUND");
    expect(await prisma.slot.count()).toBe(2);
  });
});

// ───────────────────────── 회차 수정·마감 ─────────────────────────

describe("updateSlot · closeSlot · reopenSlot", () => {
  it("메모·예약 마감·공석 종류를 고친다", async () => {
    const l = await listing([{ capacity: 4 }]);

    const updated = await updateSlot(l.owner.id, l.slot.id, { note: "드레스 코드: 화이트", deadlineMinBefore: 180, origin: "UNSOLD" });

    expect(updated).toMatchObject({ note: "드레스 코드: 화이트", origin: "UNSOLD" });
    expect(updated.bookingDeadlineAt.getTime()).toBe(l.slot.startAt.getTime() - 180 * MINUTE);
    expect((await updateSlot(l.owner.id, l.slot.id, { note: "" })).note).toBeNull();
    // 넘기지 않은 값은 그대로다.
    expect(await loadSlot(l.slot.id)).toMatchObject({ origin: "UNSOLD" });
    expect((await appError(updateSlot(l.owner.id, l.slot.id, { note: "떨이 판매" }))).code).toBe("VALIDATION");
    expect((await appError(updateSlot(l.owner.id, l.slot.id, { deadlineMinBefore: 1441 }))).code).toBe("VALIDATION");
    expect((await appError(updateSlot(l.owner.id, l.slot.id, { note: "가".repeat(81) }))).code).toBe("VALIDATION");
  });

  it("지나 있던 예약 마감을 늦추면 남은 자리를 다시 알림 흐름에 태운다", async () => {
    const l = await listing([{ capacity: 4 }], { startsInHours: 2, deadlineMinBefore: 180 });
    const calls = watchReleases();
    const before = (await loadSlot(l.slot.id)).vacancyPostedAt;
    travel(MINUTE);

    await updateSlot(l.owner.id, l.slot.id, { deadlineMinBefore: 30 });

    expect(calls).toEqual([l.seat.id]);
    expect((await loadSlot(l.slot.id)).vacancyPostedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("취소됐거나 끝난 회차는 고칠 수 없고, 매니저 이상만 고칠 수 있다", async () => {
    const cancelled = await listing([{ capacity: 4 }], { status: "CANCELLED" });
    const ended = await listing([{ capacity: 4 }], { startsInHours: -5, deadlineMinBefore: 0 });
    const l = await listing();
    const staff = await member(l.business.id, "STAFF");
    const other = await listing();

    expect((await appError(updateSlot(cancelled.owner.id, cancelled.slot.id, { note: "메모" }))).code).toBe("CLOSED");
    expect((await appError(updateSlot(ended.owner.id, ended.slot.id, { note: "메모" }))).code).toBe("CLOSED");
    expect((await appError(updateSlot(staff.id, l.slot.id, { note: "메모" }))).code).toBe("FORBIDDEN");
    expect((await appError(updateSlot(other.owner.id, l.slot.id, { note: "메모" }))).code).toBe("FORBIDDEN");
    expect((await appError(closeSlot(staff.id, l.slot.id))).code).toBe("FORBIDDEN");
    expect((await appError(closeSlot(other.owner.id, l.slot.id))).code).toBe("FORBIDDEN");
    expect((await appError(reopenSlot(other.owner.id, l.slot.id))).code).toBe("FORBIDDEN");
    expect((await loadSlot(l.slot.id)).note).toBeNull();
  });

  it("판매 마감과 재개: 마감 중에는 예약할 수 없고, 다시 열면 남은 자리가 알림 흐름을 탄다", async () => {
    const l = await listing([{ label: "A", capacity: 2 }, { label: "B", capacity: 2 }], { product: { paymentPolicy: "ONSITE" } });
    await bookOnsite(l.seat.id, 2);

    expect(await closeSlot(l.owner.id, l.slot.id)).toEqual({ status: "CLOSED" });
    expect((await appError(closeSlot(l.owner.id, l.slot.id))).code).toBe("CONFLICT");
    expect((await appError(bookOnsite(l.slot.seats[1]!.id))).code).toBe("CLOSED");

    const calls = watchReleases();
    travel(MINUTE);
    expect(await reopenSlot(l.owner.id, l.slot.id)).toEqual({ status: "OPEN" });

    // 매진된 좌석(A)은 빼고, 남은 자리가 있는 좌석(B)만 흐름을 탄다.
    expect(calls).toEqual([l.slot.seats[1]!.id]);
    expect((await loadSlot(l.slot.id)).vacancyPostedAt.getTime()).toBe(Date.now());
    expect((await appError(reopenSlot(l.owner.id, l.slot.id))).code).toBe("CONFLICT");
    expect((await bookOnsite(l.slot.seats[1]!.id)).booking.status).toBe("CONFIRMED");
  });

  it("이미 시작한 회차는 다시 열 수 없다", async () => {
    const l = await listing([{ capacity: 2 }], { startsInHours: 1, status: "CLOSED" });
    travel(HOUR + MINUTE);
    expect((await appError(reopenSlot(l.owner.id, l.slot.id))).code).toBe("CLOSED");
    expect((await loadSlot(l.slot.id)).status).toBe("CLOSED");
  });
});

// ───────────────────────── 좌석 ─────────────────────────

describe("updateSeat", () => {
  it("정원은 이미 잡힌 자리(예약 + 보류)보다 줄일 수 없다", async () => {
    const l = await listing([{ capacity: 5 }], { product: { paymentPolicy: "ONSITE" } });
    await bookOnsite(l.seat.id, 2);
    await prisma.slotSeat.update({ where: { id: l.seat.id }, data: { reserved: 3, withheld: 1 } });

    const e = await appError(updateSeat(l.owner.id, l.seat.id, { capacity: 2 }));
    expect(e.code).toBe("VALIDATION");
    expect(e.message).toContain("3석");
    expect((await loadSeat(l.seat.id)).capacity).toBe(5);

    expect(await updateSeat(l.owner.id, l.seat.id, { capacity: 3 })).toMatchObject({ capacity: 3, reserved: 3, withheld: 1 });
    expect(await verifyInventoryIntegrity()).toEqual([]);
  });

  it("정원을 늘리면 새 자리로 보고 등록 시각을 갱신하고 알림 흐름을 탄다. 줄이면 타지 않는다", async () => {
    const l = await listing([{ capacity: 2 }]);
    const calls = watchReleases();
    const posted = (await loadSlot(l.slot.id)).vacancyPostedAt;
    travel(MINUTE);

    await updateSeat(l.owner.id, l.seat.id, { capacity: 5 });
    expect(calls).toEqual([l.seat.id]);
    expect((await loadSlot(l.slot.id)).vacancyPostedAt.getTime()).toBe(posted.getTime() + MINUTE);

    travel(MINUTE);
    await updateSeat(l.owner.id, l.seat.id, { capacity: 3 });
    await updateSeat(l.owner.id, l.seat.id, { price: 10_000 });
    expect(calls).toHaveLength(1);
    expect((await loadSlot(l.slot.id)).vacancyPostedAt.getTime()).toBe(posted.getTime() + MINUTE);
    // 잡힌 자리가 없으면 0 으로 줄여 판매를 멈출 수 있다.
    expect(await updateSeat(l.owner.id, l.seat.id, { capacity: 0 })).toMatchObject({ capacity: 0 });
  });

  it("개최가 확정된 뒤 정원을 줄이면 쓰이지 않는 최소 인원도 정원에 맞춰 낮춘다", async () => {
    const l = await listing([{ capacity: 6 }]);
    await prisma.slotSeat.update({ where: { id: l.seat.id }, data: { minCount: 4 } });
    await prisma.slot.update({ where: { id: l.slot.id }, data: { decideAt: inHours(24), goConfirmedAt: new Date() } });

    expect(await updateSeat(l.owner.id, l.seat.id, { capacity: 3 })).toMatchObject({ capacity: 3, minCount: 3 });
  });

  it("가격을 바꿔도 이미 들어온 예약의 금액은 바뀌지 않는다", async () => {
    const l = await listing([{ capacity: 4, price: PRICE }], { product: { paymentPolicy: "ONSITE" } });
    const first = await bookOnsite(l.seat.id, 2);

    await updateSeat(l.owner.id, l.seat.id, { price: 50_000 });
    const second = await bookOnsite(l.seat.id, 1);

    expect(await prisma.booking.findUniqueOrThrow({ where: { id: first.booking.id } })).toMatchObject({ unitPrice: PRICE, totalAmount: PRICE * 2 });
    expect(second.booking).toMatchObject({ unitPrice: 50_000, totalAmount: 50_000 });
  });

  it("이름은 회차 안에서 겹칠 수 없고 금칙어를 쓸 수 없다. 범위를 벗어난 값은 거절한다", async () => {
    const l = await listing([{ label: "A", capacity: 2 }, { label: "B", capacity: 2 }]);
    const seatB = l.slot.seats[1]!;

    expect((await appError(updateSeat(l.owner.id, seatB.id, { label: "A" }))).code).toBe("VALIDATION");
    expect((await appError(updateSeat(l.owner.id, seatB.id, { label: "땡처리" }))).code).toBe("VALIDATION");
    expect((await appError(updateSeat(l.owner.id, seatB.id, { label: "" }))).code).toBe("VALIDATION");
    expect((await appError(updateSeat(l.owner.id, seatB.id, { capacity: -1 }))).code).toBe("VALIDATION");
    expect((await appError(updateSeat(l.owner.id, seatB.id, { capacity: 501 }))).code).toBe("VALIDATION");
    expect((await appError(updateSeat(l.owner.id, seatB.id, { price: 10_000_001 }))).code).toBe("VALIDATION");
    expect(await updateSeat(l.owner.id, seatB.id, { label: "B" })).toMatchObject({ label: "B" });
    expect(await updateSeat(l.owner.id, seatB.id, { label: "커플" })).toMatchObject({ label: "커플" });
  });

  it("매니저 이상만, 자기 사업장의 좌석만, 취소·종료되지 않은 회차만 고칠 수 있다", async () => {
    const l = await listing([{ capacity: 2 }]);
    const staff = await member(l.business.id, "STAFF");
    const other = await listing();
    const cancelled = await listing([{ capacity: 2 }], { status: "CANCELLED" });

    expect((await appError(updateSeat(staff.id, l.seat.id, { capacity: 3 }))).code).toBe("FORBIDDEN");
    expect((await appError(updateSeat(other.owner.id, l.seat.id, { capacity: 3 }))).code).toBe("FORBIDDEN");
    expect((await appError(updateSeat(l.owner.id, "missing", { capacity: 3 }))).code).toBe("NOT_FOUND");
    expect((await appError(updateSeat(cancelled.owner.id, cancelled.seat.id, { capacity: 3 }))).code).toBe("CLOSED");
    expect((await loadSeat(l.seat.id)).capacity).toBe(2);
  });
});

describe("addSeatType · removeSeatType", () => {
  it("좌석 유형을 추가하면 새 자리로 알리고, 회차당 6개까지 만들 수 있다", async () => {
    const l = await listing([{ label: "일반", capacity: 2 }]);
    const calls = watchReleases();

    const added = await addSeatType(l.owner.id, l.slot.id, { label: "커플", capacity: 2, price: 50_000 });

    expect(added).toMatchObject({ slotId: l.slot.id, label: "커플", gender: "ANY", capacity: 2, reserved: 0, price: 50_000, sort: 1 });
    expect(calls).toEqual([added.id]);
    expect((await appError(addSeatType(l.owner.id, l.slot.id, { label: "커플", capacity: 2, price: PRICE }))).code).toBe("VALIDATION");
    for (let i = 0; i < 4; i += 1) await addSeatType(l.owner.id, l.slot.id, { label: `추가${i}`, capacity: 1, price: PRICE });
    expect((await appError(addSeatType(l.owner.id, l.slot.id, { label: "일곱째", capacity: 1, price: PRICE }))).code).toBe("VALIDATION");
    expect(await prisma.slotSeat.count({ where: { slotId: l.slot.id } })).toBe(6);
  });

  it("삭제는 잡힌 자리·진행 중 대기·예약 이력이 없는 좌석만, 마지막 하나는 남긴다", async () => {
    const l = await listing(
      [
        { label: "예약됨", capacity: 2 },
        { label: "대기", capacity: 0 },
        { label: "이력", capacity: 2 },
        { label: "빈좌석", capacity: 2 },
      ],
      { product: { paymentPolicy: "ONSITE" } },
    );
    const [booked, waited, history, empty] = l.slot.seats;
    await bookOnsite(booked!.id);
    const waiter = await customer();
    const entry = await prisma.waitlistEntry.create({ data: { userId: waiter.id, slotId: l.slot.id, slotSeatId: waited!.id, status: "WAITING" } });
    const past = await createManualBooking(l.owner.id, l.business.id, { slotSeatId: history!.id, quantity: 1, guestName: "손님", guestPhone: nextPhone() });
    await prisma.booking.update({ where: { id: past.id }, data: { status: "CANCELLED" } });
    await prisma.slotSeat.update({ where: { id: history!.id }, data: { reserved: 0 } });

    expect((await appError(removeSeatType(l.owner.id, booked!.id))).code).toBe("VALIDATION");
    expect((await appError(removeSeatType(l.owner.id, waited!.id))).code).toBe("VALIDATION");
    expect((await appError(removeSeatType(l.owner.id, history!.id))).code).toBe("VALIDATION");
    expect(await prisma.slotSeat.count({ where: { slotId: l.slot.id } })).toBe(4);

    await removeSeatType(l.owner.id, empty!.id);
    expect(await prisma.slotSeat.findUnique({ where: { id: empty!.id } })).toBeNull();
    // 대기가 끝나면 지울 수 있다.
    await prisma.waitlistEntry.update({ where: { id: entry.id }, data: { status: "CANCELLED" } });
    await removeSeatType(l.owner.id, waited!.id);
    expect(await prisma.slotSeat.count({ where: { slotId: l.slot.id } })).toBe(2);

    const single = await listing([{ capacity: 2 }]);
    expect((await appError(removeSeatType(single.owner.id, single.seat.id))).code).toBe("VALIDATION");
    expect(await verifyInventoryIntegrity()).toEqual([]);
  });

  it("매니저 이상만, 자기 사업장의 회차에만", async () => {
    const l = await listing([{ label: "A", capacity: 2 }, { label: "B", capacity: 2 }]);
    const staff = await member(l.business.id, "STAFF");
    const other = await listing();
    const seat = { label: "추가", capacity: 1, price: PRICE };

    expect((await appError(addSeatType(staff.id, l.slot.id, seat))).code).toBe("FORBIDDEN");
    expect((await appError(addSeatType(other.owner.id, l.slot.id, seat))).code).toBe("FORBIDDEN");
    expect((await appError(removeSeatType(staff.id, l.slot.seats[1]!.id))).code).toBe("FORBIDDEN");
    expect((await appError(removeSeatType(other.owner.id, l.slot.seats[1]!.id))).code).toBe("FORBIDDEN");
    expect(await prisma.slotSeat.count({ where: { slotId: l.slot.id } })).toBe(2);
  });
});

describe("relistSeats", () => {
  it("보류 좌석을 일부만 또는 전부 다시 올리고, 회차를 취소석으로 표시한다(스태프 가능)", async () => {
    const l = await listing([{ capacity: 5 }]);
    await prisma.slotSeat.update({ where: { id: l.seat.id }, data: { reserved: 3, withheld: 3 } });
    const staff = await member(l.business.id, "STAFF");
    const calls = watchReleases();
    travel(MINUTE);

    expect(await relistSeats(staff.id, l.seat.id, 1)).toEqual({ relisted: 1, remaining: 3 });
    expect(await loadSeat(l.seat.id)).toMatchObject({ reserved: 2, withheld: 2 });
    expect(await loadSlot(l.slot.id)).toMatchObject({ origin: "CANCELLATION" });
    expect((await loadSlot(l.slot.id)).vacancyPostedAt.getTime()).toBe(Date.now());
    expect(calls).toEqual([l.seat.id]);

    // 보류분보다 많이 달라고 해도 있는 만큼만 올린다.
    expect(await relistSeats(staff.id, l.seat.id, 10)).toEqual({ relisted: 2, remaining: 5 });
    expect(await loadSeat(l.seat.id)).toMatchObject({ reserved: 0, withheld: 0 });
    expect((await appError(relistSeats(staff.id, l.seat.id))).code).toBe("VALIDATION");
    expect((await appError(relistSeats(staff.id, l.seat.id, 0))).code).toBe("VALIDATION");
  });

  it("취소됐거나 이미 시작한 회차의 자리는 다시 올릴 수 없고, 다른 사업장은 접근할 수 없다", async () => {
    const cancelled = await listing([{ capacity: 2 }], { status: "CANCELLED" });
    const started = await listing([{ capacity: 2 }], { startsInHours: -1, deadlineMinBefore: 0 });
    for (const l of [cancelled, started]) await prisma.slotSeat.update({ where: { id: l.seat.id }, data: { reserved: 1, withheld: 1 } });
    const other = await listing();

    expect((await appError(relistSeats(cancelled.owner.id, cancelled.seat.id))).code).toBe("CLOSED");
    expect((await appError(relistSeats(started.owner.id, started.seat.id))).code).toBe("CLOSED");
    expect((await appError(relistSeats(other.owner.id, started.seat.id))).code).toBe("FORBIDDEN");
    expect(await loadSeat(started.seat.id)).toMatchObject({ reserved: 1, withheld: 1 });
  });
});

// ───────────────────────── 사업자 조회 ─────────────────────────

describe("사업자 회차 조회", () => {
  it("목록: 좌석별 정원·잡힌 자리·보류·최소 인원·확정 인원, 상태별 예약 건수, 대기, 개최 상태, 자체 링크", async () => {
    const { business, owner, product } = await shop({ paymentPolicy: "ONSITE" });
    const [slot] = await createSlots(owner.id, business.id, {
      productId: product.id,
      starts: [inHours(100)],
      decideMinBefore: 1440,
      seats: [
        { label: "남성", gender: "MALE", capacity: 4, price: 35_000, minCount: 2 },
        { label: "여성", gender: "FEMALE", capacity: 4, price: 30_000, minCount: 1 },
      ],
    });
    const [male, female] = slot!.seats;
    await createSlots(owner.id, business.id, { productId: product.id, starts: [inHours(300)] });
    await bookOnsite(male!.id, 1);
    await bookOnsite(female!.id, 1, { gender: "FEMALE" });
    await createManualBooking(owner.id, business.id, { slotSeatId: female!.id, quantity: 2, guestName: "전화 손님", guestPhone: nextPhone() });
    await prisma.slotSeat.update({ where: { id: male!.id }, data: { reserved: { increment: 1 }, withheld: 1 } });
    await prisma.waitlistEntry.create({ data: { userId: (await customer()).id, slotId: slot!.id, slotSeatId: female!.id, status: "WAITING" } });
    const staff = await member(business.id, "STAFF");

    const items = await listSlotsForSeller(staff.id, business.id, { from: new Date(), to: inHours(200) });

    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toMatchObject({ id: slot!.id, productId: product.id, productTitle: product.title, status: "OPEN", waitingCount: 1 });
    expect(item.seats).toMatchObject([
      { id: male!.id, label: "남성", capacity: 4, reserved: 2, withheld: 1, remaining: 2, minCount: 2, confirmed: 1, waiting: 0, offered: 0 },
      { id: female!.id, label: "여성", capacity: 4, reserved: 3, withheld: 0, remaining: 1, minCount: 1, confirmed: 3, waiting: 1, offered: 0 },
    ]);
    expect(item.bookingCounts).toEqual({ pendingPayment: 0, pendingApproval: 0, confirmed: 3, completed: 0, noShow: 0 });
    expect(item.go).toMatchObject({ state: "GATHERING", needs: [{ seatId: male!.id, label: "남성", remaining: 1 }] });
    expect(item.publicPath).toBe(`/slots/${slot!.id}?via=${business.slug}`);

    expect(await listSlotsForSeller(owner.id, business.id, { from: new Date(), to: inHours(400) })).toHaveLength(2);
    expect(await listSlotsForSeller(owner.id, business.id, { from: new Date(), to: inHours(400), status: "CANCELLED" })).toHaveLength(0);
    const second = await createProduct(business.id, business.categoryId);
    expect(await listSlotsForSeller(owner.id, business.id, { from: new Date(), to: inHours(400), productId: second.id })).toHaveLength(0);
  });

  it("목록: 기간이 뒤집혔거나 100일을 넘으면 거절하고, 구성원만 볼 수 있다", async () => {
    const { business, owner } = await shop();
    const other = await shop();
    const now = new Date();

    expect((await appError(listSlotsForSeller(owner.id, business.id, { from: inHours(10), to: now }))).code).toBe("VALIDATION");
    expect((await appError(listSlotsForSeller(owner.id, business.id, { from: now, to: new Date(now.getTime() + 101 * DAY) }))).code).toBe("VALIDATION");
    expect((await appError(listSlotsForSeller(other.owner.id, business.id, { from: now, to: inHours(10) }))).code).toBe("FORBIDDEN");
    expect((await appError(listSlotsForSeller((await customer()).id, business.id, { from: now, to: inHours(10) }))).code).toBe("FORBIDDEN");
  });

  it("상세: 참석자 명단(연락처 포함)과 대기 요약을 주고, 회차가 끝나고 30일이 지나면 연락처를 가린다", async () => {
    const l = await listing([{ capacity: 4 }], { startsInHours: 5, durationMin: 60, product: { paymentPolicy: "ONSITE" } });
    const { user, booking } = await bookOnsite(l.seat.id, 2);
    await prisma.slotSeat.update({ where: { id: l.seat.id }, data: { reserved: { increment: 1 } } });
    await prisma.waitlistEntry.create({
      data: { userId: (await customer()).id, slotId: l.slot.id, slotSeatId: l.seat.id, status: "OFFERED", offeredAt: new Date(), offerExpiresAt: inHours(1) },
    });
    const other = await listing();

    const detail = await getSlotForSeller(l.owner.id, l.slot.id);

    expect(detail.bookings).toMatchObject([
      { id: booking.id, code: booking.code, status: "CONFIRMED", guestName: user.name, guestPhone: user.phone, quantity: 2, seatId: l.seat.id, seatLabel: "일반", paymentMethod: "ONSITE", attendanceConfirmedAt: null, checkedInAt: null },
    ]);
    expect(detail.waitlist).toEqual({ waiting: 0, offered: 1 });
    expect(detail.cancelledCount).toBe(0);
    expect(detail.seats[0]).toMatchObject({ reserved: 3, remaining: 1, confirmed: 2 });
    expect((await appError(getSlotForSeller(other.owner.id, l.slot.id))).code).toBe("FORBIDDEN");
    expect((await appError(getSlotForSeller(user.id, l.slot.id))).code).toBe("FORBIDDEN");
    expect((await appError(getSlotForSeller(l.owner.id, "missing"))).code).toBe("NOT_FOUND");

    travel(6 * HOUR + 30 * DAY + MINUTE);
    const old = await getSlotForSeller(l.owner.id, l.slot.id);
    expect(old.bookings[0]?.guestPhone).toBe(`${user.phone!.slice(0, 3)}-****-${user.phone!.slice(-4)}`);
  });

  it("getSlotPublicLink: 사업자 자체 링크 경로", () => {
    expect(getSlotPublicLink({ id: "slot_1", business: { slug: "daejeon-wine" } })).toBe("/slots/slot_1?via=daejeon-wine");
  });
});
