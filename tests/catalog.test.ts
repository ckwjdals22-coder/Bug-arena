import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingStatus, Prisma } from "@/generated/prisma/client";
import { CANCELLATION_PRESETS } from "@/lib/domain";
import { maskName } from "@/lib/format";
import { addDays, kstDate, kstDateKey } from "@/lib/time";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  ADDRESS_DISCLOSURE_STATUSES,
  VACANCY_SORTS,
  ageOf,
  getBusinessPage,
  getHomeFeed,
  getShareMeta,
  getSitemapEntries,
  getSlotAvailability,
  getSlotDetail,
  listAreas,
  listCategories,
  listNextVacancyCards,
  listVacancies,
  parseVacancyFilters,
  searchSuggest,
  type VacancyCard,
  type VacancyFilters,
} from "@/server/services/catalog";
import { ANALYTICS_META_KEYS, SEARCH_TERM_MAX, flushEvents, trackEvent } from "@/server/services/events";
import { REVIEW_NEW_THRESHOLD } from "@/server/services/reviews";
import { createArea, createBusiness, createCategory, createProduct, createSlot, createUser, resetDb, type SeatSpec } from "./helpers";

/** 기준 시각: 2026-12-02(수) 10:00 KST. 이번 주말은 12/5(토)·12/6(일) */
const NOW = kstDate(2026, 12, 2, 10, 0);
const HOUR_MS = 3_600_000;

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── 준비 도구 ─────────────────────────────────────────

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("실패해야 하는 호출이 성공했어요.");
}

type ProductRef = { id: string; businessId: string };

/** 사업장(분류·동네 포함)과 상품 하나 */
async function setup(
  options: {
    business?: Partial<Prisma.BusinessUncheckedCreateInput>;
    product?: Partial<Prisma.ProductUncheckedCreateInput>;
    category?: Partial<Prisma.CategoryUncheckedCreateInput>;
    area?: Partial<Prisma.AreaUncheckedCreateInput>;
  } = {},
) {
  const category = await createCategory(options.category);
  const area = await createArea(options.area);
  const { business, owner } = await createBusiness({ categoryId: category.id, areaId: area.id, ...options.business });
  const product = await createProduct(business.id, category.id, options.product);
  return { category, area, business, owner, product };
}

/** KST 시각에 시작하는 2시간짜리 회차(예약 마감은 시작 1시간 전) */
async function slotAt(
  product: ProductRef,
  startAt: Date,
  seats: SeatSpec[] = [{ capacity: 4 }],
  extra: Partial<Prisma.SlotUncheckedCreateInput> = {},
) {
  return createSlot(product, seats, {
    startAt,
    endAt: new Date(startAt.getTime() + 2 * HOUR_MS),
    bookingDeadlineAt: new Date(startAt.getTime() - HOUR_MS),
    ...extra,
  });
}

const reserve = (seatId: string, reserved: number, withheld = 0) =>
  prisma.slotSeat.update({ where: { id: seatId }, data: { reserved, withheld } });

async function createBooking(
  slot: { id: string; productId: string; businessId: string },
  seatId: string,
  userId: string | null,
  status: BookingStatus,
  data: Partial<Prisma.BookingUncheckedCreateInput> = {},
) {
  const quantity = data.quantity ?? 1;
  return prisma.booking.create({
    data: {
      code: `NJ-${randomBytes(4).toString("hex").toUpperCase()}`,
      userId,
      businessId: slot.businessId,
      productId: slot.productId,
      slotId: slot.id,
      slotSeatId: seatId,
      quantity,
      unitPrice: 30000,
      totalAmount: 30000 * quantity,
      payNowAmount: 30000 * quantity,
      status,
      paymentMethod: "ONLINE",
      guestName: "예약자본명",
      guestPhone: "01077778888",
      sellerMemo: "사업자만 보는 메모",
      policySnapshot: [...CANCELLATION_PRESETS.STANDARD.tiers],
      checkinToken: randomBytes(12).toString("hex"),
      ...data,
    },
  });
}

const ids = (page: { items: VacancyCard[] }) => page.items.map((item) => item.slotId);
const list = async (filters: VacancyFilters = {}, viewer?: Parameters<typeof listVacancies>[1]) => ids(await listVacancies(filters, viewer));

/** 값 안에 나오는 모든 키 이름(중첩 포함) */
function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value instanceof Map) {
    for (const item of value.values()) collectKeys(item, keys);
  } else if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

/** 어떤 공개 반환값에도 나오면 안 되는 내부 필드 */
const PRIVATE_KEYS = [
  "reserved",
  "withheld",
  "sellerMemo",
  "requestNote",
  "guestName",
  "guestPhone",
  "bankName",
  "bankAccountEnc",
  "bankAccountLast4",
  "bankHolder",
  "commissionBps",
  "commissionAmount",
  "commissionRule",
  "pgFeeAmount",
  "launchPromoUntil",
  "launchPromoRemaining",
  "passwordHash",
  "email",
  "checkinToken",
  "suspendedReason",
  "rejectReason",
];

function expectNoPrivateKeys(value: unknown, extra: string[] = []): void {
  const keys = collectKeys(value);
  for (const key of [...PRIVATE_KEYS, ...extra]) expect(keys.has(key), `내부 필드 ${key} 가 반환값에 있어요`).toBe(false);
}

// ── 공개 규칙 ─────────────────────────────────────────

describe("공개 노출 규칙", () => {
  async function hiddenAndVisible() {
    const start = kstDate(2026, 12, 3, 19, 0);
    const visible = await setup({ product: { title: "보이는 모임" }, business: { name: "보이는 가게" } });
    const visibleSlot = await slotAt(visible.product, start);

    const pending = await setup({ business: { status: "PENDING", name: "심사 중 가게" }, product: { title: "심사 중 모임" } });
    const pendingSlot = await slotAt(pending.product, start);
    const suspended = await setup({ business: { status: "SUSPENDED", name: "정지 가게" }, product: { title: "정지 모임" } });
    const suspendedSlot = await slotAt(suspended.product, start);
    const paused = await setup({ product: { status: "PAUSED", title: "중지 모임" } });
    const pausedSlot = await slotAt(paused.product, start);
    const closedSlot = await slotAt(visible.product, start, [{ capacity: 4 }], { status: "CLOSED" });
    const cancelledSlot = await slotAt(visible.product, start, [{ capacity: 4 }], { status: "CANCELLED" });
    // 시작은 아직이지만 예약 마감이 지난 회차
    const deadlinePassed = await slotAt(visible.product, new Date(NOW.getTime() + 30 * 60_000), [{ capacity: 4 }], {
      bookingDeadlineAt: new Date(NOW.getTime() - 60_000),
    });
    return {
      visible,
      visibleSlot,
      hidden: [pendingSlot, suspendedSlot, pausedSlot, closedSlot, cancelledSlot, deadlinePassed],
      pending,
      paused,
    };
  }

  it("심사 중·정지 사업장, 중지 상품, 마감·취소 회차, 예약 마감이 지난 회차는 목록에 나오지 않는다", async () => {
    const { visibleSlot } = await hiddenAndVisible();
    expect(await list()).toEqual([visibleSlot.id]);
    expect(await list({ availableOnly: true, when: "week" })).toEqual([visibleSlot.id]);
  });

  it("홈 피드·사이트맵·추천·다음 회차도 같은 규칙을 쓴다", async () => {
    const { visible, visibleSlot, pending, paused } = await hiddenAndVisible();

    const feed = await getHomeFeed();
    expect(feed.tomorrow.map((c) => c.slotId)).toEqual([visibleSlot.id]);
    expect(feed.today).toEqual([]);
    expect(feed.dayCounts.reduce((sum, d) => sum + d.openCount, 0)).toBe(1);
    expect(feed.categoryCounts.reduce((sum, c) => sum + c.openCount, 0)).toBe(1);

    const sitemap = await getSitemapEntries();
    expect(sitemap.slots.map((s) => s.slotId)).toEqual([visibleSlot.id]);
    // 승인된 사업장만: 보이는 가게와 중지 상품의 가게(사업장 자체는 승인 상태)
    expect(sitemap.businesses.map((b) => b.slug).sort()).toEqual([visible.business.slug, paused.business.slug].sort());

    const suggestions = await searchSuggest("모임");
    expect(suggestions.map((s) => s.label)).toEqual(["보이는 모임"]);
    expect(await searchSuggest("심사 중 가게")).toEqual([]);

    const next = await listNextVacancyCards("product", [visible.product.id, pending.product.id, paused.product.id], 3);
    expect([...next.keys()]).toEqual([visible.product.id]);
    expect(next.get(visible.product.id)?.map((c) => c.slotId)).toEqual([visibleSlot.id]);
  });
});

// ── 검색 조건 ─────────────────────────────────────────

describe("listVacancies — 조건", () => {
  it("검색어는 제목·요약·태그·사업장·분류·동네 이름에서 대소문자 구분 없이 찾고, 여러 낱말은 모두 들어 있어야 한다", async () => {
    const tomorrow = kstDate(2026, 12, 3, 19, 0);
    const a = await setup({
      product: { title: "Wine 로테이션 소개팅", summary: "처음 만나는 4:4 자리", tags: ["와인", "직장인"] },
      business: { name: "연결고리 라운지" },
      category: { name: "소개팅" },
      area: { name: "둔산동", district: "서구" },
    });
    const b = await setup({
      product: { title: "보드게임 번개", summary: null, tags: ["보드게임"] },
      business: { name: "주사위 카페" },
      category: { name: "소셜 모임" },
      area: { name: "봉명동", district: "유성구" },
    });
    const slotA = await slotAt(a.product, tomorrow);
    const slotB = await slotAt(b.product, tomorrow);

    expect(await list({ q: "wine" })).toEqual([slotA.id]);
    expect(await list({ q: "WINE" })).toEqual([slotA.id]);
    expect(await list({ q: "4:4" })).toEqual([slotA.id]);
    expect(await list({ q: "직장인" })).toEqual([slotA.id]);
    expect(await list({ q: "주사위" })).toEqual([slotB.id]);
    expect(await list({ q: "소셜" })).toEqual([slotB.id]);
    expect(await list({ q: "봉명동" })).toEqual([slotB.id]);
    expect(await list({ q: "유성구" })).toEqual([slotB.id]);
    expect(await list({ q: "둔산동 wine" })).toEqual([slotA.id]);
    expect(await list({ q: "둔산동 보드게임" })).toEqual([]);
    expect((await list({ q: "   " })).sort()).toEqual([slotA.id, slotB.id].sort());
    expect(await list({ q: "없는말" })).toEqual([]);
  });

  it("검색어의 %, _, \\ 는 와일드카드가 아니라 글자 그대로 찾는다", async () => {
    const tomorrow = kstDate(2026, 12, 3, 19, 0);
    const percent = await setup({ product: { title: "100% 수제 디저트 모임" } });
    const underscore = await setup({ product: { title: "a_b 스터디" } });
    const plain = await setup({ product: { title: "axb 스터디" } });
    const backslash = await setup({ product: { title: "역슬래시 \\ 모임" } });
    const [p, u, x, bs] = await Promise.all([
      slotAt(percent.product, tomorrow),
      slotAt(underscore.product, tomorrow),
      slotAt(plain.product, tomorrow),
      slotAt(backslash.product, tomorrow),
    ]);

    expect(await list({ q: "%" })).toEqual([p.id]);
    expect(await list({ q: "100%" })).toEqual([p.id]);
    expect(await list({ q: "_" })).toEqual([u.id]);
    expect(await list({ q: "a_b" })).toEqual([u.id]);
    expect(await list({ q: "axb" })).toEqual([x.id]);
    expect(await list({ q: "\\" })).toEqual([bs.id]);
    expect(await list({ q: "%%" })).toEqual([]);

    expect((await searchSuggest("%")).map((s) => s.label)).toEqual(["100% 수제 디저트 모임"]);
    expect((await searchSuggest("a_b")).map((s) => s.label)).toEqual(["a_b 스터디"]);
    expect(await searchSuggest("_x")).toEqual([]);
  });

  it("분류·동네·구로 좁힌다(상품에 장소가 있으면 사업장 동네보다 우선)", async () => {
    const tomorrow = kstDate(2026, 12, 3, 19, 0);
    const a = await setup({ category: { slug: "dating" }, area: { slug: "dunsan", name: "둔산동", district: "서구" } });
    const b = await setup({ category: { slug: "social" }, area: { slug: "bongmyeong", name: "봉명동", district: "유성구" } });
    // 사업장은 봉명동이지만 이 상품은 둔산동에서 진행한다
    const elsewhere = await createProduct(b.business.id, b.category.id, { areaId: a.area.id, placeName: "둔산 스튜디오" });
    const slotA = await slotAt(a.product, tomorrow);
    const slotB = await slotAt(b.product, tomorrow);
    const slotC = await slotAt(elsewhere, new Date(tomorrow.getTime() + HOUR_MS));

    expect(await list({ categorySlug: "dating" })).toEqual([slotA.id]);
    expect(await list({ categorySlug: "social" })).toEqual([slotB.id, slotC.id]);
    expect(await list({ areaSlug: "dunsan" })).toEqual([slotA.id, slotC.id]);
    expect(await list({ areaSlug: "bongmyeong" })).toEqual([slotB.id]);
    expect(await list({ district: "서구" })).toEqual([slotA.id, slotC.id]);
    expect(await list({ district: "유성구" })).toEqual([slotB.id]);
    expect(await list({ categorySlug: "social", areaSlug: "dunsan" })).toEqual([slotC.id]);

    const card = (await listVacancies({ areaSlug: "dunsan", categorySlug: "social" })).items[0]!;
    expect(card.area).toEqual({ slug: "dunsan", name: "둔산동", district: "서구" });
    expect(card.placeName).toBe("둔산 스튜디오");
    // 상품에 장소 이름이 없으면 사업장 이름이 장소 이름이다
    expect((await listVacancies({ categorySlug: "dating" })).items[0]!.placeName).toBe(a.business.name);
  });

  it("when(오늘·내일·주말·7일·전체)과 dateKey 로 날짜를 좁힌다", async () => {
    const { product } = await setup();
    const today = await slotAt(product, kstDate(2026, 12, 2, 19, 0));
    const tomorrow = await slotAt(product, kstDate(2026, 12, 3, 0, 30));
    const friday = await slotAt(product, kstDate(2026, 12, 4, 23, 30));
    const saturday = await slotAt(product, kstDate(2026, 12, 5, 0, 0));
    const sunday = await slotAt(product, kstDate(2026, 12, 6, 23, 0));
    const nextTuesday = await slotAt(product, kstDate(2026, 12, 8, 23, 59));
    const nextWednesday = await slotAt(product, kstDate(2026, 12, 9, 0, 0));

    expect(await list({ when: "today" })).toEqual([today.id]);
    expect(await list({ when: "tomorrow" })).toEqual([tomorrow.id]);
    expect(await list({ when: "weekend" })).toEqual([saturday.id, sunday.id]);
    expect(await list({ when: "week" })).toEqual([today.id, tomorrow.id, friday.id, saturday.id, sunday.id, nextTuesday.id]);
    const all = [today.id, tomorrow.id, friday.id, saturday.id, sunday.id, nextTuesday.id, nextWednesday.id];
    expect(await list({ when: "all" })).toEqual(all);
    expect(await list()).toEqual(all);
    expect(await list({ dateKey: "2026-12-04" })).toEqual([friday.id]);
    expect(await list({ dateKey: "2026-12-09" })).toEqual([nextWednesday.id]);
    // dateKey 가 when 보다 우선한다
    expect(await list({ dateKey: "2026-12-06", when: "today" })).toEqual([sunday.id]);

    expect((await failure(listVacancies({ dateKey: "2026-13-40" }))).code).toBe("VALIDATION");
    expect((await failure(listVacancies({ dateKey: "12/04" }))).code).toBe("VALIDATION");
  });

  it("timeBand 는 KST 시작 시각으로 나눈다(아침 06-12 · 낮 12-17 · 저녁 17-21 · 밤 21-06 · 퇴근 후 18-22)", async () => {
    const { product } = await setup();
    const at = async (hour: number, minute: number) => (await slotAt(product, kstDate(2026, 12, 3, hour, minute))).id;
    const h0200 = await at(2, 0);
    const h0559 = await at(5, 59);
    const h0600 = await at(6, 0);
    const h0900 = await at(9, 0);
    const h1200 = await at(12, 0);
    const h1400 = await at(14, 0);
    const h1700 = await at(17, 0);
    const h1830 = await at(18, 30);
    const h1930 = await at(19, 30);
    const h2100 = await at(21, 0);
    const h2130 = await at(21, 30);
    const h2200 = await at(22, 0);

    expect(await list({ timeBand: "morning" })).toEqual([h0600, h0900]);
    expect(await list({ timeBand: "afternoon" })).toEqual([h1200, h1400]);
    expect(await list({ timeBand: "evening" })).toEqual([h1700, h1830, h1930]);
    expect(await list({ timeBand: "night" })).toEqual([h0200, h0559, h2100, h2130, h2200]);
    expect(await list({ timeBand: "afterwork" })).toEqual([h1830, h1930, h2100, h2130]);
  });

  it("가격 범위는 예약할 수 있는 좌석의 가격으로 본다(매진 회차는 어느 좌석이든)", async () => {
    const { product } = await setup();
    const t = kstDate(2026, 12, 3, 19, 0);
    const cheap = await slotAt(product, t, [{ capacity: 2, price: 10000 }]);
    const mid = await slotAt(product, new Date(t.getTime() + HOUR_MS), [{ capacity: 2, price: 30000 }]);
    // 싼 좌석은 매진, 비싼 좌석만 남음
    const mixed = await slotAt(product, new Date(t.getTime() + 2 * HOUR_MS), [
      { label: "얼리버드", capacity: 2, price: 10000 },
      { label: "일반", capacity: 2, price: 50000 },
    ]);
    await reserve(mixed.seats[0]!.id, 2);
    const soldOut = await slotAt(product, new Date(t.getTime() + 3 * HOUR_MS), [{ capacity: 2, price: 20000 }]);
    await reserve(soldOut.seats[0]!.id, 2);

    expect(await list({ maxPrice: 10000 })).toEqual([cheap.id]);
    expect(await list({ maxPrice: 30000 })).toEqual([cheap.id, mid.id, soldOut.id]);
    expect(await list({ minPrice: 30000 })).toEqual([mid.id, mixed.id]);
    expect(await list({ minPrice: 15000, maxPrice: 25000 })).toEqual([soldOut.id]);
    expect(await list({ minPrice: 15000, maxPrice: 25000, availableOnly: true })).toEqual([]);
    expect(await list({ minPrice: 40000, maxPrice: 60000 })).toEqual([mixed.id]);
    expect((await failure(listVacancies({ minPrice: -1 }))).code).toBe("VALIDATION");
  });

  it("seatGender 는 그 성별이 예약할 수 있는 좌석(전용 또는 누구나)이 남아 있는 회차만 남긴다", async () => {
    const { product } = await setup();
    const t = kstDate(2026, 12, 3, 19, 0);
    const pair: SeatSpec[] = [
      { label: "남성", gender: "MALE", capacity: 4 },
      { label: "여성", gender: "FEMALE", capacity: 4 },
    ];
    const both = await slotAt(product, t, pair);
    const femaleFull = await slotAt(product, new Date(t.getTime() + HOUR_MS), pair);
    await reserve(femaleFull.seats[1]!.id, 4);
    const maleFull = await slotAt(product, new Date(t.getTime() + 2 * HOUR_MS), pair);
    await reserve(maleFull.seats[0]!.id, 4);
    const anyone = await slotAt(product, new Date(t.getTime() + 3 * HOUR_MS), [{ label: "일반", gender: "ANY", capacity: 4 }]);
    const allFull = await slotAt(product, new Date(t.getTime() + 4 * HOUR_MS), pair);
    await reserve(allFull.seats[0]!.id, 4);
    await reserve(allFull.seats[1]!.id, 4);

    expect(await list({ seatGender: "FEMALE" })).toEqual([both.id, maleFull.id, anyone.id]);
    expect(await list({ seatGender: "MALE" })).toEqual([both.id, femaleFull.id, anyone.id]);
    // 조건이 없으면 매진 회차도 맨 뒤에 나온다
    expect(await list()).toEqual([both.id, femaleFull.id, maleFull.id, anyone.id, allFull.id]);
  });

  it("seatGender 와 가격 조건은 같은 좌석이 함께 만족해야 한다", async () => {
    const { product } = await setup();
    const slot = await slotAt(product, kstDate(2026, 12, 3, 19, 0), [
      { label: "남성", gender: "MALE", capacity: 4, price: 40000 },
      { label: "여성", gender: "FEMALE", capacity: 4, price: 20000 },
    ]);
    expect(await list({ seatGender: "FEMALE", maxPrice: 30000 })).toEqual([slot.id]);
    expect(await list({ seatGender: "MALE", maxPrice: 30000 })).toEqual([]);
  });

  it("forMe 는 보는 사람이 지금 예약할 수 있는 회차만 남긴다(성별·나이·남은 자리)", async () => {
    const t = kstDate(2026, 12, 3, 19, 0);
    const open = await setup();
    const aged = await setup({ product: { minAge: 35, maxAge: 45 } });
    const young = await setup({ product: { minAge: 25, maxAge: 33 } });
    const pair: SeatSpec[] = [
      { label: "남성", gender: "MALE", capacity: 4 },
      { label: "여성", gender: "FEMALE", capacity: 4 },
    ];
    const both = await slotAt(open.product, t, pair);
    const femaleFull = await slotAt(open.product, new Date(t.getTime() + HOUR_MS), pair);
    await reserve(femaleFull.seats[1]!.id, 4);
    const anyone = await slotAt(open.product, new Date(t.getTime() + 2 * HOUR_MS), [{ gender: "ANY", capacity: 4 }]);
    const tooOldFor = await slotAt(young.product, new Date(t.getTime() + 3 * HOUR_MS), pair);
    const tooYoungFor = await slotAt(aged.product, new Date(t.getTime() + 4 * HOUR_MS), pair);
    const soldOut = await slotAt(open.product, new Date(t.getTime() + 5 * HOUR_MS), [{ gender: "ANY", capacity: 2 }]);
    await reserve(soldOut.seats[0]!.id, 2);
    const everything = [both.id, femaleFull.id, anyone.id, tooOldFor.id, tooYoungFor.id, soldOut.id];

    // 1992년생 여성: 2026년 기준 34세
    const woman = { id: "viewer-1", gender: "FEMALE" as const, birthYear: 1992 };
    expect(ageOf(1992, NOW)).toBe(34);
    const mine = await listVacancies({ forMe: true }, woman);
    expect(mine.forMeApplied).toBe(true);
    expect(ids(mine)).toEqual([both.id, anyone.id]);

    // 1990년생 남성(36세): 35~45세 모임은 되고 25~33세 모임은 안 된다
    const man = { id: "viewer-2", gender: "MALE" as const, birthYear: 1990 };
    expect(await list({ forMe: true }, man)).toEqual([both.id, femaleFull.id, anyone.id, tooYoungFor.id]);

    // 성별만 아는 회원: 나이 조건은 보지 않는다
    expect(await list({ forMe: true }, { id: "viewer-3", gender: "FEMALE", birthYear: null })).toEqual([
      both.id,
      anyone.id,
      tooOldFor.id,
      tooYoungFor.id,
    ]);
    // 출생 연도만 아는 회원: 성별 조건은 보지 않는다
    expect(await list({ forMe: true }, { id: "viewer-4", gender: null, birthYear: 1992 })).toEqual([both.id, femaleFull.id, anyone.id]);

    // 비로그인이거나 성별·출생 연도가 없으면 적용하지 않는다
    const anonymous = await listVacancies({ forMe: true });
    expect(anonymous.forMeApplied).toBe(false);
    expect(ids(anonymous)).toEqual(everything);
    const unknown = await listVacancies({ forMe: true }, { id: "viewer-5", gender: null, birthYear: null });
    expect(unknown.forMeApplied).toBe(false);
    expect(ids(unknown)).toEqual(everything);
    // forMe 를 켜지 않으면 회원 정보가 있어도 거르지 않는다
    expect(await list({}, woman)).toEqual(everything);
  });

  it("origin 과 discountedOnly", async () => {
    const { product } = await setup();
    const t = kstDate(2026, 12, 3, 19, 0);
    const regular = await slotAt(product, t, [{ capacity: 4, price: 30000 }]);
    const cancelled = await slotAt(product, new Date(t.getTime() + HOUR_MS), [{ capacity: 4, price: 25000, originalPrice: 30000 }], {
      origin: "CANCELLATION",
    });
    const noShow = await slotAt(product, new Date(t.getTime() + 2 * HOUR_MS), [{ capacity: 4 }], { origin: "NO_SHOW" });
    const unsold = await slotAt(
      product,
      new Date(t.getTime() + 3 * HOUR_MS),
      [
        { label: "할인석", capacity: 2, price: 20000, originalPrice: 30000 },
        { label: "일반석", capacity: 2, price: 30000 },
      ],
      { origin: "UNSOLD" },
    );
    await reserve(unsold.seats[0]!.id, 2);
    // 정가가 판매가보다 높지 않으면 할인이 아니다
    const fake = await slotAt(product, new Date(t.getTime() + 4 * HOUR_MS), [{ capacity: 4, price: 30000, originalPrice: 30000 }]);

    expect(await list({ origin: "REGULAR" })).toEqual([regular.id, fake.id]);
    expect(await list({ origin: "CANCELLATION" })).toEqual([cancelled.id]);
    expect(await list({ origin: "NO_SHOW" })).toEqual([noShow.id]);
    expect(await list({ origin: "UNSOLD" })).toEqual([unsold.id]);
    // 할인 좌석이 남아 있는 회차만(할인석이 매진된 회차는 빠진다)
    expect(await list({ discountedOnly: true })).toEqual([cancelled.id]);

    const page = await listVacancies();
    const byId = new Map(page.items.map((item) => [item.slotId, item]));
    expect(byId.get(cancelled.id)).toMatchObject({ minPrice: 25000, minOriginalPrice: 30000, origin: "CANCELLATION" });
    // 남은 좌석 기준 최저가는 정가 좌석이므로 정가 표시가 없다
    expect(byId.get(unsold.id)).toMatchObject({ minPrice: 30000, minOriginalPrice: null });
    expect(byId.get(unsold.id)?.seats[0]).toMatchObject({ price: 20000, originalPrice: 30000, remaining: 0 });
    expect(byId.get(fake.id)?.seats[0]?.originalPrice).toBeNull();
    expect(byId.get(fake.id)?.minOriginalPrice).toBeNull();
  });

  it("매진 회차는 예약 가능한 회차 뒤에 나오고, availableOnly 면 빠진다", async () => {
    const { product } = await setup();
    const t = kstDate(2026, 12, 3, 12, 0);
    const soldOutEarly = await slotAt(product, t, [{ capacity: 2 }]);
    await reserve(soldOutEarly.seats[0]!.id, 2);
    const openLate = await slotAt(product, new Date(t.getTime() + 5 * HOUR_MS));
    const openLater = await slotAt(product, new Date(t.getTime() + 6 * HOUR_MS));
    // 보류(withheld) 좌석은 reserved 에 들어 있어 고객에게는 매진이다
    const withheldOnly = await slotAt(product, new Date(t.getTime() + HOUR_MS), [{ capacity: 3 }]);
    await reserve(withheldOnly.seats[0]!.id, 3, 1);

    expect(await list()).toEqual([openLate.id, openLater.id, soldOutEarly.id, withheldOnly.id]);
    expect(await list({ availableOnly: true })).toEqual([openLate.id, openLater.id]);

    const page = await listVacancies();
    const soldOutCard = page.items.find((item) => item.slotId === withheldOnly.id)!;
    expect(soldOutCard.totalRemaining).toBe(0);
    expect(soldOutCard.totalCapacity).toBe(3);
  });

  it("입력 검증: 긴 검색어·모르는 정렬·범위를 넘는 limit 은 거절한다", async () => {
    expect((await failure(listVacancies({ q: "가".repeat(41) }))).code).toBe("VALIDATION");
    expect((await failure(listVacancies({ sort: "discount" as never }))).code).toBe("VALIDATION");
    expect((await failure(listVacancies({ limit: 51 }))).code).toBe("VALIDATION");
    expect((await failure(listVacancies({ limit: 0 }))).code).toBe("VALIDATION");
    expect((await failure(listVacancies({ cursor: "엉뚱한 값" }))).code).toBe("VALIDATION");
    // 할인율순 정렬은 만들지 않는다
    expect(VACANCY_SORTS).toEqual(["soon", "new", "price", "deadline"]);
  });

  it("parseVacancyFilters 는 주소의 검색 조건에서 올바른 값만 남긴다", () => {
    expect(
      parseVacancyFilters({
        q: `  ${"와".repeat(50)}  `,
        category: "dating",
        area: ["dunsan", "other"],
        when: "weekend",
        date: "2026-12-05",
        time: "afterwork",
        min: "10000",
        max: "abc",
        gender: "FEMALE",
        me: "1",
        origin: "CANCELLATION",
        discounted: "true",
        available: "0",
        sort: "price",
      }),
    ).toEqual({
      q: "와".repeat(40),
      categorySlug: "dating",
      areaSlug: "dunsan",
      when: "weekend",
      dateKey: "2026-12-05",
      timeBand: "afterwork",
      minPrice: 10000,
      seatGender: "FEMALE",
      forMe: true,
      origin: "CANCELLATION",
      discountedOnly: true,
      sort: "price",
    });
    expect(parseVacancyFilters({ when: "someday", date: "2026-02-31", time: "dawn", gender: "ANY", sort: "discount", q: "" })).toEqual({});
  });
});

// ── 정렬 · 쪽 넘김 ────────────────────────────────────

describe("listVacancies — 정렬과 커서", () => {
  it("정렬: 시작 빠른 순(기본)·최근에 나온 순·싼 순·예약 마감 빠른 순", async () => {
    const { product } = await setup();
    const t = kstDate(2026, 12, 3, 19, 0);
    const a = await slotAt(product, t, [{ capacity: 2, price: 30000 }], {
      vacancyPostedAt: new Date(NOW.getTime() - 3 * HOUR_MS),
      bookingDeadlineAt: new Date(t.getTime() - 5 * HOUR_MS),
    });
    const b = await slotAt(
      product,
      new Date(t.getTime() + HOUR_MS),
      [
        { label: "얼리버드", capacity: 2, price: 10000 },
        { label: "일반", capacity: 2, price: 40000 },
      ],
      { vacancyPostedAt: new Date(NOW.getTime() - HOUR_MS), bookingDeadlineAt: new Date(t.getTime() - 6 * HOUR_MS) },
    );
    // 가장 싼 좌석은 매진 → 가격 정렬 기준은 남은 좌석 중 최저가(40,000원)
    await reserve(b.seats[0]!.id, 2);
    const c = await slotAt(product, new Date(t.getTime() + 2 * HOUR_MS), [{ capacity: 2, price: 20000 }], {
      vacancyPostedAt: new Date(NOW.getTime() - 2 * HOUR_MS),
      bookingDeadlineAt: new Date(t.getTime() - 4 * HOUR_MS),
    });
    // 매진 회차는 어떤 정렬에서도 맨 뒤
    const d = await slotAt(product, new Date(t.getTime() - HOUR_MS), [{ capacity: 2, price: 5000 }], {
      vacancyPostedAt: new Date(NOW.getTime() - 60_000),
      bookingDeadlineAt: new Date(t.getTime() - 7 * HOUR_MS),
    });
    await reserve(d.seats[0]!.id, 2);

    expect(await list({ sort: "soon" })).toEqual([a.id, b.id, c.id, d.id]);
    expect(await list()).toEqual([a.id, b.id, c.id, d.id]);
    expect(await list({ sort: "new" })).toEqual([b.id, c.id, a.id, d.id]);
    expect(await list({ sort: "price" })).toEqual([c.id, a.id, b.id, d.id]);
    expect(await list({ sort: "deadline" })).toEqual([b.id, a.id, c.id, d.id]);

    const cards = new Map((await listVacancies()).items.map((item) => [item.slotId, item]));
    expect(cards.get(b.id)?.minPrice).toBe(40000);
    expect(cards.get(d.id)?.minPrice).toBe(5000);
  });

  it("같은 시작 시각의 회차가 많아도 쪽을 넘길 때 겹치거나 빠지지 않는다(모든 정렬)", async () => {
    const { product } = await setup();
    const sameStart = kstDate(2026, 12, 3, 19, 0);
    const samePosted = new Date(NOW.getTime() - HOUR_MS);
    const created: string[] = [];
    for (let i = 0; i < 23; i++) {
      const slot = await slotAt(product, sameStart, [{ capacity: 2, price: 30000 }], { vacancyPostedAt: samePosted });
      // 다섯 개는 매진
      if (i % 5 === 0) await reserve(slot.seats[0]!.id, 2);
      created.push(slot.id);
    }
    for (let i = 0; i < 4; i++) {
      const slot = await slotAt(product, new Date(sameStart.getTime() + (i + 1) * HOUR_MS), [{ capacity: 2, price: 10000 * (i + 1) }], {
        vacancyPostedAt: new Date(samePosted.getTime() + (i + 1) * 60_000),
      });
      created.push(slot.id);
    }

    for (const sort of VACANCY_SORTS) {
      const full = await list({ sort, limit: 50 });
      expect(full).toHaveLength(created.length);
      expect(new Set(full).size).toBe(created.length);

      const paged: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await listVacancies({ sort, limit: 5, cursor });
        expect(page.items.length).toBeLessThanOrEqual(5);
        paged.push(...ids(page));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 20);
      expect(paged, `${sort} 정렬의 쪽 넘김 결과`).toEqual(full);
    }

    // 마지막 쪽이 꽉 차도 다음 커서는 없다
    const exact = await listVacancies({ limit: created.length });
    expect(exact.nextCursor).toBeNull();
    // 다른 정렬에서 받은 커서는 쓸 수 없다
    const first = await listVacancies({ sort: "price", limit: 5 });
    expect((await failure(listVacancies({ sort: "soon", limit: 5, cursor: first.nextCursor! }))).code).toBe("VALIDATION");
  });

  it("한 쪽을 불러오는 데 쿼리 두 번이면 된다(N+1 없음)", async () => {
    const { product } = await setup();
    for (let i = 0; i < 12; i++) {
      await slotAt(product, kstDate(2026, 12, 3, 10 + i, 0), [
        { label: "남성", gender: "MALE", capacity: 4 },
        { label: "여성", gender: "FEMALE", capacity: 4 },
      ]);
    }
    const viewer = await createUser();
    const spy = vi.spyOn(prisma, "$queryRaw");
    const page = await listVacancies({ limit: 10 }, viewer);
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// ── 카드 내용 ─────────────────────────────────────────

describe("자리 카드", () => {
  it("좌석별 남은 자리·대기 수와 합계, 찜 여부를 담는다", async () => {
    const { product, business, category, area } = await setup({
      product: { title: "와인 소개팅", summary: "4:4 로테이션", images: ["/uploads/a.webp", "/uploads/b.webp"], tags: ["와인"], minAge: 25, maxAge: 39 },
      area: { slug: "dunsan", name: "둔산동", district: "서구" },
    });
    const slot = await slotAt(
      product,
      kstDate(2026, 12, 3, 19, 30),
      [
        { label: "남성", gender: "MALE", capacity: 4, price: 39000 },
        { label: "여성", gender: "FEMALE", capacity: 4, price: 35000, originalPrice: 39000 },
      ],
      { note: "주차는 건물 뒤편에 할 수 있어요", origin: "CANCELLATION" },
    );
    await reserve(slot.seats[0]!.id, 4, 1);
    await reserve(slot.seats[1]!.id, 1);
    const [w1, w2, w3, viewer] = await Promise.all([createUser(), createUser(), createUser(), createUser()]);
    await prisma.waitlistEntry.createMany({
      data: [
        { userId: w1.id, slotId: slot.id, slotSeatId: slot.seats[0]!.id, status: "WAITING" },
        { userId: w2.id, slotId: slot.id, slotSeatId: slot.seats[0]!.id, status: "WAITING" },
        // 제안 중·취소한 대기는 세지 않는다
        { userId: w3.id, slotId: slot.id, slotSeatId: slot.seats[0]!.id, status: "OFFERED", offerExpiresAt: new Date(NOW.getTime() + HOUR_MS) },
        { userId: viewer.id, slotId: slot.id, slotSeatId: slot.seats[0]!.id, status: "CANCELLED" },
      ],
    });
    await prisma.favorite.create({ data: { userId: viewer.id, productId: product.id } });

    const [card] = (await listVacancies({}, viewer)).items;
    expect(card).toEqual({
      slotId: slot.id,
      startAt: slot.startAt,
      endAt: slot.endAt,
      bookingDeadlineAt: slot.bookingDeadlineAt,
      origin: "CANCELLATION",
      note: "주차는 건물 뒤편에 할 수 있어요",
      vacancyPostedAt: slot.vacancyPostedAt,
      product: {
        id: product.id,
        title: "와인 소개팅",
        summary: "4:4 로테이션",
        image: "/uploads/a.webp",
        tags: ["와인"],
        durationMin: 120,
        minAge: 25,
        maxAge: 39,
        requiresApproval: false,
        isDemo: false,
      },
      category: { slug: category.slug, name: category.name, icon: category.icon },
      business: { slug: business.slug, name: business.name, ratingAvg: 0, ratingCount: 0 },
      area: { slug: area.slug, name: "둔산동", district: "서구" },
      placeName: business.name,
      seats: [
        { id: slot.seats[0]!.id, label: "남성", gender: "MALE", capacity: 4, remaining: 0, price: 39000, originalPrice: null, waitingCount: 2 },
        { id: slot.seats[1]!.id, label: "여성", gender: "FEMALE", capacity: 4, remaining: 3, price: 35000, originalPrice: 39000, waitingCount: 0 },
      ],
      totalRemaining: 3,
      totalCapacity: 8,
      minPrice: 35000,
      minOriginalPrice: 39000,
      waitingCount: 2,
      go: { state: "NONE", needs: [], decideAt: null },
      isFavorite: true,
    });

    // 비로그인이면 찜 여부 키가 없다
    const [anonymous] = (await listVacancies()).items;
    expect(anonymous && "isFavorite" in anonymous).toBe(false);
    const [other] = (await listVacancies({}, await createUser())).items;
    expect(other?.isFavorite).toBe(false);
  });

  it("남은 자리는 capacity − reserved 이고 음수가 되지 않는다", async () => {
    const { product } = await setup();
    const cases = [
      { capacity: 6, reserved: 0, withheld: 0 },
      { capacity: 6, reserved: 2, withheld: 2 },
      { capacity: 6, reserved: 5, withheld: 0 },
      { capacity: 6, reserved: 6, withheld: 3 },
      { capacity: 0, reserved: 0, withheld: 0 },
    ];
    const slot = await slotAt(
      product,
      kstDate(2026, 12, 3, 19, 0),
      cases.map((c, i) => ({ label: `유형${i}`, capacity: c.capacity })),
    );
    await Promise.all(cases.map((c, i) => reserve(slot.seats[i]!.id, c.reserved, c.withheld)));

    const [card] = (await listVacancies()).items;
    expect(card!.seats.map((s) => s.remaining)).toEqual(cases.map((c) => c.capacity - c.reserved));
    for (const seat of card!.seats) expect(seat.remaining).toBeGreaterThanOrEqual(0);
    expect(card!.totalRemaining).toBe(11);

    const availability = await getSlotAvailability(slot.id);
    expect(availability?.seats).toEqual(cases.map((c, i) => ({ id: slot.seats[i]!.id, remaining: c.capacity - c.reserved })));
    const detail = await getSlotDetail(slot.id);
    expect(detail?.seats.map((s) => s.remaining)).toEqual(cases.map((c) => c.capacity - c.reserved));
  });

  it("개최 확정 상태: 조건 없음 · 모으는 중(더 필요한 인원) · 확정", async () => {
    const { product } = await setup();
    const pair: SeatSpec[] = [
      { label: "남성", gender: "MALE", capacity: 4 },
      { label: "여성", gender: "FEMALE", capacity: 4 },
    ];
    const t = kstDate(2026, 12, 5, 19, 0);
    const decideAt = kstDate(2026, 12, 4, 19, 0);
    const withMin = async (startAt: Date, extra: Partial<Prisma.SlotUncheckedCreateInput> = {}) => {
      const slot = await slotAt(product, startAt, pair, { decideAt, ...extra });
      await prisma.slotSeat.updateMany({ where: { slotId: slot.id }, data: { minCount: 2 } });
      return slot;
    };

    const none = await slotAt(product, t, pair);
    const gathering = await withMin(new Date(t.getTime() + HOUR_MS));
    const users = await Promise.all(Array.from({ length: 7 }, () => createUser()));
    // 남성: 확정 2명(1건 2명) → 충족. 여성: 확정 1명 + 결제 대기·승인 대기·취소·노쇼는 세지 않음 → 1명 부족
    await createBooking(gathering, gathering.seats[0]!.id, users[0]!.id, "CONFIRMED", { quantity: 2 });
    await createBooking(gathering, gathering.seats[1]!.id, users[1]!.id, "CONFIRMED");
    await createBooking(gathering, gathering.seats[1]!.id, users[2]!.id, "PENDING_PAYMENT");
    await createBooking(gathering, gathering.seats[1]!.id, users[3]!.id, "PENDING_APPROVAL");
    await createBooking(gathering, gathering.seats[1]!.id, users[4]!.id, "CANCELLED");
    await createBooking(gathering, gathering.seats[1]!.id, users[5]!.id, "NO_SHOW");

    const empty = await withMin(new Date(t.getTime() + 2 * HOUR_MS));
    const confirmed = await withMin(new Date(t.getTime() + 3 * HOUR_MS), { goConfirmedAt: new Date(NOW.getTime() - HOUR_MS) });
    // 이용 완료(COMPLETED)도 확정 인원이다. 직접 입력(회원 없음) 예약도 센다.
    const met = await withMin(new Date(t.getTime() + 4 * HOUR_MS));
    await createBooking(met, met.seats[0]!.id, users[6]!.id, "COMPLETED", { quantity: 2 });
    await createBooking(met, met.seats[1]!.id, null, "CONFIRMED", { quantity: 2, channel: "MANUAL" });

    const cards = new Map((await listVacancies({ limit: 50 })).items.map((item) => [item.slotId, item.go]));
    expect(cards.get(none.id)).toEqual({ state: "NONE", needs: [], decideAt: null });
    expect(cards.get(gathering.id)).toEqual({
      state: "GATHERING",
      needs: [{ label: "여성", gender: "FEMALE", remaining: 1 }],
      decideAt,
    });
    expect(cards.get(empty.id)).toEqual({
      state: "GATHERING",
      needs: [
        { label: "남성", gender: "MALE", remaining: 2 },
        { label: "여성", gender: "FEMALE", remaining: 2 },
      ],
      decideAt,
    });
    expect(cards.get(confirmed.id)).toEqual({ state: "CONFIRMED", needs: [], decideAt });
    // 인원은 찼지만 확정 기록(goConfirmedAt)이 아직 없으면 확정으로 보여 주지 않는다
    expect(cards.get(met.id)).toEqual({ state: "GATHERING", needs: [], decideAt });

    expect((await getSlotDetail(gathering.id))?.go).toEqual(cards.get(gathering.id));
  });
});

// ── 홈 피드 ───────────────────────────────────────────

describe("getHomeFeed", () => {
  async function seed() {
    const dating = await setup({ category: { slug: "dating", name: "소개팅", sort: 1 }, area: { slug: "dunsan" } });
    const social = await setup({ category: { slug: "social", name: "소셜 모임", sort: 2 }, area: { slug: "bongmyeong", name: "봉명동", district: "유성구" } });
    await createCategory({ slug: "empty", name: "원데이 클래스", sort: 3 });
    await createCategory({ slug: "off", name: "숨긴 분류", sort: 4, isActive: false });

    const todayOpen = await slotAt(dating.product, kstDate(2026, 12, 2, 19, 0), [{ capacity: 4 }]);
    await reserve(todayOpen.seats[0]!.id, 1);
    const todaySoldOut = await slotAt(dating.product, kstDate(2026, 12, 2, 18, 0), [{ capacity: 2 }]);
    await reserve(todaySoldOut.seats[0]!.id, 2);
    const tomorrow = await slotAt(social.product, kstDate(2026, 12, 3, 19, 0), [{ capacity: 5 }]);
    const saturday = await slotAt(dating.product, kstDate(2026, 12, 5, 15, 0));
    const sunday = await slotAt(social.product, kstDate(2026, 12, 6, 11, 0));
    const later = await slotAt(dating.product, kstDate(2026, 12, 10, 19, 0));
    const cancelledSeat = await slotAt(dating.product, kstDate(2026, 12, 4, 19, 0), [{ capacity: 4 }], {
      origin: "CANCELLATION",
      vacancyPostedAt: new Date(NOW.getTime() - 5 * 60_000),
    });
    const noShowSeat = await slotAt(social.product, kstDate(2026, 12, 4, 20, 0), [{ capacity: 4 }], {
      origin: "NO_SHOW",
      vacancyPostedAt: new Date(NOW.getTime() - 60_000),
    });
    const releasedButFull = await slotAt(dating.product, kstDate(2026, 12, 4, 21, 0), [{ capacity: 1 }], {
      origin: "CANCELLATION",
      vacancyPostedAt: NOW,
    });
    await reserve(releasedButFull.seats[0]!.id, 1);
    return { dating, social, todayOpen, todaySoldOut, tomorrow, saturday, sunday, later, cancelledSeat, noShowSeat, releasedButFull };
  }

  it("구역별 자리와 집계를 실제 데이터로 채운다", async () => {
    const s = await seed();
    const feed = await getHomeFeed();

    // 방금 나온 자리: 취소·노쇼 공석 중 예약 가능한 것만, 최근에 나온 순
    expect(feed.justReleased.map((c) => c.slotId)).toEqual([s.noShowSeat.id, s.cancelledSeat.id]);
    // 오늘: 예약 가능한 자리가 먼저, 매진은 뒤
    expect(feed.today.map((c) => c.slotId)).toEqual([s.todayOpen.id, s.todaySoldOut.id]);
    expect(feed.tomorrow.map((c) => c.slotId)).toEqual([s.tomorrow.id]);
    expect(feed.weekend.map((c) => c.slotId)).toEqual([s.saturday.id, s.sunday.id]);
    // 모레(12/4) 이후 예약 가능한 회차: 취소석, 노쇼석, 토, 일, 12/10
    expect(feed.laterCount).toBe(5);
    expect(feed.dayCounts).toEqual([
      { dateKey: "2026-12-02", openCount: 1 },
      { dateKey: "2026-12-03", openCount: 1 },
      { dateKey: "2026-12-04", openCount: 2 },
      { dateKey: "2026-12-05", openCount: 1 },
      { dateKey: "2026-12-06", openCount: 1 },
      { dateKey: "2026-12-07", openCount: 0 },
      { dateKey: "2026-12-08", openCount: 0 },
    ]);
    expect(feed.dayCounts[0]?.dateKey).toBe(kstDateKey(NOW));
    // 7일 안에 시작하는 예약 가능한 회차(12/10 은 범위 밖). 활성 분류는 0건이어도 나오고, 숨긴 분류는 빠진다
    expect(feed.categoryCounts.map((c) => [c.slug, c.openCount])).toEqual([
      ["dating", 3],
      ["social", 3],
      ["empty", 0],
    ]);
    expect(feed.stats).toEqual({ openSeatsToday: 3 });
    expect(feed.myOffers).toEqual([]);
    expect(feed.resumableHolds).toEqual([]);
    expectNoPrivateKeys(feed, ["address", "lat", "lng"]);
  });

  it("areaSlug 를 주면 그 동네로 좁힌다", async () => {
    const s = await seed();
    const feed = await getHomeFeed(null, { areaSlug: "bongmyeong" });
    expect(feed.justReleased.map((c) => c.slotId)).toEqual([s.noShowSeat.id]);
    expect(feed.today).toEqual([]);
    expect(feed.tomorrow.map((c) => c.slotId)).toEqual([s.tomorrow.id]);
    expect(feed.weekend.map((c) => c.slotId)).toEqual([s.sunday.id]);
    expect(feed.laterCount).toBe(2);
    expect(feed.stats.openSeatsToday).toBe(0);
    expect(feed.categoryCounts.map((c) => [c.slug, c.openCount])).toEqual([
      ["dating", 0],
      ["social", 3],
      ["empty", 0],
    ]);
  });

  it("구역마다 정해진 개수까지만 담는다", async () => {
    const { product } = await setup();
    for (let i = 0; i < 14; i++) {
      await slotAt(product, kstDate(2026, 12, 3, 8 + i, 0), [{ capacity: 2 }], {
        origin: "CANCELLATION",
        vacancyPostedAt: new Date(NOW.getTime() - i * 60_000),
      });
    }
    const feed = await getHomeFeed();
    expect(feed.tomorrow).toHaveLength(12);
    expect(feed.justReleased).toHaveLength(8);
    expect(feed.dayCounts[1]).toEqual({ dateKey: "2026-12-03", openCount: 14 });
  });

  it("내 자리 제안(myOffers)과 이어서 결제할 예약(resumableHolds)은 본인 것만, 시간이 남은 것만 나온다", async () => {
    const s = await seed();
    const [me, other] = await Promise.all([createUser(), createUser()]);
    const seat = s.todaySoldOut.seats[0]!;
    const offer = await prisma.waitlistEntry.create({
      data: {
        userId: me.id,
        slotId: s.todaySoldOut.id,
        slotSeatId: seat.id,
        status: "OFFERED",
        quantity: 2,
        offeredAt: NOW,
        offerExpiresAt: new Date(NOW.getTime() + 10 * 60_000),
      },
    });
    // 시간이 지난 제안, 아직 대기 중인 신청, 남의 제안, 숨겨진 회차의 제안은 빠진다
    await prisma.waitlistEntry.create({
      data: { userId: me.id, slotId: s.tomorrow.id, slotSeatId: s.tomorrow.seats[0]!.id, status: "OFFERED", offerExpiresAt: new Date(NOW.getTime() - 1000) },
    });
    await prisma.waitlistEntry.create({ data: { userId: me.id, slotId: s.saturday.id, slotSeatId: s.saturday.seats[0]!.id, status: "WAITING" } });
    await prisma.waitlistEntry.create({
      data: { userId: other.id, slotId: s.sunday.id, slotSeatId: s.sunday.seats[0]!.id, status: "OFFERED", offerExpiresAt: new Date(NOW.getTime() + HOUR_MS) },
    });
    const closed = await slotAt(s.dating.product, kstDate(2026, 12, 7, 19, 0), [{ capacity: 2 }], { status: "CLOSED" });
    await prisma.waitlistEntry.create({
      data: { userId: me.id, slotId: closed.id, slotSeatId: closed.seats[0]!.id, status: "OFFERED", offerExpiresAt: new Date(NOW.getTime() + HOUR_MS) },
    });

    const hold = await createBooking(s.later, s.later.seats[0]!.id, me.id, "PENDING_PAYMENT", {
      quantity: 2,
      holdExpiresAt: new Date(NOW.getTime() + 5 * 60_000),
    });
    await createBooking(s.saturday, s.saturday.seats[0]!.id, me.id, "PENDING_PAYMENT", { holdExpiresAt: new Date(NOW.getTime() - 1000) });
    await createBooking(s.sunday, s.sunday.seats[0]!.id, me.id, "CONFIRMED");
    await createBooking(s.tomorrow, s.tomorrow.seats[0]!.id, other.id, "PENDING_PAYMENT", { holdExpiresAt: new Date(NOW.getTime() + HOUR_MS) });

    const feed = await getHomeFeed(me);
    expect(feed.myOffers).toEqual([
      {
        entryId: offer.id,
        slotId: s.todaySoldOut.id,
        seatId: seat.id,
        seatLabel: seat.label,
        seatGender: "ANY",
        quantity: 2,
        price: seat.price,
        originalPrice: null,
        offerExpiresAt: offer.offerExpiresAt,
        startAt: s.todaySoldOut.startAt,
        endAt: s.todaySoldOut.endAt,
        title: s.dating.product.title,
        businessName: s.dating.business.name,
        image: null,
      },
    ]);
    expect(feed.resumableHolds).toEqual([
      {
        code: hold.code,
        slotId: s.later.id,
        title: s.dating.product.title,
        seatLabel: s.later.seats[0]!.label,
        quantity: 2,
        payNowAmount: 60000,
        holdExpiresAt: hold.holdExpiresAt,
        startAt: s.later.startAt,
      },
    ]);
    expectNoPrivateKeys(feed);

    const others = await getHomeFeed(other);
    expect(others.myOffers.map((o) => o.slotId)).toEqual([s.sunday.id]);
    expect(others.resumableHolds.map((h) => h.slotId)).toEqual([s.tomorrow.id]);
  });
});

// ── 자리 상세 ─────────────────────────────────────────

describe("getSlotDetail", () => {
  async function detailFixture() {
    const base = await setup({
      business: {
        name: "연결고리 라운지",
        tagline: "대전에서 가장 편한 소개팅",
        phone: "0421234567",
        address: "대전 서구 대덕대로 1",
        addressDetail: "2층",
        lat: 36.35,
        lng: 127.38,
        representativeName: "김대표",
        businessRegNo: "1234567891",
        mailOrderRegNo: "2026-대전서구-0001",
        bankName: "국민",
        bankAccountEnc: "enc:secret",
        bankAccountLast4: "1234",
        bankHolder: "김대표",
        commissionBps: 500,
        launchPromoRemaining: 10,
      },
      product: {
        title: "와인 로테이션 소개팅",
        summary: "4:4 로테이션",
        description: "처음 만나는 사람들과 와인 한 잔",
        includes: "와인 2잔, 핑거푸드",
        notice: "10분 전까지 와 주세요",
        images: ["/uploads/1.webp", "/uploads/2.webp"],
        tags: ["와인"],
        placeName: "둔산 스튜디오",
        address: "대전 서구 둔산로 123 4층",
        lat: 36.3512,
        lng: 127.3789,
        minAge: 25,
        maxAge: 33,
        requiresIdentity: true,
        requiresApproval: true,
        paymentPolicy: "DEPOSIT",
        depositAmount: 10000,
        maxPerBooking: 2,
        resaleRefundRate: 50,
        cancellationTiers: [...CANCELLATION_PRESETS.FLEXIBLE.tiers],
      },
      area: { slug: "dunsan", name: "둔산동", district: "서구", city: "대전" },
    });
    const slot = await slotAt(base.product, kstDate(2026, 12, 3, 19, 30), [
      { label: "남성", gender: "MALE", capacity: 4, price: 39000 },
      { label: "여성", gender: "FEMALE", capacity: 4, price: 35000 },
    ]);
    return { ...base, slot, male: slot.seats[0]!, female: slot.seats[1]! };
  }

  it("없는 회차, 승인되지 않은 사업장, 판매 중이 아닌 상품은 null", async () => {
    const pending = await setup({ business: { status: "PENDING" } });
    const draft = await setup({ product: { status: "DRAFT" } });
    const pendingSlot = await slotAt(pending.product, kstDate(2026, 12, 3, 19, 0));
    const draftSlot = await slotAt(draft.product, kstDate(2026, 12, 3, 19, 0));

    for (const id of ["없는-회차", "", "x".repeat(100), pendingSlot.id, draftSlot.id]) {
      expect(await getSlotDetail(id)).toBeNull();
      expect(await getSlotAvailability(id)).toBeNull();
      expect(await getShareMeta(id)).toBeNull();
    }
  });

  it("상품·좌석·사업장 정보를 담고, 내부 필드는 담지 않는다", async () => {
    const f = await detailFixture();
    await reserve(f.male.id, 4, 2);
    const guest = await createUser();
    await createBooking(f.slot, f.female.id, guest.id, "CONFIRMED", { requestNote: "창가 자리 부탁해요" });

    const detail = (await getSlotDetail(f.slot.id))!;
    expect(detail.state).toBe("OPEN");
    expect(detail.serverTime).toEqual(NOW);
    expect(detail.product).toEqual({
      id: f.product.id,
      title: "와인 로테이션 소개팅",
      summary: "4:4 로테이션",
      description: "처음 만나는 사람들과 와인 한 잔",
      includes: "와인 2잔, 핑거푸드",
      notice: "10분 전까지 와 주세요",
      images: ["/uploads/1.webp", "/uploads/2.webp"],
      tags: ["와인"],
      durationMin: 120,
      minAge: 25,
      maxAge: 33,
      requiresApproval: true,
      requiresIdentity: true,
      paymentPolicy: "DEPOSIT",
      depositAmount: 10000,
      maxPerBooking: 2,
      resaleRefundRate: 50,
      cancellationTiers: [...CANCELLATION_PRESETS.FLEXIBLE.tiers],
      isDemo: false,
    });
    expect(detail.seats).toEqual([
      { id: f.male.id, label: "남성", gender: "MALE", capacity: 4, remaining: 0, price: 39000, originalPrice: null, waitingCount: 0 },
      { id: f.female.id, label: "여성", gender: "FEMALE", capacity: 4, remaining: 4, price: 35000, originalPrice: null, waitingCount: 0 },
    ]);
    expect(detail).toMatchObject({ totalRemaining: 4, totalCapacity: 8, minPrice: 35000, minOriginalPrice: null, waitingCount: 0 });
    expect(detail.business).toEqual({
      id: f.business.id,
      slug: f.business.slug,
      name: "연결고리 라운지",
      tagline: "대전에서 가장 편한 소개팅",
      logoImage: null,
      ratingAvg: 0,
      ratingCount: 0,
      followerCount: 0,
    });
    expect(detail.viewer).toBeNull();
    expectNoPrivateKeys(detail);
    // 예약자 정보나 요청 사항이 값으로 새어 나가지도 않는다
    const text = JSON.stringify(detail);
    for (const secret of ["예약자본명", "01077778888", "사업자만 보는 메모", "창가 자리", "enc:secret"]) expect(text).not.toContain(secret);
  });

  it("상태: 판매 중 · 예약 마감 · 판매 마감 · 회차 취소 · 종료", async () => {
    const { product } = await setup();
    const open = await slotAt(product, kstDate(2026, 12, 3, 19, 0));
    const deadlinePassed = await slotAt(product, new Date(NOW.getTime() + 30 * 60_000), [{ capacity: 4 }], {
      bookingDeadlineAt: new Date(NOW.getTime() - 60_000),
    });
    // 진행 중(시작했지만 끝나지 않음)인 회차도 예약 마감 상태다
    const inProgress = await slotAt(product, new Date(NOW.getTime() - 30 * 60_000));
    const closed = await slotAt(product, kstDate(2026, 12, 3, 20, 0), [{ capacity: 4 }], { status: "CLOSED" });
    const cancelled = await slotAt(product, kstDate(2026, 12, 3, 21, 0), [{ capacity: 4 }], {
      status: "CANCELLED",
      cancelledAt: NOW,
      cancelReason: "최소 인원 미달",
    });
    const ended = await slotAt(product, new Date(NOW.getTime() - 5 * HOUR_MS));
    const endedClosed = await slotAt(product, new Date(NOW.getTime() - 6 * HOUR_MS), [{ capacity: 4 }], { status: "CLOSED" });
    const endedCancelled = await slotAt(product, new Date(NOW.getTime() - 7 * HOUR_MS), [{ capacity: 4 }], { status: "CANCELLED" });

    const expected: [string, string][] = [
      [open.id, "OPEN"],
      [deadlinePassed.id, "DEADLINE_PASSED"],
      [inProgress.id, "DEADLINE_PASSED"],
      [closed.id, "CLOSED"],
      [cancelled.id, "CANCELLED"],
      [ended.id, "ENDED"],
      [endedClosed.id, "ENDED"],
      [endedCancelled.id, "CANCELLED"],
    ];
    for (const [id, state] of expected) {
      const detail = await getSlotDetail(id);
      expect(detail?.state, id).toBe(state);
      expect(detail?.seats).toHaveLength(1);
      expect((await getSlotAvailability(id))?.state).toBe(state);
      expect((await getShareMeta(id))?.state).toBe(state);
    }
    // 회차 취소 사유 같은 운영 문구는 공개 상세에 싣지 않는다
    expectNoPrivateKeys(await getSlotDetail(cancelled.id), ["cancelReason"]);
    // 같은 상품의 다른 회차: 공개 중이고 자리가 남은 것만(자기 자신 제외)
    expect((await getSlotDetail(cancelled.id))?.otherSlots.map((c) => c.slotId)).toEqual([open.id]);
    expect((await getSlotDetail(open.id))?.otherSlots).toEqual([]);
  });

  it("다른 회차는 자리가 남은 것만 시작 빠른 순으로 6개까지", async () => {
    const { product } = await setup();
    const current = await slotAt(product, kstDate(2026, 12, 3, 10, 0));
    const others: string[] = [];
    for (let i = 0; i < 8; i++) {
      const slot = await slotAt(product, kstDate(2026, 12, 4 + i, 19, 0), [{ capacity: 2 }]);
      if (i === 1) await reserve(slot.seats[0]!.id, 2);
      else others.push(slot.id);
    }
    const detail = await getSlotDetail(current.id);
    expect(detail?.otherSlots.map((c) => c.slotId)).toEqual(others.slice(0, 6));
  });

  it("정확한 주소는 예약이 확정된 고객에게만, 그 밖에는 장소 이름과 동네까지만 준다", async () => {
    const f = await detailFixture();
    const venue = { address: "대전 서구 둔산로 123 4층", lat: 36.3512, lng: 127.3789 };
    const publicPlace = {
      placeName: "둔산 스튜디오",
      area: { slug: "dunsan", name: "둔산동", district: "서구", city: "대전" },
      addressDisclosed: false,
      address: null,
      lat: null,
      lng: null,
    };
    const hidden = (detail: unknown) => {
      const text = JSON.stringify(detail);
      expect(text).not.toContain("둔산로 123");
      expect(text).not.toContain("36.3512");
      expect(text).not.toContain("127.3789");
    };

    // 비로그인
    const anonymous = (await getSlotDetail(f.slot.id))!;
    expect(anonymous.place).toEqual(publicPlace);
    hidden(anonymous);

    // 예약이 없는 회원
    const stranger = await createUser();
    const forStranger = (await getSlotDetail(f.slot.id, stranger))!;
    expect(forStranger.place).toEqual(publicPlace);
    hidden(forStranger);

    // 확정 전(결제 대기·승인 대기)이거나 끝난 예약(취소·거절·시간 초과·노쇼)은 주소를 볼 수 없다
    const notConfirmed: BookingStatus[] = ["PENDING_PAYMENT", "PENDING_APPROVAL", "CANCELLED", "REJECTED", "EXPIRED", "NO_SHOW"];
    for (const status of notConfirmed) {
      const user = await createUser();
      await createBooking(f.slot, f.female.id, user.id, status, { holdExpiresAt: new Date(NOW.getTime() + 10 * 60_000) });
      const detail = (await getSlotDetail(f.slot.id, user))!;
      expect(detail.place, status).toEqual(publicPlace);
      hidden(detail);
    }

    // 확정·이용 완료 고객
    expect(ADDRESS_DISCLOSURE_STATUSES).toEqual(["CONFIRMED", "COMPLETED"]);
    for (const status of ADDRESS_DISCLOSURE_STATUSES) {
      const user = await createUser();
      await createBooking(f.slot, f.female.id, user.id, status);
      const detail = (await getSlotDetail(f.slot.id, user))!;
      expect(detail.place, status).toEqual({ ...publicPlace, addressDisclosed: true, ...venue });
    }

    // 다른 회차의 확정 예약으로는 이 회차의 주소를 볼 수 없다
    const otherSlot = await slotAt(f.product, kstDate(2026, 12, 4, 19, 30));
    const regular = await createUser();
    await createBooking(otherSlot, otherSlot.seats[0]!.id, regular.id, "CONFIRMED");
    expect((await getSlotDetail(f.slot.id, regular))!.place).toEqual(publicPlace);
    expect((await getSlotDetail(otherSlot.id, regular))!.place.address).toBe(venue.address);

    // 목록 카드·홈 피드·사업장 페이지·폴링·공유 정보에는 주소 필드가 아예 없다
    for (const value of [await listVacancies(), await getHomeFeed(), await getSlotAvailability(f.slot.id), await getShareMeta(f.slot.id)]) {
      expectNoPrivateKeys(value, ["address", "addressDetail", "lat", "lng"]);
      hidden(value);
    }
    hidden(await getBusinessPage(f.business.slug));
  });

  it("상품에 장소가 따로 없으면 사업장 주소가 진행 장소이고, 같은 공개 규칙을 따른다", async () => {
    const base = await setup({
      business: { name: "주사위 카페", address: "대전 유성구 대학로 99", addressDetail: "3층", lat: 36.362, lng: 127.345 },
      area: { slug: "bongmyeong", name: "봉명동", district: "유성구", city: "대전" },
    });
    const slot = await slotAt(base.product, kstDate(2026, 12, 3, 19, 0));
    const anonymous = (await getSlotDetail(slot.id))!;
    expect(anonymous.place).toEqual({
      placeName: "주사위 카페",
      area: { slug: "bongmyeong", name: "봉명동", district: "유성구", city: "대전" },
      addressDisclosed: false,
      address: null,
      lat: null,
      lng: null,
    });
    expect(JSON.stringify(anonymous)).not.toContain("36.362");

    const guest = await createUser();
    await createBooking(slot, slot.seats[0]!.id, guest.id, "CONFIRMED");
    expect((await getSlotDetail(slot.id, guest))!.place).toMatchObject({
      addressDisclosed: true,
      address: "대전 유성구 대학로 99 3층",
      lat: 36.362,
      lng: 127.345,
    });
  });

  it("판매자 신원정보는 누구에게나, 어떤 상태의 회차에서도 보여 준다", async () => {
    const f = await detailFixture();
    const seller = {
      name: "연결고리 라운지",
      representativeName: "김대표",
      businessRegNo: "1234567891",
      mailOrderRegNo: "2026-대전서구-0001",
      phone: "0421234567",
      address: "대전 서구 대덕대로 1 2층",
    };
    expect((await getSlotDetail(f.slot.id))!.seller).toEqual(seller);
    expect((await getSlotDetail(f.slot.id, await createUser()))!.seller).toEqual(seller);

    const cancelled = await slotAt(f.product, kstDate(2026, 12, 4, 19, 0), [{ capacity: 2 }], { status: "CANCELLED" });
    const ended = await slotAt(f.product, new Date(NOW.getTime() - 5 * HOUR_MS));
    expect((await getSlotDetail(cancelled.id))!.seller).toEqual(seller);
    expect((await getSlotDetail(ended.id))!.seller).toEqual(seller);

    const page = (await getBusinessPage(f.business.slug))!;
    expect(page.seller).toEqual(seller);

    // 등록 정보가 비어 있어도 블록 자체는 있다
    const bare = await setup();
    const bareSlot = await slotAt(bare.product, kstDate(2026, 12, 3, 19, 0));
    expect((await getSlotDetail(bareSlot.id))!.seller).toEqual({
      name: bare.business.name,
      representativeName: null,
      businessRegNo: null,
      mailOrderRegNo: null,
      phone: null,
      address: null,
    });
  });

  it("보는 사람 상태: 찜·팔로우·참가 조건 안내·진행 중 예약", async () => {
    const f = await detailFixture();
    // 1992년생 여성(34세): 모임은 25~33세
    const woman = await createUser({ gender: "FEMALE", birthYear: 1992 });
    const fresh = (await getSlotDetail(f.slot.id, woman))!.viewer!;
    expect(fresh).toEqual({
      isFavorite: false,
      isFollowing: false,
      eligibility: [
        {
          seatId: f.male.id,
          eligible: false,
          issues: [
            { code: "GENDER_MISMATCH", message: "남성만 예약할 수 있는 자리예요." },
            { code: "AGE_TOO_OLD", message: "33세까지 참가할 수 있어요." },
          ],
        },
        { seatId: f.female.id, eligible: false, issues: [{ code: "AGE_TOO_OLD", message: "33세까지 참가할 수 있어요." }] },
      ],
      activeBooking: null,
      waitlistEntry: null,
      waitlistEntries: [],
    });

    await prisma.favorite.create({ data: { userId: woman.id, productId: f.product.id } });
    await prisma.follow.create({ data: { userId: woman.id, businessId: f.business.id } });
    const hold = await createBooking(f.slot, f.female.id, woman.id, "PENDING_PAYMENT", { holdExpiresAt: new Date(NOW.getTime() + 5 * 60_000) });
    const withHold = (await getSlotDetail(f.slot.id, woman))!.viewer!;
    expect(withHold.isFavorite).toBe(true);
    expect(withHold.isFollowing).toBe(true);
    expect(withHold.activeBooking).toEqual({ code: hold.code, status: "PENDING_PAYMENT", holdExpiresAt: hold.holdExpiresAt });

    // 결제 시간이 지난 홀드는 진행 중인 예약으로 보여 주지 않는다
    await prisma.booking.update({ where: { id: hold.id }, data: { holdExpiresAt: new Date(NOW.getTime() - 1000) } });
    expect((await getSlotDetail(f.slot.id, woman))!.viewer!.activeBooking).toBeNull();
    await prisma.booking.update({ where: { id: hold.id }, data: { status: "CONFIRMED", holdExpiresAt: null } });
    expect((await getSlotDetail(f.slot.id, woman))!.viewer!.activeBooking).toEqual({ code: hold.code, status: "CONFIRMED", holdExpiresAt: null });
    // 끝난 예약은 진행 중 예약이 아니다
    await prisma.booking.update({ where: { id: hold.id }, data: { status: "COMPLETED" } });
    expect((await getSlotDetail(f.slot.id, woman))!.viewer!.activeBooking).toBeNull();

    // 조건이 맞는 회원 / 정보가 없는 회원
    const man = await createUser({ gender: "MALE", birthYear: 1996 });
    expect((await getSlotDetail(f.slot.id, man))!.viewer!.eligibility).toEqual([
      { seatId: f.male.id, eligible: true, issues: [] },
      { seatId: f.female.id, eligible: false, issues: [{ code: "GENDER_MISMATCH", message: "여성만 예약할 수 있는 자리예요." }] },
    ]);
    const young = await createUser({ gender: "MALE", birthYear: 2004 });
    expect((await getSlotDetail(f.slot.id, young))!.viewer!.eligibility[0]).toEqual({
      seatId: f.male.id,
      eligible: false,
      issues: [{ code: "AGE_TOO_YOUNG", message: "25세부터 참가할 수 있어요." }],
    });
    const blank = await createUser();
    expect((await getSlotDetail(f.slot.id, blank))!.viewer!.eligibility[0]?.issues.map((i) => i.code)).toEqual(["GENDER_REQUIRED", "AGE_REQUIRED"]);
  });

  it("보는 사람의 대기 상태와 순번(좌석 유형별, queuedAt 기준)", async () => {
    const f = await detailFixture();
    await reserve(f.male.id, 4);
    await reserve(f.female.id, 4);
    const [first, second, me, femaleWaiter] = await Promise.all([createUser(), createUser(), createUser(), createUser()]);
    const queued = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
    await prisma.waitlistEntry.createMany({
      data: [
        { userId: first.id, slotId: f.slot.id, slotSeatId: f.male.id, status: "WAITING", queuedAt: queued(30) },
        { userId: second.id, slotId: f.slot.id, slotSeatId: f.male.id, status: "WAITING", queuedAt: queued(20) },
        // 다른 좌석 유형의 대기와 끝난 대기는 내 순번에 들어가지 않는다
        { userId: femaleWaiter.id, slotId: f.slot.id, slotSeatId: f.female.id, status: "WAITING", queuedAt: queued(40) },
        { userId: femaleWaiter.id, slotId: f.slot.id, slotSeatId: f.male.id, status: "CANCELLED", queuedAt: queued(50) },
      ],
    });
    const mine = await prisma.waitlistEntry.create({
      data: { userId: me.id, slotId: f.slot.id, slotSeatId: f.male.id, status: "WAITING", quantity: 2, queuedAt: queued(10) },
    });

    const waiting = (await getSlotDetail(f.slot.id, me))!;
    expect(waiting.viewer!.waitlistEntry).toEqual({ id: mine.id, status: "WAITING", seatId: f.male.id, quantity: 2, offerExpiresAt: null, position: 3 });
    expect(waiting.viewer!.waitlistEntries).toHaveLength(1);
    expect(waiting.seats.map((s) => s.waitingCount)).toEqual([3, 1]);
    expect(waiting.waitingCount).toBe(4);
    expect((await getSlotDetail(f.slot.id, first))!.viewer!.waitlistEntry?.position).toBe(1);

    // 제안을 한 번 놓쳐 맨 뒤로 간 경우(queuedAt 갱신)
    await prisma.waitlistEntry.updateMany({ where: { userId: first.id, slotSeatId: f.male.id }, data: { queuedAt: NOW, missedOffers: 1 } });
    expect((await getSlotDetail(f.slot.id, first))!.viewer!.waitlistEntry?.position).toBe(3);
    expect((await getSlotDetail(f.slot.id, me))!.viewer!.waitlistEntry?.position).toBe(2);

    // 제안을 받은 대기가 가장 먼저 나오고 순번은 없다
    const offerExpiresAt = new Date(NOW.getTime() + 15 * 60_000);
    const offered = await prisma.waitlistEntry.create({
      data: { userId: me.id, slotId: f.slot.id, slotSeatId: f.female.id, status: "OFFERED", offeredAt: NOW, offerExpiresAt, queuedAt: queued(5) },
    });
    const viewer = (await getSlotDetail(f.slot.id, me))!.viewer!;
    expect(viewer.waitlistEntry).toEqual({ id: offered.id, status: "OFFERED", seatId: f.female.id, quantity: 1, offerExpiresAt, position: null });
    expect(viewer.waitlistEntries.map((w) => w.id)).toEqual([offered.id, mine.id]);
    expect((await getSlotDetail(f.slot.id, await createUser()))!.viewer!.waitlistEntry).toBeNull();
  });

  it("후기 요약: 공개 후기만 세고, 3건 미만이면 신규로 표시한다", async () => {
    const f = await detailFixture();
    const past = await slotAt(f.product, new Date(NOW.getTime() - 48 * HOUR_MS));
    const writers = await Promise.all([
      createUser({ name: "홍길동" }),
      createUser({ name: "김철" }),
      createUser({ name: "남궁민수" }),
      createUser({ name: "이숨김" }),
    ]);
    const write = async (index: number, rating: number, status: "VISIBLE" | "HIDDEN", minutesAgo: number) => {
      const booking = await createBooking(past, past.seats[0]!.id, writers[index]!.id, "COMPLETED");
      return prisma.review.create({
        data: {
          bookingId: booking.id,
          userId: writers[index]!.id,
          businessId: f.business.id,
          productId: f.product.id,
          rating,
          content: `${index}번 후기예요. 분위기가 좋았어요.`,
          status,
          createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
        },
      });
    };
    const r0 = await write(0, 5, "VISIBLE", 30);
    const r1 = await write(1, 4, "VISIBLE", 20);
    await write(3, 1, "HIDDEN", 5);

    const two = (await getSlotDetail(f.slot.id))!.reviews;
    expect(REVIEW_NEW_THRESHOLD).toBe(3);
    expect(two).toMatchObject({ avg: 4.5, count: 2, isNew: true, distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 } });
    expect(two.latest.map((r) => [r.id, r.authorName])).toEqual([
      [r1.id, maskName("김철")],
      [r0.id, "홍*동"],
    ]);
    expect(two.latest[0]).toEqual({
      id: r1.id,
      rating: 4,
      content: "1번 후기예요. 분위기가 좋았어요.",
      authorName: "김*",
      product: { id: f.product.id, title: f.product.title },
      attendedAt: past.startAt,
      sellerReply: null,
      sellerRepliedAt: null,
      createdAt: r1.createdAt,
    });

    const r2 = await write(2, 3, "VISIBLE", 10);
    const three = (await getSlotDetail(f.slot.id))!.reviews;
    expect(three).toMatchObject({ avg: 4, count: 3, isNew: false });
    expect(three.latest.map((r) => r.id)).toEqual([r2.id, r1.id, r0.id]);
    expect(three.latest[0]?.authorName).toBe("남**수");
    expectNoPrivateKeys(three, ["userId", "bookingId", "name", "hiddenReason"]);
  });
});

// ── 폴링 · 공유 · 사업장 페이지 · 추천 · 분류 ─────────

describe("getSlotAvailability · getShareMeta", () => {
  it("폴링 응답은 상태·좌석별 남은 자리·서버 시각만 담고 쿼리 한 번으로 끝난다", async () => {
    const { product } = await setup();
    const slot = await slotAt(product, kstDate(2026, 12, 3, 19, 0), [
      { label: "남성", gender: "MALE", capacity: 4 },
      { label: "여성", gender: "FEMALE", capacity: 4 },
    ]);
    await reserve(slot.seats[0]!.id, 3, 1);
    const spy = vi.spyOn(prisma, "$queryRaw");
    const availability = await getSlotAvailability(slot.id);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(availability).toEqual({
      state: "OPEN",
      seats: [
        { id: slot.seats[0]!.id, remaining: 1 },
        { id: slot.seats[1]!.id, remaining: 4 },
      ],
      serverTime: NOW,
    });
  });

  it("공유 정보에는 남은 자리 수가 없고, 재고가 바뀌어도 내용이 같다", async () => {
    const { product, business } = await setup({
      product: { title: "와인 로테이션 소개팅", images: ["/uploads/cover.webp"] },
      business: { name: "연결고리 라운지" },
      area: { name: "둔산동" },
    });
    const slot = await slotAt(product, kstDate(2026, 12, 4, 19, 30), [
      { label: "얼리버드", capacity: 3, price: 25000 },
      { label: "일반", capacity: 5, price: 39000 },
    ]);
    const before = await getShareMeta(slot.id);
    expect(before).toEqual({
      title: "와인 로테이션 소개팅",
      businessName: business.name,
      dateText: "12월 4일 (금)",
      timeText: "19:30",
      whenText: "12월 4일 (금) 19:30",
      areaName: "둔산동",
      price: 25000,
      priceText: "25,000원부터",
      image: "/uploads/cover.webp",
      description: "12월 4일 (금) 19:30 · 둔산동 · 25,000원부터",
      state: "OPEN",
    });
    const keys = collectKeys(before);
    for (const key of ["remaining", "totalRemaining", "capacity", "totalCapacity", "seats", "reserved", "waitingCount"]) {
      expect(keys.has(key)).toBe(false);
    }

    // 싼 좌석이 매진돼도 공유 문구는 그대로다(캐시된 카드와 어긋나지 않게)
    await reserve(slot.seats[0]!.id, 3);
    await reserve(slot.seats[1]!.id, 4);
    expect(await getShareMeta(slot.id)).toEqual(before);

    const free = await slotAt(product, kstDate(2026, 12, 5, 19, 30), [{ capacity: 3, price: 0 }]);
    expect(await getShareMeta(free.id)).toMatchObject({ price: 0, priceText: "무료" });
    const single = await slotAt(product, kstDate(2026, 12, 6, 19, 30), [{ capacity: 3, price: 30000 }]);
    expect((await getShareMeta(single.id))?.priceText).toBe("30,000원");
  });
});

describe("getBusinessPage", () => {
  it("승인된 사업장만 보여 준다", async () => {
    const pending = await setup({ business: { status: "PENDING" } });
    const suspended = await setup({ business: { status: "SUSPENDED" } });
    expect(await getBusinessPage(pending.business.slug)).toBeNull();
    expect(await getBusinessPage(suspended.business.slug)).toBeNull();
    expect(await getBusinessPage("no-such-business")).toBeNull();
  });

  it("프로필·판매자 정보·앞으로의 자리·판매 중 상품·후기를 담는다", async () => {
    const f = await setup({
      business: {
        name: "연결고리 라운지",
        tagline: "편한 소개팅",
        description: "대전 둔산동의 소셜 라운지",
        address: "대전 서구 대덕대로 1",
        lat: 36.35,
        lng: 127.38,
        phone: "0421234567",
        representativeName: "김대표",
        businessRegNo: "1234567891",
        bankAccountEnc: "enc:secret",
        commissionBps: 300,
      },
      area: { slug: "dunsan", name: "둔산동", district: "서구", city: "대전" },
      product: { title: "와인 소개팅", images: ["/uploads/w.webp"], basePrice: 39000 },
    });
    const paused = await createProduct(f.business.id, f.category.id, { title: "쉬는 상품", status: "PAUSED" });
    const second = await createProduct(f.business.id, f.category.id, { title: "보드게임 번개" });
    const open = await slotAt(f.product, kstDate(2026, 12, 3, 19, 0));
    const soldOut = await slotAt(second, kstDate(2026, 12, 3, 12, 0), [{ capacity: 1 }]);
    await reserve(soldOut.seats[0]!.id, 1);
    await slotAt(paused, kstDate(2026, 12, 3, 13, 0));
    await slotAt(f.product, new Date(NOW.getTime() - 5 * HOUR_MS));

    const viewer = await createUser();
    await prisma.follow.create({ data: { userId: viewer.id, businessId: f.business.id } });
    await prisma.favorite.create({ data: { userId: viewer.id, productId: second.id } });
    const past = await slotAt(f.product, new Date(NOW.getTime() - 30 * HOUR_MS));
    const booking = await createBooking(past, past.seats[0]!.id, viewer.id, "COMPLETED");
    const review = await prisma.review.create({
      data: { bookingId: booking.id, userId: viewer.id, businessId: f.business.id, productId: f.product.id, rating: 5, content: "다음에도 또 올게요. 추천해요!" },
    });

    const page = (await getBusinessPage(f.business.slug, viewer))!;
    expect(page.business).toEqual({
      id: f.business.id,
      slug: f.business.slug,
      name: "연결고리 라운지",
      tagline: "편한 소개팅",
      description: "대전 둔산동의 소셜 라운지",
      category: { slug: f.category.slug, name: f.category.name },
      area: { slug: "dunsan", name: "둔산동", district: "서구", city: "대전" },
      coverImage: null,
      logoImage: null,
      instagram: null,
      kakaoChannel: null,
      website: null,
      ratingAvg: 0,
      ratingCount: 0,
      followerCount: 0,
      isDemo: false,
    });
    expect(page.seller).toMatchObject({ name: "연결고리 라운지", representativeName: "김대표", businessRegNo: "1234567891", address: "대전 서구 대덕대로 1" });
    expect(page.vacancies.map((c) => c.slotId)).toEqual([open.id, soldOut.id]);
    expect(page.products.map((p) => [p.title, p.isFavorite]).sort()).toEqual([
      ["보드게임 번개", true],
      ["와인 소개팅", false],
    ]);
    expect(page.products.find((p) => p.id === f.product.id)).toMatchObject({ image: "/uploads/w.webp", basePrice: 39000 });
    expect(page.reviews).toMatchObject({ count: 1, avg: 5, isNew: true });
    expect(page.latestReviews.items.map((r) => r.id)).toEqual([review.id]);
    expect(page.latestReviews.nextCursor).toBeNull();
    expect(page.viewer).toEqual({ isFollowing: true });
    expectNoPrivateKeys(page, ["lat", "lng"]);
    expect(JSON.stringify(page)).not.toContain("enc:secret");

    const anonymous = (await getBusinessPage(f.business.slug))!;
    expect(anonymous.viewer).toBeNull();
    expect(anonymous.products.every((p) => !("isFavorite" in p))).toBe(true);
  });
});

describe("searchSuggest · 분류 · 지역 · 사이트맵", () => {
  it("분류·동네·상품·사업장에서 최대 8건을 추천한다(앞부분이 맞는 것 먼저)", async () => {
    const a = await setup({
      category: { slug: "wine", name: "와인 모임" },
      area: { slug: "wine-street", name: "와인거리", district: "중구" },
      business: { name: "와인창고" },
      product: { title: "와인 시음회" },
    });
    const slot = await slotAt(a.product, kstDate(2026, 12, 4, 19, 0));
    const earlier = await slotAt(a.product, kstDate(2026, 12, 3, 19, 0));
    const noSlots = await createProduct(a.business.id, a.category.id, { title: "와인 클래스(회차 없음)" });
    const tail = await createProduct(a.business.id, a.category.id, { title: "내추럴 와인 입문" });
    await slotAt(tail, kstDate(2026, 12, 5, 19, 0));

    const result = await searchSuggest("와인");
    expect(result).toEqual([
      { type: "category", label: "와인 모임", sub: null, slug: "wine", slotId: null },
      { type: "area", label: "와인거리", sub: "중구", slug: "wine-street", slotId: null },
      // 상품은 가장 가까운 공개 회차로 이어진다
      { type: "product", label: "와인 시음회", sub: "와인창고", slug: null, slotId: earlier.id },
      { type: "business", label: "와인창고", sub: null, slug: a.business.slug, slotId: null },
      { type: "product", label: "내추럴 와인 입문", sub: "와인창고", slug: null, slotId: expect.any(String) },
    ]);
    expect(result.some((s) => s.label === noSlots.title)).toBe(false);
    expect(slot.id).not.toBe(earlier.id);

    expect(await searchSuggest("")).toEqual([]);
    expect(await searchSuggest("   ")).toEqual([]);
    expect((await searchSuggest("중구")).map((s) => s.type)).toEqual(["area"]);

    for (let i = 0; i < 12; i++) {
      const p = await createProduct(a.business.id, a.category.id, { title: `와인 번개 ${i}` });
      await slotAt(p, kstDate(2026, 12, 6, 10 + i, 0));
    }
    expect(await searchSuggest("와인")).toHaveLength(8);
  });

  it("listCategories·listAreas 는 활성 항목만 정렬해 주고 수수료 같은 내부 값은 뺀다", async () => {
    await createCategory({ slug: "b-cat", name: "나", sort: 2, commissionBps: 700, description: "설명" });
    await createCategory({ slug: "a-cat", name: "가", sort: 1 });
    await createCategory({ slug: "hidden-cat", name: "숨김", sort: 0, isActive: false });
    await createArea({ slug: "dunsan", name: "둔산동", district: "서구", city: "대전", sort: 1 });
    await createArea({ slug: "bongmyeong", name: "봉명동", district: "유성구", city: "대전", sort: 2 });
    await createArea({ slug: "gangnam", name: "역삼동", district: "강남구", city: "서울", sort: 0 });
    await createArea({ slug: "closed", name: "닫힌동", district: "동구", city: "대전", sort: 0, isActive: false });

    const categories = await listCategories();
    expect(categories).toEqual([
      { slug: "a-cat", name: "가", icon: "sparkles", description: null },
      { slug: "b-cat", name: "나", icon: "sparkles", description: "설명" },
    ]);
    expectNoPrivateKeys(categories);

    expect((await listAreas()).map((a) => a.slug)).toEqual(["gangnam", "dunsan", "bongmyeong"]);
    expect(await listAreas({ city: "대전" })).toEqual([
      { slug: "dunsan", name: "둔산동", district: "서구", city: "대전" },
      { slug: "bongmyeong", name: "봉명동", district: "유성구", city: "대전" },
    ]);
    expect(await listAreas({ city: "부산" })).toEqual([]);
  });

  it("사이트맵은 공개 회차와 승인된 사업장을 수정 시각과 함께 준다", async () => {
    const a = await setup();
    const slot = await slotAt(a.product, kstDate(2026, 12, 3, 19, 0));
    const sitemap = await getSitemapEntries();
    expect(sitemap).toEqual({
      slots: [{ slotId: slot.id, lastModified: slot.updatedAt }],
      businesses: [{ slug: a.business.slug, lastModified: a.business.updatedAt }],
    });
  });

  it("listNextVacancyCards 는 상품·사업장별로 예약 가능한 회차를 먼저 perOwner 개까지 준다", async () => {
    const a = await setup();
    const second = await createProduct(a.business.id, a.category.id);
    const soldOutFirst = await slotAt(a.product, kstDate(2026, 12, 3, 10, 0), [{ capacity: 1 }]);
    await reserve(soldOutFirst.seats[0]!.id, 1);
    const open1 = await slotAt(a.product, kstDate(2026, 12, 4, 10, 0));
    const open2 = await slotAt(a.product, kstDate(2026, 12, 5, 10, 0));
    const onlySoldOut = await slotAt(second, kstDate(2026, 12, 3, 9, 0), [{ capacity: 1 }]);
    await reserve(onlySoldOut.seats[0]!.id, 1);

    const byProduct = await listNextVacancyCards("product", [a.product.id, second.id, a.product.id], 1);
    expect(byProduct.get(a.product.id)?.map((c) => c.slotId)).toEqual([open1.id]);
    // 예약 가능한 회차가 없으면 대기 신청을 할 수 있는 매진 회차를 준다
    expect(byProduct.get(second.id)?.map((c) => c.slotId)).toEqual([onlySoldOut.id]);

    const byBusiness = await listNextVacancyCards("business", [a.business.id], 3);
    expect(byBusiness.get(a.business.id)?.map((c) => c.slotId)).toEqual([open1.id, open2.id, onlySoldOut.id]);
    expect((await listNextVacancyCards("business", [], 3)).size).toBe(0);
  });
});

// ── 분석 이벤트 ───────────────────────────────────────

describe("trackEvent", () => {
  it("기다리지 않고 돌아오며, 회차만 넘겨도 상품·사업장을 채워 기록한다", async () => {
    const { product, business } = await setup();
    const slot = await slotAt(product, kstDate(2026, 12, 3, 19, 0));
    const result = trackEvent({ type: "BOOKING_START", userId: "user-1", slotId: slot.id, meta: { via: "home", seatId: slot.seats[0]!.id, quantity: 2 } });
    expect(result).toBeUndefined();
    await flushEvents();

    const events = await prisma.analyticsEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "BOOKING_START",
      userId: "user-1",
      visitorId: null,
      slotId: slot.id,
      productId: product.id,
      businessId: business.id,
      meta: { via: "home", seatId: slot.seats[0]!.id, quantity: 2 },
    });
  });

  it("SLOT_VIEW 는 같은 사람·같은 상품·같은 날(KST)에 조회수를 한 번만 올린다", async () => {
    const { product } = await setup();
    const other = await createProduct(product.businessId, product.categoryId);
    const slot1 = await slotAt(product, kstDate(2026, 12, 3, 19, 0));
    const slot2 = await slotAt(product, kstDate(2026, 12, 4, 19, 0));
    const otherSlot = await slotAt(other, kstDate(2026, 12, 4, 19, 0));
    const views = async (id: string) => (await prisma.product.findUniqueOrThrow({ where: { id } })).viewCount;

    // 같은 방문자가 동시에 여러 번, 같은 상품의 다른 회차까지 봐도 한 번
    for (let i = 0; i < 6; i++) trackEvent({ type: "SLOT_VIEW", visitorId: "visitor-a", slotId: i % 2 === 0 ? slot1.id : slot2.id });
    await flushEvents();
    expect(await views(product.id)).toBe(1);
    expect(await prisma.analyticsEvent.count({ where: { type: "SLOT_VIEW", productId: product.id } })).toBe(6);

    // 다른 방문자, 로그인 회원은 각각 한 번씩
    trackEvent({ type: "SLOT_VIEW", visitorId: "visitor-b", slotId: slot1.id });
    trackEvent({ type: "SLOT_VIEW", userId: "user-1", visitorId: "visitor-c", slotId: slot1.id });
    trackEvent({ type: "SLOT_VIEW", userId: "user-1", visitorId: "visitor-d", slotId: slot2.id });
    await flushEvents();
    expect(await views(product.id)).toBe(3);

    // 다른 상품은 따로 센다. 누군지 알 수 없는 조회는 기록만 하고 조회수는 올리지 않는다
    trackEvent({ type: "SLOT_VIEW", visitorId: "visitor-a", slotId: otherSlot.id });
    trackEvent({ type: "SLOT_VIEW", slotId: otherSlot.id });
    await flushEvents();
    expect(await views(other.id)).toBe(1);
    expect(await prisma.analyticsEvent.count({ where: { type: "SLOT_VIEW", productId: other.id } })).toBe(2);

    // 다음 날(KST)에는 다시 한 번 올라간다
    vi.setSystemTime(kstDate(2026, 12, 2, 23, 59));
    trackEvent({ type: "SLOT_VIEW", visitorId: "visitor-a", slotId: slot1.id });
    await flushEvents();
    expect(await views(product.id)).toBe(3);
    vi.setSystemTime(kstDate(2026, 12, 3, 0, 1));
    trackEvent({ type: "SLOT_VIEW", visitorId: "visitor-a", slotId: slot1.id });
    await flushEvents();
    expect(await views(product.id)).toBe(4);
  });

  it("meta 는 정해진 항목만 짧게 남기고, 검색어는 40자로 자르며 연락처는 가린다", async () => {
    trackEvent({
      type: "SEARCH",
      visitorId: "visitor-a",
      meta: {
        q: `   ${"와인 소개팅 ".repeat(10)}`,
        resultCount: 0,
        source: "x".repeat(200),
        channel: "kakao",
        password: "비밀",
        phone: "01012345678",
        nested: { a: 1 },
      } as never,
    });
    trackEvent({ type: "SEARCH", meta: { q: "문의 010-1234-5678 또는 hong@example.com", resultCount: 3.9 } });
    trackEvent({ type: "SHARE", meta: { channel: "  " } });
    await flushEvents();

    const [long, contact] = await prisma.analyticsEvent.findMany({ where: { type: "SEARCH" }, orderBy: { createdAt: "asc" } });
    const meta = long!.meta as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["channel", "q", "resultCount", "source"]);
    expect(meta.q).toBe("와인 소개팅 ".repeat(10).trim().slice(0, SEARCH_TERM_MAX));
    expect(String(meta.q).length).toBeLessThanOrEqual(SEARCH_TERM_MAX);
    expect(meta.resultCount).toBe(0);
    expect(String(meta.source)).toHaveLength(60);
    for (const key of Object.keys(meta)) expect(ANALYTICS_META_KEYS).toContain(key);

    expect(contact!.meta).toEqual({ q: "문의 [가림] 또는 [가림]", resultCount: 3 });
    const share = await prisma.analyticsEvent.findFirstOrThrow({ where: { type: "SHARE" } });
    expect(share.meta).toBeNull();
  });

  it("형식이 틀리거나 기록에 실패해도 예외를 던지지 않는다", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => trackEvent({ type: "NOT_A_TYPE" as never })).not.toThrow();
    expect(() => trackEvent(null as never)).not.toThrow();
    expect(() => trackEvent({ type: "SLOT_VIEW", userId: "u".repeat(500) })).not.toThrow();
    await flushEvents();
    expect(await prisma.analyticsEvent.count()).toBe(0);
    expect(log).toHaveBeenCalledTimes(3);

    // DB 오류도 호출한 쪽으로 새지 않고 로그로만 남는다
    vi.spyOn(prisma.analyticsEvent, "create").mockRejectedValueOnce(new Error("db down"));
    expect(() => trackEvent({ type: "SEARCH", meta: { q: "와인", resultCount: 1 } })).not.toThrow();
    await expect(flushEvents()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(4);
    expect(await prisma.analyticsEvent.count()).toBe(0);

    trackEvent({ type: "BUSINESS_VIEW", businessId: "biz-1", visitorId: "v" });
    await flushEvents();
    expect(await prisma.analyticsEvent.count()).toBe(1);
  });
});

// ── 날짜 경계 ─────────────────────────────────────────

describe("날짜 경계(KST)", () => {
  it("주말 한가운데에서는 남은 주말만, 자정 직전에도 KST 날짜로 나눈다", async () => {
    const { product } = await setup();
    const saturdayNight = await slotAt(product, kstDate(2026, 12, 5, 23, 0));
    const sunday = await slotAt(product, kstDate(2026, 12, 6, 15, 0));
    const monday = await slotAt(product, kstDate(2026, 12, 7, 0, 0));

    // 토요일 21:30 KST (UTC 로는 아직 토요일 12:30)
    vi.setSystemTime(kstDate(2026, 12, 5, 21, 30));
    expect(await list({ when: "today" })).toEqual([saturdayNight.id]);
    expect(await list({ when: "tomorrow" })).toEqual([sunday.id]);
    expect(await list({ when: "weekend" })).toEqual([saturdayNight.id, sunday.id]);
    const feed = await getHomeFeed();
    expect(feed.dayCounts.slice(0, 3)).toEqual([
      { dateKey: "2026-12-05", openCount: 1 },
      { dateKey: "2026-12-06", openCount: 1 },
      { dateKey: "2026-12-07", openCount: 1 },
    ]);
    expect(feed.laterCount).toBe(1);

    // 일요일 00:10 KST (UTC 로는 토요일 15:10)
    vi.setSystemTime(kstDate(2026, 12, 6, 0, 10));
    expect(await list({ when: "today" })).toEqual([sunday.id]);
    expect(await list({ when: "weekend" })).toEqual([sunday.id]);
    expect(await list({ when: "tomorrow" })).toEqual([monday.id]);
    expect(kstDateKey(addDays(new Date(), 1))).toBe("2026-12-07");
  });
});
