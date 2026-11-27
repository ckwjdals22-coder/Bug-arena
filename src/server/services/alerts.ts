import "server-only";
import { z } from "zod";
import type { AlertRule, Prisma, SeatGender } from "@/generated/prisma/client";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/domain";
import { env } from "@/lib/env";
import { formatKRW } from "@/lib/money";
import { fmtDateTime, kstMinuteOfDay, kstParts, startOfKstDay } from "@/lib/time";
import { prisma } from "@/server/db";
import { err } from "@/server/errors";
import { getNotificationPrefs, notifyMany } from "@/server/services/notifications";
import { notificationLinks } from "@/server/services/notifications/events";
import { enqueueMessageDetailed } from "@/server/services/notifications/outbox";

/**
 * 맞춤 빈자리 알림.
 * - 회원이 조건(분류·지역·키워드·가격·요일·시간대·좌석 성별)을 저장해 두면, 조건에 맞는 자리가 열릴 때 알려 준다.
 * - announceVacancy 는 팔로워·찜한 회원·조건 일치 회원에게 한 번에 알리되, 회원당 하루 건수와 회차당 1회 제한을 지킨다.
 */

export const MAX_ALERT_RULES = 10;
/** 회원 한 명이 하루(KST)에 받는 빈자리 알림 최대 건수 */
export const VACANCY_DAILY_LIMIT = 5;
const VACANCY_TEMPLATE_KEY = "VACANCY_ALERT";
/** 알림 후보를 한 번에 처리하는 묶음 크기 */
const CANDIDATE_CHUNK = 2000;
/** 문자 대기열 등록을 동시에 진행하는 건수 */
const SMS_PARALLEL = 10;

// ── 조건 저장 ─────────────────────────────────────────

const slugList = (max: number) => z.array(z.string().trim().min(1).max(60)).max(max);
const minuteOfDay = z.number().int().min(0, "시간을 다시 골라 주세요.").max(1439, "시간을 다시 골라 주세요.");

/** 값 형식만 정한다. 생략(undefined)은 만들 때 "조건 없음", 고칠 때 "그대로 둠"을 뜻한다. */
const ruleSchema = z
  .object({
    name: z.string().trim().max(30, "이름은 30자까지 쓸 수 있어요.").nullable(),
    categorySlugs: slugList(20),
    areaSlugs: slugList(30),
    keyword: z.string().trim().max(30, "키워드는 30자까지 쓸 수 있어요.").nullable(),
    maxPrice: z.number().int().min(0, "가격은 0원 이상이어야 해요.").max(100_000_000).nullable(),
    daysOfWeek: z.array(z.number().int().min(0, "요일을 다시 골라 주세요.").max(6, "요일을 다시 골라 주세요.")).max(7),
    timeFromMin: minuteOfDay.nullable(),
    timeToMin: minuteOfDay.nullable(),
    seatGender: z.enum(["ANY", "MALE", "FEMALE"]).nullable(),
    isActive: z.boolean(),
  })
  .partial();

export type AlertRuleInput = z.input<typeof ruleSchema>;

type RuleCriteria = Pick<
  AlertRule,
  "categorySlugs" | "areaSlugs" | "keyword" | "maxPrice" | "daysOfWeek" | "timeFromMin" | "timeToMin" | "seatGender"
>;

const unique = <T>(values: T[]) => [...new Set(values)];

/** 검증을 통과한 입력에서 실제로 넘어온 항목만 저장 형식으로 바꾼다(빈 문자열은 null). */
function toRuleData(input: z.output<typeof ruleSchema>): Partial<RuleCriteria & Pick<AlertRule, "name" | "isActive">> {
  const data: Partial<RuleCriteria & Pick<AlertRule, "name" | "isActive">> = {};
  if (input.name !== undefined) data.name = input.name || null;
  if (input.categorySlugs !== undefined) data.categorySlugs = unique(input.categorySlugs);
  if (input.areaSlugs !== undefined) data.areaSlugs = unique(input.areaSlugs);
  if (input.keyword !== undefined) data.keyword = input.keyword || null;
  if (input.maxPrice !== undefined) data.maxPrice = input.maxPrice;
  if (input.daysOfWeek !== undefined) data.daysOfWeek = unique(input.daysOfWeek).sort((a, b) => a - b);
  if (input.timeFromMin !== undefined) data.timeFromMin = input.timeFromMin;
  if (input.timeToMin !== undefined) data.timeToMin = input.timeToMin;
  if (input.seatGender !== undefined) data.seatGender = input.seatGender;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  return data;
}

const EMPTY_CRITERIA: RuleCriteria = {
  categorySlugs: [],
  areaSlugs: [],
  keyword: null,
  maxPrice: null,
  daysOfWeek: [],
  timeFromMin: null,
  timeToMin: null,
  seatGender: null,
};

/** 조건이 하나도 없으면 모든 자리에 알림이 가므로 받지 않는다. */
function assertHasCriteria(rule: RuleCriteria): void {
  const has =
    rule.categorySlugs.length > 0 ||
    rule.areaSlugs.length > 0 ||
    rule.keyword !== null ||
    rule.maxPrice !== null ||
    rule.daysOfWeek.length > 0 ||
    rule.timeFromMin !== null ||
    rule.timeToMin !== null ||
    (rule.seatGender !== null && rule.seatGender !== "ANY");
  if (!has) throw err.validation("알림 받을 조건을 하나 이상 골라 주세요.");
}

async function assertSlugsExist(categorySlugs: string[] | undefined, areaSlugs: string[] | undefined): Promise<void> {
  if (categorySlugs && categorySlugs.length > 0) {
    const found = await prisma.category.count({ where: { slug: { in: categorySlugs }, isActive: true } });
    if (found !== categorySlugs.length) throw err.validation("고를 수 없는 분류가 있어요.", { categorySlugs: "분류를 다시 골라 주세요." });
  }
  if (areaSlugs && areaSlugs.length > 0) {
    const found = await prisma.area.count({ where: { slug: { in: areaSlugs }, isActive: true } });
    if (found !== areaSlugs.length) throw err.validation("고를 수 없는 지역이 있어요.", { areaSlugs: "지역을 다시 골라 주세요." });
  }
}

export async function listAlertRules(userId: string): Promise<AlertRule[]> {
  return prisma.alertRule.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
}

/** 알림 조건을 만든다. 회원당 MAX_ALERT_RULES 개까지. */
export async function createAlertRule(userId: string, input: unknown): Promise<AlertRule> {
  const data = toRuleData(ruleSchema.parse(input));
  assertHasCriteria({ ...EMPTY_CRITERIA, ...data });
  await assertSlugsExist(data.categorySlugs, data.areaSlugs);

  // 개수 확인과 저장을 회원 단위로 직렬화해 동시에 눌러도 한도를 넘지 않게 한다.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`alert-rule:${userId}`}, 0))`;
    const count = await tx.alertRule.count({ where: { userId } });
    if (count >= MAX_ALERT_RULES) {
      throw err.conflict(`알림 조건은 ${MAX_ALERT_RULES}개까지 만들 수 있어요. 쓰지 않는 조건을 지우고 다시 시도해 주세요.`);
    }
    // 목록 칼럼은 생략하면 NULL 로 저장되므로 빈 배열을 명시한다.
    return tx.alertRule.create({ data: { categorySlugs: [], areaSlugs: [], daysOfWeek: [], ...data, userId } });
  });
}

/** 본인 조건의 일부 항목을 고친다. 넘기지 않은 항목은 그대로 둔다. */
export async function updateAlertRule(userId: string, ruleId: string, patch: unknown): Promise<AlertRule> {
  const data = toRuleData(ruleSchema.parse(patch));
  const rule = await prisma.alertRule.findFirst({ where: { id: ruleId, userId } });
  if (!rule) throw err.notFound("알림 조건을 찾을 수 없어요.");
  assertHasCriteria({ ...rule, ...data });
  await assertSlugsExist(data.categorySlugs, data.areaSlugs);

  const updated = await prisma.alertRule.updateMany({ where: { id: ruleId, userId }, data });
  if (updated.count === 0) throw err.notFound("알림 조건을 찾을 수 없어요.");
  return prisma.alertRule.findUniqueOrThrow({ where: { id: ruleId } });
}

export async function deleteAlertRule(userId: string, ruleId: string): Promise<void> {
  const deleted = await prisma.alertRule.deleteMany({ where: { id: ruleId, userId } });
  if (deleted.count === 0) throw err.notFound("알림 조건을 찾을 수 없어요.");
}

// ── 조건 일치 ─────────────────────────────────────────

/** 조건과 견줄 회차 정보. 이 모양을 만족하는 조회 결과면 무엇이든 넣을 수 있다. */
export interface VacancySlot {
  startAt: Date;
  product: {
    title: string;
    tags: string[];
    category: { slug: string };
    /** 상품에 장소가 따로 없으면 사업장 지역을 쓴다. */
    area: { slug: string } | null;
  };
  business: { name: string; area: { slug: string } | null };
  seats: { gender: SeatGender; capacity: number; reserved: number; price: number }[];
}

interface OpenSeat {
  gender: SeatGender;
  price: number;
}

const openSeatsOf = (slot: VacancySlot): OpenSeat[] => slot.seats.filter((s) => s.capacity - s.reserved > 0);

/** 띄어쓰기·대소문자 차이는 무시하고 견준다("보드 게임" = "보드게임"). */
const normalizeText = (text: string) => text.toLowerCase().replace(/\s+/g, "");

function inTimeRange(minute: number, from: number | null, to: number | null): boolean {
  if (from === null && to === null) return true;
  if (from === null) return minute <= to!;
  if (to === null) return minute >= from;
  // from > to 면 자정을 넘는 범위(예: 22:00~02:00)
  return from <= to ? minute >= from && minute <= to : minute >= from || minute <= to;
}

function ruleMatches(rule: RuleCriteria, slot: VacancySlot, openSeats: OpenSeat[]): boolean {
  const areaSlug = slot.product.area?.slug ?? slot.business.area?.slug ?? null;
  if (rule.categorySlugs.length > 0 && !rule.categorySlugs.includes(slot.product.category.slug)) return false;
  if (rule.areaSlugs.length > 0 && (areaSlug === null || !rule.areaSlugs.includes(areaSlug))) return false;
  if (rule.keyword) {
    const keyword = normalizeText(rule.keyword);
    const haystack = [slot.product.title, slot.business.name, ...slot.product.tags].map(normalizeText);
    if (keyword && !haystack.some((text) => text.includes(keyword))) return false;
  }
  if (rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(kstParts(slot.startAt).weekday)) return false;
  if (!inTimeRange(kstMinuteOfDay(slot.startAt), rule.timeFromMin, rule.timeToMin)) return false;

  // 좌석 성별과 가격은 "예약할 수 있는 같은 좌석"을 기준으로 함께 본다.
  // 성별 조건이 있으면 그 성별 좌석과 누구나 좌석만 후보이고, 가격은 후보 가운데 가장 싼 좌석과 견준다.
  const wanted = rule.seatGender && rule.seatGender !== "ANY" ? rule.seatGender : null;
  const seats = wanted ? openSeats.filter((s) => s.gender === wanted || s.gender === "ANY") : openSeats;
  if (seats.length === 0) return false;
  if (rule.maxPrice !== null && Math.min(...seats.map((s) => s.price)) > rule.maxPrice) return false;
  return true;
}

interface RuleRow {
  id: string;
  userId: string;
  categorySlugs: string[] | null;
  areaSlugs: string[] | null;
  keyword: string | null;
  maxPrice: number | null;
  daysOfWeek: number[] | null;
  timeFromMin: number | null;
  timeToMin: number | null;
  seatGender: SeatGender | null;
}

async function findMatchingRules(slot: VacancySlot): Promise<{ id: string; userId: string }[]> {
  const openSeats = openSeatsOf(slot);
  if (openSeats.length === 0) return [];
  const categorySlug = slot.product.category.slug;
  const areaSlug = slot.product.area?.slug ?? slot.business.area?.slug ?? null;
  const cheapest = Math.min(...openSeats.map((s) => s.price));
  const weekday = kstParts(slot.startAt).weekday;

  // 분류·지역·가격·요일은 DB 에서 먼저 줄이고, 나머지는 코드에서 정확히 견준다.
  // 목록 칼럼은 비어 있거나 NULL 이면 "조건 없음"이다(Prisma 의 isEmpty 는 NULL 을 놓치므로 원시 SQL 을 쓴다).
  const rows = await prisma.$queryRaw<RuleRow[]>`
    SELECT r."id", r."userId", r."categorySlugs", r."areaSlugs", r."keyword", r."maxPrice", r."daysOfWeek",
           r."timeFromMin", r."timeToMin", r."seatGender"::text AS "seatGender"
    FROM "AlertRule" r
    JOIN "User" u ON u."id" = r."userId"
    WHERE r."isActive" = true
      AND u."status" = 'ACTIVE'
      AND (COALESCE(cardinality(r."categorySlugs"), 0) = 0 OR ${categorySlug}::text = ANY(r."categorySlugs"))
      AND (COALESCE(cardinality(r."areaSlugs"), 0) = 0 OR ${areaSlug}::text = ANY(r."areaSlugs"))
      AND (r."maxPrice" IS NULL OR r."maxPrice" >= ${cheapest}::int)
      AND (COALESCE(cardinality(r."daysOfWeek"), 0) = 0 OR ${weekday}::int = ANY(r."daysOfWeek"))`;

  return rows
    .filter((row) =>
      ruleMatches(
        { ...row, categorySlugs: row.categorySlugs ?? [], areaSlugs: row.areaSlugs ?? [], daysOfWeek: row.daysOfWeek ?? [] },
        slot,
        openSeats,
      ),
    )
    .map((row) => ({ id: row.id, userId: row.userId }));
}

/** 이 회차에 맞는 활성 알림 조건을 가진 회원 ID 목록(중복 없음) */
export async function matchAlertRules(slot: VacancySlot): Promise<string[]> {
  return [...new Set((await findMatchingRules(slot)).map((rule) => rule.userId))];
}

// ── 빈자리 알림 ───────────────────────────────────────

export interface AnnounceVacancyOptions {
  /** NEW: 새로 열린 자리, REOPENED: 취소 등으로 다시 생긴 자리. 생략하면 회차의 공석 사유로 정한다. */
  reason?: "NEW" | "REOPENED";
  /** 알리지 않을 회원(방금 취소한 본인 등) */
  excludeUserIds?: string[];
}

const vacancySlotInclude = {
  seats: { select: { gender: true, capacity: true, reserved: true, price: true } },
  product: {
    select: {
      id: true,
      title: true,
      tags: true,
      status: true,
      category: { select: { slug: true } },
      area: { select: { slug: true } },
    },
  },
  business: {
    select: {
      id: true,
      name: true,
      status: true,
      area: { select: { slug: true } },
      members: { select: { userId: true } },
    },
  },
} satisfies Prisma.SlotInclude;

const vacancyDedupeKey = (slotId: string, userId: string) => `VACANCY_ALERT:${slotId}:${userId}`;

async function announce(slotId: string, options: AnnounceVacancyOptions): Promise<number> {
  const now = new Date();
  const slot = await prisma.slot.findUnique({ where: { id: slotId }, include: vacancySlotInclude });
  if (!slot || slot.status !== "OPEN") return 0;
  if (slot.startAt.getTime() <= now.getTime() || slot.bookingDeadlineAt.getTime() <= now.getTime()) return 0;
  if (slot.product.status !== "ACTIVE" || slot.business.status !== "APPROVED") return 0;
  const openSeats = openSeatsOf(slot);
  if (openSeats.length === 0) return 0;

  // 1) 알릴 후보: 사업장 팔로워 + 상품을 찜한 회원 + 조건이 맞는 회원
  const [follows, favorites, matchedRules, bookings, offered] = await Promise.all([
    prisma.follow.findMany({ where: { businessId: slot.businessId }, select: { userId: true } }),
    prisma.favorite.findMany({ where: { productId: slot.productId }, select: { userId: true } }),
    findMatchingRules(slot),
    prisma.booking.findMany({
      where: { slotId, userId: { not: null }, status: { in: ACTIVE_BOOKING_STATUSES } },
      select: { userId: true },
    }),
    prisma.waitlistEntry.findMany({ where: { slotId, status: "OFFERED" }, select: { userId: true } }),
  ]);

  // 2) 제외: 요청에서 뺀 회원, 사업장 구성원, 이미 이 회차를 예약했거나 자리 제안을 받은 회원
  const excluded = new Set<string>(options.excludeUserIds ?? []);
  for (const m of slot.business.members) excluded.add(m.userId);
  for (const b of bookings) if (b.userId) excluded.add(b.userId);
  for (const w of offered) excluded.add(w.userId);

  const ruleIdsByUser = new Map<string, string[]>();
  for (const rule of matchedRules) ruleIdsByUser.set(rule.userId, [...(ruleIdsByUser.get(rule.userId) ?? []), rule.id]);
  const candidateIds = [
    ...new Set([...follows.map((f) => f.userId), ...favorites.map((f) => f.userId), ...ruleIdsByUser.keys()]),
  ].filter((id) => !excluded.has(id));
  if (candidateIds.length === 0) return 0;

  // 3) 문구 — 남은 수량처럼 금방 달라지는 값은 넣지 않고, 열린 사실과 일정·가격만 알린다.
  const reason = options.reason ?? (slot.origin === "CANCELLATION" || slot.origin === "NO_SHOW" ? "REOPENED" : "NEW");
  const cheapest = Math.min(...openSeats.map((s) => s.price));
  const price = cheapest === 0 ? "무료" : openSeats.some((s) => s.price !== cheapest) ? `${formatKRW(cheapest)}부터` : formatKRW(cheapest);
  const link = notificationLinks.slot(slot.id);
  const batch: VacancyBatch = {
    slotId: slot.id,
    now,
    title: reason === "REOPENED" ? `${slot.business.name}에 취소 자리가 났어요` : `${slot.business.name}에 새 자리가 열렸어요`,
    body: `${slot.product.title}\n${fmtDateTime(slot.startAt)} · ${price}`,
    link,
    data: { slotId: slot.id, productId: slot.productId, businessId: slot.businessId, reason },
    openGenders: new Set(openSeats.map((s) => s.gender)),
    ruleIdsByUser,
  };

  // 4) 후보가 많을 수 있으므로 나눠서 처리한다.
  let notified = 0;
  for (let i = 0; i < candidateIds.length; i += CANDIDATE_CHUNK) {
    notified += await deliverVacancy(batch, candidateIds.slice(i, i + CANDIDATE_CHUNK));
  }
  return notified;
}

interface VacancyBatch {
  slotId: string;
  now: Date;
  title: string;
  body: string;
  link: string;
  data: Prisma.InputJsonObject;
  /** 지금 자리가 남은 좌석의 성별 구분 */
  openGenders: Set<SeatGender>;
  ruleIdsByUser: Map<string, string[]>;
}

/** 후보 회원 묶음에 수신 설정·횟수 제한을 적용해 알리고, 새로 알린 회원 수를 돌려준다. */
async function deliverVacancy(batch: VacancyBatch, candidateIds: string[]): Promise<number> {
  const { slotId, now } = batch;
  const dayStart = startOfKstDay(now);
  const [users, inAppToday, smsToday, alreadyInApp, alreadySms] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: candidateIds }, status: "ACTIVE" },
      select: { id: true, phone: true, gender: true, notificationPrefs: true, marketingConsentAt: true, bookingRestrictedUntil: true },
    }),
    prisma.notification.groupBy({
      by: ["userId"],
      where: { userId: { in: candidateIds }, type: "VACANCY_ALERT", createdAt: { gte: dayStart } },
      _count: { _all: true },
    }),
    prisma.messageOutbox.groupBy({
      by: ["userId"],
      where: { userId: { in: candidateIds }, templateKey: VACANCY_TEMPLATE_KEY, createdAt: { gte: dayStart } },
      _count: { _all: true },
    }),
    prisma.notification.findMany({
      where: { userId: { in: candidateIds }, type: "VACANCY_ALERT", data: { path: ["slotId"], equals: slotId } },
      select: { userId: true },
    }),
    prisma.messageOutbox.findMany({
      where: { dedupeKey: { in: candidateIds.map((id) => vacancyDedupeKey(slotId, id)) } },
      select: { userId: true },
    }),
  ]);

  const sentToday = new Map<string, number>();
  for (const row of inAppToday) sentToday.set(row.userId, row._count._all);
  for (const row of smsToday) {
    if (row.userId) sentToday.set(row.userId, Math.max(sentToday.get(row.userId) ?? 0, row._count._all));
  }
  const alreadyNotified = new Set<string>(alreadyInApp.map((n) => n.userId));
  for (const row of alreadySms) if (row.userId) alreadyNotified.add(row.userId);

  // 회원별 판단: 예약 제한 · 성별이 맞지 않는 자리 · 회차당 1회 · 하루 건수 제한 · 수신 설정
  const inAppTargets: string[] = [];
  const smsTargets: { id: string; phone: string }[] = [];
  for (const user of users) {
    if (user.bookingRestrictedUntil && user.bookingRestrictedUntil.getTime() > now.getTime()) continue;
    // 조건을 직접 저장한 회원은 조건이 곧 의사 표시다. 팔로우·찜으로만 온 회원은 본인이 앉을 수 없는 성별 좌석이면 알리지 않는다.
    const byRule = batch.ruleIdsByUser.has(user.id);
    if (!byRule && user.gender && !batch.openGenders.has("ANY") && !batch.openGenders.has(user.gender)) continue;
    if (alreadyNotified.has(user.id)) continue;
    if ((sentToday.get(user.id) ?? 0) >= VACANCY_DAILY_LIMIT) continue;

    const prefs = getNotificationPrefs(user);
    if (prefs.vacancyInApp) inAppTargets.push(user.id);
    if (prefs.vacancySms && user.marketingConsentAt && user.phone) smsTargets.push({ id: user.id, phone: user.phone });
  }

  // 같은 회차에 대한 호출이 겹쳐도 회원당 한 건만 만들어지도록 알림 ID 를 (회차, 회원)으로 고정한다.
  const notified = new Set<string>();
  const created = await notifyMany(
    inAppTargets.map((userId) => ({
      userId,
      type: "VACANCY_ALERT" as const,
      title: batch.title,
      body: batch.body,
      linkUrl: batch.link,
      data: batch.data,
      dedupeKey: vacancyDedupeKey(slotId, userId),
    })),
  );
  for (const row of created) notified.add(row.userId);

  // 문자는 광고성 정보다 — 동의 확인·(광고) 표기·야간 제한은 발송 대기열이 처리한다.
  const smsText = `${batch.title}\n${batch.body}\n${env().APP_URL.replace(/\/+$/, "")}${batch.link}`;
  for (let i = 0; i < smsTargets.length; i += SMS_PARALLEL) {
    await Promise.all(
      smsTargets.slice(i, i + SMS_PARALLEL).map(async (target) => {
        const queued = await enqueueMessageDetailed({
          userId: target.id,
          channel: "SMS",
          recipient: target.phone,
          templateKey: VACANCY_TEMPLATE_KEY,
          body: smsText,
          isAdvertising: true,
          dedupeKey: vacancyDedupeKey(slotId, target.id),
        });
        if (queued.created) notified.add(target.id);
      }),
    );
  }

  const ruleIds = [...notified].flatMap((userId) => batch.ruleIdsByUser.get(userId) ?? []);
  if (ruleIds.length > 0) {
    await prisma.alertRule.updateMany({ where: { id: { in: ruleIds } }, data: { lastNotifiedAt: now } });
  }
  return notified.size;
}

/**
 * 회차에 자리가 열렸음을 알린다. 판매 중이고 예약 마감 전이며 남은 자리가 있을 때만 동작한다.
 * 트랜잭션이 끝난 뒤 호출하며, 실패해도 예외를 던지지 않는다.
 */
export async function announceVacancy(slotId: string, options: AnnounceVacancyOptions = {}): Promise<{ notified: number }> {
  try {
    return { notified: await announce(slotId, options) };
  } catch (e) {
    console.error(`[alerts] 빈자리 알림 실패 slot=${slotId}`, e);
    return { notified: 0 };
  }
}

// ── 사업자 대시보드: 수요 신호 ────────────────────────

export interface DemandSignals {
  /** 사업장을 팔로우한 회원 수 */
  followers: number;
  /** 이 사업장 상품을 찜한 수 */
  favorites: number;
  /** 이 사업장의 분류·지역을 조건으로 빈자리 알림을 걸어 둔 회원 수 */
  alertSubscribers: number;
  /** 앞으로 열릴 회차에서 자리를 기다리는 대기 건수 */
  waitlistWaiting: number;
  /** 위 대기 건의 인원 합계 */
  waitlistSeats: number;
}

export async function getDemandSignals(businessId: string): Promise<DemandSignals> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { category: { select: { slug: true } }, area: { select: { slug: true } } },
  });
  if (!business) throw err.notFound("사업장을 찾을 수 없어요.");
  const categorySlug = business.category.slug;
  const areaSlug = business.area?.slug ?? null;

  const [followers, favorites, subscribers, waitlist] = await Promise.all([
    prisma.follow.count({ where: { businessId } }),
    prisma.favorite.count({ where: { product: { businessId } } }),
    // 분류나 지역을 명시했고, 명시한 조건이 이 사업장과 어긋나지 않는 활성 조건을 가진 회원 수
    prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(DISTINCT r."userId")::int AS "count"
      FROM "AlertRule" r
      JOIN "User" u ON u."id" = r."userId"
      WHERE r."isActive" = true
        AND u."status" = 'ACTIVE'
        AND (COALESCE(cardinality(r."categorySlugs"), 0) = 0 OR ${categorySlug}::text = ANY(r."categorySlugs"))
        AND (COALESCE(cardinality(r."areaSlugs"), 0) = 0 OR ${areaSlug}::text = ANY(r."areaSlugs"))
        AND (COALESCE(cardinality(r."categorySlugs"), 0) > 0 OR COALESCE(cardinality(r."areaSlugs"), 0) > 0)`,
    prisma.waitlistEntry.aggregate({
      where: { status: "WAITING", slot: { businessId, status: "OPEN", startAt: { gt: new Date() } } },
      _count: { _all: true },
      _sum: { quantity: true },
    }),
  ]);

  return {
    followers,
    favorites,
    alertSubscribers: Number(subscribers[0]?.count ?? 0),
    waitlistWaiting: waitlist._count._all,
    waitlistSeats: waitlist._sum.quantity ?? 0,
  };
}
