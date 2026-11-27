import "server-only";
import { cache } from "react";
import { z } from "zod";
import {
  Prisma,
  type BookingStatus,
  type Gender,
  type PaymentPolicy,
  type SeatGender,
  type SlotStatus,
  type VacancyOrigin,
  type WaitlistStatus,
} from "@/generated/prisma/client";
import { ACTIVE_BOOKING_STATUSES, SEAT_GENDER_LABEL, VACANCY_ORIGINS, parseCancellationTiers, type CancellationTier } from "@/lib/domain";
import { formatKRW } from "@/lib/money";
import { addDays, fmtDate, fmtDateTime, fmtTime, kstDateKey, kstParts, kstWeekendRange, parseKst, startOfKstDay } from "@/lib/time";
import { prisma } from "@/server/db";
import { AppError, err, toActionError } from "@/server/errors";
import { getPublicBusiness } from "@/server/services/business";
import { getReviewSummary, listReviewsForBusiness, type ReviewPage, type ReviewSummary } from "@/server/services/reviews";

/**
 * 공개 카탈로그(읽기 전용) — 홈 피드, 검색·목록, 자리 상세, 사업장 페이지, 공유·사이트맵.
 *
 * 원칙
 * - 남은 자리 = capacity − reserved (음수 없음). 화면의 모든 숫자는 DB 값에서 나온다.
 * - 내부 값(reserved·withheld, 사업자 메모, 예약자 연락처, 계좌, 수수료)은 어떤 반환값에도 담지 않는다.
 * - 정렬 기준은 공개돼 있다: 예약 가능한 자리가 먼저, 그 안에서 고른 기준(기본: 시작이 빠른 순). 광고·상위 노출·할인율순 정렬은 없다.
 * - 정확한 주소는 예약이 확정된 고객에게만 준다(docs 6.10). 판매자 신원정보는 법정 표시 사항이라 항상 준다.
 */

// ── 공통 ──────────────────────────────────────────────

/** zod 검증 실패를 필드별 메시지를 담은 VALIDATION 오류로 바꾼다. */
function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const { error } = toActionError(parsed.error);
  throw new AppError("VALIDATION", error.message, error.fieldErrors);
}

const idSchema = z.string().min(1).max(64);
const slugSchema = z.string().trim().min(1, "조건을 다시 골라 주세요.").max(60, "조건을 다시 골라 주세요.");

/** LIKE 패턴의 특수문자(%, _, \)를 글자 그대로 찾도록 바꾼다. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** 목록을 보는 사람. 로그인 세션의 회원 정보(SessionUser)를 그대로 넘기면 된다. */
export interface CatalogViewer {
  id: string;
  gender?: Gender | null;
  birthYear?: number | null;
}

/** 참가 나이 판정에 쓰는 나이: KST 기준 올해 − 출생 연도(연 나이). 회원 정보에 출생 연도만 있기 때문이다. */
export function ageOf(birthYear: number, now: Date = new Date()): number {
  return kstParts(now).year - birthYear;
}

/**
 * 공개 노출 규칙 — 이 한 곳에서만 정의한다(목록·피드·검색·찜·팔로우·사이트맵이 모두 여기 것을 쓴다).
 * - 공개 상품: 사업장 승인(APPROVED) + 상품 판매 중(ACTIVE). 자리 상세를 열 수 있는 조건이다.
 * - 공개 회차: 공개 상품 + 회차 판매 중(OPEN) + 예약 마감 전. 목록에 나오는 조건이다.
 * SQL 조각은 별칭 s(Slot)·p(Product)·b(Business)를 전제로 한다.
 */
export const visibility = {
  product: { status: "ACTIVE", business: { status: "APPROVED" } } satisfies Prisma.ProductWhereInput,
  business: { status: "APPROVED" } satisfies Prisma.BusinessWhereInput,
  slot: (now: Date): Prisma.SlotWhereInput => ({
    status: "OPEN",
    bookingDeadlineAt: { gt: now },
    product: { status: "ACTIVE" },
    business: { status: "APPROVED" },
  }),
  productSql: Prisma.sql`p."status" = 'ACTIVE' AND b."status" = 'APPROVED'`,
  slotSql: (now: Date) =>
    Prisma.sql`p."status" = 'ACTIVE' AND b."status" = 'APPROVED' AND s."status" = 'OPEN' AND s."bookingDeadlineAt" > ${now}::timestamp`,
};

/** 정확한 주소를 볼 수 있는 예약 상태 — "예약이 확정된 고객"(docs 6.10) */
export const ADDRESS_DISCLOSURE_STATUSES: BookingStatus[] = ["CONFIRMED", "COMPLETED"];

// ── 분류 · 지역 ───────────────────────────────────────

export interface CategoryItem {
  slug: string;
  name: string;
  icon: string;
  description: string | null;
}

export interface AreaItem {
  slug: string;
  name: string;
  district: string;
  city: string;
}

/** 활성 분류(정렬 순). 같은 요청 안에서는 한 번만 조회한다. */
export const listCategories = cache(async (): Promise<CategoryItem[]> => {
  return prisma.category.findMany({
    where: { isActive: true },
    orderBy: [{ sort: "asc" }, { name: "asc" }],
    select: { slug: true, name: true, icon: true, description: true },
  });
});

const loadAreas = cache(async (city: string | null): Promise<AreaItem[]> => {
  return prisma.area.findMany({
    where: { isActive: true, ...(city ? { city } : {}) },
    orderBy: [{ sort: "asc" }, { district: "asc" }, { name: "asc" }],
    select: { slug: true, name: true, district: true, city: true },
  });
});

/** 활성 지역(정렬 순). city 를 주면 그 시의 동네만. 같은 요청 안에서는 한 번만 조회한다. */
export async function listAreas(options: { city?: string } = {}): Promise<AreaItem[]> {
  const city = parseInput(z.string().trim().min(1).max(20).optional(), options.city);
  return loadAreas(city ?? null);
}

// ── 자리 카드 ─────────────────────────────────────────

export interface VacancySeat {
  id: string;
  label: string;
  gender: SeatGender;
  capacity: number;
  /** 남은 자리 = capacity − reserved (0 이상) */
  remaining: number;
  price: number;
  /** 정가. price 보다 클 때만 값이 있다(그 밖에는 null — 할인 표시 없음) */
  originalPrice: number | null;
  /** 이 좌석 유형에서 차례를 기다리는 대기 신청 건수 */
  waitingCount: number;
}

export type GoStateKind = "NONE" | "GATHERING" | "CONFIRMED";

/** 개최 확정 상태(docs 6.7). 최소 인원 조건이 없으면 NONE */
export interface GoState {
  state: GoStateKind;
  /** 모으는 중일 때, 확정까지 더 필요한 인원(좌석 유형별) */
  needs: { label: string; gender: SeatGender; remaining: number }[];
  decideAt: Date | null;
}

export interface VacancyCard {
  slotId: string;
  startAt: Date;
  endAt: Date;
  bookingDeadlineAt: Date;
  origin: VacancyOrigin;
  /** 사업자가 고객에게 보여 주려고 적은 한 줄 메모 */
  note: string | null;
  vacancyPostedAt: Date;
  product: {
    id: string;
    title: string;
    summary: string | null;
    image: string | null;
    tags: string[];
    durationMin: number;
    minAge: number | null;
    maxAge: number | null;
    requiresApproval: boolean;
    isDemo: boolean;
  };
  category: { slug: string; name: string; icon: string };
  business: { slug: string; name: string; ratingAvg: number; ratingCount: number };
  area: { slug: string; name: string; district: string } | null;
  placeName: string | null;
  seats: VacancySeat[];
  totalRemaining: number;
  totalCapacity: number;
  /** 남은 자리가 있는 좌석 중 가장 싼 가격(매진이면 전체 중 가장 싼 가격) */
  minPrice: number;
  /** minPrice 좌석의 정가(할인 중일 때만) */
  minOriginalPrice: number | null;
  waitingCount: number;
  go: GoState;
  /** viewer 를 넘겼을 때만 들어 있다 */
  isFavorite?: boolean;
}

interface SeatRow {
  id: string;
  label: string;
  gender: SeatGender;
  capacity: number;
  remaining: number;
  minCount: number;
  price: number;
  originalPrice: number | null;
  waitingCount: number;
  confirmedCount: number;
}

interface CardRow {
  slotId: string;
  startAt: Date;
  endAt: Date;
  bookingDeadlineAt: Date;
  origin: VacancyOrigin;
  note: string | null;
  vacancyPostedAt: Date;
  decideAt: Date | null;
  goConfirmedAt: Date | null;
  productId: string;
  title: string;
  summary: string | null;
  images: string[] | null;
  tags: string[] | null;
  durationMin: number;
  minAge: number | null;
  maxAge: number | null;
  requiresApproval: boolean;
  isDemo: boolean;
  placeName: string | null;
  categorySlug: string;
  categoryName: string;
  categoryIcon: string;
  businessSlug: string;
  businessName: string;
  ratingAvg: number;
  ratingCount: number;
  areaSlug: string | null;
  areaName: string | null;
  areaDistrict: string | null;
  seats: SeatRow[];
  isFavorite: boolean;
}

/** 목록·집계가 함께 쓰는 FROM 절. agg = 회차의 남은 자리 합계와 대표 가격(남은 좌석 중 최저가, 매진이면 전체 최저가) */
const SLOT_FROM = Prisma.sql`
  FROM "Slot" s
  JOIN "Product" p ON p."id" = s."productId"
  JOIN "Business" b ON b."id" = s."businessId"
  JOIN "Category" c ON c."id" = p."categoryId"
  LEFT JOIN "Area" a ON a."id" = COALESCE(p."areaId", b."areaId")
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(GREATEST(ss."capacity" - ss."reserved", 0)), 0)::int AS "remaining",
           COALESCE(MIN(ss."price") FILTER (WHERE ss."capacity" > ss."reserved"), MIN(ss."price"), 0)::int AS "price"
    FROM "SlotSeat" ss
    WHERE ss."slotId" = s."id"
  ) agg`;

/** 좌석 유형별 화면 값. 남은 자리·대기·확정 인원을 SQL 에서 계산해, reserved·withheld 는 애초에 꺼내지 않는다. */
const SEATS_JSON = Prisma.sql`(
  SELECT COALESCE(json_agg(json_build_object(
    'id', ss."id",
    'label', ss."label",
    'gender', ss."gender",
    'capacity', ss."capacity",
    'remaining', GREATEST(ss."capacity" - ss."reserved", 0),
    'minCount', ss."minCount",
    'price', ss."price",
    'originalPrice', ss."originalPrice",
    'waitingCount', (SELECT COUNT(*) FROM "WaitlistEntry" w WHERE w."slotSeatId" = ss."id" AND w."status" = 'WAITING'),
    'confirmedCount', (
      SELECT COALESCE(SUM(k."quantity"), 0) FROM "Booking" k
      WHERE k."slotSeatId" = ss."id" AND k."status" IN ('CONFIRMED', 'COMPLETED')
    )
  ) ORDER BY ss."sort", ss."id"), '[]'::json)
  FROM "SlotSeat" ss
  WHERE ss."slotId" = s."id"
)`;

function toSeat(row: SeatRow): VacancySeat {
  const price = Number(row.price);
  const original = row.originalPrice === null ? null : Number(row.originalPrice);
  return {
    id: row.id,
    label: row.label,
    gender: row.gender,
    capacity: Number(row.capacity),
    remaining: Math.max(0, Number(row.remaining)),
    price,
    originalPrice: original !== null && original > price ? original : null,
    waitingCount: Number(row.waitingCount),
  };
}

function toGoState(slot: { decideAt: Date | null; goConfirmedAt: Date | null }, seats: SeatRow[]): GoState {
  // 최소 인원 조건이 하나도 없으면 표시하지 않는다.
  if (seats.every((s) => Number(s.minCount) <= 0)) return { state: "NONE", needs: [], decideAt: null };
  // 개최 확정은 기록된 시각(goConfirmedAt)으로만 판단한다 — 한 번 확정되면 이후 취소가 나와도 되돌리지 않는다.
  if (slot.goConfirmedAt) return { state: "CONFIRMED", needs: [], decideAt: slot.decideAt };
  const needs = seats
    .filter((s) => Number(s.minCount) > Number(s.confirmedCount))
    .map((s) => ({ label: s.label, gender: s.gender, remaining: Number(s.minCount) - Number(s.confirmedCount) }));
  return { state: "GATHERING", needs, decideAt: slot.decideAt };
}

function summarizePrices(seats: VacancySeat[]): { minPrice: number; minOriginalPrice: number | null } {
  const open = seats.filter((s) => s.remaining > 0);
  const pool = open.length > 0 ? open : seats;
  if (pool.length === 0) return { minPrice: 0, minOriginalPrice: null };
  const minPrice = Math.min(...pool.map((s) => s.price));
  // 같은 최저가 좌석이 모두 할인 중일 때만 정가를 함께 보여 준다(일부만 할인인데 전체가 할인처럼 보이지 않게).
  const originals = pool.filter((s) => s.price === minPrice).map((s) => s.originalPrice);
  const minOriginalPrice = originals.every((o): o is number => o !== null) ? Math.min(...originals) : null;
  return { minPrice, minOriginalPrice };
}

function toCard(row: CardRow, withFavorite: boolean): VacancyCard {
  const seats = row.seats.map(toSeat);
  return {
    slotId: row.slotId,
    startAt: row.startAt,
    endAt: row.endAt,
    bookingDeadlineAt: row.bookingDeadlineAt,
    origin: row.origin,
    note: row.note,
    vacancyPostedAt: row.vacancyPostedAt,
    product: {
      id: row.productId,
      title: row.title,
      summary: row.summary,
      image: row.images?.[0] ?? null,
      tags: row.tags ?? [],
      durationMin: row.durationMin,
      minAge: row.minAge,
      maxAge: row.maxAge,
      requiresApproval: row.requiresApproval,
      isDemo: row.isDemo,
    },
    category: { slug: row.categorySlug, name: row.categoryName, icon: row.categoryIcon },
    business: { slug: row.businessSlug, name: row.businessName, ratingAvg: row.ratingAvg, ratingCount: row.ratingCount },
    area: row.areaSlug && row.areaName && row.areaDistrict ? { slug: row.areaSlug, name: row.areaName, district: row.areaDistrict } : null,
    placeName: row.placeName ?? row.businessName,
    seats,
    totalRemaining: seats.reduce((sum, s) => sum + s.remaining, 0),
    totalCapacity: seats.reduce((sum, s) => sum + s.capacity, 0),
    ...summarizePrices(seats),
    waitingCount: seats.reduce((sum, s) => sum + s.waitingCount, 0),
    go: toGoState(row, row.seats),
    ...(withFavorite ? { isFavorite: Boolean(row.isFavorite) } : {}),
  };
}

/** 회차 ID 목록을 카드로 만든다(쿼리 1회). 공개 여부는 호출하는 쪽이 이미 걸렀다고 본다. */
async function loadCards(slotIds: string[], viewerId: string | null): Promise<Map<string, VacancyCard>> {
  const ids = [...new Set(slotIds)];
  if (ids.length === 0) return new Map();
  const favorite = viewerId
    ? Prisma.sql`EXISTS (SELECT 1 FROM "Favorite" f WHERE f."userId" = ${viewerId} AND f."productId" = p."id")`
    : Prisma.sql`false`;
  const rows = await prisma.$queryRaw<CardRow[]>`
    SELECT s."id" AS "slotId", s."startAt", s."endAt", s."bookingDeadlineAt", s."origin"::text AS "origin", s."note",
           s."vacancyPostedAt", s."decideAt", s."goConfirmedAt",
           p."id" AS "productId", p."title", p."summary", p."images", p."tags", p."durationMin", p."minAge", p."maxAge",
           p."requiresApproval", p."isDemo", p."placeName",
           c."slug" AS "categorySlug", c."name" AS "categoryName", c."icon" AS "categoryIcon",
           b."slug" AS "businessSlug", b."name" AS "businessName", b."ratingAvg", b."ratingCount",
           a."slug" AS "areaSlug", a."name" AS "areaName", a."district" AS "areaDistrict",
           ${SEATS_JSON} AS "seats",
           ${favorite} AS "isFavorite"
    FROM "Slot" s
    JOIN "Product" p ON p."id" = s."productId"
    JOIN "Business" b ON b."id" = s."businessId"
    JOIN "Category" c ON c."id" = p."categoryId"
    LEFT JOIN "Area" a ON a."id" = COALESCE(p."areaId", b."areaId")
    WHERE s."id" = ANY(${ids}::text[])`;
  return new Map(rows.map((row) => [row.slotId, toCard(row, viewerId !== null)]));
}

const pickCards = (ids: string[], cards: Map<string, VacancyCard>): VacancyCard[] =>
  ids.map((id) => cards.get(id)).filter((card): card is VacancyCard => card !== undefined);

// ── 목록 조회(공개 회차 ID 를 정렬·커서와 함께 고른다) ──

export const VACANCY_SORTS = ["soon", "new", "price", "deadline"] as const;
export type VacancySort = (typeof VACANCY_SORTS)[number];
export const VACANCY_WHENS = ["today", "tomorrow", "weekend", "week", "all"] as const;
export type VacancyWhen = (typeof VACANCY_WHENS)[number];
export const TIME_BANDS = ["morning", "afternoon", "evening", "night", "afterwork"] as const;
export type TimeBand = (typeof TIME_BANDS)[number];

/** 매진 회차는 예약 가능한 회차 뒤에 둔다(대기 신청 입구이므로 숨기지는 않는다). */
const RANK = Prisma.sql`(CASE WHEN agg."remaining" > 0 THEN 0 ELSE 1 END)`;

const SORT_KEYS: Record<VacancySort, { expr: Prisma.Sql; desc: boolean; kind: "time" | "number" }> = {
  soon: { expr: Prisma.sql`s."startAt"`, desc: false, kind: "time" },
  new: { expr: Prisma.sql`s."vacancyPostedAt"`, desc: true, kind: "time" },
  price: { expr: Prisma.sql`agg."price"`, desc: false, kind: "number" },
  deadline: { expr: Prisma.sql`s."bookingDeadlineAt"`, desc: false, kind: "time" },
};

/** 시작 시각의 KST 시(0~23). DB 에는 UTC 로 저장돼 있어 9시간을 더해 읽는다. */
const KST_HOUR = Prisma.sql`EXTRACT(HOUR FROM s."startAt" + interval '9 hours')`;

const TIME_BAND_SQL: Record<TimeBand, Prisma.Sql> = {
  morning: Prisma.sql`(${KST_HOUR} >= 6 AND ${KST_HOUR} < 12)`,
  afternoon: Prisma.sql`(${KST_HOUR} >= 12 AND ${KST_HOUR} < 17)`,
  evening: Prisma.sql`(${KST_HOUR} >= 17 AND ${KST_HOUR} < 21)`,
  night: Prisma.sql`(${KST_HOUR} >= 21 OR ${KST_HOUR} < 6)`,
  afterwork: Prisma.sql`(${KST_HOUR} >= 18 AND ${KST_HOUR} < 22)`,
};

interface PageCursor {
  s: VacancySort;
  r: number;
  k: string | number;
  i: string;
}

const cursorSchema = z.object({
  s: z.enum(VACANCY_SORTS),
  r: z.number().int().min(0).max(1),
  k: z.union([z.string().min(1).max(40), z.number().int().min(0)]),
  i: z.string().min(1).max(64),
});

const encodeCursor = (cursor: PageCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

function decodeCursor(raw: string, sort: VacancySort): PageCursor {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    const kind = SORT_KEYS[sort].kind;
    const keyOk = kind === "number" ? typeof parsed.k === "number" : typeof parsed.k === "string" && !Number.isNaN(Date.parse(parsed.k));
    if (parsed.s === sort && keyOk) return parsed;
  } catch {
    // 아래에서 같은 오류로 알린다
  }
  throw err.validation("목록을 처음부터 다시 불러와 주세요.");
}

interface SlotPick {
  id: string;
  rank: number;
  sortKey: Date | number;
}

const cursorOf = (sort: VacancySort, row: SlotPick): string =>
  encodeCursor({ s: sort, r: Number(row.rank), k: row.sortKey instanceof Date ? row.sortKey.toISOString() : Number(row.sortKey), i: row.id });

/**
 * 공개 회차를 조건·정렬에 맞춰 고른다. 정렬은 (예약 가능 여부, 정렬 키, ID) 순이라
 * 같은 키를 가진 회차가 많아도 커서로 넘길 때 겹치거나 빠지지 않는다.
 */
async function pickSlots(args: {
  now: Date;
  conditions?: Prisma.Sql[];
  sort?: VacancySort;
  limit: number;
  cursor?: PageCursor | null;
}): Promise<SlotPick[]> {
  const sort = args.sort ?? "soon";
  const key = SORT_KEYS[sort];
  const where = [visibility.slotSql(args.now), ...(args.conditions ?? [])];
  if (args.cursor) {
    const c = args.cursor;
    const value = key.kind === "time" ? Prisma.sql`${new Date(String(c.k))}::timestamp` : Prisma.sql`${Number(c.k)}::int`;
    const beyond = key.desc ? Prisma.sql`${key.expr} < ${value}` : Prisma.sql`${key.expr} > ${value}`;
    where.push(
      Prisma.sql`(${RANK} > ${c.r}::int OR (${RANK} = ${c.r}::int AND (${beyond} OR (${key.expr} = ${value} AND s."id" > ${c.i}))))`,
    );
  }
  const direction = key.desc ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  return prisma.$queryRaw<SlotPick[]>`
    SELECT s."id", ${RANK}::int AS "rank", ${key.expr} AS "sortKey"
    ${SLOT_FROM}
    WHERE ${Prisma.join(where, " AND ")}
    ORDER BY ${RANK} ASC, ${key.expr} ${direction}, s."id" ASC
    LIMIT ${args.limit}::int`;
}

const startRange = (from: Date, to: Date) => Prisma.sql`s."startAt" >= ${from}::timestamp AND s."startAt" < ${to}::timestamp`;
const AVAILABLE = Prisma.sql`agg."remaining" > 0`;

// ── 검색·목록 ─────────────────────────────────────────

export interface VacancyFilters {
  /** 검색어(40자 이하). 상품 제목·요약·태그, 사업장 이름, 분류·동네 이름에서 찾는다 */
  q?: string;
  categorySlug?: string;
  areaSlug?: string;
  /** 구(예: 서구) */
  district?: string;
  when?: VacancyWhen;
  /** "YYYY-MM-DD"(KST). 주면 when 보다 우선한다 */
  dateKey?: string;
  timeBand?: TimeBand;
  minPrice?: number;
  maxPrice?: number;
  /** 그 성별이 지금 예약할 수 있는 좌석(해당 성별 전용 또는 누구나)이 남아 있는 회차만 */
  seatGender?: "MALE" | "FEMALE";
  /**
   * 보는 사람이 지금 예약할 수 있는 좌석이 남아 있는 회차만(성별·나이 조건이 맞고 자리가 남음).
   * 회원 정보에 성별·출생 연도가 둘 다 없으면 적용하지 않는다(forMeApplied=false).
   * 하나만 있으면, 없는 정보가 필요한 자리(성별 전용 좌석·나이 조건이 있는 상품)는 예약할 수 없으므로 빠진다.
   */
  forMe?: boolean;
  origin?: VacancyOrigin;
  /** 정가보다 싸게 나온, 남은 좌석이 있는 회차만 */
  discountedOnly?: boolean;
  /** true 면 매진 회차를 뺀다(기본 false — 매진 회차는 대기 신청 입구라서 뒤쪽에 보여 준다) */
  availableOnly?: boolean;
  sort?: VacancySort;
  cursor?: string;
  /** 기본 20, 최대 50 */
  limit?: number;
}

export interface VacancyPage {
  items: VacancyCard[];
  nextCursor: string | null;
  /** forMe 를 실제로 적용했는지(회원 정보에 성별·출생 연도가 없으면 false) */
  forMeApplied: boolean;
}

const priceSchema = z.number().int("가격을 다시 입력해 주세요.").min(0, "가격은 0원 이상이어야 해요.").max(100_000_000, "가격을 다시 입력해 주세요.");

const filtersSchema = z.object({
  q: z.string().trim().max(40, "검색어는 40자까지 쓸 수 있어요.").optional(),
  categorySlug: slugSchema.optional(),
  areaSlug: slugSchema.optional(),
  district: z.string().trim().min(1, "조건을 다시 골라 주세요.").max(20, "조건을 다시 골라 주세요.").optional(),
  when: z.enum(VACANCY_WHENS, "날짜 조건을 다시 골라 주세요.").optional(),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "날짜를 다시 골라 주세요.").optional(),
  timeBand: z.enum(TIME_BANDS, "시간대를 다시 골라 주세요.").optional(),
  minPrice: priceSchema.optional(),
  maxPrice: priceSchema.optional(),
  seatGender: z.enum(["MALE", "FEMALE"], "성별 조건을 다시 골라 주세요.").optional(),
  forMe: z.boolean().optional(),
  origin: z.enum(VACANCY_ORIGINS, "자리 종류를 다시 골라 주세요.").optional(),
  discountedOnly: z.boolean().optional(),
  availableOnly: z.boolean().optional(),
  sort: z.enum(VACANCY_SORTS, "정렬 기준을 다시 골라 주세요.").optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

type ParsedFilters = z.output<typeof filtersSchema>;

function whenRange(filters: ParsedFilters, now: Date): { from: Date; to: Date } | null {
  if (filters.dateKey) {
    const from = parseKst(filters.dateKey);
    if (!from) throw err.validation("날짜를 다시 골라 주세요.", { dateKey: "날짜를 다시 골라 주세요." });
    return { from, to: addDays(from, 1) };
  }
  const today = startOfKstDay(now);
  switch (filters.when) {
    case "today":
      return { from: today, to: addDays(today, 1) };
    case "tomorrow":
      return { from: addDays(today, 1), to: addDays(today, 2) };
    case "weekend":
      return kstWeekendRange(now);
    case "week":
      return { from: today, to: addDays(today, 7) };
    default:
      return null;
  }
}

function buildConditions(f: ParsedFilters, viewer: CatalogViewer | null, now: Date): { conditions: Prisma.Sql[]; forMeApplied: boolean } {
  const conditions: Prisma.Sql[] = [];

  // 검색어는 띄어쓰기로 나눠, 모든 낱말이 어딘가에 들어 있는 회차만 찾는다.
  for (const token of (f.q ?? "").split(/\s+/).filter(Boolean).slice(0, 5)) {
    const pattern = `%${escapeLike(token)}%`;
    conditions.push(Prisma.sql`(
      p."title" ILIKE ${pattern} OR COALESCE(p."summary", '') ILIKE ${pattern}
      OR array_to_string(p."tags", ' ') ILIKE ${pattern}
      OR b."name" ILIKE ${pattern} OR c."name" ILIKE ${pattern}
      OR COALESCE(a."name", '') ILIKE ${pattern} OR COALESCE(a."district", '') ILIKE ${pattern}
    )`);
  }
  if (f.categorySlug) conditions.push(Prisma.sql`c."slug" = ${f.categorySlug}`);
  if (f.areaSlug) conditions.push(Prisma.sql`a."slug" = ${f.areaSlug}`);
  if (f.district) conditions.push(Prisma.sql`a."district" = ${f.district}`);
  const range = whenRange(f, now);
  if (range) conditions.push(startRange(range.from, range.to));
  if (f.timeBand) conditions.push(TIME_BAND_SQL[f.timeBand]);
  if (f.origin) conditions.push(Prisma.sql`s."origin"::text = ${f.origin}`);
  if (f.availableOnly) conditions.push(AVAILABLE);

  // 좌석 조건(성별·가격·할인)은 "같은 좌석 하나"가 모두 만족해야 한다.
  const seat: Prisma.Sql[] = [];
  let mustBeOpen = false;
  if (f.seatGender) {
    seat.push(Prisma.sql`ss."gender"::text IN (${f.seatGender}, 'ANY')`);
    mustBeOpen = true;
  }
  // forMe 는 자리 상세의 참가 조건 안내(seatEligibility)와 같은 기준을 쓴다:
  // 성별 전용 좌석은 내 성별과 같아야 하고, 나이 조건이 있는 상품은 출생 연도가 있어야 하며 범위 안이어야 한다.
  const forMeApplied = Boolean(f.forMe && viewer && (viewer.gender || viewer.birthYear));
  if (forMeApplied && viewer) {
    mustBeOpen = true;
    seat.push(viewer.gender ? Prisma.sql`ss."gender"::text IN (${viewer.gender}, 'ANY')` : Prisma.sql`ss."gender" = 'ANY'`);
    if (viewer.birthYear) {
      const age = ageOf(viewer.birthYear, now);
      conditions.push(
        Prisma.sql`(p."minAge" IS NULL OR p."minAge" <= ${age}::int) AND (p."maxAge" IS NULL OR p."maxAge" >= ${age}::int)`,
      );
    } else {
      conditions.push(Prisma.sql`p."minAge" IS NULL AND p."maxAge" IS NULL`);
    }
  }
  if (f.minPrice !== undefined) seat.push(Prisma.sql`ss."price" >= ${f.minPrice}::int`);
  if (f.maxPrice !== undefined) seat.push(Prisma.sql`ss."price" <= ${f.maxPrice}::int`);
  if (f.discountedOnly) {
    seat.push(Prisma.sql`ss."originalPrice" > ss."price"`);
    mustBeOpen = true;
  }
  if (seat.length > 0 || mustBeOpen) {
    // 가격만 고른 경우, 매진 회차(대기 입구)는 어떤 좌석이든 가격이 맞으면 남긴다.
    seat.push(mustBeOpen ? Prisma.sql`ss."capacity" > ss."reserved"` : Prisma.sql`(ss."capacity" > ss."reserved" OR agg."remaining" = 0)`);
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "SlotSeat" ss WHERE ss."slotId" = s."id" AND ${Prisma.join(seat, " AND ")})`,
    );
  }
  return { conditions, forMeApplied };
}

/**
 * 공개 중인 자리 목록. 예약 가능한 회차가 먼저 나오고, 그 안에서 sort 기준으로 정렬한다
 * (soon: 시작 빠른 순 · new: 최근에 나온 순 · price: 싼 순 · deadline: 예약 마감 빠른 순).
 */
export async function listVacancies(filters: VacancyFilters = {}, viewer?: CatalogViewer | null): Promise<VacancyPage> {
  const f = parseInput(filtersSchema, filters);
  const now = new Date();
  const sort = f.sort ?? "soon";
  const limit = f.limit ?? 20;
  const cursor = f.cursor ? decodeCursor(f.cursor, sort) : null;
  const { conditions, forMeApplied } = buildConditions(f, viewer ?? null, now);

  const rows = await pickSlots({ now, conditions, sort, limit: limit + 1, cursor });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const cards = await loadCards(page.map((row) => row.id), viewer?.id ?? null);
  return {
    items: pickCards(page.map((row) => row.id), cards),
    nextCursor: rows.length > limit && last ? cursorOf(sort, last) : null,
    forMeApplied,
  };
}

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * 주소의 검색 조건(searchParams)을 목록 조건으로 바꾼다. 형식이 틀린 값은 버리고 검색어는 40자로 자른다.
 * 쓰는 이름: q, category, area, district, when, date, time, min, max, gender, me, origin, discounted, available, sort, cursor
 */
export function parseVacancyFilters(params: SearchParams): VacancyFilters {
  const text = (key: string, max: number): string | undefined => {
    const raw = params[key];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    return value && value.length <= max ? value : undefined;
  };
  const oneOf = <T extends string>(key: string, values: readonly T[]): T | undefined => {
    const value = text(key, 40);
    return values.find((v) => v === value);
  };
  const amount = (key: string): number | undefined => {
    const value = text(key, 9);
    return value && /^\d+$/.test(value) ? Number(value) : undefined;
  };
  const flag = (key: string): true | undefined => {
    const value = text(key, 5);
    return value === "1" || value === "true" ? true : undefined;
  };
  const rawQuery = params.q;
  const q = (Array.isArray(rawQuery) ? rawQuery[0] : rawQuery)?.trim().slice(0, 40).trim();
  const date = text("date", 10);
  const filters: VacancyFilters = {
    q: q || undefined,
    categorySlug: text("category", 60),
    areaSlug: text("area", 60),
    district: text("district", 20),
    when: oneOf("when", VACANCY_WHENS),
    dateKey: date && parseKst(date) ? date : undefined,
    timeBand: oneOf("time", TIME_BANDS),
    minPrice: amount("min"),
    maxPrice: amount("max"),
    seatGender: oneOf("gender", ["MALE", "FEMALE"] as const),
    forMe: flag("me"),
    origin: oneOf("origin", VACANCY_ORIGINS),
    discountedOnly: flag("discounted"),
    availableOnly: flag("available"),
    sort: oneOf("sort", VACANCY_SORTS),
    cursor: text("cursor", 512),
  };
  // 값이 없는 항목은 키째로 뺀다.
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)) as VacancyFilters;
}

/**
 * 상품별(또는 사업장별) 다음 공개 회차 카드. 예약 가능한 회차가 먼저, 그 안에서 시작이 빠른 순으로 perOwner 개까지.
 * 찜·팔로우 목록이 쓴다. 공개 규칙을 통과한 회차만 나온다.
 */
export async function listNextVacancyCards(
  by: "product" | "business",
  ownerIds: string[],
  perOwner: number,
  viewer?: CatalogViewer | null,
): Promise<Map<string, VacancyCard[]>> {
  const ids = [...new Set(parseInput(z.array(idSchema).max(500), ownerIds))];
  const take = parseInput(z.number().int().min(1).max(20), perOwner);
  const result = new Map<string, VacancyCard[]>();
  if (ids.length === 0) return result;
  const owner = by === "product" ? Prisma.sql`p."id"` : Prisma.sql`b."id"`;
  const rows = await prisma.$queryRaw<{ id: string; ownerId: string }[]>`
    SELECT t."id", t."ownerId"
    FROM (
      SELECT s."id", ${owner} AS "ownerId",
             ROW_NUMBER() OVER (PARTITION BY ${owner} ORDER BY ${RANK} ASC, s."startAt" ASC, s."id" ASC) AS "rn"
      ${SLOT_FROM}
      WHERE ${visibility.slotSql(new Date())} AND ${owner} = ANY(${ids}::text[])
    ) t
    WHERE t."rn" <= ${take}::int
    ORDER BY t."ownerId", t."rn"`;
  const cards = await loadCards(rows.map((row) => row.id), viewer?.id ?? null);
  for (const row of rows) {
    const card = cards.get(row.id);
    if (card) result.set(row.ownerId, [...(result.get(row.ownerId) ?? []), card]);
  }
  return result;
}

// ── 홈 피드 ───────────────────────────────────────────

/** "기다리던 자리가 났어요" — 내 대기에 온 자리 제안(좌석을 잡아 둔 상태) */
export interface MyOffer {
  entryId: string;
  slotId: string;
  seatId: string;
  seatLabel: string;
  seatGender: SeatGender;
  quantity: number;
  price: number;
  originalPrice: number | null;
  /** 이 시각까지 자리를 잡아 둔다 */
  offerExpiresAt: Date;
  startAt: Date;
  endAt: Date;
  title: string;
  businessName: string;
  image: string | null;
}

/** 결제를 마치지 않아 아직 좌석을 잡아 둔 내 예약 */
export interface ResumableHold {
  code: string;
  slotId: string;
  title: string;
  seatLabel: string;
  quantity: number;
  payNowAmount: number;
  holdExpiresAt: Date;
  startAt: Date;
}

export interface HomeFeed {
  /** 취소·노쇼로 방금 다시 나온 자리(최근에 나온 순, 예약 가능한 것만, 최대 8) */
  justReleased: VacancyCard[];
  /** 오늘·내일·이번 주말(각 최대 12, 예약 가능한 자리 먼저) */
  today: VacancyCard[];
  tomorrow: VacancyCard[];
  weekend: VacancyCard[];
  /** 모레 이후에 시작하는 예약 가능한 회차 수 */
  laterCount: number;
  /** 오늘부터 7일간, 날짜별 예약 가능한 회차 수 */
  dayCounts: { dateKey: string; openCount: number }[];
  /** 분류별, 7일 안에 시작하는 예약 가능한 회차 수 */
  categoryCounts: { slug: string; name: string; icon: string; openCount: number }[];
  stats: { openSeatsToday: number };
  /** viewer 가 있을 때만 채운다 */
  myOffers: MyOffer[];
  resumableHolds: ResumableHold[];
}

const HOME_RELEASED_MAX = 8;
const HOME_SECTION_MAX = 12;
const HOME_DAYS = 7;

async function loadMyOffers(userId: string, now: Date): Promise<MyOffer[]> {
  const rows = await prisma.waitlistEntry.findMany({
    where: { userId, status: "OFFERED", offerExpiresAt: { gt: now }, slot: visibility.slot(now) },
    orderBy: [{ offerExpiresAt: "asc" }, { id: "asc" }],
    take: 10,
    select: {
      id: true,
      quantity: true,
      offerExpiresAt: true,
      slotSeat: { select: { id: true, label: true, gender: true, price: true, originalPrice: true } },
      slot: {
        select: {
          id: true,
          startAt: true,
          endAt: true,
          product: { select: { title: true, images: true } },
          business: { select: { name: true } },
        },
      },
    },
  });
  return rows.flatMap((row) => {
    if (!row.offerExpiresAt) return [];
    const { price, originalPrice } = row.slotSeat;
    return [
      {
        entryId: row.id,
        slotId: row.slot.id,
        seatId: row.slotSeat.id,
        seatLabel: row.slotSeat.label,
        seatGender: row.slotSeat.gender,
        quantity: row.quantity,
        price,
        originalPrice: originalPrice !== null && originalPrice > price ? originalPrice : null,
        offerExpiresAt: row.offerExpiresAt,
        startAt: row.slot.startAt,
        endAt: row.slot.endAt,
        title: row.slot.product.title,
        businessName: row.slot.business.name,
        image: row.slot.product.images[0] ?? null,
      },
    ];
  });
}

async function loadResumableHolds(userId: string, now: Date): Promise<ResumableHold[]> {
  const rows = await prisma.booking.findMany({
    where: { userId, status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } },
    orderBy: [{ holdExpiresAt: "asc" }, { id: "asc" }],
    take: 5,
    select: {
      code: true,
      slotId: true,
      quantity: true,
      payNowAmount: true,
      holdExpiresAt: true,
      slot: { select: { startAt: true } },
      slotSeat: { select: { label: true } },
      product: { select: { title: true } },
    },
  });
  return rows.flatMap((row) =>
    row.holdExpiresAt
      ? [
          {
            code: row.code,
            slotId: row.slotId,
            title: row.product.title,
            seatLabel: row.slotSeat.label,
            quantity: row.quantity,
            payNowAmount: row.payNowAmount,
            holdExpiresAt: row.holdExpiresAt,
            startAt: row.slot.startAt,
          },
        ]
      : [],
  );
}

/** 홈 화면 피드. areaSlug 를 주면 공개 구역(내 제안·결제 대기 제외)을 그 동네로 좁힌다. */
export async function getHomeFeed(viewer?: CatalogViewer | null, options: { areaSlug?: string } = {}): Promise<HomeFeed> {
  const areaSlug = parseInput(slugSchema.optional(), options.areaSlug);
  const now = new Date();
  const today = startOfKstDay(now);
  const weekend = kstWeekendRange(now);
  const area = areaSlug ? [Prisma.sql`a."slug" = ${areaSlug}`] : [];
  const scope = Prisma.join([visibility.slotSql(now), AVAILABLE, ...area], " AND ");

  const [released, todayRows, tomorrowRows, weekendRows, dayRows, categoryRows, categories, myOffers, resumableHolds] =
    await Promise.all([
      pickSlots({
        now,
        conditions: [...area, AVAILABLE, Prisma.sql`s."origin" IN ('CANCELLATION', 'NO_SHOW')`],
        sort: "new",
        limit: HOME_RELEASED_MAX,
      }),
      pickSlots({ now, conditions: [...area, startRange(today, addDays(today, 1))], limit: HOME_SECTION_MAX }),
      pickSlots({ now, conditions: [...area, startRange(addDays(today, 1), addDays(today, 2))], limit: HOME_SECTION_MAX }),
      pickSlots({ now, conditions: [...area, startRange(weekend.from, weekend.to)], limit: HOME_SECTION_MAX }),
      prisma.$queryRaw<{ dateKey: string; openCount: number; openSeats: number }[]>`
        SELECT to_char(s."startAt" + interval '9 hours', 'YYYY-MM-DD') AS "dateKey",
               COUNT(*)::int AS "openCount", COALESCE(SUM(agg."remaining"), 0)::int AS "openSeats"
        ${SLOT_FROM}
        WHERE ${scope}
        GROUP BY 1`,
      prisma.$queryRaw<{ slug: string; openCount: number }[]>`
        SELECT c."slug", COUNT(*)::int AS "openCount"
        ${SLOT_FROM}
        WHERE ${scope} AND s."startAt" < ${addDays(today, HOME_DAYS)}::timestamp
        GROUP BY c."slug"`,
      listCategories(),
      viewer ? loadMyOffers(viewer.id, now) : Promise.resolve([]),
      viewer ? loadResumableHolds(viewer.id, now) : Promise.resolve([]),
    ]);

  const sections = [released, todayRows, tomorrowRows, weekendRows].map((rows) => rows.map((row) => row.id));
  const cards = await loadCards(sections.flat(), viewer?.id ?? null);
  const [justReleased = [], todayCards = [], tomorrowCards = [], weekendCards = []] = sections.map((ids) => pickCards(ids, cards));

  const byDay = new Map(dayRows.map((row) => [row.dateKey, row]));
  const laterFrom = kstDateKey(addDays(today, 2));
  const openByCategory = new Map(categoryRows.map((row) => [row.slug, Number(row.openCount)]));
  return {
    justReleased,
    today: todayCards,
    tomorrow: tomorrowCards,
    weekend: weekendCards,
    laterCount: dayRows.reduce((sum, row) => (row.dateKey >= laterFrom ? sum + Number(row.openCount) : sum), 0),
    dayCounts: Array.from({ length: HOME_DAYS }, (_, i) => {
      const dateKey = kstDateKey(addDays(today, i));
      return { dateKey, openCount: Number(byDay.get(dateKey)?.openCount ?? 0) };
    }),
    categoryCounts: categories.map((c) => ({ slug: c.slug, name: c.name, icon: c.icon, openCount: openByCategory.get(c.slug) ?? 0 })),
    stats: { openSeatsToday: Number(byDay.get(kstDateKey(today))?.openSeats ?? 0) },
    myOffers,
    resumableHolds,
  };
}

// ── 자리 상세 ─────────────────────────────────────────

export type SlotState = "OPEN" | "DEADLINE_PASSED" | "CLOSED" | "CANCELLED" | "ENDED";

function slotStateOf(slot: { status: SlotStatus; endAt: Date; bookingDeadlineAt: Date }, now: Date): SlotState {
  if (slot.status === "CANCELLED") return "CANCELLED";
  if (slot.endAt.getTime() <= now.getTime()) return "ENDED";
  if (slot.status === "CLOSED") return "CLOSED";
  if (slot.bookingDeadlineAt.getTime() <= now.getTime()) return "DEADLINE_PASSED";
  return "OPEN";
}

/** 장소. 정확한 주소·좌표는 예약이 확정된 고객(addressDisclosed)에게만 들어 있다 */
export interface SlotPlace {
  placeName: string | null;
  area: { slug: string; name: string; district: string; city: string } | null;
  addressDisclosed: boolean;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

/** 판매자 신원정보 — 통신판매중개 플랫폼의 법정 표시 사항이라 누구에게나 보여 준다 */
export interface SellerIdentity {
  name: string;
  representativeName: string | null;
  businessRegNo: string | null;
  mailOrderRegNo: string | null;
  phone: string | null;
  /** 사업장 소재지(등록 주소) */
  address: string | null;
}

export interface BusinessCard {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  logoImage: string | null;
  ratingAvg: number;
  ratingCount: number;
  followerCount: number;
}

export type EligibilityIssue = "GENDER_REQUIRED" | "GENDER_MISMATCH" | "AGE_REQUIRED" | "AGE_TOO_YOUNG" | "AGE_TOO_OLD";

/** 좌석별 참가 조건 안내(예약 가능 여부의 최종 판단은 예약 시점에 다시 한다) */
export interface SeatEligibility {
  seatId: string;
  eligible: boolean;
  issues: { code: EligibilityIssue; message: string }[];
}

export interface ViewerWaitlistEntry {
  id: string;
  status: WaitlistStatus;
  seatId: string;
  quantity: number;
  offerExpiresAt: Date | null;
  /** 제안(OFFERED)을 받았고 아직 응답 시간이 남아 있는지. 시간이 지난 제안은 정리 전이라도 false 다 */
  offerActive: boolean;
  /** 대기 중(WAITING)일 때 그 좌석 유형에서의 내 순번(1부터). 제안을 받은 상태면 null */
  position: number | null;
}

export interface SlotViewerState {
  isFavorite: boolean;
  isFollowing: boolean;
  eligibility: SeatEligibility[];
  /** 이 회차에 진행 중인 내 예약(결제 대기는 시간이 남아 있을 때만) */
  activeBooking: { code: string; status: BookingStatus; holdExpiresAt: Date | null } | null;
  /** 가장 먼저 챙겨야 할 내 대기(응답 시간이 남은 제안이 먼저, 그다음 줄 선 순서) */
  waitlistEntry: ViewerWaitlistEntry | null;
  /** 이 회차에 걸어 둔 내 대기 전체(좌석 유형별) */
  waitlistEntries: ViewerWaitlistEntry[];
}

export interface SlotDetail {
  slotId: string;
  state: SlotState;
  serverTime: Date;
  startAt: Date;
  endAt: Date;
  bookingDeadlineAt: Date;
  origin: VacancyOrigin;
  note: string | null;
  vacancyPostedAt: Date;
  seats: VacancySeat[];
  totalRemaining: number;
  totalCapacity: number;
  minPrice: number;
  minOriginalPrice: number | null;
  waitingCount: number;
  go: GoState;
  product: {
    id: string;
    title: string;
    summary: string | null;
    description: string | null;
    includes: string | null;
    notice: string | null;
    images: string[];
    tags: string[];
    durationMin: number;
    minAge: number | null;
    maxAge: number | null;
    requiresApproval: boolean;
    requiresIdentity: boolean;
    paymentPolicy: PaymentPolicy;
    depositAmount: number | null;
    maxPerBooking: number;
    resaleRefundRate: number | null;
    cancellationTiers: CancellationTier[];
    isDemo: boolean;
  };
  category: { slug: string; name: string; icon: string };
  place: SlotPlace;
  business: BusinessCard;
  seller: SellerIdentity;
  /** 이 상품의 공개 후기 요약 */
  reviews: ReviewSummary;
  /** 같은 상품의 다른 회차(자리가 남은 것, 시작 빠른 순, 최대 6) */
  otherSlots: VacancyCard[];
  /** 로그인하지 않았으면 null */
  viewer: SlotViewerState | null;
}

const joinAddress = (...parts: (string | null)[]) => parts.filter(Boolean).join(" ") || null;

function toSellerIdentity(b: {
  name: string;
  representativeName: string | null;
  businessRegNo: string | null;
  mailOrderRegNo: string | null;
  phone: string | null;
  address: string | null;
  addressDetail: string | null;
}): SellerIdentity {
  return {
    name: b.name,
    representativeName: b.representativeName,
    businessRegNo: b.businessRegNo,
    mailOrderRegNo: b.mailOrderRegNo,
    phone: b.phone,
    address: joinAddress(b.address, b.addressDetail),
  };
}

function seatEligibility(
  seat: { id: string; gender: SeatGender },
  product: { minAge: number | null; maxAge: number | null },
  viewer: CatalogViewer,
  now: Date,
): SeatEligibility {
  const issues: SeatEligibility["issues"] = [];
  if (seat.gender !== "ANY") {
    if (!viewer.gender) issues.push({ code: "GENDER_REQUIRED", message: "내 정보에 성별을 등록하면 예약할 수 있어요." });
    else if (viewer.gender !== seat.gender) {
      issues.push({ code: "GENDER_MISMATCH", message: `${SEAT_GENDER_LABEL[seat.gender]}만 예약할 수 있는 자리예요.` });
    }
  }
  if (product.minAge !== null || product.maxAge !== null) {
    if (!viewer.birthYear) issues.push({ code: "AGE_REQUIRED", message: "내 정보에 출생 연도를 등록하면 예약할 수 있어요." });
    else {
      const age = ageOf(viewer.birthYear, now);
      if (product.minAge !== null && age < product.minAge) {
        issues.push({ code: "AGE_TOO_YOUNG", message: `${product.minAge}세부터 참가할 수 있어요.` });
      } else if (product.maxAge !== null && age > product.maxAge) {
        issues.push({ code: "AGE_TOO_OLD", message: `${product.maxAge}세까지 참가할 수 있어요.` });
      }
    }
  }
  return { seatId: seat.id, eligible: issues.length === 0, issues };
}

const detailSelect = {
  id: true,
  status: true,
  product: {
    select: {
      id: true,
      status: true,
      description: true,
      includes: true,
      notice: true,
      images: true,
      requiresIdentity: true,
      paymentPolicy: true,
      depositAmount: true,
      maxPerBooking: true,
      resaleRefundRate: true,
      cancellationTiers: true,
      address: true,
      lat: true,
      lng: true,
      area: { select: { slug: true, name: true, district: true, city: true } },
    },
  },
  business: {
    select: {
      id: true,
      status: true,
      slug: true,
      name: true,
      tagline: true,
      logoImage: true,
      ratingAvg: true,
      ratingCount: true,
      followerCount: true,
      phone: true,
      address: true,
      addressDetail: true,
      lat: true,
      lng: true,
      representativeName: true,
      businessRegNo: true,
      mailOrderRegNo: true,
      area: { select: { slug: true, name: true, district: true, city: true } },
    },
  },
} satisfies Prisma.SlotSelect;

interface ViewerSlotData {
  isFollowing: boolean;
  bookings: { code: string; status: BookingStatus; holdExpiresAt: Date | null }[];
  waitlist: ViewerWaitlistEntry[];
}

async function loadViewerSlotData(slotId: string, businessId: string, viewerId: string, now: Date): Promise<ViewerSlotData> {
  const [follow, bookings, waitlist] = await Promise.all([
    prisma.follow.findUnique({ where: { userId_businessId: { userId: viewerId, businessId } }, select: { userId: true } }),
    prisma.booking.findMany({
      where: { slotId, userId: viewerId, status: { in: [...ACTIVE_BOOKING_STATUSES, "COMPLETED"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { code: true, status: true, holdExpiresAt: true },
    }),
    // 순번 = 같은 좌석 유형에서 나보다 먼저 줄 선 대기 수 + 1 (기준: queuedAt)
    prisma.$queryRaw<{ id: string; status: WaitlistStatus; seatId: string; quantity: number; offerExpiresAt: Date | null; position: number }[]>`
      SELECT w."id", w."status"::text AS "status", w."slotSeatId" AS "seatId", w."quantity", w."offerExpiresAt",
             (
               SELECT COUNT(*) FROM "WaitlistEntry" o
               WHERE o."slotSeatId" = w."slotSeatId" AND o."status" = 'WAITING'
                 AND (o."queuedAt" < w."queuedAt" OR (o."queuedAt" = w."queuedAt" AND o."id" < w."id"))
             )::int + 1 AS "position"
      FROM "WaitlistEntry" w
      WHERE w."slotId" = ${slotId} AND w."userId" = ${viewerId} AND w."status" IN ('WAITING', 'OFFERED')
      ORDER BY w."queuedAt" ASC, w."id" ASC`,
  ]);
  const entries = waitlist.map((w) => ({
    id: w.id,
    status: w.status,
    seatId: w.seatId,
    quantity: Number(w.quantity),
    offerExpiresAt: w.offerExpiresAt,
    // 시간이 지난 제안은 정리 작업이 아직 돌지 않았어도 살아 있는 제안으로 보여 주지 않는다.
    offerActive: w.status === "OFFERED" && w.offerExpiresAt !== null && w.offerExpiresAt.getTime() > now.getTime(),
    position: w.status === "WAITING" ? Number(w.position) : null,
  }));
  return {
    isFollowing: follow !== null,
    bookings,
    // 응답 시간이 남은 제안을 맨 앞에(정렬이 안정적이라 나머지는 줄 선 순서 그대로)
    waitlist: entries.sort((x, y) => Number(y.offerActive) - Number(x.offerActive)),
  };
}

/**
 * 자리 상세. 회차가 없거나 사업장이 승인 상태가 아니거나 상품이 판매 중이 아니면 null.
 * 마감·종료·취소된 회차도 내용은 그대로 주고 state 로 구분한다.
 */
export async function getSlotDetail(slotId: string, viewer?: CatalogViewer | null): Promise<SlotDetail | null> {
  const id = idSchema.safeParse(slotId);
  if (!id.success) return null;
  const slot = await prisma.slot.findUnique({ where: { id: id.data }, select: detailSelect });
  if (!slot || slot.business.status !== "APPROVED" || slot.product.status !== "ACTIVE") return null;

  const now = new Date();
  const { product, business } = slot;
  const [others, reviews, viewerData] = await Promise.all([
    pickSlots({
      now,
      conditions: [Prisma.sql`p."id" = ${product.id}`, Prisma.sql`s."id" <> ${slot.id}`, AVAILABLE],
      limit: 6,
    }),
    getReviewSummary({ productId: product.id }),
    viewer ? loadViewerSlotData(slot.id, business.id, viewer.id, now) : Promise.resolve(null),
  ]);
  const otherIds = others.map((row) => row.id);
  const cards = await loadCards([slot.id, ...otherIds], viewer?.id ?? null);
  const card = cards.get(slot.id);
  if (!card) return null;

  // 정확한 주소는 예약이 확정된 고객에게만(docs 6.10). 상품에 장소가 따로 없으면 사업장 주소가 곧 진행 장소다.
  const addressDisclosed = Boolean(viewerData?.bookings.some((b) => ADDRESS_DISCLOSURE_STATUSES.includes(b.status)));
  const venue = product.address
    ? { address: product.address, lat: product.lat, lng: product.lng }
    : { address: joinAddress(business.address, business.addressDetail), lat: business.lat, lng: business.lng };

  let viewerState: SlotViewerState | null = null;
  if (viewer && viewerData) {
    const activeBooking =
      viewerData.bookings.find(
        (b) =>
          ACTIVE_BOOKING_STATUSES.some((status) => status === b.status) &&
          // 결제 시간이 지난 홀드는 진행 중인 예약으로 보여 주지 않는다.
          (b.status !== "PENDING_PAYMENT" || (b.holdExpiresAt !== null && b.holdExpiresAt.getTime() > now.getTime())),
      ) ?? null;
    viewerState = {
      isFavorite: card.isFavorite ?? false,
      isFollowing: viewerData.isFollowing,
      eligibility: card.seats.map((seat) => seatEligibility(seat, card.product, viewer, now)),
      activeBooking,
      waitlistEntry: viewerData.waitlist[0] ?? null,
      waitlistEntries: viewerData.waitlist,
    };
  }

  return {
    slotId: card.slotId,
    state: slotStateOf({ status: slot.status, endAt: card.endAt, bookingDeadlineAt: card.bookingDeadlineAt }, now),
    serverTime: now,
    startAt: card.startAt,
    endAt: card.endAt,
    bookingDeadlineAt: card.bookingDeadlineAt,
    origin: card.origin,
    note: card.note,
    vacancyPostedAt: card.vacancyPostedAt,
    seats: card.seats,
    totalRemaining: card.totalRemaining,
    totalCapacity: card.totalCapacity,
    minPrice: card.minPrice,
    minOriginalPrice: card.minOriginalPrice,
    waitingCount: card.waitingCount,
    go: card.go,
    product: {
      id: product.id,
      title: card.product.title,
      summary: card.product.summary,
      description: product.description,
      includes: product.includes,
      notice: product.notice,
      images: product.images,
      tags: card.product.tags,
      durationMin: card.product.durationMin,
      minAge: card.product.minAge,
      maxAge: card.product.maxAge,
      requiresApproval: card.product.requiresApproval,
      requiresIdentity: product.requiresIdentity,
      paymentPolicy: product.paymentPolicy,
      depositAmount: product.depositAmount,
      maxPerBooking: product.maxPerBooking,
      resaleRefundRate: product.resaleRefundRate,
      cancellationTiers: parseCancellationTiers(product.cancellationTiers),
      isDemo: card.product.isDemo,
    },
    category: card.category,
    place: {
      placeName: card.placeName,
      area: product.area ?? business.area,
      addressDisclosed,
      address: addressDisclosed ? venue.address : null,
      lat: addressDisclosed ? venue.lat : null,
      lng: addressDisclosed ? venue.lng : null,
    },
    business: {
      id: business.id,
      slug: business.slug,
      name: business.name,
      tagline: business.tagline,
      logoImage: business.logoImage,
      ratingAvg: business.ratingAvg,
      ratingCount: business.ratingCount,
      followerCount: business.followerCount,
    },
    seller: toSellerIdentity(business),
    reviews,
    otherSlots: pickCards(otherIds, cards),
    viewer: viewerState,
  };
}

export interface SlotAvailability {
  state: SlotState;
  seats: { id: string; remaining: number }[];
  serverTime: Date;
}

/** 잔여석 폴링용 가벼운 조회(쿼리 1회). 공개할 수 없는 회차는 null */
export async function getSlotAvailability(slotId: string): Promise<SlotAvailability | null> {
  const id = idSchema.safeParse(slotId);
  if (!id.success) return null;
  const now = new Date();
  const rows = await prisma.$queryRaw<
    { status: SlotStatus; endAt: Date; bookingDeadlineAt: Date; seats: { id: string; remaining: number }[] }[]
  >`
    SELECT s."status"::text AS "status", s."endAt", s."bookingDeadlineAt",
           (
             SELECT COALESCE(json_agg(json_build_object(
               'id', ss."id", 'remaining', GREATEST(ss."capacity" - ss."reserved", 0)
             ) ORDER BY ss."sort", ss."id"), '[]'::json)
             FROM "SlotSeat" ss WHERE ss."slotId" = s."id"
           ) AS "seats"
    FROM "Slot" s
    JOIN "Product" p ON p."id" = s."productId"
    JOIN "Business" b ON b."id" = s."businessId"
    WHERE s."id" = ${id.data} AND ${visibility.productSql}`;
  const row = rows[0];
  if (!row) return null;
  return {
    state: slotStateOf(row, now),
    seats: row.seats.map((seat) => ({ id: seat.id, remaining: Math.max(0, Number(seat.remaining)) })),
    serverTime: now,
  };
}

// ── 사업장 페이지 ─────────────────────────────────────

export interface BusinessProductCard {
  id: string;
  title: string;
  summary: string | null;
  image: string | null;
  /** 정가(1인 기준) */
  basePrice: number;
  durationMin: number;
  tags: string[];
  category: { slug: string; name: string; icon: string };
  ratingAvg: number;
  ratingCount: number;
  /** viewer 를 넘겼을 때만 들어 있다 */
  isFavorite?: boolean;
}

export interface BusinessPage {
  business: {
    id: string;
    slug: string;
    name: string;
    tagline: string | null;
    description: string | null;
    category: { slug: string; name: string };
    area: { slug: string; name: string; district: string; city: string } | null;
    coverImage: string | null;
    logoImage: string | null;
    instagram: string | null;
    kakaoChannel: string | null;
    website: string | null;
    ratingAvg: number;
    ratingCount: number;
    followerCount: number;
    isDemo: boolean;
  };
  seller: SellerIdentity;
  /** 앞으로 열리는 공개 회차(예약 가능한 자리 먼저, 시작 빠른 순, 최대 30) */
  vacancies: VacancyCard[];
  /** 판매 중인 상품 */
  products: BusinessProductCard[];
  /** 이 사업장의 공개 후기 요약 */
  reviews: ReviewSummary;
  /** 공개 후기 첫 쪽(최신순 10건). 이어 보기는 listReviewsForBusiness 에 nextCursor 를 넘긴다 */
  latestReviews: ReviewPage;
  /** 로그인하지 않았으면 null */
  viewer: { isFollowing: boolean } | null;
}

/** 공개 사업장 페이지(/b/{slug}). 승인된 사업장이 아니면 null */
export async function getBusinessPage(slug: string, viewer?: CatalogViewer | null): Promise<BusinessPage | null> {
  const profile = await getPublicBusiness(slug);
  if (!profile) return null;
  const now = new Date();
  const [slotRows, productRows, reviews, latestReviews, follow, favorites] = await Promise.all([
    pickSlots({ now, conditions: [Prisma.sql`b."id" = ${profile.id}`], limit: 30 }),
    prisma.product.findMany({
      where: { businessId: profile.id, ...visibility.product },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
      select: {
        id: true,
        title: true,
        summary: true,
        images: true,
        basePrice: true,
        durationMin: true,
        tags: true,
        ratingAvg: true,
        ratingCount: true,
        category: { select: { slug: true, name: true, icon: true } },
      },
    }),
    getReviewSummary({ businessId: profile.id }),
    listReviewsForBusiness(profile.id, { limit: 10 }),
    viewer
      ? prisma.follow.findUnique({ where: { userId_businessId: { userId: viewer.id, businessId: profile.id } }, select: { userId: true } })
      : Promise.resolve(null),
    viewer
      ? prisma.favorite.findMany({ where: { userId: viewer.id, product: { businessId: profile.id } }, select: { productId: true } })
      : Promise.resolve([]),
  ]);
  const slotIds = slotRows.map((row) => row.id);
  const cards = await loadCards(slotIds, viewer?.id ?? null);
  const favoriteIds = new Set(favorites.map((f) => f.productId));

  return {
    business: {
      id: profile.id,
      slug: profile.slug,
      name: profile.name,
      tagline: profile.tagline,
      description: profile.description,
      category: profile.category,
      area: profile.area,
      coverImage: profile.coverImage,
      logoImage: profile.logoImage,
      instagram: profile.instagram,
      kakaoChannel: profile.kakaoChannel,
      website: profile.website,
      ratingAvg: profile.ratingAvg,
      ratingCount: profile.ratingCount,
      followerCount: profile.followerCount,
      isDemo: profile.isDemo,
    },
    seller: {
      name: profile.legal.name,
      representativeName: profile.legal.representativeName,
      businessRegNo: profile.legal.businessRegNo,
      mailOrderRegNo: profile.legal.mailOrderRegNo,
      phone: profile.legal.phone,
      address: profile.legal.address,
    },
    vacancies: pickCards(slotIds, cards),
    products: productRows.map((p) => ({
      id: p.id,
      title: p.title,
      summary: p.summary,
      image: p.images[0] ?? null,
      basePrice: p.basePrice,
      durationMin: p.durationMin,
      tags: p.tags,
      category: p.category,
      ratingAvg: p.ratingAvg,
      ratingCount: p.ratingCount,
      ...(viewer ? { isFavorite: favoriteIds.has(p.id) } : {}),
    })),
    reviews,
    latestReviews,
    viewer: viewer ? { isFollowing: follow !== null } : null,
  };
}

// ── 검색어 추천 ───────────────────────────────────────

export interface SearchSuggestion {
  type: "category" | "area" | "product" | "business";
  label: string;
  /** 보조 문구: 동네의 구, 상품의 사업장 이름 */
  sub: string | null;
  /** 분류·동네·사업장의 슬러그 */
  slug: string | null;
  /** 상품이면 가장 가까운 공개 회차 */
  slotId: string | null;
}

const SUGGEST_MAX = 8;
const SUGGEST_TYPE_ORDER: SearchSuggestion["type"][] = ["category", "area", "product", "business"];

/** 입력 중인 검색어에 맞는 추천(최대 8건): 분류, 동네, 공개 회차가 있는 상품, 승인된 사업장. 앞부분이 맞는 것을 먼저 보여 준다. */
export async function searchSuggest(q: string): Promise<SearchSuggestion[]> {
  const term = (typeof q === "string" ? q : "").trim().slice(0, 40).trim();
  if (!term) return [];
  const contains = `%${escapeLike(term)}%`;
  const prefix = `${escapeLike(term)}%`;
  const now = new Date();
  const rows = await prisma.$queryRaw<(SearchSuggestion & { isPrefix: boolean })[]>`
    (SELECT 'category' AS "type", c."name" AS "label", NULL::text AS "sub", c."slug" AS "slug", NULL::text AS "slotId",
            (c."name" ILIKE ${prefix}) AS "isPrefix"
     FROM "Category" c
     WHERE c."isActive" = true AND c."name" ILIKE ${contains}
     ORDER BY "isPrefix" DESC, c."sort" ASC, c."name" ASC
     LIMIT 3)
    UNION ALL
    (SELECT 'area', a."name", a."district", a."slug", NULL::text, (a."name" ILIKE ${prefix})
     FROM "Area" a
     WHERE a."isActive" = true AND (a."name" ILIKE ${contains} OR a."district" ILIKE ${contains})
     ORDER BY 6 DESC, a."sort" ASC, a."name" ASC
     LIMIT 3)
    UNION ALL
    (SELECT 'product', p."title", b."name", NULL::text, nxt."id", (p."title" ILIKE ${prefix})
     FROM "Product" p
     JOIN "Business" b ON b."id" = p."businessId"
     JOIN LATERAL (
       SELECT s."id" FROM "Slot" s
       WHERE s."productId" = p."id" AND ${visibility.slotSql(now)}
       ORDER BY s."startAt" ASC, s."id" ASC
       LIMIT 1
     ) nxt ON true
     WHERE p."title" ILIKE ${contains}
     ORDER BY 6 DESC, p."title" ASC, p."id" ASC
     LIMIT 6)
    UNION ALL
    (SELECT 'business', b."name", NULL::text, b."slug", NULL::text, (b."name" ILIKE ${prefix})
     FROM "Business" b
     WHERE b."status" = 'APPROVED' AND b."name" ILIKE ${contains}
     ORDER BY 6 DESC, b."name" ASC, b."id" ASC
     LIMIT 4)`;
  // UNION ALL 은 순서를 보장하지 않으므로 여기서 정한다: 앞부분 일치 → 종류 순 → 이름 순(정렬은 안정적이라 가지 안의 순서는 유지된다).
  const typeOrder = (type: SearchSuggestion["type"]) => SUGGEST_TYPE_ORDER.indexOf(type);
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (x, y) =>
        Number(y.row.isPrefix) - Number(x.row.isPrefix) || typeOrder(x.row.type) - typeOrder(y.row.type) || x.index - y.index,
    )
    .slice(0, SUGGEST_MAX)
    .map(({ row }) => ({ type: row.type, label: row.label, sub: row.sub, slug: row.slug, slotId: row.slotId }));
}

// ── 사이트맵 · 공유 ───────────────────────────────────

export interface SitemapEntries {
  slots: { slotId: string; lastModified: Date }[];
  businesses: { slug: string; lastModified: Date }[];
}

const SITEMAP_MAX = 5000;

/** sitemap.xml 용: 지금 공개 중인 회차와 승인된 사업장 페이지 */
export async function getSitemapEntries(): Promise<SitemapEntries> {
  const now = new Date();
  const [slots, businesses] = await Promise.all([
    prisma.slot.findMany({
      where: visibility.slot(now),
      orderBy: [{ startAt: "asc" }, { id: "asc" }],
      take: SITEMAP_MAX,
      select: { id: true, updatedAt: true },
    }),
    prisma.business.findMany({
      where: visibility.business,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: SITEMAP_MAX,
      select: { slug: true, updatedAt: true },
    }),
  ]);
  return {
    slots: slots.map((s) => ({ slotId: s.id, lastModified: s.updatedAt })),
    businesses: businesses.map((b) => ({ slug: b.slug, lastModified: b.updatedAt })),
  };
}

/** 공유 카드(Open Graph)용 정보. 남은 자리 수는 담지 않는다 — 캐시된 카드가 지난 재고를 보여 주면 안 되기 때문이다. */
export interface ShareMeta {
  title: string;
  businessName: string;
  /** "11월 27일 (금)" */
  dateText: string;
  /** "19:30" */
  timeText: string;
  /** "11월 27일 (금) 19:30" */
  whenText: string;
  areaName: string | null;
  /** 가장 싼 좌석 가격(재고와 무관하게 전체 좌석 기준) */
  price: number;
  /** "무료" / "30,000원" / "30,000원부터" */
  priceText: string;
  image: string | null;
  /** "11월 27일 (금) 19:30 · 둔산동 · 30,000원" */
  description: string;
  state: SlotState;
}

export async function getShareMeta(slotId: string): Promise<ShareMeta | null> {
  const id = idSchema.safeParse(slotId);
  if (!id.success) return null;
  const slot = await prisma.slot.findUnique({
    where: { id: id.data },
    select: {
      status: true,
      startAt: true,
      endAt: true,
      bookingDeadlineAt: true,
      seats: { select: { price: true } },
      product: { select: { status: true, title: true, images: true, area: { select: { name: true } } } },
      business: { select: { status: true, name: true, area: { select: { name: true } } } },
    },
  });
  if (!slot || slot.business.status !== "APPROVED" || slot.product.status !== "ACTIVE") return null;

  const prices = slot.seats.map((seat) => seat.price);
  const price = prices.length > 0 ? Math.min(...prices) : 0;
  const base = price === 0 ? "무료" : formatKRW(price);
  const priceText = prices.some((p) => p !== price) ? `${base}부터` : base;
  const areaName = slot.product.area?.name ?? slot.business.area?.name ?? null;
  const whenText = fmtDateTime(slot.startAt);
  return {
    title: slot.product.title,
    businessName: slot.business.name,
    dateText: fmtDate(slot.startAt),
    timeText: fmtTime(slot.startAt),
    whenText,
    areaName,
    price,
    priceText,
    image: slot.product.images[0] ?? null,
    description: [whenText, areaName, priceText].filter(Boolean).join(" · "),
    state: slotStateOf(slot, new Date()),
  };
}
