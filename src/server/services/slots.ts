import "server-only";
import { z } from "zod";
import type {
  ActorType,
  BookingChannel,
  BookingStatus,
  PaymentMethod,
  PaymentState,
  Prisma,
  SeatGender,
  SlotStatus,
  VacancyOrigin,
} from "@/generated/prisma/client";
import { ACTIVE_BOOKING_STATUSES, SEAT_HOLDING_STATUSES, parseSeatTemplates } from "@/lib/domain";
import { maskPhone } from "@/lib/format";
import { formatKRW } from "@/lib/money";
import { findBannedPhrases } from "@/lib/policy";
import { DAY, MINUTE, fmtDateTime } from "@/lib/time";
import { audit } from "@/server/audit";
import { assertBusinessAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { AppError, err } from "@/server/errors";
import { announceVacancy } from "@/server/services/alerts";
import { confirmedCountBySeat, lockSeat, relistWithheld, releaseSeats } from "@/server/services/inventory";
import { notificationLinks, notifyBusinessMembers } from "@/server/services/notifications/events";
import { afterSeatsReleased } from "@/server/services/vacancy";
import { createExternalSaleBooking } from "./booking/create";
import { evaluateGoConfirmation, getGoState, markGoConfirmed, readGoProgress, type GoStateInfo } from "./booking/go";
import { cancelBookingCore } from "./booking/lifecycle";
import {
  JOB_BATCH,
  assertAdminRole,
  idSchema,
  lockKey,
  optionalText,
  parseInput,
  quantitySchema,
  reasonSchema,
  runTx,
  type AdminActor,
  type Tx,
} from "./booking/shared";

export { evaluateGoConfirmation, getGoState, type GoSlotInput, type GoStateInfo, type GoStateKind } from "./booking/go";

/**
 * 회차·좌석 관리(사업자)와 개최 확정 작업.
 * - 회차 만들기(일괄·빠른 등록·복제), 수정, 판매 마감·재개, 좌석 유형과 정원·가격 변경
 * - 보류 좌석 다시 올리기, 외부 판매 자리 기록, 회차 취소(예약 전액 환불)
 * - 개최 확정(docs 6.7): 수동 확정, 판정 시각이 지난 회차 정리
 *
 * 좌석 수(reserved·withheld)는 inventory.ts 의 조건부 UPDATE 로만 바꾼다. 정원(capacity)은 여기서 바꾸되
 * "예약된 수보다 줄일 수 없다"를 조건부 UPDATE 로 지킨다.
 * 잠금 순서(교착 방지): Slot → SlotSeat. 예약 트랜잭션은 회차 행을 공유 잠금으로 잡으므로,
 * 회차를 고치는 트랜잭션은 회차 행을 먼저 잠근 뒤 좌석을 건드린다.
 */

const MAX_PRICE = 10_000_000;
const MAX_SEAT_TYPES = 6;
const MAX_STARTS = 60;
/** 빠른 등록: 시작까지 이 시간이 안 남은 자리는 올릴 수 없다 */
const QUICK_POST_MIN_LEAD_MS = 5 * MINUTE;
/** 목록 조회 기간 상한 */
const MAX_LIST_RANGE_MS = 100 * DAY;
const MAX_LIST_SLOTS = 500;
/** 회차가 끝나고 이 기간이 지나면 예약자 연락처를 가린다 */
const CONTACT_RETENTION_MS = 30 * DAY;
const UNDERFILLED_REASON = "최소 인원이 모이지 않아 열리지 않게 됐어요";

const MSG_SLOT_NOT_FOUND = "회차를 찾을 수 없어요.";
const MSG_SEAT_NOT_FOUND = "좌석을 찾을 수 없어요.";
const MSG_ORIGINAL_PRICE = "기준가는 이 상품의 정가를 넘을 수 없어요.";

const SINGLE_LINE = /^[^\p{Cc}]*$/u;

// ── 입력 스키마 ───────────────────────────────────────

const priceSchema = (label: string) =>
  z
    .number(`${label}을 숫자로 입력해 주세요.`)
    .int(`${label}은 원 단위 정수로 입력해 주세요.`)
    .min(0, `${label}은 0원 이상이어야 해요.`)
    .max(MAX_PRICE, `${label}은 ${formatKRW(MAX_PRICE)}까지 입력할 수 있어요.`);

const labelSchema = z
  .string("좌석 이름을 입력해 주세요.")
  .trim()
  .min(1, "좌석 이름을 입력해 주세요.")
  .max(12, "좌석 이름은 12자까지 쓸 수 있어요.")
  .regex(SINGLE_LINE, "좌석 이름에 쓸 수 없는 문자가 있어요.");

const capacitySchema = (min: number) =>
  z
    .number("정원을 숫자로 입력해 주세요.")
    .int("정원은 정수로 입력해 주세요.")
    .min(min, `정원은 ${min}명 이상이어야 해요.`)
    .max(500, "정원은 500명까지 정할 수 있어요.");

const minCountSchema = z
  .number("최소 인원을 숫자로 입력해 주세요.")
  .int("최소 인원은 정수로 입력해 주세요.")
  .min(0, "최소 인원은 0명 이상이어야 해요.")
  .max(500, "최소 인원은 정원보다 클 수 없어요.");

const seatSchema = z.object({
  label: labelSchema,
  gender: z.enum(["ANY", "MALE", "FEMALE"], "좌석의 성별 구분을 골라 주세요.").default("ANY"),
  capacity: capacitySchema(1),
  price: priceSchema("좌석 가격"),
  originalPrice: priceSchema("기준가").nullish(),
  minCount: minCountSchema.default(0),
});

const seatsSchema = z
  .array(seatSchema, "좌석 구성을 하나 이상 넣어 주세요.")
  .min(1, "좌석 구성을 하나 이상 넣어 주세요.")
  .max(MAX_SEAT_TYPES, `좌석 구성은 ${MAX_SEAT_TYPES}개까지 만들 수 있어요.`);

const noteSchema = z
  .string("메모를 확인해 주세요.")
  .trim()
  .max(80, "한 줄 메모는 80자까지 쓸 수 있어요.")
  .regex(SINGLE_LINE, "한 줄 메모에 쓸 수 없는 문자가 있어요.")
  .nullish()
  .transform((value) => value || null);

const deadlineSchema = z
  .number("예약 마감 기준을 숫자로 입력해 주세요.")
  .int("예약 마감 기준은 분 단위 정수로 입력해 주세요.")
  .min(0, "예약 마감 기준은 0분 이상이어야 해요.")
  .max(1440, "예약 마감은 시작 24시간(1,440분) 전까지 정할 수 있어요.");

const startSchema = z.date("시작 시각을 확인해 주세요.");
const startsSchema = z
  .array(startSchema, "시작 시각을 하나 이상 골라 주세요.")
  .min(1, "시작 시각을 하나 이상 골라 주세요.")
  .max(MAX_STARTS, `한 번에 ${MAX_STARTS}개까지 만들 수 있어요.`);

const createSchema = z.object({
  productId: idSchema,
  starts: startsSchema,
  durationMin: z
    .number("진행 시간을 숫자로 입력해 주세요.")
    .int("진행 시간은 분 단위 정수로 입력해 주세요.")
    .min(10, "진행 시간은 10분 이상이어야 해요.")
    .max(1440, "진행 시간은 24시간(1,440분)까지 정할 수 있어요.")
    .optional(),
  deadlineMinBefore: deadlineSchema.optional(),
  seats: seatsSchema.optional(),
  decideMinBefore: z
    .number("개최 판정 시점을 숫자로 입력해 주세요.")
    .int("개최 판정 시점은 분 단위 정수로 입력해 주세요.")
    .min(60, "개최 판정은 시작 1시간 전보다 일러야 해요.")
    .max(10_080, "개최 판정은 시작 7일(10,080분) 전까지 정할 수 있어요.")
    .optional(),
  origin: z.enum(["REGULAR", "CANCELLATION", "NO_SHOW", "UNSOLD"], "공석 종류를 골라 주세요.").default("REGULAR"),
  note: noteSchema,
});

const quickSchema = z.object({
  productId: idSchema,
  startAt: startSchema,
  seats: z
    .array(seatSchema.omit({ minCount: true }), "좌석을 하나 이상 넣어 주세요.")
    .min(1, "좌석을 하나 이상 넣어 주세요.")
    .max(MAX_SEAT_TYPES, `좌석 구성은 ${MAX_SEAT_TYPES}개까지 만들 수 있어요.`),
  origin: z.enum(["CANCELLATION", "NO_SHOW", "UNSOLD"], "자리가 생긴 이유를 골라 주세요."),
  note: noteSchema,
  deadlineMinBefore: deadlineSchema.optional(),
});

const updateSlotSchema = z.object({
  note: noteSchema.optional(),
  deadlineMinBefore: deadlineSchema.optional(),
  origin: z.enum(["REGULAR", "CANCELLATION", "NO_SHOW", "UNSOLD"], "공석 종류를 골라 주세요.").optional(),
});

const updateSeatSchema = z.object({
  label: labelSchema.optional(),
  capacity: capacitySchema(0).optional(),
  price: priceSchema("좌석 가격").optional(),
  originalPrice: priceSchema("기준가").nullable().optional(),
  minCount: minCountSchema.optional(),
});

export type SeatInput = z.input<typeof seatSchema>;
export type CreateSlotsInput = z.input<typeof createSchema>;
export type QuickPostInput = z.input<typeof quickSchema>;
export type UpdateSlotInput = z.input<typeof updateSlotSchema>;
export type UpdateSeatInput = z.input<typeof updateSeatSchema>;

type SeatData = z.output<typeof seatSchema>;

export type SlotWithSeats = Prisma.SlotGetPayload<{ include: { seats: true } }>;

// ── 문구·가격 규칙(docs 6.10) ─────────────────────────

function assertNoBannedPhrase(...texts: (string | null | undefined)[]): void {
  const found = findBannedPhrases(...texts)[0];
  if (found) throw err.validation(`"${found.phrase}"은(는) 쓸 수 없는 표현이에요. ${found.reason}`);
}

interface PricedProduct {
  basePrice: number;
  seatTemplates: unknown;
}

/** 이 좌석의 정가: 상품 좌석 구성에서 이름이 같은 좌석의 가격, 없으면 상품 정가 */
function regularPriceOf(product: PricedProduct, label: string): number {
  return parseSeatTemplates(product.seatTemplates).find((template) => template.label === label)?.price ?? product.basePrice;
}

/** 기준가는 판매 가격보다 높아야 하고, 그 상품의 정가를 넘을 수 없다(부풀린 할인 표시 방지). */
function assertOriginalPrice(product: PricedProduct, seat: { label: string; price: number; originalPrice?: number | null }): void {
  if (seat.originalPrice == null) return;
  if (seat.originalPrice <= seat.price) throw err.validation("기준가는 판매 가격보다 높아야 해요. 할인하는 자리가 아니면 기준가를 비워 주세요.");
  if (seat.originalPrice > regularPriceOf(product, seat.label)) throw err.validation(MSG_ORIGINAL_PRICE);
}

function assertSeats(product: PricedProduct, seats: SeatData[]): void {
  const labels = new Set<string>();
  for (const seat of seats) {
    if (labels.has(seat.label)) throw err.validation(`좌석 이름 "${seat.label}"이(가) 겹쳐요. 서로 다른 이름을 써 주세요.`);
    labels.add(seat.label);
    if (seat.minCount > seat.capacity) throw err.validation("최소 인원은 정원보다 클 수 없어요.");
    assertOriginalPrice(product, seat);
  }
  assertNoBannedPhrase(...seats.map((seat) => seat.label));
}

// ── 회차 만들기 ───────────────────────────────────────

interface SlotPlan {
  startAt: Date;
  endAt: Date;
  bookingDeadlineAt: Date;
  decideAt: Date | null;
}

interface BuildOptions {
  starts: Date[];
  durationMin: number;
  deadlineMinBefore: number;
  decideMinBefore: number | null;
  /** 빠른 등록이면 예약 마감이 과거가 되지 않게 시작 시각으로 당긴다 */
  clampDeadline: boolean;
  hasMinimum: boolean;
  now: Date;
}

function planSlots(options: BuildOptions): SlotPlan[] {
  const { now } = options;
  const seen = new Set<number>();
  if (options.hasMinimum && options.decideMinBefore === null) {
    throw err.validation("최소 인원을 정했다면 개최 여부를 판정할 시점도 정해 주세요.", { decideMinBefore: "개최 판정 시점을 정해 주세요." });
  }
  return options.starts.map((startAt) => {
    const at = startAt.getTime();
    if (Number.isNaN(at)) throw err.validation("시작 시각을 확인해 주세요.");
    if (at <= now.getTime()) throw err.validation(`지난 시각(${fmtDateTime(startAt)})에는 회차를 만들 수 없어요.`);
    if (seen.has(at)) throw err.validation(`같은 시작 시각(${fmtDateTime(startAt)})이 두 번 들어 있어요.`);
    seen.add(at);

    let deadline = at - options.deadlineMinBefore * MINUTE;
    if (deadline <= now.getTime()) {
      if (!options.clampDeadline) {
        throw err.validation(`${fmtDateTime(startAt)} 회차는 예약 마감 시각이 이미 지났어요. 마감 기준을 줄이거나 시작 시각을 늦춰 주세요.`);
      }
      deadline = at;
    }
    let decideAt: Date | null = null;
    if (options.hasMinimum && options.decideMinBefore !== null) {
      decideAt = new Date(at - options.decideMinBefore * MINUTE);
      if (decideAt.getTime() <= now.getTime()) {
        throw err.validation(`${fmtDateTime(startAt)} 회차는 개최 판정 시각이 이미 지났어요. 판정 시점을 시작에 더 가깝게 정해 주세요.`);
      }
    }
    return { startAt, endAt: new Date(at + options.durationMin * MINUTE), bookingDeadlineAt: new Date(deadline), decideAt };
  });
}

interface SellableProduct extends PricedProduct {
  id: string;
  businessId: string;
  durationMin: number;
  business: { status: string; defaultDeadlineMin: number };
}

/** 그 사업장의 판매 중인 상품인지 확인하고 돌려준다(다른 사업장의 상품은 없는 것으로 답한다). */
async function loadSellableProduct(productId: string, businessId: string): Promise<SellableProduct> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      businessId: true,
      status: true,
      durationMin: true,
      basePrice: true,
      seatTemplates: true,
      business: { select: { status: true, defaultDeadlineMin: true } },
    },
  });
  if (!product || product.businessId !== businessId) throw err.notFound("상품을 찾을 수 없어요.");
  if (product.status !== "ACTIVE") throw err.validation("판매 중인 상품에만 회차를 만들 수 있어요. 상품을 먼저 판매 시작해 주세요.");
  return product;
}

/**
 * 회차를 한 트랜잭션으로 만든다. 같은 상품의 회차 만들기는 줄 세워, 같은 시작 시각의 회차가 두 번 생기지 않게 한다.
 * 취소되지 않은 회차가 같은 시각에 이미 있으면 VALIDATION.
 */
async function insertSlots(
  product: SellableProduct,
  plans: SlotPlan[],
  seats: SeatData[],
  origin: VacancyOrigin,
  note: string | null,
  now: Date,
): Promise<SlotWithSeats[]> {
  const created = await runTx(async (tx) => {
    await lockKey(tx, `slots:product:${product.id}`);
    const clash = await tx.slot.findFirst({
      where: { productId: product.id, status: { not: "CANCELLED" }, startAt: { in: plans.map((plan) => plan.startAt) } },
      orderBy: { startAt: "asc" },
      select: { startAt: true },
    });
    if (clash) {
      throw err.validation(`${fmtDateTime(clash.startAt)}에는 이미 회차가 있어요. 그 회차에서 정원을 늘리거나 자리를 다시 올려 주세요.`);
    }
    const slots: SlotWithSeats[] = [];
    for (const plan of plans) {
      slots.push(
        await tx.slot.create({
          data: {
            productId: product.id,
            businessId: product.businessId,
            ...plan,
            origin,
            note,
            vacancyPostedAt: now,
            seats: {
              create: seats.map((seat, index) => ({
                label: seat.label,
                gender: seat.gender,
                capacity: seat.capacity,
                price: seat.price,
                originalPrice: seat.originalPrice ?? null,
                minCount: seat.minCount,
                sort: index,
              })),
            },
          },
          include: { seats: { orderBy: { sort: "asc" } } },
        }),
      );
    }
    return slots;
  });
  // 승인된 사업장의 새 회차만 팔로워·맞춤 알림 회원에게 알린다.
  if (product.business.status === "APPROVED") {
    for (const slot of created) await announceVacancy(slot.id, { reason: "NEW" });
  }
  return created;
}

/**
 * 회차 일괄 만들기(매니저 이상). 시작 시각 1~60개에 같은 좌석 구성으로 회차를 만든다.
 * - 상품은 그 사업장의 판매 중(ACTIVE) 상품이어야 한다.
 * - 좌석을 주지 않으면 상품의 기본 좌석 구성을, 예약 마감을 주지 않으면 사업장 기본값(시작 N분 전)을 쓴다.
 * - 최소 인원(minCount)이 하나라도 있으면 개최 판정 시점(decideMinBefore, 시작 60~10,080분 전)이 필요하다.
 * - 기준가(originalPrice)는 판매 가격보다 높고 그 상품의 정가 이하여야 한다. 메모·좌석 이름에는 금칙어를 쓸 수 없다.
 */
export async function createSlots(actorUserId: string, businessId: string, input: CreateSlotsInput): Promise<SlotWithSeats[]> {
  const bizId = parseInput(idSchema, businessId);
  await assertBusinessAccess(actorUserId, bizId, "MANAGER");
  const data = parseInput(createSchema, input);
  const product = await loadSellableProduct(data.productId, bizId);
  const seats = data.seats ?? parseInput(seatsSchema, parseSeatTemplates(product.seatTemplates));
  assertSeats(product, seats);
  assertNoBannedPhrase(data.note);

  const now = new Date();
  const plans = planSlots({
    starts: data.starts,
    durationMin: data.durationMin ?? product.durationMin,
    deadlineMinBefore: data.deadlineMinBefore ?? Math.min(1440, Math.max(0, product.business.defaultDeadlineMin)),
    decideMinBefore: data.decideMinBefore ?? null,
    clampDeadline: false,
    hasMinimum: seats.some((seat) => seat.minCount > 0),
    now,
  });
  return insertSlots(product, plans, seats, data.origin, data.note, now);
}

/**
 * 빈자리 빠른 등록(스태프 이상) — 취소·노쇼·미판매로 생긴 자리를 회차 하나로 바로 올린다.
 * 시작까지 5분이 안 남았으면 올릴 수 없다. 예약 마감 기준이 이미 지난 시각이 되면 시작 시각까지 예약을 받는다.
 */
export async function quickPostVacancy(actorUserId: string, businessId: string, input: QuickPostInput): Promise<SlotWithSeats> {
  const bizId = parseInput(idSchema, businessId);
  await assertBusinessAccess(actorUserId, bizId, "STAFF");
  const data = parseInput(quickSchema, input);
  const product = await loadSellableProduct(data.productId, bizId);
  const seats = data.seats.map((seat) => ({ ...seat, minCount: 0 }));
  assertSeats(product, seats);
  assertNoBannedPhrase(data.note);

  const now = new Date();
  if (data.startAt.getTime() - now.getTime() < QUICK_POST_MIN_LEAD_MS) {
    throw err.validation("시작까지 5분이 안 남은 자리는 올릴 수 없어요.");
  }
  const plans = planSlots({
    starts: [data.startAt],
    durationMin: product.durationMin,
    deadlineMinBefore: data.deadlineMinBefore ?? Math.min(1440, Math.max(0, product.business.defaultDeadlineMin)),
    decideMinBefore: null,
    clampDeadline: true,
    hasMinimum: false,
    now,
  });
  const [slot] = await insertSlots(product, plans, seats, data.origin, data.note, now);
  if (!slot) throw new Error("회차를 만들지 못했습니다.");
  return slot;
}

// ── 회차 불러오기(권한 확인 포함) ─────────────────────

const managedSlotSelect = {
  id: true,
  businessId: true,
  productId: true,
  status: true,
  startAt: true,
  endAt: true,
  bookingDeadlineAt: true,
  decideAt: true,
  goConfirmedAt: true,
  origin: true,
  note: true,
  product: { select: { id: true, businessId: true, status: true, title: true, durationMin: true, basePrice: true, seatTemplates: true } },
  business: { select: { status: true, defaultDeadlineMin: true, slug: true } },
  seats: { orderBy: { sort: "asc" } },
} satisfies Prisma.SlotSelect;

type ManagedSlot = Prisma.SlotGetPayload<{ select: typeof managedSlotSelect }>;

async function loadManagedSlot(actorUserId: string, slotId: string, minRole: "STAFF" | "MANAGER"): Promise<ManagedSlot> {
  const slot = await prisma.slot.findUnique({ where: { id: parseInput(idSchema, slotId) }, select: managedSlotSelect });
  if (!slot) throw err.notFound(MSG_SLOT_NOT_FOUND);
  await assertBusinessAccess(actorUserId, slot.businessId, minRole);
  return slot;
}

async function loadManagedSeat(actorUserId: string, slotSeatId: string, minRole: "STAFF" | "MANAGER") {
  const seat = await prisma.slotSeat.findUnique({ where: { id: parseInput(idSchema, slotSeatId) }, select: { id: true, slotId: true } });
  if (!seat) throw err.notFound(MSG_SEAT_NOT_FOUND);
  const slot = await loadManagedSlot(actorUserId, seat.slotId, minRole);
  const current = slot.seats.find((item) => item.id === seat.id);
  if (!current) throw err.notFound(MSG_SEAT_NOT_FOUND);
  return { slot, seat: current };
}

function assertEditable(slot: { status: SlotStatus; endAt: Date }, now: Date): void {
  if (slot.status === "CANCELLED") throw err.closed("취소된 회차는 고칠 수 없어요.");
  if (slot.endAt.getTime() <= now.getTime()) throw err.closed("이미 끝난 회차는 고칠 수 없어요.");
}

const lockSlot = (tx: Tx, slotId: string) => tx.$queryRaw`SELECT "id" FROM "Slot" WHERE "id" = ${slotId} FOR UPDATE`;

/** 판매 중인 회차의 남은 자리를 대기자·알림 흐름에 태운다(회차 다시 열기·예약 마감 연장). */
async function announceOpenSeats(slotId: string): Promise<void> {
  const seats = await prisma.slotSeat.findMany({ where: { slotId }, select: { id: true, capacity: true, reserved: true } });
  for (const seat of seats) {
    const remaining = seat.capacity - seat.reserved;
    if (remaining > 0) await afterSeatsReleased(seat.id, { reason: "REOPEN", quantity: remaining, withheld: false });
  }
}

// ── 회차 복제·수정·마감 ───────────────────────────────

/**
 * 회차 복제(매니저 이상). 좌석 구성·가격·최소 인원·진행 시간·예약 마감·판정 시점을 그대로 쓰고 재고는 새로 시작한다.
 * 새 회차는 일반 판매(REGULAR)로 만들어진다.
 */
export async function duplicateSlot(actorUserId: string, slotId: string, starts: Date[]): Promise<SlotWithSeats[]> {
  const source = await loadManagedSlot(actorUserId, slotId, "MANAGER");
  const times = parseInput(startsSchema, starts);
  const product = await loadSellableProduct(source.productId, source.businessId);
  const seats: SeatData[] = source.seats.map((seat) => ({
    label: seat.label,
    gender: seat.gender,
    capacity: Math.max(1, seat.capacity),
    price: seat.price,
    originalPrice: seat.originalPrice,
    minCount: Math.min(seat.minCount, Math.max(1, seat.capacity)),
  }));
  assertSeats(product, seats);
  assertNoBannedPhrase(source.note);

  const now = new Date();
  const hasMinimum = seats.some((seat) => seat.minCount > 0);
  const plans = planSlots({
    starts: times,
    durationMin: Math.max(1, Math.round((source.endAt.getTime() - source.startAt.getTime()) / MINUTE)),
    deadlineMinBefore: Math.max(0, Math.round((source.startAt.getTime() - source.bookingDeadlineAt.getTime()) / MINUTE)),
    decideMinBefore: source.decideAt ? Math.round((source.startAt.getTime() - source.decideAt.getTime()) / MINUTE) : null,
    clampDeadline: false,
    hasMinimum,
    now,
  });
  return insertSlots(product, plans, seats, "REGULAR", source.note, now);
}

/**
 * 회차 수정(매니저 이상): 한 줄 메모, 예약 마감(시작 N분 전), 공석 종류.
 * 지나 있던 예약 마감을 다시 미래로 늦추면 남은 자리를 대기자·알림 흐름에 다시 태운다.
 */
export async function updateSlot(actorUserId: string, slotId: string, input: UpdateSlotInput): Promise<SlotWithSeats> {
  const slot = await loadManagedSlot(actorUserId, slotId, "MANAGER");
  const data = parseInput(updateSlotSchema, input);
  const now = new Date();
  assertEditable(slot, now);
  if (data.note !== undefined) assertNoBannedPhrase(data.note);

  const update: Prisma.SlotUncheckedUpdateInput = {};
  if (data.note !== undefined) update.note = data.note;
  if (data.origin !== undefined) update.origin = data.origin;
  let reopened = false;
  if (data.deadlineMinBefore !== undefined) {
    const deadline = new Date(slot.startAt.getTime() - data.deadlineMinBefore * MINUTE);
    update.bookingDeadlineAt = deadline;
    reopened = slot.status === "OPEN" && slot.bookingDeadlineAt.getTime() <= now.getTime() && deadline.getTime() > now.getTime();
    if (reopened) update.vacancyPostedAt = now;
  }
  const updated = await prisma.slot.update({ where: { id: slot.id }, data: update, include: { seats: { orderBy: { sort: "asc" } } } });
  if (reopened) await announceOpenSeats(slot.id);
  return updated;
}

/** 판매 마감(매니저 이상): OPEN → CLOSED. 기존 예약과 대기는 그대로 둔다. */
export async function closeSlot(actorUserId: string, slotId: string): Promise<{ status: SlotStatus }> {
  const slot = await loadManagedSlot(actorUserId, slotId, "MANAGER");
  const updated = await prisma.slot.updateMany({ where: { id: slot.id, status: "OPEN" }, data: { status: "CLOSED" } });
  if (updated.count !== 1) throw err.conflict("판매 중인 회차만 마감할 수 있어요.");
  return { status: "CLOSED" };
}

/** 판매 재개(매니저 이상): CLOSED → OPEN. 시작 전 회차만 가능하고, 남은 자리를 대기자·알림 흐름에 다시 태운다. */
export async function reopenSlot(actorUserId: string, slotId: string): Promise<{ status: SlotStatus }> {
  const slot = await loadManagedSlot(actorUserId, slotId, "MANAGER");
  const now = new Date();
  if (slot.startAt.getTime() <= now.getTime()) throw err.closed("이미 시작한 회차는 다시 열 수 없어요.");
  const updated = await prisma.slot.updateMany({ where: { id: slot.id, status: "CLOSED" }, data: { status: "OPEN", vacancyPostedAt: now } });
  if (updated.count !== 1) throw err.conflict("판매를 마감한 회차만 다시 열 수 있어요.");
  await announceOpenSeats(slot.id);
  return { status: "OPEN" };
}

// ── 좌석 ──────────────────────────────────────────────

function assertMinCountAllowed(slot: { decideAt: Date | null; goConfirmedAt: Date | null }, minCount: number, changed: boolean, now: Date): void {
  if (!changed) return;
  if (slot.goConfirmedAt) throw err.conflict("개최가 확정된 뒤에는 최소 인원을 바꿀 수 없어요.");
  if (minCount > 0 && (!slot.decideAt || slot.decideAt.getTime() <= now.getTime())) {
    throw err.validation("개최 판정 시각이 없거나 이미 지난 회차에는 최소 인원을 새로 정할 수 없어요.");
  }
}

export type SlotSeatRow = SlotWithSeats["seats"][number];

/**
 * 좌석 수정(매니저 이상): 이름·정원·가격·기준가·최소 인원.
 * - 정원은 이미 잡힌 자리(예약 + 보류)보다 줄일 수 없다. 늘리면 새 자리가 생긴 것으로 보고 대기자·알림 흐름을 탄다.
 * - 가격을 바꿔도 이미 들어온 예약의 금액은 바뀌지 않는다.
 * - 최소 인원은 개최 확정 뒤에는 바꿀 수 없다. 낮춰서 조건이 채워지면 바로 개최가 확정된다.
 */
export async function updateSeat(actorUserId: string, slotSeatId: string, input: UpdateSeatInput): Promise<SlotSeatRow> {
  const { slot, seat } = await loadManagedSeat(actorUserId, slotSeatId, "MANAGER");
  const data = parseInput(updateSeatSchema, input);
  const now = new Date();
  assertEditable(slot, now);

  const label = data.label ?? seat.label;
  const price = data.price ?? seat.price;
  const originalPrice = data.originalPrice === undefined ? seat.originalPrice : data.originalPrice;
  const minCount = data.minCount ?? seat.minCount;
  if (label !== seat.label) {
    if (slot.seats.some((other) => other.id !== seat.id && other.label === label)) {
      throw err.validation(`좌석 이름 "${label}"이(가) 겹쳐요. 서로 다른 이름을 써 주세요.`);
    }
    assertNoBannedPhrase(label);
  }
  // 기준가는 이번에 가격·기준가·이름 중 하나라도 바꿀 때 다시 확인한다.
  if (data.label !== undefined || data.price !== undefined || data.originalPrice !== undefined) {
    assertOriginalPrice(slot.product, { label, price, originalPrice });
  }
  assertMinCountAllowed(slot, minCount, minCount !== seat.minCount, now);

  const result = await runTx(async (tx) => {
    await lockSlot(tx, slot.id);
    const current = await lockSeat(tx, seat.id);
    const capacity = data.capacity ?? current.capacity;
    // 개최가 확정된 뒤의 최소 인원은 더는 쓰이지 않으므로, 정원을 줄일 때는 정원에 맞춰 함께 낮춘다.
    const finalMinCount = slot.goConfirmedAt && data.minCount === undefined ? Math.min(minCount, capacity) : minCount;
    if (finalMinCount > capacity) throw err.validation("최소 인원은 정원보다 클 수 없어요.");
    if (capacity !== current.capacity) {
      const changed = await tx.$executeRaw`
        UPDATE "SlotSeat" SET "capacity" = ${capacity}, "minCount" = LEAST("minCount", ${capacity}::int), "updatedAt" = ${now}::timestamp
        WHERE "id" = ${seat.id} AND "reserved" <= ${capacity}`;
      if (changed !== 1) {
        throw err.validation(`이미 예약됐거나 보류 중인 자리가 ${current.reserved}석 있어요. 정원을 그보다 줄일 수 없어요.`);
      }
    }
    const row = await tx.slotSeat.update({ where: { id: seat.id }, data: { label, price, originalPrice, minCount: finalMinCount } });
    const added = capacity - current.capacity;
    if (added > 0) await tx.slot.update({ where: { id: slot.id }, data: { vacancyPostedAt: now } });
    return { row, added };
  });

  if (result.added > 0) await afterSeatsReleased(seat.id, { reason: "CAPACITY", quantity: result.added, withheld: false });
  if (minCount !== seat.minCount) await evaluateGoConfirmation(slot.id);
  return result.row;
}

/** 좌석 유형 추가(매니저 이상, 회차당 6개까지). 새 자리가 생긴 것이므로 대기자·알림 흐름을 탄다. */
export async function addSeatType(actorUserId: string, slotId: string, input: SeatInput): Promise<SlotSeatRow> {
  const slot = await loadManagedSlot(actorUserId, slotId, "MANAGER");
  const data = parseInput(seatSchema, input);
  const now = new Date();
  assertEditable(slot, now);
  assertSeats(slot.product, [data]);
  assertMinCountAllowed(slot, data.minCount, data.minCount > 0, now);

  const row = await runTx(async (tx) => {
    await lockSlot(tx, slot.id);
    const existing = await tx.slotSeat.findMany({ where: { slotId: slot.id }, select: { label: true, sort: true } });
    if (existing.length >= MAX_SEAT_TYPES) throw err.validation(`좌석 구성은 ${MAX_SEAT_TYPES}개까지 만들 수 있어요.`);
    if (existing.some((other) => other.label === data.label)) {
      throw err.validation(`좌석 이름 "${data.label}"이(가) 겹쳐요. 서로 다른 이름을 써 주세요.`);
    }
    const created = await tx.slotSeat.create({
      data: {
        slotId: slot.id,
        label: data.label,
        gender: data.gender,
        capacity: data.capacity,
        price: data.price,
        originalPrice: data.originalPrice ?? null,
        minCount: data.minCount,
        sort: existing.reduce((max, other) => Math.max(max, other.sort), -1) + 1,
      },
    });
    await tx.slot.update({ where: { id: slot.id }, data: { vacancyPostedAt: now } });
    return created;
  });
  await afterSeatsReleased(row.id, { reason: "CAPACITY", quantity: row.capacity, withheld: false });
  return row;
}

/**
 * 좌석 유형 삭제(매니저 이상). 잡힌 자리가 없고(예약·보류 0), 진행 중인 대기가 없고, 예약 이력이 없는 좌석만 지울 수 있다.
 * 예약 이력이 있는 좌석은 정원을 줄여 판매를 멈춘다. 회차에는 좌석 유형이 하나 이상 남아야 한다.
 */
export async function removeSeatType(actorUserId: string, slotSeatId: string): Promise<void> {
  const { slot, seat } = await loadManagedSeat(actorUserId, slotSeatId, "MANAGER");
  assertEditable(slot, new Date());

  await runTx(async (tx) => {
    await lockSlot(tx, slot.id);
    const current = await lockSeat(tx, seat.id);
    if (current.reserved > 0) throw err.validation("예약됐거나 보류 중인 자리가 있는 좌석은 지울 수 없어요.");
    const waiting = await tx.waitlistEntry.count({ where: { slotSeatId: seat.id, status: { in: ["WAITING", "OFFERED"] } } });
    if (waiting > 0) throw err.validation("대기 중인 고객이 있는 좌석은 지울 수 없어요.");
    if ((await tx.slotSeat.count({ where: { slotId: slot.id } })) <= 1) throw err.validation("좌석 구성은 하나 이상 있어야 해요.");
    if ((await tx.booking.count({ where: { slotSeatId: seat.id } })) > 0) {
      throw err.validation("예약 이력이 있는 좌석은 지울 수 없어요. 정원을 줄여 판매를 멈춰 주세요.");
    }
    await tx.slotSeat.delete({ where: { id: seat.id } });
  });
  // 채워지지 않던 좌석 유형이 사라지면 남은 조건만으로 개최가 확정될 수 있다.
  if (seat.minCount > 0) await evaluateGoConfirmation(slot.id);
}

/**
 * 보류 좌석 다시 올리기(스태프 이상). 취소로 닫혀 있던 좌석(withheld)을 다시 공개한다.
 * 회차를 취소석(CANCELLATION)으로 표시하고 등록 시각을 지금으로 바꾼 뒤, 대기자·알림 흐름을 탄다.
 * qty 를 생략하면 보류분 전부를 올린다.
 */
export async function relistSeats(actorUserId: string, slotSeatId: string, qty?: number): Promise<{ relisted: number; remaining: number }> {
  const { slot, seat } = await loadManagedSeat(actorUserId, slotSeatId, "STAFF");
  const count = qty === undefined ? undefined : parseInput(quantitySchema, qty);
  const now = new Date();
  if (slot.status === "CANCELLED") throw err.closed("취소된 회차의 자리는 다시 올릴 수 없어요.");
  if (slot.startAt.getTime() <= now.getTime()) throw err.closed("이미 시작한 회차의 자리는 다시 올릴 수 없어요.");

  const result = await runTx(async (tx) => {
    await lockSlot(tx, slot.id);
    const relisted = await relistWithheld(tx, seat.id, count);
    if (relisted === 0) throw err.validation("다시 올릴 보류 좌석이 없어요.");
    await tx.slot.update({ where: { id: slot.id }, data: { origin: "CANCELLATION", vacancyPostedAt: now } });
    const current = await lockSeat(tx, seat.id);
    return { relisted, remaining: current.capacity - current.reserved };
  });
  await afterSeatsReleased(seat.id, { reason: "RELIST", quantity: result.relisted, withheld: false });
  return result;
}

// ── 외부 판매 ─────────────────────────────────────────

export interface ExternalSaleResult {
  bookingId: string;
  code: string;
  quantity: number;
  /** 기록한 뒤 남은 자리 */
  remaining: number;
}

async function remainingOf(slotSeatId: string): Promise<number> {
  const seat = await prisma.slotSeat.findUnique({ where: { id: slotSeatId }, select: { capacity: true, reserved: true } });
  return seat ? Math.max(0, seat.capacity - seat.reserved) : 0;
}

/**
 * 외부 판매 −1(스태프 이상): 다른 채널에서 팔린 자리를 한 번에 줄인다.
 * 직접 입력(MANUAL) 채널의 확정 예약으로 기록한다(예약자 "외부 예약", 연락처 없음, 금액 0원, 수수료 없음).
 */
export async function markExternalSale(actorUserId: string, slotSeatId: string, quantity: number, memo?: string | null): Promise<ExternalSaleResult> {
  const { seat } = await loadManagedSeat(actorUserId, slotSeatId, "STAFF");
  const qty = parseInput(quantitySchema, quantity);
  const note = parseInput(optionalText(500, "메모는 500자까지 쓸 수 있어요."), memo);
  const booking = await createExternalSaleBooking(seat.id, qty, note);
  return { bookingId: booking.id, code: booking.code, quantity: booking.quantity, remaining: await remainingOf(seat.id) };
}

/** 외부 판매 기록 되돌리기(스태프 이상): 그 예약을 취소하고 자리를 바로 다시 공개한다(대기자·알림 흐름). */
export async function undoExternalSale(actorUserId: string, bookingId: string): Promise<{ remaining: number }> {
  const booking = await prisma.booking.findUnique({
    where: { id: parseInput(idSchema, bookingId) },
    select: { id: true, businessId: true, slotSeatId: true, channel: true, source: true, status: true },
  });
  if (!booking) throw err.notFound("예약을 찾을 수 없어요.");
  await assertBusinessAccess(actorUserId, booking.businessId, "STAFF");
  if (booking.channel !== "MANUAL" || booking.source !== "external") throw err.validation("외부 판매로 기록한 자리만 되돌릴 수 있어요.");
  if (booking.status !== "CONFIRMED") throw err.conflict("이미 되돌렸거나 처리가 끝난 기록이에요.");

  await cancelBookingCore({
    bookingId: booking.id,
    by: "SELLER",
    byId: actorUserId,
    reason: "외부 판매 기록 되돌림",
    to: "CANCELLED",
    from: ["CONFIRMED"],
    refund: "FULL",
    seats: "PUBLIC",
    // 취소석이 아니라 사업자가 다시 연 자리다.
    releaseReason: "CAPACITY",
    notify: "NONE",
  });
  return { remaining: await remainingOf(booking.slotSeatId) };
}

// ── 회차 취소 ─────────────────────────────────────────

export type SlotCancelActor = { type: "SELLER"; userId: string } | { type: "SYSTEM" } | { type: "ADMIN"; admin: AdminActor };

export interface CancelSlotResult {
  /** 이번 호출로 회차가 취소됐는지(이미 취소된 회차면 false) */
  cancelled: boolean;
  /** 전액 환불로 취소한 예약 수 */
  cancelledBookings: number;
  /** 환불이 실패해 운영자 재시도가 필요한 예약 수 */
  refundFailures: number;
}

/** 회차의 진행 중 예약을 모두 전액 환불로 취소한다. 그사이 상태가 바뀐 예약은 다음 바퀴에서 다시 본다. */
async function cancelSlotBookings(slotId: string, by: ActorType, byId: string | null, reason: string): Promise<{ cancelled: number; refundFailures: number }> {
  let cancelled = 0;
  let refundFailures = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const active = await prisma.booking.findMany({ where: { slotId, status: { in: ACTIVE_BOOKING_STATUSES } }, select: { id: true } });
    if (active.length === 0) break;
    for (const { id } of active) {
      try {
        const result = await cancelBookingCore({
          bookingId: id,
          by,
          byId,
          reason,
          to: "CANCELLED",
          from: ["PENDING_PAYMENT", "PENDING_APPROVAL", "CONFIRMED"],
          refund: "FULL",
          seats: "PUBLIC",
          releaseReason: null,
          notify: { slotCancelled: reason },
        });
        cancelled += 1;
        if (result.refund.status === "FAILED") refundFailures += 1;
      } catch (e) {
        // 동시에 같은 예약을 처리한 요청이 있으면(상태 충돌) 넘어간다. 그 밖의 오류는 남긴다.
        if (!(e instanceof AppError)) console.error(`[slots] 회차 취소 중 예약 취소 실패 booking=${id}`, e);
      }
    }
  }
  return { cancelled, refundFailures };
}

/**
 * 회차 취소의 공통 구현.
 * 트랜잭션: 회차를 CANCELLED 로(조건부 — 한 번만 성공), 대기를 CLOSED 로(제안 중이던 좌석 홀드 반환), 재판매 환불 대기 정리.
 * 그 뒤 진행 중 예약을 모두 전액 환불로 취소하고 고객에게 사유와 함께 알린다.
 * onlyIfUndecided: 개최가 아직 확정되지 않았을 때만 취소한다(최소 인원 미달 판정용 — 그사이 확정됐으면 취소하지 않는다).
 */
async function cancelSlotCore(
  slotId: string,
  by: ActorType,
  byId: string | null,
  reason: string,
  options: { onlyIfUndecided?: boolean; now?: Date } = {},
): Promise<CancelSlotResult> {
  const now = options.now ?? new Date();
  const changed = await runTx(async (tx) => {
    const updated = await tx.slot.updateMany({
      where: { id: slotId, status: { in: ["OPEN", "CLOSED"] }, ...(options.onlyIfUndecided ? { goConfirmedAt: null } : {}) },
      data: { status: "CANCELLED", cancelledAt: now, cancelReason: reason },
    });
    if (updated.count !== 1) return false;
    await tx.waitlistEntry.updateMany({ where: { slotId, status: "WAITING" }, data: { status: "CLOSED" } });
    const offered = await tx.waitlistEntry.findMany({ where: { slotId, status: "OFFERED" }, select: { id: true, slotSeatId: true, quantity: true } });
    for (const entry of offered) {
      const closed = await tx.waitlistEntry.updateMany({ where: { id: entry.id, status: "OFFERED" }, data: { status: "CLOSED" } });
      if (closed.count === 1 && !(await releaseSeats(tx, entry.slotSeatId, entry.quantity, { withhold: false }))) {
        throw new Error(`좌석 재고와 자리 제안이 어긋났습니다: entry=${entry.id}`);
      }
    }
    await tx.booking.updateMany({ where: { slotId, resalePendingQty: { gt: 0 } }, data: { resalePendingQty: 0 } });
    return true;
  });
  if (!changed && options.onlyIfUndecided) return { cancelled: false, cancelledBookings: 0, refundFailures: 0 };

  const bookings = await cancelSlotBookings(slotId, by, byId, reason);
  return { cancelled: changed, cancelledBookings: bookings.cancelled, refundFailures: bookings.refundFailures };
}

/** 사업자가 직접 취소한 경우가 아니면 사업장 구성원에게 회차 취소를 알린다. */
async function notifySellerSlotCancelled(slotId: string, reason: string, cancelledBookings: number): Promise<void> {
  const slot = await prisma.slot.findUnique({
    where: { id: slotId },
    select: { id: true, businessId: true, startAt: true, product: { select: { title: true } } },
  });
  if (!slot) return;
  await notifyBusinessMembers(slot.businessId, {
    type: "SLOT_CANCELLED",
    title: "회차가 취소됐어요",
    body: [
      `${slot.product.title} · ${fmtDateTime(slot.startAt)}`,
      `사유: ${reason.slice(0, 120)}`,
      cancelledBookings > 0 ? `예약 ${cancelledBookings}건을 전액 환불로 취소하고 고객에게 알렸어요.` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    linkUrl: notificationLinks.sellerSlot(slot.id),
    data: { slotId: slot.id },
    dedupeKey: `SLOT_CANCELLED:${slot.id}:seller`,
  });
}

/**
 * 회차 취소. 결제 대기·승인 대기·확정 예약을 모두 전액 환불로 취소하고, 대기를 닫고, 고객에게 사유와 함께 알린다.
 * - SELLER: 매니저 이상, 회차 시작 전까지만.
 * - ADMIN: OPS·CS·SUPER. SYSTEM: 주기 작업(최소 인원 미달 등).
 * 이미 취소된 회차를 사업자가 다시 취소하면 CONFLICT. 운영자·시스템이 다시 부르면 남아 있는 진행 중 예약만 마저 정리한다.
 */
export async function cancelSlot(actor: SlotCancelActor, slotId: string, reason: string): Promise<CancelSlotResult> {
  const id = parseInput(idSchema, slotId);
  const why = parseInput(reasonSchema(200), reason);
  const slot = await prisma.slot.findUnique({ where: { id }, select: { id: true, businessId: true, status: true, startAt: true } });
  if (!slot) throw err.notFound(MSG_SLOT_NOT_FOUND);

  let byId: string | null = null;
  if (actor.type === "SELLER") {
    await assertBusinessAccess(actor.userId, slot.businessId, "MANAGER");
    if (slot.status === "CANCELLED") throw err.conflict("이미 취소된 회차예요.");
    if (slot.startAt.getTime() <= Date.now()) throw err.closed("이미 시작한 회차는 취소할 수 없어요. 도움이 필요하면 고객센터로 문의해 주세요.");
    byId = actor.userId;
  } else if (actor.type === "ADMIN") {
    await assertAdminRole(actor.admin, ["OPS", "CS"]);
    byId = actor.admin.id;
  }

  const result = await cancelSlotCore(id, actor.type, byId, why);
  if (actor.type === "SELLER" && !result.cancelled) throw err.conflict("이미 취소된 회차예요.");
  if (result.cancelled) {
    if (actor.type !== "SELLER") await notifySellerSlotCancelled(id, why, result.cancelledBookings);
    if (actor.type !== "SYSTEM") {
      await audit({
        actorId: byId,
        actorType: actor.type,
        action: "slot.cancel",
        targetType: "Slot",
        targetId: id,
        meta: { reason: why, cancelledBookings: result.cancelledBookings, refundFailures: result.refundFailures },
      });
    }
  }
  return result;
}

// ── 개최 확정 ─────────────────────────────────────────

/**
 * 사업자가 개최를 직접 확정한다(매니저 이상). 최소 인원을 못 채웠어도 진행하기로 한 경우에 쓴다.
 * 확정 예약 고객과 사업장 구성원에게 알린다. 한 번 확정하면 되돌릴 수 없다.
 */
export async function confirmSlotGo(actorUserId: string, slotId: string): Promise<{ goConfirmedAt: Date }> {
  const slot = await loadManagedSlot(actorUserId, slotId, "MANAGER");
  if (slot.status === "CANCELLED") throw err.closed("취소된 회차는 개최를 확정할 수 없어요.");
  if (slot.seats.every((seat) => seat.minCount <= 0)) throw err.validation("최소 인원 조건이 없는 회차예요. 따로 확정하지 않아도 예정대로 열려요.");
  if (slot.goConfirmedAt) throw err.conflict("이미 개최가 확정된 회차예요.");

  const now = new Date();
  if (!(await markGoConfirmed(slot.id, now))) throw err.conflict("이미 개최가 확정됐거나 취소된 회차예요.");
  await audit({ actorId: actorUserId, actorType: "SELLER", action: "slot.go_confirm", targetType: "Slot", targetId: slot.id });
  return { goConfirmedAt: now };
}

export interface DecideSlotsResult {
  /** 최소 인원을 채워 개최가 확정된 회차 수 */
  confirmed: number;
  /** 최소 인원 미달로 취소된 회차 수 */
  cancelled: number;
}

/**
 * 주기 작업: 판정 시각(decideAt)이 지났는데 개최가 확정되지 않은 회차를 정리한다.
 * 모든 좌석 유형이 최소 인원을 채웠으면 개최를 확정하고, 아니면 회차를 취소해 예약을 전액 환불한다.
 * 취소됐는데 진행 중 예약이 남아 있는 회차(처리 도중 끊긴 경우)도 마저 정리한다.
 * 조건부 UPDATE 로 점유한 회차만 처리하므로 동시에 여러 번 실행돼도 회차마다 한 번만 확정·취소된다.
 */
export async function decideDueSlots(now: Date = new Date()): Promise<DecideSlotsResult> {
  const due = await prisma.slot.findMany({
    where: { status: { in: ["OPEN", "CLOSED"] }, goConfirmedAt: null, decideAt: { lte: now } },
    orderBy: { decideAt: "asc" },
    take: JOB_BATCH,
    select: { id: true },
  });
  const result: DecideSlotsResult = { confirmed: 0, cancelled: 0 };
  for (const { id } of due) {
    try {
      const progress = await readGoProgress(id);
      if (!progress) continue;
      if (progress.met) {
        // 최소 인원 조건이 사라진 회차는 알림 없이 정리만 한다.
        if ((await markGoConfirmed(id, now, { silent: !progress.hasMinimum })) && progress.hasMinimum) result.confirmed += 1;
        continue;
      }
      const cancelled = await cancelSlotCore(id, "SYSTEM", null, UNDERFILLED_REASON, { onlyIfUndecided: true, now });
      if (cancelled.cancelled) {
        result.cancelled += 1;
        await notifySellerSlotCancelled(id, UNDERFILLED_REASON, cancelled.cancelledBookings);
      }
    } catch (e) {
      console.error(`[slots] 개최 판정 실패 slot=${id}`, e);
    }
  }

  const leftovers = await prisma.slot.findMany({
    where: { status: "CANCELLED", bookings: { some: { status: { in: ACTIVE_BOOKING_STATUSES } } } },
    take: JOB_BATCH,
    select: { id: true, cancelReason: true },
  });
  for (const slot of leftovers) {
    try {
      await cancelSlotBookings(slot.id, "SYSTEM", null, slot.cancelReason ?? "회차가 취소됐어요");
    } catch (e) {
      console.error(`[slots] 취소된 회차의 예약 정리 실패 slot=${slot.id}`, e);
    }
  }
  return result;
}

// ── 사업자 조회 ───────────────────────────────────────

export interface SellerSlotSeat {
  id: string;
  label: string;
  gender: SeatGender;
  capacity: number;
  /** 잡힌 자리 = 예약 + 결제 대기 + 승인 대기 + 대기자 제안 + 보류 */
  reserved: number;
  /** 취소로 닫혀 있어 다시 올릴 수 있는 좌석 수 */
  withheld: number;
  /** 남은 자리 = capacity − reserved */
  remaining: number;
  minCount: number;
  /** 확정 인원(확정 + 이용 완료 예약 수량) — 개최 확정 판정 기준 */
  confirmed: number;
  price: number;
  originalPrice: number | null;
  /** 차례를 기다리는 대기 건수 / 자리를 제안받아 응답을 기다리는 건수 */
  waiting: number;
  offered: number;
}

export interface SellerSlotItem {
  id: string;
  productId: string;
  productTitle: string;
  startAt: Date;
  endAt: Date;
  bookingDeadlineAt: Date;
  status: SlotStatus;
  origin: VacancyOrigin;
  note: string | null;
  vacancyPostedAt: Date;
  decideAt: Date | null;
  goConfirmedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  seats: SellerSlotSeat[];
  /** 상태별 예약 건수(좌석을 잡고 있는 예약만) */
  bookingCounts: { pendingPayment: number; pendingApproval: number; confirmed: number; completed: number; noShow: number };
  waitingCount: number;
  go: GoStateInfo;
  /** 사업자 자체 링크(이 링크로 들어온 예약은 DIRECT 채널) */
  publicPath: string;
}

const sellerSlotInclude = {
  seats: { orderBy: { sort: "asc" } },
  product: { select: { title: true } },
  business: { select: { slug: true } },
} satisfies Prisma.SlotInclude;

type SellerSlotRow = Prisma.SlotGetPayload<{ include: typeof sellerSlotInclude }>;

/**
 * 사업자 자체 링크: /slots/{id}?via={사업장 slug}. 이 링크로 들어와 예약하면 채널이 DIRECT 로 남는다.
 * 같은 사이트 안의 경로를 돌려주므로, 공유할 때는 서비스 주소를 앞에 붙인다.
 */
export function getSlotPublicLink(slot: { id: string; business: { slug: string } }): string {
  return `/slots/${slot.id}?via=${encodeURIComponent(slot.business.slug)}`;
}

const STATUS_COUNT_KEY: Partial<Record<BookingStatus, keyof SellerSlotItem["bookingCounts"]>> = {
  PENDING_PAYMENT: "pendingPayment",
  PENDING_APPROVAL: "pendingApproval",
  CONFIRMED: "confirmed",
  COMPLETED: "completed",
  NO_SHOW: "noShow",
};

async function toSellerSlots(rows: SellerSlotRow[]): Promise<SellerSlotItem[]> {
  if (rows.length === 0) return [];
  const slotIds = rows.map((row) => row.id);
  const [bookingGroups, waitGroups] = await Promise.all([
    prisma.booking.groupBy({
      by: ["slotId", "slotSeatId", "status"],
      where: { slotId: { in: slotIds }, status: { in: SEAT_HOLDING_STATUSES } },
      _sum: { quantity: true },
      _count: { _all: true },
    }),
    prisma.waitlistEntry.groupBy({
      by: ["slotSeatId", "status"],
      where: { slotId: { in: slotIds }, status: { in: ["WAITING", "OFFERED"] } },
      _count: { _all: true },
    }),
  ]);

  return rows.map((row) => {
    const bookingCounts = { pendingPayment: 0, pendingApproval: 0, confirmed: 0, completed: 0, noShow: 0 };
    const confirmedBySeat = new Map<string, number>();
    for (const group of bookingGroups) {
      if (group.slotId !== row.id) continue;
      const key = STATUS_COUNT_KEY[group.status];
      if (key) bookingCounts[key] += group._count._all;
      if (group.status === "CONFIRMED" || group.status === "COMPLETED") {
        confirmedBySeat.set(group.slotSeatId, (confirmedBySeat.get(group.slotSeatId) ?? 0) + (group._sum.quantity ?? 0));
      }
    }
    const seats = row.seats.map((seat): SellerSlotSeat => {
      const waits = waitGroups.filter((group) => group.slotSeatId === seat.id);
      return {
        id: seat.id,
        label: seat.label,
        gender: seat.gender,
        capacity: seat.capacity,
        reserved: seat.reserved,
        withheld: seat.withheld,
        remaining: Math.max(0, seat.capacity - seat.reserved),
        minCount: seat.minCount,
        confirmed: confirmedBySeat.get(seat.id) ?? 0,
        price: seat.price,
        originalPrice: seat.originalPrice,
        waiting: waits.find((group) => group.status === "WAITING")?._count._all ?? 0,
        offered: waits.find((group) => group.status === "OFFERED")?._count._all ?? 0,
      };
    });
    return {
      id: row.id,
      productId: row.productId,
      productTitle: row.product.title,
      startAt: row.startAt,
      endAt: row.endAt,
      bookingDeadlineAt: row.bookingDeadlineAt,
      status: row.status,
      origin: row.origin,
      note: row.note,
      vacancyPostedAt: row.vacancyPostedAt,
      decideAt: row.decideAt,
      goConfirmedAt: row.goConfirmedAt,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      seats,
      bookingCounts,
      waitingCount: seats.reduce((sum, seat) => sum + seat.waiting + seat.offered, 0),
      go: getGoState(row, confirmedBySeat),
      publicPath: getSlotPublicLink(row),
    };
  });
}

const listSchema = z.object({
  from: z.date("기간을 다시 골라 주세요."),
  to: z.date("기간을 다시 골라 주세요."),
  productId: idSchema.optional(),
  status: z.enum(["OPEN", "CLOSED", "CANCELLED"], "회차 상태를 다시 골라 주세요.").optional(),
});

export type SellerSlotQuery = z.input<typeof listSchema>;

/**
 * 사업장 회차 목록(스태프 이상). 시작 시각이 from 이상 to 미만인 회차를 시작이 빠른 순으로 준다(기간 100일, 500개까지).
 * 좌석별 정원·잡힌 자리·보류·최소 인원·확정 인원, 상태별 예약 건수, 대기 건수, 개최 상태를 함께 준다.
 */
export async function listSlotsForSeller(actorUserId: string, businessId: string, query: SellerSlotQuery): Promise<SellerSlotItem[]> {
  const bizId = parseInput(idSchema, businessId);
  await assertBusinessAccess(actorUserId, bizId, "STAFF");
  const { from, to, productId, status } = parseInput(listSchema, query);
  if (to.getTime() <= from.getTime()) throw err.validation("조회 기간을 다시 골라 주세요. 끝나는 날이 시작하는 날보다 뒤여야 해요.");
  if (to.getTime() - from.getTime() > MAX_LIST_RANGE_MS) throw err.validation("한 번에 100일까지 조회할 수 있어요. 기간을 줄여 주세요.");

  const rows = await prisma.slot.findMany({
    where: { businessId: bizId, startAt: { gte: from, lt: to }, ...(productId ? { productId } : {}), ...(status ? { status } : {}) },
    orderBy: [{ startAt: "asc" }, { id: "asc" }],
    take: MAX_LIST_SLOTS,
    include: sellerSlotInclude,
  });
  return toSellerSlots(rows);
}

export interface SellerSlotBooking {
  id: string;
  code: string;
  status: BookingStatus;
  channel: BookingChannel;
  seatId: string;
  seatLabel: string;
  guestName: string;
  /** 예약자 연락처. 회차가 끝나고 30일이 지나면 가린 번호만 준다 */
  guestPhone: string;
  quantity: number;
  totalAmount: number;
  payOnsiteAmount: number;
  paymentMethod: PaymentMethod;
  paymentState: PaymentState;
  attendanceConfirmedAt: Date | null;
  checkedInAt: Date | null;
  createdAt: Date;
  requestNote: string | null;
  sellerMemo: string | null;
}

export interface SellerSlotDetail extends SellerSlotItem {
  /** 좌석을 잡고 있는 예약(결제 대기·승인 대기·확정·이용 완료·노쇼), 예약한 순 */
  bookings: SellerSlotBooking[];
  /** 취소·거절된 예약 수 */
  cancelledCount: number;
  waitlist: { waiting: number; offered: number };
}

/** 회차 상세(스태프 이상): 좌석 현황, 참석자 명단(연락처 포함), 대기 요약. */
export async function getSlotForSeller(actorUserId: string, slotId: string): Promise<SellerSlotDetail> {
  const id = parseInput(idSchema, slotId);
  const row = await prisma.slot.findUnique({ where: { id }, include: sellerSlotInclude });
  if (!row) throw err.notFound(MSG_SLOT_NOT_FOUND);
  await assertBusinessAccess(actorUserId, row.businessId, "STAFF");

  const [items, bookings, cancelledCount] = await Promise.all([
    toSellerSlots([row]),
    prisma.booking.findMany({
      where: { slotId: id, status: { in: SEAT_HOLDING_STATUSES } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        code: true,
        status: true,
        channel: true,
        slotSeatId: true,
        guestName: true,
        guestPhone: true,
        quantity: true,
        totalAmount: true,
        payOnsiteAmount: true,
        paymentMethod: true,
        paymentState: true,
        attendanceConfirmedAt: true,
        checkedInAt: true,
        createdAt: true,
        requestNote: true,
        sellerMemo: true,
      },
    }),
    prisma.booking.count({ where: { slotId: id, status: { in: ["CANCELLED", "REJECTED"] } } }),
  ]);
  const item = items[0];
  if (!item) throw err.notFound(MSG_SLOT_NOT_FOUND);
  const masked = Date.now() - row.endAt.getTime() > CONTACT_RETENTION_MS;
  const labelOf = new Map(row.seats.map((seat) => [seat.id, seat.label]));
  return {
    ...item,
    bookings: bookings.map((b) => ({
      id: b.id,
      code: b.code,
      status: b.status,
      channel: b.channel,
      seatId: b.slotSeatId,
      seatLabel: labelOf.get(b.slotSeatId) ?? "",
      guestName: b.guestName,
      guestPhone: b.guestPhone && masked ? maskPhone(b.guestPhone) : b.guestPhone,
      quantity: b.quantity,
      totalAmount: b.totalAmount,
      payOnsiteAmount: b.payOnsiteAmount,
      paymentMethod: b.paymentMethod,
      paymentState: b.paymentState,
      attendanceConfirmedAt: b.attendanceConfirmedAt,
      checkedInAt: b.checkedInAt,
      createdAt: b.createdAt,
      requestNote: b.requestNote,
      sellerMemo: b.sellerMemo,
    })),
    cancelledCount,
    waitlist: {
      waiting: item.seats.reduce((sum, seat) => sum + seat.waiting, 0),
      offered: item.seats.reduce((sum, seat) => sum + seat.offered, 0),
    },
  };
}

/** 좌석 유형별 확정 인원으로 회차의 개최 상태를 읽는다(화면에서 따로 필요할 때). 회차가 없으면 null */
export async function getSlotGoState(slotId: string): Promise<GoStateInfo | null> {
  const slot = await prisma.slot.findUnique({
    where: { id: parseInput(idSchema, slotId) },
    select: { decideAt: true, goConfirmedAt: true, seats: { select: { id: true, label: true, minCount: true }, orderBy: { sort: "asc" } } },
  });
  if (!slot) return null;
  return getGoState(slot, await confirmedCountBySeat(slotId));
}
