import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingStatus, MemberRole, Prisma, ReportReason, ReportStatus } from "@/generated/prisma/client";
import { CANCELLATION_PRESETS } from "@/lib/domain";
import { maskName } from "@/lib/format";
import { HOUR, MINUTE } from "@/lib/time";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  NO_SHOW_DISPUTE_HOURS,
  REPORT_ATTEMPT_HOURLY_LIMIT,
  REPORT_DAILY_LIMIT,
  REPORT_DETAIL_MAX,
  REPORT_DETAIL_MIN,
  REPORT_REASONS,
  REPORT_TARGET_TYPES,
  createReport,
  listMyReports,
  type CreateReportInput,
} from "@/server/services/reports";
import { createBusiness, createCategory, createProduct, createSlot, createUser, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── 준비 도구 ─────────────────────────────────────────

const DETAIL = "안내된 내용과 실제 진행이 많이 달랐어요.";

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("실패해야 하는 호출이 성공했어요.");
}

async function setup() {
  const category = await createCategory();
  const { business, owner } = await createBusiness({ categoryId: category.id, name: "연결고리 라운지" });
  const product = await createProduct(business.id, category.id, { title: "와인 로테이션 소개팅" });
  const slot = await createSlot(product, [{ capacity: 30 }], { startsInHours: -30 });
  return { category, business, owner, product, slot };
}

type SlotRef = { id: string; productId: string; businessId: string; seats: { id: string }[] };

async function createBooking(slot: SlotRef, userId: string | null, status: BookingStatus = "CONFIRMED", data: Partial<Prisma.BookingUncheckedCreateInput> = {}) {
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
      policySnapshot: [...CANCELLATION_PRESETS.STANDARD.tiers],
      checkinToken: randomBytes(12).toString("hex"),
      ...data,
    },
  });
}

const addMember = (businessId: string, userId: string, role: MemberRole) =>
  prisma.businessMember.create({ data: { businessId, userId, role } });

const report = (input: Partial<CreateReportInput> & Pick<CreateReportInput, "reporterId" | "targetType" | "targetId">) =>
  createReport({ reason: "FALSE_INFO", detail: DETAIL, ...input });

const setStatus = (id: string, status: ReportStatus) => prisma.report.update({ where: { id }, data: { status } });

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

// ── 접수 ──────────────────────────────────────────────

describe("createReport — 대상과 입력", () => {
  it("사업장·상품·후기·회원을 신고할 수 있고, 접수 내용이 그대로 남는다", async () => {
    const { business, product, slot } = await setup();
    const [me, someone, writer] = await Promise.all([createUser(), createUser(), createUser()]);
    const reviewed = await createBooking(slot, writer.id, "COMPLETED");
    const review = await prisma.review.create({
      data: { bookingId: reviewed.id, userId: writer.id, businessId: business.id, productId: product.id, rating: 5, content: "광고처럼 보이는 후기예요." },
    });

    const targets: [CreateReportInput["targetType"], string, ReportReason][] = [
      ["BUSINESS", business.id, "OFF_PLATFORM"],
      ["PRODUCT", product.id, "FAKE_VACANCY"],
      ["REVIEW", review.id, "INAPPROPRIATE"],
      ["USER", someone.id, "SAFETY"],
    ];
    for (const [targetType, targetId, reason] of targets) {
      const created = await createReport({ reporterId: me.id, targetType, targetId, reason, detail: `  ${DETAIL}  ` });
      expect(created).toEqual({ id: expect.any(String), status: "OPEN", createdAt: expect.any(Date) });
      expect(await prisma.report.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
        reporterId: me.id,
        targetType,
        targetId,
        bookingId: null,
        reason,
        detail: DETAIL,
        status: "OPEN",
        resolution: null,
        handledById: null,
      });
    }
    expect(await prisma.report.count()).toBe(targets.length);

    // 접수 사실은 감사 로그에 남긴다
    const logs = await prisma.auditLog.findMany({ where: { action: "report.create" } });
    expect(logs).toHaveLength(targets.length);
    for (const log of logs) expect(log).toMatchObject({ actorId: me.id, actorType: "CUSTOMER", targetType: "Report" });
  });

  it("없는 대상과 본인은 신고할 수 없다", async () => {
    const { business } = await setup();
    const me = await createUser();
    for (const targetType of ["BUSINESS", "PRODUCT", "REVIEW", "USER", "BOOKING"] as const) {
      const e = await failure(report({ reporterId: me.id, targetType, targetId: "없는-대상" }));
      expect(e.code, targetType).toBe("NOT_FOUND");
    }
    // 종류가 다른 ID 는 대상이 아니다
    expect((await failure(report({ reporterId: me.id, targetType: "PRODUCT", targetId: business.id }))).code).toBe("NOT_FOUND");
    const self = await failure(report({ reporterId: me.id, targetType: "USER", targetId: me.id }));
    expect(self.code).toBe("VALIDATION");
    expect(await prisma.report.count()).toBe(0);
  });

  it("입력 검증: 대상 종류·사유·내용 길이", async () => {
    const { business } = await setup();
    const me = await createUser();
    const base = { reporterId: me.id, targetType: "BUSINESS", targetId: business.id, reason: "FALSE_INFO", detail: DETAIL };
    const attempt = (patch: Record<string, unknown>) => failure(createReport({ ...base, ...patch } as never));

    expect((await attempt({ targetType: "SLOT" })).fieldErrors?.targetType).toBeTruthy();
    expect((await attempt({ reason: "SPAM" })).fieldErrors?.reason).toBeTruthy();
    expect((await attempt({ reason: undefined })).code).toBe("VALIDATION");
    const short = await attempt({ detail: "가".repeat(REPORT_DETAIL_MIN - 1) });
    expect(short.code).toBe("VALIDATION");
    expect(short.fieldErrors?.detail).toContain(`${REPORT_DETAIL_MIN}자`);
    expect((await attempt({ detail: `${"가".repeat(REPORT_DETAIL_MIN - 1)}${" ".repeat(30)}` })).code).toBe("VALIDATION");
    const long = await attempt({ detail: "가".repeat(REPORT_DETAIL_MAX + 1) });
    expect(long.fieldErrors?.detail).toContain(`${REPORT_DETAIL_MAX}자`);
    expect((await attempt({ targetId: "" })).code).toBe("VALIDATION");
    expect((await attempt({ targetId: "x".repeat(100) })).code).toBe("VALIDATION");
    expect((await attempt({ bookingId: "x".repeat(100) })).code).toBe("VALIDATION");
    expect(await prisma.report.count()).toBe(0);

    await expect(createReport({ ...base, detail: "가".repeat(REPORT_DETAIL_MIN) } as CreateReportInput)).resolves.toBeTruthy();
    await expect(createReport({ ...base, reason: "OTHER", detail: "가".repeat(REPORT_DETAIL_MAX) } as CreateReportInput)).resolves.toBeTruthy();
    // 스키마의 enum 과 같은 목록을 쓴다
    expect([...REPORT_TARGET_TYPES].sort()).toEqual(["BOOKING", "BUSINESS", "PRODUCT", "REVIEW", "USER"]);
    expect(REPORT_REASONS).toContain("NO_SHOW_DISPUTE");
    expect(REPORT_REASONS).toContain("COMMISSION_DISPUTE");
  });
});

describe("createReport — 예약이 얽힌 신고", () => {
  it("예약을 대상으로 한 신고는 그 예약을 한 본인만 할 수 있다", async () => {
    const { slot, owner } = await setup();
    const [me, other] = await Promise.all([createUser(), createUser()]);
    const mine = await createBooking(slot, me.id, "COMPLETED");

    // 남의 예약은 없는 예약과 똑같이 답한다(있는지 알려 주지 않는다). 그 사업장 대표라도 일반 신고는 할 수 없다
    const missing = await failure(report({ reporterId: other.id, targetType: "BOOKING", targetId: "없는-예약", reason: "NO_SERVICE" }));
    for (const reporter of [other, owner]) {
      const e = await failure(report({ reporterId: reporter.id, targetType: "BOOKING", targetId: mine.id, reason: "NO_SERVICE" }));
      expect(e.code).toBe("NOT_FOUND");
      expect(e.message).toBe(missing.message);
    }
    const manual = await createBooking(slot, null, "COMPLETED", { channel: "MANUAL" });
    expect((await failure(report({ reporterId: me.id, targetType: "BOOKING", targetId: manual.id }))).code).toBe("NOT_FOUND");

    const created = await report({ reporterId: me.id, targetType: "BOOKING", targetId: mine.id, reason: "NO_SERVICE" });
    expect(await prisma.report.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ targetType: "BOOKING", targetId: mine.id, bookingId: mine.id });

    // 대상 예약과 다른 예약을 함께 넘기면 받지 않는다
    const another = await createBooking(await createSlot({ id: slot.productId, businessId: slot.businessId }, [{ capacity: 5 }], { startsInHours: -50 }), me.id, "COMPLETED");
    const mismatch = await failure(report({ reporterId: me.id, targetType: "BOOKING", targetId: mine.id, bookingId: another.id, reason: "OTHER" }));
    expect(mismatch.code).toBe("VALIDATION");
    expect(mismatch.fieldErrors?.bookingId).toBeTruthy();
  });

  it("환불 분쟁은 본인 예약을 골라야 하고, 신고 대상과 관련된 예약이어야 한다", async () => {
    const { business, product, slot, owner } = await setup();
    const elsewhere = await setup();
    const [me, other] = await Promise.all([createUser(), createUser()]);
    const mine = await createBooking(slot, me.id, "CANCELLED");
    const theirs = await createBooking(slot, other.id, "CANCELLED");
    const mineElsewhere = await createBooking(elsewhere.slot, me.id, "CANCELLED");

    // 예약 없이는 접수하지 않는다
    const noBooking = await failure(report({ reporterId: me.id, targetType: "BUSINESS", targetId: business.id, reason: "REFUND_DISPUTE" }));
    expect(noBooking.code).toBe("VALIDATION");
    expect(noBooking.fieldErrors?.bookingId).toBeTruthy();
    // 남의 예약(그 사업장 대표가 고객 예약을 넣는 경우 포함)
    for (const reporter of [me, owner]) {
      const e = await failure(report({ reporterId: reporter.id, targetType: "BUSINESS", targetId: business.id, bookingId: theirs.id, reason: "REFUND_DISPUTE" }));
      expect(e.code).toBe("NOT_FOUND");
    }
    // 다른 사업장에서 한 내 예약을 붙일 수 없다
    const unrelated = await failure(
      report({ reporterId: me.id, targetType: "BUSINESS", targetId: business.id, bookingId: mineElsewhere.id, reason: "REFUND_DISPUTE" }),
    );
    expect(unrelated.code).toBe("VALIDATION");
    expect((await failure(report({ reporterId: me.id, targetType: "PRODUCT", targetId: product.id, bookingId: mineElsewhere.id, reason: "REFUND_DISPUTE" }))).code).toBe(
      "VALIDATION",
    );
    expect(await prisma.report.count()).toBe(0);

    const viaBusiness = await report({ reporterId: me.id, targetType: "BUSINESS", targetId: business.id, bookingId: mine.id, reason: "REFUND_DISPUTE" });
    const viaProduct = await report({ reporterId: me.id, targetType: "PRODUCT", targetId: product.id, bookingId: mine.id, reason: "REFUND_DISPUTE" });
    const viaBooking = await report({ reporterId: me.id, targetType: "BOOKING", targetId: mine.id, reason: "REFUND_DISPUTE" });
    for (const created of [viaBusiness, viaProduct, viaBooking]) {
      expect((await prisma.report.findUniqueOrThrow({ where: { id: created.id } })).bookingId).toBe(mine.id);
    }
  });

  it("참고로 붙이는 예약은 본인 예약이거나 본인 사업장의 예약이어야 한다", async () => {
    const { business, slot, owner } = await setup();
    const elsewhere = await setup();
    const [customer, stranger, staff] = await Promise.all([createUser(), createUser(), createUser()]);
    await addMember(business.id, staff.id, "STAFF");
    const booking = await createBooking(slot, customer.id, "COMPLETED");

    // 사업장 구성원이 고객을 신고하면서 자기 사업장의 예약을 붙인다
    const bySeller = await report({ reporterId: staff.id, targetType: "USER", targetId: customer.id, bookingId: booking.id, reason: "INAPPROPRIATE" });
    expect((await prisma.report.findUniqueOrThrow({ where: { id: bySeller.id } })).bookingId).toBe(booking.id);
    // 고객이 사업장을 신고하면서 자기 예약을 붙인다
    await expect(report({ reporterId: customer.id, targetType: "BUSINESS", targetId: business.id, bookingId: booking.id, reason: "NO_SERVICE" })).resolves.toBeTruthy();

    // 관계없는 회원, 다른 사업장 대표는 남의 예약을 붙일 수 없다
    for (const reporter of [stranger, elsewhere.owner]) {
      const e = await failure(report({ reporterId: reporter.id, targetType: "USER", targetId: customer.id, bookingId: booking.id, reason: "INAPPROPRIATE" }));
      expect(e.code).toBe("NOT_FOUND");
    }
    expect((await failure(report({ reporterId: owner.id, targetType: "USER", targetId: customer.id, bookingId: "없는-예약" }))).code).toBe("NOT_FOUND");
  });
});

describe("createReport — 노쇼 이의제기", () => {
  it("노쇼 처리된 본인 예약에만, 처리 후 정해진 시간 안에만 신청할 수 있다", async () => {
    const { slot, product, business, owner } = await setup();
    const [me, other, late, edge] = await Promise.all([createUser(), createUser(), createUser(), createUser()]);
    const windowMs = NO_SHOW_DISPUTE_HOURS * HOUR;
    const noShow = await createBooking(slot, me.id, "NO_SHOW", { noShowAt: new Date(Date.now() - 2 * HOUR) });
    const base = { targetType: "BOOKING" as const, reason: "NO_SHOW_DISPUTE" as const };

    // 예약이 아닌 대상으로는 신청할 수 없다
    for (const [targetType, targetId] of [
      ["BUSINESS", business.id],
      ["PRODUCT", product.id],
    ] as const) {
      const e = await failure(report({ reporterId: me.id, targetType, targetId, bookingId: noShow.id, reason: "NO_SHOW_DISPUTE" }));
      expect(e.code).toBe("VALIDATION");
    }
    // 남의 예약(그 사업장 대표 포함)
    for (const reporter of [other, owner]) {
      expect((await failure(report({ ...base, reporterId: reporter.id, targetId: noShow.id }))).code).toBe("NOT_FOUND");
    }
    // 노쇼가 아닌 예약
    for (const status of ["CONFIRMED", "COMPLETED", "CANCELLED"] as const) {
      const user = await createUser();
      const booking = await createBooking(slot, user.id, status);
      const e = await failure(report({ ...base, reporterId: user.id, targetId: booking.id }));
      expect(e.code, status).toBe("CONFLICT");
    }

    // 기한이 지난 노쇼
    const expired = await createBooking(slot, late.id, "NO_SHOW", { noShowAt: new Date(Date.now() - windowMs - MINUTE) });
    const tooLate = await failure(report({ ...base, reporterId: late.id, targetId: expired.id }));
    expect(tooLate.code).toBe("CONFLICT");
    expect(tooLate.message).toBe(`노쇼 처리 후 ${NO_SHOW_DISPUTE_HOURS}시간 안에만 이의제기할 수 있어요.`);
    expect(NO_SHOW_DISPUTE_HOURS).toBe(72);
    expect(await prisma.report.count()).toBe(0);

    // 기한 직전과 방금 처리된 노쇼는 받는다
    const nearlyOver = await createBooking(slot, edge.id, "NO_SHOW", { noShowAt: new Date(Date.now() - windowMs + MINUTE) });
    await expect(report({ ...base, reporterId: edge.id, targetId: nearlyOver.id })).resolves.toMatchObject({ status: "OPEN" });
    const created = await report({ ...base, reporterId: me.id, targetId: noShow.id });
    expect(await prisma.report.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      reporterId: me.id,
      targetType: "BOOKING",
      targetId: noShow.id,
      bookingId: noShow.id,
      reason: "NO_SHOW_DISPUTE",
    });
  });

  it("노쇼 처리 시각 기록이 없으면 마지막 변경 시각을 기준으로 삼는다", async () => {
    const { slot } = await setup();
    const [recent, old] = await Promise.all([createUser(), createUser()]);
    const justNow = await createBooking(slot, recent.id, "NO_SHOW", { noShowAt: null });
    const longAgo = await createBooking(slot, old.id, "NO_SHOW", { noShowAt: null });
    await prisma.$executeRaw`UPDATE "Booking" SET "updatedAt" = ${new Date(Date.now() - (NO_SHOW_DISPUTE_HOURS + 1) * HOUR)}::timestamp WHERE "id" = ${longAgo.id}`;

    await expect(report({ reporterId: recent.id, targetType: "BOOKING", targetId: justNow.id, reason: "NO_SHOW_DISPUTE" })).resolves.toBeTruthy();
    expect((await failure(report({ reporterId: old.id, targetType: "BOOKING", targetId: longAgo.id, reason: "NO_SHOW_DISPUTE" }))).code).toBe("CONFLICT");
  });
});

describe("createReport — 수수료 이의제기", () => {
  it("그 예약을 받은 사업장의 대표·매니저만 신청할 수 있다", async () => {
    const { slot, business, owner } = await setup();
    const elsewhere = await setup();
    const [customer, manager, staff, stranger] = await Promise.all([createUser(), createUser(), createUser(), createUser()]);
    await addMember(business.id, manager.id, "MANAGER");
    await addMember(business.id, staff.id, "STAFF");
    const booking = await createBooking(slot, customer.id, "COMPLETED", { commissionRule: "MARKET_NEW", commissionBps: 990, commissionAmount: 2970 });
    const walkIn = await createBooking(slot, null, "COMPLETED", { channel: "MANUAL" });
    const base = { targetType: "BOOKING" as const, reason: "COMMISSION_DISPUTE" as const, detail: "직접 등록한 단골 고객인데 신규 고객 요율이 적용됐어요." };

    // 예약한 고객 본인, 관계없는 회원, 다른 사업장 대표: 예약이 있는지도 알려 주지 않는다
    for (const reporter of [customer, stranger, elsewhere.owner]) {
      const e = await failure(createReport({ ...base, reporterId: reporter.id, targetId: booking.id }));
      expect(e.code).toBe("NOT_FOUND");
    }
    // 스태프는 권한이 없다
    const byStaff = await failure(createReport({ ...base, reporterId: staff.id, targetId: booking.id }));
    expect(byStaff.code).toBe("FORBIDDEN");
    expect(byStaff.message).toContain("대표나 매니저");
    // 예약이 아닌 대상
    const wrongTarget = await failure(createReport({ ...base, reporterId: owner.id, targetType: "BUSINESS", targetId: business.id, bookingId: booking.id }));
    expect(wrongTarget.code).toBe("VALIDATION");
    expect((await failure(createReport({ ...base, reporterId: owner.id, targetId: "없는-예약" }))).code).toBe("NOT_FOUND");
    expect(await prisma.report.count()).toBe(0);

    const byOwner = await createReport({ ...base, reporterId: owner.id, targetId: booking.id });
    const byManager = await createReport({ ...base, reporterId: manager.id, targetId: booking.id });
    // 회원 없이 직접 입력한 예약도 대상이 된다
    const onWalkIn = await createReport({ ...base, reporterId: owner.id, targetId: walkIn.id });
    for (const [created, reporterId, bookingId] of [
      [byOwner, owner.id, booking.id],
      [byManager, manager.id, booking.id],
      [onWalkIn, owner.id, walkIn.id],
    ] as const) {
      expect(await prisma.report.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
        reporterId,
        targetType: "BOOKING",
        targetId: bookingId,
        bookingId,
        reason: "COMMISSION_DISPUTE",
        status: "OPEN",
      });
    }
    const logs = await prisma.auditLog.findMany({ where: { action: "report.create" } });
    expect(logs.map((l) => l.actorType)).toEqual(["SELLER", "SELLER", "SELLER"]);
  });
});

// ── 중복 · 한도 ───────────────────────────────────────

describe("createReport — 중복과 한도", () => {
  it("같은 대상·같은 사유로 처리 중인 내 신고가 있으면 다시 받지 않는다", async () => {
    const { business, product } = await setup();
    const [me, other] = await Promise.all([createUser(), createUser()]);
    const first = await report({ reporterId: me.id, targetType: "BUSINESS", targetId: business.id, reason: "FALSE_INFO" });

    const duplicate = await failure(report({ reporterId: me.id, targetType: "BUSINESS", targetId: business.id, reason: "FALSE_INFO", detail: "다른 말로 한 번 더 적어 봤어요." }));
    expect(duplicate.code).toBe("CONFLICT");
    await setStatus(first.id, "IN_REVIEW");
    expect((await failure(report({ reporterId: me.id, targetType: "BUSINESS", targetId: business.id, reason: "FALSE_INFO" }))).code).toBe("CONFLICT");

    // 사유가 다르거나, 대상이 다르거나, 다른 회원이면 받는다
    await expect(report({ reporterId: me.id, targetType: "BUSINESS", targetId: business.id, reason: "OFF_PLATFORM" })).resolves.toBeTruthy();
    await expect(report({ reporterId: me.id, targetType: "PRODUCT", targetId: product.id, reason: "FALSE_INFO" })).resolves.toBeTruthy();
    await expect(report({ reporterId: other.id, targetType: "BUSINESS", targetId: business.id, reason: "FALSE_INFO" })).resolves.toBeTruthy();

    // 처리가 끝난(완료·기각) 뒤에는 다시 접수할 수 있다(하루 한도와 무관한 확인이라 한도 기록은 비운다)
    await prisma.rateLimit.deleteMany();
    for (const status of ["RESOLVED", "DISMISSED"] as const) {
      const open = await prisma.report.findFirstOrThrow({
        where: { reporterId: me.id, targetType: "BUSINESS", targetId: business.id, reason: "FALSE_INFO", status: { in: ["OPEN", "IN_REVIEW"] } },
      });
      await setStatus(open.id, status);
      await expect(report({ reporterId: me.id, targetType: "BUSINESS", targetId: business.id, reason: "FALSE_INFO" })).resolves.toMatchObject({ status: "OPEN" });
    }
    expect(await prisma.report.count({ where: { reporterId: me.id, targetType: "BUSINESS", targetId: business.id, reason: "FALSE_INFO" } })).toBe(3);
  });

  it("같은 신고를 동시에 여러 번 보내도 한 건만 접수된다", async () => {
    const { business } = await setup();
    const me = await createUser();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => report({ reporterId: me.id, targetType: "BUSINESS", targetId: business.id, reason: "SAFETY" })),
    );
    const accepted = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) expect((r.reason as AppError).code).toBe("CONFLICT");
    expect(await prisma.report.count()).toBe(1);

    // 접수되지 않은 세 번은 하루 한도에 들어가지 않는다
    const counter = await prisma.rateLimit.findFirstOrThrow({ where: { key: `report:user:${me.id}` } });
    expect(counter.count).toBe(1);
  });

  it("하루에 정해진 건수까지만 접수하고, 접수되지 않은 시도는 건수에 넣지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-02T03:10:00Z"));
    const me = await createUser();
    const other = await createUser();
    const targets = [];
    for (let i = 0; i < REPORT_DAILY_LIMIT + 2; i++) targets.push((await setup()).business);

    // 실패하는 시도(없는 대상·중복·검증 오류)는 한도를 쓰지 않는다
    await report({ reporterId: me.id, targetType: "BUSINESS", targetId: targets[0]!.id });
    for (let i = 0; i < REPORT_DAILY_LIMIT + 1; i++) {
      expect((await failure(report({ reporterId: me.id, targetType: "BUSINESS", targetId: "없는-사업장" }))).code).toBe("NOT_FOUND");
      expect((await failure(report({ reporterId: me.id, targetType: "BUSINESS", targetId: targets[0]!.id }))).code).toBe("CONFLICT");
    }
    expect((await failure(report({ reporterId: me.id, targetType: "USER", targetId: me.id }))).code).toBe("VALIDATION");

    for (let i = 1; i < REPORT_DAILY_LIMIT; i++) {
      await expect(report({ reporterId: me.id, targetType: "BUSINESS", targetId: targets[i]!.id })).resolves.toMatchObject({ status: "OPEN" });
    }
    expect(await prisma.report.count({ where: { reporterId: me.id } })).toBe(REPORT_DAILY_LIMIT);

    const limited = await failure(report({ reporterId: me.id, targetType: "BUSINESS", targetId: targets[REPORT_DAILY_LIMIT]!.id }));
    expect(limited.code).toBe("RATE_LIMITED");
    expect(limited.message).toContain(`${REPORT_DAILY_LIMIT}건`);
    // 막힌 뒤에는 무엇을 보내도 접수되지 않는다
    expect((await failure(report({ reporterId: me.id, targetType: "BUSINESS", targetId: targets[REPORT_DAILY_LIMIT + 1]!.id }))).code).toBe("RATE_LIMITED");
    expect(await prisma.report.count({ where: { reporterId: me.id } })).toBe(REPORT_DAILY_LIMIT);

    // 다른 회원은 영향을 받지 않고, 다음 날에는 다시 접수할 수 있다
    await expect(report({ reporterId: other.id, targetType: "BUSINESS", targetId: targets[0]!.id })).resolves.toBeTruthy();
    vi.setSystemTime(new Date("2026-12-03T03:10:00Z"));
    await expect(report({ reporterId: me.id, targetType: "BUSINESS", targetId: targets[REPORT_DAILY_LIMIT]!.id })).resolves.toBeTruthy();
  });

  it("접수되지 않는 시도를 계속 되풀이하면 잠시 막는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-02T03:10:00Z"));
    const { business } = await setup();
    const me = await createUser();
    for (let i = 0; i < REPORT_ATTEMPT_HOURLY_LIMIT; i++) {
      expect((await failure(report({ reporterId: me.id, targetType: "BOOKING", targetId: `추측-${i}` }))).code).toBe("NOT_FOUND");
    }
    expect((await failure(report({ reporterId: me.id, targetType: "BUSINESS", targetId: business.id }))).code).toBe("RATE_LIMITED");
    expect(await prisma.report.count()).toBe(0);
    vi.setSystemTime(new Date("2026-12-02T04:10:00Z"));
    await expect(report({ reporterId: me.id, targetType: "BUSINESS", targetId: business.id })).resolves.toBeTruthy();
  });
});

// ── 신고자 보호 · 내 신고 내역 ────────────────────────

describe("신고자 보호와 listMyReports", () => {
  it("신고 대상에게는 어떤 알림도 가지 않는다", async () => {
    const { business, product, slot, owner } = await setup();
    const [me, target] = await Promise.all([createUser(), createUser()]);
    const noShow = await createBooking(slot, me.id, "NO_SHOW", { noShowAt: new Date() });
    await report({ reporterId: me.id, targetType: "BUSINESS", targetId: business.id });
    await report({ reporterId: me.id, targetType: "PRODUCT", targetId: product.id });
    await report({ reporterId: me.id, targetType: "USER", targetId: target.id, reason: "INAPPROPRIATE" });
    await report({ reporterId: me.id, targetType: "BOOKING", targetId: noShow.id, reason: "NO_SHOW_DISPUTE" });

    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.messageOutbox.count()).toBe(0);
    // 신고당한 쪽이 볼 수 있는 내역에는 아무것도 없다
    expect(await listMyReports(owner.id)).toEqual([]);
    expect(await listMyReports(target.id)).toEqual([]);
  });

  it("내가 접수한 신고를 최신순으로, 처리 상태·결과와 함께 준다(처리한 운영자는 담지 않는다)", async () => {
    const { business, product, slot, owner } = await setup();
    const admin = await createUser({ adminRole: "CS", name: "운영자김" });
    const [me, someone] = await Promise.all([createUser(), createUser({ name: "홍길동" })]);
    const mine = await createBooking(slot, me.id, "CANCELLED");
    const customerBooking = await createBooking(slot, someone.id, "COMPLETED");

    const onBusiness = await report({ reporterId: me.id, targetType: "BUSINESS", targetId: business.id, bookingId: mine.id, reason: "REFUND_DISPUTE" });
    const onProduct = await report({ reporterId: me.id, targetType: "PRODUCT", targetId: product.id, reason: "FAKE_VACANCY" });
    const onUser = await report({ reporterId: me.id, targetType: "USER", targetId: someone.id, reason: "INAPPROPRIATE" });
    const onBooking = await report({ reporterId: me.id, targetType: "BOOKING", targetId: mine.id, reason: "NO_SERVICE" });
    const sellerDispute = await createReport({
      reporterId: owner.id,
      targetType: "BOOKING",
      targetId: customerBooking.id,
      reason: "COMMISSION_DISPUTE",
      detail: "직접 등록한 단골 고객이에요. 요율을 다시 봐 주세요.",
    });
    const base = Date.now();
    for (const [i, r] of [onBusiness, onProduct, onUser, onBooking].entries()) {
      await prisma.report.update({ where: { id: r.id }, data: { createdAt: new Date(base - (10 - i) * MINUTE) } });
    }
    const handledAt = new Date(base - MINUTE);
    await prisma.report.update({
      where: { id: onBusiness.id },
      data: { status: "RESOLVED", resolution: "환불 기준에 따라 50%를 환불했어요.", handledById: admin.id, handledAt },
    });
    await setStatus(onProduct.id, "IN_REVIEW");
    await prisma.report.update({ where: { id: onUser.id }, data: { status: "DISMISSED", resolution: "확인할 수 있는 근거가 없었어요.", handledById: admin.id, handledAt } });

    const list = await listMyReports(me.id);
    expect(list.map((r) => r.id)).toEqual([onBooking.id, onUser.id, onProduct.id, onBusiness.id]);
    expect(list[3]).toEqual({
      id: onBusiness.id,
      targetType: "BUSINESS",
      targetId: business.id,
      targetLabel: "연결고리 라운지",
      bookingCode: mine.code,
      reason: "REFUND_DISPUTE",
      detail: DETAIL,
      status: "RESOLVED",
      resolution: "환불 기준에 따라 50%를 환불했어요.",
      handledAt,
      createdAt: new Date(base - 10 * MINUTE),
    });
    expect(list[2]).toMatchObject({ targetLabel: "와인 로테이션 소개팅", status: "IN_REVIEW", resolution: null, handledAt: null, bookingCode: null });
    // 신고한 회원의 이름은 가려서 보여 준다
    expect(list[1]).toMatchObject({ targetLabel: maskName("홍길동"), status: "DISMISSED", resolution: "확인할 수 있는 근거가 없었어요." });
    expect(list[0]).toMatchObject({ targetType: "BOOKING", targetLabel: mine.code, bookingCode: mine.code, status: "OPEN" });

    // 처리한 운영자가 누구인지, 신고자 ID 같은 값은 없다
    const keys = collectKeys(list);
    for (const key of ["handledById", "handledBy", "reporterId", "reporter", "bookingId", "guestPhone", "email"]) expect(keys.has(key), key).toBe(false);
    expect(JSON.stringify(list)).not.toContain("운영자김");
    expect(JSON.stringify(list)).not.toContain("홍길동");

    // 사업자의 수수료 이의제기: 대상 예약번호는 보이지만, 남의 예약이라 bookingCode 로는 주지 않는다
    expect(await listMyReports(owner.id)).toEqual([
      expect.objectContaining({ id: sellerDispute.id, reason: "COMMISSION_DISPUTE", targetLabel: customerBooking.code, bookingCode: null, status: "OPEN" }),
    ]);
    // 남의 신고는 섞이지 않는다
    expect(await listMyReports(someone.id)).toEqual([]);
  });

  it("신고한 뒤 대상이 지워져도 내역은 남는다", async () => {
    const { product } = await setup();
    const me = await createUser();
    const gone = await createProduct(product.businessId, product.categoryId, { title: "곧 지워질 상품" });
    const created = await report({ reporterId: me.id, targetType: "PRODUCT", targetId: gone.id });
    await prisma.product.delete({ where: { id: gone.id } });

    expect(await listMyReports(me.id)).toEqual([expect.objectContaining({ id: created.id, targetId: gone.id, targetLabel: null, status: "OPEN" })]);
  });
});
