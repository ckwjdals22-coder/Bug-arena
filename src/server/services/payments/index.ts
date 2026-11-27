import "server-only";
import { z } from "zod";
import { Prisma, type ActorType, type AdminRole, type Payment, type Refund } from "@/generated/prisma/client";
import { newOrderId, newToken } from "@/lib/ids";
import { formatKRW } from "@/lib/money";
import { MINUTE } from "@/lib/time";
import { audit } from "@/server/audit";
import { prisma } from "@/server/db";
import { AppError, err } from "@/server/errors";
import {
  PaymentProviderError,
  assertPaymentConfigured,
  currentProviderName,
  getPaymentProviderByName,
  type ProviderCancelResult,
  type ProviderPaymentState,
} from "./provider";

export { newMockPaymentKey } from "./mock";
export {
  PaymentProviderError,
  assertPaymentConfigured,
  getPaymentClientConfig,
  getPaymentProvider,
  type PaymentClientConfig,
  type PaymentProviderAdapter,
} from "./provider";

/**
 * 결제·환불 상태 서비스. Payment·Refund 행과 PG 통신을 모두 여기서만 다룬다.
 *
 * Payment 상태
 *   READY ─ 승인 ─▶ PAID ─ 부분 환불 ─▶ PARTIAL_CANCELLED ─ 잔액 환불 ─▶ CANCELLED
 *     ├ 거절·금액 불일치 ─▶ FAILED
 *     └ 홀드 만료(결제 없이) ─▶ CANCELLED
 *
 * READY 행의 세부 상태(열 조합으로 표현)
 *   - paymentKey = null, failCode = null : 아직 PG 에 승인을 요청한 적 없음
 *   - paymentKey 있음                    : 어떤 요청이 점유하고 PG 승인을 진행 중
 *   - paymentKey = null, failCode = CONFIRM_UNKNOWN : 승인 결과를 확인하지 못해 점유를 푼 상태(대사 대상)
 *
 * PG 를 부르는 함수(confirmPayment·refundPayment·retryRefund·reconcilePayment)는 DB 트랜잭션 밖에서 호출해야 한다.
 */

const MAX_AMOUNT = 1_000_000_000;
/** 승인 요청(30초)과 조회(15초)를 합친 것보다 넉넉한 시간. 이보다 오래된 점유는 요청이 죽은 것으로 본다. */
const CLAIM_STALE_MS = 2 * MINUTE;
/** 같은 결제를 다른 요청이 승인하고 있을 때 결과를 기다려 주는 시간 */
const CONFIRM_WAIT_MS = 10_000;
const CONFIRM_POLL_MS = 250;
/** 이보다 오래 REQUESTED 로 남은 환불은 처리 중에 끊긴 것으로 보고 재시도 대상에 넣는다. */
const REFUND_STALE_MS = 10 * MINUTE;
const UNKNOWN_OUTCOME = "CONFIRM_UNKNOWN";

const MSG_AMOUNT_MISMATCH = "결제 금액이 주문 금액과 달라요.";
const MSG_DELAYED = "결제 확인이 지연되고 있어요. 잠시 후 다시 시도해 주세요.";
const MSG_NOT_FOUND = "결제 정보를 찾을 수 없어요.";
const MSG_CHECKING = "결제를 확인하고 있어요. 잠시 후 예약 내역에서 결과를 확인해 주세요.";

const idSchema = z.string().min(1).max(64);
const orderIdSchema = z.string().regex(/^[A-Za-z0-9_=-]{6,64}$/, "주문번호 형식이 올바르지 않아요.");
const paymentKeySchema = z.string().min(1, "결제 정보가 올바르지 않아요.").max(200, "결제 정보가 올바르지 않아요.");

type Db = Prisma.TransactionClient;

const isPaid = (payment: Pick<Payment, "status">) => payment.status === "PAID" || payment.status === "PARTIAL_CANCELLED";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return Prisma.DbNull;
  }
}

/** PG 오류는 코드만, 그 밖의 예외는 원인까지 남긴다(키·토큰은 오류 객체에 담기지 않는다). */
function logIssue(context: string, orderId: string, e: unknown): void {
  if (e instanceof PaymentProviderError) console.error(`[payments] ${context}`, orderId, e.code);
  else console.error(`[payments] ${context}`, orderId, e);
}

/** 결제 행을 잠그고 최신 금액을 읽는다(같은 결제에 대한 환불 계산을 직렬화). */
async function lockPayment(tx: Db, paymentId: string): Promise<{ amount: number; cancelledAmount: number }> {
  const rows = await tx.$queryRaw<{ amount: number; cancelledAmount: number }[]>`
    SELECT "amount", "cancelledAmount" FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw err.notFound(MSG_NOT_FOUND);
  return row;
}

// ── 주문 생성 ─────────────────────────────────────────

const orderSchema = z.object({
  bookingId: idSchema,
  amount: z.number().int("결제 금액은 원 단위 정수여야 해요.").min(1, "결제 금액은 1원 이상이어야 해요.").max(MAX_AMOUNT, "결제할 수 있는 금액을 넘었어요."),
});

/**
 * 예약과 같은 트랜잭션 안에서 결제 주문(READY)을 만든다.
 * 금액은 호출자(예약 엔진)가 DB 값으로 계산한 값이어야 한다.
 */
export async function createPaymentOrder(tx: Db, input: { bookingId: string; amount: number }): Promise<Payment> {
  const { bookingId, amount } = orderSchema.parse(input);
  assertPaymentConfigured();
  return tx.payment.create({
    data: { bookingId, provider: currentProviderName(), orderId: newOrderId(), amount, status: "READY" },
  });
}

// ── 결제 승인 ─────────────────────────────────────────

const confirmSchema = z.object({
  orderId: orderIdSchema,
  paymentKey: paymentKeySchema,
  amount: z.number().int("결제 금액이 올바르지 않아요.").min(0, "결제 금액이 올바르지 않아요.").max(MAX_AMOUNT, "결제 금액이 올바르지 않아요."),
});

export interface ConfirmPaymentResult {
  payment: Payment;
  /** true 면 이전 요청에서 이미 승인된 결제다(이번 호출로 PG 를 부르지 않았다). */
  alreadyProcessed: boolean;
}

function closedOrderError(payment: Payment): AppError {
  switch (payment.status) {
    case "PAID":
    case "PARTIAL_CANCELLED":
      return err.conflict("이미 결제가 끝난 주문이에요.");
    case "FAILED":
      return err.conflict("결제에 실패한 주문이에요. 처음부터 다시 결제해 주세요.");
    case "CANCELLED":
      return err.conflict("취소된 주문이에요. 처음부터 다시 예약해 주세요.");
    default:
      return err.conflict(MSG_CHECKING);
  }
}

/**
 * 결제창에서 돌아온 결제를 PG 에 승인 요청하고 결과를 기록한다.
 * 같은 주문에 대한 중복·동시 호출은 PG 승인을 한 번만 일으키고 같은 결과로 끝난다.
 */
export async function confirmPayment(input: { orderId: string; paymentKey: string; amount: number }): Promise<ConfirmPaymentResult> {
  const { orderId, paymentKey, amount } = confirmSchema.parse(input);
  const payment = await prisma.payment.findUnique({ where: { orderId } });
  if (!payment) throw err.notFound(MSG_NOT_FOUND);

  if (isPaid(payment) && payment.paymentKey === paymentKey) return { payment, alreadyProcessed: true };
  if (payment.status !== "READY") throw closedOrderError(payment);
  // 테스트 결제로 만든 주문이 실제 결제 환경에서 승인되는 일(또는 그 반대)을 막는다.
  if (payment.provider !== currentProviderName()) throw err.conflict("결제 설정이 바뀌었어요. 처음부터 다시 결제해 주세요.");

  if (amount !== payment.amount) {
    // 금액 변조 시도. PG 에 요청이 나간 적 없는 주문만 실패 처리한다(진행 중인 승인을 덮어쓰지 않는다).
    await prisma.payment.updateMany({
      where: { id: payment.id, status: "READY", paymentKey: null, failCode: null },
      data: { status: "FAILED", failCode: "AMOUNT_MISMATCH", failMessage: MSG_AMOUNT_MISMATCH },
    });
    throw err.validation(MSG_AMOUNT_MISMATCH);
  }

  const claimed = await claimPayment(payment, paymentKey);
  if (!claimed) return awaitOtherConfirm(orderId, paymentKey);

  const provider = getPaymentProviderByName(claimed.provider);
  let approved: ApprovedCharge;
  try {
    approved = await provider.confirm({ paymentKey, orderId, amount: claimed.amount });
  } catch (e) {
    if (e instanceof PaymentProviderError && !e.retryable) {
      await prisma.payment.updateMany({
        where: { id: claimed.id, status: "READY", paymentKey },
        data: {
          status: "FAILED",
          failCode: e.code.slice(0, 100),
          failMessage: e.userMessage,
          raw: toJson({ error: { code: e.code, message: e.message.slice(0, 500) } }),
        },
      });
      throw err.payment(e.userMessage);
    }
    if (e instanceof AppError) {
      // 미연동 등 PG 에 요청이 나가기 전의 오류: 청구됐을 가능성이 없으므로 점유만 푼다.
      await prisma.payment.updateMany({ where: { id: claimed.id, status: "READY", paymentKey }, data: { paymentKey: null } });
      throw e;
    }
    return resolveUnknownOutcome(claimed, paymentKey, e);
  }

  const outcome = await settleApproved(claimed, approved);
  if (outcome.kind === "PAID") return { payment: outcome.payment, alreadyProcessed: false };
  throw settleError(outcome);
}

/**
 * PG 를 부르기 전에 결제 행을 점유한다(READY 이면서 paymentKey 가 비어 있는 행에 결제 키를 기록).
 * 동시에 들어온 두 승인 요청 중 하나만 성공하므로 PG 승인은 한 번만 나간다.
 * 같은 예약에 주문이 여러 개 있어도 승인은 하나만 진행되도록 예약의 결제 행 전체를 잠그고 확인한다.
 * 점유하지 못하면 null.
 */
async function claimPayment(payment: Payment, paymentKey: string): Promise<Payment | null> {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);
  try {
    return await prisma.$transaction(async (tx) => {
      const siblings = await tx.$queryRaw<{ id: string; status: string; paymentKey: string | null; failCode: string | null }[]>`
        SELECT "id", "status"::text AS "status", "paymentKey", "failCode"
        FROM "Payment" WHERE "bookingId" = ${payment.bookingId} ORDER BY "id" FOR UPDATE`;
      for (const other of siblings) {
        if (other.id === payment.id) continue;
        if (other.status === "PAID" || other.status === "PARTIAL_CANCELLED") throw err.conflict("이미 결제가 끝난 예약이에요.");
        if (other.status === "READY" && (other.paymentKey !== null || other.failCode !== null)) {
          throw err.conflict("이 예약의 다른 결제를 확인하고 있어요. 잠시 후 다시 시도해 주세요.");
        }
      }
      const claimed = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: "READY",
          // 같은 결제 키의 점유가 오래됐다면 그 요청은 죽은 것이므로 이어받는다(PG 승인은 주문번호로 멱등).
          OR: [{ paymentKey: null }, { paymentKey, updatedAt: { lt: staleBefore } }],
        },
        data: { paymentKey, failCode: null, failMessage: null },
      });
      if (claimed.count === 0) return null;
      return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    });
  } catch (e) {
    // paymentKey 유니크 위반: 다른 주문에 이미 쓰인 결제 키
    if (isUniqueViolation(e)) throw err.conflict("이미 다른 주문에 사용된 결제 정보예요.");
    throw e;
  }
}

/** 점유에 실패했을 때: 같은 결제 키로 진행 중인 다른 요청이 끝나기를 잠시 기다렸다가 같은 결과를 돌려준다. */
async function awaitOtherConfirm(orderId: string, paymentKey: string): Promise<ConfirmPaymentResult> {
  const deadline = Date.now() + CONFIRM_WAIT_MS;
  for (;;) {
    const current = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    const inFlight = current.status === "READY" && current.paymentKey === paymentKey;
    if (!inFlight || Date.now() >= deadline) {
      if (isPaid(current) && current.paymentKey === paymentKey) return { payment: current, alreadyProcessed: true };
      if (current.status === "FAILED" && current.paymentKey === paymentKey) {
        throw err.payment(current.failMessage ?? "결제에 실패했어요. 처음부터 다시 결제해 주세요.");
      }
      if (current.status === "READY" && current.paymentKey === null && current.failCode === UNKNOWN_OUTCOME) throw err.payment(MSG_DELAYED);
      throw closedOrderError(current);
    }
    await sleep(CONFIRM_POLL_MS);
  }
}

/**
 * 승인 요청의 결과를 알 수 없을 때(시간 초과·5xx·"이미 처리됨").
 * PG 조회로 확정할 수 있으면 그 결과를 반영하고, 아니면 점유를 풀어 재시도를 허용하되 대사 대상으로 표시해 둔다.
 */
async function resolveUnknownOutcome(claimed: Payment, paymentKey: string, cause: unknown): Promise<ConfirmPaymentResult> {
  logIssue("승인 결과를 확인하지 못함", claimed.orderId, cause);
  let state: ProviderPaymentState | null | undefined;
  try {
    state = await getPaymentProviderByName(claimed.provider).fetchByOrderId(claimed.orderId, paymentKey);
  } catch (e) {
    logIssue("승인 결과 조회 실패", claimed.orderId, e);
  }
  if (state !== undefined) {
    const synced = await syncWithProvider(claimed, state);
    if (synced.state === "PAID") return { payment: synced.payment, alreadyProcessed: false };
    if (synced.state === "CANCELLED") throw err.payment(synced.payment.failMessage ?? "결제가 승인되지 않았어요. 처음부터 다시 결제해 주세요.");
  }
  await prisma.payment.updateMany({
    where: { id: claimed.id, status: "READY", paymentKey },
    data: {
      paymentKey: null,
      failCode: UNKNOWN_OUTCOME,
      failMessage: "PG 승인 결과를 확인하지 못했어요.",
      // 대사 때 결제 키로 조회할 수 있게 남겨 둔다.
      raw: { unresolvedPaymentKey: paymentKey },
    },
  });
  throw err.payment(MSG_DELAYED);
}

function unresolvedPaymentKey(raw: unknown): string | null {
  const parsed = z.object({ unresolvedPaymentKey: paymentKeySchema }).safeParse(raw);
  return parsed.success ? parsed.data.unresolvedPaymentKey : null;
}

// ── PG 승인 결과 반영 ─────────────────────────────────

interface ApprovedCharge {
  paymentKey: string;
  orderId: string;
  amount: number;
  method?: string | null;
  approvedAt: Date;
  receiptUrl?: string | null;
  raw: unknown;
}

type ReversalReason = "AMOUNT_MISMATCH" | "DUPLICATE";

type SettleOutcome =
  | { kind: "PAID"; payment: Payment }
  /** PG 에서는 승인됐지만 받아들일 수 없어 자동 취소한 결제. done=false 면 취소가 아직 끝나지 않았다. */
  | { kind: "REVERSED"; reason: ReversalReason; done: boolean; payment: Payment }
  /** PG 에서는 승인됐는데 우리 행이 이미 다른 상태로 끝나 있다(수동 확인 필요). */
  | { kind: "LOST"; payment: Payment };

/** PG 가 승인한 결제를 우리 주문과 대조한 뒤 PAID 로 기록한다. */
async function settleApproved(payment: Payment, charge: ApprovedCharge): Promise<SettleOutcome> {
  if (charge.orderId !== payment.orderId || charge.amount !== payment.amount) {
    return reverseCharge(payment, charge, "AMOUNT_MISMATCH");
  }
  try {
    await prisma.payment.updateMany({
      where: { id: payment.id, status: "READY" },
      data: {
        status: "PAID",
        paymentKey: charge.paymentKey,
        approvedAt: charge.approvedAt,
        method: charge.method?.slice(0, 50) ?? null,
        receiptUrl: charge.receiptUrl ?? null,
        raw: toJson(charge.raw),
        failCode: null,
        failMessage: null,
      },
    });
  } catch (e) {
    // "예약 한 건에 승인된 결제는 하나" 유니크 인덱스 위반: 같은 예약의 다른 주문이 먼저 결제됐다.
    if (isUniqueViolation(e) && (await hasOtherPaidPayment(payment))) return reverseCharge(payment, charge, "DUPLICATE");
    throw e;
  }
  const current = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  if (isPaid(current) && current.paymentKey === charge.paymentKey) return { kind: "PAID", payment: current };
  console.error("[payments] PG 승인 건을 기록하지 못함 — 수동 확인 필요", payment.orderId, current.status);
  await audit({
    actorType: "SYSTEM",
    action: "payment.anomaly",
    targetType: "Payment",
    targetId: payment.id,
    meta: { orderId: payment.orderId, providerStatus: "DONE", status: current.status },
  });
  return { kind: "LOST", payment: current };
}

async function hasOtherPaidPayment(payment: Payment): Promise<boolean> {
  const other = await prisma.payment.findFirst({
    where: { bookingId: payment.bookingId, id: { not: payment.id }, status: { in: ["PAID", "PARTIAL_CANCELLED"] } },
    select: { id: true },
  });
  return other !== null;
}

const REVERSAL = {
  AMOUNT_MISMATCH: {
    failCode: "PROVIDER_AMOUNT_MISMATCH",
    reason: "주문 금액 불일치로 자동 취소",
    failMessage: "PG 승인 금액이 주문 금액과 달라 자동으로 취소했어요.",
  },
  DUPLICATE: {
    failCode: "DUPLICATE_PAYMENT",
    reason: "중복 결제 자동 취소",
    failMessage: "같은 예약에 이미 승인된 결제가 있어 자동으로 취소했어요.",
  },
} as const;

/**
 * 받아들일 수 없는 승인 건을 PG 에서 전액 취소한다.
 * 전액 취소는 두 번 실행될 수 없으므로(잔액이 없으면 PG 가 거절) 시도마다 새 멱등 키를 쓴다.
 * 취소에 실패하면 행을 점유 상태로 남겨 대사(reconcilePayment)가 다시 시도하게 한다.
 */
async function reverseCharge(payment: Payment, charge: ApprovedCharge, reason: ReversalReason): Promise<SettleOutcome> {
  const spec = REVERSAL[reason];
  let done = true;
  try {
    await getPaymentProviderByName(payment.provider).cancel({
      paymentKey: charge.paymentKey,
      amount: charge.amount,
      reason: spec.reason,
      idempotencyKey: `reverse_${payment.id}_${newToken(6)}`,
    });
  } catch (e) {
    done = false;
    logIssue("자동 취소 실패 — 대사에서 다시 시도", payment.orderId, e);
  }
  await prisma.payment.updateMany({
    where: { id: payment.id, status: "READY" },
    data: done
      ? { status: "FAILED", paymentKey: charge.paymentKey, failCode: spec.failCode, failMessage: spec.failMessage }
      : { paymentKey: charge.paymentKey, failCode: `${reason}_REVERSAL_PENDING`, failMessage: "PG 자동 취소를 다시 시도할 예정이에요." },
  });
  await audit({
    actorType: "SYSTEM",
    action: "payment.auto_reversal",
    targetType: "Payment",
    targetId: payment.id,
    meta: { orderId: payment.orderId, reason, reversed: done, orderAmount: payment.amount, chargedAmount: charge.amount },
  });
  return { kind: "REVERSED", reason, done, payment: await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }) };
}

function settleError(outcome: Exclude<SettleOutcome, { kind: "PAID" }>): AppError {
  if (outcome.kind === "LOST") return err.conflict(MSG_CHECKING);
  if (outcome.reason === "DUPLICATE") return err.conflict("이미 결제가 끝난 예약이에요. 방금 결제는 자동으로 취소돼요.");
  return err.payment("결제 금액이 주문 금액과 달라 결제를 취소했어요. 처음부터 다시 결제해 주세요.");
}

// ── 결제 없이 끝난 주문 ───────────────────────────────

/**
 * 홀드가 결제 없이 만료됐을 때 READY 주문을 닫는다(PG 호출 없음).
 * PG 승인이 진행 중이거나 결과를 확인하지 못한 주문은 닫지 않고 false 를 돌려준다
 * — 그런 주문은 reconcilePayment 로 결과를 확정해야 한다.
 * 예약 만료와 같은 트랜잭션에서 처리하려면 db 에 트랜잭션 클라이언트를 넘긴다.
 */
export async function markPaymentAbandoned(orderId: string, db: Db = prisma): Promise<boolean> {
  const result = await db.payment.updateMany({
    where: { orderId: orderIdSchema.parse(orderId), status: "READY", paymentKey: null, failCode: null },
    data: { status: "CANCELLED" },
  });
  return result.count === 1;
}

// ── 대사(PG 상태와 맞추기) ────────────────────────────

/**
 * - PAID      : 결제가 승인돼 있다(부분 환불 포함) → 예약을 확정하거나, 예약이 이미 끝났다면 환불한다.
 * - CANCELLED : 청구된 금액이 없다(취소·실패·만료·전액 환불).
 * - PENDING   : 아직 결제 전이거나 승인 진행 중이다.
 * - UNKNOWN   : PG 조회에 실패했거나 PG 와 우리 기록이 어긋난다(로그·감사 기록 확인).
 */
export type ReconcileState = "PAID" | "CANCELLED" | "PENDING" | "UNKNOWN";

export interface ReconcileResult {
  state: ReconcileState;
  payment: Payment;
}

/**
 * PG 조회 API 로 결제 상태를 다시 확인해 우리 기록을 맞춘다. 웹훅 처리와 크론 안전망에서 쓴다.
 * 웹훅 본문의 값은 믿지 않고, hint.paymentKey 는 조회 대상을 찾는 데만 쓴다(조회 결과의 주문번호가 다르면 무시).
 */
export async function reconcilePayment(orderId: string, hint: { paymentKey?: string | null } = {}): Promise<ReconcileResult> {
  const payment = await prisma.payment.findUnique({ where: { orderId: orderIdSchema.parse(orderId) } });
  if (!payment) throw err.notFound(MSG_NOT_FOUND);
  const hinted = paymentKeySchema.safeParse(hint.paymentKey);
  const lookupKey = payment.paymentKey ?? unresolvedPaymentKey(payment.raw) ?? (hinted.success ? hinted.data : null);

  let state: ProviderPaymentState | null;
  try {
    state = await getPaymentProviderByName(payment.provider).fetchByOrderId(payment.orderId, lookupKey);
  } catch (e) {
    if (e instanceof AppError) throw e;
    logIssue("대사용 PG 조회 실패", payment.orderId, e);
    return { state: "UNKNOWN", payment };
  }
  return syncWithProvider(payment, state);
}

async function syncWithProvider(payment: Payment, state: ProviderPaymentState | null): Promise<ReconcileResult> {
  const status = state?.status ?? null;
  const reload = () => prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });

  if (payment.status === "READY") {
    if (state && status === "DONE") {
      if (!state.paymentKey) return { state: "UNKNOWN", payment };
      const outcome = await settleApproved(payment, {
        paymentKey: state.paymentKey,
        orderId: state.orderId,
        amount: state.totalAmount,
        method: state.method,
        approvedAt: state.approvedAt ?? new Date(),
        receiptUrl: state.receiptUrl,
        raw: state.raw,
      });
      if (outcome.kind === "PAID") {
        await auditReconcile(payment, "PAID");
        return { state: "PAID", payment: outcome.payment };
      }
      return { state: outcome.kind === "REVERSED" && outcome.done ? "CANCELLED" : "UNKNOWN", payment: outcome.payment };
    }
    // PG 에 승인을 요청한 적 없는 주문은 고객이 아직 결제 중일 수 있으므로 건드리지 않는다.
    const requested = payment.paymentKey !== null || payment.failCode !== null;
    if (!requested) return { state: "PENDING", payment };

    if (status === "CANCELED" || status === "ABORTED" || status === "EXPIRED") {
      await prisma.payment.updateMany({
        where: { id: payment.id, status: "READY" },
        data:
          status === "CANCELED"
            ? { status: "CANCELLED" }
            : {
                status: "FAILED",
                failCode: `PROVIDER_${status}`,
                failMessage: status === "EXPIRED" ? "결제 시간이 지났어요. 처음부터 다시 결제해 주세요." : "결제가 승인되지 않았어요. 처음부터 다시 결제해 주세요.",
              },
      });
      await auditReconcile(payment, status === "CANCELED" ? "CANCELLED" : "FAILED");
      return { state: "CANCELLED", payment: await reload() };
    }
    if (status === null || status === "WAITING") {
      // 충분히 기다렸는데도 PG 가 승인 전이라고 하면 승인 요청은 처리되지 않은 것이다 → 깨끗한 READY 로 되돌린다.
      if (payment.updatedAt.getTime() < Date.now() - CLAIM_STALE_MS) {
        await prisma.payment.updateMany({
          where: { id: payment.id, status: "READY", updatedAt: payment.updatedAt },
          data: { paymentKey: null, failCode: null, failMessage: null, raw: Prisma.DbNull },
        });
        return { state: "PENDING", payment: await reload() };
      }
      return { state: "PENDING", payment };
    }
    return { state: "UNKNOWN", payment };
  }

  if (isPaid(payment)) {
    if (status === "DONE" || status === "PARTIAL_CANCELED") return { state: "PAID", payment };
    if (status === "CANCELED") {
      await syncFullyCancelled(payment);
      return { state: "CANCELLED", payment: await reload() };
    }
    console.error("[payments] 승인된 결제가 PG 에서 확인되지 않음 — 수동 확인 필요", payment.orderId, status);
    return { state: "UNKNOWN", payment };
  }

  // CANCELLED · FAILED: 청구가 없어야 하는 주문
  if (status === "DONE" || status === "PARTIAL_CANCELED") {
    console.error("[payments] 닫힌 주문이 PG 에서는 승인 상태 — 수동 확인 필요", payment.orderId, payment.status);
    await audit({
      actorType: "SYSTEM",
      action: "payment.anomaly",
      targetType: "Payment",
      targetId: payment.id,
      meta: { orderId: payment.orderId, providerStatus: status, status: payment.status },
    });
    return { state: "UNKNOWN", payment };
  }
  return { state: "CANCELLED", payment };
}

/**
 * PG 에서 전액 취소된 결제(PG 관리자 화면에서 직접 취소 등)를 우리 기록에 반영한다.
 * 열려 있던 환불은 완료로 닫고, 기록에 없는 취소분은 시스템 환불로 남겨 "완료 환불 합계 = 취소 금액"을 유지한다.
 */
async function syncFullyCancelled(payment: Payment): Promise<void> {
  const synced = await prisma.$transaction(async (tx) => {
    const locked = await lockPayment(tx, payment.id);
    const updated = await tx.payment.updateMany({
      where: { id: payment.id, status: { in: ["PAID", "PARTIAL_CANCELLED"] } },
      data: { status: "CANCELLED", cancelledAmount: locked.amount },
    });
    if (updated.count === 0) return false;
    const now = new Date();
    const open = await tx.refund.aggregate({
      where: { paymentId: payment.id, status: { in: ["REQUESTED", "FAILED"] } },
      _sum: { amount: true },
    });
    await tx.refund.updateMany({
      where: { paymentId: payment.id, status: { in: ["REQUESTED", "FAILED"] } },
      data: { status: "DONE", processedAt: now, error: null },
    });
    const untracked = locked.amount - locked.cancelledAmount - (open._sum.amount ?? 0);
    if (untracked > 0) {
      await tx.refund.create({
        data: {
          paymentId: payment.id,
          bookingId: payment.bookingId,
          amount: untracked,
          reason: "PG 에서 직접 취소된 결제를 반영",
          status: "DONE",
          requestedBy: "SYSTEM",
          processedAt: now,
        },
      });
    }
    return true;
  });
  if (synced) await auditReconcile(payment, "CANCELLED");
}

async function auditReconcile(payment: Payment, to: string): Promise<void> {
  await audit({
    actorType: "SYSTEM",
    action: "payment.reconcile",
    targetType: "Payment",
    targetId: payment.id,
    meta: { orderId: payment.orderId, bookingId: payment.bookingId, from: payment.status, to },
  });
}

/**
 * 크론 안전망이 reconcilePayment 로 확인해야 하는 주문번호 목록:
 * 승인 도중 끊긴 점유(오래된 것)와 승인 결과를 확인하지 못한 주문.
 */
export async function listPaymentsNeedingReconcile(limit = 50): Promise<string[]> {
  const take = z.number().int().min(1).max(500).parse(limit);
  const rows = await prisma.payment.findMany({
    where: {
      status: "READY",
      OR: [{ paymentKey: { not: null }, updatedAt: { lt: new Date(Date.now() - CLAIM_STALE_MS) } }, { failCode: { not: null } }],
    },
    orderBy: { updatedAt: "asc" },
    take,
    select: { orderId: true },
  });
  return rows.map((row) => row.orderId);
}

// ── 환불 ──────────────────────────────────────────────

const refundSchema = z.object({
  bookingId: idSchema,
  amount: z.number().int("환불 금액은 원 단위 정수여야 해요.").max(MAX_AMOUNT, "환불할 수 있는 금액을 넘었어요."),
  // PG 취소 사유는 200자까지라 넘치는 부분은 잘라 낸다(사유가 길다는 이유로 환불이 막히면 안 된다).
  reason: z
    .string()
    .max(2000)
    .transform((value) => value.trim().slice(0, 200) || "예약 취소"),
  requestedBy: z.enum(["CUSTOMER", "SELLER", "ADMIN", "SYSTEM"]),
  requestedById: idSchema.nullish(),
});

export interface RefundPaymentInput {
  bookingId: string;
  /** 환불할 금액(원). 호출자가 정책에 따라 계산한 값 */
  amount: number;
  reason: string;
  requestedBy: ActorType;
  requestedById?: string | null;
}

/**
 * 예약의 온라인 결제분을 환불한다(PG 전액·부분 취소).
 * - 환불할 금액이 없거나 승인된 결제가 없으면 null.
 * - 남은 환불 가능 금액을 넘으면 CONFLICT.
 * - PG 취소가 실패해도 예외를 던지지 않고 FAILED 환불을 돌려준다(예약 취소는 마저 끝내고, 운영자 콘솔에서 재시도).
 *
 * 동시 환불 방지: Refund 를 만들기 전에 Payment 행을 SELECT … FOR UPDATE 로 잠그고
 * "결제 금액 − 취소 완료 금액 − 진행 중·실패 환불 합계"를 넘지 않는지 확인한다.
 * 실패한 환불도 재시도될 금액이라 계속 잡아 둔다. 이 방식은 cancelledAmount 를 "PG 에서 실제로 취소가 끝난 금액"으로만
 * 유지하므로, PG 호출 도중 프로세스가 죽어도 되돌릴 예약분이 남지 않는다.
 */
export async function refundPayment(input: RefundPaymentInput): Promise<Refund | null> {
  const { bookingId, amount, reason, requestedBy, requestedById } = refundSchema.parse(input);
  if (amount <= 0) return null;
  const payment = await prisma.payment.findFirst({ where: { bookingId, status: { in: ["PAID", "PARTIAL_CANCELLED"] } } });
  if (!payment) return null;

  const refund = await prisma.$transaction(async (tx) => {
    const locked = await lockPayment(tx, payment.id);
    const open = await tx.refund.aggregate({
      where: { paymentId: payment.id, status: { in: ["REQUESTED", "FAILED"] } },
      _sum: { amount: true },
    });
    const refundable = locked.amount - locked.cancelledAmount - (open._sum.amount ?? 0);
    if (amount > refundable) {
      throw err.conflict(
        refundable > 0 ? `환불할 수 있는 금액(${formatKRW(refundable)})을 넘었어요.` : "이미 환불이 끝났거나 진행 중인 결제예요.",
      );
    }
    return tx.refund.create({
      data: { paymentId: payment.id, bookingId, amount, reason, requestedBy, requestedById: requestedById ?? null },
    });
  });

  const result = await executeRefund(refund, payment);
  await audit({
    actorId: requestedById ?? null,
    actorType: requestedBy,
    action: result.status === "DONE" ? "payment.refund" : "payment.refund_failed",
    targetType: "Refund",
    targetId: result.id,
    meta: { bookingId, paymentId: payment.id, orderId: payment.orderId, amount, status: result.status },
  });
  return result;
}

/**
 * 환불 한 건의 PG 멱등 키. 첫 시도(attempts = 0)는 환불 ID 그대로이고,
 * PG 가 확정적으로 거절한 뒤의 재시도부터는 "환불ID-r1", "환불ID-r2" … 로 바뀐다.
 *
 * 키를 바꾸는 조건이 중요하다.
 * - 결과를 모르는 실패(시간 초과·5xx·처리 도중 끊김): 첫 요청이 PG 에서는 성공했을 수 있으므로 반드시 같은 키로 다시 보낸다.
 * - PG 가 확정적으로 거절한 실패: PG 는 같은 키에 처음 응답(거절)을 그대로 되돌려 주므로, 원인을 고친 뒤에도
 *   같은 키로는 성공할 수 없다. 이때만 retryRefund 가 attempts 를 올려 새 키를 쓴다.
 */
export function refundIdempotencyKey(refund: Pick<Refund, "id" | "attempts">): string {
  return refund.attempts > 0 ? `${refund.id}-r${refund.attempts}` : refund.id;
}

/**
 * PG 가 확정적으로 거절한 환불의 오류 문구(Refund.error) 맨 앞에 붙는 표시.
 * 운영자 화면에는 "원인을 고친 뒤 재시도해야 하는 실패"로 보이고, retryRefund 는 이 표시가 있는 환불만 새 멱등 키로 다시 보낸다.
 */
export const REFUND_REJECTED_TAG = "[PG 거절]";

/**
 * PG 취소를 요청하고 결과를 Refund·Payment 에 반영한다. 실패해도 던지지 않고 FAILED 로 남긴다.
 * PG 가 이 요청을 확정적으로 거절했을 때만 오류 문구에 REFUND_REJECTED_TAG 를 붙인다.
 * 결과를 모르는 실패와 우리 쪽 확인에서 걸린 실패(금액 불일치 등)에는 붙이지 않는다 — 그런 환불은 같은 키로 다시 보내야 한다.
 */
async function executeRefund(refund: Refund, payment: Payment): Promise<Refund> {
  let rejectedByProvider = false;
  try {
    if (!payment.paymentKey) {
      throw new PaymentProviderError({ code: "MISSING_PAYMENT_KEY", userMessage: "결제 키가 없어 PG 취소를 요청할 수 없어요.", retryable: false });
    }
    let result: ProviderCancelResult;
    try {
      // 같은 멱등 키로는 응답을 못 받은 뒤 다시 요청해도 PG 에서 한 번만 취소된다.
      result = await getPaymentProviderByName(payment.provider).cancel({
        paymentKey: payment.paymentKey,
        amount: refund.amount,
        reason: refund.reason,
        idempotencyKey: refundIdempotencyKey(refund),
      });
    } catch (e) {
      rejectedByProvider = e instanceof PaymentProviderError && !e.retryable;
      throw e;
    }
    if (result.cancelledAmount !== refund.amount) {
      throw new PaymentProviderError({
        code: "CANCEL_AMOUNT_MISMATCH",
        userMessage: "PG 취소 금액이 요청한 금액과 달라요. PG 관리자 화면에서 확인해 주세요.",
        retryable: false,
        detail: `요청 ${refund.amount}원, PG 취소 ${result.cancelledAmount}원 — PG 관리자 화면에서 확인이 필요해요.`,
      });
    }
    await completeRefund(refund, result.providerRef ?? null);
  } catch (e) {
    let error: string;
    if (e instanceof PaymentProviderError) error = `[${e.code}] ${e.message}`;
    else if (e instanceof AppError) error = e.message;
    else {
      console.error("[payments] 환불 처리 중 예기치 못한 오류", payment.orderId, e);
      error = "환불을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.";
    }
    if (rejectedByProvider) error = `${REFUND_REJECTED_TAG} ${error}`;
    // 같은 시도(attempts)의 결과만 기록한다 — 그사이 새 키로 다시 시도 중이면 건드리지 않는다.
    await prisma.refund.updateMany({
      where: { id: refund.id, status: "REQUESTED", attempts: refund.attempts },
      data: { status: "FAILED", error: error.slice(0, 500) },
    });
  }
  return prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

/** PG 취소 성공을 한 트랜잭션으로 기록한다: Refund DONE + Payment.cancelledAmount 증가 + 상태 전이. */
async function completeRefund(refund: Refund, providerRef: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const locked = await lockPayment(tx, refund.paymentId);
    // PG 가 이 환불의 멱등 키로 취소를 확정했으므로, 그사이 FAILED 로 기록된 경우에도 완료로 바꾼다.
    const done = await tx.refund.updateMany({
      where: { id: refund.id, status: { in: ["REQUESTED", "FAILED"] } },
      data: { status: "DONE", processedAt: new Date(), providerRef, error: null },
    });
    if (done.count === 0) {
      // 대사에서 먼저 완료 처리한 환불: 금액은 이미 반영됐으므로 취소 거래 번호만 채운다.
      await tx.refund.updateMany({ where: { id: refund.id, providerRef: null }, data: { providerRef } });
      return;
    }
    const cancelledAmount = locked.cancelledAmount + refund.amount;
    await tx.payment.update({
      where: { id: refund.paymentId },
      data: { cancelledAmount, status: cancelledAmount >= locked.amount ? "CANCELLED" : "PARTIAL_CANCELLED" },
    });
  });
}

/** 환불 재시도를 누가 실행하는지. 운영자면 서비스 안에서 역할을 다시 확인한다. */
export type RefundRetryActor = { type: "ADMIN"; adminId: string } | { type: "SYSTEM" };

const REFUND_ADMIN_ROLES: AdminRole[] = ["SUPER", "CS", "FINANCE"];

async function assertRefundOperator(adminId: string): Promise<void> {
  const admin = await prisma.user.findUnique({ where: { id: idSchema.parse(adminId) }, select: { status: true, adminRole: true } });
  if (!admin || admin.status !== "ACTIVE" || !admin.adminRole || !REFUND_ADMIN_ROLES.includes(admin.adminRole)) throw err.forbidden();
}

/**
 * 실패한 환불(또는 처리 도중 끊겨 REQUESTED 로 남은 환불)을 다시 시도한다. 이미 끝난 환불은 그대로 돌려준다.
 * - PG 가 확정적으로 거절했던 환불(오류 문구가 REFUND_REJECTED_TAG 로 시작): attempts 를 1 올리고 새 멱등 키로 요청한다.
 *   거절된 요청은 PG 에서 아무것도 취소하지 않았으므로 새 키로 보내도 이중 환불이 되지 않는다.
 * - 결과를 모르는 실패와 끊긴 요청: attempts 를 그대로 두고 같은 멱등 키로 요청한다.
 *   첫 시도가 PG 에서는 성공했던 경우에도 이중으로 취소되지 않는다.
 */
export async function retryRefund(refundId: string, actor: RefundRetryActor = { type: "SYSTEM" }): Promise<Refund> {
  const id = idSchema.parse(refundId);
  if (actor.type === "ADMIN") await assertRefundOperator(actor.adminId);

  const refund = await prisma.refund.findUnique({ where: { id }, include: { payment: true } });
  if (!refund) throw err.notFound("환불 내역을 찾을 수 없어요.");
  const { payment, ...current } = refund;
  if (current.status === "DONE") return current;

  // 1) 확정 거절 건: 새 키로 넘어간다(동시에 들어온 재시도 중 하나만 attempts 를 올린다).
  const rotated = await prisma.refund.updateMany({
    where: { id, status: "FAILED", error: { startsWith: REFUND_REJECTED_TAG } },
    data: { status: "REQUESTED", error: null, attempts: { increment: 1 } },
  });
  // 2) 그 밖의 재시도 대상(결과를 모르는 실패, 처리 도중 끊긴 요청): 같은 키로 다시 보낸다.
  const claimed =
    rotated.count === 1
      ? rotated
      : await prisma.refund.updateMany({
          where: { id, OR: [{ status: "FAILED" }, { status: "REQUESTED", createdAt: { lt: new Date(Date.now() - REFUND_STALE_MS) } }] },
          data: { status: "REQUESTED", error: null },
        });
  // 점유한 뒤의 최신 행(attempts 포함)으로 멱등 키를 정한다.
  const latest = await prisma.refund.findUniqueOrThrow({ where: { id } });
  if (latest.status === "DONE") return latest;
  if (claimed.count === 0) throw err.conflict("이미 처리 중인 환불이에요. 잠시 후 다시 확인해 주세요.");

  const result = await executeRefund(latest, payment);
  await audit({
    actorId: actor.type === "ADMIN" ? actor.adminId : null,
    actorType: actor.type,
    action: "payment.refund_retry",
    targetType: "Refund",
    targetId: id,
    meta: {
      bookingId: result.bookingId,
      paymentId: result.paymentId,
      orderId: payment.orderId,
      amount: result.amount,
      status: result.status,
      attempts: result.attempts,
      newKey: rotated.count === 1,
    },
  });
  return result;
}

/** 운영자 콘솔용: 재시도가 필요한 환불(실패했거나 처리 도중 끊긴 것), 오래된 순 */
export async function listFailedRefunds(options: { limit?: number } = {}) {
  const take = z.number().int().min(1).max(500).parse(options.limit ?? 100);
  return prisma.refund.findMany({
    where: { OR: [{ status: "FAILED" }, { status: "REQUESTED", createdAt: { lt: new Date(Date.now() - REFUND_STALE_MS) } }] },
    orderBy: { createdAt: "asc" },
    take,
    include: {
      payment: { select: { id: true, orderId: true, provider: true, amount: true, cancelledAmount: true, status: true, method: true } },
      booking: {
        select: {
          id: true,
          code: true,
          status: true,
          userId: true,
          guestName: true,
          businessId: true,
          business: { select: { name: true } },
          product: { select: { title: true } },
        },
      },
    },
  });
}

export type FailedRefund = Awaited<ReturnType<typeof listFailedRefunds>>[number];

// ── 조회 ──────────────────────────────────────────────

export type PaymentWithRefunds = Payment & { refunds: Refund[] };

/**
 * 주문번호로 결제를 찾는다. 결제창에서 돌아온 요청이 어느 예약의 것인지 확인하는 데 쓴다
 * — 호출자는 confirmPayment 를 부르기 전에 payment.bookingId 로 예약의 주인과 홀드 만료를 확인해야 한다.
 */
export async function getPaymentByOrderId(orderId: string): Promise<Payment | null> {
  const parsed = orderIdSchema.safeParse(orderId);
  if (!parsed.success) return null;
  return prisma.payment.findUnique({ where: { orderId: parsed.data } });
}

/**
 * 예약의 대표 결제 한 건(환불 내역 포함).
 * 승인된 결제 → 승인 후 전액 환불된 결제 → 결제 대기 중인 주문 → 가장 최근 주문 순으로 고른다.
 * 권한(예약의 주인·사업장) 확인은 예약을 조회하는 호출자가 한다.
 */
export async function getPaymentForBooking(bookingId: string): Promise<PaymentWithRefunds | null> {
  const payments = await prisma.payment.findMany({
    where: { bookingId: idSchema.parse(bookingId) },
    orderBy: { createdAt: "desc" },
    include: { refunds: { orderBy: { createdAt: "asc" } } },
  });
  return (
    payments.find(isPaid) ??
    payments.find((p) => p.approvedAt !== null) ??
    payments.find((p) => p.status === "READY") ??
    payments[0] ??
    null
  );
}

/**
 * 예약의 환불 내역 전체(요청한 순서). 한 예약에 환불이 여러 번 있을 수 있다(부분 환불, 재판매 연동 추가 환불 등).
 * 권한(예약의 주인·사업장) 확인은 예약을 조회하는 호출자가 한다.
 * status: REQUESTED = 처리 중, DONE = 완료(processedAt = 완료 시각), FAILED = 실패(운영자 재시도 대상).
 * error 는 운영자용 문구이므로 고객 화면에는 내보내지 않는다.
 */
export async function getRefundsForBooking(bookingId: string): Promise<Refund[]> {
  return prisma.refund.findMany({
    where: { bookingId: idSchema.parse(bookingId) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}
