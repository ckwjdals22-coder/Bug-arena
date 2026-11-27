import "server-only";
import { z } from "zod";
import type { BookingChannel, PlanTier, Prisma } from "@/generated/prisma/client";
import { BOOKING_CHANNEL_LABEL } from "@/lib/domain";
import { applyBps, formatBps } from "@/lib/money";
import { COMMISSION_RULE_LABEL } from "@/lib/policy";
import { DAY } from "@/lib/time";
import { prisma } from "@/server/db";
import { err } from "@/server/errors";
import { getSettings, type PlatformSettings } from "@/server/settings";

/**
 * 수수료 판정(docs/02-architecture.md 6.6).
 * 원칙: 플랫폼이 채운 자리에만 받는다. 사업자에게 보이는 요율은 결제 대행 수수료를 포함한 단일 요율이다.
 * 중개 수수료가 없는 온라인 결제(자체 링크·내 고객·입점 프로모션)에는 결제 실비만 따로 계산한다.
 *
 * 판정 순서(처음 맞는 규칙): MANUAL → DIRECT → OWN_CUSTOMER → PROMO → OVERRIDE → MARKET_RETURNING → MARKET_NEW
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export const COMMISSION_RULES = ["MANUAL", "DIRECT", "OWN_CUSTOMER", "PROMO", "OVERRIDE", "MARKET_RETURNING", "MARKET_NEW"] as const;
export type CommissionRule = (typeof COMMISSION_RULES)[number];

export function isCommissionRule(value: unknown): value is CommissionRule {
  return typeof value === "string" && (COMMISSION_RULES as readonly string[]).includes(value);
}

/** 중개 수수료 대신 결제 실비를 따로 차감하는 규칙 */
const PG_FEE_RULES: ReadonlySet<string> = new Set<CommissionRule>(["DIRECT", "OWN_CUSTOMER", "PROMO"]);
/** 이용 이력으로 치는 예약 상태(확정·완료·노쇼) */
const HISTORY_STATUSES = ["CONFIRMED", "COMPLETED", "NO_SHOW"] as const;
/** 사업자가 직접 등록했거나 가져온 고객 카드 */
const OWN_CUSTOMER_SOURCES = ["MANUAL", "IMPORTED"] as const;

export type CommissionSettings = Pick<
  PlatformSettings,
  | "commissionNewCustomerBps"
  | "proCommissionNewCustomerBps"
  | "commissionReturningBps"
  | "commissionDirectBps"
  | "commissionCapPerSeat"
  | "returningWindowDays"
  | "pgFeeBps"
>;

/** 예약에 저장하는 수수료 스냅샷 */
export interface CommissionSnapshot {
  rule: CommissionRule;
  /** 중개 수수료율(bps). 결제 실비율은 포함하지 않는다 */
  bps: number;
  commissionAmount: number;
  pgFeeAmount: number;
  /** 재방문 판정 기간 안에 이 사업자 이용 이력이 없으면 true */
  isNewCustomer: boolean;
}

export interface CommissionBusiness {
  id: string;
  plan: PlanTier;
  /** 사업자 개별 요율(bps). 없으면 null */
  commissionBps: number | null;
  launchPromoUntil: Date | null;
  launchPromoRemaining: number;
}

const digitsOnly = (value: string) => value.replace(/\D/g, "");

const MAX_AMOUNT = 10_000_000_000;
const amountsSchema = z
  .object({
    quantity: z.number().int().min(1).max(10_000),
    totalAmount: z.number().int().min(0).max(MAX_AMOUNT),
    payNowAmount: z.number().int().min(0).max(MAX_AMOUNT),
  })
  .refine((v) => v.payNowAmount <= v.totalAmount);

/** 금액은 호출하는 코드가 DB 값으로 넘긴다. 범위를 벗어나면 계산하지 않고 멈춘다. */
function assertAmounts(input: { quantity: number; totalAmount: number; payNowAmount: number }): void {
  if (!amountsSchema.safeParse(input).success) {
    throw err.validation("수수료를 계산할 수 없어요. 예약 인원과 금액을 확인해 주세요.");
  }
}

// ── 금액 계산(순수 함수) ──────────────────────────────

/**
 * 남은 금액 기준 수수료. 확정 시점 계산과 취소·재판매 환불 뒤의 재계산에 같이 쓴다.
 * - 중개 수수료 = min(applyBps(retainedTotal, bps), 좌석당 상한 × quantity) — 상한이 0 이면 상한 없음
 * - 결제 실비 = DIRECT·OWN_CUSTOMER·PROMO 일 때만 applyBps(retainedOnline, pgFeeBps)
 * 남은 금액이 없으면(전액 환불) 둘 다 0 이다.
 */
export function recalcCommissionForRetained(input: {
  rule: string | null;
  bps: number;
  /** 예약 수량(상한 계산용) */
  quantity: number;
  /** 사업자 몫으로 남은 거래 금액. 확정 시점에는 totalAmount, 취소 뒤에는 온라인 결제액 − 환불액 */
  retainedTotal: number;
  /** 그중 온라인으로 결제돼 남은 금액 */
  retainedOnline: number;
  settings: Pick<PlatformSettings, "commissionCapPerSeat" | "pgFeeBps">;
}): { commissionAmount: number; pgFeeAmount: number } {
  const total = Math.max(0, Math.floor(input.retainedTotal));
  if (total === 0 || input.rule === "MANUAL") return { commissionAmount: 0, pgFeeAmount: 0 };
  const online = Math.min(total, Math.max(0, Math.floor(input.retainedOnline)));
  const cap = input.settings.commissionCapPerSeat * Math.max(1, Math.floor(input.quantity));
  const raw = applyBps(total, Math.max(0, input.bps));
  return {
    commissionAmount: cap > 0 ? Math.min(raw, cap) : raw,
    pgFeeAmount: input.rule !== null && PG_FEE_RULES.has(input.rule) ? applyBps(online, input.settings.pgFeeBps) : 0,
  };
}

/**
 * 남는자리로 들어온 예약(탐색·대기)의 요율. 개별·업종 요율이 있으면 그 요율을 쓰되,
 * 재방문 고객은 재방문 요율과 비교해 낮은 쪽을 쓴다.
 */
export function marketRate(input: {
  plan: PlanTier;
  /** 사업자 개별 요율 ?? 업종 요율. 없으면 null */
  overrideBps: number | null;
  isReturning: boolean;
  settings: Pick<PlatformSettings, "commissionNewCustomerBps" | "proCommissionNewCustomerBps" | "commissionReturningBps">;
}): { rule: "OVERRIDE" | "MARKET_RETURNING" | "MARKET_NEW"; bps: number } {
  const { settings } = input;
  if (input.overrideBps !== null) {
    return { rule: "OVERRIDE", bps: input.isReturning ? Math.min(input.overrideBps, settings.commissionReturningBps) : input.overrideBps };
  }
  if (input.isReturning) return { rule: "MARKET_RETURNING", bps: settings.commissionReturningBps };
  return { rule: "MARKET_NEW", bps: input.plan === "PRO" ? settings.proCommissionNewCustomerBps : settings.commissionNewCustomerBps };
}

/** 판정에 필요한 사실(조회 결과)을 모은 값 */
export interface CommissionFacts {
  channel: BookingChannel;
  plan: PlanTier;
  /** 사업자 개별 요율 ?? 업종 요율 */
  overrideBps: number | null;
  /** 예약 전에 사업자가 직접 등록·가져온 고객 카드가 있었는지 */
  hasOwnCustomerCard: boolean;
  /** 입점 프로모션이 진행 중이고 남은 건수가 있는지 */
  promoActive: boolean;
  /** 재방문 판정 기간 안에 이용 이력이 있는지 */
  isReturning: boolean;
  quantity: number;
  totalAmount: number;
  payNowAmount: number;
  settings: CommissionSettings;
}

/** 조회 없이 규칙표만 적용한다. */
export function decideCommission(facts: CommissionFacts): CommissionSnapshot {
  let picked: { rule: CommissionRule; bps: number };
  if (facts.channel === "MANUAL") picked = { rule: "MANUAL", bps: 0 };
  else if (facts.channel === "DIRECT") picked = { rule: "DIRECT", bps: facts.settings.commissionDirectBps };
  else if (facts.hasOwnCustomerCard) picked = { rule: "OWN_CUSTOMER", bps: 0 };
  else if (facts.promoActive) picked = { rule: "PROMO", bps: 0 };
  else picked = marketRate({ plan: facts.plan, overrideBps: facts.overrideBps, isReturning: facts.isReturning, settings: facts.settings });

  const amounts = recalcCommissionForRetained({
    rule: picked.rule,
    bps: picked.bps,
    quantity: facts.quantity,
    retainedTotal: facts.totalAmount,
    retainedOnline: facts.payNowAmount,
    settings: facts.settings,
  });
  return { rule: picked.rule, bps: picked.bps, ...amounts, isNewCustomer: !facts.isReturning };
}

// ── 조회 ──────────────────────────────────────────────

/**
 * 이 사업자의 신규 고객인지: 재방문 판정 기간 안에 시작한(또는 앞으로 시작할) 회차에
 * 확정·완료·노쇼 예약이 회원 ID 나 전화번호로 하나도 없으면 true.
 * 식별할 값이 없으면(외부 판매 자리 등) 신규로 본다.
 */
export async function isNewCustomerFor(
  businessId: string,
  who: { userId?: string | null; phone: string },
  opts: { now?: Date; excludeBookingId?: string; windowDays?: number } = {},
  db: Db = prisma,
): Promise<boolean> {
  const phone = digitsOnly(who.phone);
  const identities: Prisma.BookingWhereInput[] = [];
  if (who.userId) identities.push({ userId: who.userId });
  if (phone) identities.push({ guestPhone: phone });
  if (identities.length === 0) return true;

  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? (await getSettings()).returningWindowDays;
  const prior = await db.booking.findFirst({
    where: {
      businessId,
      status: { in: [...HISTORY_STATUSES] },
      slot: { startAt: { gte: new Date(now.getTime() - windowDays * DAY) } },
      OR: identities,
      ...(opts.excludeBookingId ? { id: { not: opts.excludeBookingId } } : {}),
    },
    select: { id: true },
  });
  return prior === null;
}

/** 예약 전에(before 보다 먼저) 사업자가 직접 등록했거나 가져온 고객 카드가 그 전화번호로 있었는지 */
async function hasOwnCustomerCard(businessId: string, phone: string, before: Date, db: Db): Promise<boolean> {
  if (!phone) return false;
  const card = await db.businessCustomer.findFirst({
    where: { businessId, phone, source: { in: [...OWN_CUSTOMER_SOURCES] }, createdAt: { lt: before } },
    select: { id: true },
  });
  return card !== null;
}

const isPromoActive = (business: Pick<CommissionBusiness, "launchPromoUntil" | "launchPromoRemaining">, now: Date) =>
  business.launchPromoUntil !== null && business.launchPromoUntil.getTime() > now.getTime() && business.launchPromoRemaining > 0;

export interface ResolveCommissionInput {
  business: CommissionBusiness;
  /** 업종(상품 분류) 요율. 없으면 null */
  categoryCommissionBps: number | null;
  channel: BookingChannel;
  userId?: string | null;
  /** 예약자 전화번호 */
  phone: string;
  quantity: number;
  totalAmount: number;
  /** 온라인으로 결제하는 금액(전액 또는 예약금) */
  payNowAmount: number;
  settings: CommissionSettings;
  now?: Date;
  /** 예약을 만든 시각. '내 고객' 카드는 이 시각보다 먼저 만들어져 있어야 한다(기본값: now) */
  bookedAt?: Date;
  /** 이용 이력에서 뺄 예약(지금 판정하는 예약 자신) */
  excludeBookingId?: string;
}

async function gatherFacts(input: ResolveCommissionInput, db: Db): Promise<CommissionFacts> {
  assertAmounts(input);
  const now = input.now ?? new Date();
  const phone = digitsOnly(input.phone);
  const isNew = await isNewCustomerFor(
    input.business.id,
    { userId: input.userId, phone },
    { now, excludeBookingId: input.excludeBookingId, windowDays: input.settings.returningWindowDays },
    db,
  );
  // 직접 입력·자체 링크 예약은 채널만으로 규칙이 정해지므로 고객 카드를 볼 필요가 없다.
  const viaMarket = input.channel === "MARKETPLACE" || input.channel === "WAITLIST";
  return {
    channel: input.channel,
    plan: input.business.plan,
    overrideBps: input.business.commissionBps ?? input.categoryCommissionBps,
    hasOwnCustomerCard: viaMarket ? await hasOwnCustomerCard(input.business.id, phone, input.bookedAt ?? now, db) : false,
    promoActive: isPromoActive(input.business, now),
    isReturning: !isNew,
    quantity: input.quantity,
    totalAmount: input.totalAmount,
    payNowAmount: input.payNowAmount,
    settings: input.settings,
  };
}

/**
 * 수수료 규칙을 판정한다(필요한 조회 포함). 입점 프로모션 건수는 차감하지 않는다 —
 * 확정 트랜잭션에서는 snapshotCommission 을 쓴다.
 */
export async function resolveCommission(input: ResolveCommissionInput, db: Db = prisma): Promise<CommissionSnapshot> {
  return decideCommission(await gatherFacts(input, db));
}

// ── 입점 프로모션 ─────────────────────────────────────

/**
 * 입점 프로모션 1건 사용. 기간이 남아 있고 남은 건수가 있을 때만 조건부 UPDATE 로 1 줄인다.
 * false 면 프로모션이 끝난 것이므로 프로모션 없이 다시 판정해야 한다.
 */
export async function consumeLaunchPromo(tx: Tx, businessId: string, now: Date): Promise<boolean> {
  const updated = await tx.$executeRaw`
    UPDATE "Business"
    SET "launchPromoRemaining" = "launchPromoRemaining" - 1, "updatedAt" = ${new Date()}::timestamp
    WHERE "id" = ${businessId} AND "launchPromoUntil" > ${now}::timestamp AND "launchPromoRemaining" > 0`;
  return updated === 1;
}

/** snapshotCommission 에 넘기는 예약 값(Booking 행을 그대로 넘겨도 된다) */
export interface SnapshotCommissionInput {
  id: string;
  businessId: string;
  productId: string;
  channel: BookingChannel;
  userId: string | null;
  guestPhone: string;
  quantity: number;
  totalAmount: number;
  payNowAmount: number;
  createdAt: Date;
}

/**
 * 예약 확정 트랜잭션 안에서 부른다. 사업자·업종 요율을 읽어 규칙을 판정하고,
 * PROMO 로 판정되면 프로모션 건수를 1 차감한다. 그사이 프로모션이 소진됐으면 프로모션 없이 다시 판정한다.
 * 돌려준 값을 Booking 의 commissionRule / commissionBps / commissionAmount / pgFeeAmount / isNewCustomer 에 저장한다.
 */
export async function snapshotCommission(
  tx: Tx,
  booking: SnapshotCommissionInput,
  opts: { now?: Date; settings?: CommissionSettings } = {},
): Promise<CommissionSnapshot> {
  const now = opts.now ?? new Date();
  const settings = opts.settings ?? (await getSettings());
  const business = await tx.business.findUnique({
    where: { id: booking.businessId },
    select: { id: true, plan: true, commissionBps: true, launchPromoUntil: true, launchPromoRemaining: true },
  });
  if (!business) throw err.notFound("사업장을 찾을 수 없어요.");
  const product = await tx.product.findUnique({
    where: { id: booking.productId },
    select: { category: { select: { commissionBps: true } } },
  });

  const facts = await gatherFacts(
    {
      business,
      categoryCommissionBps: product?.category.commissionBps ?? null,
      channel: booking.channel,
      userId: booking.userId,
      phone: booking.guestPhone,
      quantity: booking.quantity,
      totalAmount: booking.totalAmount,
      payNowAmount: booking.payNowAmount,
      settings,
      now,
      bookedAt: booking.createdAt,
      excludeBookingId: booking.id,
    },
    tx,
  );
  const decided = decideCommission(facts);
  if (decided.rule !== "PROMO") return decided;
  if (await consumeLaunchPromo(tx, business.id, now)) return decided;
  return decideCommission({ ...facts, promoActive: false });
}

// ── 정산서 표시 ───────────────────────────────────────

/** 유입 세부 경로(Booking.source) 표시 이름 */
export const BOOKING_SOURCE_LABEL: Record<string, string> = {
  home: "홈",
  search: "검색",
  category: "분류 탐색",
  alert: "빈자리 알림",
  follow: "팔로우 알림",
  favorite: "찜 목록",
  share: "공유 링크",
  biz_link: "내 예약 링크",
  qr: "QR 코드",
  waitlist_offer: "대기 자리 제안",
  manual: "직접 입력",
  external: "외부 판매",
};

export interface CommissionDescription {
  /** 적용 규칙 이름. 확정 전이면 "확정 전" */
  ruleLabel: string;
  ruleDesc: string;
  /** "9.9%" / "0% + 결제 실비" / 확정 전이면 "-" */
  bpsText: string;
  channelLabel: string;
  /** 유입 세부 경로. 값이 없거나 모르는 값이면 채널 이름 */
  sourceLabel: string;
}

/** 정산서·예약 상세에서 건별 유입 경로와 적용 규칙을 보여 줄 문구 */
export function describeCommission(booking: {
  commissionRule: string | null;
  commissionBps: number;
  channel: BookingChannel;
  source: string | null;
}): CommissionDescription {
  const channelLabel = BOOKING_CHANNEL_LABEL[booking.channel];
  const sourceLabel = (booking.source ? BOOKING_SOURCE_LABEL[booking.source] : undefined) ?? channelLabel;
  const rule = booking.commissionRule;
  const info = rule ? COMMISSION_RULE_LABEL[rule] : undefined;
  if (!rule || !info) {
    return { ruleLabel: "확정 전", ruleDesc: "예약이 확정되면 수수료 규칙이 정해져요.", bpsText: "-", channelLabel, sourceLabel };
  }
  const rate = formatBps(booking.commissionBps);
  return {
    ruleLabel: info.label,
    ruleDesc: info.desc,
    bpsText: PG_FEE_RULES.has(rule) ? `${rate} + 결제 실비` : rate,
    channelLabel,
    sourceLabel,
  };
}
