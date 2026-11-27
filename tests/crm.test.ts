import { beforeEach, describe, expect, it } from "vitest";
import type { BookingChannel, BookingStatus, MemberRole, Prisma } from "@/generated/prisma/client";
import { formatPhone, maskPhone } from "@/lib/format";
import { newBookingCode, newToken } from "@/lib/ids";
import { DAY } from "@/lib/time";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import { resolveCommission } from "@/server/services/commission";
import {
  CUSTOMER_SOURCE_LABEL,
  MAX_IMPORT_ROWS,
  addManualCustomer,
  exportCustomersCsv,
  getCustomer,
  getCustomerStats,
  importCustomers,
  isBlockedCustomer,
  listCustomers,
  recordBookingEvent,
  updateCustomer,
  type CrmBooking,
} from "@/server/services/crm";
import { DEFAULT_SETTINGS, PLAN_FEATURES } from "@/server/settings";
import { createBusiness, createListing, createUser, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("실패해야 하는 호출이 성공했어요.");
}

async function addMember(businessId: string, role: MemberRole) {
  const user = await createUser();
  await prisma.businessMember.create({ data: { businessId, userId: user.id, role } });
  return user;
}

const PHONE = "01012345678";

const crmBooking = (businessId: string, overrides: Partial<CrmBooking> = {}): CrmBooking => ({
  businessId,
  userId: null,
  guestName: "김손님",
  guestPhone: PHONE,
  channel: "MARKETPLACE",
  totalAmount: 30_000,
  createdAt: new Date(),
  ...overrides,
});

const card = (businessId: string, phone = PHONE) => prisma.businessCustomer.findUnique({ where: { businessId_phone: { businessId, phone } } });
const cardOrThrow = (businessId: string, phone = PHONE) =>
  prisma.businessCustomer.findUniqueOrThrow({ where: { businessId_phone: { businessId, phone } } });
const audits = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

/** 카드를 바로 만든다(목록·검색 시험용). */
const seedCard = (businessId: string, data: Partial<Prisma.BusinessCustomerUncheckedCreateInput> & { phone: string }) =>
  prisma.businessCustomer.create({ data: { businessId, name: "고객", ...data } });

// ───────────────────────── 예약 엔진 연동 ─────────────────────────

describe("recordBookingEvent", () => {
  it("예약 흐름에 따라 카드와 횟수를 맞춘다", async () => {
    const { business } = await createBusiness();
    const member = await createUser();
    const bookedAt = new Date(Date.now() - 2 * DAY);
    const slotStartAt = new Date(Date.now() - DAY);
    const booking = crmBooking(business.id, { userId: member.id, createdAt: bookedAt, slot: { startAt: slotStartAt } });

    await recordBookingEvent(booking, "BOOKED");
    expect(await cardOrThrow(business.id)).toMatchObject({
      name: "김손님",
      phone: PHONE,
      userId: member.id,
      source: "MARKETPLACE",
      bookingCount: 1,
      completedCount: 0,
      cancelCount: 0,
      noShowCount: 0,
      totalSpent: 0,
      lastBookingAt: bookedAt,
      lastVisitAt: null,
      isBlocked: false,
    });

    await recordBookingEvent(booking, "COMPLETED");
    expect(await cardOrThrow(business.id)).toMatchObject({ bookingCount: 1, completedCount: 1, totalSpent: 30_000, lastVisitAt: slotStartAt });

    // 두 번째 예약은 취소, 세 번째 예약은 노쇼
    const second = crmBooking(business.id, { userId: member.id, totalAmount: 45_000 });
    await recordBookingEvent(second, "BOOKED");
    await recordBookingEvent(second, "CANCELLED");
    const third = crmBooking(business.id, { userId: member.id });
    await recordBookingEvent(third, "BOOKED");
    await recordBookingEvent(third, "NO_SHOW");
    expect(await cardOrThrow(business.id)).toMatchObject({ bookingCount: 3, completedCount: 1, cancelCount: 1, noShowCount: 1, totalSpent: 30_000 });
    expect((await cardOrThrow(business.id)).lastBookingAt!.getTime()).toBeGreaterThan(bookedAt.getTime());

    // 노쇼를 되돌리고 이용 완료로 처리
    await recordBookingEvent(third, "NO_SHOW_REVERTED");
    await recordBookingEvent(third, "COMPLETED");
    expect(await cardOrThrow(business.id)).toMatchObject({ noShowCount: 0, completedCount: 2, totalSpent: 60_000 });
    expect(await prisma.businessCustomer.count({ where: { businessId: business.id } })).toBe(1);
  });

  it("노쇼 되돌리기는 0 아래로 내려가지 않고, 최근 예약일·방문일은 뒤로 가지 않는다", async () => {
    const { business } = await createBusiness();
    const recent = new Date(Date.now() - DAY);
    const older = new Date(Date.now() - 10 * DAY);

    await recordBookingEvent(crmBooking(business.id), "NO_SHOW_REVERTED");
    expect(await cardOrThrow(business.id)).toMatchObject({ noShowCount: 0, bookingCount: 0 });

    await recordBookingEvent(crmBooking(business.id, { createdAt: recent, slot: { startAt: recent } }), "BOOKED");
    await recordBookingEvent(crmBooking(business.id, { createdAt: recent, slot: { startAt: recent } }), "COMPLETED");
    // 더 오래된 예약의 사건이 나중에 들어와도 날짜는 최신 값을 유지한다.
    await recordBookingEvent(crmBooking(business.id, { createdAt: older, slot: { startAt: older } }), "BOOKED");
    await recordBookingEvent(crmBooking(business.id, { createdAt: older, slot: { startAt: older } }), "COMPLETED");
    expect(await cardOrThrow(business.id)).toMatchObject({ bookingCount: 2, completedCount: 2, lastBookingAt: recent, lastVisitAt: recent });
  });

  it.each<[BookingChannel, string]>([
    ["MARKETPLACE", "MARKETPLACE"],
    ["WAITLIST", "MARKETPLACE"],
    ["DIRECT", "DIRECT"],
    ["MANUAL", "MANUAL"],
  ])("처음 예약한 채널 %s → 유입 경로 %s", async (channel, source) => {
    const { business } = await createBusiness();
    await recordBookingEvent(crmBooking(business.id, { channel }), "BOOKED");
    expect((await cardOrThrow(business.id)).source).toBe(source);
  });

  it("이미 있는 카드의 유입 경로·이름·메모는 바꾸지 않는다(가져온 고객은 계속 내 고객)", async () => {
    const { business } = await createBusiness();
    const member = await createUser();
    await seedCard(business.id, { phone: PHONE, name: "단골 김씨", source: "IMPORTED", memo: "창가 선호", tags: ["단골"] });

    await recordBookingEvent(crmBooking(business.id, { userId: member.id, guestName: "김손님", channel: "MARKETPLACE" }), "BOOKED");

    expect(await cardOrThrow(business.id)).toMatchObject({
      source: "IMPORTED",
      name: "단골 김씨",
      memo: "창가 선호",
      tags: ["단골"],
      bookingCount: 1,
      // 회원 연결만 채운다.
      userId: member.id,
    });

    // 남는자리로 처음 온 고객을 나중에 직접 입력으로 예약해도 '직접 등록'으로 바뀌지 않는다.
    await recordBookingEvent(crmBooking(business.id, { guestPhone: "01088880000", channel: "MARKETPLACE" }), "BOOKED");
    await recordBookingEvent(crmBooking(business.id, { guestPhone: "01088880000", channel: "MANUAL" }), "BOOKED");
    expect(await cardOrThrow(business.id, "01088880000")).toMatchObject({ source: "MARKETPLACE", bookingCount: 2 });

    // 이미 연결된 회원은 다른 회원으로 바뀌지 않는다.
    const another = await createUser();
    await recordBookingEvent(crmBooking(business.id, { userId: another.id }), "BOOKED");
    expect((await cardOrThrow(business.id)).userId).toBe(member.id);
  });

  it("전화번호가 비어 있으면(외부 판매 자리) 아무것도 하지 않고, 번호는 숫자만 남겨 찾는다", async () => {
    const { business } = await createBusiness();
    await recordBookingEvent(crmBooking(business.id, { guestPhone: "", channel: "MANUAL", guestName: "외부 판매" }), "BOOKED");
    await recordBookingEvent(crmBooking(business.id, { guestPhone: " - ", channel: "MANUAL" }), "CANCELLED");
    expect(await prisma.businessCustomer.count()).toBe(0);

    await recordBookingEvent(crmBooking(business.id, { guestPhone: "010-1234-5678" }), "BOOKED");
    await recordBookingEvent(crmBooking(business.id, { guestPhone: "01012345678" }), "BOOKED");
    expect(await cardOrThrow(business.id)).toMatchObject({ bookingCount: 2 });
    // 이름이 비어 있어도 카드는 만들어진다.
    await recordBookingEvent(crmBooking(business.id, { guestPhone: "01055556666", guestName: "   " }), "BOOKED");
    expect((await cardOrThrow(business.id, "01055556666")).name).not.toBe("");
  });

  it("사업장마다 카드가 따로다", async () => {
    const a = await createBusiness();
    const b = await createBusiness();
    await recordBookingEvent(crmBooking(a.business.id), "BOOKED");
    await recordBookingEvent(crmBooking(b.business.id), "BOOKED");
    await recordBookingEvent(crmBooking(b.business.id), "NO_SHOW");
    expect(await cardOrThrow(a.business.id)).toMatchObject({ bookingCount: 1, noShowCount: 0 });
    expect(await cardOrThrow(b.business.id)).toMatchObject({ bookingCount: 1, noShowCount: 1 });
  });

  it("같은 고객의 사건이 동시에 들어와도 카드는 하나이고 횟수가 빠지지 않는다", async () => {
    const { business } = await createBusiness();

    await Promise.all(Array.from({ length: 20 }, () => recordBookingEvent(crmBooking(business.id), "BOOKED")));
    await Promise.all([
      ...Array.from({ length: 6 }, () => recordBookingEvent(crmBooking(business.id), "COMPLETED")),
      ...Array.from({ length: 4 }, () => recordBookingEvent(crmBooking(business.id), "CANCELLED")),
    ]);

    expect(await prisma.businessCustomer.count({ where: { businessId: business.id } })).toBe(1);
    expect(await cardOrThrow(business.id)).toMatchObject({ bookingCount: 20, completedCount: 6, cancelCount: 4, totalSpent: 180_000 });
  });

  it("예약 트랜잭션 안에서 부르면 함께 커밋·롤백된다", async () => {
    const { business } = await createBusiness();

    await expect(
      prisma.$transaction(async (tx) => {
        await recordBookingEvent(crmBooking(business.id), "BOOKED", tx);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await card(business.id)).toBeNull();

    await prisma.$transaction((tx) => recordBookingEvent(crmBooking(business.id), "BOOKED", tx));
    expect(await cardOrThrow(business.id)).toMatchObject({ bookingCount: 1 });
  });
});

describe("isBlockedCustomer", () => {
  it("차단한 카드의 전화번호나 연결된 회원이면 true", async () => {
    const { business } = await createBusiness();
    const other = await createBusiness();
    const member = await createUser();
    await seedCard(business.id, { phone: PHONE, userId: member.id, isBlocked: true });
    await seedCard(business.id, { phone: "01000001111", isBlocked: false });

    expect(await isBlockedCustomer(business.id, { phone: "010-1234-5678" })).toBe(true);
    // 번호를 바꿔 예약해도 같은 회원이면 막는다.
    expect(await isBlockedCustomer(business.id, { userId: member.id, phone: "01099998888" })).toBe(true);
    expect(await isBlockedCustomer(business.id, { phone: "01000001111" })).toBe(false);
    expect(await isBlockedCustomer(business.id, { phone: "01099998888" })).toBe(false);
    expect(await isBlockedCustomer(business.id, { phone: "" })).toBe(false);
    // 다른 사업장의 차단은 영향을 주지 않는다.
    expect(await isBlockedCustomer(other.business.id, { userId: member.id, phone: PHONE })).toBe(false);
  });
});

// ───────────────────────── 처음 만난 경로 ─────────────────────────

describe("유입 경로는 처음 만난 경로다(남는자리로 먼저 예약한 번호는 직접 등록해도 '내 고객'이 되지 않는다)", () => {
  type Listing = Awaited<ReturnType<typeof createListing>>;

  /** 카드를 만들지 않고 예약 행만 넣는다(확정 전·거절·시간 초과 예약에는 카드가 없다). */
  const insertBooking = (listing: Listing, overrides: Partial<Prisma.BookingUncheckedCreateInput> = {}) =>
    prisma.booking.create({
      data: {
        code: newBookingCode(),
        businessId: listing.business.id,
        productId: listing.product.id,
        slotId: listing.slot.id,
        slotSeatId: listing.seat.id,
        quantity: 1,
        unitPrice: 30_000,
        totalAmount: 30_000,
        payNowAmount: 30_000,
        status: "PENDING_APPROVAL",
        paymentMethod: "ONLINE",
        guestName: "김손님",
        guestPhone: PHONE,
        policySnapshot: [],
        checkinToken: newToken(),
        ...overrides,
      },
    });

  it.each<[BookingChannel, BookingStatus, string]>([
    ["MARKETPLACE", "PENDING_APPROVAL", "MARKETPLACE"],
    ["MARKETPLACE", "REJECTED", "MARKETPLACE"],
    ["MARKETPLACE", "EXPIRED", "MARKETPLACE"],
    ["WAITLIST", "CANCELLED", "MARKETPLACE"],
    ["DIRECT", "PENDING_APPROVAL", "MANUAL"],
    ["MANUAL", "CONFIRMED", "MANUAL"],
  ])("직접 등록: %s 채널의 %s 예약이 먼저 있던 번호 → %s", async (channel, status, source) => {
    const listing = await createListing([{ capacity: 10 }]);
    await insertBooking(listing, { channel, status });

    const created = await addManualCustomer(listing.owner.id, listing.business.id, { name: "김손님", phone: PHONE });

    expect(created.source).toBe(source);
    expect(created.sourceLabel).toBe(CUSTOMER_SOURCE_LABEL[source as keyof typeof CUSTOMER_SOURCE_LABEL]);
  });

  it("직접 등록: 다른 사업장·다른 번호의 남는자리 예약은 상관없다", async () => {
    const mine = await createListing([{ capacity: 10 }]);
    const other = await createListing([{ capacity: 10 }]);
    await insertBooking(other, { status: "CONFIRMED" });
    await insertBooking(mine, { status: "CONFIRMED", guestPhone: "01077770000" });

    expect((await addManualCustomer(mine.owner.id, mine.business.id, { name: "김손님", phone: PHONE })).source).toBe("MANUAL");
  });

  it("가져오기: 남는자리로 먼저 예약한 번호만 '남는자리'로, 나머지는 '가져온 고객'으로 만든다", async () => {
    const listing = await createListing([{ capacity: 10 }]);
    await insertBooking(listing, { guestPhone: "01010000001", status: "PENDING_APPROVAL" });
    await insertBooking(listing, { guestPhone: "01010000002", status: "REJECTED", channel: "WAITLIST" });
    await insertBooking(listing, { guestPhone: "01010000003", status: "CONFIRMED", channel: "DIRECT" });

    const result = await importCustomers(listing.owner.id, listing.business.id, [
      { name: "승인 대기", phone: "010-1000-0001" },
      { name: "거절됨", phone: "01010000002" },
      { name: "내 링크", phone: "01010000003" },
      { name: "처음 보는 번호", phone: "01010000004" },
    ]);

    expect(result).toEqual({ created: 4, skippedExisting: 0, invalid: [] });
    expect((await cardOrThrow(listing.business.id, "01010000001")).source).toBe("MARKETPLACE");
    expect((await cardOrThrow(listing.business.id, "01010000002")).source).toBe("MARKETPLACE");
    expect((await cardOrThrow(listing.business.id, "01010000003")).source).toBe("IMPORTED");
    expect((await cardOrThrow(listing.business.id, "01010000004")).source).toBe("IMPORTED");
  });

  it("직접 입력 예약: 남는자리 예약이 먼저 있었으면 '남는자리', 직접 입력이 먼저였으면 '직접 등록'", async () => {
    const listing = await createListing([{ capacity: 10 }]);
    const earlier = new Date(Date.now() - 2 * DAY);
    const later = new Date(Date.now() - DAY);

    // 남는자리 예약(거절) → 같은 번호를 직접 입력으로 예약
    await insertBooking(listing, { guestPhone: "01010000001", status: "REJECTED", createdAt: earlier });
    await recordBookingEvent(crmBooking(listing.business.id, { guestPhone: "01010000001", channel: "MANUAL", createdAt: later }), "BOOKED");
    expect(await cardOrThrow(listing.business.id, "01010000001")).toMatchObject({ source: "MARKETPLACE", bookingCount: 1 });

    // 직접 입력 예약이 먼저였고, 남는자리 예약은 그 뒤에 들어온 경우
    await insertBooking(listing, { guestPhone: "01010000002", status: "PENDING_PAYMENT", createdAt: later });
    await recordBookingEvent(crmBooking(listing.business.id, { guestPhone: "01010000002", channel: "MANUAL", createdAt: earlier }), "BOOKED");
    expect((await cardOrThrow(listing.business.id, "01010000002")).source).toBe("MANUAL");
  });

  it("수수료 판정: 승인 대기 중에 연락처를 보고 직접 등록해도 그 고객의 다음 예약은 '내 고객'이 아니다", async () => {
    const listing = await createListing([{ capacity: 10 }]);
    const business = await prisma.business.findUniqueOrThrow({ where: { id: listing.business.id } });
    const resolve = (phone: string) =>
      resolveCommission({
        business,
        categoryCommissionBps: null,
        channel: "MARKETPLACE",
        phone,
        quantity: 1,
        totalAmount: 30_000,
        payNowAmount: 30_000,
        settings: DEFAULT_SETTINGS,
        now: new Date(Date.now() + DAY),
      });
    await insertBooking(listing, { status: "REJECTED" });

    await addManualCustomer(listing.owner.id, listing.business.id, { name: "김손님", phone: PHONE });
    await addManualCustomer(listing.owner.id, listing.business.id, { name: "원래 단골", phone: "01088887777" });

    expect((await resolve(PHONE)).rule).not.toBe("OWN_CUSTOMER");
    // 남는자리와 상관없이 직접 등록한 고객은 그대로 '내 고객'이다.
    expect((await resolve("01088887777")).rule).toBe("OWN_CUSTOMER");
  });
});

// ───────────────────────── 조회 ─────────────────────────

describe("listCustomers", () => {
  async function seedList() {
    const { business, owner } = await createBusiness();
    const now = Date.now();
    await seedCard(business.id, { phone: "01011110001", name: "가영", bookingCount: 1, completedCount: 1, totalSpent: 30_000, lastBookingAt: new Date(now - 5 * DAY), tags: ["와인"] });
    await seedCard(business.id, { phone: "01011110002", name: "나은", bookingCount: 4, completedCount: 3, totalSpent: 120_000, lastBookingAt: new Date(now - DAY), tags: ["단골", "와인"], memo: "생일 12월" });
    await seedCard(business.id, { phone: "01011110003", name: "다현", bookingCount: 2, completedCount: 0, noShowCount: 2, totalSpent: 0, lastBookingAt: new Date(now - 3 * DAY), isBlocked: true });
    await seedCard(business.id, { phone: "01022220004", name: "Rachel", source: "IMPORTED" });
    return { business, owner };
  }

  it("기본은 최근 예약 순이고, 전화번호는 가려서 준다", async () => {
    const { business, owner } = await seedList();

    const page = await listCustomers(owner.id, business.id);

    expect(page.total).toBe(4);
    expect(page.nextCursor).toBeNull();
    // 예약 이력이 없는 카드는 맨 뒤
    expect(page.items.map((c) => c.name)).toEqual(["나은", "다현", "가영", "Rachel"]);
    const naeun = page.items[0]!;
    expect(naeun).toMatchObject({
      phoneMasked: maskPhone("01011110002"),
      source: "MARKETPLACE",
      sourceLabel: CUSTOMER_SOURCE_LABEL.MARKETPLACE,
      bookingCount: 4,
      completedCount: 3,
      totalSpent: 120_000,
      tags: ["단골", "와인"],
      hasMemo: true,
      isBlocked: false,
      isMember: false,
    });
    expect(JSON.stringify(page)).not.toContain("01011110002");
    expect(page.items[3]).toMatchObject({ source: "IMPORTED", sourceLabel: CUSTOMER_SOURCE_LABEL.IMPORTED, hasMemo: false });
  });

  it("이름·전화번호 일부로 찾고, 태그와 구분으로 거른다", async () => {
    const { business, owner } = await seedList();
    const names = async (query: Parameters<typeof listCustomers>[2]) => (await listCustomers(owner.id, business.id, query)).items.map((c) => c.name);

    expect(await names({ q: "나은" })).toEqual(["나은"]);
    expect(await names({ q: "rachel" })).toEqual(["Rachel"]);
    expect(await names({ q: "2222" })).toEqual(["Rachel"]);
    expect(await names({ q: "010-1111" })).toEqual(["나은", "다현", "가영"]);
    expect(await names({ q: "없는이름" })).toEqual([]);
    expect(await names({ tag: "와인" })).toEqual(["나은", "가영"]);
    expect(await names({ tag: "단골", q: "가영" })).toEqual([]);

    expect(await names({ segment: "new" })).toEqual(["가영", "Rachel"]);
    expect(await names({ segment: "repeat" })).toEqual(["나은", "다현"]);
    expect(await names({ segment: "noshow" })).toEqual(["다현"]);
    expect(await names({ segment: "blocked" })).toEqual(["다현"]);
    expect(await names({ segment: "all" })).toHaveLength(4);
  });

  it("정렬: 이용 횟수·누적 결제액·이름", async () => {
    const { business, owner } = await seedList();
    const names = async (sort: "visits" | "spent" | "name") => (await listCustomers(owner.id, business.id, { sort })).items.map((c) => c.name);

    expect((await names("visits")).slice(0, 2)).toEqual(["나은", "가영"]);
    expect((await names("spent")).slice(0, 2)).toEqual(["나은", "가영"]);
    expect(await names("name")).toEqual(["Rachel", "가영", "나은", "다현"]);
  });

  it("쪽 나누기: nextCursor 를 그대로 넘기면 겹치지 않고 이어진다", async () => {
    const { business, owner } = await createBusiness();
    for (let i = 0; i < 7; i++) {
      await seedCard(business.id, { phone: `0103333000${i}`, name: `고객${i}`, lastBookingAt: new Date(Date.now() - i * DAY) });
    }

    const first = await listCustomers(owner.id, business.id, { limit: 3 });
    const second = await listCustomers(owner.id, business.id, { limit: 3, cursor: first.nextCursor! });
    const third = await listCustomers(owner.id, business.id, { limit: 3, cursor: second.nextCursor! });

    expect(first.total).toBe(7);
    expect(first.items.map((c) => c.name)).toEqual(["고객0", "고객1", "고객2"]);
    expect(second.items.map((c) => c.name)).toEqual(["고객3", "고객4", "고객5"]);
    expect(third.items.map((c) => c.name)).toEqual(["고객6"]);
    expect(third.nextCursor).toBeNull();
  });

  it("입력 검증: 긴 검색어, 범위를 벗어난 개수, 잘못된 위치·구분·정렬", async () => {
    const { business, owner } = await createBusiness();
    const bad: unknown[] = [
      { q: "가".repeat(41) },
      { limit: 0 },
      { limit: 101 },
      { cursor: "abc" },
      { cursor: "-1" },
      { segment: "vip" },
      { sort: "random" },
    ];
    for (const query of bad) {
      expect((await failure(listCustomers(owner.id, business.id, query as never))).code).toBe("VALIDATION");
    }
  });
});

describe("getCustomer · getCustomerStats", () => {
  it("상세에는 전체 번호·메모와 그 사업장에서의 예약 이력이 담긴다", async () => {
    const listing = await createListing([{ label: "일반석", capacity: 10 }]);
    const other = await createListing();
    const member = await createUser();
    const customer = await seedCard(listing.business.id, { phone: PHONE, name: "김손님", userId: member.id, memo: "창가 선호" });
    const insert = (l: typeof listing, overrides: Partial<Prisma.BookingUncheckedCreateInput>) =>
      prisma.booking.create({
        data: {
          code: newBookingCode(),
          businessId: l.business.id,
          productId: l.product.id,
          slotId: l.slot.id,
          slotSeatId: l.seat.id,
          quantity: 1,
          unitPrice: 30_000,
          totalAmount: 30_000,
          payNowAmount: 30_000,
          status: "CONFIRMED",
          paymentMethod: "ONLINE",
          guestName: "김손님",
          guestPhone: PHONE,
          policySnapshot: [],
          checkinToken: newToken(),
          ...overrides,
        },
      });
    const byPhone = await insert(listing, { status: "CANCELLED", createdAt: new Date(Date.now() - 2 * DAY) });
    // 회원으로 연결된 예약은 번호가 달라도 이력에 들어간다.
    const byUser = await insert(listing, { userId: member.id, guestPhone: "01099990000", quantity: 2, totalAmount: 60_000, payNowAmount: 60_000 });
    await insert(listing, { guestPhone: "01000000000" });
    await insert(other, {});

    const detail = await getCustomer(listing.owner.id, customer.id);

    expect(detail).toMatchObject({ id: customer.id, businessId: listing.business.id, name: "김손님", phone: PHONE, memo: "창가 선호", isMember: true });
    expect(detail.bookings.map((b) => b.id)).toEqual([byUser.id, byPhone.id]);
    expect(detail.bookings[0]).toMatchObject({
      code: byUser.code,
      status: "CONFIRMED",
      channel: "MARKETPLACE",
      quantity: 2,
      totalAmount: 60_000,
      productTitle: listing.product.title,
      seatLabel: "일반석",
      slotStartAt: listing.slot.startAt,
    });
  });

  it("다른 사업장의 카드는 볼 수 없고, 없는 카드는 NOT_FOUND", async () => {
    const mine = await createBusiness();
    const theirs = await createBusiness();
    const stranger = await createUser();
    const customer = await seedCard(theirs.business.id, { phone: PHONE });

    expect((await failure(getCustomer(mine.owner.id, customer.id))).code).toBe("FORBIDDEN");
    expect((await failure(getCustomer(stranger.id, customer.id))).code).toBe("FORBIDDEN");
    expect((await failure(getCustomer(mine.owner.id, "no-such-card"))).code).toBe("NOT_FOUND");
    expect((await failure(listCustomers(mine.owner.id, theirs.business.id))).code).toBe("FORBIDDEN");
    expect((await failure(listCustomers(stranger.id, theirs.business.id))).code).toBe("FORBIDDEN");
  });

  it("고객 요약을 센다", async () => {
    const { business } = await createBusiness();
    const other = await createBusiness();
    await seedCard(business.id, { phone: "01011110001", bookingCount: 1 });
    await seedCard(business.id, { phone: "01011110002", bookingCount: 3, noShowCount: 1 });
    await seedCard(business.id, { phone: "01011110003", bookingCount: 2, isBlocked: true, firstSeenAt: new Date(Date.now() - 90 * DAY) });
    await seedCard(business.id, { phone: "01011110004", source: "IMPORTED" });
    await seedCard(other.business.id, { phone: "01011110001", bookingCount: 9 });

    expect(await getCustomerStats(business.id)).toEqual({ total: 4, firstTime: 2, repeat: 2, noShow: 1, blocked: 1, addedLast30Days: 3 });
    expect(await getCustomerStats("no-such-business")).toEqual({ total: 0, firstTime: 0, repeat: 0, noShow: 0, blocked: 0, addedLast30Days: 0 });
  });
});

// ───────────────────────── 변경 ─────────────────────────

describe("updateCustomer", () => {
  it("넘긴 항목만 바꾸고, 차단·해제는 감사 로그에 남긴다", async () => {
    const { business, owner } = await createBusiness();
    const customer = await seedCard(business.id, { phone: PHONE, name: "김손님", memo: "원래 메모", tags: ["단골"] });

    const tagged = await updateCustomer(owner.id, customer.id, { tags: [" 와인 ", "단골", "와인"] });
    expect(tagged).toMatchObject({ tags: ["와인", "단골"], memo: "원래 메모", isBlocked: false, phone: PHONE });

    const blocked = await updateCustomer(owner.id, customer.id, { isBlocked: true, memo: "  노쇼 2회  " });
    expect(blocked).toMatchObject({ isBlocked: true, memo: "노쇼 2회", tags: ["와인", "단골"] });
    // 같은 값으로 다시 저장해도 로그가 늘지 않는다.
    await updateCustomer(owner.id, customer.id, { isBlocked: true });
    expect(await audits("crm.block")).toHaveLength(1);
    expect((await audits("crm.block"))[0]).toMatchObject({ actorId: owner.id, actorType: "SELLER", targetType: "BusinessCustomer", targetId: customer.id });

    const cleared = await updateCustomer(owner.id, customer.id, { isBlocked: false, memo: "", tags: [] });
    expect(cleared).toMatchObject({ isBlocked: false, memo: null, tags: [] });
    expect(await audits("crm.unblock")).toHaveLength(1);

    // 빈 요청은 그대로 돌려준다.
    expect(await updateCustomer(owner.id, customer.id, {})).toMatchObject({ memo: null, tags: [] });
    // 이름·전화번호·유입 경로는 이 함수로 바꿀 수 없다.
    await updateCustomer(owner.id, customer.id, { name: "다른이름", phone: "01000000000", source: "MANUAL", memo: "메모" } as never);
    expect(await cardOrThrow(business.id)).toMatchObject({ name: "김손님", phone: PHONE, source: "MARKETPLACE", memo: "메모" });
  });

  it("입력 검증: 태그 10개·12자, 메모 1,000자", async () => {
    const { business, owner } = await createBusiness();
    const customer = await seedCard(business.id, { phone: PHONE });

    const tooMany = await failure(updateCustomer(owner.id, customer.id, { tags: Array.from({ length: 11 }, (_, i) => `태그${i}`) }));
    expect(tooMany.code).toBe("VALIDATION");
    expect(tooMany.fieldErrors).toHaveProperty("tags");
    expect((await failure(updateCustomer(owner.id, customer.id, { tags: ["가".repeat(13)] }))).code).toBe("VALIDATION");
    expect((await failure(updateCustomer(owner.id, customer.id, { tags: ["  "] }))).code).toBe("VALIDATION");
    expect((await failure(updateCustomer(owner.id, customer.id, { memo: "가".repeat(1001) }))).fieldErrors).toHaveProperty("memo");
    expect((await failure(updateCustomer(owner.id, customer.id, { isBlocked: "yes" } as never))).code).toBe("VALIDATION");

    // 경계값은 통과한다.
    const ok = await updateCustomer(owner.id, customer.id, {
      tags: Array.from({ length: 10 }, (_, i) => `${"가".repeat(11)}${i}`),
      memo: "가".repeat(1000),
    });
    expect(ok.tags).toHaveLength(10);
    expect(ok.memo).toHaveLength(1000);
  });

  it("스태프는 볼 수만 있고, 매니저부터 고칠 수 있다. 다른 사업장은 못 건드린다", async () => {
    const { business } = await createBusiness();
    const outsider = await createBusiness();
    const staff = await addMember(business.id, "STAFF");
    const manager = await addMember(business.id, "MANAGER");
    const customer = await seedCard(business.id, { phone: PHONE });

    expect((await listCustomers(staff.id, business.id)).items).toHaveLength(1);
    expect((await getCustomer(staff.id, customer.id)).phone).toBe(PHONE);
    expect((await failure(updateCustomer(staff.id, customer.id, { isBlocked: true }))).code).toBe("FORBIDDEN");
    expect((await failure(updateCustomer(outsider.owner.id, customer.id, { isBlocked: true }))).code).toBe("FORBIDDEN");
    expect((await cardOrThrow(business.id)).isBlocked).toBe(false);

    expect((await updateCustomer(manager.id, customer.id, { isBlocked: true })).isBlocked).toBe(true);
    expect((await failure(updateCustomer(manager.id, "no-such-card", { isBlocked: true }))).code).toBe("NOT_FOUND");
  });
});

describe("addManualCustomer", () => {
  it("직접 등록한 카드는 MANUAL 로 만들어지고 번호는 숫자만 저장한다", async () => {
    const { business, owner } = await createBusiness();

    const created = await addManualCustomer(owner.id, business.id, { name: " 박단골 ", phone: "010-2222-3333", memo: "전화 예약 손님", tags: ["전화"] });

    expect(created).toMatchObject({ name: "박단골", phone: "01022223333", source: "MANUAL", memo: "전화 예약 손님", tags: ["전화"], bookingCount: 0, bookings: [] });
    expect(await cardOrThrow(business.id, "01022223333")).toMatchObject({ source: "MANUAL", userId: null });
    const [log] = await audits("crm.add");
    expect(log).toMatchObject({ actorId: owner.id, targetId: created.id });
    expect(JSON.stringify(log!.meta)).not.toContain("01022223333");
    expect(JSON.stringify(log!.meta)).not.toContain("박단골");
  });

  it("이미 카드가 있는 번호는 덮어쓰지 않고 CONFLICT", async () => {
    const { business, owner } = await createBusiness();
    await seedCard(business.id, { phone: PHONE, name: "남는자리 고객", source: "MARKETPLACE" });

    const error = await failure(addManualCustomer(owner.id, business.id, { name: "바꿔치기", phone: PHONE }));

    expect(error.code).toBe("CONFLICT");
    expect(error.fieldErrors).toHaveProperty("phone");
    expect(await cardOrThrow(business.id)).toMatchObject({ name: "남는자리 고객", source: "MARKETPLACE" });
  });

  it("입력 검증과 권한", async () => {
    const { business, owner } = await createBusiness();
    const outsider = await createBusiness();
    const staff = await addMember(business.id, "STAFF");
    const manager = await addMember(business.id, "MANAGER");

    expect((await failure(addManualCustomer(owner.id, business.id, { name: "", phone: PHONE }))).fieldErrors).toHaveProperty("name");
    expect((await failure(addManualCustomer(owner.id, business.id, { name: "가".repeat(31), phone: PHONE }))).fieldErrors).toHaveProperty("name");
    expect((await failure(addManualCustomer(owner.id, business.id, { name: "줄\n바꿈", phone: PHONE }))).fieldErrors).toHaveProperty("name");
    for (const phone of ["", "042-123-4567", "010-123", "abcdefghijk"]) {
      expect((await failure(addManualCustomer(owner.id, business.id, { name: "홍길동", phone }))).fieldErrors).toHaveProperty("phone");
    }
    expect((await failure(addManualCustomer(owner.id, business.id, { name: "홍길동", phone: PHONE, memo: "가".repeat(1001) }))).code).toBe("VALIDATION");
    expect((await failure(addManualCustomer(owner.id, business.id, { name: "홍길동", phone: PHONE, tags: ["가".repeat(13)] }))).code).toBe("VALIDATION");

    expect((await failure(addManualCustomer(staff.id, business.id, { name: "홍길동", phone: PHONE }))).code).toBe("FORBIDDEN");
    expect((await failure(addManualCustomer(outsider.owner.id, business.id, { name: "홍길동", phone: PHONE }))).code).toBe("FORBIDDEN");
    expect(await prisma.businessCustomer.count()).toBe(0);

    expect((await addManualCustomer(manager.id, business.id, { name: "홍길동", phone: PHONE })).source).toBe("MANUAL");
  });
});

describe("importCustomers", () => {
  it("올바른 줄만 IMPORTED 로 등록하고, 틀린 줄·겹친 줄·이미 있는 번호를 나눠 알려 준다", async () => {
    const { business, owner } = await createBusiness();
    await seedCard(business.id, { phone: "01011112222", name: "기존 고객", source: "MARKETPLACE", memo: "기존 메모", bookingCount: 3 });

    const result = await importCustomers(owner.id, business.id, [
      { name: "김하나", phone: "010-1000-0001", memo: "소개 손님", tags: ["지인"] },
      { name: "이두리", phone: "01010000002" },
      { name: "", phone: "01010000003" },
      { name: "박세찌", phone: "02-123-4567" },
      { name: "최네찌", phone: "010 1000 0001" },
      { name: "덮어쓰기", phone: "010-1111-2222", memo: "새 메모" },
      { name: "정다섯", phone: "01010000005", memo: "가".repeat(1001) },
      { name: "한여섯", phone: "01010000006", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) },
      { name: "=cmd|' /C calc'!A0", phone: "01010000007" },
    ]);

    expect(result.created).toBe(3);
    expect(result.skippedExisting).toBe(1);
    expect(result.invalid.map((i) => i.row)).toEqual([3, 4, 5, 7, 8]);
    for (const item of result.invalid) expect(item.reason.length).toBeGreaterThan(0);
    expect(result.invalid.find((i) => i.row === 5)!.reason).toContain("전화번호");
    expect(result.created + result.skippedExisting + result.invalid.length).toBe(9);

    expect(await cardOrThrow(business.id, "01010000001")).toMatchObject({ name: "김하나", source: "IMPORTED", memo: "소개 손님", tags: ["지인"], bookingCount: 0, userId: null });
    expect(await cardOrThrow(business.id, "01010000002")).toMatchObject({ name: "이두리", source: "IMPORTED", memo: null, tags: [] });
    // 수식처럼 보이는 이름도 글자 그대로 저장한다(내보낼 때 안전하게 바꾼다).
    expect((await cardOrThrow(business.id, "01010000007")).name).toBe("=cmd|' /C calc'!A0");
    // 이미 있던 카드는 그대로다.
    expect(await cardOrThrow(business.id, "01011112222")).toMatchObject({ name: "기존 고객", source: "MARKETPLACE", memo: "기존 메모", bookingCount: 3 });
    expect(await prisma.businessCustomer.count({ where: { businessId: business.id } })).toBe(4);
  });

  it("감사 로그에는 건수만 남는다(이름·전화번호 없음)", async () => {
    const { business, owner } = await createBusiness();

    await importCustomers(owner.id, business.id, [
      { name: "김비밀", phone: "01077778888" },
      { name: "이비밀", phone: "잘못된번호" },
    ]);

    const [log] = await audits("crm.import");
    expect(log).toMatchObject({ actorId: owner.id, actorType: "SELLER", targetType: "Business", targetId: business.id });
    expect(log!.meta).toEqual({ rows: 2, created: 1, skippedExisting: 0, invalid: 1 });
    const serialized = JSON.stringify(log);
    for (const secret of ["김비밀", "이비밀", "01077778888", "잘못된번호"]) expect(serialized).not.toContain(secret);
  });

  it("다시 가져와도 카드가 겹치지 않고, 동시에 가져와도 한 장씩만 생긴다", async () => {
    const { business, owner } = await createBusiness();
    const rows = Array.from({ length: 40 }, (_, i) => ({ name: `고객${i}`, phone: `010555500${String(i).padStart(2, "0")}` }));

    const results = await Promise.all([importCustomers(owner.id, business.id, rows), importCustomers(owner.id, business.id, rows)]);

    expect(results[0].created + results[1].created).toBe(40);
    expect(results[0].skippedExisting + results[1].skippedExisting).toBe(40);
    expect(await prisma.businessCustomer.count({ where: { businessId: business.id } })).toBe(40);

    const again = await importCustomers(owner.id, business.id, rows.slice(0, 5));
    expect(again).toEqual({ created: 0, skippedExisting: 5, invalid: [] });
  });

  it("한 번에 1~1,000줄만 받는다", async () => {
    const { business, owner } = await createBusiness();
    const many = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({ name: `고객${i}`, phone: `0106${String(i).padStart(7, "0")}` }));

    expect((await failure(importCustomers(owner.id, business.id, []))).code).toBe("VALIDATION");
    expect((await failure(importCustomers(owner.id, business.id, many))).code).toBe("VALIDATION");
    expect((await failure(importCustomers(owner.id, business.id, "not-an-array" as never))).code).toBe("VALIDATION");
    expect(await prisma.businessCustomer.count()).toBe(0);

    const result = await importCustomers(owner.id, business.id, many.slice(0, MAX_IMPORT_ROWS));
    expect(result).toEqual({ created: MAX_IMPORT_ROWS, skippedExisting: 0, invalid: [] });
  });

  it("형식이 깨진 줄(문자열이 아닌 값 등)도 전체를 막지 않고 그 줄만 돌려준다", async () => {
    const { business, owner } = await createBusiness();
    const rows = [null, { name: 123, phone: 1012345678 }, { phone: "01012345678" }, { name: "정상", phone: "01012345678" }] as never;

    const result = await importCustomers(owner.id, business.id, rows);

    expect(result.created).toBe(1);
    expect(result.invalid.map((i) => i.row)).toEqual([1, 2, 3]);
  });

  it("매니저 이상만, 자기 사업장에만 가져올 수 있다", async () => {
    const { business } = await createBusiness();
    const outsider = await createBusiness();
    const staff = await addMember(business.id, "STAFF");
    const manager = await addMember(business.id, "MANAGER");
    const rows = [{ name: "홍길동", phone: PHONE }];

    expect((await failure(importCustomers(staff.id, business.id, rows))).code).toBe("FORBIDDEN");
    expect((await failure(importCustomers(outsider.owner.id, business.id, rows))).code).toBe("FORBIDDEN");
    expect(await prisma.businessCustomer.count()).toBe(0);
    expect(await audits("crm.import")).toHaveLength(0);

    expect((await importCustomers(manager.id, business.id, rows)).created).toBe(1);
  });
});

// ───────────────────────── 내보내기 ─────────────────────────

describe("exportCustomersCsv", () => {
  const exportablePlans = (Object.keys(PLAN_FEATURES) as (keyof typeof PLAN_FEATURES)[]).filter((plan) => PLAN_FEATURES[plan].customerExport);
  const lockedPlans = (Object.keys(PLAN_FEATURES) as (keyof typeof PLAN_FEATURES)[]).filter((plan) => !PLAN_FEATURES[plan].customerExport);

  it("내보내기 기능이 없는 플랜은 FORBIDDEN, 있는 플랜은 CSV 를 받는다", async () => {
    expect(exportablePlans.length).toBeGreaterThan(0);
    for (const plan of lockedPlans) {
      const { business, owner } = await createBusiness({ plan });
      await seedCard(business.id, { phone: PHONE });
      const error = await failure(exportCustomersCsv(owner.id, business.id));
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toContain(PLAN_FEATURES.PRO.label);
    }
    expect(await audits("crm.export")).toHaveLength(0);

    for (const plan of exportablePlans) {
      const { business, owner } = await createBusiness({ plan });
      await seedCard(business.id, { phone: PHONE });
      expect((await exportCustomersCsv(owner.id, business.id)).count).toBe(1);
    }
    expect(await audits("crm.export")).toHaveLength(exportablePlans.length);
  });

  it("BOM 으로 시작하고, 수식으로 읽힐 수 있는 칸은 작은따옴표를 붙여 문자로 만든다", async () => {
    const { business, owner } = await createBusiness({ plan: exportablePlans[0]! });
    const other = await createBusiness({ plan: exportablePlans[0]! });
    await seedCard(business.id, {
      phone: "01010000001",
      name: "=HYPERLINK(\"http://evil.example\",\"click\")",
      memo: "+82 로 연락",
      tags: ["-할인", "@멘션"],
      bookingCount: 2,
      completedCount: 1,
      totalSpent: 45_000,
      lastBookingAt: new Date("2026-11-20T10:30:00Z"),
      isBlocked: true,
    });
    await seedCard(business.id, { phone: "01010000002", name: "\t탭으로 시작", memo: "\r캐리지리턴" });
    await seedCard(business.id, { phone: "01010000003", name: "김정상", memo: "쉼표, 따옴표 \" 그리고\n줄바꿈", source: "IMPORTED" });
    await seedCard(other.business.id, { phone: "01099999999", name: "남의 고객" });

    const file = await exportCustomersCsv(owner.id, business.id);

    expect(file.count).toBe(3);
    expect(file.filename).toMatch(/^customers-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(file.content.charCodeAt(0)).toBe(0xfeff);
    expect(file.content).not.toContain("남의 고객");

    const body = file.content.slice(1);
    // 위험한 첫 글자로 시작하는 칸이 하나도 없어야 한다(모든 칸은 큰따옴표로 감싸고, 위험한 칸은 ' 로 시작).
    const cells = [...body.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell).not.toMatch(/^[=+\-@\t\r]/);

    expect(body).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(body).toContain(`"'+82 로 연락"`);
    expect(body).toContain(`"'-할인 @멘션"`);
    expect(body).toContain(`"'\t탭으로 시작"`);
    expect(body).toContain(`"'\r캐리지리턴"`);
    expect(body).toContain(`"쉼표, 따옴표 "" 그리고\n줄바꿈"`);
    // 전화번호는 하이픈을 넣어 문자로 내보낸다(앞자리 0 이 지워지지 않게).
    expect(body).toContain(`"${formatPhone("01010000001")}"`);
    expect(body).toContain(`"${CUSTOMER_SOURCE_LABEL.IMPORTED}"`);
    expect(body).toContain(`"45000"`);
    expect(body).toContain(`"차단"`);

    // 머리글 한 줄 + 고객 3줄(메모 안의 줄바꿈은 줄 구분이 아니다)
    expect(body.split("\r\n").filter((line) => line.length > 0)).toHaveLength(4 + 0);
    const header = body.split("\r\n")[0]!;
    expect(header.split(",")[0]).toBe(`"이름"`);
    expect(header.split(",")).toHaveLength(14);
  });

  it("내보낸 사실과 건수를 감사 로그에 남기고, 매니저 이상만 할 수 있다", async () => {
    const { business, owner } = await createBusiness({ plan: exportablePlans[0]! });
    const outsider = await createBusiness({ plan: exportablePlans[0]! });
    const staff = await addMember(business.id, "STAFF");
    const manager = await addMember(business.id, "MANAGER");
    await seedCard(business.id, { phone: PHONE, name: "김비밀" });
    await seedCard(business.id, { phone: "01000002222", name: "이비밀" });

    expect((await failure(exportCustomersCsv(staff.id, business.id))).code).toBe("FORBIDDEN");
    expect((await failure(exportCustomersCsv(outsider.owner.id, business.id))).code).toBe("FORBIDDEN");
    expect(await audits("crm.export")).toHaveLength(0);

    await exportCustomersCsv(manager.id, business.id);
    await exportCustomersCsv(owner.id, business.id);

    const logs = await audits("crm.export");
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ actorId: manager.id, actorType: "SELLER", targetType: "Business", targetId: business.id, meta: { count: 2 } });
    expect(JSON.stringify(logs)).not.toContain("김비밀");
    expect(JSON.stringify(logs)).not.toContain(PHONE);
  });
});
