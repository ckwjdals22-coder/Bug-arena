import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { newBookingCode, newToken } from "@/lib/ids";
import { prisma } from "@/server/db";
import {
  confirmedCountBySeat,
  lockSeat,
  releaseSeats,
  relistWithheld,
  reserveSeats,
  verifyInventoryIntegrity,
} from "@/server/services/inventory";
import { createListing, createUser, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

type Listing = Awaited<ReturnType<typeof createListing>>;

const loadSeat = (id: string) => prisma.slotSeat.findUniqueOrThrow({ where: { id } });
const setSeat = (id: string, data: { reserved?: number; withheld?: number }) => prisma.slotSeat.update({ where: { id }, data });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const reserve = (seatId: string, qty: number) => prisma.$transaction((tx) => reserveSeats(tx, seatId, qty));
const release = (seatId: string, qty: number, withhold: boolean) => prisma.$transaction((tx) => releaseSeats(tx, seatId, qty, { withhold }));
const relist = (seatId: string, qty?: number) => prisma.$transaction((tx) => relistWithheld(tx, seatId, qty));

/** 재고 숫자는 건드리지 않고 예약 행만 만든다(점검 함수 시험용). */
async function insertBooking(listing: Listing, seatId: string, overrides: Partial<Prisma.BookingUncheckedCreateInput> = {}) {
  const quantity = overrides.quantity ?? 1;
  return prisma.booking.create({
    data: {
      code: newBookingCode(),
      businessId: listing.business.id,
      productId: listing.product.id,
      slotId: listing.slot.id,
      slotSeatId: seatId,
      quantity,
      unitPrice: 30000,
      totalAmount: 30000 * quantity,
      payNowAmount: 30000 * quantity,
      status: "CONFIRMED",
      paymentMethod: "ONLINE",
      paymentState: "PAID",
      guestName: "김손님",
      guestPhone: "01012345678",
      policySnapshot: [],
      checkinToken: newToken(),
      ...overrides,
    },
  });
}

describe("reserveSeats", () => {
  it("남은 자리 안에서만 reserved 를 늘린다", async () => {
    const { seat } = await createListing([{ capacity: 4 }]);

    expect(await reserve(seat.id, 3)).toBe(true);
    expect(await loadSeat(seat.id)).toMatchObject({ reserved: 3, withheld: 0 });

    // 2자리는 모자라므로 아무것도 바뀌지 않는다.
    expect(await reserve(seat.id, 2)).toBe(false);
    expect((await loadSeat(seat.id)).reserved).toBe(3);

    expect(await reserve(seat.id, 1)).toBe(true);
    expect(await reserve(seat.id, 1)).toBe(false);
    expect((await loadSeat(seat.id)).reserved).toBe(4);
  });

  it("보류 좌석은 reserved 에 들어 있어 예약할 수 없다", async () => {
    const { seat } = await createListing([{ capacity: 3 }]);
    await setSeat(seat.id, { reserved: 2, withheld: 2 });

    expect(await reserve(seat.id, 2)).toBe(false);
    expect(await reserve(seat.id, 1)).toBe(true);
    expect(await loadSeat(seat.id)).toMatchObject({ reserved: 3, withheld: 2 });
  });

  it("없는 좌석이면 false, 수량이 1 이상의 정수가 아니면 예외", async () => {
    const { seat } = await createListing([{ capacity: 4 }]);
    expect(await reserve("no-such-seat", 1)).toBe(false);

    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(reserve(seat.id, bad)).rejects.toThrow(RangeError);
      await expect(release(seat.id, bad, false)).rejects.toThrow(RangeError);
      await expect(relist(seat.id, bad)).rejects.toThrow(RangeError);
    }
    expect(await loadSeat(seat.id)).toMatchObject({ reserved: 0, withheld: 0 });
  });

  it("5자리에 50명이 동시에 1자리씩 잡으면 정확히 5명만 성공한다", async () => {
    const { seat } = await createListing([{ capacity: 5 }]);

    const results = await Promise.all(Array.from({ length: 50 }, () => reserve(seat.id, 1)));

    expect(results.filter(Boolean)).toHaveLength(5);
    expect((await loadSeat(seat.id)).reserved).toBe(5);
  });

  it("수량이 섞인 동시 요청도 정원을 넘지 않는다", async () => {
    const { seat } = await createListing([{ capacity: 7 }]);
    const quantities = Array.from({ length: 30 }, (_, i) => (i % 3) + 1);

    const results = await Promise.all(quantities.map((qty) => reserve(seat.id, qty)));

    const granted = quantities.filter((_, i) => results[i]).reduce((sum, qty) => sum + qty, 0);
    const after = await loadSeat(seat.id);
    expect(after.reserved).toBe(granted);
    expect(granted).toBeLessThanOrEqual(7);
    // 1자리짜리 요청이 섞여 있으므로 끝까지 채워진다.
    expect(granted).toBe(7);
  });
});

describe("releaseSeats", () => {
  it("공개 반환: reserved 를 줄여 다시 예약할 수 있게 한다", async () => {
    const { seat } = await createListing([{ capacity: 4 }]);
    await setSeat(seat.id, { reserved: 3 });

    expect(await release(seat.id, 2, false)).toBe(true);
    expect(await loadSeat(seat.id)).toMatchObject({ reserved: 1, withheld: 0 });
    expect(await reserve(seat.id, 3)).toBe(true);
  });

  it("보류 반환: reserved 는 그대로 두고 withheld 만 늘려 자리를 닫아 둔다", async () => {
    const { seat } = await createListing([{ capacity: 4 }]);
    await setSeat(seat.id, { reserved: 4 });

    expect(await release(seat.id, 1, true)).toBe(true);
    expect(await loadSeat(seat.id)).toMatchObject({ reserved: 4, withheld: 1 });
    // 남은 자리는 여전히 0 이다.
    expect(await reserve(seat.id, 1)).toBe(false);
  });

  it("예약이 잡고 있던 좌석(reserved − withheld)보다 많이 돌려줄 수 없다", async () => {
    const { seat } = await createListing([{ capacity: 5 }]);
    await setSeat(seat.id, { reserved: 3, withheld: 2 });

    // 예약분은 1자리뿐이다.
    expect(await release(seat.id, 2, false)).toBe(false);
    expect(await release(seat.id, 2, true)).toBe(false);
    expect(await loadSeat(seat.id)).toMatchObject({ reserved: 3, withheld: 2 });

    expect(await release(seat.id, 1, true)).toBe(true);
    expect(await loadSeat(seat.id)).toMatchObject({ reserved: 3, withheld: 3 });
    expect(await release(seat.id, 1, false)).toBe(false);
    expect(await release(seat.id, 1, true)).toBe(false);
  });

  it("0 아래로 내려가지 않는다", async () => {
    const { seat } = await createListing([{ capacity: 4 }]);
    await setSeat(seat.id, { reserved: 1 });

    expect(await release(seat.id, 2, false)).toBe(false);
    expect(await release(seat.id, 1, false)).toBe(true);
    expect(await release(seat.id, 1, false)).toBe(false);
    expect(await release("no-such-seat", 1, false)).toBe(false);
    expect((await loadSeat(seat.id)).reserved).toBe(0);
  });

  it("동시에 돌려줘도 예약분만큼만 성공한다", async () => {
    const { seat } = await createListing([{ capacity: 10 }]);
    await setSeat(seat.id, { reserved: 6, withheld: 2 });

    // 예약분 4자리를 공개 반환 15건·보류 반환 15건이 나눠 갖는다.
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => release(seat.id, 1, i % 2 === 0)));

    expect(results.filter(Boolean)).toHaveLength(4);
    const after = await loadSeat(seat.id);
    expect(after.reserved - after.withheld).toBe(0);
    expect(after.withheld).toBeGreaterThanOrEqual(2);
    expect(after.reserved).toBeLessThanOrEqual(6);
  });
});

describe("relistWithheld", () => {
  it("수량을 생략하면 보류분 전부를 다시 올린다", async () => {
    const { seat } = await createListing([{ capacity: 6 }]);
    await setSeat(seat.id, { reserved: 5, withheld: 3 });

    expect(await relist(seat.id)).toBe(3);
    expect(await loadSeat(seat.id)).toMatchObject({ reserved: 2, withheld: 0 });
    expect(await relist(seat.id)).toBe(0);
  });

  it("수량을 주면 보류분을 넘지 않는 만큼만 올리고 실제로 올린 수를 돌려준다", async () => {
    const { seat } = await createListing([{ capacity: 6 }]);
    await setSeat(seat.id, { reserved: 5, withheld: 3 });

    expect(await relist(seat.id, 1)).toBe(1);
    expect(await loadSeat(seat.id)).toMatchObject({ reserved: 4, withheld: 2 });
    expect(await relist(seat.id, 5)).toBe(2);
    expect(await loadSeat(seat.id)).toMatchObject({ reserved: 2, withheld: 0 });
    expect(await relist("no-such-seat")).toBe(0);
  });

  it("동시에 다시 올려도 보류분을 한 번씩만 푼다", async () => {
    const { seat } = await createListing([{ capacity: 8 }]);
    await setSeat(seat.id, { reserved: 8, withheld: 5 });

    const results = await Promise.all(Array.from({ length: 12 }, () => relist(seat.id, 1)));

    expect(results.reduce((sum, n) => sum + n, 0)).toBe(5);
    expect(await loadSeat(seat.id)).toMatchObject({ reserved: 3, withheld: 0 });
  });

  it("취소 → 보류 → 다시 올리기 → 재예약이 불변식을 지킨다", async () => {
    const { seat } = await createListing([{ capacity: 2 }]);
    expect(await reserve(seat.id, 2)).toBe(true);
    expect(await release(seat.id, 1, true)).toBe(true);
    expect(await reserve(seat.id, 1)).toBe(false);
    expect(await relist(seat.id)).toBe(1);
    expect(await loadSeat(seat.id)).toMatchObject({ reserved: 1, withheld: 0 });
    expect(await reserve(seat.id, 1)).toBe(true);
    expect(await reserve(seat.id, 1)).toBe(false);
  });
});

describe("lockSeat", () => {
  it("최신 수량을 돌려주고, 없는 좌석이면 NOT_FOUND", async () => {
    const { seat } = await createListing([{ capacity: 9 }]);
    await setSeat(seat.id, { reserved: 4, withheld: 1 });

    expect(await prisma.$transaction((tx) => lockSeat(tx, seat.id))).toEqual({ capacity: 9, reserved: 4, withheld: 1 });
    await expect(prisma.$transaction((tx) => lockSeat(tx, "no-such-seat"))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("잠금을 쥔 트랜잭션이 끝날 때까지 다른 트랜잭션의 잠금·좌석 확보가 기다린다", async () => {
    const { seat } = await createListing([{ capacity: 3 }]);
    const order: string[] = [];
    let locked!: () => void;
    const firstHasLock = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const first = prisma.$transaction(async (tx) => {
      const before = await lockSeat(tx, seat.id);
      locked();
      await sleep(300);
      // 읽은 값으로 계산해서 쓴다(정원 변경·재판매 매칭과 같은 흐름).
      expect(await reserveSeats(tx, seat.id, before.capacity - before.reserved)).toBe(true);
      order.push("first");
    });
    await firstHasLock;
    const second = prisma.$transaction(async (tx) => {
      const seen = await lockSeat(tx, seat.id);
      order.push("second");
      return seen;
    });
    const third = reserve(seat.id, 1).then((ok) => {
      order.push("third");
      return ok;
    });

    const [, seen, ok] = await Promise.all([first, second, third]);

    expect(order[0]).toBe("first");
    // 뒤에 온 쪽은 앞 트랜잭션이 채운 뒤의 값을 본다.
    expect(seen).toEqual({ capacity: 3, reserved: 3, withheld: 0 });
    expect(ok).toBe(false);
  });
});

describe("confirmedCountBySeat", () => {
  it("좌석 유형별로 확정·이용 완료 예약 수량만 더한다(직접 입력 포함, 예약 없는 유형은 0)", async () => {
    const listing = await createListing([
      { label: "남성", gender: "MALE", capacity: 4 },
      { label: "여성", gender: "FEMALE", capacity: 4 },
      { label: "누구나", capacity: 4 },
    ]);
    const [male, female, anyone] = listing.slot.seats;
    await insertBooking(listing, male!.id, { status: "CONFIRMED", quantity: 2 });
    await insertBooking(listing, male!.id, { status: "COMPLETED", quantity: 1, channel: "MANUAL" });
    await insertBooking(listing, male!.id, { status: "PENDING_PAYMENT", quantity: 1 });
    await insertBooking(listing, female!.id, { status: "CONFIRMED", quantity: 1 });
    await insertBooking(listing, female!.id, { status: "CANCELLED", quantity: 3 });
    await insertBooking(listing, female!.id, { status: "NO_SHOW", quantity: 1 });
    await insertBooking(listing, female!.id, { status: "PENDING_APPROVAL", quantity: 1 });

    const counts = await confirmedCountBySeat(listing.slot.id);

    expect(counts.size).toBe(3);
    expect(counts.get(male!.id)).toBe(3);
    expect(counts.get(female!.id)).toBe(1);
    expect(counts.get(anyone!.id)).toBe(0);
    // 트랜잭션 안에서도 같은 값을 본다.
    expect(await prisma.$transaction((tx) => confirmedCountBySeat(listing.slot.id, tx))).toEqual(counts);
    expect((await confirmedCountBySeat("no-such-slot")).size).toBe(0);
  });
});

describe("verifyInventoryIntegrity", () => {
  it("예약·제안·보류의 합이 reserved 와 같으면 빈 목록을 돌려준다", async () => {
    const listing = await createListing([{ capacity: 12 }, { label: "예비", capacity: 3 }]);
    const seat = listing.seat;
    const waiter = await createUser();
    const other = await createUser();

    // 좌석을 잡는 상태: 결제 대기 1 + 승인 대기 1 + 확정 2 + 이용 완료 1 + 노쇼 1 = 6
    await insertBooking(listing, seat.id, { status: "PENDING_PAYMENT" });
    await insertBooking(listing, seat.id, { status: "PENDING_APPROVAL" });
    await insertBooking(listing, seat.id, { status: "CONFIRMED", quantity: 2 });
    await insertBooking(listing, seat.id, { status: "COMPLETED" });
    await insertBooking(listing, seat.id, { status: "NO_SHOW" });
    // 좌석을 잡지 않는 상태
    await insertBooking(listing, seat.id, { status: "CANCELLED", quantity: 2, resalePendingQty: 2 });
    await insertBooking(listing, seat.id, { status: "REJECTED" });
    await insertBooking(listing, seat.id, { status: "EXPIRED" });
    // 제안 중인 대기 2 는 좌석을 잡고, 기다리는 대기는 잡지 않는다.
    await prisma.waitlistEntry.create({
      data: { userId: waiter.id, slotId: listing.slot.id, slotSeatId: seat.id, quantity: 2, status: "OFFERED", offeredAt: new Date() },
    });
    await prisma.waitlistEntry.create({ data: { userId: other.id, slotId: listing.slot.id, slotSeatId: seat.id, quantity: 3 } });
    // 보류 1
    await setSeat(seat.id, { reserved: 6 + 2 + 1, withheld: 1 });

    expect(await verifyInventoryIntegrity()).toEqual([]);
    expect(await prisma.$transaction((tx) => verifyInventoryIntegrity(tx))).toEqual([]);
  });

  it("손으로 망가뜨린 좌석 행을 찾아낸다", async () => {
    const healthy = await createListing([{ capacity: 4 }]);
    const broken = await createListing([{ capacity: 6 }]);
    await insertBooking(healthy, healthy.seat.id, { quantity: 2 });
    await setSeat(healthy.seat.id, { reserved: 2 });
    await insertBooking(broken, broken.seat.id, { quantity: 2 });
    await setSeat(broken.seat.id, { reserved: 2 });
    expect(await verifyInventoryIntegrity()).toEqual([]);

    // 예약은 2자리인데 reserved 가 5 로 틀어진 상태(보류 1 포함)
    await setSeat(broken.seat.id, { reserved: 5, withheld: 1 });

    expect(await verifyInventoryIntegrity()).toEqual([
      {
        kind: "SEAT_COUNT",
        slotSeatId: broken.seat.id,
        slotId: broken.slot.id,
        capacity: 6,
        reserved: 5,
        withheld: 1,
        bookedQty: 2,
        offeredQty: 0,
        expectedReserved: 3,
      },
    ]);

    // 반대로 예약은 있는데 재고가 잡혀 있지 않은 경우(초과 예약 위험)
    await setSeat(broken.seat.id, { reserved: 0, withheld: 0 });
    const [mismatch] = await verifyInventoryIntegrity();
    expect(mismatch).toMatchObject({ kind: "SEAT_COUNT", slotSeatId: broken.seat.id, reserved: 0, expectedReserved: 2 });
  });

  it("취소되지 않은 예약에 남은 재판매 환불 대기 수량을 찾아낸다", async () => {
    const listing = await createListing([{ capacity: 4 }]);
    const cancelled = await insertBooking(listing, listing.seat.id, { status: "CANCELLED", quantity: 2, resalePendingQty: 1 });
    const stuck = await insertBooking(listing, listing.seat.id, { status: "CONFIRMED", quantity: 2, resalePendingQty: 2 });
    await setSeat(listing.seat.id, { reserved: 2 });

    const mismatches = await verifyInventoryIntegrity();

    expect(mismatches).toEqual([
      {
        kind: "RESALE_PENDING",
        bookingId: stuck.id,
        slotSeatId: listing.seat.id,
        slotId: listing.slot.id,
        status: "CONFIRMED",
        resalePendingQty: 2,
      },
    ]);
    expect(mismatches.some((m) => m.kind === "RESALE_PENDING" && m.bookingId === cancelled.id)).toBe(false);
  });

  it("서비스 함수만 거친 재고는 항상 정상이다", async () => {
    const listing = await createListing([{ capacity: 5 }]);
    const seatId = listing.seat.id;

    // 확정 예약 3건(각 1자리)을 좌석 확보와 한 트랜잭션으로 만든다.
    const bookings = [];
    for (let i = 0; i < 3; i++) {
      bookings.push(
        await prisma.$transaction(async (tx) => {
          expect(await reserveSeats(tx, seatId, 1)).toBe(true);
          return tx.booking.create({
            data: {
              code: newBookingCode(),
              businessId: listing.business.id,
              productId: listing.product.id,
              slotId: listing.slot.id,
              slotSeatId: seatId,
              quantity: 1,
              unitPrice: 30000,
              totalAmount: 30000,
              payNowAmount: 30000,
              status: "CONFIRMED",
              paymentMethod: "ONLINE",
              guestName: "김손님",
              guestPhone: `0101111000${i}`,
              policySnapshot: [],
              checkinToken: newToken(),
            },
          });
        }),
      );
    }
    expect(await verifyInventoryIntegrity()).toEqual([]);

    // 한 건은 보류로, 한 건은 공개로 취소한다.
    await prisma.$transaction(async (tx) => {
      await tx.booking.update({ where: { id: bookings[0]!.id }, data: { status: "CANCELLED" } });
      expect(await releaseSeats(tx, seatId, 1, { withhold: true })).toBe(true);
    });
    await prisma.$transaction(async (tx) => {
      await tx.booking.update({ where: { id: bookings[1]!.id }, data: { status: "CANCELLED" } });
      expect(await releaseSeats(tx, seatId, 1, { withhold: false })).toBe(true);
    });
    expect(await loadSeat(seatId)).toMatchObject({ reserved: 2, withheld: 1 });
    expect(await verifyInventoryIntegrity()).toEqual([]);

    await relist(seatId);
    expect(await loadSeat(seatId)).toMatchObject({ reserved: 1, withheld: 0 });
    expect(await verifyInventoryIntegrity()).toEqual([]);
  });
});
