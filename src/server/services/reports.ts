import "server-only";
import { z } from "zod";
import type { Prisma, ReportReason, ReportStatus, ReportTargetType } from "@/generated/prisma/client";
import { maskName } from "@/lib/format";
import { HOUR } from "@/lib/time";
import { audit } from "@/server/audit";
import { assertBusinessAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { AppError, err, toActionError } from "@/server/errors";
import { enforceRateLimit, refundRateLimit } from "@/server/security/rate-limit";

/**
 * 신고·이의제기 접수.
 * - 신고 대상에게는 누가 신고했는지 알리지 않는다(이 모듈은 대상에게 어떤 알림도 보내지 않는다).
 * - 예약이 얽힌 신고는 신고자가 그 예약의 당사자(예약한 본인 또는 그 사업장 구성원)일 때만 받는다.
 * - 접수된 신고의 검토·처리는 운영자 모듈이 맡는다.
 */

export const REPORT_TARGET_TYPES = ["BUSINESS", "PRODUCT", "REVIEW", "USER", "BOOKING"] as const satisfies readonly ReportTargetType[];
export const REPORT_REASONS = [
  "FALSE_INFO",
  "FAKE_VACANCY",
  "NO_SERVICE",
  "REFUND_DISPUTE",
  "OFF_PLATFORM",
  "INAPPROPRIATE",
  "SAFETY",
  "NO_SHOW_DISPUTE",
  "COMMISSION_DISPUTE",
  "OTHER",
] as const satisfies readonly ReportReason[];

/** 회원 한 명이 하루에 접수할 수 있는 신고 건수 */
export const REPORT_DAILY_LIMIT = 5;
/** 노쇼 처리 후 이의제기할 수 있는 시간(docs 6.8) */
export const NO_SHOW_DISPUTE_HOURS = 72;
export const REPORT_DETAIL_MIN = 10;
export const REPORT_DETAIL_MAX = 1000;

const DAY_SEC = 86_400;
const BOOKING_NOT_FOUND = "예약을 찾을 수 없어요.";

type Tx = Prisma.TransactionClient;

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const { error } = toActionError(parsed.error);
  throw new AppError("VALIDATION", error.message, error.fieldErrors);
}

const idSchema = z.string().min(1, "대상을 다시 골라 주세요.").max(64, "대상을 다시 골라 주세요.");

const createSchema = z.object({
  reporterId: idSchema,
  targetType: z.enum(REPORT_TARGET_TYPES, "신고 대상을 다시 골라 주세요."),
  targetId: idSchema,
  bookingId: idSchema.optional(),
  reason: z.enum(REPORT_REASONS, "신고 사유를 골라 주세요."),
  detail: z
    .string({ error: "신고 내용을 적어 주세요." })
    .trim()
    .min(REPORT_DETAIL_MIN, `신고 내용은 ${REPORT_DETAIL_MIN}자 이상 적어 주세요.`)
    .max(REPORT_DETAIL_MAX, `신고 내용은 ${REPORT_DETAIL_MAX}자까지 쓸 수 있어요.`),
});

export type CreateReportInput = z.input<typeof createSchema>;

export interface CreatedReport {
  id: string;
  status: ReportStatus;
  createdAt: Date;
}

const lockKey = (tx: Tx, key: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

const bookingSelect = { id: true, userId: true, businessId: true, status: true, noShowAt: true, updatedAt: true } satisfies Prisma.BookingSelect;
type ReportBooking = Prisma.BookingGetPayload<{ select: typeof bookingSelect }>;

async function isBusinessMember(userId: string, businessId: string): Promise<boolean> {
  const member = await prisma.businessMember.findUnique({
    where: { businessId_userId: { businessId, userId } },
    select: { id: true },
  });
  return member !== null;
}

/** 신고 대상이 실제로 있는지 확인한다(예약 대상은 따로 당사자 확인을 거친다). */
async function assertTargetExists(targetType: Exclude<ReportTargetType, "BOOKING">, targetId: string, reporterId: string): Promise<void> {
  if (targetType === "USER") {
    if (targetId === reporterId) throw err.validation("본인은 신고할 수 없어요.");
    const user = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!user) throw err.notFound("신고할 회원을 찾을 수 없어요.");
    return;
  }
  const found =
    targetType === "BUSINESS"
      ? await prisma.business.findUnique({ where: { id: targetId }, select: { id: true } })
      : targetType === "PRODUCT"
        ? await prisma.product.findUnique({ where: { id: targetId }, select: { id: true } })
        : await prisma.review.findUnique({ where: { id: targetId }, select: { id: true } });
  if (!found) throw err.notFound("신고할 대상을 찾을 수 없어요.");
}

/**
 * 신고와 얽힌 예약을 확인해 돌려준다. 예약이 얽히지 않은 신고면 null.
 * 당사자가 아닌 예약은 있는지조차 알려 주지 않는다(없는 예약과 같은 오류).
 */
async function resolveBooking(data: z.output<typeof createSchema>): Promise<ReportBooking | null> {
  const { reporterId, targetType, targetId, reason } = data;
  const bookingId = targetType === "BOOKING" ? targetId : data.bookingId;
  if (targetType === "BOOKING" && data.bookingId && data.bookingId !== targetId) {
    throw err.validation("신고할 예약을 다시 골라 주세요.", { bookingId: "신고 대상과 같은 예약이어야 해요." });
  }

  if (reason === "NO_SHOW_DISPUTE" && targetType !== "BOOKING") {
    throw err.validation("노쇼 이의제기는 노쇼 처리된 예약에서 신청해 주세요.", { targetType: "예약을 골라 주세요." });
  }
  if (reason === "COMMISSION_DISPUTE" && targetType !== "BOOKING") {
    throw err.validation("수수료 이의제기는 정산 내역의 예약에서 신청해 주세요.", { targetType: "예약을 골라 주세요." });
  }
  if (!bookingId) {
    if (reason === "REFUND_DISPUTE") {
      throw err.validation("환불 분쟁은 어떤 예약인지 골라 주세요.", { bookingId: "예약을 골라 주세요." });
    }
    return null;
  }

  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: bookingSelect });
  if (!booking) throw err.notFound(BOOKING_NOT_FOUND);
  const isOwner = booking.userId === reporterId;

  if (reason === "COMMISSION_DISPUTE") {
    // 수수료 판정 이의제기는 그 사업장의 대표·매니저만 할 수 있다.
    if (!(await isBusinessMember(reporterId, booking.businessId))) throw err.notFound(BOOKING_NOT_FOUND);
    await assertBusinessAccess(reporterId, booking.businessId, "MANAGER");
    return booking;
  }

  if (targetType === "BOOKING" || reason === "REFUND_DISPUTE") {
    if (!isOwner) throw err.notFound(BOOKING_NOT_FOUND);
  } else if (!isOwner && !(await isBusinessMember(reporterId, booking.businessId))) {
    // 참고로 붙이는 예약도 본인 예약이거나 본인 사업장의 예약이어야 한다.
    throw err.notFound(BOOKING_NOT_FOUND);
  }

  if (reason === "NO_SHOW_DISPUTE") {
    if (booking.status !== "NO_SHOW") throw err.conflict("노쇼로 처리된 예약에만 이의제기할 수 있어요.");
    const noShowAt = booking.noShowAt ?? booking.updatedAt;
    if (Date.now() - noShowAt.getTime() > NO_SHOW_DISPUTE_HOURS * HOUR) {
      throw err.conflict(`노쇼 처리 후 ${NO_SHOW_DISPUTE_HOURS}시간 안에만 이의제기할 수 있어요.`);
    }
  }
  return booking;
}

/**
 * 신고·이의제기를 접수한다.
 * - 대상이 실제로 있어야 하고, 같은 대상·같은 사유로 처리 중(접수·검토 중)인 내 신고가 있으면 다시 받지 않는다.
 * - 하루 REPORT_DAILY_LIMIT 건까지 접수할 수 있다(접수되지 않은 시도는 건수에 넣지 않는다).
 */
export async function createReport(input: CreateReportInput): Promise<CreatedReport> {
  const data = parseInput(createSchema, input);
  // 대상 확인을 되풀이해 시도하는 것을 막는 한도(실패한 시도도 센다)
  await enforceRateLimit(`report-attempt:user:${data.reporterId}`, 30, 3600);
  const limitKey = `report:user:${data.reporterId}`;
  const countedAt = Date.now();
  await enforceRateLimit(
    limitKey,
    REPORT_DAILY_LIMIT,
    DAY_SEC,
    `신고는 하루 ${REPORT_DAILY_LIMIT}건까지 접수할 수 있어요. 급한 일은 고객센터로 알려 주세요.`,
  );

  let report: CreatedReport;
  try {
    const booking = await resolveBooking(data);
    if (data.targetType !== "BOOKING") await assertTargetExists(data.targetType, data.targetId, data.reporterId);

    report = await prisma.$transaction(async (tx) => {
      // 같은 신고를 동시에 두 번 보내도 한 건만 접수되도록 줄 세운다.
      await lockKey(tx, `report:${data.reporterId}:${data.targetType}:${data.targetId}:${data.reason}`);
      const pending = await tx.report.findFirst({
        where: {
          reporterId: data.reporterId,
          targetType: data.targetType,
          targetId: data.targetId,
          reason: data.reason,
          status: { in: ["OPEN", "IN_REVIEW"] },
        },
        select: { id: true },
      });
      if (pending) throw err.conflict("같은 내용으로 접수한 신고를 처리하고 있어요. 진행 상황은 마이 > 신고 내역에서 볼 수 있어요.");
      return tx.report.create({
        data: {
          reporterId: data.reporterId,
          targetType: data.targetType,
          targetId: data.targetId,
          bookingId: booking?.id ?? null,
          reason: data.reason,
          detail: data.detail,
        },
        select: { id: true, status: true, createdAt: true },
      });
    });
  } catch (e) {
    // 접수되지 않은 시도는 하루 건수에서 뺀다. 되돌리지 못해도 원래 오류를 그대로 알린다.
    await refundRateLimit(limitKey, DAY_SEC, countedAt).catch((refundError) => {
      console.error("[reports] 신고 한도 되돌리기 실패", refundError);
    });
    throw e;
  }

  await audit({
    actorId: data.reporterId,
    actorType: data.reason === "COMMISSION_DISPUTE" ? "SELLER" : "CUSTOMER",
    action: "report.create",
    targetType: "Report",
    targetId: report.id,
    meta: { targetType: data.targetType, targetId: data.targetId, reason: data.reason },
  });
  return report;
}

export interface MyReport {
  id: string;
  targetType: ReportTargetType;
  targetId: string;
  /** 대상을 알아볼 수 있는 이름(사업장 이름, 상품 제목, 예약번호, 가린 회원 이름). 대상이 지워졌으면 null */
  targetLabel: string | null;
  /** 얽힌 예약의 예약번호(본인 예약일 때만) */
  bookingCode: string | null;
  reason: ReportReason;
  detail: string;
  status: ReportStatus;
  /** 운영자가 남긴 처리 결과 */
  resolution: string | null;
  handledAt: Date | null;
  createdAt: Date;
}

/** 내가 접수한 신고(최신순)와 처리 상태·결과. 처리한 운영자가 누구인지는 담지 않는다. */
export async function listMyReports(userId: string): Promise<MyReport[]> {
  const reporterId = parseInput(idSchema, userId);
  const rows = await prisma.report.findMany({
    where: { reporterId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    select: {
      id: true,
      targetType: true,
      targetId: true,
      bookingId: true,
      reason: true,
      detail: true,
      status: true,
      resolution: true,
      handledAt: true,
      createdAt: true,
    },
  });
  if (rows.length === 0) return [];

  const idsOf = (type: ReportTargetType) => [...new Set(rows.filter((r) => r.targetType === type).map((r) => r.targetId))];
  const bookingIds = [...new Set([...idsOf("BOOKING"), ...rows.flatMap((r) => (r.bookingId ? [r.bookingId] : []))])];
  const [businesses, products, reviews, users, bookings] = await Promise.all([
    prisma.business.findMany({ where: { id: { in: idsOf("BUSINESS") } }, select: { id: true, name: true } }),
    prisma.product.findMany({ where: { id: { in: idsOf("PRODUCT") } }, select: { id: true, title: true } }),
    prisma.review.findMany({ where: { id: { in: idsOf("REVIEW") } }, select: { id: true, product: { select: { title: true } } } }),
    prisma.user.findMany({ where: { id: { in: idsOf("USER") } }, select: { id: true, name: true } }),
    prisma.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, code: true, userId: true } }),
  ]);
  const labels: Record<ReportTargetType, Map<string, string>> = {
    BUSINESS: new Map(businesses.map((b) => [b.id, b.name])),
    PRODUCT: new Map(products.map((p) => [p.id, p.title])),
    REVIEW: new Map(reviews.map((r) => [r.id, `${r.product.title} 후기`])),
    USER: new Map(users.map((u) => [u.id, maskName(u.name)])),
    BOOKING: new Map(bookings.map((b) => [b.id, b.code])),
  };
  const ownCodes = new Map(bookings.filter((b) => b.userId === reporterId).map((b) => [b.id, b.code]));

  return rows.map((row) => ({
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    targetLabel: labels[row.targetType].get(row.targetId) ?? null,
    bookingCode: row.bookingId ? (ownCodes.get(row.bookingId) ?? null) : null,
    reason: row.reason,
    detail: row.detail,
    status: row.status,
    resolution: row.resolution,
    handledAt: row.handledAt,
    createdAt: row.createdAt,
  }));
}
