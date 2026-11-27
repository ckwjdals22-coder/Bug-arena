import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { kstDateKey } from "@/lib/time";
import { prisma } from "@/server/db";
import { sha256 } from "@/server/security/crypto";

/**
 * 퍼널·수요 분석용 이벤트 기록.
 * - 화면 응답을 늦추지 않는다: trackEvent 는 기다리지 않고 바로 돌아오며, 어떤 경우에도 예외를 던지지 않는다.
 * - 기록에 실패하면 로그만 남긴다(본 작업에는 영향이 없다).
 * - meta 에는 정해진 항목만, 짧게 담는다. 연락처처럼 보이는 검색어는 가린다.
 */

export const ANALYTICS_EVENT_TYPES = [
  "SLOT_VIEW",
  "BOOKING_START",
  "SEARCH",
  "SHARE",
  "WAITLIST_JOIN",
  "BUSINESS_VIEW",
  "OFFER_OPEN",
  "CHECKOUT_VIEW",
] as const;
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

/** meta 에 담을 수 있는 항목. 그 밖의 키는 버린다. */
export const ANALYTICS_META_KEYS = [
  "q",
  "resultCount",
  "via",
  "source",
  "channel",
  "categorySlug",
  "areaSlug",
  "district",
  "when",
  "dateKey",
  "timeBand",
  "seatGender",
  "origin",
  "sort",
  "forMe",
  "position",
  "seatId",
  "quantity",
] as const;
export type AnalyticsMetaKey = (typeof ANALYTICS_META_KEYS)[number];

/** 검색어는 이 길이까지만 남긴다 */
export const SEARCH_TERM_MAX = 40;
const META_TEXT_MAX = 60;

export interface TrackEventInput {
  type: AnalyticsEventType;
  userId?: string | null;
  /** 비로그인 방문자 식별용 익명 ID(쿠키) */
  visitorId?: string | null;
  businessId?: string | null;
  productId?: string | null;
  slotId?: string | null;
  /** ANALYTICS_META_KEYS 의 항목만 남는다. SEARCH 는 q·resultCount 를 함께 넘긴다 */
  meta?: Partial<Record<AnalyticsMetaKey, string | number | boolean | null | undefined>> | null;
}

const optionalId = z
  .string()
  .max(64)
  .nullish()
  .transform((value) => value || null);

const inputSchema = z.object({
  type: z.enum(ANALYTICS_EVENT_TYPES),
  userId: optionalId,
  visitorId: optionalId,
  businessId: optionalId,
  productId: optionalId,
  slotId: optionalId,
  meta: z.record(z.string(), z.unknown()).nullish(),
});

type ParsedEvent = z.output<typeof inputSchema>;

/** 검색어 정리: 공백을 줄이고 40자로 자른다. 이메일·전화번호처럼 보이는 부분은 가린다. */
function cleanSearchTerm(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[가림]")
    .replace(/\d(?:[\s-]?\d){7,}/g, "[가림]")
    .slice(0, SEARCH_TERM_MAX);
}

function sanitizeMeta(meta: ParsedEvent["meta"]): Prisma.InputJsonObject | undefined {
  if (!meta) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const key of ANALYTICS_META_KEYS) {
    const value = meta[key];
    if (typeof value === "string") {
      const text = key === "q" ? cleanSearchTerm(value) : value.trim().slice(0, META_TEXT_MAX);
      if (text) out[key] = text;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = Math.trunc(value);
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 회차·상품만 넘어온 이벤트에 상품·사업장 ID 를 채운다(사업자 통계가 사업장 기준이라서). */
async function fillOwners(event: ParsedEvent): Promise<Pick<ParsedEvent, "businessId" | "productId">> {
  let { businessId, productId } = event;
  if (event.slotId && (!businessId || !productId)) {
    const slot = await prisma.slot.findUnique({ where: { id: event.slotId }, select: { productId: true, businessId: true } });
    productId = productId ?? slot?.productId ?? null;
    businessId = businessId ?? slot?.businessId ?? null;
  } else if (productId && !businessId) {
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { businessId: true } });
    businessId = product?.businessId ?? null;
  }
  return { businessId, productId };
}

async function record(input: TrackEventInput): Promise<void> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    console.error("[events] 형식이 맞지 않는 이벤트를 버렸어요", parsed.error.issues[0]?.message);
    return;
  }
  const event = parsed.data;
  const { businessId, productId } = await fillOwners(event);
  const row = {
    type: event.type,
    userId: event.userId,
    visitorId: event.visitorId,
    businessId,
    productId,
    slotId: event.slotId,
    meta: sanitizeMeta(event.meta),
  } satisfies Prisma.AnalyticsEventCreateManyInput;

  // 조회수는 같은 사람(회원 또는 방문자)·같은 상품·같은 날(KST)에 한 번만 올린다.
  // 그날의 첫 조회 이벤트에 고정 ID 를 주어, 동시에 들어와도 한 건만 "첫 조회"가 되게 한다.
  const actor = event.userId ? `u:${event.userId}` : event.visitorId ? `v:${event.visitorId}` : null;
  if (event.type === "SLOT_VIEW" && productId && actor) {
    const firstViewId = `ev_${sha256(`SLOT_VIEW:${actor}:${productId}:${kstDateKey(new Date())}`).slice(0, 27)}`;
    const counted = await prisma.$transaction(async (tx) => {
      const first = await tx.analyticsEvent.createMany({ data: [{ ...row, id: firstViewId }], skipDuplicates: true });
      if (first.count !== 1) return false;
      await tx.$executeRaw`UPDATE "Product" SET "viewCount" = "viewCount" + 1 WHERE "id" = ${productId}`;
      return true;
    });
    if (counted) return;
  }
  await prisma.analyticsEvent.create({ data: row });
}

const pending = new Set<Promise<void>>();

/**
 * 이벤트를 기록한다. 기다리지 않고 바로 돌아오며 예외를 던지지 않는다.
 * 응답이 끝나면 프로세스가 멈추는 환경(서버리스)에서는 after(() => flushEvents()) 로 마무리를 맡긴다.
 */
export function trackEvent(input: TrackEventInput): void {
  // record 는 async 라 동기 예외가 없고, 실패는 여기서 받아 로그로만 남긴다.
  const task = record(input).catch((e) => {
    console.error(`[events] 기록 실패 type=${String(input?.type)}`, e);
  });
  pending.add(task);
  void task.finally(() => pending.delete(task));
}

/** 아직 끝나지 않은 이벤트 기록이 모두 끝날 때까지 기다린다. 예외를 던지지 않는다. */
export async function flushEvents(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}
