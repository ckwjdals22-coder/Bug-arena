import "server-only";

/**
 * 예약 엔진(docs/02-architecture.md 6장)의 공개 API. 구현은 booking/ 아래에 나뉘어 있다.
 *
 *   create.ts       예약 전 견적 · 고객 예약 · 직접 입력 예약 · 이어서 결제
 *   payment.ts      결제 승인 뒤 확정 · 결제 그만두기 · 홀드 만료 · 웹훅/대사
 *   cancel.ts       고객·사업자·운영자 취소 · 승인/거절 · 취소 미리보기
 *   resale.ts       재판매 연동 환불
 *   attendance.ts   참석 확정 · 체크인 · 노쇼 · 자동 완료
 *   queries.ts      고객·사업자 조회
 *   eligibility.ts  예약 자격 확인(대기 모듈도 함께 쓴다)
 *   lifecycle.ts    상태 전이의 공통 구현(취소·만료·결제 완료 반영·확정 뒤처리)
 *   go.ts           개최 확정 판정
 *
 * 회차·좌석 관리와 개최 확정 작업(decideDueSlots 등)은 services/slots.ts 에 있다.
 */

export {
  createBooking,
  createManualBooking,
  getBookingQuote,
  prepareBookingPayment,
  type BookingPaymentTicket,
  type BookingQuote,
  type CreateBookingInput,
  type CreateBookingResult,
  type ManualBookingInput,
  type SellerIdentityBlock,
} from "./booking/create";

export {
  abandonBooking,
  confirmBookingPayment,
  expireHolds,
  reconcileDuePayments,
  syncBookingWithPayment,
  type ConfirmBookingPaymentResult,
  type SyncBookingResult,
} from "./booking/payment";

export {
  approveBooking,
  cancelBookingByAdmin,
  cancelBookingByCustomer,
  cancelBookingBySeller,
  computeCancellationPreview,
  expireStaleApprovals,
  previewCancellation,
  rejectBooking,
  type AdminCancelResult,
  type CancellationPreview,
  type CustomerCancelResult,
  type SellerCancelResult,
} from "./booking/cancel";

export { clearStaleResalePending, settleResaleFor, type ResaleSettlement } from "./booking/resale";

export {
  adminRevertNoShow,
  checkInBooking,
  completeDueBookings,
  confirmAttendance,
  markNoShow,
  revertNoShow,
  type CheckInResult,
  type NoShowResult,
} from "./booking/attendance";

export {
  CUSTOMER_BOOKING_TABS,
  getBookingForCustomer,
  getBookingForSeller,
  getBookingTicket,
  listCustomerBookings,
  listResumableHolds,
  listSellerBookings,
  updateSellerMemo,
  type BookingPlace,
  type BookingTicket,
  type CustomerBookingDetail,
  type CustomerBookingItem,
  type CustomerBookingPage,
  type CustomerBookingTab,
  type ResumableHoldItem,
  type SellerBookingDetail,
  type SellerBookingItem,
  type SellerBookingPage,
  type SellerBookingQuery,
} from "./booking/queries";

export {
  assertBookingEligibility,
  checkBookingEligibility,
  checkSlotBookable,
  type EligibilityIssue,
  type EligibilityOptions,
  type EligibilityResult,
  type EligibilitySlotContext,
  type EligibilityUser,
} from "./booking/eligibility";

export { evaluateGoConfirmation, getGoState, type GoSlotInput, type GoStateInfo, type GoStateKind } from "./booking/go";

export { syncBookingPaymentState, type AdminActor, type BookingSummary, type RefundOutcome } from "./booking/shared";
