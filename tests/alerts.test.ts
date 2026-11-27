import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { kstDate, startOfKstDay } from "@/lib/time";
import { prisma } from "@/server/db";
import {
  MAX_ALERT_RULES,
  VACANCY_DAILY_LIMIT,
  announceVacancy,
  createAlertRule,
  deleteAlertRule,
  getDemandSignals,
  listAlertRules,
  matchAlertRules,
  updateAlertRule,
} from "@/server/services/alerts";
import { ADVERTISING_OPT_OUT, ADVERTISING_PREFIX } from "@/server/services/notifications/outbox";
import { createArea, createBusiness, createCategory, createProduct, createSlot, createUser, resetDb, type SeatSpec } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 조건 일치 테스트용 회차: 분류·지역·제목·태그·좌석을 정해 만든다. 기본 시작은 2027-01-09(토) 19:30 KST */
async function createVacancy(
  options: {
    seats?: SeatSpec[];
    reserved?: number[];
    productArea?: boolean;
    businessArea?: boolean;
    product?: Partial<Prisma.ProductUncheckedCreateInput>;
    business?: Partial<Prisma.BusinessUncheckedCreateInput>;
    startAt?: Date;
    slot?: Partial<Prisma.SlotUncheckedCreateInput>;
  } = {},
) {
  const category = await createCategory({ name: "소셜 모임" });
  const area = await createArea();
  const { business, owner } = await createBusiness({
    categoryId: category.id,
    name: "둔산 소셜클럽",
    areaId: options.businessArea === false ? null : area.id,
    ...options.business,
  });
  const product = await createProduct(business.id, category.id, {
    title: "금요 와인 소셜",
    tags: ["와인", "소개팅"],
    areaId: options.productArea ? area.id : null,
    ...options.product,
  });
  const startAt = options.startAt ?? kstDate(2027, 1, 9, 19, 30);
  const slot = await createSlot(product, options.seats ?? [{ capacity: 4, price: 30000 }], {
    startAt,
    endAt: new Date(startAt.getTime() + 2 * 3_600_000),
    bookingDeadlineAt: new Date(startAt.getTime() - 3_600_000),
    ...options.slot,
  });
  for (const [i, reserved] of (options.reserved ?? []).entries()) {
    await prisma.slotSeat.update({ where: { id: slot.seats[i]!.id }, data: { reserved } });
  }
  return { category, area, business, owner, product, slot };
}

const loadVacancySlot = (slotId: string) =>
  prisma.slot.findUniqueOrThrow({
    where: { id: slotId },
    include: {
      seats: true,
      product: { include: { category: true, area: true } },
      business: { include: { area: true } },
    },
  });

/** 조건 하나를 가진 회원을 만들고 회원 ID 를 돌려준다. */
async function userWithRule(rule: Record<string, unknown>, userOverrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  const user = await createUser(userOverrides);
  await createAlertRule(user.id, rule);
  return user.id;
}

const vacancyAlerts = (userId: string) => prisma.notification.findMany({ where: { userId, type: "VACANCY_ALERT" } });

// ───────────────────────── 조건 관리 ─────────────────────────

describe("맞춤 알림 조건 관리", () => {
  it("조건을 만들고 본인 것만 조회한다(중복 제거·정렬·빈 문자열 정리)", async () => {
    const me = await createUser();
    const other = await createUser();
    const category = await createCategory();
    const area = await createArea();

    const rule = await createAlertRule(me.id, {
      name: "  주말 와인  ",
      categorySlugs: [category.slug, category.slug],
      areaSlugs: [area.slug],
      keyword: " 와인 ",
      maxPrice: 40000,
      daysOfWeek: [6, 0, 6],
      timeFromMin: 1080,
      timeToMin: 1320,
      seatGender: "FEMALE",
    });
    expect(rule).toMatchObject({
      userId: me.id,
      name: "주말 와인",
      categorySlugs: [category.slug],
      areaSlugs: [area.slug],
      keyword: "와인",
      maxPrice: 40000,
      daysOfWeek: [0, 6],
      timeFromMin: 1080,
      timeToMin: 1320,
      seatGender: "FEMALE",
      isActive: true,
      lastNotifiedAt: null,
    });
    await createAlertRule(other.id, { keyword: "보드게임" });

    const mine = await listAlertRules(me.id);
    expect(mine.map((r) => r.id)).toEqual([rule.id]);
    expect(await listAlertRules(other.id)).toHaveLength(1);

    const blank = await createAlertRule(me.id, { name: "", keyword: "   ", maxPrice: 0 });
    expect(blank).toMatchObject({ name: null, keyword: null, maxPrice: 0, categorySlugs: [], daysOfWeek: [] });
  });

  it("입력 검증: 없는 분류·지역, 긴 키워드, 음수 가격, 요일·시간 범위, 조건 없음", async () => {
    const me = await createUser();
    const inactive = await createCategory({ isActive: false });

    await expect(createAlertRule(me.id, { categorySlugs: ["no-such-category"] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createAlertRule(me.id, { categorySlugs: [inactive.slug] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createAlertRule(me.id, { areaSlugs: ["no-such-area"] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createAlertRule(me.id, { keyword: "가".repeat(31) })).rejects.toThrow();
    await expect(createAlertRule(me.id, { maxPrice: -1 })).rejects.toThrow();
    await expect(createAlertRule(me.id, { maxPrice: 1000.5 })).rejects.toThrow();
    await expect(createAlertRule(me.id, { daysOfWeek: [7] })).rejects.toThrow();
    await expect(createAlertRule(me.id, { daysOfWeek: [-1] })).rejects.toThrow();
    await expect(createAlertRule(me.id, { timeFromMin: 1440 })).rejects.toThrow();
    await expect(createAlertRule(me.id, { timeToMin: -1 })).rejects.toThrow();
    await expect(createAlertRule(me.id, { seatGender: "OTHER" })).rejects.toThrow();
    // 조건이 하나도 없으면 모든 자리에 알림이 가므로 받지 않는다.
    await expect(createAlertRule(me.id, {})).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createAlertRule(me.id, { name: "이름만", seatGender: "ANY" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await prisma.alertRule.count()).toBe(0);

    expect((await createAlertRule(me.id, { keyword: "가".repeat(30) })).keyword).toHaveLength(30);
    expect(await createAlertRule(me.id, { timeFromMin: 0, timeToMin: 1439 })).toMatchObject({ timeFromMin: 0, timeToMin: 1439 });
  });

  it("회원당 10개까지만 만들 수 있다(동시에 눌러도 넘지 않는다)", async () => {
    const me = await createUser();
    const other = await createUser();
    expect(MAX_ALERT_RULES).toBe(10);
    for (let i = 0; i < 9; i++) await createAlertRule(me.id, { keyword: `키워드${i}` });

    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => createAlertRule(me.id, { keyword: `동시${i}` })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "CONFLICT" });
    }
    expect(await prisma.alertRule.count({ where: { userId: me.id } })).toBe(10);
    await expect(createAlertRule(me.id, { keyword: "하나 더" })).rejects.toMatchObject({ code: "CONFLICT" });

    // 다른 회원의 한도와는 무관하고, 지우면 다시 만들 수 있다.
    await createAlertRule(other.id, { keyword: "와인" });
    const [first] = await listAlertRules(me.id);
    await deleteAlertRule(me.id, first!.id);
    await expect(createAlertRule(me.id, { keyword: "다시" })).resolves.toMatchObject({ keyword: "다시" });
  });

  it("남의 조건은 고치거나 지울 수 없다", async () => {
    const me = await createUser();
    const other = await createUser();
    const rule = await createAlertRule(me.id, { keyword: "와인", maxPrice: 30000 });

    await expect(updateAlertRule(other.id, rule.id, { keyword: "해킹" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteAlertRule(other.id, rule.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(updateAlertRule(me.id, "no-such-rule", { keyword: "와인" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.alertRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ userId: me.id, keyword: "와인" });

    await deleteAlertRule(me.id, rule.id);
    expect(await prisma.alertRule.count()).toBe(0);
    await expect(deleteAlertRule(me.id, rule.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("넘긴 항목만 고치고, null 은 조건을 지운다. 조건을 전부 지울 수는 없다", async () => {
    const me = await createUser();
    const rule = await createAlertRule(me.id, { keyword: "와인", maxPrice: 30000, daysOfWeek: [5, 6] });

    const paused = await updateAlertRule(me.id, rule.id, { isActive: false });
    expect(paused).toMatchObject({ isActive: false, keyword: "와인", maxPrice: 30000, daysOfWeek: [5, 6] });

    const edited = await updateAlertRule(me.id, rule.id, { maxPrice: null, daysOfWeek: [], isActive: true });
    expect(edited).toMatchObject({ isActive: true, keyword: "와인", maxPrice: null, daysOfWeek: [] });

    await expect(updateAlertRule(me.id, rule.id, { keyword: null })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(updateAlertRule(me.id, rule.id, { areaSlugs: ["no-such-area"] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(updateAlertRule(me.id, rule.id, { maxPrice: -5 })).rejects.toThrow();
    expect((await prisma.alertRule.findUniqueOrThrow({ where: { id: rule.id } })).keyword).toBe("와인");
  });
});

// ───────────────────────── 조건 일치 ─────────────────────────

describe("matchAlertRules — 조건별 일치", () => {
  it("분류", async () => {
    const v = await createVacancy();
    const otherCategory = await createCategory();
    const hit = await userWithRule({ categorySlugs: [v.category.slug] });
    const multi = await userWithRule({ categorySlugs: [otherCategory.slug, v.category.slug] });
    await userWithRule({ categorySlugs: [otherCategory.slug] });

    expect((await matchAlertRules(await loadVacancySlot(v.slot.id))).sort()).toEqual([hit, multi].sort());
  });

  it("지역: 상품에 장소가 있으면 그 지역, 없으면 사업장 지역으로 견준다", async () => {
    const elsewhere = await createArea({ name: "봉명동" });
    const v = await createVacancy({ productArea: false, businessArea: true });
    const hit = await userWithRule({ areaSlugs: [v.area.slug] });
    await userWithRule({ areaSlugs: [elsewhere.slug] });
    expect(await matchAlertRules(await loadVacancySlot(v.slot.id))).toEqual([hit]);

    // 상품 장소가 사업장과 다른 동네면 상품 장소가 기준이다.
    await prisma.product.update({ where: { id: v.product.id }, data: { areaId: elsewhere.id } });
    const moved = await matchAlertRules(await loadVacancySlot(v.slot.id));
    expect(moved).toHaveLength(1);
    expect(moved).not.toContain(hit);

    // 지역 정보가 전혀 없는 자리는 지역 조건을 건 회원에게 알리지 않는다.
    const nowhere = await createVacancy({ productArea: false, businessArea: false });
    const anywhere = await userWithRule({ keyword: "와인" });
    expect(await matchAlertRules(await loadVacancySlot(nowhere.slot.id))).toEqual([anywhere]);
  });

  it("키워드: 상품 이름·사업장 이름·태그에서 띄어쓰기와 대소문자를 무시하고 찾는다", async () => {
    const v = await createVacancy({ product: { title: "금요 Wine 소셜 모임", tags: ["소개팅", "보드 게임"] } });
    const inTitle = await userWithRule({ keyword: "wine소셜" });
    const inBusiness = await userWithRule({ keyword: "둔산소셜" });
    const inTag = await userWithRule({ keyword: "보드게임" });
    await userWithRule({ keyword: "요가" });

    expect((await matchAlertRules(await loadVacancySlot(v.slot.id))).sort()).toEqual([inTitle, inBusiness, inTag].sort());
  });

  it("가격: 지금 예약할 수 있는 좌석 가운데 가장 싼 가격과 견준다", async () => {
    // 20,000원 좌석은 매진, 30,000원 좌석만 남음
    const v = await createVacancy({
      seats: [
        { label: "얼리버드", capacity: 2, price: 20000 },
        { label: "일반", capacity: 4, price: 30000 },
      ],
      reserved: [2, 1],
    });
    const enough = await userWithRule({ maxPrice: 30000 });
    const generous = await userWithRule({ maxPrice: 50000 });
    await userWithRule({ maxPrice: 29999 });
    await userWithRule({ maxPrice: 20000 });

    expect((await matchAlertRules(await loadVacancySlot(v.slot.id))).sort()).toEqual([enough, generous].sort());
  });

  it("요일(KST)", async () => {
    // 2027-01-09 는 토요일. UTC 로는 같은 날 10:30 이지만, 자정 무렵 회차는 KST 요일로 판단해야 한다.
    const saturday = await createVacancy();
    const sat = await userWithRule({ daysOfWeek: [6] });
    const weekend = await userWithRule({ daysOfWeek: [0, 6] });
    const weekday = await userWithRule({ daysOfWeek: [1, 2, 3, 4, 5] });
    expect((await matchAlertRules(await loadVacancySlot(saturday.slot.id))).sort()).toEqual([sat, weekend].sort());

    // 일요일 00:30 KST = 토요일 15:30 UTC → 일요일로 본다.
    const sundayEarly = await createVacancy({ startAt: kstDate(2027, 1, 10, 0, 30) });
    const matched = await matchAlertRules(await loadVacancySlot(sundayEarly.slot.id));
    expect(matched).toContain(weekend);
    expect(matched).not.toContain(sat);
    expect(matched).not.toContain(weekday);
  });

  it("시작 시간대(KST): 한쪽만 정한 범위와 자정을 넘는 범위", async () => {
    const v = await createVacancy(); // 19:30 = 1170분
    const evening = await userWithRule({ timeFromMin: 1080, timeToMin: 1260 });
    const exact = await userWithRule({ timeFromMin: 1170, timeToMin: 1170 });
    const fromOnly = await userWithRule({ timeFromMin: 1100 });
    const toOnly = await userWithRule({ timeToMin: 1200 });
    const overnight = await userWithRule({ timeFromMin: 1140, timeToMin: 120 });
    await userWithRule({ timeFromMin: 1200, timeToMin: 1320 });
    await userWithRule({ timeFromMin: 540, timeToMin: 1169 });
    await userWithRule({ timeFromMin: 1171 });
    await userWithRule({ timeToMin: 1100 });
    await userWithRule({ timeFromMin: 1320, timeToMin: 120 });

    expect((await matchAlertRules(await loadVacancySlot(v.slot.id))).sort()).toEqual(
      [evening, exact, fromOnly, toOnly, overnight].sort(),
    );
  });

  it("좌석 성별: 그 성별 좌석이나 누구나 좌석에 자리가 남아 있어야 한다(가격 조건과 함께 본다)", async () => {
    // 남성석 25,000원 2자리 남음, 여성석 35,000원 매진
    const v = await createVacancy({
      seats: [
        { label: "남성", gender: "MALE", capacity: 4, price: 25000 },
        { label: "여성", gender: "FEMALE", capacity: 4, price: 35000 },
      ],
      reserved: [2, 4],
    });
    const male = await userWithRule({ seatGender: "MALE" });
    const female = await userWithRule({ seatGender: "FEMALE" });
    const maleCheap = await userWithRule({ seatGender: "MALE", maxPrice: 25000 });
    expect((await matchAlertRules(await loadVacancySlot(v.slot.id))).sort()).toEqual([male, maleCheap].sort());

    // 여성석에 자리가 나면 여성 조건도 맞는다. 다만 여성석 가격(35,000원)이 상한을 넘으면 맞지 않는다.
    await prisma.slotSeat.update({ where: { id: v.slot.seats[1]!.id }, data: { reserved: 3 } });
    const femaleCheap = await userWithRule({ seatGender: "FEMALE", maxPrice: 30000 });
    const reopened = await matchAlertRules(await loadVacancySlot(v.slot.id));
    expect(reopened).toContain(female);
    expect(reopened).not.toContain(femaleCheap);

    // 누구나 좌석은 어떤 성별 조건에도 맞는다.
    const open = await createVacancy({ seats: [{ gender: "ANY", capacity: 4, price: 30000 }] });
    const forAny = await matchAlertRules(await loadVacancySlot(open.slot.id));
    expect(forAny).toEqual(expect.arrayContaining([male, female]));
  });

  it("목록 칼럼이 NULL 로 저장된 조건(시드·직접 입력 데이터)도 '조건 없음'으로 다룬다", async () => {
    const v = await createVacancy();
    const direct = await createUser();
    // 스키마 기본값은 빈 배열이지만, 외부에서 직접 넣은 행은 NULL 일 수 있다.
    await prisma.alertRule.create({ data: { userId: direct.id, keyword: "와인" } });
    await prisma.$executeRaw`
      UPDATE "AlertRule" SET "categorySlugs" = NULL, "areaSlugs" = NULL, "daysOfWeek" = NULL WHERE "userId" = ${direct.id}`;
    const [row] = await prisma.$queryRaw<{ isNull: boolean }[]>`
      SELECT "categorySlugs" IS NULL AS "isNull" FROM "AlertRule" WHERE "userId" = ${direct.id}`;
    expect(row?.isNull).toBe(true);
    expect(await matchAlertRules(await loadVacancySlot(v.slot.id))).toEqual([direct.id]);

    // 서비스로 만든 조건은 빈 배열로 저장한다.
    const viaService = await userWithRule({ keyword: "와인" });
    const [stored] = await prisma.$queryRaw<{ raw: string | null }[]>`
      SELECT "categorySlugs"::text AS "raw" FROM "AlertRule" WHERE "userId" = ${viaService}`;
    expect(stored?.raw).toBe("{}");
  });

  it("꺼 둔 조건·이용 정지 회원의 조건은 빼고, 여러 조건이 맞아도 회원은 한 번만 나온다. 매진이면 아무도 없다", async () => {
    const v = await createVacancy();
    const me = await createUser();
    await createAlertRule(me.id, { keyword: "와인" });
    await createAlertRule(me.id, { categorySlugs: [v.category.slug] });
    const paused = await createUser();
    await createAlertRule(paused.id, { keyword: "와인", isActive: false });
    await userWithRule({ keyword: "와인" }, { status: "SUSPENDED" });

    expect(await matchAlertRules(await loadVacancySlot(v.slot.id))).toEqual([me.id]);

    await prisma.slotSeat.updateMany({ where: { slotId: v.slot.id }, data: { reserved: 4 } });
    expect(await matchAlertRules(await loadVacancySlot(v.slot.id))).toEqual([]);
  });
});

// ───────────────────────── 빈자리 알림 ─────────────────────────

describe("announceVacancy", () => {
  /** 예약 가능한(48시간 뒤 시작) 회차 */
  const openVacancy = (options: Parameters<typeof createVacancy>[0] = {}) =>
    createVacancy({ startAt: new Date(Date.now() + 48 * 3_600_000), ...options });

  const follow = (userId: string, businessId: string) => prisma.follow.create({ data: { userId, businessId } });
  const favorite = (userId: string, productId: string) => prisma.favorite.create({ data: { userId, productId } });

  async function book(v: Awaited<ReturnType<typeof createVacancy>>, userId: string, status: "CONFIRMED" | "PENDING_PAYMENT" | "CANCELLED") {
    return prisma.booking.create({
      data: {
        code: `NJ-${randomBytes(4).toString("hex").toUpperCase()}`,
        userId,
        businessId: v.business.id,
        productId: v.product.id,
        slotId: v.slot.id,
        slotSeatId: v.slot.seats[0]!.id,
        quantity: 1,
        unitPrice: 30000,
        totalAmount: 30000,
        payNowAmount: 30000,
        status,
        paymentMethod: "ONLINE",
        guestName: "예약자",
        guestPhone: "01012345678",
        policySnapshot: [],
        checkinToken: randomBytes(12).toString("hex"),
      },
    });
  }

  it("팔로워·찜한 회원·조건이 맞는 회원에게 한 번씩 알린다", async () => {
    const v = await openVacancy();
    const follower = await createUser();
    const fan = await createUser();
    const everything = await createUser();
    await follow(follower.id, v.business.id);
    await favorite(fan.id, v.product.id);
    await follow(everything.id, v.business.id);
    await favorite(everything.id, v.product.id);
    const rule = await createAlertRule(everything.id, { keyword: "와인" });
    const ruleOnly = await userWithRule({ categorySlugs: [v.category.slug] });
    const unrelated = await userWithRule({ keyword: "요가" });

    expect(await announceVacancy(v.slot.id)).toEqual({ notified: 4 });

    for (const id of [follower.id, fan.id, everything.id, ruleOnly]) {
      const alerts = await vacancyAlerts(id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ title: "둔산 소셜클럽에 새 자리가 열렸어요", linkUrl: `/slots/${v.slot.id}`, readAt: null });
      expect(alerts[0]!.data).toMatchObject({ slotId: v.slot.id, productId: v.product.id, businessId: v.business.id, reason: "NEW" });
      expect(alerts[0]!.body).toContain("금요 와인 소셜");
      expect(alerts[0]!.body).toContain("30,000원");
    }
    expect(await vacancyAlerts(unrelated)).toHaveLength(0);
    // 문자는 받겠다고 한 회원에게만 간다(기본은 꺼짐).
    expect(await prisma.messageOutbox.count()).toBe(0);

    // 알림이 나간 조건에는 마지막 알림 시각이 남는다.
    expect((await prisma.alertRule.findUniqueOrThrow({ where: { id: rule.id } })).lastNotifiedAt).toBeInstanceOf(Date);
    const untouched = await prisma.alertRule.findFirstOrThrow({ where: { userId: unrelated } });
    expect(untouched.lastNotifiedAt).toBeNull();
  });

  it("같은 회차는 회원당 한 번만 알린다(다시 불러도, 동시에 불러도)", async () => {
    const v = await openVacancy();
    const users = await Promise.all(Array.from({ length: 6 }, () => createUser()));
    for (const u of users) await follow(u.id, v.business.id);

    const results = await Promise.all([announceVacancy(v.slot.id), announceVacancy(v.slot.id), announceVacancy(v.slot.id)]);
    expect(results.reduce((sum, r) => sum + r.notified, 0)).toBe(6);
    expect(await prisma.notification.count({ where: { type: "VACANCY_ALERT" } })).toBe(6);

    expect(await announceVacancy(v.slot.id, { reason: "REOPENED" })).toEqual({ notified: 0 });

    // 나중에 팔로우한 회원만 새로 받는다.
    const late = await createUser();
    await follow(late.id, v.business.id);
    expect(await announceVacancy(v.slot.id, { reason: "REOPENED" })).toEqual({ notified: 1 });
    expect((await vacancyAlerts(late.id))[0]).toMatchObject({ title: "둔산 소셜클럽에 취소 자리가 났어요" });
    expect((await vacancyAlerts(late.id))[0]!.data).toMatchObject({ reason: "REOPENED" });
    expect(await prisma.notification.count({ where: { type: "VACANCY_ALERT" } })).toBe(7);

    // 같은 사업장의 다른 회차는 따로 알린다.
    const another = await createSlot(v.product, [{ capacity: 2 }], { startsInHours: 72, origin: "CANCELLATION" });
    expect(await announceVacancy(another.id)).toEqual({ notified: 7 });
    const second = await prisma.notification.findFirstOrThrow({ where: { userId: late.id, data: { path: ["slotId"], equals: another.id } } });
    expect(second.title).toBe("둔산 소셜클럽에 취소 자리가 났어요");
  });

  it("하루(KST) 5건까지만 알린다", async () => {
    const v = await openVacancy();
    const full = await createUser();
    const almost = await createUser();
    const yesterday = await createUser();
    for (const u of [full, almost, yesterday]) await follow(u.id, v.business.id);
    expect(VACANCY_DAILY_LIMIT).toBe(5);

    const today = new Date();
    const before = new Date(startOfKstDay(today).getTime() - 60_000);
    const seed = (userId: string, count: number, createdAt: Date) =>
      prisma.notification.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          userId,
          type: "VACANCY_ALERT",
          title: "다른 자리",
          body: "본문",
          data: { slotId: `other-${i}` },
          createdAt,
        })),
      });
    await seed(full.id, 5, today);
    await seed(almost.id, 4, today);
    await seed(yesterday.id, 5, before);
    // 다른 종류의 알림은 세지 않는다.
    await prisma.notification.createMany({
      data: Array.from({ length: 6 }, () => ({ userId: almost.id, type: "BOOKING_CONFIRMED", title: "예약", body: "본문" })),
    });

    expect(await announceVacancy(v.slot.id)).toEqual({ notified: 2 });
    const has = async (userId: string) =>
      (await prisma.notification.count({ where: { userId, type: "VACANCY_ALERT", data: { path: ["slotId"], equals: v.slot.id } } })) === 1;
    expect(await has(full.id)).toBe(false);
    expect(await has(almost.id)).toBe(true);
    expect(await has(yesterday.id)).toBe(true);

    // 이제 5건이 된 회원은 다음 회차 알림을 받지 않는다.
    const next = await createSlot(v.product, [{ capacity: 2 }], { startsInHours: 72 });
    expect(await announceVacancy(next.id)).toEqual({ notified: 1 });
    expect(await prisma.notification.count({ where: { userId: almost.id, type: "VACANCY_ALERT" } })).toBe(5);
  });

  it("제외 대상: 요청에서 뺀 회원, 이미 예약한 회원, 자리 제안을 받은 회원, 사업장 구성원, 이용할 수 없는 회원", async () => {
    const v = await openVacancy();
    const normal = await createUser();
    const justCancelled = await createUser();
    const booked = await createUser();
    const paying = await createUser();
    const cancelledBefore = await createUser();
    const offered = await createUser();
    const waiting = await createUser();
    const staff = await createUser();
    const suspended = await createUser({ status: "SUSPENDED" });
    const withdrawn = await createUser({ status: "WITHDRAWN" });
    const restricted = await createUser({ bookingRestrictedUntil: new Date(Date.now() + 86_400_000) });
    const restrictionOver = await createUser({ bookingRestrictedUntil: new Date(Date.now() - 86_400_000) });

    await prisma.businessMember.create({ data: { businessId: v.business.id, userId: staff.id, role: "STAFF" } });
    const everyone = [normal, justCancelled, booked, paying, cancelledBefore, offered, waiting, staff, suspended, withdrawn, restricted, restrictionOver, v.owner];
    for (const u of everyone) await follow(u.id, v.business.id);
    await book(v, booked.id, "CONFIRMED");
    await book(v, paying.id, "PENDING_PAYMENT");
    await book(v, cancelledBefore.id, "CANCELLED");
    const seatId = v.slot.seats[0]!.id;
    await prisma.waitlistEntry.create({ data: { userId: offered.id, slotId: v.slot.id, slotSeatId: seatId, status: "OFFERED", offeredAt: new Date() } });
    await prisma.waitlistEntry.create({ data: { userId: waiting.id, slotId: v.slot.id, slotSeatId: seatId, status: "WAITING" } });

    const result = await announceVacancy(v.slot.id, { reason: "REOPENED", excludeUserIds: [justCancelled.id] });
    const notifiedIds = (await prisma.notification.findMany({ where: { type: "VACANCY_ALERT" }, select: { userId: true } })).map((n) => n.userId);
    expect(notifiedIds.sort()).toEqual([normal.id, cancelledBefore.id, waiting.id, restrictionOver.id].sort());
    expect(result).toEqual({ notified: 4 });
  });

  it("알릴 수 없는 회차: 마감·취소된 회차, 예약 마감이 지난 회차, 매진, 판매 중지 상품, 승인 전 사업장", async () => {
    const closed = await openVacancy({ slot: { status: "CLOSED" } });
    const cancelled = await openVacancy({ slot: { status: "CANCELLED" } });
    const pastDeadline = await createVacancy({ startAt: new Date(Date.now() + 30 * 60_000) });
    const started = await createVacancy({ startAt: new Date(Date.now() - 30 * 60_000) });
    const soldOut = await openVacancy({ reserved: [4] });
    const paused = await openVacancy({ product: { status: "PAUSED" } });
    const pending = await openVacancy({ business: { status: "SUSPENDED" } });
    const follower = await createUser();
    for (const v of [closed, cancelled, pastDeadline, started, soldOut, paused, pending]) {
      await follow(follower.id, v.business.id);
      expect(await announceVacancy(v.slot.id)).toEqual({ notified: 0 });
    }
    expect(await prisma.notification.count()).toBe(0);

    // 없는 회차를 넘겨도 예외를 던지지 않는다.
    await expect(announceVacancy("no-such-slot")).resolves.toEqual({ notified: 0 });
  });

  it("수신 설정: 앱 알림을 끈 회원은 건너뛰고, 문자는 켠 회원 가운데 광고 수신에 동의한 회원에게만 보낸다", async () => {
    const v = await openVacancy();
    const consent = { marketingConsentAt: new Date(), nightAlertConsentAt: new Date() };
    const inAppOff = await createUser({ notificationPrefs: { vacancyInApp: false } });
    const both = await createUser({ ...consent, phone: "01011110001", notificationPrefs: { vacancySms: true } });
    const smsOnly = await createUser({ ...consent, phone: "01011110002", notificationPrefs: { vacancyInApp: false, vacancySms: true } });
    const smsNoConsent = await createUser({ phone: "01011110003", notificationPrefs: { vacancySms: true } });
    const smsNoPhone = await createUser({ ...consent, phone: null, notificationPrefs: { vacancyInApp: false, vacancySms: true } });
    for (const u of [inAppOff, both, smsOnly, smsNoConsent, smsNoPhone]) await follow(u.id, v.business.id);

    expect(await announceVacancy(v.slot.id)).toEqual({ notified: 3 });

    expect(await vacancyAlerts(inAppOff.id)).toHaveLength(0);
    expect(await vacancyAlerts(both.id)).toHaveLength(1);
    expect(await vacancyAlerts(smsOnly.id)).toHaveLength(0);
    expect(await vacancyAlerts(smsNoConsent.id)).toHaveLength(1);

    const sms = await prisma.messageOutbox.findMany({ orderBy: { recipient: "asc" } });
    expect(sms.map((m) => m.recipient)).toEqual(["01011110001", "01011110002"]);
    for (const m of sms) {
      expect(m).toMatchObject({ channel: "SMS", templateKey: "VACANCY_ALERT", isAdvertising: true, status: "QUEUED", businessId: null });
      expect(m.body.startsWith(ADVERTISING_PREFIX)).toBe(true);
      expect(m.body.endsWith(ADVERTISING_OPT_OUT)).toBe(true);
      expect(m.body).toContain("둔산 소셜클럽에 새 자리가 열렸어요");
      expect(m.body).toContain(`http://localhost:3000/slots/${v.slot.id}`);
    }

    // 문자만 받는 회원도 같은 회차는 한 번만 받는다.
    expect(await announceVacancy(v.slot.id)).toEqual({ notified: 0 });
    expect(await prisma.messageOutbox.count()).toBe(2);
  });

  it("야간에는 별도 동의가 없는 회원의 빈자리 문자를 다음 08:00 으로 예약한다(앱 알림은 바로)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(kstDate(2026, 11, 27, 22, 10));
    const v = await openVacancy();
    const user = await createUser({ marketingConsentAt: new Date(), notificationPrefs: { vacancySms: true } });
    await follow(user.id, v.business.id);

    expect(await announceVacancy(v.slot.id)).toEqual({ notified: 1 });
    expect(await vacancyAlerts(user.id)).toHaveLength(1);
    const sms = await prisma.messageOutbox.findFirstOrThrow({ where: { userId: user.id } });
    expect(sms.scheduledAt).toEqual(kstDate(2026, 11, 28, 8, 0));
  });

  it("팔로우·찜으로만 온 회원에게는 본인이 앉을 수 없는 성별 좌석을 알리지 않는다(조건을 건 회원은 예외)", async () => {
    // 여성석만 남은 회차
    const v = await openVacancy({
      seats: [
        { label: "남성", gender: "MALE", capacity: 4, price: 30000 },
        { label: "여성", gender: "FEMALE", capacity: 4, price: 30000 },
      ],
      reserved: [4, 3],
    });
    const man = await createUser({ gender: "MALE" });
    const woman = await createUser({ gender: "FEMALE" });
    const unknown = await createUser();
    const manWithRule = await createUser({ gender: "MALE" });
    for (const u of [man, woman, unknown]) await follow(u.id, v.business.id);
    await createAlertRule(manWithRule.id, { seatGender: "FEMALE", keyword: "와인" });

    expect(await announceVacancy(v.slot.id)).toEqual({ notified: 3 });
    expect(await vacancyAlerts(man.id)).toHaveLength(0);
    expect(await vacancyAlerts(woman.id)).toHaveLength(1);
    expect(await vacancyAlerts(unknown.id)).toHaveLength(1);
    expect(await vacancyAlerts(manWithRule.id)).toHaveLength(1);
  });

  it("가격 표시: 좌석 가격이 여러 가지면 '부터', 무료면 '무료'", async () => {
    const mixed = await openVacancy({
      seats: [
        { label: "얼리버드", capacity: 2, price: 20000 },
        { label: "일반", capacity: 2, price: 30000 },
      ],
    });
    const free = await openVacancy({ seats: [{ capacity: 2, price: 0 }] });
    const user = await createUser();
    await follow(user.id, mixed.business.id);
    await follow(user.id, free.business.id);
    await announceVacancy(mixed.slot.id);
    await announceVacancy(free.slot.id);

    const alerts = await vacancyAlerts(user.id);
    const bodyOf = (slotId: string) => alerts.find((n) => (n.data as { slotId: string }).slotId === slotId)!.body;
    expect(bodyOf(mixed.slot.id)).toContain("20,000원부터");
    expect(bodyOf(free.slot.id)).toContain("무료");
  });
});

// ───────────────────────── 수요 신호 ─────────────────────────

describe("getDemandSignals", () => {
  it("팔로워·찜·알림 조건 회원·대기 건수를 센다", async () => {
    const v = await createVacancy({ startAt: new Date(Date.now() + 48 * 3_600_000) });
    const otherCategory = await createCategory();
    const otherArea = await createArea();
    const users = await Promise.all(Array.from({ length: 4 }, () => createUser()));
    await prisma.follow.createMany({ data: users.slice(0, 3).map((u) => ({ userId: u.id, businessId: v.business.id })) });
    await prisma.favorite.createMany({ data: users.slice(0, 2).map((u) => ({ userId: u.id, productId: v.product.id })) });

    // 분류·지역을 명시했고 이 사업장과 어긋나지 않는 조건만 센다(회원 단위).
    const subscriber = await createUser();
    await createAlertRule(subscriber.id, { categorySlugs: [v.category.slug] });
    await createAlertRule(subscriber.id, { areaSlugs: [v.area.slug], maxPrice: 50000 });
    await userWithRule({ categorySlugs: [v.category.slug], areaSlugs: [v.area.slug] });
    await userWithRule({ categorySlugs: [otherCategory.slug] });
    await userWithRule({ categorySlugs: [v.category.slug], areaSlugs: [otherArea.slug] });
    await userWithRule({ keyword: "와인" });
    const pausedUser = await createUser();
    await createAlertRule(pausedUser.id, { categorySlugs: [v.category.slug], isActive: false });

    // 앞으로 열릴 회차의 대기만 센다.
    const seatId = v.slot.seats[0]!.id;
    await prisma.waitlistEntry.create({ data: { userId: users[0]!.id, slotId: v.slot.id, slotSeatId: seatId, quantity: 2, status: "WAITING" } });
    await prisma.waitlistEntry.create({ data: { userId: users[1]!.id, slotId: v.slot.id, slotSeatId: seatId, quantity: 1, status: "WAITING" } });
    await prisma.waitlistEntry.create({ data: { userId: users[2]!.id, slotId: v.slot.id, slotSeatId: seatId, status: "CANCELLED" } });
    const past = await createSlot(v.product, [{ capacity: 2 }], { startsInHours: -5 });
    await prisma.waitlistEntry.create({ data: { userId: users[3]!.id, slotId: past.id, slotSeatId: past.seats[0]!.id, status: "WAITING" } });

    expect(await getDemandSignals(v.business.id)).toEqual({
      followers: 3,
      favorites: 2,
      alertSubscribers: 2,
      waitlistWaiting: 2,
      waitlistSeats: 3,
    });

    const { business: empty } = await createBusiness();
    expect(await getDemandSignals(empty.id)).toEqual({ followers: 0, favorites: 0, alertSubscribers: 0, waitlistWaiting: 0, waitlistSeats: 0 });
    await expect(getDemandSignals("no-such-business")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
