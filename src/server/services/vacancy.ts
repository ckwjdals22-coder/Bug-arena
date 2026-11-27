import "server-only";
import { z } from "zod";
import { prisma } from "@/server/db";
import { announceVacancy } from "@/server/services/alerts";
import { onSeatReleasedForSeller } from "@/server/services/notifications/events";

/**
 * 좌석이 다시 생긴 뒤의 후속 처리(docs/02-architecture.md 6.5). 좌석을 돌려놓은 트랜잭션이 끝난 뒤에 부른다.
 *
 *   보류(withheld) ─▶ 사업자에게 "다시 올릴까요?" 알림만 보낸다.
 *   공개 반환 ─▶ 대기 처리기(제안·동시 알림) ─▶ 그래도 공개로 남은 자리가 있으면
 *              (취소석이면 회차에 취소석 표시·등록 시각 갱신) ─▶ 팔로워·맞춤 알림 회원에게 알림
 *
 * 어떤 경우에도 예외를 던지지 않는다. 이미 끝난 본 작업(취소·만료 등)을 되돌리거나 깨뜨리지 않기 위해서다.
 */

export const SEAT_RELEASE_REASONS = ["CANCELLATION", "EXPIRED", "REJECTED", "RELIST", "CAPACITY", "REOPEN", "OFFER_EXPIRED"] as const;
export type SeatReleaseReason = (typeof SEAT_RELEASE_REASONS)[number];

export interface SeatReleaseContext {
  /**
   * CANCELLATION 예약 취소 · EXPIRED 결제 대기 만료 · REJECTED 승인 거절 · RELIST 보류 좌석 다시 올리기 ·
   * CAPACITY 정원 늘림 · REOPEN 회차 다시 열기 · OFFER_EXPIRED 대기 제안 만료
   */
  reason: SeatReleaseReason;
  /** 돌려놓은 좌석 수 */
  quantity: number;
  /** true 면 좌석이 보류(withheld)로 닫혀 있다 — 사업자가 다시 올릴 때까지 공개하지 않는다 */
  withheld: boolean;
  /** 빈자리 알림에서 뺄 회원(방금 취소한 본인 등) */
  excludeUserIds?: string[];
}

export interface WaitlistProcessResult {
  /** 좌석을 잡아 두고 제안한 대기 건수 */
  offered: number;
  /** 선착순 동시 알림을 보낸 대기 건수 */
  broadcast: number;
  /** 처리 뒤에도 누구나 예약할 수 있게 남은 좌석 수 */
  remainingPublic: number;
}

/** 좌석 유형 하나의 대기자를 처리하는 함수(대기 모듈이 등록한다) */
export type WaitlistProcessor = (slotSeatId: string) => Promise<WaitlistProcessResult>;

export interface SeatReleaseOutcome {
  /**
   * WITHHELD: 사업자에게만 알렸다 · PROCESSED: 대기 처리와 공개 알림까지 진행했다 ·
   * SKIPPED: 할 일이 없었다(없는 좌석, 닫힌 회차, 예약 마감 뒤) · FAILED: 처리 중 오류가 나서 중단했다(로그 확인)
   */
  path: "WITHHELD" | "PROCESSED" | "SKIPPED" | "FAILED";
  offered: number;
  broadcast: number;
  remainingPublic: number;
  /** 빈자리 알림을 새로 받은 회원 수 */
  notified: number;
}

// 등록한 처리기는 전역에 둔다. 번들이 나뉘어 이 모듈이 여러 번 평가돼도 같은 처리기를 보게 하기 위해서다.
const REGISTRY_KEY = Symbol.for("namneun.vacancy.waitlistProcessor");
const registry = globalThis as { [REGISTRY_KEY]?: WaitlistProcessor };

/**
 * 대기 처리기를 등록한다(대기 모듈이 불러올 때 한 번). null 을 주면 등록을 지운다.
 * 등록된 처리기가 없으면 대기자가 없는 것처럼 동작한다(남은 자리를 그대로 공개).
 */
export function setWaitlistProcessor(fn: WaitlistProcessor | null): void {
  if (fn) registry[REGISTRY_KEY] = fn;
  else delete registry[REGISTRY_KEY];
}

/** 취소로 생긴 자리가 공개되는 경우: 방금 취소됐거나, 취소 뒤 보류해 둔 좌석을 사업자가 다시 올렸을 때 */
const CANCELLATION_REASONS: ReadonlySet<SeatReleaseReason> = new Set<SeatReleaseReason>(["CANCELLATION", "RELIST"]);
/** 사업자가 새로 연 자리(정원 늘림·회차 다시 열기) — 취소석이 아니므로 "새 자리"로 알린다 */
const NEW_SEAT_REASONS: ReadonlySet<SeatReleaseReason> = new Set<SeatReleaseReason>(["CAPACITY", "REOPEN"]);

const contextSchema = z.object({
  reason: z.enum(SEAT_RELEASE_REASONS),
  quantity: z.number().int().min(1).max(10_000),
  withheld: z.boolean(),
  excludeUserIds: z.array(z.string().min(1).max(64)).max(100).optional(),
});

const outcome = (path: SeatReleaseOutcome["path"], rest: Partial<Omit<SeatReleaseOutcome, "path">> = {}): SeatReleaseOutcome => ({
  path,
  offered: 0,
  broadcast: 0,
  remainingPublic: 0,
  notified: 0,
  ...rest,
});

async function readRemaining(slotSeatId: string): Promise<number> {
  const seat = await prisma.slotSeat.findUnique({ where: { id: slotSeatId }, select: { capacity: true, reserved: true } });
  return seat ? Math.max(0, seat.capacity - seat.reserved) : 0;
}

/**
 * 취소석 표시: 그 좌석이 지금 실제로 공개돼 있을 때만(남은 자리 > 0) 회차의 등록 시각을 갱신하고,
 * 일반 판매(REGULAR)였던 회차는 취소석(CANCELLATION)으로 바꾼다. 노쇼·미판매 표시는 그대로 둔다.
 */
async function markCancellationVacancy(slotId: string, slotSeatId: string, now: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Slot"
    SET "vacancyPostedAt" = ${now}::timestamp,
        "origin" = CASE WHEN "origin" = 'REGULAR' THEN 'CANCELLATION'::"VacancyOrigin" ELSE "origin" END,
        "updatedAt" = ${now}::timestamp
    WHERE "id" = ${slotId} AND "status" = 'OPEN' AND "bookingDeadlineAt" > ${now}::timestamp
      AND EXISTS (SELECT 1 FROM "SlotSeat" s WHERE s."id" = ${slotSeatId} AND s."reserved" < s."capacity")`;
}

async function handle(slotSeatId: string, ctx: z.output<typeof contextSchema>): Promise<SeatReleaseOutcome> {
  const seat = await prisma.slotSeat.findUnique({
    where: { id: slotSeatId },
    select: { slotId: true, slot: { select: { status: true, startAt: true, bookingDeadlineAt: true } } },
  });
  if (!seat) return outcome("SKIPPED");
  const { slotId, slot } = seat;
  const now = new Date();

  if (ctx.withheld) {
    // 취소됐거나 이미 시작한 회차는 다시 올릴 수 없으므로 묻지 않는다.
    if (slot.status === "CANCELLED" || slot.startAt.getTime() <= now.getTime()) return outcome("SKIPPED");
    await onSeatReleasedForSeller(slotId, ctx.quantity);
    return outcome("WITHHELD");
  }

  if (slot.status !== "OPEN" || slot.bookingDeadlineAt.getTime() <= now.getTime()) return outcome("SKIPPED");

  // 대기자 먼저. 처리기가 실패해도 남은 자리는 DB 에서 다시 읽어 공개 흐름을 이어 간다.
  let processed: WaitlistProcessResult | null = null;
  const processor = registry[REGISTRY_KEY];
  if (processor) {
    try {
      processed = await processor(slotSeatId);
    } catch (e) {
      console.error(`[vacancy] 대기 처리 실패 seat=${slotSeatId} reason=${ctx.reason}`, e);
    }
  }
  const remainingPublic = processed ? Math.max(0, processed.remainingPublic) : await readRemaining(slotSeatId);
  const result = { offered: processed?.offered ?? 0, broadcast: processed?.broadcast ?? 0, remainingPublic };
  if (remainingPublic === 0) return outcome("PROCESSED", result);

  if (CANCELLATION_REASONS.has(ctx.reason)) await markCancellationVacancy(slotId, slotSeatId, now);
  const { notified } = await announceVacancy(slotId, {
    reason: NEW_SEAT_REASONS.has(ctx.reason) ? "NEW" : "REOPENED",
    excludeUserIds: ctx.excludeUserIds,
  });
  return outcome("PROCESSED", { ...result, notified });
}

/**
 * 좌석 반환 뒤처리. 좌석을 돌려놓은 트랜잭션이 커밋된 다음에 부른다.
 * - withheld: 사업자에게 다시 올릴지 묻는 알림만 보낸다.
 * - 그 밖: 회차가 판매 중이고 예약 마감 전일 때 대기 처리기를 부르고, 공개로 남은 자리가 있으면 빈자리 알림을 보낸다.
 *   취소석(CANCELLATION·RELIST)이 공개되면 회차의 공석 사유를 취소석으로, 등록 시각을 지금으로 바꾼다.
 * 예외를 던지지 않으며, 실패는 좌석·회차 ID 만 담아 로그로 남긴다.
 */
export async function afterSeatsReleased(slotSeatId: string, ctx: SeatReleaseContext): Promise<SeatReleaseOutcome> {
  try {
    const parsed = contextSchema.safeParse(ctx);
    if (typeof slotSeatId !== "string" || slotSeatId.length === 0 || slotSeatId.length > 64 || !parsed.success) {
      console.error(`[vacancy] 잘못된 호출 seat=${String(slotSeatId).slice(0, 64)}`);
      return outcome("FAILED");
    }
    return await handle(slotSeatId, parsed.data);
  } catch (e) {
    console.error(`[vacancy] 좌석 반환 뒤처리 실패 seat=${String(slotSeatId).slice(0, 64)}`, e);
    return outcome("FAILED");
  }
}
