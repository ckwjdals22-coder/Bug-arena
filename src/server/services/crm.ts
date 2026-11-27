import "server-only";
import { z } from "zod";
import { Prisma, type BookingChannel, type BookingStatus, type BusinessCustomer, type CustomerSource } from "@/generated/prisma/client";
import { formatPhone, maskPhone, normalizePhone } from "@/lib/format";
import { formatNumber } from "@/lib/money";
import { DAY, fmtDateTimeNumeric, kstDateKey } from "@/lib/time";
import { audit } from "@/server/audit";
import { assertBusinessAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { AppError, err, toActionError } from "@/server/errors";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { PLAN_FEATURES } from "@/server/settings";

/**
 * 사업자 고객 카드(BusinessCustomer).
 * - 예약 엔진이 recordBookingEvent 로 예약·취소·이용 완료·노쇼를 알려 주면 카드와 횟수를 자동으로 맞춘다.
 * - 사업자가 직접 등록(MANUAL)하거나 가져온(IMPORTED) 카드는 수수료 판정에서 '내 고객'의 근거가 되므로,
 *   이미 있는 카드의 유입 경로(source)는 어떤 경로로도 바꾸지 않는다.
 * - 유입 경로는 "처음 만난 경로"다. 남는자리(탐색·대기)로 먼저 예약한 번호는 그 예약이 확정되지 않아
 *   카드가 아직 없더라도, 나중에 직접 등록·가져오기·직접 입력 예약으로 카드를 만들 때 '남는자리'로 남긴다.
 * - 조회는 스태프 이상, 변경·가져오기·내보내기는 매니저 이상.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export const CUSTOMER_SOURCE_LABEL: Record<CustomerSource, string> = {
  MARKETPLACE: "남는자리",
  DIRECT: "내 예약 링크",
  MANUAL: "직접 등록",
  IMPORTED: "가져온 고객",
};

export const MAX_IMPORT_ROWS = 1000;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 12;
const MAX_MEMO_LENGTH = 1000;
const MAX_NAME_LENGTH = 30;
/** 고객 상세에 보여 주는 최근 예약 수 */
const HISTORY_LIMIT = 50;
/** 한 번에 내보내는 고객 수 상한 */
const EXPORT_LIMIT = 50_000;
const UNNAMED = "이름 없음";

const SINGLE_LINE = /^[^\p{Cc}]*$/u;
const digitsOnly = (value: string) => value.replace(/\D/g, "");
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** zod 검증 실패를 필드별 메시지를 담은 VALIDATION 오류로 바꾼다. */
function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const { error } = toActionError(parsed.error);
  throw new AppError("VALIDATION", error.message, error.fieldErrors);
}

// ── 예약 엔진 연동 ────────────────────────────────────

export type CrmBookingEvent = "BOOKED" | "CANCELLED" | "COMPLETED" | "NO_SHOW" | "NO_SHOW_REVERTED";

/** recordBookingEvent 에 넘기는 예약 값(Booking 행을 그대로 넘겨도 된다) */
export interface CrmBooking {
  businessId: string;
  userId: string | null;
  guestName: string;
  guestPhone: string;
  channel: BookingChannel;
  totalAmount: number;
  createdAt: Date;
  /** 있으면 이용 완료 때 '최근 방문일'로 쓴다(없으면 처리 시각) */
  slot?: { startAt: Date } | null;
}

const SOURCE_BY_CHANNEL: Record<BookingChannel, CustomerSource> = {
  MARKETPLACE: "MARKETPLACE",
  WAITLIST: "MARKETPLACE",
  DIRECT: "DIRECT",
  MANUAL: "MANUAL",
};

/** 남는자리가 데려온 예약의 채널 */
const PLATFORM_CHANNELS: BookingChannel[] = ["MARKETPLACE", "WAITLIST"];

/**
 * 주어진 번호 가운데 이 사업장에 남는자리(탐색·대기)로 예약한 적이 있는 번호(예약 상태와 무관).
 * before 를 주면 그 시각보다 먼저 만든 예약만 본다.
 * 승인 대기·거절·시간 초과처럼 카드가 생기기 전의 예약에서 연락처를 보고 직접 등록해
 * 이후 예약을 '내 고객'(중개 수수료 0)으로 돌리는 것을 막는 근거다.
 */
async function phonesFirstSeenOnPlatform(db: Db, businessId: string, phones: string[], before?: Date): Promise<Set<string>> {
  if (phones.length === 0) return new Set();
  const rows = await db.booking.findMany({
    where: {
      businessId,
      guestPhone: { in: phones },
      channel: { in: PLATFORM_CHANNELS },
      ...(before ? { createdAt: { lt: before } } : {}),
    },
    select: { guestPhone: true },
    distinct: ["guestPhone"],
  });
  return new Set(rows.map((row) => row.guestPhone));
}

/**
 * 예약 흐름의 사건을 고객 카드에 반영한다. (사업장, 전화번호)로 카드를 찾고 없으면 만든다.
 * - BOOKED: 예약이 확정됐을 때 한 번. 예약 수 +1, 최근 예약일 갱신
 * - CANCELLED: 취소 수 +1 / COMPLETED: 이용 완료 수 +1, 누적 결제액·최근 방문일 갱신
 * - NO_SHOW: 노쇼 수 +1 / NO_SHOW_REVERTED: 노쇼 수 −1(0 아래로 내려가지 않음)
 * 전화번호가 비어 있으면(외부 판매 자리 등) 아무것도 하지 않는다.
 * 유입 경로는 카드를 처음 만들 때의 채널로만 정하고 이후에는 바꾸지 않는다. 직접 입력 예약이라도
 * 그 번호가 남는자리로 먼저 예약한 적이 있으면 '남는자리'로 만든다.
 * 횟수는 원자적으로 증감하므로 트랜잭션 안(tx)과 밖 어디서 불러도 된다.
 */
export async function recordBookingEvent(booking: CrmBooking, event: CrmBookingEvent, db: Db = prisma): Promise<void> {
  const phone = digitsOnly(booking.guestPhone);
  if (!phone) return;
  const now = new Date();

  let source = SOURCE_BY_CHANNEL[booking.channel];
  if (source === "MANUAL" && (await phonesFirstSeenOnPlatform(db, booking.businessId, [phone], booking.createdAt)).has(phone)) {
    source = "MARKETPLACE";
  }

  // 이미 있는 카드는 건드리지 않는다(ON CONFLICT DO NOTHING).
  await db.businessCustomer.createMany({
    data: [
      {
        businessId: booking.businessId,
        userId: booking.userId,
        name: booking.guestName.trim().slice(0, MAX_NAME_LENGTH) || UNNAMED,
        phone,
        source,
        firstSeenAt: now,
      },
    ],
    skipDuplicates: true,
  });

  const sets: Prisma.Sql[] = [Prisma.sql`"updatedAt" = ${now}::timestamp`];
  if (booking.userId) sets.push(Prisma.sql`"userId" = COALESCE("userId", ${booking.userId})`);
  switch (event) {
    case "BOOKED":
      sets.push(
        Prisma.sql`"bookingCount" = "bookingCount" + 1`,
        Prisma.sql`"lastBookingAt" = GREATEST(COALESCE("lastBookingAt", ${booking.createdAt}::timestamp), ${booking.createdAt}::timestamp)`,
      );
      break;
    case "CANCELLED":
      sets.push(Prisma.sql`"cancelCount" = "cancelCount" + 1`);
      break;
    case "COMPLETED": {
      const visitedAt = booking.slot?.startAt ?? now;
      sets.push(
        Prisma.sql`"completedCount" = "completedCount" + 1`,
        Prisma.sql`"totalSpent" = "totalSpent" + ${Math.max(0, Math.floor(booking.totalAmount))}`,
        Prisma.sql`"lastVisitAt" = GREATEST(COALESCE("lastVisitAt", ${visitedAt}::timestamp), ${visitedAt}::timestamp)`,
      );
      break;
    }
    case "NO_SHOW":
      sets.push(Prisma.sql`"noShowCount" = "noShowCount" + 1`);
      break;
    case "NO_SHOW_REVERTED":
      sets.push(Prisma.sql`"noShowCount" = GREATEST("noShowCount" - 1, 0)`);
      break;
  }
  await db.$executeRaw`
    UPDATE "BusinessCustomer" SET ${Prisma.join(sets, ", ")}
    WHERE "businessId" = ${booking.businessId} AND "phone" = ${phone}`;
}

/** 사업자가 차단한 고객인지(전화번호 또는 회원 ID 로 확인). 예약 엔진이 예약을 받기 전에 확인한다. */
export async function isBlockedCustomer(
  businessId: string,
  who: { userId?: string | null; phone: string },
  db: Db = prisma,
): Promise<boolean> {
  const phone = digitsOnly(who.phone);
  const identities: Prisma.BusinessCustomerWhereInput[] = [];
  if (who.userId) identities.push({ userId: who.userId });
  if (phone) identities.push({ phone });
  if (identities.length === 0) return false;
  const card = await db.businessCustomer.findFirst({ where: { businessId, isBlocked: true, OR: identities }, select: { id: true } });
  return card !== null;
}

// ── 입력 스키마 ───────────────────────────────────────

const idSchema = z.string().min(1).max(64);

const nameSchema = z
  .string("이름을 입력해 주세요.")
  .trim()
  .min(1, "이름을 입력해 주세요.")
  .max(MAX_NAME_LENGTH, `이름은 ${MAX_NAME_LENGTH}자까지 쓸 수 있어요.`)
  .regex(SINGLE_LINE, "이름에 쓸 수 없는 문자가 있어요.");

const phoneSchema = z
  .string("휴대전화 번호를 입력해 주세요.")
  .max(30, "휴대전화 번호를 확인해 주세요.")
  .transform((value, ctx) => {
    const phone = normalizePhone(value);
    if (!phone) {
      ctx.addIssue({ code: "custom", message: "휴대전화 번호를 확인해 주세요. (예: 010-1234-5678)" });
      return z.NEVER;
    }
    return phone;
  });

const memoSchema = z
  .string()
  .trim()
  .max(MAX_MEMO_LENGTH, `메모는 ${formatNumber(MAX_MEMO_LENGTH)}자까지 쓸 수 있어요.`)
  .transform((value) => value || null);

const tagsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, "빈 태그는 넣을 수 없어요.")
      .max(MAX_TAG_LENGTH, `태그는 ${MAX_TAG_LENGTH}자까지 쓸 수 있어요.`)
      .regex(SINGLE_LINE, "태그에 쓸 수 없는 문자가 있어요."),
  )
  .max(MAX_TAGS, `태그는 ${MAX_TAGS}개까지 달 수 있어요.`)
  .transform((tags) => [...new Set(tags)]);

const customerInputSchema = z.object({
  name: nameSchema,
  phone: phoneSchema,
  memo: memoSchema.nullish(),
  tags: tagsSchema.nullish(),
});

const updateSchema = z
  .object({
    tags: tagsSchema,
    memo: memoSchema.nullable(),
    isBlocked: z.boolean("차단 여부를 확인해 주세요."),
  })
  .partial();

export const CUSTOMER_SEGMENTS = ["all", "new", "repeat", "noshow", "blocked"] as const;
export type CustomerSegment = (typeof CUSTOMER_SEGMENTS)[number];
export const CUSTOMER_SORTS = ["recent", "visits", "spent", "name"] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

const listSchema = z.object({
  q: z.string().trim().max(40, "검색어는 40자까지 쓸 수 있어요.").optional(),
  tag: z.string().trim().max(MAX_TAG_LENGTH).optional(),
  segment: z.enum(CUSTOMER_SEGMENTS).default("all"),
  sort: z.enum(CUSTOMER_SORTS).default("recent"),
  cursor: z
    .string()
    .regex(/^\d{1,7}$/, "목록 위치가 올바르지 않아요. 처음부터 다시 불러와 주세요.")
    .optional(),
  limit: z.number().int().min(1).max(100).default(30),
});

export type CustomerInput = z.input<typeof customerInputSchema>;
export type CustomerPatch = z.input<typeof updateSchema>;
export type CustomerListQuery = z.input<typeof listSchema>;

// ── 조회 형식 ─────────────────────────────────────────

/** 목록과 상세가 함께 쓰는 카드 값 */
interface CustomerSummary {
  id: string;
  name: string;
  source: CustomerSource;
  sourceLabel: string;
  /** 남는자리 회원과 연결된 카드인지 */
  isMember: boolean;
  bookingCount: number;
  completedCount: number;
  cancelCount: number;
  noShowCount: number;
  totalSpent: number;
  firstSeenAt: Date;
  lastBookingAt: Date | null;
  lastVisitAt: Date | null;
  tags: string[];
  isBlocked: boolean;
}

export interface CustomerListItem extends CustomerSummary {
  /** 목록에서는 가운데를 가린 번호만 준다: 010-****-5678 */
  phoneMasked: string;
  hasMemo: boolean;
}

export interface CustomerBookingItem {
  id: string;
  code: string;
  status: BookingStatus;
  channel: BookingChannel;
  quantity: number;
  totalAmount: number;
  productTitle: string;
  seatLabel: string;
  slotStartAt: Date;
  createdAt: Date;
}

export interface CustomerDetail extends CustomerSummary {
  businessId: string;
  /** 숫자만 있는 전체 번호 */
  phone: string;
  memo: string | null;
  /** 최근 예약부터 최대 50건 */
  bookings: CustomerBookingItem[];
}

export interface CustomerPage {
  items: CustomerListItem[];
  /** 다음 쪽이 있으면 그대로 cursor 로 넘긴다. 없으면 null */
  nextCursor: string | null;
  /** 조건에 맞는 전체 고객 수 */
  total: number;
}

function toSummary(c: BusinessCustomer): CustomerSummary {
  return {
    id: c.id,
    name: c.name,
    source: c.source,
    sourceLabel: CUSTOMER_SOURCE_LABEL[c.source],
    isMember: c.userId !== null,
    bookingCount: c.bookingCount,
    completedCount: c.completedCount,
    cancelCount: c.cancelCount,
    noShowCount: c.noShowCount,
    totalSpent: c.totalSpent,
    firstSeenAt: c.firstSeenAt,
    lastBookingAt: c.lastBookingAt,
    lastVisitAt: c.lastVisitAt,
    tags: c.tags,
    isBlocked: c.isBlocked,
  };
}

const toListItem = (c: BusinessCustomer): CustomerListItem => ({ ...toSummary(c), phoneMasked: maskPhone(c.phone), hasMemo: Boolean(c.memo) });

const SEGMENT_WHERE: Record<CustomerSegment, Prisma.BusinessCustomerWhereInput> = {
  all: {},
  new: { bookingCount: { lte: 1 } },
  repeat: { bookingCount: { gte: 2 } },
  noshow: { noShowCount: { gt: 0 } },
  blocked: { isBlocked: true },
};

const RECENT_FIRST = { lastBookingAt: { sort: "desc", nulls: "last" } } as const;
const SORT_ORDER: Record<CustomerSort, Prisma.BusinessCustomerOrderByWithRelationInput[]> = {
  recent: [RECENT_FIRST, { createdAt: "desc" }, { id: "asc" }],
  visits: [{ completedCount: "desc" }, RECENT_FIRST, { id: "asc" }],
  spent: [{ totalSpent: "desc" }, RECENT_FIRST, { id: "asc" }],
  name: [{ name: "asc" }, { id: "asc" }],
};

// ── 사업자 화면: 조회 ─────────────────────────────────

/**
 * 고객 목록(스태프 이상).
 * q 는 이름 또는 전화번호 일부, segment 는 new(예약 1회 이하) / repeat(2회 이상) / noshow(노쇼 이력) / blocked(차단).
 */
export async function listCustomers(actorUserId: string, businessId: string, query: CustomerListQuery = {}): Promise<CustomerPage> {
  await assertBusinessAccess(actorUserId, businessId, "STAFF");
  const { q, tag, segment, sort, cursor, limit } = parseInput(listSchema, query);

  const where: Prisma.BusinessCustomerWhereInput = { businessId, ...SEGMENT_WHERE[segment] };
  if (tag) where.tags = { has: tag };
  if (q) {
    const digits = digitsOnly(q);
    where.OR = [{ name: { contains: q, mode: "insensitive" } }, ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : [])];
  }

  const offset = cursor ? Number(cursor) : 0;
  const [rows, total] = await Promise.all([
    prisma.businessCustomer.findMany({ where, orderBy: SORT_ORDER[sort], skip: offset, take: limit + 1 }),
    prisma.businessCustomer.count({ where }),
  ]);
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map(toListItem),
    nextCursor: hasMore ? String(offset + limit) : null,
    total,
  };
}

/** 카드를 읽고, 행위자가 그 카드의 사업장 구성원인지 확인한다(IDOR 방지). */
async function loadCustomer(actorUserId: string, customerId: string, minRole: "STAFF" | "MANAGER"): Promise<BusinessCustomer> {
  const id = parseInput(idSchema, customerId);
  const customer = await prisma.businessCustomer.findUnique({ where: { id } });
  if (!customer) throw err.notFound("고객 정보를 찾을 수 없어요.");
  await assertBusinessAccess(actorUserId, customer.businessId, minRole);
  return customer;
}

async function toDetail(c: BusinessCustomer): Promise<CustomerDetail> {
  const bookings = await prisma.booking.findMany({
    where: { businessId: c.businessId, OR: [{ guestPhone: c.phone }, ...(c.userId ? [{ userId: c.userId }] : [])] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HISTORY_LIMIT,
    select: {
      id: true,
      code: true,
      status: true,
      channel: true,
      quantity: true,
      totalAmount: true,
      createdAt: true,
      product: { select: { title: true } },
      slotSeat: { select: { label: true } },
      slot: { select: { startAt: true } },
    },
  });
  return {
    ...toSummary(c),
    businessId: c.businessId,
    phone: c.phone,
    memo: c.memo,
    bookings: bookings.map((b) => ({
      id: b.id,
      code: b.code,
      status: b.status,
      channel: b.channel,
      quantity: b.quantity,
      totalAmount: b.totalAmount,
      productTitle: b.product.title,
      seatLabel: b.slotSeat.label,
      slotStartAt: b.slot.startAt,
      createdAt: b.createdAt,
    })),
  };
}

/** 고객 카드 상세와 예약 이력(스태프 이상) */
export async function getCustomer(actorUserId: string, customerId: string): Promise<CustomerDetail> {
  return toDetail(await loadCustomer(actorUserId, customerId, "STAFF"));
}

export interface CustomerStats {
  total: number;
  /** 예약 1회 이하 */
  firstTime: number;
  /** 예약 2회 이상 */
  repeat: number;
  /** 노쇼 이력이 있는 고객 */
  noShow: number;
  blocked: number;
  /** 최근 30일 사이 새로 생긴 카드 */
  addedLast30Days: number;
}

/** 사업장 고객 요약(대시보드용). 권한은 호출하는 쪽에서 확인한다. */
export async function getCustomerStats(businessId: string): Promise<CustomerStats> {
  const since = new Date(Date.now() - 30 * DAY);
  const rows = await prisma.$queryRaw<CustomerStats[]>`
    SELECT COUNT(*)::int AS "total",
           (COUNT(*) FILTER (WHERE "bookingCount" <= 1))::int AS "firstTime",
           (COUNT(*) FILTER (WHERE "bookingCount" >= 2))::int AS "repeat",
           (COUNT(*) FILTER (WHERE "noShowCount" > 0))::int AS "noShow",
           (COUNT(*) FILTER (WHERE "isBlocked"))::int AS "blocked",
           (COUNT(*) FILTER (WHERE "firstSeenAt" >= ${since}::timestamp))::int AS "addedLast30Days"
    FROM "BusinessCustomer"
    WHERE "businessId" = ${businessId}`;
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    firstTime: Number(row?.firstTime ?? 0),
    repeat: Number(row?.repeat ?? 0),
    noShow: Number(row?.noShow ?? 0),
    blocked: Number(row?.blocked ?? 0),
    addedLast30Days: Number(row?.addedLast30Days ?? 0),
  };
}

// ── 사업자 화면: 변경 ─────────────────────────────────

/** 태그·메모·차단 여부 수정(매니저 이상). 넘어온 항목만 바꾼다. 이름·전화번호·유입 경로는 바꿀 수 없다. */
export async function updateCustomer(actorUserId: string, customerId: string, patch: CustomerPatch): Promise<CustomerDetail> {
  const current = await loadCustomer(actorUserId, customerId, "MANAGER");
  const data = parseInput(updateSchema, patch);
  const update: Prisma.BusinessCustomerUncheckedUpdateInput = {};
  if (data.tags !== undefined) update.tags = data.tags;
  if (data.memo !== undefined) update.memo = data.memo;
  if (data.isBlocked !== undefined) update.isBlocked = data.isBlocked;
  if (Object.keys(update).length === 0) return toDetail(current);

  const customer = await prisma.businessCustomer.update({ where: { id: current.id }, data: update });
  if (data.isBlocked !== undefined && data.isBlocked !== current.isBlocked) {
    await audit({
      actorId: actorUserId,
      actorType: "SELLER",
      action: data.isBlocked ? "crm.block" : "crm.unblock",
      targetType: "BusinessCustomer",
      targetId: customer.id,
      meta: { businessId: customer.businessId },
    });
  }
  return toDetail(customer);
}

const ALREADY_REGISTERED = "이미 등록된 번호예요. 고객 목록에서 검색해 보세요.";

/**
 * 고객 직접 등록(매니저 이상). 같은 번호의 카드가 이미 있으면 덮어쓰지 않고 CONFLICT 를 낸다.
 * 카드는 '직접 등록'(MANUAL)으로 만든다. 단, 남는자리로 먼저 예약한 적이 있는 번호는 '남는자리'(MARKETPLACE)로 만든다.
 */
export async function addManualCustomer(actorUserId: string, businessId: string, input: CustomerInput): Promise<CustomerDetail> {
  await assertBusinessAccess(actorUserId, businessId, "MANAGER");
  const data = parseInput(customerInputSchema, input);
  const viaPlatform = await phonesFirstSeenOnPlatform(prisma, businessId, [data.phone]);
  try {
    const customer = await prisma.businessCustomer.create({
      data: {
        businessId,
        name: data.name,
        phone: data.phone,
        memo: data.memo ?? null,
        tags: data.tags ?? [],
        source: viaPlatform.has(data.phone) ? "MARKETPLACE" : "MANUAL",
      },
    });
    await audit({
      actorId: actorUserId,
      actorType: "SELLER",
      action: "crm.add",
      targetType: "BusinessCustomer",
      targetId: customer.id,
      meta: { businessId },
    });
    return toDetail(customer);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("CONFLICT", ALREADY_REGISTERED, { phone: ALREADY_REGISTERED });
    throw e;
  }
}

export interface ImportCustomersResult {
  created: number;
  /** 이미 카드가 있어 건너뛴 수(기존 카드는 바꾸지 않는다) */
  skippedExisting: number;
  /** 등록하지 못한 줄. row 는 넘긴 배열에서의 순서(1부터) */
  invalid: { row: number; reason: string }[];
}

/**
 * 기존 고객 명단 가져오기(매니저 이상, 한 번에 1~1,000명). 가져온 카드는 '가져온 고객'(IMPORTED)으로 만든다.
 * 형식이 틀린 줄과 앞 줄과 번호가 겹치는 줄은 invalid 로 돌려주고, 나머지는 그대로 등록한다.
 * 이미 카드가 있는 번호는 건너뛴다(유입 경로·메모·태그를 덮어쓰지 않는다).
 * 남는자리로 먼저 예약한 적이 있는 번호는 카드는 만들되 '남는자리'(MARKETPLACE)로 남긴다.
 */
export async function importCustomers(actorUserId: string, businessId: string, rows: CustomerInput[]): Promise<ImportCustomersResult> {
  await assertBusinessAccess(actorUserId, businessId, "MANAGER");
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_IMPORT_ROWS) {
    throw err.validation(`한 번에 1명부터 ${formatNumber(MAX_IMPORT_ROWS)}명까지 가져올 수 있어요. 명단을 나눠서 올려 주세요.`);
  }
  await enforceRateLimit(`crm-import:${businessId}`, 10, 3600, "명단 가져오기를 너무 자주 했어요. 한 시간 뒤에 다시 시도해 주세요.");

  const invalid: ImportCustomersResult["invalid"] = [];
  const seen = new Set<string>();
  const valid: z.output<typeof customerInputSchema>[] = [];
  rows.forEach((raw, index) => {
    const parsed = customerInputSchema.safeParse(raw);
    if (!parsed.success) {
      invalid.push({ row: index + 1, reason: parsed.error.issues[0]?.message ?? "내용을 확인해 주세요." });
      return;
    }
    if (seen.has(parsed.data.phone)) {
      invalid.push({ row: index + 1, reason: "앞 줄과 전화번호가 같아요." });
      return;
    }
    seen.add(parsed.data.phone);
    valid.push(parsed.data);
  });

  const viaPlatform = await phonesFirstSeenOnPlatform(prisma, businessId, [...seen]);
  const data = valid.map(
    (row): Prisma.BusinessCustomerCreateManyInput => ({
      businessId,
      name: row.name,
      phone: row.phone,
      memo: row.memo ?? null,
      tags: row.tags ?? [],
      source: viaPlatform.has(row.phone) ? "MARKETPLACE" : "IMPORTED",
    }),
  );

  const created = data.length > 0 ? (await prisma.businessCustomer.createMany({ data, skipDuplicates: true })).count : 0;
  const result: ImportCustomersResult = { created, skippedExisting: data.length - created, invalid };
  // 감사 로그에는 건수만 남긴다(이름·전화번호 금지).
  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "crm.import",
    targetType: "Business",
    targetId: businessId,
    meta: { rows: rows.length, created: result.created, skippedExisting: result.skippedExisting, invalid: invalid.length },
  });
  return result;
}

// ── 내보내기 ──────────────────────────────────────────

/** 엑셀이 UTF-8 로 읽게 하는 BOM. 보이지 않는 문자라 이스케이프로 적는다. */
const CSV_BOM = "\uFEFF";
const CSV_HEADER = ["이름", "전화번호", "유입 경로", "첫 등록", "최근 예약", "최근 방문", "예약", "이용 완료", "취소", "노쇼", "누적 결제액", "태그", "메모", "차단"];

/**
 * CSV 칸 하나. 수식으로 해석될 수 있는 첫 글자(= + - @ 탭 CR) 앞에는 작은따옴표를 붙여
 * 엑셀이 문자로 읽게 하고(CSV 인젝션 방지), 값 전체를 큰따옴표로 감싼다.
 */
function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

const csvDate = (date: Date | null) => (date ? fmtDateTimeNumeric(date) : "");

export interface CustomerExport {
  filename: string;
  /** UTF-8 BOM 으로 시작하는 CSV 본문(엑셀에서 한글이 깨지지 않게) */
  content: string;
  count: number;
}

/** 고객 명단 CSV 내보내기(프로 플랜, 매니저 이상). 내보낸 사실과 건수를 감사 로그에 남긴다. */
export async function exportCustomersCsv(actorUserId: string, businessId: string): Promise<CustomerExport> {
  await assertBusinessAccess(actorUserId, businessId, "MANAGER");
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { plan: true } });
  if (!business) throw err.notFound("사업장을 찾을 수 없어요.");
  if (!PLAN_FEATURES[business.plan].customerExport) {
    throw err.forbidden(`고객 명단 내보내기는 ${PLAN_FEATURES.PRO.label} 플랜에서 쓸 수 있어요.`);
  }

  const customers = await prisma.businessCustomer.findMany({
    where: { businessId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: EXPORT_LIMIT,
  });
  const lines = [CSV_HEADER.map(csvCell).join(",")];
  for (const c of customers) {
    lines.push(
      [
        c.name,
        formatPhone(c.phone),
        CUSTOMER_SOURCE_LABEL[c.source],
        csvDate(c.firstSeenAt),
        csvDate(c.lastBookingAt),
        csvDate(c.lastVisitAt),
        c.bookingCount,
        c.completedCount,
        c.cancelCount,
        c.noShowCount,
        c.totalSpent,
        c.tags.join(" "),
        c.memo ?? "",
        c.isBlocked ? "차단" : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }

  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "crm.export",
    targetType: "Business",
    targetId: businessId,
    meta: { count: customers.length },
  });
  return {
    filename: `customers-${kstDateKey(new Date())}.csv`,
    content: `${CSV_BOM}${lines.join("\r\n")}\r\n`,
    count: customers.length,
  };
}
