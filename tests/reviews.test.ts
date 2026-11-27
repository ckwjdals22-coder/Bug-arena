import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminRole, BookingStatus, MemberRole, Prisma } from "@/generated/prisma/client";
import { CANCELLATION_PRESETS } from "@/lib/domain";
import { maskName } from "@/lib/format";
import { DAY, HOUR, MINUTE } from "@/lib/time";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  REVIEW_CONTENT_MAX,
  REVIEW_CONTENT_MIN,
  REVIEW_HIDE_REASON_MAX,
  REVIEW_HOURLY_LIMIT,
  REVIEW_NEW_THRESHOLD,
  REVIEW_REPLY_MAX,
  WITHDRAWN_AUTHOR,
  createReview,
  deleteOwnReview,
  getReviewSummary,
  hideReview,
  listMyReviews,
  listReviewableBookings,
  listReviewsForBusiness,
  listReviewsForProduct,
  listReviewsForSeller,
  removeReply,
  replyToReview,
  unhideReview,
} from "@/server/services/reviews";
import { DEFAULT_SETTINGS, updateSettings } from "@/server/settings";
import { createBusiness, createCategory, createProduct, createSlot, createUser, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── 준비 도구 ─────────────────────────────────────────

const GOOD_CONTENT = "분위기가 편해서 처음인데도 즐겁게 이야기했어요.";

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("실패해야 하는 호출이 성공했어요.");
}

/** 사업장 + 상품 + 이미 끝난 회차 하나 */
async function setup(options: { product?: Partial<Prisma.ProductUncheckedCreateInput>; business?: Partial<Prisma.BusinessUncheckedCreateInput> } = {}) {
  const category = await createCategory();
  const { business, owner } = await createBusiness({ categoryId: category.id, ...options.business });
  const product = await createProduct(business.id, category.id, { title: "와인 로테이션 소개팅", ...options.product });
  const slot = await createSlot(product, [{ capacity: 30 }], { startsInHours: -30 });
  return { category, business, owner, product, slot, seat: slot.seats[0]! };
}

type SlotRef = { id: string; productId: string; businessId: string; seats: { id: string }[] };

async function createBooking(
  slot: SlotRef,
  userId: string | null,
  status: BookingStatus = "COMPLETED",
  data: Partial<Prisma.BookingUncheckedCreateInput> = {},
) {
  return prisma.booking.create({
    data: {
      code: `NJ-${randomBytes(4).toString("hex").toUpperCase()}`,
      userId,
      businessId: slot.businessId,
      productId: slot.productId,
      slotId: slot.id,
      slotSeatId: slot.seats[0]!.id,
      quantity: 1,
      unitPrice: 30000,
      totalAmount: 30000,
      payNowAmount: 30000,
      status,
      paymentMethod: "ONLINE",
      guestName: "예약자본명",
      guestPhone: "01077778888",
      sellerMemo: "사업자만 보는 메모",
      policySnapshot: [...CANCELLATION_PRESETS.STANDARD.tiers],
      checkinToken: randomBytes(12).toString("hex"),
      completedAt: status === "COMPLETED" ? new Date(Date.now() - HOUR) : null,
      ...data,
    },
  });
}

const addMember = (businessId: string, userId: string, role: MemberRole) =>
  prisma.businessMember.create({ data: { businessId, userId, role } });

const createAdmin = (role: AdminRole) => createUser({ adminRole: role, name: `운영자${role}` });

async function ratings(productId: string, businessId: string) {
  const [product, business] = await Promise.all([
    prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { ratingAvg: true, ratingCount: true } }),
    prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { ratingAvg: true, ratingCount: true } }),
  ]);
  return { product, business };
}

type TestUser = Awaited<ReturnType<typeof createUser>>;

/** 이용 완료 예약을 만들고 후기까지 남긴다. */
async function writeReview(slot: SlotRef, rating: number, user?: TestUser, content = GOOD_CONTENT) {
  const author = user ?? (await createUser());
  const booking = await createBooking(slot, author.id);
  const review = await createReview({ userId: author.id, bookingId: booking.id, rating, content });
  return { author, booking, review };
}

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

// ── 후기를 쓸 수 있는 예약 ────────────────────────────

describe("listReviewableBookings", () => {
  it("이용 완료했고 후기가 없으며 작성 기간 안에 있는 내 예약만 나온다", async () => {
    const { slot, product, business } = await setup({ product: { images: ["/uploads/cover.webp"] } });
    const windowMs = DEFAULT_SETTINGS.reviewWindowDays * DAY;
    const [me, other] = await Promise.all([createUser(), createUser()]);
    const otherSlot = await createSlot(product, [{ capacity: 10 }], { startsInHours: -100 });

    const recentAt = new Date(Date.now() - 2 * HOUR);
    const recent = await createBooking(slot, me.id, "COMPLETED", { completedAt: recentAt });
    const nearlyOver = await createBooking(otherSlot, me.id, "COMPLETED", { completedAt: new Date(Date.now() - windowMs + HOUR) });
    // 기간이 지난 예약, 끝나지 않은 예약, 노쇼·취소 예약, 남의 예약은 빠진다
    const expiredSlot = await createSlot(product, [{ capacity: 10 }], { startsInHours: -24 * (DEFAULT_SETTINGS.reviewWindowDays + 2) });
    await createBooking(expiredSlot, me.id, "COMPLETED", { completedAt: new Date(Date.now() - windowMs - HOUR) });
    const upcoming = await createSlot(product, [{ capacity: 10 }], { startsInHours: 24 });
    await createBooking(upcoming, me.id, "CONFIRMED");
    const noShowSlot = await createSlot(product, [{ capacity: 10 }], { startsInHours: -50 });
    await createBooking(noShowSlot, me.id, "NO_SHOW");
    const cancelledSlot = await createSlot(product, [{ capacity: 10 }], { startsInHours: -60 });
    await createBooking(cancelledSlot, me.id, "CANCELLED");
    await createBooking(slot, other.id, "COMPLETED");

    const list = await listReviewableBookings(me.id);
    expect(list.map((b) => b.bookingId)).toEqual([recent.id, nearlyOver.id]);
    expect(list[0]).toEqual({
      bookingId: recent.id,
      code: recent.code,
      product: { id: product.id, title: product.title, image: "/uploads/cover.webp" },
      business: { slug: business.slug, name: business.name },
      startAt: slot.startAt,
      completedAt: recentAt,
      reviewDeadlineAt: new Date(recentAt.getTime() + windowMs),
    });

    // 후기를 남긴 예약은 빠진다
    await createReview({ userId: me.id, bookingId: recent.id, rating: 5, content: GOOD_CONTENT });
    expect((await listReviewableBookings(me.id)).map((b) => b.bookingId)).toEqual([nearlyOver.id]);
    expect(await listReviewableBookings(other.id)).toHaveLength(1);
  });

  it("완료 시각 기록이 없으면 회차 종료 시각을 기준으로 삼는다", async () => {
    const { product } = await setup();
    const me = await createUser();
    const windowMs = DEFAULT_SETTINGS.reviewWindowDays * DAY;
    const endedRecently = await createSlot(product, [{ capacity: 10 }], { startsInHours: -5 });
    const endedLongAgo = await createSlot(product, [{ capacity: 10 }], { startsInHours: -24 * (DEFAULT_SETTINGS.reviewWindowDays + 1) });
    const inWindow = await createBooking(endedRecently, me.id, "COMPLETED", { completedAt: null });
    const outOfWindow = await createBooking(endedLongAgo, me.id, "COMPLETED", { completedAt: null });

    const list = await listReviewableBookings(me.id);
    expect(list.map((b) => b.bookingId)).toEqual([inWindow.id]);
    expect(list[0]?.completedAt).toEqual(endedRecently.endAt);
    expect(list[0]?.reviewDeadlineAt).toEqual(new Date(endedRecently.endAt.getTime() + windowMs));
    expect((await failure(createReview({ userId: me.id, bookingId: outOfWindow.id, rating: 5, content: GOOD_CONTENT }))).code).toBe("CONFLICT");
  });
});

// ── 작성 ──────────────────────────────────────────────

describe("createReview", () => {
  it("이용 완료한 본인 예약에 후기를 남기고, 상품·사업장 평점을 공개 후기로 다시 계산한다", async () => {
    const { slot, product, business } = await setup();
    const second = await createProduct(business.id, business.categoryId, { title: "보드게임 번개" });
    const secondSlot = await createSlot(second, [{ capacity: 10 }], { startsInHours: -30 });
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: 0, ratingCount: 0 },
      business: { ratingAvg: 0, ratingCount: 0 },
    });

    const me = await createUser({ name: "홍길동" });
    const booking = await createBooking(slot, me.id);
    const created = await createReview({ userId: me.id, bookingId: booking.id, rating: 5, content: `  ${GOOD_CONTENT}  ` });
    expect(created).toEqual({ id: expect.any(String), rating: 5, content: GOOD_CONTENT, createdAt: expect.any(Date) });

    const row = await prisma.review.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({
      bookingId: booking.id,
      userId: me.id,
      businessId: business.id,
      productId: product.id,
      rating: 5,
      content: GOOD_CONTENT,
      status: "VISIBLE",
      sellerReply: null,
    });
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: 5, ratingCount: 1 },
      business: { ratingAvg: 5, ratingCount: 1 },
    });

    // 같은 상품에 4점, 다른 상품에 2점 → 상품 평균과 사업장 평균이 따로 계산된다
    await writeReview(slot, 4);
    await writeReview(secondSlot, 2);
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: 4.5, ratingCount: 2 },
      business: { ratingAvg: 3.67, ratingCount: 3 },
    });
    expect(await ratings(second.id, business.id)).toMatchObject({ product: { ratingAvg: 2, ratingCount: 1 } });
  });

  it("남의 예약, 끝나지 않은 예약, 없는 예약에는 쓸 수 없다", async () => {
    const { slot, product, business } = await setup();
    const [me, other] = await Promise.all([createUser(), createUser()]);
    const mine = await createBooking(slot, me.id);

    // 남의 예약은 있는지조차 알려 주지 않는다
    const stranger = await failure(createReview({ userId: other.id, bookingId: mine.id, rating: 5, content: GOOD_CONTENT }));
    expect(stranger.code).toBe("NOT_FOUND");
    const missing = await failure(createReview({ userId: me.id, bookingId: "없는-예약", rating: 5, content: GOOD_CONTENT }));
    expect(missing.code).toBe("NOT_FOUND");
    expect(stranger.message).toBe(missing.message);

    const notDone: BookingStatus[] = ["PENDING_PAYMENT", "PENDING_APPROVAL", "CONFIRMED", "NO_SHOW", "CANCELLED", "REJECTED", "EXPIRED"];
    for (const status of notDone) {
      const user = await createUser();
      const booking = await createBooking(slot, user.id, status);
      const e = await failure(createReview({ userId: user.id, bookingId: booking.id, rating: 5, content: GOOD_CONTENT }));
      expect(e.code, status).toBe("CONFLICT");
    }
    // 회원 없이 직접 입력한 예약에는 누구도 쓸 수 없다
    const manual = await createBooking(slot, null, "COMPLETED", { channel: "MANUAL" });
    expect((await failure(createReview({ userId: me.id, bookingId: manual.id, rating: 5, content: GOOD_CONTENT }))).code).toBe("NOT_FOUND");

    expect(await prisma.review.count()).toBe(0);
    expect(await ratings(product.id, business.id)).toMatchObject({ product: { ratingCount: 0 }, business: { ratingCount: 0 } });
  });

  it("작성 기간(reviewWindowDays)이 지나면 쓸 수 없고, 운영 설정을 바꾸면 바로 반영된다", async () => {
    const { slot, product } = await setup();
    const windowMs = DEFAULT_SETTINGS.reviewWindowDays * DAY;
    const [inTime, late] = await Promise.all([createUser(), createUser()]);
    const lateSlot = await createSlot(product, [{ capacity: 10 }], { startsInHours: -200 });
    const justInside = await createBooking(slot, inTime.id, "COMPLETED", { completedAt: new Date(Date.now() - windowMs + 5 * MINUTE) });
    const justOutside = await createBooking(lateSlot, late.id, "COMPLETED", { completedAt: new Date(Date.now() - windowMs - 5 * MINUTE) });

    const e = await failure(createReview({ userId: late.id, bookingId: justOutside.id, rating: 4, content: GOOD_CONTENT }));
    expect(e.code).toBe("CONFLICT");
    expect(e.message).toContain(`${DEFAULT_SETTINGS.reviewWindowDays}일`);
    await expect(createReview({ userId: inTime.id, bookingId: justInside.id, rating: 4, content: GOOD_CONTENT })).resolves.toMatchObject({ rating: 4 });

    // 운영자가 기간을 줄이면 그 기준으로 막는다
    const admin = await createAdmin("OPS");
    const shorter = 1;
    await updateSettings({ reviewWindowDays: shorter }, admin.id);
    const user = await createUser();
    const twoDaysAgo = await createBooking(lateSlot, user.id, "COMPLETED", { completedAt: new Date(Date.now() - 2 * DAY) });
    const blocked = await failure(createReview({ userId: user.id, bookingId: twoDaysAgo.id, rating: 5, content: GOOD_CONTENT }));
    expect(blocked.code).toBe("CONFLICT");
    expect(blocked.message).toContain(`${shorter}일`);
    expect(await listReviewableBookings(user.id)).toEqual([]);
  });

  it("예약 하나에 후기는 하나만 — 동시에 두 번 보내도 한 건만 남는다", async () => {
    const { slot, product, business } = await setup();
    const me = await createUser();
    const booking = await createBooking(slot, me.id);

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) => createReview({ userId: me.id, bookingId: booking.id, rating: i + 2, content: GOOD_CONTENT })),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(3);
    for (const f of failed) {
      expect(f.reason).toBeInstanceOf(AppError);
      expect((f.reason as AppError).code).toBe("CONFLICT");
    }

    const rows = await prisma.review.findMany({ where: { bookingId: booking.id } });
    expect(rows).toHaveLength(1);
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: rows[0]!.rating, ratingCount: 1 },
      business: { ratingAvg: rows[0]!.rating, ratingCount: 1 },
    });
    // 나중에 다시 보내도 같은 안내
    const again = await failure(createReview({ userId: me.id, bookingId: booking.id, rating: 1, content: GOOD_CONTENT }));
    expect(again.code).toBe("CONFLICT");
    expect(again.message).toBe("이미 후기를 남긴 예약이에요.");
  });

  it("여러 고객이 동시에 후기를 남겨도 평점 집계가 정확하다", async () => {
    const { slot, product, business } = await setup();
    const second = await createProduct(business.id, business.categoryId);
    const secondSlot = await createSlot(second, [{ capacity: 30 }], { startsInHours: -30 });
    const scores = [5, 4, 3, 5, 1, 2, 4, 5, 3, 4, 5, 2];
    const writers = await Promise.all(scores.map(() => createUser()));
    // 짝수 번째는 첫 상품, 홀수 번째는 둘째 상품
    const bookings = await Promise.all(writers.map((w, i) => createBooking(i % 2 === 0 ? slot : secondSlot, w.id)));

    await Promise.all(
      bookings.map((b, i) => createReview({ userId: writers[i]!.id, bookingId: b.id, rating: scores[i]!, content: GOOD_CONTENT })),
    );

    const avg = (values: number[]) => Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
    const first = scores.filter((_, i) => i % 2 === 0);
    const rest = scores.filter((_, i) => i % 2 === 1);
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: avg(first), ratingCount: first.length },
      business: { ratingAvg: avg(scores), ratingCount: scores.length },
    });
    expect((await ratings(second.id, business.id)).product).toEqual({ ratingAvg: avg(rest), ratingCount: rest.length });
  });

  it("입력 검증: 별점은 1~5 정수, 내용은 정해진 길이", async () => {
    const { slot } = await setup();
    const me = await createUser();
    const booking = await createBooking(slot, me.id);
    const attempt = (patch: Record<string, unknown>) =>
      failure(createReview({ userId: me.id, bookingId: booking.id, rating: 5, content: GOOD_CONTENT, ...patch } as never));

    for (const rating of [0, 6, 4.5, -1, "5", null, undefined, Number.NaN]) {
      const e = await attempt({ rating });
      expect(e.code, `rating=${String(rating)}`).toBe("VALIDATION");
      expect(e.fieldErrors?.rating).toBeTruthy();
    }
    const short = await attempt({ content: "가".repeat(REVIEW_CONTENT_MIN - 1) });
    expect(short.code).toBe("VALIDATION");
    expect(short.fieldErrors?.content).toContain(`${REVIEW_CONTENT_MIN}자`);
    // 공백만 늘린 내용은 길이로 치지 않는다
    expect((await attempt({ content: `${"가".repeat(REVIEW_CONTENT_MIN - 1)}${" ".repeat(20)}` })).code).toBe("VALIDATION");
    const long = await attempt({ content: "가".repeat(REVIEW_CONTENT_MAX + 1) });
    expect(long.code).toBe("VALIDATION");
    expect(long.fieldErrors?.content).toContain(`${REVIEW_CONTENT_MAX}자`);
    expect((await attempt({ bookingId: "x".repeat(200) })).code).toBe("VALIDATION");
    expect(await prisma.review.count()).toBe(0);

    // 경계값은 통과한다
    await expect(createReview({ userId: me.id, bookingId: booking.id, rating: 1, content: "가".repeat(REVIEW_CONTENT_MIN) })).resolves.toMatchObject({ rating: 1 });
    const other = await createUser();
    const otherBooking = await createBooking(slot, other.id);
    await expect(
      createReview({ userId: other.id, bookingId: otherBooking.id, rating: 5, content: "가".repeat(REVIEW_CONTENT_MAX) }),
    ).resolves.toMatchObject({ rating: 5 });
  });

  it("작성이 끝난 뒤 사업장 구성원 모두에게 새 후기 알림(SELLER_REVIEW)을 보낸다", async () => {
    const { slot, business, owner, product } = await setup();
    const [manager, staff, outsider] = await Promise.all([createUser(), createUser(), createUser()]);
    await addMember(business.id, manager.id, "MANAGER");
    await addMember(business.id, staff.id, "STAFF");

    const { author, review } = await writeReview(slot, 4);
    const notifications = await prisma.notification.findMany({ where: { type: "SELLER_REVIEW" } });
    expect(notifications.map((n) => n.userId).sort()).toEqual([owner.id, manager.id, staff.id].sort());
    for (const n of notifications) {
      expect(n.title).toBe("새 후기가 등록됐어요");
      expect(n.body).toContain(product.title);
      expect(n.body).toContain("4점");
      expect(n.data).toMatchObject({ reviewId: review.id, productId: product.id, rating: 4 });
      // 작성자가 누구인지(이름·연락처)는 알림에 싣지 않는다
      expect(n.body).not.toContain(author.name);
    }
    expect(await prisma.notification.count({ where: { userId: { in: [outsider.id, author.id] } } })).toBe(0);
  });

  it("알림을 보내지 못해도 후기는 그대로 남는다", async () => {
    const { slot, product, business } = await setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma.notification, "createManyAndReturn").mockRejectedValueOnce(new Error("알림 저장 실패") as never);

    const { review } = await writeReview(slot, 5);
    expect(await prisma.review.count({ where: { id: review.id } })).toBe(1);
    expect(await ratings(product.id, business.id)).toMatchObject({ product: { ratingCount: 1 }, business: { ratingCount: 1 } });
    expect(await prisma.notification.count()).toBe(0);
    // 실패는 조용히 삼키지 않고 기록으로 남긴다
    expect(log).toHaveBeenCalled();
  });

  it("너무 자주 쓰면 잠시 막는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-02T03:10:00Z"));
    const { slot } = await setup();
    const me = await createUser();
    for (let i = 0; i < REVIEW_HOURLY_LIMIT; i++) {
      const e = await failure(createReview({ userId: me.id, bookingId: "없는-예약", rating: 5, content: GOOD_CONTENT }));
      expect(e.code).toBe("NOT_FOUND");
    }
    const booking = await createBooking(slot, me.id);
    const limited = await failure(createReview({ userId: me.id, bookingId: booking.id, rating: 5, content: GOOD_CONTENT }));
    expect(limited.code).toBe("RATE_LIMITED");
    expect(await prisma.review.count()).toBe(0);

    // 다른 회원은 영향을 받지 않고, 시간이 지나면 다시 쓸 수 있다
    const other = await createUser();
    const otherBooking = await createBooking(slot, other.id);
    await expect(createReview({ userId: other.id, bookingId: otherBooking.id, rating: 5, content: GOOD_CONTENT })).resolves.toBeTruthy();
    vi.setSystemTime(new Date("2026-12-02T04:10:00Z"));
    await expect(createReview({ userId: me.id, bookingId: booking.id, rating: 5, content: GOOD_CONTENT })).resolves.toBeTruthy();
  });
});

// ── 삭제 ──────────────────────────────────────────────

describe("deleteOwnReview", () => {
  it("내 후기만 지울 수 있고, 지우면 평점 집계에서 빠진다", async () => {
    const { slot, product, business } = await setup();
    const a = await writeReview(slot, 5);
    const b = await writeReview(slot, 2);
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: 3.5, ratingCount: 2 },
      business: { ratingAvg: 3.5, ratingCount: 2 },
    });

    // 남의 후기, 없는 후기
    expect((await failure(deleteOwnReview(a.author.id, b.review.id))).code).toBe("NOT_FOUND");
    expect((await failure(deleteOwnReview(a.author.id, "없는-후기"))).code).toBe("NOT_FOUND");
    expect(await prisma.review.count()).toBe(2);

    await deleteOwnReview(b.author.id, b.review.id);
    expect(await prisma.review.findUnique({ where: { id: b.review.id } })).toBeNull();
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: 5, ratingCount: 1 },
      business: { ratingAvg: 5, ratingCount: 1 },
    });
    // 이미 지운 후기를 다시 지우려 하면 찾을 수 없다고 알린다
    expect((await failure(deleteOwnReview(b.author.id, b.review.id))).code).toBe("NOT_FOUND");

    await deleteOwnReview(a.author.id, a.review.id);
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: 0, ratingCount: 0 },
      business: { ratingAvg: 0, ratingCount: 0 },
    });
    // 기간 안이면 지운 뒤 다시 쓸 수 있다
    expect((await listReviewableBookings(a.author.id)).map((r) => r.bookingId)).toEqual([a.booking.id]);
    await expect(createReview({ userId: a.author.id, bookingId: a.booking.id, rating: 4, content: GOOD_CONTENT })).resolves.toMatchObject({ rating: 4 });
  });

  it("숨김 처리된 내 후기를 지워도 집계는 공개 후기 기준 그대로다", async () => {
    const { slot, product, business } = await setup();
    const admin = await createAdmin("CS");
    const visible = await writeReview(slot, 4);
    const hidden = await writeReview(slot, 1);
    await hideReview({ id: admin.id, role: "CS" }, hidden.review.id, "욕설이 들어 있어요");

    await deleteOwnReview(hidden.author.id, hidden.review.id);
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: 4, ratingCount: 1 },
      business: { ratingAvg: 4, ratingCount: 1 },
    });
    expect(await prisma.review.findMany({ select: { id: true } })).toEqual([{ id: visible.review.id }]);
  });
});

// ── 사업자 답글 ───────────────────────────────────────

describe("replyToReview · removeReply", () => {
  it("그 사업장의 대표·매니저만 답글을 달고 지울 수 있다", async () => {
    const { slot, business, owner } = await setup();
    const other = await setup();
    const [manager, staff, stranger] = await Promise.all([createUser(), createUser(), createUser()]);
    await addMember(business.id, manager.id, "MANAGER");
    await addMember(business.id, staff.id, "STAFF");
    const { review, author } = await writeReview(slot, 4);

    // 스태프, 다른 사업장 대표, 관계없는 회원, 후기 작성자는 답글을 달 수 없다
    for (const actor of [staff, other.owner, stranger, author]) {
      expect((await failure(replyToReview(actor.id, review.id, "찾아 주셔서 고마워요."))).code).toBe("FORBIDDEN");
      expect((await failure(removeReply(actor.id, review.id))).code).toBe("FORBIDDEN");
    }
    expect((await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).sellerReply).toBeNull();
    expect((await failure(replyToReview(owner.id, "없는-후기", "찾아 주셔서 고마워요."))).code).toBe("NOT_FOUND");

    const replied = await replyToReview(owner.id, review.id, "  찾아 주셔서 고마워요.  ");
    expect(replied).toEqual({ sellerReply: "찾아 주셔서 고마워요.", sellerRepliedAt: expect.any(Date) });
    expect(await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).toMatchObject({
      sellerReply: "찾아 주셔서 고마워요.",
      sellerRepliedAt: replied.sellerRepliedAt,
    });
    // 매니저가 고쳐 쓸 수 있다
    await replyToReview(manager.id, review.id, "다음에도 편하게 오세요.");
    const [shown] = (await listReviewsForProduct(slot.productId)).items;
    expect(shown).toMatchObject({ sellerReply: "다음에도 편하게 오세요.", sellerRepliedAt: expect.any(Date) });

    await removeReply(manager.id, review.id);
    expect(await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).toMatchObject({ sellerReply: null, sellerRepliedAt: null });
    // 답글이 없어도 오류 없이 끝난다
    await expect(removeReply(owner.id, review.id)).resolves.toBeUndefined();
  });

  it("답글은 후기 본문·별점·공개 여부·평점 집계를 바꾸지 못한다", async () => {
    const { slot, product, business, owner } = await setup();
    const { review } = await writeReview(slot, 2, undefined, "기대한 것과 달라서 아쉬웠어요. 진행이 늦었어요.");
    const before = await prisma.review.findUniqueOrThrow({ where: { id: review.id } });

    await replyToReview(owner.id, review.id, "불편을 드려 죄송해요. 진행 순서를 고쳤어요.");
    const after = await prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(after).toMatchObject({ rating: before.rating, content: before.content, status: "VISIBLE", hiddenReason: null });
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: 2, ratingCount: 1 },
      business: { ratingAvg: 2, ratingCount: 1 },
    });

    // 사업자는 운영자 역할을 자칭해도 후기를 숨길 수 없다
    for (const role of ["SUPER", "OPS", "CS"] as const) {
      expect((await failure(hideReview({ id: owner.id, role }, review.id, "마음에 들지 않는 후기예요"))).code).toBe("FORBIDDEN");
    }
    expect((await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).status).toBe("VISIBLE");
  });

  it("답글 입력 검증과 숨김 처리된 후기", async () => {
    const { slot, owner } = await setup();
    const admin = await createAdmin("OPS");
    const { review } = await writeReview(slot, 3);

    for (const reply of ["", "   ", "가".repeat(REVIEW_REPLY_MAX + 1), null]) {
      expect((await failure(replyToReview(owner.id, review.id, reply as never))).code).toBe("VALIDATION");
    }
    await expect(replyToReview(owner.id, review.id, "가".repeat(REVIEW_REPLY_MAX))).resolves.toBeTruthy();

    await hideReview({ id: admin.id, role: "OPS" }, review.id, "광고성 내용이에요");
    const e = await failure(replyToReview(owner.id, review.id, "숨겨진 후기에 다는 답글"));
    expect(e.code).toBe("CONFLICT");
    expect((await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).sellerReply).toBe("가".repeat(REVIEW_REPLY_MAX));
  });
});

// ── 운영자 숨김 ───────────────────────────────────────

describe("hideReview · unhideReview", () => {
  it("CS·OPS·SUPER 만 숨기고 되돌릴 수 있다(넘겨받은 역할과 DB 의 역할을 모두 확인)", async () => {
    const { slot } = await setup();
    const { review } = await writeReview(slot, 1);
    const [cs, ops, superAdmin, finance, member] = await Promise.all([
      createAdmin("CS"),
      createAdmin("OPS"),
      createAdmin("SUPER"),
      createAdmin("FINANCE"),
      createUser(),
    ]);
    const status = async () => (await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).status;

    // 정산 담당, 일반 회원, 역할을 부풀려 넘긴 경우, 정지된 운영자
    expect((await failure(hideReview({ id: finance.id, role: "FINANCE" }, review.id, "운영 기준 위반"))).code).toBe("FORBIDDEN");
    expect((await failure(hideReview({ id: finance.id, role: "SUPER" }, review.id, "운영 기준 위반"))).code).toBe("FORBIDDEN");
    expect((await failure(hideReview({ id: member.id, role: "CS" }, review.id, "운영 기준 위반"))).code).toBe("FORBIDDEN");
    expect((await failure(hideReview({ id: "없는-운영자", role: "SUPER" }, review.id, "운영 기준 위반"))).code).toBe("FORBIDDEN");
    const suspended = await createUser({ adminRole: "CS", status: "SUSPENDED" });
    expect((await failure(hideReview({ id: suspended.id, role: "CS" }, review.id, "운영 기준 위반"))).code).toBe("FORBIDDEN");
    expect(await status()).toBe("VISIBLE");

    for (const admin of [
      { id: cs.id, role: "CS" as const },
      { id: ops.id, role: "OPS" as const },
      { id: superAdmin.id, role: "SUPER" as const },
    ]) {
      await hideReview(admin, review.id, "운영 기준 위반");
      expect(await status()).toBe("HIDDEN");
      expect((await failure(unhideReview({ id: finance.id, role: "FINANCE" }, review.id, "다시 확인함"))).code).toBe("FORBIDDEN");
      await unhideReview(admin, review.id, "다시 확인해 보니 문제가 없어요");
      expect(await status()).toBe("VISIBLE");
    }
  });

  it("사유는 반드시 적어야 하고, 후기와 감사 로그에 남는다", async () => {
    const { slot, product, business } = await setup();
    const admin = await createAdmin("CS");
    const actor = { id: admin.id, role: "CS" as const };
    const { review, author } = await writeReview(slot, 1);

    for (const reason of ["", " ", "가", "가".repeat(REVIEW_HIDE_REASON_MAX + 1), undefined]) {
      expect((await failure(hideReview(actor, review.id, reason as never))).code).toBe("VALIDATION");
    }
    expect((await failure(hideReview(actor, "없는-후기", "운영 기준 위반"))).code).toBe("NOT_FOUND");
    expect(await prisma.auditLog.count()).toBe(0);

    await hideReview(actor, review.id, "  다른 참가자의 실명이 적혀 있어요  ");
    expect(await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).toMatchObject({
      status: "HIDDEN",
      hiddenReason: "다른 참가자의 실명이 적혀 있어요",
    });
    const [hideLog] = await prisma.auditLog.findMany({ where: { action: "review.hide" } });
    expect(hideLog).toMatchObject({
      actorId: admin.id,
      actorType: "ADMIN",
      targetType: "Review",
      targetId: review.id,
      meta: { reason: "다른 참가자의 실명이 적혀 있어요", productId: product.id, businessId: business.id },
    });
    // 작성자에게 처리 사실과 사유를 알린다
    const notice = await prisma.notification.findFirstOrThrow({ where: { userId: author.id } });
    expect(notice.body).toContain("다른 참가자의 실명이 적혀 있어요");
    // 작성자의 내 후기 목록에는 숨김 상태와 사유가 보인다
    expect((await listMyReviews(author.id))[0]).toMatchObject({ status: "HIDDEN", hiddenReason: "다른 참가자의 실명이 적혀 있어요" });

    // 이미 숨긴 후기를 다시 숨길 수 없다
    expect((await failure(hideReview(actor, review.id, "한 번 더 숨기기"))).code).toBe("CONFLICT");
    expect(await prisma.auditLog.count({ where: { action: "review.hide" } })).toBe(1);

    // 되돌릴 때도 사유가 필요하고 감사 로그에 남는다
    expect((await failure(unhideReview(actor, review.id, ""))).code).toBe("VALIDATION");
    await unhideReview(actor, review.id, "이의 신청을 검토해 복구해요");
    expect(await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).toMatchObject({ status: "VISIBLE", hiddenReason: null });
    const [unhideLog] = await prisma.auditLog.findMany({ where: { action: "review.unhide" } });
    expect(unhideLog).toMatchObject({ actorId: admin.id, targetId: review.id, meta: { reason: "이의 신청을 검토해 복구해요" } });
    expect((await failure(unhideReview(actor, review.id, "이미 공개된 후기"))).code).toBe("CONFLICT");
    expect((await listMyReviews(author.id))[0]).toMatchObject({ status: "VISIBLE", hiddenReason: null });
  });

  it("숨기면 평점 집계·공개 목록·요약에서 빠지고, 되돌리면 다시 들어간다", async () => {
    const { slot, product, business } = await setup();
    const admin = await createAdmin("OPS");
    const actor = { id: admin.id, role: "OPS" as const };
    const good = await writeReview(slot, 5);
    const bad = await writeReview(slot, 1);
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: 3, ratingCount: 2 },
      business: { ratingAvg: 3, ratingCount: 2 },
    });

    await hideReview(actor, bad.review.id, "사실과 다른 내용이에요");
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: 5, ratingCount: 1 },
      business: { ratingAvg: 5, ratingCount: 1 },
    });
    expect((await listReviewsForProduct(product.id)).items.map((r) => r.id)).toEqual([good.review.id]);
    expect((await listReviewsForBusiness(business.id)).items.map((r) => r.id)).toEqual([good.review.id]);
    expect(await getReviewSummary({ productId: product.id })).toMatchObject({
      avg: 5,
      count: 1,
      isNew: true,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 },
    });

    // 숨겨진 사이 새 후기가 들어와도 숨긴 후기는 세지 않는다
    await writeReview(slot, 4);
    expect((await ratings(product.id, business.id)).product).toEqual({ ratingAvg: 4.5, ratingCount: 2 });

    await unhideReview(actor, bad.review.id, "확인 결과 문제가 없어요");
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: 3.33, ratingCount: 3 },
      business: { ratingAvg: 3.33, ratingCount: 3 },
    });
    const summary = await getReviewSummary({ businessId: business.id });
    expect(summary).toMatchObject({ avg: 3.33, count: 3, isNew: 3 < REVIEW_NEW_THRESHOLD, distribution: { 1: 1, 2: 0, 3: 0, 4: 1, 5: 1 } });
    expect((await listReviewsForProduct(product.id)).items).toHaveLength(3);
  });

  it("숨김·되돌리기·작성이 동시에 일어나도 집계는 공개 후기와 일치한다", async () => {
    const { slot, product, business } = await setup();
    const admin = await createAdmin("SUPER");
    const actor = { id: admin.id, role: "SUPER" as const };
    const existing = await Promise.all([5, 4, 3, 2, 1, 5].map((rating) => writeReview(slot, rating)));
    const newcomers = await Promise.all([4, 2, 5].map(async (rating) => ({ rating, user: await createUser() })));
    const newBookings = await Promise.all(newcomers.map((n) => createBooking(slot, n.user.id)));

    await Promise.all([
      hideReview(actor, existing[0]!.review.id, "동시에 숨기기 1"),
      hideReview(actor, existing[1]!.review.id, "동시에 숨기기 2"),
      deleteOwnReview(existing[2]!.author.id, existing[2]!.review.id),
      ...newcomers.map((n, i) => createReview({ userId: n.user.id, bookingId: newBookings[i]!.id, rating: n.rating, content: GOOD_CONTENT })),
    ]);
    await Promise.all([unhideReview(actor, existing[0]!.review.id, "동시에 되돌리기"), hideReview(actor, existing[5]!.review.id, "동시에 숨기기 3")]);

    const visible = await prisma.review.findMany({ where: { businessId: business.id, status: "VISIBLE" }, select: { rating: true } });
    const expectedAvg = Math.round((visible.reduce((sum, r) => sum + r.rating, 0) / visible.length) * 100) / 100;
    // 남은 공개 후기: 5(되돌림), 2, 1, 4, 2, 5
    expect(visible.map((r) => r.rating).sort()).toEqual([1, 2, 2, 4, 5, 5]);
    expect(await ratings(product.id, business.id)).toEqual({
      product: { ratingAvg: expectedAvg, ratingCount: visible.length },
      business: { ratingAvg: expectedAvg, ratingCount: visible.length },
    });
  });
});

// ── 목록 ──────────────────────────────────────────────

describe("공개 후기 목록", () => {
  it("공개 후기만, 작성자 이름을 가려서, 사업자 답글과 함께 최신순으로 준다", async () => {
    const { slot, product, business, owner } = await setup();
    const otherProduct = await createProduct(business.id, business.categoryId, { title: "보드게임 번개" });
    const otherSlot = await createSlot(otherProduct, [{ capacity: 10 }], { startsInHours: -40 });
    const admin = await createAdmin("CS");

    const first = await writeReview(slot, 5, await createUser({ name: "홍길동" }));
    const second = await writeReview(otherSlot, 4, await createUser({ name: "김철" }));
    const hidden = await writeReview(slot, 1, await createUser({ name: "이숨김" }));
    // 작성 시각을 벌려 순서를 고정한다
    const base = Date.now();
    await prisma.review.update({ where: { id: first.review.id }, data: { createdAt: new Date(base - 3 * MINUTE) } });
    await prisma.review.update({ where: { id: second.review.id }, data: { createdAt: new Date(base - 2 * MINUTE) } });
    await prisma.review.update({ where: { id: hidden.review.id }, data: { createdAt: new Date(base - MINUTE) } });
    await hideReview({ id: admin.id, role: "CS" }, hidden.review.id, "운영 기준 위반");
    const reply = await replyToReview(owner.id, first.review.id, "찾아 주셔서 고마워요.");

    const forProduct = await listReviewsForProduct(product.id);
    expect(forProduct).toEqual({
      items: [
        {
          id: first.review.id,
          rating: 5,
          content: GOOD_CONTENT,
          authorName: "홍*동",
          product: { id: product.id, title: product.title },
          attendedAt: slot.startAt,
          sellerReply: "찾아 주셔서 고마워요.",
          sellerRepliedAt: reply.sellerRepliedAt,
          createdAt: new Date(base - 3 * MINUTE),
        },
      ],
      nextCursor: null,
    });

    const forBusiness = await listReviewsForBusiness(business.id);
    expect(forBusiness.items.map((r) => [r.id, r.authorName, r.product.title])).toEqual([
      [second.review.id, maskName("김철"), "보드게임 번개"],
      [first.review.id, maskName("홍길동"), product.title],
    ]);

    // 작성자를 알아볼 수 있는 값·예약 정보·숨김 사유는 어디에도 없다
    const keys = collectKeys([forProduct, forBusiness]);
    for (const key of ["userId", "bookingId", "name", "email", "phone", "guestName", "guestPhone", "hiddenReason", "status", "businessId"]) {
      expect(keys.has(key), key).toBe(false);
    }
    const text = JSON.stringify([forProduct, forBusiness]);
    for (const secret of ["홍길동", "김철", "이숨김", "예약자본명", "01077778888", "사업자만 보는 메모", first.author.email, first.booking.code]) {
      expect(text).not.toContain(secret);
    }

    // 탈퇴한 회원의 후기는 가린 이름 대신 안내 문구로 보여 준다
    await prisma.user.update({ where: { id: second.author.id }, data: { status: "WITHDRAWN", name: "탈퇴한 회원" } });
    expect((await listReviewsForBusiness(business.id)).items.map((r) => r.authorName)).toEqual([WITHDRAWN_AUTHOR, "홍*동"]);
    expect((await getReviewSummary({ businessId: business.id })).latest.map((r) => r.authorName)).toEqual([WITHDRAWN_AUTHOR, "홍*동"]);

    // 다른 사업장·없는 상품은 빈 목록
    const elsewhere = await setup();
    expect(await listReviewsForBusiness(elsewhere.business.id)).toEqual({ items: [], nextCursor: null });
    expect(await listReviewsForProduct("없는-상품")).toEqual({ items: [], nextCursor: null });
  });

  it("작성 시각이 같은 후기가 많아도 쪽을 넘길 때 겹치거나 빠지지 않는다", async () => {
    const { slot, product, business } = await setup();
    const written = await Promise.all(Array.from({ length: 11 }, (_, i) => writeReview(slot, (i % 5) + 1)));
    const sameTime = new Date(Date.now() - HOUR);
    // 일곱 건은 같은 시각, 나머지는 서로 다른 시각
    await prisma.review.updateMany({ where: { id: { in: written.slice(0, 7).map((w) => w.review.id) } }, data: { createdAt: sameTime } });
    for (const [i, w] of written.slice(7).entries()) {
      await prisma.review.update({ where: { id: w.review.id }, data: { createdAt: new Date(sameTime.getTime() + (i + 1) * MINUTE) } });
    }

    for (const fetchPage of [
      (cursor?: string) => listReviewsForProduct(product.id, { limit: 3, cursor }),
      (cursor?: string) => listReviewsForBusiness(business.id, { limit: 3, cursor }),
    ]) {
      const paged: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await fetchPage(cursor);
        expect(page.items.length).toBeLessThanOrEqual(3);
        paged.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(4);
      expect(new Set(paged).size).toBe(written.length);
      expect(paged).toEqual((await listReviewsForProduct(product.id, { limit: 50 })).items.map((r) => r.id));
    }

    expect((await failure(listReviewsForProduct(product.id, { cursor: "엉뚱한 값" }))).code).toBe("VALIDATION");
    expect((await failure(listReviewsForProduct(product.id, { limit: 51 }))).code).toBe("VALIDATION");
    expect((await failure(listReviewsForBusiness(business.id, { limit: 0 }))).code).toBe("VALIDATION");
  });
});

describe("listReviewsForSeller · listMyReviews", () => {
  it("사업장 구성원만 자기 사업장 후기를 보고, 답글이 없는 후기만 골라 볼 수 있다", async () => {
    const { slot, business, owner } = await setup();
    const other = await setup();
    const [staff, stranger] = await Promise.all([createUser(), createUser()]);
    await addMember(business.id, staff.id, "STAFF");
    const admin = await createAdmin("CS");

    const replied = await writeReview(slot, 5, await createUser({ name: "홍길동" }));
    const waiting = await writeReview(slot, 3);
    const hidden = await writeReview(slot, 1);
    await writeReview(other.slot, 4);
    const base = Date.now();
    await prisma.review.update({ where: { id: replied.review.id }, data: { createdAt: new Date(base - 3 * MINUTE) } });
    await prisma.review.update({ where: { id: waiting.review.id }, data: { createdAt: new Date(base - 2 * MINUTE) } });
    await prisma.review.update({ where: { id: hidden.review.id }, data: { createdAt: new Date(base - MINUTE) } });
    await replyToReview(owner.id, replied.review.id, "찾아 주셔서 고마워요.");
    await hideReview({ id: admin.id, role: "CS" }, hidden.review.id, "운영 기준 위반");

    // 스태프도 볼 수 있다. 숨김 처리된 후기도 상태와 함께 보인다
    const all = await listReviewsForSeller(staff.id, business.id);
    expect(all.items.map((r) => [r.id, r.status])).toEqual([
      [hidden.review.id, "HIDDEN"],
      [waiting.review.id, "VISIBLE"],
      [replied.review.id, "VISIBLE"],
    ]);
    expect(all.items[2]).toMatchObject({ authorName: "홍*동", sellerReply: "찾아 주셔서 고마워요.", rating: 5 });
    expect(all.nextCursor).toBeNull();

    // 답글을 달지 않은 공개 후기만
    expect((await listReviewsForSeller(owner.id, business.id, { unrepliedOnly: true })).items.map((r) => r.id)).toEqual([waiting.review.id]);
    const firstPage = await listReviewsForSeller(owner.id, business.id, { limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    const secondPage = await listReviewsForSeller(owner.id, business.id, { limit: 2, cursor: firstPage.nextCursor! });
    expect(secondPage.items.map((r) => r.id)).toEqual([replied.review.id]);
    expect(secondPage.nextCursor).toBeNull();

    // 다른 사업장 대표, 관계없는 회원은 볼 수 없다
    expect((await failure(listReviewsForSeller(other.owner.id, business.id))).code).toBe("FORBIDDEN");
    expect((await failure(listReviewsForSeller(stranger.id, business.id))).code).toBe("FORBIDDEN");
    expect((await failure(listReviewsForSeller(owner.id, other.business.id))).code).toBe("FORBIDDEN");
    // 사업자에게도 작성자의 실명·연락처·예약번호는 주지 않는다
    const text = JSON.stringify(all);
    for (const secret of ["홍길동", replied.author.email, replied.author.phone!, replied.booking.code]) expect(text).not.toContain(secret);
  });

  it("내가 쓴 후기는 숨김 상태·답글까지 보이고, 남의 후기는 섞이지 않는다", async () => {
    const { slot, product, business, owner } = await setup();
    const me = await createUser();
    const laterSlot = await createSlot(product, [{ capacity: 10 }], { startsInHours: -10 });
    const older = await writeReview(slot, 5, me);
    const newer = await writeReview(laterSlot, 2, me);
    await writeReview(slot, 4);
    const base = Date.now();
    await prisma.review.update({ where: { id: older.review.id }, data: { createdAt: new Date(base - 2 * MINUTE) } });
    await prisma.review.update({ where: { id: newer.review.id }, data: { createdAt: new Date(base - MINUTE) } });
    await replyToReview(owner.id, older.review.id, "또 오세요.");

    const mine = await listMyReviews(me.id);
    expect(mine).toEqual([
      {
        id: newer.review.id,
        bookingCode: newer.booking.code,
        product: { id: product.id, title: product.title },
        business: { slug: business.slug, name: business.name },
        attendedAt: laterSlot.startAt,
        rating: 2,
        content: GOOD_CONTENT,
        status: "VISIBLE",
        hiddenReason: null,
        sellerReply: null,
        sellerRepliedAt: null,
        createdAt: new Date(base - MINUTE),
      },
      expect.objectContaining({ id: older.review.id, bookingCode: older.booking.code, sellerReply: "또 오세요.", rating: 5 }),
    ]);
    expect(await listMyReviews((await createUser()).id)).toEqual([]);
  });
});
