import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  FOLLOWING_VACANCIES,
  TOGGLE_LIMIT_PER_MINUTE,
  listFavorites,
  listFollowing,
  toggleFavorite,
  toggleFollow,
} from "@/server/services/favorites";
import { createArea, createBusiness, createCategory, createProduct, createSlot, createUser, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── 준비 도구 ─────────────────────────────────────────

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("실패해야 하는 호출이 성공했어요.");
}

async function setup(
  options: {
    business?: Partial<Prisma.BusinessUncheckedCreateInput>;
    product?: Partial<Prisma.ProductUncheckedCreateInput>;
  } = {},
) {
  const category = await createCategory();
  const area = await createArea();
  const { business, owner } = await createBusiness({ categoryId: category.id, areaId: area.id, ...options.business });
  const product = await createProduct(business.id, category.id, options.product);
  return { category, area, business, owner, product };
}

const favoriteCount = async (productId: string) => (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).favoriteCount;
const followerCount = async (businessId: string) => (await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).followerCount;
const fillSeat = (seatId: string, reserved: number) => prisma.slotSeat.update({ where: { id: seatId }, data: { reserved } });

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

const PRIVATE_KEYS = [
  "reserved",
  "withheld",
  "sellerMemo",
  "guestPhone",
  "bankAccountEnc",
  "bankAccountLast4",
  "commissionBps",
  "launchPromoRemaining",
  "address",
  "lat",
  "lng",
  "status",
];

// ── 찜 ────────────────────────────────────────────────

describe("toggleFavorite", () => {
  it("켜고 끌 때마다 찜 수를 함께 맞춘다", async () => {
    const { product } = await setup();
    const [a, b] = await Promise.all([createUser(), createUser()]);

    expect(await toggleFavorite(a.id, product.id)).toEqual({ isFavorite: true, favoriteCount: 1 });
    expect(await toggleFavorite(b.id, product.id)).toEqual({ isFavorite: true, favoriteCount: 2 });
    expect(await prisma.favorite.count({ where: { productId: product.id } })).toBe(2);
    expect(await favoriteCount(product.id)).toBe(2);

    expect(await toggleFavorite(a.id, product.id)).toEqual({ isFavorite: false, favoriteCount: 1 });
    expect(await prisma.favorite.findMany({ where: { productId: product.id }, select: { userId: true } })).toEqual([{ userId: b.id }]);
    expect(await toggleFavorite(a.id, product.id)).toEqual({ isFavorite: true, favoriteCount: 2 });
    expect(await toggleFavorite(b.id, product.id)).toEqual({ isFavorite: false, favoriteCount: 1 });
    expect(await toggleFavorite(a.id, product.id)).toEqual({ isFavorite: false, favoriteCount: 0 });
    expect(await prisma.favorite.count()).toBe(0);
    expect(await favoriteCount(product.id)).toBe(0);
  });

  it("공개 중인 상품만 새로 찜할 수 있고, 내려간 상품의 찜은 언제든 풀 수 있다", async () => {
    const me = await createUser();
    const hiddenCases: Parameters<typeof setup>[0][] = [
      { product: { status: "PAUSED" } },
      { product: { status: "DRAFT" } },
      { product: { status: "ARCHIVED" } },
      { business: { status: "PENDING" } },
      { business: { status: "SUSPENDED" } },
      { business: { status: "REJECTED" } },
    ];
    for (const options of hiddenCases) {
      const { product } = await setup(options);
      const e = await failure(toggleFavorite(me.id, product.id));
      expect(e.code, JSON.stringify(options)).toBe("NOT_FOUND");
      expect(await favoriteCount(product.id)).toBe(0);
    }
    expect((await failure(toggleFavorite(me.id, "없는-상품"))).code).toBe("NOT_FOUND");
    expect((await failure(toggleFavorite(me.id, ""))).code).toBe("VALIDATION");
    expect((await failure(toggleFavorite(me.id, "x".repeat(100)))).code).toBe("VALIDATION");
    expect(await prisma.favorite.count()).toBe(0);

    // 찜한 뒤 상품이 판매 중지돼도 풀 수 있다. 다시 켜는 것은 안 된다
    const { product } = await setup();
    await toggleFavorite(me.id, product.id);
    await prisma.product.update({ where: { id: product.id }, data: { status: "PAUSED" } });
    expect(await toggleFavorite(me.id, product.id)).toEqual({ isFavorite: false, favoriteCount: 0 });
    expect((await failure(toggleFavorite(me.id, product.id))).code).toBe("NOT_FOUND");
    expect(await favoriteCount(product.id)).toBe(0);
  });

  it("여러 회원이 동시에 눌러도 찜 수가 실제 찜 행 수와 같다", async () => {
    const { product } = await setup();
    const users = await Promise.all(Array.from({ length: 24 }, () => createUser()));

    const on = await Promise.all(users.map((u) => toggleFavorite(u.id, product.id)));
    expect(on.every((r) => r.isFavorite)).toBe(true);
    // 각자가 받은 찜 수는 1~24 가 한 번씩이다(같은 값을 두 번 쓰는 갱신 유실이 없다)
    expect(on.map((r) => r.favoriteCount).sort((x, y) => x - y)).toEqual(users.map((_, i) => i + 1));
    expect(await favoriteCount(product.id)).toBe(users.length);
    expect(await prisma.favorite.count({ where: { productId: product.id } })).toBe(users.length);

    // 절반은 끄고, 새 회원 다섯이 동시에 켠다
    const newcomers = await Promise.all(Array.from({ length: 5 }, () => createUser()));
    const leaving = users.slice(0, 12);
    const mixed = await Promise.all([...leaving, ...newcomers].map((u) => toggleFavorite(u.id, product.id)));
    expect(mixed.slice(0, leaving.length).every((r) => !r.isFavorite)).toBe(true);
    expect(mixed.slice(leaving.length).every((r) => r.isFavorite)).toBe(true);
    expect(await favoriteCount(product.id)).toBe(users.length - leaving.length + newcomers.length);
    expect(await prisma.favorite.count({ where: { productId: product.id } })).toBe(users.length - leaving.length + newcomers.length);
  });

  it("같은 회원이 같은 상품을 동시에 여러 번 눌러도 찜 행과 찜 수가 어긋나지 않는다", async () => {
    const { product } = await setup();
    const other = await setup();
    const users = await Promise.all(Array.from({ length: 6 }, () => createUser()));

    // 회원마다 다섯 번(홀수)씩 동시에 → 차례로 처리되어 모두 '켜짐'으로 끝난다
    const results = await Promise.all(users.flatMap((u) => Array.from({ length: 5 }, () => toggleFavorite(u.id, product.id))));
    for (const [i, user] of users.entries()) {
      const mine = results.slice(i * 5, i * 5 + 5);
      expect(mine.filter((r) => r.isFavorite)).toHaveLength(3);
      expect(mine.filter((r) => !r.isFavorite)).toHaveLength(2);
      expect(await prisma.favorite.count({ where: { userId: user.id, productId: product.id } })).toBe(1);
    }
    expect(await favoriteCount(product.id)).toBe(users.length);
    expect(await prisma.favorite.count({ where: { productId: product.id } })).toBe(users.length);

    // 켜진 상태에서 다시 다섯 번씩 동시에 → 모두 '꺼짐'으로 끝나고 찜 수는 0. 다른 상품의 찜 수는 건드리지 않는다
    await toggleFavorite(users[0]!.id, other.product.id);
    await Promise.all(users.flatMap((u) => Array.from({ length: 5 }, () => toggleFavorite(u.id, product.id))));
    expect(await favoriteCount(product.id)).toBe(0);
    expect(await prisma.favorite.count({ where: { productId: product.id } })).toBe(0);
    expect(await favoriteCount(other.product.id)).toBe(1);
  });

  it("너무 빠르게 여러 번 누르면 잠시 막는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-02T03:10:05Z"));
    const { product } = await setup();
    const [me, other] = await Promise.all([createUser(), createUser()]);

    for (let i = 0; i < TOGGLE_LIMIT_PER_MINUTE; i++) await toggleFavorite(me.id, product.id);
    const expected = TOGGLE_LIMIT_PER_MINUTE % 2;
    expect(await favoriteCount(product.id)).toBe(expected);

    const limited = await failure(toggleFavorite(me.id, product.id));
    expect(limited.code).toBe("RATE_LIMITED");
    // 막힌 요청은 아무것도 바꾸지 않는다
    expect(await favoriteCount(product.id)).toBe(expected);
    expect(await prisma.favorite.count()).toBe(expected);

    // 다른 회원과 팔로우는 따로 세고, 시간이 지나면 다시 된다
    await expect(toggleFavorite(other.id, product.id)).resolves.toMatchObject({ isFavorite: true });
    await expect(toggleFollow(me.id, product.businessId)).resolves.toMatchObject({ isFollowing: true });
    vi.setSystemTime(new Date("2026-12-02T03:11:05Z"));
    await expect(toggleFavorite(me.id, product.id)).resolves.toBeTruthy();
  });
});

describe("listFavorites", () => {
  it("내가 찜한 상품을 최근에 찜한 순으로, 각 상품의 다음 회차와 함께 준다", async () => {
    const a = await setup({ product: { title: "와인 로테이션 소개팅", summary: "4:4 로테이션", images: ["/uploads/a.webp", "/uploads/b.webp"] } });
    const b = await setup({ product: { title: "보드게임 번개" } });
    const noSlots = await setup({ product: { title: "회차가 없는 상품" } });
    const [me, other] = await Promise.all([createUser(), createUser()]);

    // a: 가장 가까운 회차는 매진 → 예약 가능한 다음 회차가 먼저 나온다
    const soldOut = await createSlot(a.product, [{ capacity: 2 }], { startsInHours: 24 });
    await fillSeat(soldOut.seats[0]!.id, 2);
    const open = await createSlot(a.product, [{ capacity: 4, price: 35000 }], { startsInHours: 48 });
    await createSlot(a.product, [{ capacity: 4 }], { startsInHours: 72 });
    // 숨겨진 회차(마감·예약 마감 지남)는 다음 회차가 아니다
    await createSlot(a.product, [{ capacity: 4 }], { startsInHours: 12, status: "CLOSED" });
    await createSlot(a.product, [{ capacity: 4 }], { startsInHours: 0.5 });
    // b: 매진 회차뿐 → 대기 입구로 그 회차를 준다
    const onlySoldOut = await createSlot(b.product, [{ capacity: 1 }], { startsInHours: 30 });
    await fillSeat(onlySoldOut.seats[0]!.id, 1);

    await toggleFavorite(me.id, a.product.id);
    await toggleFavorite(me.id, b.product.id);
    await toggleFavorite(me.id, noSlots.product.id);
    await toggleFavorite(other.id, a.product.id);
    const base = Date.now();
    await prisma.favorite.update({ where: { userId_productId: { userId: me.id, productId: a.product.id } }, data: { createdAt: new Date(base - 3000) } });
    await prisma.favorite.update({ where: { userId_productId: { userId: me.id, productId: b.product.id } }, data: { createdAt: new Date(base - 2000) } });
    await prisma.favorite.update({ where: { userId_productId: { userId: me.id, productId: noSlots.product.id } }, data: { createdAt: new Date(base - 1000) } });

    const list = await listFavorites(me.id);
    expect(list.map((f) => f.productId)).toEqual([noSlots.product.id, b.product.id, a.product.id]);
    expect(list[2]).toMatchObject({
      productId: a.product.id,
      title: "와인 로테이션 소개팅",
      isAvailable: true,
      summary: "4:4 로테이션",
      image: "/uploads/a.webp",
      category: { slug: a.category.slug, name: a.category.name, icon: a.category.icon },
      business: { slug: a.business.slug, name: a.business.name },
      favoritedAt: new Date(base - 3000),
    });
    expect(list[2]!.nextSlot).toMatchObject({ slotId: open.id, totalRemaining: 4, minPrice: 35000, isFavorite: true });
    expect(list[1]!.nextSlot).toMatchObject({ slotId: onlySoldOut.id, totalRemaining: 0 });
    expect(list[0]!.nextSlot).toBeNull();

    // 남의 찜은 섞이지 않는다
    expect((await listFavorites(other.id)).map((f) => f.productId)).toEqual([a.product.id]);
    expect(await listFavorites((await createUser()).id)).toEqual([]);
    // 내부 값·정확한 주소는 담지 않는다
    const keys = collectKeys(list);
    for (const key of PRIVATE_KEYS) expect(keys.has(key), key).toBe(false);
  });

  it("내려간 상품은 이름만 남기고 다음 회차를 주지 않는다", async () => {
    const paused = await setup({ product: { title: "판매 중지된 상품", summary: "요약", images: ["/uploads/p.webp"] } });
    const suspended = await setup({ product: { title: "정지된 사업장의 상품", summary: "요약", images: ["/uploads/s.webp"] } });
    const me = await createUser();
    await createSlot(paused.product, [{ capacity: 4 }], { startsInHours: 24 });
    await createSlot(suspended.product, [{ capacity: 4 }], { startsInHours: 24 });
    await toggleFavorite(me.id, paused.product.id);
    await toggleFavorite(me.id, suspended.product.id);
    await prisma.product.update({ where: { id: paused.product.id }, data: { status: "PAUSED" } });
    await prisma.business.update({ where: { id: suspended.business.id }, data: { status: "SUSPENDED" } });

    const list = await listFavorites(me.id);
    expect(list).toHaveLength(2);
    for (const item of list) {
      expect(item).toMatchObject({ isAvailable: false, summary: null, image: null, nextSlot: null });
      expect(item.title).toMatch(/상품$/);
    }
  });
});

// ── 팔로우 ────────────────────────────────────────────

describe("toggleFollow", () => {
  it("켜고 끌 때마다 팔로워 수를 함께 맞춘다", async () => {
    const { business } = await setup();
    const [a, b] = await Promise.all([createUser(), createUser()]);

    expect(await toggleFollow(a.id, business.id)).toEqual({ isFollowing: true, followerCount: 1 });
    expect(await toggleFollow(b.id, business.id)).toEqual({ isFollowing: true, followerCount: 2 });
    expect(await toggleFollow(a.id, business.id)).toEqual({ isFollowing: false, followerCount: 1 });
    expect(await prisma.follow.findMany({ where: { businessId: business.id }, select: { userId: true } })).toEqual([{ userId: b.id }]);
    expect(await toggleFollow(b.id, business.id)).toEqual({ isFollowing: false, followerCount: 0 });
    expect(await followerCount(business.id)).toBe(0);
    expect(await prisma.follow.count()).toBe(0);
  });

  it("승인된 사업장만 새로 팔로우할 수 있고, 팔로우 해제는 언제든 할 수 있다", async () => {
    const me = await createUser();
    for (const status of ["PENDING", "REJECTED", "SUSPENDED"] as const) {
      const { business } = await setup({ business: { status } });
      expect((await failure(toggleFollow(me.id, business.id))).code, status).toBe("NOT_FOUND");
      expect(await followerCount(business.id)).toBe(0);
    }
    expect((await failure(toggleFollow(me.id, "없는-사업장"))).code).toBe("NOT_FOUND");
    expect((await failure(toggleFollow(me.id, ""))).code).toBe("VALIDATION");
    expect(await prisma.follow.count()).toBe(0);

    const { business } = await setup();
    await toggleFollow(me.id, business.id);
    await prisma.business.update({ where: { id: business.id }, data: { status: "SUSPENDED" } });
    expect(await toggleFollow(me.id, business.id)).toEqual({ isFollowing: false, followerCount: 0 });
    expect((await failure(toggleFollow(me.id, business.id))).code).toBe("NOT_FOUND");
  });

  it("여러 회원이 동시에 팔로우·해제해도 팔로워 수가 실제 팔로우 행 수와 같다", async () => {
    const { business } = await setup();
    const users = await Promise.all(Array.from({ length: 24 }, () => createUser()));

    const on = await Promise.all(users.map((u) => toggleFollow(u.id, business.id)));
    expect(on.map((r) => r.followerCount).sort((x, y) => x - y)).toEqual(users.map((_, i) => i + 1));
    expect(await followerCount(business.id)).toBe(users.length);
    expect(await prisma.follow.count({ where: { businessId: business.id } })).toBe(users.length);

    // 같은 회원의 연타(세 번)와 다른 회원의 해제가 뒤섞여도 맞는다
    const tapping = users.slice(0, 6);
    const leaving = users.slice(6, 16);
    await Promise.all([
      ...tapping.flatMap((u) => Array.from({ length: 3 }, () => toggleFollow(u.id, business.id))),
      ...leaving.map((u) => toggleFollow(u.id, business.id)),
    ]);
    // 연타한 여섯 명: 켜짐 → (끔·켬·끔) → 꺼짐. 남은 사람은 8명
    const remaining = users.length - tapping.length - leaving.length;
    expect(await prisma.follow.count({ where: { businessId: business.id } })).toBe(remaining);
    expect(await followerCount(business.id)).toBe(remaining);
  });

  it("찜과 팔로우가 동시에 섞여도 서로의 집계를 건드리지 않는다", async () => {
    const { business, product } = await setup();
    const second = await createProduct(business.id, business.categoryId);
    const users = await Promise.all(Array.from({ length: 10 }, () => createUser()));

    await Promise.all(
      users.flatMap((u, i) => [
        toggleFollow(u.id, business.id),
        toggleFavorite(u.id, product.id),
        ...(i % 2 === 0 ? [toggleFavorite(u.id, second.id)] : []),
      ]),
    );
    expect(await followerCount(business.id)).toBe(10);
    expect(await favoriteCount(product.id)).toBe(10);
    expect(await favoriteCount(second.id)).toBe(5);
    expect(await prisma.follow.count()).toBe(10);
    expect(await prisma.favorite.count()).toBe(15);
  });

  it("너무 빠르게 여러 번 누르면 잠시 막는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-02T03:10:05Z"));
    const { business } = await setup();
    const me = await createUser();
    for (let i = 0; i < TOGGLE_LIMIT_PER_MINUTE; i++) await toggleFollow(me.id, business.id);
    expect((await failure(toggleFollow(me.id, business.id))).code).toBe("RATE_LIMITED");
    expect(await followerCount(business.id)).toBe(TOGGLE_LIMIT_PER_MINUTE % 2);
  });
});

describe("listFollowing", () => {
  it("팔로우한 사업장을 최근 순으로, 사업장마다 다음 회차를 정해진 개수까지 준다", async () => {
    const a = await setup({ business: { name: "연결고리 라운지", tagline: "편한 소개팅", logoImage: "/uploads/logo.webp" } });
    const b = await setup({ business: { name: "주사위 카페" } });
    const [me, other] = await Promise.all([createUser(), createUser()]);
    const secondProduct = await createProduct(a.business.id, a.category.id, { title: "둘째 상품" });

    // a: 매진 1 + 예약 가능 4 → 예약 가능한 회차가 먼저, 시작 빠른 순
    const soldOut = await createSlot(a.product, [{ capacity: 1 }], { startsInHours: 10 });
    await fillSeat(soldOut.seats[0]!.id, 1);
    const opens = [];
    for (const hours of [20, 30, 40, 50]) opens.push(await createSlot(hours === 30 ? secondProduct : a.product, [{ capacity: 3 }], { startsInHours: hours }));
    await createSlot(a.product, [{ capacity: 3 }], { startsInHours: 15, status: "CANCELLED" });

    await toggleFollow(me.id, a.business.id);
    await toggleFollow(me.id, b.business.id);
    await toggleFollow(other.id, b.business.id);
    await toggleFavorite(me.id, secondProduct.id);
    const base = Date.now();
    await prisma.follow.update({ where: { userId_businessId: { userId: me.id, businessId: a.business.id } }, data: { createdAt: new Date(base - 2000) } });
    await prisma.follow.update({ where: { userId_businessId: { userId: me.id, businessId: b.business.id } }, data: { createdAt: new Date(base - 1000) } });

    const list = await listFollowing(me.id);
    expect(list.map((f) => f.business.id)).toEqual([b.business.id, a.business.id]);
    expect(list[1]).toMatchObject({
      business: {
        id: a.business.id,
        slug: a.business.slug,
        name: "연결고리 라운지",
        tagline: "편한 소개팅",
        logoImage: "/uploads/logo.webp",
        category: { slug: a.category.slug, name: a.category.name, icon: a.category.icon },
        ratingAvg: 0,
        ratingCount: 0,
        followerCount: 1,
      },
      isAvailable: true,
      followedAt: new Date(base - 2000),
    });
    expect(FOLLOWING_VACANCIES).toBeLessThan(opens.length);
    expect(list[1]!.vacancies.map((c) => c.slotId)).toEqual(opens.slice(0, FOLLOWING_VACANCIES).map((s) => s.id));
    // 카드의 찜 여부는 보는 사람 기준이다
    expect(list[1]!.vacancies.map((c) => c.isFavorite)).toEqual(opens.slice(0, FOLLOWING_VACANCIES).map((s) => s.productId === secondProduct.id));
    expect(list[0]).toMatchObject({ business: { followerCount: 2 }, vacancies: [] });

    expect((await listFollowing(other.id)).map((f) => f.business.id)).toEqual([b.business.id]);
    const keys = collectKeys(list);
    for (const key of PRIVATE_KEYS) expect(keys.has(key), key).toBe(false);
  });

  it("정지된 사업장은 이름만 남기고 회차를 주지 않는다", async () => {
    const { business, product } = await setup({ business: { tagline: "소개", logoImage: "/uploads/logo.webp" } });
    const me = await createUser();
    await createSlot(product, [{ capacity: 4 }], { startsInHours: 24 });
    await toggleFollow(me.id, business.id);
    await prisma.business.update({ where: { id: business.id }, data: { status: "SUSPENDED" } });

    const [item] = await listFollowing(me.id);
    expect(item).toMatchObject({
      business: { id: business.id, name: business.name, tagline: null, logoImage: null },
      isAvailable: false,
      vacancies: [],
    });
  });
});
