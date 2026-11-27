import "server-only";
import { z } from "zod";
import { Prisma, type AdminRole, type ReviewStatus } from "@/generated/prisma/client";
import { maskName } from "@/lib/format";
import { DAY } from "@/lib/time";
import { audit } from "@/server/audit";
import { assertBusinessAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { AppError, err, toActionError } from "@/server/errors";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { notify } from "@/server/services/notifications";
import { notifyBusinessMembers } from "@/server/services/notifications/events";
import { getSettings } from "@/server/settings";

/**
 * 후기 서비스.
 * - 이용 완료(COMPLETED)된 예약의 본인만, 완료 후 reviewWindowDays 안에, 예약당 한 번 쓸 수 있다.
 * - 사업자는 답글만 달 수 있다(수정·숨김 불가). 숨김은 운영자(CS·OPS·SUPER)가 사유와 함께 처리한다.
 * - 상품·사업장의 평점 집계(ratingAvg/ratingCount)는 공개(VISIBLE) 후기만으로, 변경과 같은 트랜잭션에서 다시 계산한다.
 */

/** 공개 후기가 이 개수보다 적으면 평점 대신 "신규"로 보여 준다. */
export const REVIEW_NEW_THRESHOLD = 3;
export const REVIEW_CONTENT_MIN = 10;
export const REVIEW_CONTENT_MAX = 1000;
export const REVIEW_REPLY_MAX = 500;
export const REVIEW_HIDE_REASON_MAX = 200;

const REVIEW_MODERATOR_ROLES: AdminRole[] = ["SUPER", "OPS", "CS"];
const SUMMARY_LATEST = 3;

// ── 공통 ──────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

/** zod 검증 실패를 필드별 메시지를 담은 VALIDATION 오류로 바꾼다. */
function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const { error } = toActionError(parsed.error);
  throw new AppError("VALIDATION", error.message, error.fieldErrors);
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

const idSchema = z.string().min(1, "대상을 다시 골라 주세요.").max(64, "대상을 다시 골라 주세요.");

const REVIEW_NOT_FOUND = "후기를 찾을 수 없어요.";

/** 같은 사업장의 평점 집계를 트랜잭션 단위로 줄 세운다(동시에 바뀐 후기가 서로의 집계를 덮어쓰지 않게). */
const lockRatings = (tx: Tx, businessId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`review-ratings:${businessId}`}, 0))`;

/** 공개 후기만으로 상품·사업장 평점을 다시 계산한다. lockRatings 를 잡은 트랜잭션 안에서만 부른다. */
async function recomputeRatings(tx: Tx, productId: string, businessId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE "Product" SET "ratingAvg" = agg."avg", "ratingCount" = agg."cnt"
    FROM (
      SELECT COALESCE(ROUND(AVG("rating")::numeric, 2), 0)::float8 AS "avg", COUNT(*)::int AS "cnt"
      FROM "Review" WHERE "productId" = ${productId} AND "status" = 'VISIBLE'
    ) agg
    WHERE "Product"."id" = ${productId}`;
  await tx.$executeRaw`
    UPDATE "Business" SET "ratingAvg" = agg."avg", "ratingCount" = agg."cnt"
    FROM (
      SELECT COALESCE(ROUND(AVG("rating")::numeric, 2), 0)::float8 AS "avg", COUNT(*)::int AS "cnt"
      FROM "Review" WHERE "businessId" = ${businessId} AND "status" = 'VISIBLE'
    ) agg
    WHERE "Business"."id" = ${businessId}`;
}

// ── 목록용 커서(작성 시각 내림차순, 같은 시각이면 ID 내림차순) ──

interface ReviewCursor {
  t: string;
  i: string;
}

const cursorSchema = z.object({ t: z.string().min(1).max(40), i: z.string().min(1).max(64) });

const encodeCursor = (row: { createdAt: Date; id: string }) =>
  Buffer.from(JSON.stringify({ t: row.createdAt.toISOString(), i: row.id } satisfies ReviewCursor)).toString("base64url");

function decodeCursor(raw: string): { createdAt: Date; id: string } {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    const createdAt = new Date(parsed.t);
    if (!Number.isNaN(createdAt.getTime())) return { createdAt, id: parsed.i };
  } catch {
    // 아래에서 같은 오류로 알린다
  }
  throw err.validation("목록을 처음부터 다시 불러와 주세요.");
}

const pageSchema = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const REVIEW_ORDER = [{ createdAt: "desc" }, { id: "desc" }] satisfies Prisma.ReviewOrderByWithRelationInput[];

function afterCursor(cursor: string | undefined): Prisma.ReviewWhereInput {
  if (!cursor) return {};
  const c = decodeCursor(cursor);
  return { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] };
}

function toPage<Row extends { id: string; createdAt: Date }, Item>(rows: Row[], limit: number, map: (row: Row) => Item) {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(map), nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

// ── 공개 후기 ─────────────────────────────────────────

/** 누구나 볼 수 있는 후기. 작성자 이름은 가려서 내보내고, 연락처·예약 정보는 담지 않는다. */
export interface PublicReview {
  id: string;
  rating: number;
  content: string;
  /** 가린 이름(예: 홍*동) */
  authorName: string;
  product: { id: string; title: string };
  /** 참여한 회차의 시작 시각 */
  attendedAt: Date;
  sellerReply: string | null;
  sellerRepliedAt: Date | null;
  createdAt: Date;
}

export interface ReviewPage<Item = PublicReview> {
  items: Item[];
  nextCursor: string | null;
}

const publicReviewSelect = {
  id: true,
  rating: true,
  content: true,
  sellerReply: true,
  sellerRepliedAt: true,
  createdAt: true,
  user: { select: { name: true } },
  product: { select: { id: true, title: true } },
  booking: { select: { slot: { select: { startAt: true } } } },
} satisfies Prisma.ReviewSelect;

type PublicReviewRow = Prisma.ReviewGetPayload<{ select: typeof publicReviewSelect }>;

const toPublicReview = (row: PublicReviewRow): PublicReview => ({
  id: row.id,
  rating: row.rating,
  content: row.content,
  authorName: maskName(row.user.name),
  product: row.product,
  attendedAt: row.booking.slot.startAt,
  sellerReply: row.sellerReply,
  sellerRepliedAt: row.sellerRepliedAt,
  createdAt: row.createdAt,
});

async function listPublicReviews(scope: Prisma.ReviewWhereInput, options: { cursor?: string; limit?: number }): Promise<ReviewPage> {
  const o = parseInput(pageSchema, options);
  const limit = o.limit ?? 10;
  const rows = await prisma.review.findMany({
    where: { AND: [scope, { status: "VISIBLE" }, afterCursor(o.cursor)] },
    orderBy: REVIEW_ORDER,
    take: limit + 1,
    select: publicReviewSelect,
  });
  return toPage(rows, limit, toPublicReview);
}

/** 상품의 공개 후기(최신순). nextCursor 를 다음 호출의 cursor 로 넘기면 이어서 볼 수 있다. */
export async function listReviewsForProduct(productId: string, options: { cursor?: string; limit?: number } = {}): Promise<ReviewPage> {
  return listPublicReviews({ productId: parseInput(idSchema, productId) }, options);
}

/** 사업장의 공개 후기(최신순) */
export async function listReviewsForBusiness(businessId: string, options: { cursor?: string; limit?: number } = {}): Promise<ReviewPage> {
  return listPublicReviews({ businessId: parseInput(idSchema, businessId) }, options);
}

export interface ReviewSummary {
  /** 공개 후기 평균(소수 둘째 자리까지). 후기가 없으면 0 */
  avg: number;
  count: number;
  /** 공개 후기가 REVIEW_NEW_THRESHOLD 개 미만 — 화면은 점수 대신 "신규"를 보여 준다 */
  isNew: boolean;
  /** 별점별 개수 */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
  /** 최신 공개 후기 3건 */
  latest: PublicReview[];
}

/** 상품 또는 사업장의 후기 요약. 캐시된 집계가 아니라 공개 후기를 직접 세어 만든다. */
export async function getReviewSummary(scope: { productId: string } | { businessId: string }): Promise<ReviewSummary> {
  const where: Prisma.ReviewWhereInput =
    "productId" in scope
      ? { productId: parseInput(idSchema, scope.productId), status: "VISIBLE" }
      : { businessId: parseInput(idSchema, scope.businessId), status: "VISIBLE" };
  const [groups, latest] = await Promise.all([
    prisma.review.groupBy({ by: ["rating"], where, _count: { _all: true } }),
    prisma.review.findMany({ where, orderBy: REVIEW_ORDER, take: SUMMARY_LATEST, select: publicReviewSelect }),
  ]);
  const distribution: ReviewSummary["distribution"] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let total = 0;
  for (const group of groups) {
    if (group.rating < 1 || group.rating > 5) continue;
    distribution[group.rating as 1 | 2 | 3 | 4 | 5] = group._count._all;
    count += group._count._all;
    total += group.rating * group._count._all;
  }
  return {
    avg: count === 0 ? 0 : Math.round((total / count) * 100) / 100,
    count,
    isNew: count < REVIEW_NEW_THRESHOLD,
    distribution,
    latest: latest.map(toPublicReview),
  };
}

// ── 고객: 작성·삭제·내 후기 ───────────────────────────

export interface ReviewableBooking {
  bookingId: string;
  code: string;
  product: { id: string; title: string; image: string | null };
  business: { slug: string; name: string };
  startAt: Date;
  completedAt: Date;
  /** 이 시각까지 후기를 쓸 수 있다 */
  reviewDeadlineAt: Date;
}

/** 이용 완료 시각. 기록이 없으면 회차 종료 시각으로 본다. */
const completionTime = (booking: { completedAt: Date | null; slot: { endAt: Date } }) => booking.completedAt ?? booking.slot.endAt;

/** 후기를 쓸 수 있는 내 예약: 이용 완료, 후기 없음, 완료 후 reviewWindowDays 이내 */
export async function listReviewableBookings(userId: string): Promise<ReviewableBooking[]> {
  const settings = await getSettings();
  const now = new Date();
  const windowMs = settings.reviewWindowDays * DAY;
  const cutoff = new Date(now.getTime() - windowMs);
  const rows = await prisma.booking.findMany({
    where: {
      userId: parseInput(idSchema, userId),
      status: "COMPLETED",
      review: null,
      OR: [{ completedAt: { gte: cutoff } }, { completedAt: null, slot: { endAt: { gte: cutoff } } }],
    },
    orderBy: [{ completedAt: "desc" }, { id: "desc" }],
    take: 100,
    select: {
      id: true,
      code: true,
      completedAt: true,
      slot: { select: { startAt: true, endAt: true } },
      product: { select: { id: true, title: true, images: true } },
      business: { select: { slug: true, name: true } },
    },
  });
  return rows.map((row) => {
    const completedAt = completionTime(row);
    return {
      bookingId: row.id,
      code: row.code,
      product: { id: row.product.id, title: row.product.title, image: row.product.images[0] ?? null },
      business: row.business,
      startAt: row.slot.startAt,
      completedAt,
      reviewDeadlineAt: new Date(completedAt.getTime() + windowMs),
    };
  });
}

const createSchema = z.object({
  userId: idSchema,
  bookingId: idSchema,
  rating: z
    .number({ error: "별점을 골라 주세요." })
    .int("별점은 1점부터 5점까지 고를 수 있어요.")
    .min(1, "별점은 1점부터 5점까지 고를 수 있어요.")
    .max(5, "별점은 1점부터 5점까지 고를 수 있어요."),
  content: z
    .string({ error: "후기 내용을 적어 주세요." })
    .trim()
    .min(REVIEW_CONTENT_MIN, `후기는 ${REVIEW_CONTENT_MIN}자 이상 적어 주세요.`)
    .max(REVIEW_CONTENT_MAX, `후기는 ${REVIEW_CONTENT_MAX}자까지 쓸 수 있어요.`),
});

export interface CreatedReview {
  id: string;
  rating: number;
  content: string;
  createdAt: Date;
}

const ALREADY_REVIEWED = "이미 후기를 남긴 예약이에요.";
const NOT_COMPLETED = "이용을 마친 예약에만 후기를 쓸 수 있어요.";

/**
 * 후기 작성. 예약한 본인만, 이용 완료된 예약에, 완료 후 reviewWindowDays 안에, 한 번만 쓸 수 있다.
 * 후기 저장과 평점 집계 갱신은 한 트랜잭션이고, 사업자 알림은 그 뒤에 보낸다.
 */
export async function createReview(input: { userId: string; bookingId: string; rating: number; content: string }): Promise<CreatedReview> {
  const data = parseInput(createSchema, input);
  await enforceRateLimit(`review:user:${data.userId}`, 10, 3600, "후기를 너무 자주 쓰고 있어요. 잠시 후 다시 시도해 주세요.");

  const booking = await prisma.booking.findUnique({
    where: { id: data.bookingId },
    select: {
      id: true,
      userId: true,
      status: true,
      completedAt: true,
      businessId: true,
      productId: true,
      slot: { select: { endAt: true } },
      product: { select: { title: true } },
      review: { select: { id: true } },
    },
  });
  // 남의 예약은 있는지조차 알려 주지 않는다.
  if (!booking || booking.userId !== data.userId) throw err.notFound("예약을 찾을 수 없어요.");
  if (booking.status !== "COMPLETED") throw err.conflict(NOT_COMPLETED);
  if (booking.review) throw err.conflict(ALREADY_REVIEWED);

  const settings = await getSettings();
  const deadline = completionTime(booking).getTime() + settings.reviewWindowDays * DAY;
  if (Date.now() > deadline) {
    throw err.conflict(`후기는 이용한 뒤 ${settings.reviewWindowDays}일 안에만 쓸 수 있어요.`);
  }

  let review: CreatedReview;
  try {
    review = await prisma.$transaction(async (tx) => {
      await lockRatings(tx, booking.businessId);
      // 잠금을 기다리는 사이 예약 상태가 바뀌었을 수 있어 다시 확인한다.
      const stillCompleted = await tx.booking.count({ where: { id: booking.id, userId: data.userId, status: "COMPLETED" } });
      if (stillCompleted !== 1) throw err.conflict(NOT_COMPLETED);
      const created = await tx.review.create({
        data: {
          bookingId: booking.id,
          userId: data.userId,
          businessId: booking.businessId,
          productId: booking.productId,
          rating: data.rating,
          content: data.content,
        },
        select: { id: true, rating: true, content: true, createdAt: true },
      });
      await recomputeRatings(tx, booking.productId, booking.businessId);
      return created;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw err.conflict(ALREADY_REVIEWED);
    throw e;
  }

  // 알림은 본 작업이 끝난 뒤에 보낸다(실패해도 후기는 그대로 남는다 — 실패는 알림 모듈이 기록한다).
  await notifyBusinessMembers(booking.businessId, {
    type: "SELLER_REVIEW",
    title: "새 후기가 등록됐어요",
    body: `${booking.product.title} · 별점 ${review.rating}점\n${review.content.slice(0, 80)}`,
    linkUrl: "/seller/reviews",
    data: { reviewId: review.id, productId: booking.productId, rating: review.rating },
    dedupeKey: `SELLER_REVIEW:${review.id}`,
  });
  return review;
}

/** 내가 쓴 후기를 지운다. 평점 집계도 함께 다시 계산한다. */
export async function deleteOwnReview(userId: string, reviewId: string): Promise<void> {
  const id = parseInput(idSchema, reviewId);
  const review = await prisma.review.findUnique({ where: { id }, select: { userId: true, productId: true, businessId: true } });
  if (!review || review.userId !== userId) throw err.notFound(REVIEW_NOT_FOUND);

  await prisma.$transaction(async (tx) => {
    await lockRatings(tx, review.businessId);
    const deleted = await tx.review.deleteMany({ where: { id, userId } });
    if (deleted.count !== 1) throw err.notFound(REVIEW_NOT_FOUND);
    await recomputeRatings(tx, review.productId, review.businessId);
  });
}

export interface MyReview {
  id: string;
  bookingCode: string;
  product: { id: string; title: string };
  business: { slug: string; name: string };
  attendedAt: Date;
  rating: number;
  content: string;
  status: ReviewStatus;
  /** 운영자가 숨긴 사유(숨김 상태일 때만) */
  hiddenReason: string | null;
  sellerReply: string | null;
  sellerRepliedAt: Date | null;
  createdAt: Date;
}

/** 내가 쓴 후기(최신순). 숨김 처리된 후기도 사유와 함께 보여 준다. */
export async function listMyReviews(userId: string): Promise<MyReview[]> {
  const rows = await prisma.review.findMany({
    where: { userId: parseInput(idSchema, userId) },
    orderBy: REVIEW_ORDER,
    take: 200,
    select: {
      id: true,
      rating: true,
      content: true,
      status: true,
      hiddenReason: true,
      sellerReply: true,
      sellerRepliedAt: true,
      createdAt: true,
      product: { select: { id: true, title: true } },
      business: { select: { slug: true, name: true } },
      booking: { select: { code: true, slot: { select: { startAt: true } } } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    bookingCode: row.booking.code,
    product: row.product,
    business: row.business,
    attendedAt: row.booking.slot.startAt,
    rating: row.rating,
    content: row.content,
    status: row.status,
    hiddenReason: row.status === "HIDDEN" ? row.hiddenReason : null,
    sellerReply: row.sellerReply,
    sellerRepliedAt: row.sellerRepliedAt,
    createdAt: row.createdAt,
  }));
}

// ── 사업자: 답글 ──────────────────────────────────────

const replySchema = z
  .string({ error: "답글 내용을 적어 주세요." })
  .trim()
  .min(1, "답글 내용을 적어 주세요.")
  .max(REVIEW_REPLY_MAX, `답글은 ${REVIEW_REPLY_MAX}자까지 쓸 수 있어요.`);

async function loadReviewForSeller(actorUserId: string, reviewId: string) {
  const id = parseInput(idSchema, reviewId);
  const review = await prisma.review.findUnique({ where: { id }, select: { id: true, businessId: true } });
  if (!review) throw err.notFound(REVIEW_NOT_FOUND);
  await assertBusinessAccess(actorUserId, review.businessId, "MANAGER");
  return review;
}

/** 후기에 답글을 달거나 고친다(매니저 이상). 사업자는 후기 본문을 고치거나 숨길 수 없다. */
export async function replyToReview(
  actorUserId: string,
  reviewId: string,
  reply: string,
): Promise<{ sellerReply: string; sellerRepliedAt: Date }> {
  const text = parseInput(replySchema, reply);
  const review = await loadReviewForSeller(actorUserId, reviewId);
  await enforceRateLimit(`review-reply:user:${actorUserId}`, 60, 3600, "답글을 너무 자주 달고 있어요. 잠시 후 다시 시도해 주세요.");

  const sellerRepliedAt = new Date();
  const updated = await prisma.review.updateMany({
    where: { id: review.id, status: "VISIBLE" },
    data: { sellerReply: text, sellerRepliedAt },
  });
  if (updated.count !== 1) throw err.conflict("비공개 처리된 후기에는 답글을 달 수 없어요.");
  return { sellerReply: text, sellerRepliedAt };
}

/** 답글을 지운다(매니저 이상). 답글이 없어도 오류 없이 끝난다. */
export async function removeReply(actorUserId: string, reviewId: string): Promise<void> {
  const review = await loadReviewForSeller(actorUserId, reviewId);
  await prisma.review.updateMany({ where: { id: review.id }, data: { sellerReply: null, sellerRepliedAt: null } });
}

export interface SellerReview {
  id: string;
  rating: number;
  content: string;
  /** 가린 이름 */
  authorName: string;
  product: { id: string; title: string };
  attendedAt: Date;
  status: ReviewStatus;
  sellerReply: string | null;
  sellerRepliedAt: Date | null;
  createdAt: Date;
}

const sellerListSchema = pageSchema.extend({ unrepliedOnly: z.boolean().optional() });

/** 사업장에 달린 후기(구성원 누구나 조회). unrepliedOnly 면 답글을 달지 않은 공개 후기만 */
export async function listReviewsForSeller(
  actorUserId: string,
  businessId: string,
  options: { unrepliedOnly?: boolean; cursor?: string; limit?: number } = {},
): Promise<ReviewPage<SellerReview>> {
  const id = parseInput(idSchema, businessId);
  await assertBusinessAccess(actorUserId, id);
  const o = parseInput(sellerListSchema, options);
  const limit = o.limit ?? 20;
  const rows = await prisma.review.findMany({
    where: {
      AND: [{ businessId: id }, o.unrepliedOnly ? { sellerReply: null, status: "VISIBLE" } : {}, afterCursor(o.cursor)],
    },
    orderBy: REVIEW_ORDER,
    take: limit + 1,
    select: { ...publicReviewSelect, status: true },
  });
  return toPage(rows, limit, (row) => ({
    id: row.id,
    rating: row.rating,
    content: row.content,
    authorName: maskName(row.user.name),
    product: row.product,
    attendedAt: row.booking.slot.startAt,
    status: row.status,
    sellerReply: row.sellerReply,
    sellerRepliedAt: row.sellerRepliedAt,
    createdAt: row.createdAt,
  }));
}

// ── 운영자: 숨김·해제 ─────────────────────────────────

export interface ReviewModerator {
  id: string;
  role: AdminRole;
}

const reasonSchema = z
  .string({ error: "사유를 적어 주세요." })
  .trim()
  .min(2, "사유를 2자 이상 적어 주세요.")
  .max(REVIEW_HIDE_REASON_MAX, `사유는 ${REVIEW_HIDE_REASON_MAX}자까지 쓸 수 있어요.`);

/** 넘겨받은 역할과 DB 의 현재 역할이 모두 후기 관리 권한(CS·OPS·SUPER)이어야 한다. */
async function assertReviewModerator(admin: ReviewModerator): Promise<void> {
  if (!REVIEW_MODERATOR_ROLES.includes(admin.role)) throw err.forbidden();
  const row = await prisma.user.findUnique({ where: { id: admin.id }, select: { status: true, adminRole: true } });
  if (!row || row.status !== "ACTIVE" || !row.adminRole || !REVIEW_MODERATOR_ROLES.includes(row.adminRole)) throw err.forbidden();
}

async function moderate(admin: ReviewModerator, reviewId: string, reason: string, hide: boolean): Promise<void> {
  await assertReviewModerator(admin);
  const id = parseInput(idSchema, reviewId);
  const why = parseInput(reasonSchema, reason);
  const review = await prisma.review.findUnique({
    where: { id },
    select: { userId: true, productId: true, businessId: true, product: { select: { title: true } } },
  });
  if (!review) throw err.notFound(REVIEW_NOT_FOUND);

  await prisma.$transaction(async (tx) => {
    await lockRatings(tx, review.businessId);
    const updated = await tx.review.updateMany({
      where: { id, status: hide ? "VISIBLE" : "HIDDEN" },
      data: hide ? { status: "HIDDEN", hiddenReason: why } : { status: "VISIBLE", hiddenReason: null },
    });
    if (updated.count !== 1) throw err.conflict(hide ? "이미 비공개 처리된 후기예요." : "이미 공개 중인 후기예요.");
    await recomputeRatings(tx, review.productId, review.businessId);
  });

  await audit({
    actorId: admin.id,
    actorType: "ADMIN",
    action: hide ? "review.hide" : "review.unhide",
    targetType: "Review",
    targetId: id,
    meta: { reason: why, productId: review.productId, businessId: review.businessId },
  });
  // 작성자에게 처리 사실과 사유를 알린다(이의는 고객센터로).
  await notify({
    userId: review.userId,
    type: "SYSTEM",
    title: hide ? "작성한 후기가 비공개 처리됐어요" : "작성한 후기가 다시 공개됐어요",
    body: hide
      ? `${review.product.title} 후기가 운영 기준에 따라 비공개 처리됐어요.\n사유: ${why}\n처리에 이의가 있으면 고객센터로 알려 주세요.`
      : `${review.product.title} 후기가 다시 공개됐어요.`,
    linkUrl: "/my/reviews",
  });
}

/** 후기 숨김(CS·OPS·SUPER). 사유는 필수이며 후기와 감사 로그에 남는다. 평점 집계에서 빠진다. */
export async function hideReview(admin: ReviewModerator, reviewId: string, reason: string): Promise<void> {
  await moderate(admin, reviewId, reason, true);
}

/** 숨긴 후기를 다시 공개(CS·OPS·SUPER). 사유는 필수이며 감사 로그에 남는다. 평점 집계에 다시 들어간다. */
export async function unhideReview(admin: ReviewModerator, reviewId: string, reason: string): Promise<void> {
  await moderate(admin, reviewId, reason, false);
}
