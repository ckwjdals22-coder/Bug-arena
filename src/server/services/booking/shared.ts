import "server-only";
import { z } from "zod";
import {
  Prisma,
  type ActorType,
  type AdminRole,
  type Booking,
  type BookingChannel,
  type BookingStatus,
  type PaymentMethod,
  type PaymentPolicy,
  type PaymentState,
} from "@/generated/prisma/client";
import { normalizePhone } from "@/lib/format";
import { MINUTE } from "@/lib/time";
import { audit } from "@/server/audit";
import { prisma } from "@/server/db";
import { AppError, err, toActionError } from "@/server/errors";
import { getPaymentForBooking, refundPayment } from "@/server/services/payments";

/**
 * 예약 엔진 공용 도구 — 트랜잭션 실행, 입력 검증, 금액 계산, 환불 실행.
 * 예약 엔진의 다른 파일(booking/*.ts)과 회차 서비스(slots.ts)만 가져다 쓴다.
 */

export type Tx = Prisma.TransactionClient;

/**
 * 예약 트랜잭션 옵션. 예약이 몰리면 연결 풀을 기다리는 시간이 길어지므로 기본값(2초·5초)보다 넉넉히 준다.
 * 트랜잭션 안에서는 tx 만 쓰고, 운영 설정처럼 다른 연결이 필요한 값은 트랜잭션을 열기 전에 읽어 둔다.
 */
const TX_OPTIONS = { maxWait: 15_000, timeout: 30_000 } as const;

export function runTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, TX_OPTIONS);
}

/** 같은 키의 작업을 트랜잭션 단위로 줄 세운다. */
export const lockKey = (tx: Tx, key: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

export const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** zod 검증 실패를 필드별 메시지를 담은 VALIDATION 오류로 바꾼다. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const { error } = toActionError(parsed.error);
  throw new AppError("VALIDATION", error.message, error.fieldErrors);
}

/** 후속 처리(알림·CRM·빈자리 안내)를 감싼다. 실패해도 이미 끝난 본 작업을 깨뜨리지 않고 로그만 남긴다. */
export async function safely(label: string, id: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    console.error(`[booking] ${label} 실패 id=${id}`, e);
  }
}

// ── 공통 상수 ─────────────────────────────────────────

/** 결제 승인을 요청하는 동안 홀드를 늘려 두는 시간(승인 요청은 최대 45초쯤 걸린다) */
export const PAYMENT_HOLD_EXTENSION_MS = 3 * MINUTE;
/** 한 회원이 동시에 가질 수 있는 결제 대기 예약 수 */
export const MAX_PENDING_PAYMENTS = 3;
/** 한 번의 주기 작업에서 처리하는 최대 건수(남은 건은 다음 실행에서 이어 간다) */
export const JOB_BATCH = 200;
/** 예약 건별 좌석 수 상한(DB 제약: 상품 maxPerBooking 은 20 이하) */
export const MAX_QUANTITY = 20;

export const MSG_BOOKING_NOT_FOUND = "예약을 찾을 수 없어요.";
export const MSG_STATE_CHANGED = "예약 상태가 바뀌었어요. 새로고침한 뒤 다시 확인해 주세요.";

// ── 입력 스키마 ───────────────────────────────────────

const SINGLE_LINE = /^[^\p{Cc}]*$/u;

export const idSchema = z.string("대상을 다시 골라 주세요.").min(1, "대상을 다시 골라 주세요.").max(64, "대상을 다시 골라 주세요.");

export const guestNameSchema = z
  .string("예약자 이름을 입력해 주세요.")
  .trim()
  .min(1, "예약자 이름을 입력해 주세요.")
  .max(30, "예약자 이름은 30자까지 쓸 수 있어요.")
  .regex(SINGLE_LINE, "예약자 이름에 쓸 수 없는 문자가 있어요.");

export const guestPhoneSchema = z
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

export const quantitySchema = z
  .number("인원을 숫자로 입력해 주세요.")
  .int("인원은 정수로 입력해 주세요.")
  .min(1, "인원은 1명 이상이어야 해요.")
  .max(MAX_QUANTITY, `한 번에 ${MAX_QUANTITY}명까지 예약할 수 있어요.`);

/** 선택 입력 글: 비어 있으면 null */
export const optionalText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, tooLong)
    .nullish()
    .transform((value) => value || null);

export const reasonSchema = (max = 200) =>
  z.string("사유를 입력해 주세요.").trim().min(1, "사유를 입력해 주세요.").max(max, `사유는 ${max}자까지 쓸 수 있어요.`);

// ── 금액 ──────────────────────────────────────────────

export interface BookingAmounts {
  totalAmount: number;
  /** 지금 온라인으로 결제할 금액 */
  payNowAmount: number;
  /** 현장에서 낼 금액 */
  payOnsiteAmount: number;
  paymentMethod: PaymentMethod;
}

/**
 * 결제 금액 계산. 고객이 내는 돈은 정확히 totalAmount 이고 고객 수수료는 없다.
 * - 합계 0원 → FREE
 * - 현장 결제 상품 → ONSITE
 * - 그 밖 → ONLINE. 예약금 결제 상품은 min(예약금 × 인원, 합계)만 지금 결제하고 나머지는 현장에서 낸다.
 *   (예약금이 0원이라 지금 낼 돈이 없으면 현장 결제로 본다.)
 */
export function computeAmounts(
  product: { paymentPolicy: PaymentPolicy; depositAmount: number | null },
  unitPrice: number,
  quantity: number,
): BookingAmounts {
  const totalAmount = unitPrice * quantity;
  if (totalAmount === 0) return { totalAmount, payNowAmount: 0, payOnsiteAmount: 0, paymentMethod: "FREE" };
  if (product.paymentPolicy === "ONSITE") return { totalAmount, payNowAmount: 0, payOnsiteAmount: totalAmount, paymentMethod: "ONSITE" };
  const payNowAmount = product.paymentPolicy === "DEPOSIT" ? Math.min(Math.max(0, product.depositAmount ?? 0) * quantity, totalAmount) : totalAmount;
  if (payNowAmount === 0) return { totalAmount, payNowAmount: 0, payOnsiteAmount: totalAmount, paymentMethod: "ONSITE" };
  return { totalAmount, payNowAmount, payOnsiteAmount: totalAmount - payNowAmount, paymentMethod: "ONLINE" };
}

/** 온라인으로 실제 결제가 끝난 예약인지(환불할 돈이 있는지) */
export const isPaidOnline = (booking: { paymentMethod: PaymentMethod; paymentState: PaymentState; payNowAmount: number }) =>
  booking.paymentMethod === "ONLINE" && booking.paymentState !== "UNPAID" && booking.payNowAmount > 0;

// ── 고객에게 돌려주는 예약 요약 ───────────────────────

/** 예약 생성·결제 결과로 돌려주는 값. 체크인 토큰·사업자 메모·수수료 같은 내부 값은 담지 않는다. */
export interface BookingSummary {
  id: string;
  code: string;
  status: BookingStatus;
  slotId: string;
  slotSeatId: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  payNowAmount: number;
  payOnsiteAmount: number;
  paymentMethod: PaymentMethod;
  paymentState: PaymentState;
  channel: BookingChannel;
  /** 결제 대기 중일 때 좌석을 잡아 두는 기한 */
  holdExpiresAt: Date | null;
  confirmedAt: Date | null;
  createdAt: Date;
}

export function toBookingSummary(b: Booking): BookingSummary {
  return {
    id: b.id,
    code: b.code,
    status: b.status,
    slotId: b.slotId,
    slotSeatId: b.slotSeatId,
    quantity: b.quantity,
    unitPrice: b.unitPrice,
    totalAmount: b.totalAmount,
    payNowAmount: b.payNowAmount,
    payOnsiteAmount: b.payOnsiteAmount,
    paymentMethod: b.paymentMethod,
    paymentState: b.paymentState,
    channel: b.channel,
    holdExpiresAt: b.holdExpiresAt,
    confirmedAt: b.confirmedAt,
    createdAt: b.createdAt,
  };
}

// ── 운영자 권한 ───────────────────────────────────────

export interface AdminActor {
  id: string;
  role: AdminRole;
}

/** 운영자 역할 확인. 넘겨받은 역할을 그대로 믿지 않고 계정의 현재 역할·상태를 다시 읽는다. SUPER 는 항상 통과. */
export async function assertAdminRole(admin: AdminActor, allowed: AdminRole[]): Promise<void> {
  const parsed = z.object({ id: idSchema, role: z.enum(["SUPER", "OPS", "CS", "FINANCE"]) }).safeParse(admin);
  if (!parsed.success) throw err.forbidden();
  const user = await prisma.user.findUnique({ where: { id: parsed.data.id }, select: { status: true, adminRole: true } });
  if (!user || user.status !== "ACTIVE" || !user.adminRole || user.adminRole !== parsed.data.role) throw err.forbidden();
  if (user.adminRole !== "SUPER" && !allowed.includes(user.adminRole)) throw err.forbidden();
}

// ── 환불 ──────────────────────────────────────────────

export interface RefundOutcome {
  /** NONE 환불할 금액 없음 · DONE 결제사 환불 완료 · FAILED 환불 실패(운영자 콘솔에서 재시도) */
  status: "NONE" | "DONE" | "FAILED";
  amount: number;
  refundId: string | null;
}

/**
 * 예약의 결제 상태(paymentState)를 결제 행의 실제 취소 금액에 맞춘다.
 * 환불이 끝난 뒤(예약 엔진의 환불, 운영자의 환불 재시도 뒤)에 부른다.
 */
export async function syncBookingPaymentState(bookingId: string): Promise<PaymentState | null> {
  const payment = await getPaymentForBooking(bookingId);
  if (!payment || payment.approvedAt === null) return null;
  const state: PaymentState | null =
    payment.status === "PAID" ? "PAID" : payment.status === "PARTIAL_CANCELLED" ? "PARTIALLY_REFUNDED" : payment.status === "CANCELLED" ? "REFUNDED" : null;
  if (!state) return null;
  await prisma.booking.updateMany({ where: { id: bookingId, paymentState: { not: state } }, data: { paymentState: state } });
  return state;
}

/**
 * 트랜잭션이 끝난 뒤 결제사 환불을 실행한다. 어떤 경우에도 예외를 던지지 않는다.
 * - 환불이 끝나면(DONE) 예약의 결제 상태를 환불 완료·부분 환불로 맞춘다.
 * - 실패하면 결제 상태를 그대로 두고(환불 행은 FAILED 로 남아 운영자 콘솔에 보인다) 감사 로그에 남긴다.
 */
export async function refundBookingPayment(input: {
  bookingId: string;
  amount: number;
  reason: string;
  requestedBy: ActorType;
  requestedById?: string | null;
}): Promise<RefundOutcome> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) return { status: "NONE", amount: 0, refundId: null };
  try {
    const refund = await refundPayment(input);
    if (refund?.status === "DONE") {
      await syncBookingPaymentState(input.bookingId);
      return { status: "DONE", amount: input.amount, refundId: refund.id };
    }
    if (refund) return { status: "FAILED", amount: input.amount, refundId: refund.id };
    // 환불할 금액이 있는데 승인된 결제를 찾지 못했다: 기록이 어긋난 것이므로 운영자가 볼 수 있게 남긴다.
    await recordRefundProblem(input, "승인된 결제를 찾지 못했어요.");
  } catch (e) {
    console.error(`[booking] 환불 요청 실패 id=${input.bookingId}`, e);
    await recordRefundProblem(input, e instanceof AppError ? e.message : "환불을 요청하지 못했어요.");
  }
  return { status: "FAILED", amount: input.amount, refundId: null };
}

async function recordRefundProblem(input: { bookingId: string; amount: number; requestedBy: ActorType }, detail: string): Promise<void> {
  await audit({
    actorType: "SYSTEM",
    action: "booking.refund_error",
    targetType: "Booking",
    targetId: input.bookingId,
    meta: { amount: input.amount, requestedBy: input.requestedBy, detail: detail.slice(0, 200) },
  });
}
