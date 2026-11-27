import "server-only";
import type { BusinessStatus, Gender, ProductStatus, SeatGender, SlotStatus, UserStatus } from "@/generated/prisma/client";
import { SEAT_GENDER_LABEL } from "@/lib/domain";
import { fmtDateTime, kstParts } from "@/lib/time";
import { prisma } from "@/server/db";
import { AppError, type ErrorCode } from "@/server/errors";
import { isBlockedCustomer } from "@/server/services/crm";

/**
 * 예약 자격 확인. 예약 생성·예약 전 견적·대기 신청이 같은 규칙을 쓴다.
 * 좌석 수(매진)와 예약 건수 제한은 여기서 보지 않는다 — 그 판단은 예약 트랜잭션이 한다.
 */

export interface EligibilityUser {
  id: string;
  status: UserStatus;
  gender: Gender | null;
  birthYear: number | null;
  identityVerifiedAt: Date | null;
  bookingRestrictedUntil: Date | null;
}

export interface EligibilitySlotContext {
  slot: { status: SlotStatus; startAt: Date; bookingDeadlineAt: Date };
  product: { status: ProductStatus; minAge: number | null; maxAge: number | null; requiresIdentity: boolean };
  business: { id: string; status: BusinessStatus };
  seat: { gender: SeatGender };
}

export type EligibilityIssue =
  | "USER_INACTIVE"
  | "RESTRICTED"
  | "SLOT_CANCELLED"
  | "SLOT_CLOSED"
  | "NOT_ON_SALE"
  | "STARTED"
  | "DEADLINE_PASSED"
  | "GENDER_REQUIRED"
  | "GENDER_MISMATCH"
  | "AGE_REQUIRED"
  | "AGE_TOO_YOUNG"
  | "AGE_TOO_OLD"
  | "IDENTITY_REQUIRED"
  | "BLOCKED"
  | "OWN_BUSINESS";

export type EligibilityResult = { ok: true } | { ok: false; issue: EligibilityIssue; code: ErrorCode; reason: string };

export interface EligibilityOptions {
  now?: Date;
  /** 예약자 연락처(사업자 차단 여부를 전화번호로도 확인한다) */
  guestPhone?: string | null;
}

const fail = (issue: EligibilityIssue, code: ErrorCode, reason: string): EligibilityResult => ({ ok: false, issue, code, reason });

/** 참가 나이 판정에 쓰는 나이: KST 기준 올해 − 출생 연도(연 나이) */
const yearAge = (birthYear: number, now: Date) => kstParts(now).year - birthYear;

/** 회차가 지금 예약을 받는 상태인지(회원과 무관한 조건): 회차·상품·사업장 상태와 시작·예약 마감 시각 */
export function checkSlotBookable(ctx: Omit<EligibilitySlotContext, "seat">, now: Date = new Date()): EligibilityResult {
  if (ctx.slot.status === "CANCELLED") return fail("SLOT_CANCELLED", "CLOSED", "취소된 회차예요. 다른 자리를 찾아봐 주세요.");
  if (ctx.slot.status !== "OPEN") return fail("SLOT_CLOSED", "CLOSED", "판매가 마감된 회차예요. 다른 자리를 찾아봐 주세요.");
  if (ctx.product.status !== "ACTIVE" || ctx.business.status !== "APPROVED") {
    return fail("NOT_ON_SALE", "CLOSED", "지금은 예약을 받지 않는 자리예요. 다른 자리를 찾아봐 주세요.");
  }
  if (ctx.slot.startAt.getTime() <= now.getTime()) return fail("STARTED", "CLOSED", "이미 시작한 회차예요. 다른 자리를 찾아봐 주세요.");
  if (ctx.slot.bookingDeadlineAt.getTime() <= now.getTime()) return fail("DEADLINE_PASSED", "CLOSED", "예약 마감 시간이 지났어요. 다른 자리를 찾아봐 주세요.");
  return { ok: true };
}

/**
 * 이 회원이 이 좌석을 예약할 수 있는지 확인한다(예외를 던지지 않고 결과로 돌려준다).
 * 확인 순서: 계정 상태·예약 제한 → 회차·상품·사업장 상태 → 예약 마감 → 성별 → 나이 → 본인확인 → 사업자 차단 → 자기 사업장.
 */
export async function checkBookingEligibility(user: EligibilityUser, ctx: EligibilitySlotContext, options: EligibilityOptions = {}): Promise<EligibilityResult> {
  const now = options.now ?? new Date();

  if (user.status !== "ACTIVE") return fail("USER_INACTIVE", "FORBIDDEN", "지금은 예약할 수 없는 계정이에요. 고객센터로 문의해 주세요.");
  if (user.bookingRestrictedUntil && user.bookingRestrictedUntil.getTime() > now.getTime()) {
    return fail("RESTRICTED", "FORBIDDEN", `노쇼가 누적되어 ${fmtDateTime(user.bookingRestrictedUntil)}까지 예약이 제한돼요.`);
  }

  const bookable = checkSlotBookable(ctx, now);
  if (!bookable.ok) return bookable;

  if (ctx.seat.gender !== "ANY") {
    if (!user.gender) return fail("GENDER_REQUIRED", "VALIDATION", "프로필에서 성별을 먼저 설정해 주세요.");
    if (user.gender !== ctx.seat.gender) {
      return fail("GENDER_MISMATCH", "VALIDATION", `${SEAT_GENDER_LABEL[ctx.seat.gender]} 좌석이에요. 예약할 수 있는 다른 좌석을 골라 주세요.`);
    }
  }

  const { minAge, maxAge } = ctx.product;
  if (minAge !== null || maxAge !== null) {
    if (!user.birthYear) return fail("AGE_REQUIRED", "VALIDATION", "프로필에서 출생 연도를 먼저 설정해 주세요.");
    const age = yearAge(user.birthYear, now);
    if (minAge !== null && age < minAge) return fail("AGE_TOO_YOUNG", "VALIDATION", `${minAge}세부터 참가할 수 있는 자리예요.`);
    if (maxAge !== null && age > maxAge) return fail("AGE_TOO_OLD", "VALIDATION", `${maxAge}세까지 참가할 수 있는 자리예요.`);
  }

  if (ctx.product.requiresIdentity && !user.identityVerifiedAt) {
    return fail("IDENTITY_REQUIRED", "VALIDATION", "본인확인을 마친 뒤 예약할 수 있어요.");
  }

  if (await isBlockedCustomer(ctx.business.id, { userId: user.id, phone: options.guestPhone ?? "" })) {
    return fail("BLOCKED", "FORBIDDEN", "이 사업장에서는 예약을 받을 수 없어요. 다른 자리를 찾아봐 주세요.");
  }

  const member = await prisma.businessMember.findUnique({
    where: { businessId_userId: { businessId: ctx.business.id, userId: user.id } },
    select: { id: true },
  });
  if (member) return fail("OWN_BUSINESS", "FORBIDDEN", "내 사업장의 자리는 직접 입력으로 등록해 주세요.");

  return { ok: true };
}

/** 자격이 없으면 AppError 를 던진다. */
export async function assertBookingEligibility(user: EligibilityUser, ctx: EligibilitySlotContext, options: EligibilityOptions = {}): Promise<void> {
  const result = await checkBookingEligibility(user, ctx, options);
  if (!result.ok) throw new AppError(result.code, result.reason);
}
