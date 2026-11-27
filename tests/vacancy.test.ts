import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingStatus, Prisma, SlotStatus, VacancyOrigin } from "@/generated/prisma/client";
import { newBookingCode, newToken } from "@/lib/ids";
import { DAY, HOUR, MINUTE } from "@/lib/time";
import { prisma } from "@/server/db";
import {
  SEAT_RELEASE_REASONS,
  afterSeatsReleased,
  setWaitlistProcessor,
  type SeatReleaseContext,
  type SeatReleaseReason,
  type WaitlistProcessResult,
} from "@/server/services/vacancy";
import { createListing, createUser, resetDb, type SeatSpec } from "./helpers";

beforeEach(async () => {
  await resetDb();
  setWaitlistProcessor(null);
});

afterEach(() => {
  setWaitlistProcessor(null);
  vi.restoreAllMocks();
});

/** 회차를 올린 지 이틀 지난 것으로 만든다(등록 시각이 갱신됐는지 견주기 위해). */
const POSTED_AT = new Date(Date.now() - 2 * DAY);

type Listing = Awaited<ReturnType<typeof createListing>>;

/** 예약 가능한 회차(48시간 뒤 시작). reserved 로 좌석 유형별 예약 수를 정한다. */
async function listing(
  options: { seats?: SeatSpec[]; reserved?: number[]; withheld?: number[]; origin?: VacancyOrigin; status?: SlotStatus; startsInHours?: number } = {},
): Promise<Listing> {
  const created = await createListing(options.seats ?? [{ capacity: 4 }], {
    origin: options.origin ?? "REGULAR",
    status: options.status ?? "OPEN",
    startsInHours: options.startsInHours ?? 48,
    vacancyPostedAt: POSTED_AT,
  });
  for (const [i, seat] of created.slot.seats.entries()) {
    const reserved = options.reserved?.[i] ?? 0;
    const withheld = options.withheld?.[i] ?? 0;
    if (reserved > 0 || withheld > 0) await prisma.slotSeat.update({ where: { id: seat.id }, data: { reserved, withheld } });
  }
  return created;
}

async function follower(businessId: string) {
  const user = await createUser();
  await prisma.follow.create({ data: { userId: user.id, businessId } });
  return user;
}

const loadSlot = (id: string) => prisma.slot.findUniqueOrThrow({ where: { id } });
const vacancyAlerts = (userId: string) => prisma.notification.findMany({ where: { userId, type: "VACANCY_ALERT" } });
const sellerAlerts = (userId: string) => prisma.notification.findMany({ where: { userId, type: "SELLER_SEAT_RELEASED" } });
const alertReason = (n: { data: Prisma.JsonValue | null }) => (n.data as { reason?: string } | null)?.reason;

const released = (reason: SeatReleaseReason, overrides: Partial<SeatReleaseContext> = {}): SeatReleaseContext => ({
  reason,
  quantity: 1,
  withheld: false,
  ...overrides,
});

/** 대기 처리기 대역: 불린 좌석 ID 를 기록하고 정해 둔 결과를 돌려준다. */
function registerProcessor(result: WaitlistProcessResult | (() => Promise<WaitlistProcessResult>)) {
  const calls: string[] = [];
  setWaitlistProcessor(async (slotSeatId) => {
    calls.push(slotSeatId);
    return typeof result === "function" ? result() : result;
  });
  return calls;
}

async function insertBooking(l: Listing, seatId: string, overrides: Partial<Prisma.BookingUncheckedCreateInput> = {}) {
  return prisma.booking.create({
    data: {
      code: newBookingCode(),
      businessId: l.business.id,
      productId: l.product.id,
      slotId: l.slot.id,
      slotSeatId: seatId,
      quantity: 1,
      unitPrice: 30_000,
      totalAmount: 30_000,
      payNowAmount: 30_000,
      status: "CANCELLED",
      paymentMethod: "ONLINE",
      guestName: "김손님",
      guestPhone: "01012345678",
      policySnapshot: [],
      checkinToken: newToken(),
      ...overrides,
    },
  });
}

// ───────────────────────── 보류 좌석 ─────────────────────────

describe("보류(withheld)로 닫힌 좌석", () => {
  it("사업자에게만 다시 올릴지 묻고, 대기·공개 흐름은 타지 않는다", async () => {
    const l = await listing({ reserved: [3], withheld: [1] });
    const fan = await follower(l.business.id);
    const calls = registerProcessor({ offered: 1, broadcast: 0, remainingPublic: 0 });

    const result = await afterSeatsReleased(l.seat.id, released("CANCELLATION", { withheld: true }));

    expect(result).toEqual({ path: "WITHHELD", offered: 0, broadcast: 0, remainingPublic: 0, notified: 0 });
    const toSeller = await sellerAlerts(l.owner.id);
    expect(toSeller).toHaveLength(1);
    expect(toSeller[0]!.data).toMatchObject({ slotId: l.slot.id, quantity: 1 });
    expect(await vacancyAlerts(fan.id)).toHaveLength(0);
    expect(calls).toEqual([]);
    // 닫혀 있는 자리이므로 회차에는 아무 표시도 하지 않는다.
    expect(await loadSlot(l.slot.id)).toMatchObject({ origin: "REGULAR", vacancyPostedAt: POSTED_AT });
    expect(await prisma.slotSeat.findUniqueOrThrow({ where: { id: l.seat.id } })).toMatchObject({ reserved: 3, withheld: 1 });
  });

  it("알리는 좌석 수는 실제로 보류돼 있는 수를 넘지 않는다", async () => {
    const l = await listing({ reserved: [4], withheld: [2] });

    await afterSeatsReleased(l.seat.id, released("CANCELLATION", { withheld: true, quantity: 3 }));

    const [alert] = await sellerAlerts(l.owner.id);
    expect(alert!.data).toMatchObject({ quantity: 2 });
  });

  it.each<[string, Parameters<typeof listing>[0]]>([
    ["취소된 회차", { reserved: [2], withheld: [1], status: "CANCELLED" }],
    ["이미 시작한 회차", { reserved: [2], withheld: [1], startsInHours: -1 }],
    ["그사이 사업자가 이미 다시 올려 보류분이 없는 좌석", { reserved: [2], withheld: [0] }],
  ])("%s 는 묻지 않는다", async (_name, options) => {
    const l = await listing(options);

    const result = await afterSeatsReleased(l.seat.id, released("CANCELLATION", { withheld: true }));

    expect(result.path).toBe("SKIPPED");
    expect(await sellerAlerts(l.owner.id)).toHaveLength(0);
  });
});

// ───────────────────────── 공개 반환 ─────────────────────────

describe("공개로 돌아온 좌석", () => {
  it("취소석: 일반 판매 회차를 취소석으로 바꾸고 등록 시각을 갱신한 뒤, 팔로워에게 취소 자리로 알린다", async () => {
    const l = await listing({ reserved: [2] });
    const fan = await follower(l.business.id);
    const canceller = await follower(l.business.id);
    const startedAt = Date.now();

    const result = await afterSeatsReleased(l.seat.id, released("CANCELLATION", { excludeUserIds: [canceller.id] }));

    expect(result).toEqual({ path: "PROCESSED", offered: 0, broadcast: 0, remainingPublic: 2, notified: 1 });
    const slot = await loadSlot(l.slot.id);
    expect(slot.origin).toBe("CANCELLATION");
    expect(slot.vacancyPostedAt.getTime()).toBeGreaterThanOrEqual(startedAt);
    const alerts = await vacancyAlerts(fan.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data).toMatchObject({ slotId: l.slot.id, reason: "REOPENED" });
    // 방금 취소한 본인과 사업장 구성원에게는 알리지 않는다.
    expect(await vacancyAlerts(canceller.id)).toHaveLength(0);
    expect(await vacancyAlerts(l.owner.id)).toHaveLength(0);
    expect(await sellerAlerts(l.owner.id)).toHaveLength(0);
  });

  it.each<VacancyOrigin>(["NO_SHOW", "UNSOLD", "CANCELLATION"])("취소석: 공석 사유가 이미 %s 인 회차는 사유를 그대로 두고 등록 시각만 갱신한다", async (origin) => {
    const l = await listing({ reserved: [1], origin });
    const startedAt = Date.now();

    await afterSeatsReleased(l.seat.id, released("CANCELLATION"));

    const slot = await loadSlot(l.slot.id);
    expect(slot.origin).toBe(origin);
    expect(slot.vacancyPostedAt.getTime()).toBeGreaterThanOrEqual(startedAt);
  });

  it("보류 좌석을 다시 올리면(RELIST) 취소석으로 공개한다", async () => {
    const l = await listing({ reserved: [3] });
    const fan = await follower(l.business.id);
    const startedAt = Date.now();

    const result = await afterSeatsReleased(l.seat.id, released("RELIST", { quantity: 1 }));

    expect(result).toMatchObject({ path: "PROCESSED", remainingPublic: 1, notified: 1 });
    const slot = await loadSlot(l.slot.id);
    expect(slot.origin).toBe("CANCELLATION");
    expect(slot.vacancyPostedAt.getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(alertReason((await vacancyAlerts(fan.id))[0]!)).toBe("REOPENED");
  });

  it.each<SeatReleaseReason>(["EXPIRED", "REJECTED"])("%s: 취소가 아닌 반환은 취소석으로 표시하지 않고, 회차에 기록된 공석 사유대로 알린다", async (reason) => {
    const regular = await listing({ reserved: [2] });
    const cancelledBefore = await listing({ reserved: [2], origin: "CANCELLATION" });
    const fanOfRegular = await follower(regular.business.id);
    const fanOfCancelled = await follower(cancelledBefore.business.id);

    expect(await afterSeatsReleased(regular.seat.id, released(reason))).toMatchObject({ path: "PROCESSED", remainingPublic: 2, notified: 1 });
    expect(await afterSeatsReleased(cancelledBefore.seat.id, released(reason))).toMatchObject({ path: "PROCESSED", notified: 1 });

    // 취소석이 아니므로 사유도 등록 시각도 그대로다.
    expect(await loadSlot(regular.slot.id)).toMatchObject({ origin: "REGULAR", vacancyPostedAt: POSTED_AT });
    expect(await loadSlot(cancelledBefore.slot.id)).toMatchObject({ origin: "CANCELLATION", vacancyPostedAt: POSTED_AT });
    // 취소가 없었던 회차를 "취소 자리"라고 알리지 않는다.
    expect(alertReason((await vacancyAlerts(fanOfRegular.id))[0]!)).toBe("NEW");
    expect(alertReason((await vacancyAlerts(fanOfCancelled.id))[0]!)).toBe("REOPENED");
  });

  it.each<SeatReleaseReason>(["CAPACITY", "REOPEN"])("%s: 사업자가 새로 연 자리는 새 자리로 알리고 회차 표시는 건드리지 않는다", async (reason) => {
    const l = await listing({ reserved: [1], origin: "CANCELLATION" });
    const fan = await follower(l.business.id);

    const result = await afterSeatsReleased(l.seat.id, released(reason, { quantity: 2 }));

    expect(result).toMatchObject({ path: "PROCESSED", remainingPublic: 3, notified: 1 });
    expect(await loadSlot(l.slot.id)).toMatchObject({ origin: "CANCELLATION", vacancyPostedAt: POSTED_AT });
    expect(alertReason((await vacancyAlerts(fan.id))[0]!)).toBe("NEW");
  });

  describe("대기 제안 만료(OFFER_EXPIRED)", () => {
    it("마지막 공석 등록 뒤에 그 좌석 유형에서 취소가 있었으면 취소석으로 공개한다", async () => {
      const l = await listing({ reserved: [3] });
      const fan = await follower(l.business.id);
      await insertBooking(l, l.seat.id, { status: "CANCELLED", cancelledAt: new Date(Date.now() - 40 * MINUTE) });
      const startedAt = Date.now();

      const result = await afterSeatsReleased(l.seat.id, released("OFFER_EXPIRED"));

      expect(result).toMatchObject({ path: "PROCESSED", remainingPublic: 1, notified: 1 });
      const slot = await loadSlot(l.slot.id);
      expect(slot.origin).toBe("CANCELLATION");
      expect(slot.vacancyPostedAt.getTime()).toBeGreaterThanOrEqual(startedAt);
      expect(alertReason((await vacancyAlerts(fan.id))[0]!)).toBe("REOPENED");

      // 한 번 공개한 취소는 다시 치지 않는다: 그 뒤의 제안 만료는 등록 시각을 또 올리지 않는다.
      const postedAt = slot.vacancyPostedAt;
      await afterSeatsReleased(l.seat.id, released("OFFER_EXPIRED"));
      expect((await loadSlot(l.slot.id)).vacancyPostedAt).toEqual(postedAt);
    });

    it.each<[string, (l: Listing) => Promise<unknown>]>([
      ["취소가 없었을 때(결제 대기 만료로 생긴 자리)", (l) => insertBooking(l, l.seat.id, { status: "EXPIRED" })],
      ["취소가 마지막 공석 등록보다 먼저였을 때", (l) => insertBooking(l, l.seat.id, { status: "CANCELLED", cancelledAt: new Date(POSTED_AT.getTime() - HOUR) })],
      ["취소가 다른 좌석 유형에서 났을 때", (l) => insertBooking(l, l.slot.seats[1]!.id, { status: "CANCELLED", cancelledAt: new Date() })],
    ])("%s 는 취소석으로 표시하지 않는다", async (_name, seed) => {
      const l = await listing({ seats: [{ label: "남성", capacity: 4 }, { label: "여성", capacity: 4 }], reserved: [3, 4] });
      const fan = await follower(l.business.id);
      await seed(l);

      const result = await afterSeatsReleased(l.seat.id, released("OFFER_EXPIRED"));

      expect(result).toMatchObject({ path: "PROCESSED", remainingPublic: 1, notified: 1 });
      expect(await loadSlot(l.slot.id)).toMatchObject({ origin: "REGULAR", vacancyPostedAt: POSTED_AT });
      expect(alertReason((await vacancyAlerts(fan.id))[0]!)).toBe("NEW");
    });
  });

  it("남은 자리가 없으면(다시 매진) 표시도 알림도 하지 않는다", async () => {
    const l = await listing({ seats: [{ label: "남성", capacity: 2 }, { label: "여성", capacity: 2 }], reserved: [2, 0] });
    const fan = await follower(l.business.id);

    // 남성석은 그사이 다시 다 찼다. 여성석에 자리가 있어도 남성석 취소를 공개했다고 하지 않는다.
    const result = await afterSeatsReleased(l.seat.id, released("CANCELLATION"));

    expect(result).toEqual({ path: "PROCESSED", offered: 0, broadcast: 0, remainingPublic: 0, notified: 0 });
    expect(await loadSlot(l.slot.id)).toMatchObject({ origin: "REGULAR", vacancyPostedAt: POSTED_AT });
    expect(await vacancyAlerts(fan.id)).toHaveLength(0);
  });

  it.each<[string, Parameters<typeof listing>[0]]>([
    ["판매를 마감한 회차", { reserved: [1], status: "CLOSED" }],
    ["취소된 회차", { reserved: [1], status: "CANCELLED" }],
    ["예약 마감이 지난 회차", { reserved: [1], startsInHours: 0.5 }],
    ["이미 시작한 회차", { reserved: [1], startsInHours: -2 }],
  ])("%s 는 건너뛴다(대기 처리기도 부르지 않는다)", async (_name, options) => {
    const l = await listing(options);
    const fan = await follower(l.business.id);
    const calls = registerProcessor({ offered: 0, broadcast: 0, remainingPublic: 3 });

    for (const reason of SEAT_RELEASE_REASONS) {
      expect((await afterSeatsReleased(l.seat.id, released(reason))).path).toBe("SKIPPED");
    }

    expect(calls).toEqual([]);
    expect(await vacancyAlerts(fan.id)).toHaveLength(0);
    expect(await loadSlot(l.slot.id)).toMatchObject({ origin: "REGULAR", vacancyPostedAt: POSTED_AT });
  });

  it("같은 회차의 뒤처리가 동시에 여러 번 돌아도 회원당 알림은 한 번이다", async () => {
    const l = await listing({ reserved: [1] });
    const fans: { id: string }[] = [];
    for (let i = 0; i < 4; i++) fans.push(await follower(l.business.id));

    const results = await Promise.all(Array.from({ length: 6 }, () => afterSeatsReleased(l.seat.id, released("CANCELLATION"))));

    expect(results.every((r) => r.path === "PROCESSED")).toBe(true);
    expect(results.reduce((sum, r) => sum + r.notified, 0)).toBe(fans.length);
    for (const fan of fans) expect(await vacancyAlerts(fan.id)).toHaveLength(1);
    expect((await loadSlot(l.slot.id)).origin).toBe("CANCELLATION");
  });
});

// ───────────────────────── 대기 처리기 ─────────────────────────

describe("대기 처리기", () => {
  it("등록한 처리기를 좌석 ID 로 부르고, 자리가 모두 대기자에게 제안되면 공개 표시·알림을 하지 않는다", async () => {
    const l = await listing({ reserved: [2] });
    const fan = await follower(l.business.id);
    // 제안은 좌석을 잡아 둔다(reserved 에 포함).
    const calls = registerProcessor(async () => {
      await prisma.slotSeat.update({ where: { id: l.seat.id }, data: { reserved: 4 } });
      return { offered: 2, broadcast: 0, remainingPublic: 0 };
    });

    const result = await afterSeatsReleased(l.seat.id, released("CANCELLATION", { quantity: 2 }));

    expect(result).toEqual({ path: "PROCESSED", offered: 2, broadcast: 0, remainingPublic: 0, notified: 0 });
    expect(calls).toEqual([l.seat.id]);
    expect(await loadSlot(l.slot.id)).toMatchObject({ origin: "REGULAR", vacancyPostedAt: POSTED_AT });
    expect(await vacancyAlerts(fan.id)).toHaveLength(0);
  });

  it("일부만 제안되고 자리가 남으면 남은 자리를 공개한다", async () => {
    const l = await listing({ reserved: [1] });
    const fan = await follower(l.business.id);
    registerProcessor(async () => {
      await prisma.slotSeat.update({ where: { id: l.seat.id }, data: { reserved: 2 } });
      return { offered: 1, broadcast: 0, remainingPublic: 2 };
    });

    const result = await afterSeatsReleased(l.seat.id, released("CANCELLATION", { quantity: 3 }));

    expect(result).toEqual({ path: "PROCESSED", offered: 1, broadcast: 0, remainingPublic: 2, notified: 1 });
    expect((await loadSlot(l.slot.id)).origin).toBe("CANCELLATION");
    expect(await vacancyAlerts(fan.id)).toHaveLength(1);
  });

  it("선착순 동시 알림만 보냈으면(좌석을 잡지 않음) 자리는 공개로 남는다", async () => {
    const l = await listing({ reserved: [2] });
    const fan = await follower(l.business.id);
    registerProcessor({ offered: 0, broadcast: 3, remainingPublic: 2 });

    const result = await afterSeatsReleased(l.seat.id, released("CANCELLATION"));

    expect(result).toEqual({ path: "PROCESSED", offered: 0, broadcast: 3, remainingPublic: 2, notified: 1 });
    expect((await loadSlot(l.slot.id)).origin).toBe("CANCELLATION");
    expect(await vacancyAlerts(fan.id)).toHaveLength(1);
  });

  it("처리기가 자리가 남았다고 해도 DB 에 남은 자리가 없으면 취소석으로 표시하지 않는다", async () => {
    const l = await listing({ reserved: [4] });
    const fan = await follower(l.business.id);
    registerProcessor({ offered: 0, broadcast: 0, remainingPublic: 1 });

    const result = await afterSeatsReleased(l.seat.id, released("CANCELLATION"));

    expect(result).toMatchObject({ path: "PROCESSED", notified: 0 });
    expect(await loadSlot(l.slot.id)).toMatchObject({ origin: "REGULAR", vacancyPostedAt: POSTED_AT });
    expect(await vacancyAlerts(fan.id)).toHaveLength(0);
  });

  it("등록을 지우면(null) 대기자가 없는 것처럼 남은 자리를 그대로 공개한다", async () => {
    const l = await listing({ reserved: [3] });
    const calls = registerProcessor({ offered: 1, broadcast: 0, remainingPublic: 0 });
    setWaitlistProcessor(null);

    const result = await afterSeatsReleased(l.seat.id, released("CANCELLATION"));

    expect(calls).toEqual([]);
    expect(result).toMatchObject({ path: "PROCESSED", offered: 0, remainingPublic: 1 });
    expect((await loadSlot(l.slot.id)).origin).toBe("CANCELLATION");
  });

  it("나중에 등록한 처리기가 앞의 것을 바꾼다", async () => {
    const l = await listing({ reserved: [3] });
    const first = registerProcessor({ offered: 0, broadcast: 0, remainingPublic: 1 });
    const second = registerProcessor({ offered: 0, broadcast: 1, remainingPublic: 1 });

    const result = await afterSeatsReleased(l.seat.id, released("EXPIRED"));

    expect(first).toEqual([]);
    expect(second).toEqual([l.seat.id]);
    expect(result.broadcast).toBe(1);
  });

  it("처리기가 실패해도 남은 자리를 DB 에서 읽어 공개 흐름을 잇는다", async () => {
    const l = await listing({ reserved: [2] });
    const fan = await follower(l.business.id);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setWaitlistProcessor(async () => {
      throw new Error("대기 처리 중 오류");
    });

    const result = await afterSeatsReleased(l.seat.id, released("CANCELLATION"));

    expect(result).toEqual({ path: "PROCESSED", offered: 0, broadcast: 0, remainingPublic: 2, notified: 1 });
    expect((await loadSlot(l.slot.id)).origin).toBe("CANCELLATION");
    expect(await vacancyAlerts(fan.id)).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain(l.seat.id);
  });

  it.each<[string, unknown]>([
    ["음수", { offered: 0, broadcast: 0, remainingPublic: -1 }],
    ["숫자가 아닌 값", { offered: 0, broadcast: 0, remainingPublic: "2" }],
    ["빠진 항목", { remainingPublic: 1 }],
    ["아무것도 돌려주지 않음", undefined],
  ])("처리기 결과가 엉뚱하면(%s) 믿지 않고 DB 의 남은 자리로 판단한다", async (_name, garbage) => {
    const l = await listing({ reserved: [1] });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setWaitlistProcessor(async () => garbage as WaitlistProcessResult);

    const result = await afterSeatsReleased(l.seat.id, released("CANCELLATION"));

    expect(result).toMatchObject({ path: "PROCESSED", offered: 0, broadcast: 0, remainingPublic: 3 });
    expect(log).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────── 실패해도 던지지 않는다 ─────────────────────────

describe("어떤 경우에도 예외를 던지지 않는다", () => {
  it("없는 좌석은 건너뛴다", async () => {
    await expect(afterSeatsReleased("no-such-seat", released("CANCELLATION"))).resolves.toMatchObject({ path: "SKIPPED" });
    await expect(afterSeatsReleased("no-such-seat", released("CANCELLATION", { withheld: true }))).resolves.toMatchObject({ path: "SKIPPED" });
  });

  it("잘못된 호출은 아무것도 하지 않고 FAILED 로 돌려준다", async () => {
    const l = await listing({ reserved: [1] });
    const fan = await follower(l.business.id);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bad: unknown[] = [
      released("CANCELLATION", { quantity: 0 }),
      released("CANCELLATION", { quantity: 1.5 }),
      released("CANCELLATION", { quantity: Number.NaN }),
      { reason: "SOMETHING_ELSE", quantity: 1, withheld: false },
      { reason: "CANCELLATION", quantity: 1, withheld: "yes" },
      { reason: "CANCELLATION", quantity: 1 },
      released("CANCELLATION", { excludeUserIds: Array.from({ length: 101 }, (_, i) => `u${i}`) }),
      null,
      undefined,
    ];

    for (const ctx of bad) {
      await expect(afterSeatsReleased(l.seat.id, ctx as SeatReleaseContext)).resolves.toMatchObject({ path: "FAILED", notified: 0 });
    }
    for (const seatId of ["", "x".repeat(65), 42, null]) {
      await expect(afterSeatsReleased(seatId as string, released("CANCELLATION"))).resolves.toMatchObject({ path: "FAILED" });
    }

    expect(await vacancyAlerts(fan.id)).toHaveLength(0);
    expect(await loadSlot(l.slot.id)).toMatchObject({ origin: "REGULAR", vacancyPostedAt: POSTED_AT });
    expect(log).toHaveBeenCalled();
  });

  it("DB 오류가 나도 던지지 않고, 로그에는 좌석 ID 말고는 남기지 않는다", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // 0x00 은 Postgres 가 받지 않는 문자라 조회 자체가 실패한다.
    const brokenId = "seat\u0000id";

    await expect(afterSeatsReleased(brokenId, released("CANCELLATION"))).resolves.toMatchObject({ path: "FAILED" });
    await expect(afterSeatsReleased(brokenId, released("CANCELLATION", { withheld: true }))).resolves.toMatchObject({ path: "FAILED" });

    expect(log).toHaveBeenCalledTimes(2);
    for (const call of log.mock.calls) expect(String(call[0])).toMatch(/^\[vacancy\] 좌석 반환 뒤처리 실패 seat=/);
  });

  it("실패 로그에는 좌석 ID 와 사유만 남기고 고객 정보는 남기지 않는다", async () => {
    const l = await listing({ reserved: [2] });
    const statuses: BookingStatus[] = ["CONFIRMED", "PENDING_PAYMENT", "CANCELLED"];
    for (const status of statuses) await insertBooking(l, l.seat.id, { status, cancelledAt: status === "CANCELLED" ? new Date() : null });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setWaitlistProcessor(async () => {
      throw new Error("boom");
    });

    for (const reason of SEAT_RELEASE_REASONS) await afterSeatsReleased(l.seat.id, released(reason));

    expect(log).toHaveBeenCalledTimes(SEAT_RELEASE_REASONS.length);
    for (const call of log.mock.calls) {
      const message = String(call[0]);
      expect(message).toMatch(new RegExp(`^\\[vacancy\\] 대기 처리 실패 seat=${l.seat.id} reason=[A-Z_]+$`));
      expect(message).not.toContain("01012345678");
      expect(message).not.toContain("김손님");
    }
  });
});
