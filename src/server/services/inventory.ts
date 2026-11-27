import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db";
import { err } from "@/server/errors";

/**
 * 좌석 재고. SlotSeat.reserved / withheld 를 바꾸는 코드는 이 파일에만 둔다.
 *
 * 불변식
 * - 남은 자리 = capacity − reserved
 * - reserved = 좌석을 잡고 있는 예약 수량 + 제안(OFFERED) 중인 대기 수량 + withheld
 * - 0 ≤ withheld ≤ reserved ≤ capacity (DB CHECK 제약이 최종 방어선)
 *
 * 모든 증감은 조건부 원자 UPDATE 한 문장이고, 상태 전이와 같은 트랜잭션에서 호출한다.
 * 조건이 맞지 않으면 아무 행도 바꾸지 않고 false(또는 0)를 돌려준다.
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

/** 한 번에 증감할 수 있는 좌석 수 상한(잘못된 값으로 재고가 크게 틀어지는 것을 막는다) */
const MAX_SEAT_QTY = 10_000;

/** 수량은 호출하는 코드가 정한다. 1 이상의 정수가 아니면 코드 오류이므로 바로 멈춘다. */
function assertQty(qty: number): void {
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_SEAT_QTY) {
    throw new RangeError(`좌석 수량이 올바르지 않습니다: ${String(qty)}`);
  }
}

/**
 * 좌석 확보. 남은 자리가 qty 이상일 때만 reserved 를 늘린다.
 * false 면 자리가 모자란 것이다(매진).
 */
export async function reserveSeats(tx: Tx, slotSeatId: string, qty: number): Promise<boolean> {
  assertQty(qty);
  const updated = await tx.$executeRaw`
    UPDATE "SlotSeat"
    SET "reserved" = "reserved" + ${qty}, "updatedAt" = ${new Date()}::timestamp
    WHERE "id" = ${slotSeatId} AND "reserved" + ${qty} <= "capacity"`;
  return updated === 1;
}

/**
 * 좌석 반환.
 * - withhold = false: reserved 를 줄여 다시 예약할 수 있게 한다.
 * - withhold = true : reserved 는 그대로 두고 withheld 를 늘린다(사업자가 다시 올릴 때까지 닫아 둔다).
 * 어느 쪽이든 "예약이 잡고 있던 좌석"(reserved − withheld)보다 많이 돌려줄 수 없다.
 * false 면 재고와 예약이 어긋난 것이므로 호출한 쪽에서 정합성 오류로 다뤄야 한다.
 */
export async function releaseSeats(tx: Tx, slotSeatId: string, qty: number, opts: { withhold: boolean }): Promise<boolean> {
  assertQty(qty);
  const now = new Date();
  const updated = opts.withhold
    ? await tx.$executeRaw`
        UPDATE "SlotSeat"
        SET "withheld" = "withheld" + ${qty}, "updatedAt" = ${now}::timestamp
        WHERE "id" = ${slotSeatId} AND "withheld" + ${qty} <= "reserved"`
    : await tx.$executeRaw`
        UPDATE "SlotSeat"
        SET "reserved" = "reserved" - ${qty}, "updatedAt" = ${now}::timestamp
        WHERE "id" = ${slotSeatId} AND "reserved" - ${qty} >= "withheld"`;
  return updated === 1;
}

/**
 * 보류 좌석 다시 올리기: reserved 와 withheld 를 같은 수만큼 줄인다.
 * qty 를 생략하면 보류분 전부, 주면 보류분을 넘지 않는 만큼만 올린다. 실제로 올린 수를 돌려준다(없으면 0).
 */
export async function relistWithheld(tx: Tx, slotSeatId: string, qty?: number): Promise<number> {
  if (qty !== undefined) assertQty(qty);
  const limit = qty ?? MAX_SEAT_QTY;
  const rows = await tx.$queryRaw<{ relisted: number }[]>`
    WITH locked AS (
      SELECT "id", LEAST("withheld", ${limit}::int) AS n FROM "SlotSeat" WHERE "id" = ${slotSeatId} FOR UPDATE
    )
    UPDATE "SlotSeat" s
    SET "reserved" = s."reserved" - l.n, "withheld" = s."withheld" - l.n, "updatedAt" = ${new Date()}::timestamp
    FROM locked l
    WHERE s."id" = l."id" AND l.n > 0
    RETURNING l.n::int AS "relisted"`;
  return Number(rows[0]?.relisted ?? 0);
}

export interface LockedSeat {
  capacity: number;
  reserved: number;
  withheld: number;
}

/**
 * 좌석 행을 잠그고(SELECT … FOR UPDATE) 최신 수량을 읽는다.
 * 재판매 매칭·정원 변경처럼 "읽고 계산한 뒤 쓰는" 작업을 줄 세울 때 쓴다. 잠금은 트랜잭션이 끝날 때 풀린다.
 */
export async function lockSeat(tx: Tx, slotSeatId: string): Promise<LockedSeat> {
  const rows = await tx.$queryRaw<LockedSeat[]>`
    SELECT "capacity", "reserved", "withheld" FROM "SlotSeat" WHERE "id" = ${slotSeatId} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw err.notFound("좌석 정보를 찾을 수 없어요.");
  return { capacity: Number(row.capacity), reserved: Number(row.reserved), withheld: Number(row.withheld) };
}

/**
 * 회차의 좌석 유형별 확정 인원(CONFIRMED + COMPLETED 예약 수량 합). 개최 확정 판정에 쓴다.
 * 예약이 없는 좌석 유형도 0 으로 들어 있다.
 */
export async function confirmedCountBySeat(slotId: string, db: Db = prisma): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<{ slotSeatId: string; confirmed: number }[]>`
    SELECT s."id" AS "slotSeatId", COALESCE(SUM(b."quantity"), 0)::int AS "confirmed"
    FROM "SlotSeat" s
    LEFT JOIN "Booking" b ON b."slotSeatId" = s."id" AND b."status" IN ('CONFIRMED', 'COMPLETED')
    WHERE s."slotId" = ${slotId}
    GROUP BY s."id"`;
  return new Map(rows.map((row) => [row.slotSeatId, Number(row.confirmed)]));
}

/** 재고 점검에서 찾은 어긋남 */
export type InventoryMismatch =
  | {
      /** reserved 가 예약·제안·보류의 합과 다르다 */
      kind: "SEAT_COUNT";
      slotSeatId: string;
      slotId: string;
      capacity: number;
      reserved: number;
      withheld: number;
      /** 좌석을 잡고 있는 예약 수량 합 */
      bookedQty: number;
      /** 제안(OFFERED) 중인 대기 수량 합 */
      offeredQty: number;
      /** bookedQty + offeredQty + withheld */
      expectedReserved: number;
    }
  | {
      /** 취소되지 않은 예약에 재판매 환불 대기 수량이 남아 있다 */
      kind: "RESALE_PENDING";
      bookingId: string;
      slotSeatId: string;
      slotId: string;
      status: string;
      resalePendingQty: number;
    };

interface MismatchRow {
  kind: "SEAT_COUNT" | "RESALE_PENDING";
  slotSeatId: string;
  slotId: string;
  bookingId: string | null;
  status: string | null;
  capacity: number | null;
  reserved: number | null;
  withheld: number | null;
  bookedQty: number | null;
  offeredQty: number | null;
  resalePendingQty: number | null;
}

/**
 * 전체 재고 정합성 점검(테스트·시드·운영자 콘솔용). 빈 배열이면 정상이다.
 * - 좌석마다 reserved = 좌석 점유 예약(결제 대기·승인 대기·확정·완료·노쇼) 수량 + 제안 중 대기 수량 + withheld 인지
 * - 취소가 아닌 예약에 resalePendingQty 가 남아 있지 않은지
 * 한 번의 질의로 어긋난 행만 가져온다.
 */
export async function verifyInventoryIntegrity(db: Db = prisma): Promise<InventoryMismatch[]> {
  const rows = await db.$queryRaw<MismatchRow[]>`
    WITH booked AS (
      SELECT "slotSeatId", SUM("quantity")::int AS qty
      FROM "Booking"
      WHERE "status" IN ('PENDING_PAYMENT', 'PENDING_APPROVAL', 'CONFIRMED', 'COMPLETED', 'NO_SHOW')
      GROUP BY "slotSeatId"
    ),
    offered AS (
      SELECT "slotSeatId", SUM("quantity")::int AS qty
      FROM "WaitlistEntry"
      WHERE "status" = 'OFFERED'
      GROUP BY "slotSeatId"
    )
    SELECT 'SEAT_COUNT' AS "kind", s."id" AS "slotSeatId", s."slotId" AS "slotId",
           NULL::text AS "bookingId", NULL::text AS "status",
           s."capacity", s."reserved", s."withheld",
           COALESCE(b.qty, 0) AS "bookedQty", COALESCE(o.qty, 0) AS "offeredQty",
           NULL::int AS "resalePendingQty"
    FROM "SlotSeat" s
    LEFT JOIN booked b ON b."slotSeatId" = s."id"
    LEFT JOIN offered o ON o."slotSeatId" = s."id"
    WHERE s."reserved" <> COALESCE(b.qty, 0) + COALESCE(o.qty, 0) + s."withheld"
    UNION ALL
    SELECT 'RESALE_PENDING', k."slotSeatId", k."slotId",
           k."id", k."status"::text,
           NULL::int, NULL::int, NULL::int, NULL::int, NULL::int,
           k."resalePendingQty"
    FROM "Booking" k
    WHERE k."resalePendingQty" > 0 AND k."status" <> 'CANCELLED'
    ORDER BY 1, 2, 4`;

  return rows.map((row): InventoryMismatch => {
    if (row.kind === "RESALE_PENDING") {
      return {
        kind: "RESALE_PENDING",
        bookingId: row.bookingId ?? "",
        slotSeatId: row.slotSeatId,
        slotId: row.slotId,
        status: row.status ?? "",
        resalePendingQty: Number(row.resalePendingQty ?? 0),
      };
    }
    const bookedQty = Number(row.bookedQty ?? 0);
    const offeredQty = Number(row.offeredQty ?? 0);
    const withheld = Number(row.withheld ?? 0);
    return {
      kind: "SEAT_COUNT",
      slotSeatId: row.slotSeatId,
      slotId: row.slotId,
      capacity: Number(row.capacity ?? 0),
      reserved: Number(row.reserved ?? 0),
      withheld,
      bookedQty,
      offeredQty,
      expectedReserved: bookedQty + offeredQty + withheld,
    };
  });
}
