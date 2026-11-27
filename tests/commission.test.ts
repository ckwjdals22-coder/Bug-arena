import { beforeEach, describe, expect, it } from "vitest";
import type { BookingChannel, BookingStatus, CustomerSource, Prisma } from "@/generated/prisma/client";
import { BOOKING_CHANNEL_LABEL } from "@/lib/domain";
import { newBookingCode, newToken } from "@/lib/ids";
import { applyBps, formatBps } from "@/lib/money";
import { COMMISSION_RULE_LABEL } from "@/lib/policy";
import { DAY, MINUTE } from "@/lib/time";
import { prisma } from "@/server/db";
import {
  BOOKING_SOURCE_LABEL,
  COMMISSION_RULES,
  consumeLaunchPromo,
  decideCommission,
  describeCommission,
  isCommissionRule,
  isNewCustomerFor,
  marketRate,
  recalcCommissionForRetained,
  resolveCommission,
  snapshotCommission,
  type CommissionFacts,
  type CommissionRule,
  type CommissionSettings,
  type ResolveCommissionInput,
} from "@/server/services/commission";
import { DEFAULT_SETTINGS, getSettings, resetSettingsCache, updateSettings } from "@/server/settings";
import { createBusiness, createCategory, createProduct, createSlot, createUser, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

const NOW = new Date();
const PHONE = "01055550001";

/** 요율 비교가 뚜렷하도록 값의 크기 관계를 고정한 설정(기본값이 바뀌어도 시험의 뜻이 유지되게). */
const S: CommissionSettings = {
  ...DEFAULT_SETTINGS,
  commissionNewCustomerBps: 1000,
  proCommissionNewCustomerBps: 700,
  commissionReturningBps: 500,
  commissionDirectBps: 0,
  commissionCapPerSeat: 0,
  pgFeeBps: 300,
};

const facts = (overrides: Partial<CommissionFacts> = {}): CommissionFacts => ({
  channel: "MARKETPLACE",
  plan: "FREE",
  overrideBps: null,
  hasOwnCustomerCard: false,
  promoActive: false,
  isReturning: false,
  quantity: 2,
  totalAmount: 60_000,
  payNowAmount: 60_000,
  settings: S,
  ...overrides,
});

async function setup(business: Partial<Prisma.BusinessUncheckedCreateInput> = {}, category: Partial<Prisma.CategoryUncheckedCreateInput> = {}) {
  const cat = await createCategory(category);
  const created = await createBusiness({ categoryId: cat.id, ...business });
  const product = await createProduct(created.business.id, cat.id);
  const slot = await createSlot(product, [{ capacity: 50 }]);
  return { ...created, category: cat, product, slot, seat: slot.seats[0]! };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function insertBooking(ctx: Ctx, overrides: Partial<Prisma.BookingUncheckedCreateInput> = {}) {
  return prisma.booking.create({
    data: {
      code: newBookingCode(),
      businessId: ctx.business.id,
      productId: ctx.product.id,
      slotId: ctx.slot.id,
      slotSeatId: ctx.seat.id,
      quantity: 1,
      unitPrice: 30_000,
      totalAmount: 30_000,
      payNowAmount: 30_000,
      status: "CONFIRMED",
      paymentMethod: "ONLINE",
      paymentState: "PAID",
      guestName: "김손님",
      guestPhone: PHONE,
      policySnapshot: [],
      checkinToken: newToken(),
      ...overrides,
    },
  });
}

/** 시작 시각을 정한 회차에 이용 이력 예약을 만든다. */
async function insertHistory(ctx: Ctx, startAt: Date, overrides: Partial<Prisma.BookingUncheckedCreateInput> = {}) {
  const slot = await createSlot(ctx.product, [{ capacity: 10 }], {
    startAt,
    endAt: new Date(startAt.getTime() + 120 * MINUTE),
    bookingDeadlineAt: new Date(startAt.getTime() - 60 * MINUTE),
  });
  return insertBooking(ctx, { slotId: slot.id, slotSeatId: slot.seats[0]!.id, ...overrides });
}

const addCard = (businessId: string, source: CustomerSource, createdAt: Date, phone = PHONE) =>
  prisma.businessCustomer.create({ data: { businessId, name: "단골", phone, source, createdAt } });

const resolveInput = (ctx: Ctx, overrides: Partial<ResolveCommissionInput> = {}): ResolveCommissionInput => ({
  business: ctx.business,
  categoryCommissionBps: ctx.category.commissionBps,
  channel: "MARKETPLACE",
  userId: null,
  phone: PHONE,
  quantity: 1,
  totalAmount: 30_000,
  payNowAmount: 30_000,
  settings: S,
  now: NOW,
  ...overrides,
});

// ───────────────────────── 규칙표(조회 없음) ─────────────────────────

describe("decideCommission — 규칙표와 우선순위", () => {
  const everything = { hasOwnCustomerCard: true, promoActive: true, overrideBps: 800, isReturning: true } as const;

  const cases: { name: string; input: Partial<CommissionFacts>; rule: CommissionRule; bps: number; pgFee: boolean }[] = [
    { name: "직접 입력은 다른 조건이 다 맞아도 MANUAL", input: { channel: "MANUAL", ...everything }, rule: "MANUAL", bps: 0, pgFee: false },
    { name: "자체 링크는 내 고객·프로모션·개별 요율보다 먼저 DIRECT", input: { channel: "DIRECT", ...everything }, rule: "DIRECT", bps: S.commissionDirectBps, pgFee: true },
    { name: "내 고객 카드는 프로모션보다 먼저", input: { ...everything }, rule: "OWN_CUSTOMER", bps: 0, pgFee: true },
    { name: "대기 전환도 남는자리 유입이라 내 고객 카드를 본다", input: { channel: "WAITLIST", hasOwnCustomerCard: true }, rule: "OWN_CUSTOMER", bps: 0, pgFee: true },
    { name: "프로모션은 개별 요율·재방문보다 먼저", input: { ...everything, hasOwnCustomerCard: false }, rule: "PROMO", bps: 0, pgFee: true },
    { name: "개별 요율(신규 고객)", input: { overrideBps: 800 }, rule: "OVERRIDE", bps: 800, pgFee: false },
    { name: "개별 요율이 재방문 요율보다 높으면 재방문 고객은 재방문 요율", input: { overrideBps: 800, isReturning: true }, rule: "OVERRIDE", bps: S.commissionReturningBps, pgFee: false },
    { name: "개별 요율이 재방문 요율보다 낮으면 그대로", input: { overrideBps: 300, isReturning: true }, rule: "OVERRIDE", bps: 300, pgFee: false },
    { name: "개별 요율 0% 도 요율이다", input: { overrideBps: 0 }, rule: "OVERRIDE", bps: 0, pgFee: false },
    { name: "프로 플랜이어도 개별 요율이 있으면 개별 요율", input: { plan: "PRO", overrideBps: 1500 }, rule: "OVERRIDE", bps: 1500, pgFee: false },
    { name: "재방문 고객", input: { isReturning: true }, rule: "MARKET_RETURNING", bps: S.commissionReturningBps, pgFee: false },
    { name: "프로 플랜의 재방문 고객도 재방문 요율", input: { plan: "PRO", isReturning: true }, rule: "MARKET_RETURNING", bps: S.commissionReturningBps, pgFee: false },
    { name: "신규 고객", input: {}, rule: "MARKET_NEW", bps: S.commissionNewCustomerBps, pgFee: false },
    { name: "대기 전환 신규 고객", input: { channel: "WAITLIST" }, rule: "MARKET_NEW", bps: S.commissionNewCustomerBps, pgFee: false },
    { name: "프로 플랜 신규 고객", input: { plan: "PRO" }, rule: "MARKET_NEW", bps: S.proCommissionNewCustomerBps, pgFee: false },
  ];

  it.each(cases)("$name", ({ input, rule, bps, pgFee }) => {
    const f = facts(input);
    const result = decideCommission(f);
    expect(result.rule).toBe(rule);
    expect(result.bps).toBe(bps);
    expect(result.commissionAmount).toBe(rule === "MANUAL" ? 0 : applyBps(f.totalAmount, bps));
    expect(result.pgFeeAmount).toBe(pgFee ? applyBps(f.payNowAmount, S.pgFeeBps) : 0);
    expect(result.isNewCustomer).toBe(!f.isReturning);
  });

  it("모든 규칙 이름에 사업자 화면용 설명이 있다", () => {
    for (const rule of COMMISSION_RULES) expect(COMMISSION_RULE_LABEL[rule]).toBeDefined();
    expect(isCommissionRule("PROMO")).toBe(true);
    expect(isCommissionRule("SOMETHING")).toBe(false);
    expect(isCommissionRule(null)).toBe(false);
  });

  it("자체 링크 요율을 올리면 그 요율과 결제 실비가 함께 계산된다", () => {
    const settings = { ...S, commissionDirectBps: 200 };
    const result = decideCommission(facts({ channel: "DIRECT", settings }));
    expect(result).toMatchObject({
      rule: "DIRECT",
      bps: 200,
      commissionAmount: applyBps(60_000, 200),
      pgFeeAmount: applyBps(60_000, settings.pgFeeBps),
    });
  });

  it("결제 실비는 온라인 결제액에만 붙는다(예약금·현장 결제)", () => {
    const deposit = decideCommission(facts({ promoActive: true, totalAmount: 60_000, payNowAmount: 20_000 }));
    expect(deposit).toMatchObject({ rule: "PROMO", commissionAmount: 0, pgFeeAmount: applyBps(20_000, S.pgFeeBps) });

    const onsite = decideCommission(facts({ channel: "DIRECT", totalAmount: 60_000, payNowAmount: 0 }));
    expect(onsite).toMatchObject({ rule: "DIRECT", commissionAmount: 0, pgFeeAmount: 0 });

    // 중개 수수료는 현장 결제분을 포함한 거래 금액 전체에 매긴다.
    const market = decideCommission(facts({ totalAmount: 60_000, payNowAmount: 20_000 }));
    expect(market).toMatchObject({ rule: "MARKET_NEW", commissionAmount: applyBps(60_000, S.commissionNewCustomerBps), pgFeeAmount: 0 });
  });

  it("좌석당 상한 × 인원을 넘지 않는다(상한 0 은 상한 없음)", () => {
    const capped = { ...S, commissionCapPerSeat: 2_000 };
    const uncappedAmount = applyBps(300_000, S.commissionNewCustomerBps);
    expect(uncappedAmount).toBeGreaterThan(2_000 * 3);

    expect(decideCommission(facts({ quantity: 3, totalAmount: 300_000, payNowAmount: 300_000, settings: capped })).commissionAmount).toBe(2_000 * 3);
    expect(decideCommission(facts({ quantity: 1, totalAmount: 300_000, payNowAmount: 300_000, settings: capped })).commissionAmount).toBe(2_000);
    // 상한보다 적으면 요율대로
    expect(decideCommission(facts({ quantity: 3, totalAmount: 30_000, payNowAmount: 30_000, settings: capped })).commissionAmount).toBe(
      applyBps(30_000, S.commissionNewCustomerBps),
    );
    expect(decideCommission(facts({ quantity: 3, totalAmount: 300_000, payNowAmount: 300_000 })).commissionAmount).toBe(uncappedAmount);
  });

  it("무료 예약은 수수료가 없다", () => {
    expect(decideCommission(facts({ totalAmount: 0, payNowAmount: 0 }))).toMatchObject({ rule: "MARKET_NEW", commissionAmount: 0, pgFeeAmount: 0 });
  });

  it("원 단위 미만은 버린다", () => {
    const settings = { ...S, commissionNewCustomerBps: 990 };
    expect(decideCommission(facts({ quantity: 1, totalAmount: 33_333, payNowAmount: 33_333, settings })).commissionAmount).toBe(
      Math.floor((33_333 * 990) / 10_000),
    );
  });
});

describe("marketRate", () => {
  it("기본 설정값에서도 프로 플랜·재방문 요율을 설정에서 읽는다", () => {
    const settings = DEFAULT_SETTINGS;
    expect(marketRate({ plan: "FREE", overrideBps: null, isReturning: false, settings })).toEqual({ rule: "MARKET_NEW", bps: settings.commissionNewCustomerBps });
    expect(marketRate({ plan: "PRO", overrideBps: null, isReturning: false, settings })).toEqual({ rule: "MARKET_NEW", bps: settings.proCommissionNewCustomerBps });
    expect(marketRate({ plan: "PRO", overrideBps: null, isReturning: true, settings })).toEqual({ rule: "MARKET_RETURNING", bps: settings.commissionReturningBps });
    expect(marketRate({ plan: "FREE", overrideBps: 10_000, isReturning: true, settings })).toEqual({ rule: "OVERRIDE", bps: settings.commissionReturningBps });
  });
});

// ───────────────────────── 조회가 필요한 판정 ─────────────────────────

describe("resolveCommission — 채널·요율", () => {
  it("직접 입력: 수수료도 결제 실비도 없다(전화번호가 없어도 된다)", async () => {
    const ctx = await setup({ launchPromoUntil: new Date(NOW.getTime() + DAY), launchPromoRemaining: 5 });
    expect(await resolveCommission(resolveInput(ctx, { channel: "MANUAL", phone: "" }))).toEqual({
      rule: "MANUAL",
      bps: 0,
      commissionAmount: 0,
      pgFeeAmount: 0,
      isNewCustomer: true,
    });
  });

  it("자체 링크: 설정 요율 + 결제 실비", async () => {
    const ctx = await setup({ commissionBps: 800 });
    expect(await resolveCommission(resolveInput(ctx, { channel: "DIRECT" }))).toEqual({
      rule: "DIRECT",
      bps: S.commissionDirectBps,
      commissionAmount: applyBps(30_000, S.commissionDirectBps),
      pgFeeAmount: applyBps(30_000, S.pgFeeBps),
      isNewCustomer: true,
    });
  });

  it("신규 고객: 베이직과 프로 플랜 요율", async () => {
    const free = await setup();
    const pro = await setup({ plan: "PRO" });
    expect(await resolveCommission(resolveInput(free))).toMatchObject({
      rule: "MARKET_NEW",
      bps: S.commissionNewCustomerBps,
      commissionAmount: applyBps(30_000, S.commissionNewCustomerBps),
      pgFeeAmount: 0,
      isNewCustomer: true,
    });
    expect(await resolveCommission(resolveInput(pro))).toMatchObject({ rule: "MARKET_NEW", bps: S.proCommissionNewCustomerBps });
  });

  it("개별 요율: 사업자 요율이 업종 요율보다 먼저, 업종 요율만 있어도 적용", async () => {
    const both = await setup({ commissionBps: 800 }, { commissionBps: 1200 });
    const categoryOnly = await setup({}, { commissionBps: 1200 });
    expect(await resolveCommission(resolveInput(both))).toMatchObject({ rule: "OVERRIDE", bps: 800, commissionAmount: applyBps(30_000, 800), pgFeeAmount: 0 });
    expect(await resolveCommission(resolveInput(categoryOnly))).toMatchObject({ rule: "OVERRIDE", bps: 1200 });
  });

  it("개별 요율이 있는 사업자의 재방문 고객은 재방문 요율과 비교해 낮은 쪽", async () => {
    const high = await setup({ commissionBps: 800 });
    const low = await setup({ commissionBps: 300 });
    await insertHistory(high, new Date(NOW.getTime() - 10 * DAY));
    await insertHistory(low, new Date(NOW.getTime() - 10 * DAY));

    expect(await resolveCommission(resolveInput(high))).toMatchObject({ rule: "OVERRIDE", bps: S.commissionReturningBps, isNewCustomer: false });
    expect(await resolveCommission(resolveInput(low))).toMatchObject({ rule: "OVERRIDE", bps: 300, isNewCustomer: false });
  });

  it("금액 범위를 벗어난 입력은 계산하지 않는다", async () => {
    const ctx = await setup();
    for (const bad of [{ quantity: 0 }, { quantity: 1.5 }, { totalAmount: -1 }, { payNowAmount: 30_001 }, { totalAmount: Number.NaN }]) {
      await expect(resolveCommission(resolveInput(ctx, bad))).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });
});

describe("resolveCommission — 재방문 판정", () => {
  it.each<[BookingStatus, boolean]>([
    ["CONFIRMED", true],
    ["COMPLETED", true],
    ["NO_SHOW", true],
    ["CANCELLED", false],
    ["REJECTED", false],
    ["EXPIRED", false],
    ["PENDING_PAYMENT", false],
    ["PENDING_APPROVAL", false],
  ])("이용 이력 상태 %s → 재방문 %s", async (status, returning) => {
    const ctx = await setup();
    await insertHistory(ctx, new Date(NOW.getTime() - 30 * DAY), { status });

    const result = await resolveCommission(resolveInput(ctx));

    expect(result.isNewCustomer).toBe(!returning);
    expect(result.rule).toBe(returning ? "MARKET_RETURNING" : "MARKET_NEW");
    expect(result.bps).toBe(returning ? S.commissionReturningBps : S.commissionNewCustomerBps);
  });

  it("회원 ID 나 전화번호 어느 쪽으로든 이력을 찾는다(전화번호는 숫자만 견준다)", async () => {
    const ctx = await setup();
    const member = await createUser();
    await insertHistory(ctx, new Date(NOW.getTime() - 5 * DAY), { userId: member.id, guestPhone: "01099990000" });

    // 같은 회원이 다른 번호로 예약
    expect(await resolveCommission(resolveInput(ctx, { userId: member.id, phone: "01012340000" }))).toMatchObject({ rule: "MARKET_RETURNING" });
    // 비회원이 같은 번호로 예약(하이픈이 섞여 와도 같다)
    expect(await resolveCommission(resolveInput(ctx, { userId: null, phone: "010-9999-0000" }))).toMatchObject({ rule: "MARKET_RETURNING" });
    // 둘 다 다르면 신규
    const stranger = await createUser();
    expect(await resolveCommission(resolveInput(ctx, { userId: stranger.id, phone: "01012340000" }))).toMatchObject({ rule: "MARKET_NEW" });
  });

  it("다른 사업자에서의 이용 이력은 치지 않는다", async () => {
    const mine = await setup();
    const other = await setup();
    await insertHistory(other, new Date(NOW.getTime() - 5 * DAY));

    expect(await resolveCommission(resolveInput(mine))).toMatchObject({ rule: "MARKET_NEW", isNewCustomer: true });
    expect(await resolveCommission(resolveInput(other))).toMatchObject({ rule: "MARKET_RETURNING", isNewCustomer: false });
  });

  it("판정 기간의 경계: 기간 안에 시작한 회차만 이력이다", async () => {
    const windowMs = S.returningWindowDays * DAY;
    const inside = await setup();
    const outside = await setup();
    await insertHistory(inside, new Date(NOW.getTime() - windowMs + MINUTE), { status: "COMPLETED" });
    await insertHistory(outside, new Date(NOW.getTime() - windowMs - MINUTE), { status: "COMPLETED" });

    expect(await resolveCommission(resolveInput(inside))).toMatchObject({ rule: "MARKET_RETURNING", isNewCustomer: false });
    expect(await resolveCommission(resolveInput(outside))).toMatchObject({ rule: "MARKET_NEW", isNewCustomer: true });

    // 기간을 줄이면 같은 이력이 기간 밖이 된다.
    const shorter = { ...S, returningWindowDays: S.returningWindowDays - 1 };
    expect(await resolveCommission(resolveInput(inside, { settings: shorter }))).toMatchObject({ rule: "MARKET_NEW" });
  });

  it("앞으로 열릴 회차의 확정 예약도 이력이고, 지금 판정하는 예약 자신은 뺀다", async () => {
    const ctx = await setup();
    const current = await insertBooking(ctx);

    expect(await resolveCommission(resolveInput(ctx))).toMatchObject({ rule: "MARKET_RETURNING" });
    expect(await resolveCommission(resolveInput(ctx, { excludeBookingId: current.id }))).toMatchObject({ rule: "MARKET_NEW", isNewCustomer: true });
  });

  it("isNewCustomerFor: 기간을 생략하면 운영 설정의 기간을 쓰고, 식별 값이 없으면 신규로 본다", async () => {
    const ctx = await setup();
    const windowMs = DEFAULT_SETTINGS.returningWindowDays * DAY;
    await insertHistory(ctx, new Date(NOW.getTime() - windowMs - MINUTE));

    expect(await isNewCustomerFor(ctx.business.id, { phone: PHONE }, { now: NOW })).toBe(true);
    await updateSettings({ returningWindowDays: Math.min(DEFAULT_SETTINGS.returningWindowDays + 30, 1095) }, ctx.owner.id);
    expect(await isNewCustomerFor(ctx.business.id, { phone: PHONE }, { now: NOW })).toBe(false);
    expect(await isNewCustomerFor(ctx.business.id, { phone: "" }, { now: NOW })).toBe(true);
    expect(await isNewCustomerFor(ctx.business.id, { userId: null, phone: "--" }, { now: NOW })).toBe(true);
  });

  it("isNewCustomerFor: 트랜잭션 안에서는 판정 기간을 넘겨야 한다(트랜잭션 밖 연결로 설정을 읽지 않게)", async () => {
    const ctx = await setup();
    await insertHistory(ctx, new Date(NOW.getTime() - 5 * DAY));

    await expect(prisma.$transaction((tx) => isNewCustomerFor(ctx.business.id, { phone: PHONE }, { now: NOW }, tx))).rejects.toThrow("windowDays");
    expect(
      await prisma.$transaction((tx) => isNewCustomerFor(ctx.business.id, { phone: PHONE }, { now: NOW, windowDays: S.returningWindowDays }, tx)),
    ).toBe(false);
    expect(
      await prisma.$transaction((tx) => isNewCustomerFor(ctx.business.id, { phone: "01000000000" }, { now: NOW, windowDays: S.returningWindowDays }, tx)),
    ).toBe(true);
  });
});

describe("resolveCommission — 내 고객 카드", () => {
  const before = new Date(NOW.getTime() - MINUTE);
  const after = new Date(NOW.getTime() + MINUTE);

  it.each<[CustomerSource, boolean]>([
    ["MANUAL", true],
    ["IMPORTED", true],
    ["MARKETPLACE", false],
    ["DIRECT", false],
  ])("예약 전에 만든 %s 카드 → 내 고객 %s", async (source, own) => {
    const ctx = await setup();
    await addCard(ctx.business.id, source, before);

    const result = await resolveCommission(resolveInput(ctx));

    expect(result.rule).toBe(own ? "OWN_CUSTOMER" : "MARKET_NEW");
    if (own) {
      expect(result).toMatchObject({ bps: 0, commissionAmount: 0, pgFeeAmount: applyBps(30_000, S.pgFeeBps), isNewCustomer: true });
    }
  });

  it("예약 뒤에 만든 카드는 치지 않는다", async () => {
    const ctx = await setup();
    await addCard(ctx.business.id, "IMPORTED", after);
    expect(await resolveCommission(resolveInput(ctx))).toMatchObject({ rule: "MARKET_NEW" });
  });

  it("기준은 확정 시각이 아니라 예약을 만든 시각이다(승인 대기 중에 카드를 넣어도 소용없다)", async () => {
    const ctx = await setup();
    const bookedAt = new Date(NOW.getTime() - 60 * MINUTE);
    // 예약(1시간 전)과 확정(지금) 사이에 등록한 카드
    await addCard(ctx.business.id, "MANUAL", new Date(NOW.getTime() - 30 * MINUTE));

    expect(await resolveCommission(resolveInput(ctx, { bookedAt }))).toMatchObject({ rule: "MARKET_NEW" });
    // bookedAt 을 주지 않으면 now 가 기준이다.
    expect(await resolveCommission(resolveInput(ctx))).toMatchObject({ rule: "OWN_CUSTOMER" });
  });

  it("다른 번호·다른 사업자의 카드는 치지 않고, 대기 전환 예약에도 적용된다", async () => {
    const ctx = await setup();
    const other = await setup();
    await addCard(other.business.id, "IMPORTED", before);
    await addCard(ctx.business.id, "IMPORTED", before, "01077770000");

    expect(await resolveCommission(resolveInput(ctx))).toMatchObject({ rule: "MARKET_NEW" });
    expect(await resolveCommission(resolveInput(ctx, { phone: "010-7777-0000", channel: "WAITLIST" }))).toMatchObject({ rule: "OWN_CUSTOMER" });
  });

  it("내 고객 카드는 프로모션·개별 요율·재방문보다 먼저다", async () => {
    const ctx = await setup({ commissionBps: 800, launchPromoUntil: new Date(NOW.getTime() + DAY), launchPromoRemaining: 3 });
    await addCard(ctx.business.id, "MANUAL", before);
    await insertHistory(ctx, new Date(NOW.getTime() - 5 * DAY));

    expect(await resolveCommission(resolveInput(ctx))).toMatchObject({ rule: "OWN_CUSTOMER", bps: 0, isNewCustomer: false });
  });
});

describe("resolveCommission — 입점 프로모션", () => {
  it("기간이 남고 건수가 남았을 때만 PROMO, 판정만으로는 건수가 줄지 않는다", async () => {
    const active = await setup({ launchPromoUntil: new Date(NOW.getTime() + MINUTE), launchPromoRemaining: 1, commissionBps: 800 });
    const ended = await setup({ launchPromoUntil: new Date(NOW.getTime() - MINUTE), launchPromoRemaining: 5 });
    const usedUp = await setup({ launchPromoUntil: new Date(NOW.getTime() + DAY), launchPromoRemaining: 0 });
    const never = await setup();

    expect(await resolveCommission(resolveInput(active))).toEqual({
      rule: "PROMO",
      bps: 0,
      commissionAmount: 0,
      pgFeeAmount: applyBps(30_000, S.pgFeeBps),
      isNewCustomer: true,
    });
    expect(await resolveCommission(resolveInput(ended))).toMatchObject({ rule: "MARKET_NEW" });
    expect(await resolveCommission(resolveInput(usedUp))).toMatchObject({ rule: "MARKET_NEW" });
    expect(await resolveCommission(resolveInput(never))).toMatchObject({ rule: "MARKET_NEW" });

    const row = await prisma.business.findUniqueOrThrow({ where: { id: active.business.id } });
    expect(row.launchPromoRemaining).toBe(1);
  });

  it("consumeLaunchPromo: 3건 남았을 때 20건이 동시에 쓰면 정확히 3건만 성공한다", async () => {
    const ctx = await setup({ launchPromoUntil: new Date(NOW.getTime() + DAY), launchPromoRemaining: 3 });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => prisma.$transaction((tx) => consumeLaunchPromo(tx, ctx.business.id, NOW))),
    );

    expect(results.filter(Boolean)).toHaveLength(3);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: ctx.business.id } })).launchPromoRemaining).toBe(0);
  });

  it("consumeLaunchPromo: 기간이 끝났거나 프로모션이 없으면 false, 롤백되면 건수도 돌아온다", async () => {
    const until = new Date(NOW.getTime() + 60 * MINUTE);
    const ctx = await setup({ launchPromoUntil: until, launchPromoRemaining: 2 });
    const none = await setup();
    const remaining = async () => (await prisma.business.findUniqueOrThrow({ where: { id: ctx.business.id } })).launchPromoRemaining;

    // 종료 시각 이후(같은 시각 포함)에는 쓸 수 없다.
    expect(await prisma.$transaction((tx) => consumeLaunchPromo(tx, ctx.business.id, new Date(until.getTime() + 1000)))).toBe(false);
    expect(await prisma.$transaction((tx) => consumeLaunchPromo(tx, ctx.business.id, until))).toBe(false);
    expect(await prisma.$transaction((tx) => consumeLaunchPromo(tx, none.business.id, NOW))).toBe(false);
    expect(await remaining()).toBe(2);

    await expect(
      prisma.$transaction(async (tx) => {
        expect(await consumeLaunchPromo(tx, ctx.business.id, new Date(until.getTime() - 1000))).toBe(true);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await remaining()).toBe(2);
  });
});

// ───────────────────────── 확정 트랜잭션용 스냅샷 ─────────────────────────

describe("snapshotCommission", () => {
  /** 엔진과 같은 순서: 운영 설정은 트랜잭션을 열기 전에 읽어서 넘긴다. */
  const snapshot = async (booking: Parameters<typeof snapshotCommission>[1], now = new Date()) => {
    const settings = await getSettings();
    return prisma.$transaction((tx) => snapshotCommission(tx, booking, { settings, now }));
  };

  it("운영 설정·사업자·상품 분류를 읽어 판정한다(기본 설정)", async () => {
    const ctx = await setup({}, { commissionBps: null });
    const booking = await insertBooking(ctx, { quantity: 2, totalAmount: 60_000, payNowAmount: 60_000 });

    const result = await snapshot(booking);

    const expected = recalcCommissionForRetained({
      rule: "MARKET_NEW",
      bps: DEFAULT_SETTINGS.commissionNewCustomerBps,
      quantity: 2,
      retainedTotal: 60_000,
      retainedOnline: 60_000,
      settings: DEFAULT_SETTINGS,
    });
    expect(result).toEqual({ rule: "MARKET_NEW", bps: DEFAULT_SETTINGS.commissionNewCustomerBps, ...expected, isNewCustomer: true });
  });

  it("운영자가 바꾼 설정과 상품 분류의 업종 요율을 따른다", async () => {
    const ctx = await setup();
    const special = await createCategory({ commissionBps: 1234 });
    const product = await createProduct(ctx.business.id, special.id);
    const slot = await createSlot(product, [{ capacity: 5 }]);
    const inSpecial = await insertBooking(ctx, { productId: product.id, slotId: slot.id, slotSeatId: slot.seats[0]!.id, guestPhone: "01022220000" });
    const regular = await insertBooking(ctx, { guestPhone: "01033330000" });
    await updateSettings({ commissionNewCustomerBps: 1111, commissionCapPerSeat: 0 }, ctx.owner.id);

    expect(await snapshot(inSpecial)).toMatchObject({ rule: "OVERRIDE", bps: 1234, commissionAmount: applyBps(30_000, 1234) });
    expect(await snapshot(regular)).toMatchObject({ rule: "MARKET_NEW", bps: 1111, commissionAmount: applyBps(30_000, 1111) });
  });

  it("PROMO 로 판정되면 프로모션 건수를 1 줄인다. 다른 규칙이면 줄이지 않는다", async () => {
    const ctx = await setup({ launchPromoUntil: new Date(Date.now() + DAY), launchPromoRemaining: 2 });
    const remaining = async () => (await prisma.business.findUniqueOrThrow({ where: { id: ctx.business.id } })).launchPromoRemaining;
    const market = await insertBooking(ctx, { guestPhone: "01011110001" });
    const manual = await insertBooking(ctx, { guestPhone: "01011110002", channel: "MANUAL", paymentMethod: "ONSITE", payNowAmount: 0, payOnsiteAmount: 30_000 });
    const direct = await insertBooking(ctx, { guestPhone: "01011110003", channel: "DIRECT" });

    expect(await snapshot(manual)).toMatchObject({ rule: "MANUAL", commissionAmount: 0, pgFeeAmount: 0 });
    expect(await snapshot(direct)).toMatchObject({ rule: "DIRECT" });
    expect(await remaining()).toBe(2);

    expect(await snapshot(market)).toMatchObject({
      rule: "PROMO",
      bps: 0,
      commissionAmount: 0,
      pgFeeAmount: applyBps(30_000, DEFAULT_SETTINGS.pgFeeBps),
    });
    expect(await remaining()).toBe(1);
  });

  it("남은 프로모션보다 많은 예약이 동시에 확정되면 남은 건수만 PROMO, 나머지는 프로모션 없이 다시 판정한다", async () => {
    const ctx = await setup({ launchPromoUntil: new Date(Date.now() + DAY), launchPromoRemaining: 3 });
    const bookings: Awaited<ReturnType<typeof insertBooking>>[] = [];
    for (let i = 0; i < 30; i++) {
      bookings.push(await insertBooking(ctx, { guestPhone: `010444400${String(i).padStart(2, "0")}`, status: "PENDING_PAYMENT" }));
    }
    // 설정 캐시가 비어 있고 동시 트랜잭션이 연결 풀보다 많아도, 설정을 트랜잭션 밖에서 읽으므로 서로를 기다리지 않는다.
    resetSettingsCache();

    const results = await Promise.all(bookings.map((b) => snapshot(b)));

    const rules = results.map((r) => r.rule);
    expect(rules.filter((r) => r === "PROMO")).toHaveLength(3);
    expect(rules.filter((r) => r === "MARKET_NEW")).toHaveLength(27);
    for (const r of results.filter((x) => x.rule === "MARKET_NEW")) {
      expect(r.bps).toBe(DEFAULT_SETTINGS.commissionNewCustomerBps);
      expect(r.pgFeeAmount).toBe(0);
    }
    expect((await prisma.business.findUniqueOrThrow({ where: { id: ctx.business.id } })).launchPromoRemaining).toBe(0);
  });

  it("지금 확정하는 예약 자신은 이력에서 빼고, 내 고객 카드는 예약 시각 기준으로 본다", async () => {
    const ctx = await setup();
    const now = new Date();
    const booking = await insertBooking(ctx, { createdAt: new Date(now.getTime() - 60 * MINUTE) });
    expect(await snapshot(booking, now)).toMatchObject({ rule: "MARKET_NEW", isNewCustomer: true });

    // 예약 뒤에 등록한 카드
    const late = await addCard(ctx.business.id, "MANUAL", new Date(now.getTime() - 30 * MINUTE));
    expect(await snapshot(booking, now)).toMatchObject({ rule: "MARKET_NEW" });
    // 예약 전에 있던 카드
    await prisma.businessCustomer.update({ where: { id: late.id }, data: { createdAt: new Date(now.getTime() - 120 * MINUTE) } });
    expect(await snapshot(booking, now)).toMatchObject({ rule: "OWN_CUSTOMER", bps: 0 });

    // 같은 고객의 다른 확정 예약이 있으면 재방문
    await prisma.businessCustomer.delete({ where: { id: late.id } });
    await insertHistory(ctx, new Date(now.getTime() - 3 * DAY), { status: "COMPLETED" });
    expect(await snapshot(booking, now)).toMatchObject({ rule: "MARKET_RETURNING", isNewCustomer: false });
  });

  it("사업장이 없으면 NOT_FOUND", async () => {
    const ctx = await setup();
    const booking = await insertBooking(ctx);
    await expect(snapshot({ ...booking, businessId: "no-such-business" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ───────────────────────── 취소·재판매 뒤 재계산 ─────────────────────────

describe("recalcCommissionForRetained", () => {
  const base = { quantity: 2, settings: S };

  it("남은 금액 기준으로 다시 계산한다", () => {
    // 60,000원 중 50% 환불 → 30,000원이 남음
    expect(recalcCommissionForRetained({ ...base, rule: "MARKET_NEW", bps: S.commissionNewCustomerBps, retainedTotal: 30_000, retainedOnline: 30_000 })).toEqual({
      commissionAmount: applyBps(30_000, S.commissionNewCustomerBps),
      pgFeeAmount: 0,
    });
    expect(recalcCommissionForRetained({ ...base, rule: "OVERRIDE", bps: 800, retainedTotal: 12_345, retainedOnline: 12_345 })).toEqual({
      commissionAmount: applyBps(12_345, 800),
      pgFeeAmount: 0,
    });
  });

  it("전액 환불이면 수수료도 결제 실비도 0", () => {
    for (const rule of COMMISSION_RULES) {
      expect(recalcCommissionForRetained({ ...base, rule, bps: 1000, retainedTotal: 0, retainedOnline: 0 })).toEqual({ commissionAmount: 0, pgFeeAmount: 0 });
    }
    expect(recalcCommissionForRetained({ ...base, rule: "PROMO", bps: 0, retainedTotal: -500, retainedOnline: -500 })).toEqual({ commissionAmount: 0, pgFeeAmount: 0 });
  });

  it("결제 실비는 DIRECT·OWN_CUSTOMER·PROMO 의 남은 온라인 결제액에만 붙는다", () => {
    for (const rule of ["DIRECT", "OWN_CUSTOMER", "PROMO"] as const) {
      expect(recalcCommissionForRetained({ ...base, rule, bps: 0, retainedTotal: 40_000, retainedOnline: 25_000 })).toEqual({
        commissionAmount: 0,
        pgFeeAmount: applyBps(25_000, S.pgFeeBps),
      });
    }
    for (const rule of ["MARKET_NEW", "MARKET_RETURNING", "OVERRIDE", "MANUAL"] as const) {
      expect(recalcCommissionForRetained({ ...base, rule, bps: 0, retainedTotal: 40_000, retainedOnline: 25_000 }).pgFeeAmount).toBe(0);
    }
    // 온라인으로 남은 금액은 남은 거래 금액을 넘을 수 없다.
    expect(recalcCommissionForRetained({ ...base, rule: "PROMO", bps: 0, retainedTotal: 10_000, retainedOnline: 99_000 }).pgFeeAmount).toBe(
      applyBps(10_000, S.pgFeeBps),
    );
  });

  it("직접 입력 예약은 항상 0, 상한은 예약 수량 기준으로 그대로 적용한다", () => {
    expect(recalcCommissionForRetained({ ...base, rule: "MANUAL", bps: 1000, retainedTotal: 50_000, retainedOnline: 50_000 })).toEqual({
      commissionAmount: 0,
      pgFeeAmount: 0,
    });
    const capped = { ...S, commissionCapPerSeat: 1_000 };
    expect(
      recalcCommissionForRetained({ rule: "MARKET_NEW", bps: 1000, quantity: 2, retainedTotal: 500_000, retainedOnline: 500_000, settings: capped }).commissionAmount,
    ).toBe(2_000);
    expect(
      recalcCommissionForRetained({ rule: "MARKET_NEW", bps: 1000, quantity: 2, retainedTotal: 15_000, retainedOnline: 15_000, settings: capped }).commissionAmount,
    ).toBe(1_500);
  });

  it("확정 때의 스냅샷과 같은 식이다(남은 금액 = 전체 금액이면 값이 같다)", () => {
    const f = facts({ quantity: 3, totalAmount: 90_000, payNowAmount: 30_000, promoActive: true });
    const snap = decideCommission(f);
    expect(
      recalcCommissionForRetained({ rule: snap.rule, bps: snap.bps, quantity: 3, retainedTotal: 90_000, retainedOnline: 30_000, settings: S }),
    ).toEqual({ commissionAmount: snap.commissionAmount, pgFeeAmount: snap.pgFeeAmount });
  });
});

// ───────────────────────── 정산서 문구 ─────────────────────────

describe("describeCommission", () => {
  const describeFor = (rule: string | null, bps: number, channel: BookingChannel, source: string | null) =>
    describeCommission({ commissionRule: rule, commissionBps: bps, channel, source });

  it("규칙 이름·설명·요율·유입 경로를 사람이 읽는 문구로 돌려준다", () => {
    expect(describeFor("MARKET_NEW", 990, "MARKETPLACE", "search")).toEqual({
      ruleLabel: COMMISSION_RULE_LABEL.MARKET_NEW!.label,
      ruleDesc: COMMISSION_RULE_LABEL.MARKET_NEW!.desc,
      bpsText: formatBps(990),
      channelLabel: BOOKING_CHANNEL_LABEL.MARKETPLACE,
      sourceLabel: BOOKING_SOURCE_LABEL.search,
    });
    expect(describeFor("MARKET_RETURNING", 490, "WAITLIST", "waitlist_offer")).toMatchObject({
      ruleLabel: COMMISSION_RULE_LABEL.MARKET_RETURNING!.label,
      bpsText: formatBps(490),
      channelLabel: BOOKING_CHANNEL_LABEL.WAITLIST,
      sourceLabel: BOOKING_SOURCE_LABEL.waitlist_offer,
    });
  });

  it("결제 실비만 차감하는 규칙은 요율 옆에 결제 실비를 밝힌다", () => {
    for (const rule of ["DIRECT", "OWN_CUSTOMER", "PROMO"]) {
      expect(describeFor(rule, 0, "DIRECT", "biz_link").bpsText).toBe(`${formatBps(0)} + 결제 실비`);
    }
    expect(describeFor("MANUAL", 0, "MANUAL", null).bpsText).toBe(formatBps(0));
  });

  it("모르는 유입 경로·값이 없는 경로는 채널 이름으로, 확정 전 예약은 '확정 전'으로 보여 준다", () => {
    expect(describeFor("MARKET_NEW", 990, "MARKETPLACE", "something_new").sourceLabel).toBe(BOOKING_CHANNEL_LABEL.MARKETPLACE);
    expect(describeFor("MANUAL", 0, "MANUAL", null).sourceLabel).toBe(BOOKING_CHANNEL_LABEL.MANUAL);
    expect(describeFor(null, 0, "MARKETPLACE", "home")).toMatchObject({ ruleLabel: "확정 전", bpsText: "-", sourceLabel: BOOKING_SOURCE_LABEL.home });
    expect(describeFor("LEGACY_RULE", 500, "MARKETPLACE", null)).toMatchObject({ ruleLabel: "기타", bpsText: formatBps(500) });
  });
});
