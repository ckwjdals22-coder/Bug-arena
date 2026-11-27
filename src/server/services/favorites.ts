import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db";
import { AppError, err, toActionError } from "@/server/errors";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { listNextVacancyCards, visibility, type VacancyCard } from "@/server/services/catalog";

/**
 * 찜(상품)과 팔로우(사업장).
 * - 켜고 끄는 일과 집계(favoriteCount·followerCount) 갱신은 한 트랜잭션이다. 집계는 실제로 행이 생기거나 지워졌을 때만 바뀐다.
 * - 새로 찜·팔로우할 수 있는 대상은 공개 중인 상품·승인된 사업장뿐이다. 해제는 대상이 내려간 뒤에도 언제든 할 수 있다.
 */

/** 팔로우 목록에서 사업장마다 보여 주는 다음 회차 수 */
export const FOLLOWING_VACANCIES = 3;
/** 회원 한 명이 1분에 찜(또는 팔로우)을 켜고 끌 수 있는 횟수 */
export const TOGGLE_LIMIT_PER_MINUTE = 60;
const LIST_MAX = 200;
const TOGGLE_RATE_MESSAGE = "잠시 후 다시 시도해 주세요. 너무 빠르게 여러 번 눌렀어요.";

type Tx = Prisma.TransactionClient;

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const { error } = toActionError(parsed.error);
  throw new AppError("VALIDATION", error.message, error.fieldErrors);
}

const idSchema = z.string().min(1, "대상을 다시 골라 주세요.").max(64, "대상을 다시 골라 주세요.");

/** 같은 회원이 같은 대상을 동시에 여러 번 눌러도 차례로 처리되게 한다. */
const lockKey = (tx: Tx, key: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

// ── 찜 ────────────────────────────────────────────────

export interface FavoriteToggleResult {
  isFavorite: boolean;
  /** 바뀐 뒤 이 상품을 찜한 회원 수 */
  favoriteCount: number;
}

/** 상품 찜을 켜거나 끈다. 공개 중인 상품만 새로 찜할 수 있다. */
export async function toggleFavorite(userId: string, productId: string): Promise<FavoriteToggleResult> {
  const user = parseInput(idSchema, userId);
  const product = parseInput(idSchema, productId);
  await enforceRateLimit(`favorite:user:${user}`, TOGGLE_LIMIT_PER_MINUTE, 60, TOGGLE_RATE_MESSAGE);

  return prisma.$transaction(async (tx) => {
    await lockKey(tx, `favorite:${user}:${product}`);
    const removed = await tx.favorite.deleteMany({ where: { userId: user, productId: product } });
    if (removed.count > 0) {
      const rows = await tx.$queryRaw<{ favoriteCount: number }[]>`
        UPDATE "Product" SET "favoriteCount" = GREATEST("favoriteCount" - 1, 0)
        WHERE "id" = ${product}
        RETURNING "favoriteCount"`;
      return { isFavorite: false, favoriteCount: Number(rows[0]?.favoriteCount ?? 0) };
    }

    const visible = await tx.product.findFirst({ where: { id: product, ...visibility.product }, select: { id: true } });
    if (!visible) throw err.notFound("지금은 찜할 수 없는 상품이에요.");
    await tx.favorite.create({ data: { userId: user, productId: product } });
    const rows = await tx.$queryRaw<{ favoriteCount: number }[]>`
      UPDATE "Product" SET "favoriteCount" = "favoriteCount" + 1
      WHERE "id" = ${product}
      RETURNING "favoriteCount"`;
    return { isFavorite: true, favoriteCount: Number(rows[0]?.favoriteCount ?? 1) };
  });
}

export interface FavoriteItem {
  productId: string;
  title: string;
  /** 지금 공개 중인 상품인지. false 면 요약·이미지·다음 회차 없이 이름만 준다(찜 해제는 가능) */
  isAvailable: boolean;
  summary: string | null;
  image: string | null;
  category: { slug: string; name: string; icon: string };
  business: { slug: string; name: string };
  favoritedAt: Date;
  /** 가장 가까운 공개 회차(예약 가능한 회차 우선). 없으면 null */
  nextSlot: VacancyCard | null;
}

/** 내가 찜한 상품(최근에 찜한 순)과 각 상품의 다음 회차 */
export async function listFavorites(userId: string): Promise<FavoriteItem[]> {
  const user = parseInput(idSchema, userId);
  const rows = await prisma.favorite.findMany({
    where: { userId: user },
    orderBy: [{ createdAt: "desc" }, { productId: "asc" }],
    take: LIST_MAX,
    select: {
      createdAt: true,
      product: {
        select: {
          id: true,
          title: true,
          summary: true,
          images: true,
          status: true,
          category: { select: { slug: true, name: true, icon: true } },
          business: { select: { slug: true, name: true, status: true } },
        },
      },
    },
  });
  const isVisible = (p: (typeof rows)[number]["product"]) =>
    p.status === visibility.product.status && p.business.status === visibility.product.business.status;
  const next = await listNextVacancyCards(
    "product",
    rows.filter((row) => isVisible(row.product)).map((row) => row.product.id),
    1,
    { id: user },
  );
  return rows.map(({ createdAt, product }) => {
    const isAvailable = isVisible(product);
    return {
      productId: product.id,
      title: product.title,
      isAvailable,
      summary: isAvailable ? product.summary : null,
      image: isAvailable ? (product.images[0] ?? null) : null,
      category: product.category,
      business: { slug: product.business.slug, name: product.business.name },
      favoritedAt: createdAt,
      nextSlot: next.get(product.id)?.[0] ?? null,
    };
  });
}

// ── 팔로우 ────────────────────────────────────────────

export interface FollowToggleResult {
  isFollowing: boolean;
  /** 바뀐 뒤 이 사업장의 팔로워 수 */
  followerCount: number;
}

/** 사업장 팔로우를 켜거나 끈다. 승인된 사업장만 새로 팔로우할 수 있다. */
export async function toggleFollow(userId: string, businessId: string): Promise<FollowToggleResult> {
  const user = parseInput(idSchema, userId);
  const business = parseInput(idSchema, businessId);
  await enforceRateLimit(`follow:user:${user}`, TOGGLE_LIMIT_PER_MINUTE, 60, TOGGLE_RATE_MESSAGE);

  return prisma.$transaction(async (tx) => {
    await lockKey(tx, `follow:${user}:${business}`);
    const removed = await tx.follow.deleteMany({ where: { userId: user, businessId: business } });
    if (removed.count > 0) {
      const rows = await tx.$queryRaw<{ followerCount: number }[]>`
        UPDATE "Business" SET "followerCount" = GREATEST("followerCount" - 1, 0)
        WHERE "id" = ${business}
        RETURNING "followerCount"`;
      return { isFollowing: false, followerCount: Number(rows[0]?.followerCount ?? 0) };
    }

    const approved = await tx.business.findFirst({ where: { id: business, ...visibility.business }, select: { id: true } });
    if (!approved) throw err.notFound("지금은 팔로우할 수 없는 사업장이에요.");
    await tx.follow.create({ data: { userId: user, businessId: business } });
    const rows = await tx.$queryRaw<{ followerCount: number }[]>`
      UPDATE "Business" SET "followerCount" = "followerCount" + 1
      WHERE "id" = ${business}
      RETURNING "followerCount"`;
    return { isFollowing: true, followerCount: Number(rows[0]?.followerCount ?? 1) };
  });
}

export interface FollowingItem {
  business: {
    id: string;
    slug: string;
    name: string;
    tagline: string | null;
    logoImage: string | null;
    category: { slug: string; name: string; icon: string };
    ratingAvg: number;
    ratingCount: number;
    followerCount: number;
  };
  /** 지금 승인 상태인 사업장인지. false 면 소개·로고·회차 없이 이름만 준다(팔로우 해제는 가능) */
  isAvailable: boolean;
  followedAt: Date;
  /** 앞으로 열리는 공개 회차(예약 가능한 회차 우선, 최대 3) */
  vacancies: VacancyCard[];
}

/** 내가 팔로우한 사업장(최근에 팔로우한 순)과 각 사업장의 다음 회차 */
export async function listFollowing(userId: string): Promise<FollowingItem[]> {
  const user = parseInput(idSchema, userId);
  const rows = await prisma.follow.findMany({
    where: { userId: user },
    orderBy: [{ createdAt: "desc" }, { businessId: "asc" }],
    take: LIST_MAX,
    select: {
      createdAt: true,
      business: {
        select: {
          id: true,
          slug: true,
          name: true,
          tagline: true,
          logoImage: true,
          status: true,
          ratingAvg: true,
          ratingCount: true,
          followerCount: true,
          category: { select: { slug: true, name: true, icon: true } },
        },
      },
    },
  });
  const isVisible = (b: (typeof rows)[number]["business"]) => b.status === visibility.business.status;
  const next = await listNextVacancyCards(
    "business",
    rows.filter((row) => isVisible(row.business)).map((row) => row.business.id),
    FOLLOWING_VACANCIES,
    { id: user },
  );
  return rows.map(({ createdAt, business }) => {
    const isAvailable = isVisible(business);
    return {
      business: {
        id: business.id,
        slug: business.slug,
        name: business.name,
        tagline: isAvailable ? business.tagline : null,
        logoImage: isAvailable ? business.logoImage : null,
        category: business.category,
        ratingAvg: business.ratingAvg,
        ratingCount: business.ratingCount,
        followerCount: business.followerCount,
      },
      isAvailable,
      followedAt: createdAt,
      vacancies: next.get(business.id) ?? [],
    };
  });
}
