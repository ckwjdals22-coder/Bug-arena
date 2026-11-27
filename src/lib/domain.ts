/**
 * 도메인 상수·라벨·순수 계산 — 서버와 클라이언트가 함께 쓴다(서버 전용 모듈을 import 하지 않는다).
 * enum 값은 prisma/schema.prisma 와 반드시 일치해야 한다.
 */

export type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

// ── 예약 ──────────────────────────────────────────────

export const BOOKING_STATUSES = [
  "PENDING_PAYMENT",
  "PENDING_APPROVAL",
  "CONFIRMED",
  "COMPLETED",
  "NO_SHOW",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
] as const;
export type BookingStatusKey = (typeof BOOKING_STATUSES)[number];

export const BOOKING_STATUS_LABEL: Record<BookingStatusKey, string> = {
  PENDING_PAYMENT: "결제 대기",
  PENDING_APPROVAL: "승인 대기",
  CONFIRMED: "예약 확정",
  COMPLETED: "이용 완료",
  NO_SHOW: "노쇼",
  CANCELLED: "취소됨",
  REJECTED: "거절됨",
  EXPIRED: "시간 초과",
};

export const BOOKING_STATUS_TONE: Record<BookingStatusKey, Tone> = {
  PENDING_PAYMENT: "warning",
  PENDING_APPROVAL: "warning",
  CONFIRMED: "success",
  COMPLETED: "neutral",
  NO_SHOW: "danger",
  CANCELLED: "neutral",
  REJECTED: "neutral",
  EXPIRED: "neutral",
};

/** 좌석을 점유하고 있는(재고에 잡혀 있는) 예약 상태 */
export const SEAT_HOLDING_STATUSES: BookingStatusKey[] = ["PENDING_PAYMENT", "PENDING_APPROVAL", "CONFIRMED", "COMPLETED", "NO_SHOW"];
/** 아직 진행 중인 예약 상태(한 회차에 회원당 하나만 가능) */
export const ACTIVE_BOOKING_STATUSES: BookingStatusKey[] = ["PENDING_PAYMENT", "PENDING_APPROVAL", "CONFIRMED"];

export const BOOKING_CHANNEL_LABEL = {
  MARKETPLACE: "남는자리 탐색",
  DIRECT: "내 예약 링크",
  WAITLIST: "대기 전환",
  MANUAL: "직접 입력",
} as const;

export const PAYMENT_METHOD_LABEL = {
  ONLINE: "온라인 결제",
  ONSITE: "현장 결제",
  FREE: "무료",
} as const;

export const PAYMENT_STATE_LABEL = {
  UNPAID: "미결제",
  PAID: "결제 완료",
  PARTIALLY_REFUNDED: "부분 환불",
  REFUNDED: "환불 완료",
} as const;

export const PAYMENT_POLICY_LABEL = {
  PREPAY: "전액 선결제",
  DEPOSIT: "예약금 결제",
  ONSITE: "현장 결제",
} as const;

export const ACTOR_LABEL = {
  CUSTOMER: "고객",
  SELLER: "사업자",
  ADMIN: "운영자",
  SYSTEM: "시스템",
} as const;

// ── 공석 ──────────────────────────────────────────────

export const VACANCY_ORIGINS = ["REGULAR", "CANCELLATION", "NO_SHOW", "UNSOLD"] as const;
export type VacancyOriginKey = (typeof VACANCY_ORIGINS)[number];

/** 피드 배지 문구. 일반 판매는 배지를 붙이지 않는다. */
export const VACANCY_ORIGIN_LABEL: Record<VacancyOriginKey, string | null> = {
  REGULAR: null,
  CANCELLATION: "취소석",
  NO_SHOW: "노쇼 공석",
  UNSOLD: "미판매",
};

export const VACANCY_ORIGIN_OPTION_LABEL: Record<VacancyOriginKey, string> = {
  REGULAR: "일반 판매",
  CANCELLATION: "취소로 생긴 자리",
  NO_SHOW: "노쇼로 생긴 자리",
  UNSOLD: "아직 안 팔린 자리",
};

export const SLOT_STATUS_LABEL = {
  OPEN: "판매 중",
  CLOSED: "판매 마감",
  CANCELLED: "회차 취소",
} as const;

export const PRODUCT_STATUS_LABEL = {
  DRAFT: "임시저장",
  ACTIVE: "판매 중",
  PAUSED: "판매 중지",
  ARCHIVED: "보관됨",
} as const;

export const SEAT_GENDER_LABEL = {
  ANY: "누구나",
  MALE: "남성",
  FEMALE: "여성",
} as const;

export const GENDER_LABEL = { MALE: "남성", FEMALE: "여성" } as const;

export const WAITLIST_STATUS_LABEL = {
  WAITING: "대기 중",
  OFFERED: "자리 났어요",
  CONVERTED: "예약 완료",
  EXPIRED: "제안 시간 초과",
  CANCELLED: "대기 취소",
  CLOSED: "종료됨",
} as const;

// ── 사업자·운영 ───────────────────────────────────────

export const BUSINESS_STATUS_LABEL = {
  PENDING: "심사 중",
  APPROVED: "입점 승인",
  REJECTED: "반려",
  SUSPENDED: "이용 정지",
} as const;

export const BUSINESS_STATUS_TONE: Record<keyof typeof BUSINESS_STATUS_LABEL, Tone> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  SUSPENDED: "danger",
};

export const MEMBER_ROLE_LABEL = { OWNER: "대표", MANAGER: "매니저", STAFF: "스태프" } as const;

export const ADMIN_ROLE_LABEL = {
  SUPER: "최고 관리자",
  OPS: "운영",
  CS: "고객 지원",
  FINANCE: "정산",
} as const;

export const ADMIN_ROLE_DESC = {
  SUPER: "모든 메뉴와 운영자 계정·권한 관리",
  OPS: "입점 심사, 상품·공석 운영, 분류·설정",
  CS: "회원·예약 조회, 신고·분쟁 처리, 환불",
  FINANCE: "거래·정산 조회와 지급 처리",
} as const;

export const USER_STATUS_LABEL = { ACTIVE: "정상", SUSPENDED: "이용 정지", WITHDRAWN: "탈퇴" } as const;

export const PLAN_LABEL = { FREE: "베이직", PRO: "프로" } as const;

export const SETTLEMENT_STATUS_LABEL = {
  PENDING: "집계 완료",
  CONFIRMED: "금액 확정",
  PAID: "지급 완료",
  HELD: "지급 보류",
} as const;

export const REPORT_REASON_LABEL = {
  FALSE_INFO: "허위·과장 정보",
  FAKE_VACANCY: "실제로는 없는 자리",
  NO_SERVICE: "서비스를 받지 못함",
  REFUND_DISPUTE: "환불 분쟁",
  OFF_PLATFORM: "외부 결제 유도",
  INAPPROPRIATE: "부적절한 내용·행동",
  SAFETY: "안전 문제",
  OTHER: "기타",
} as const;

export const REPORT_STATUS_LABEL = {
  OPEN: "접수",
  IN_REVIEW: "검토 중",
  RESOLVED: "처리 완료",
  DISMISSED: "기각",
} as const;

export const REPORT_TARGET_LABEL = {
  BUSINESS: "사업자",
  PRODUCT: "상품",
  REVIEW: "후기",
  USER: "회원",
  BOOKING: "예약",
} as const;

export const MESSAGE_CHANNEL_LABEL = { SMS: "문자", ALIMTALK: "알림톡", EMAIL: "이메일" } as const;

export const MESSAGE_STATUS_LABEL = {
  QUEUED: "발송 대기",
  SENT: "발송 완료",
  SIMULATED: "미연동(기록만)",
  FAILED: "실패",
  SKIPPED: "건너뜀",
} as const;

// ── JSON 필드 타입 ────────────────────────────────────

/** 취소·환불 구간: 시작까지 hoursBefore 시간 이상 남았으면 refundRate% 환불 */
export interface CancellationTier {
  hoursBefore: number;
  refundRate: number;
}

export interface SeatTemplate {
  label: string;
  gender: "ANY" | "MALE" | "FEMALE";
  capacity: number;
  price: number;
}

export const CANCELLATION_PRESETS = {
  FLEXIBLE: {
    label: "유연",
    desc: "시작 24시간 전까지 전액, 3시간 전까지 50% 환불",
    tiers: [
      { hoursBefore: 24, refundRate: 100 },
      { hoursBefore: 3, refundRate: 50 },
      { hoursBefore: 0, refundRate: 0 },
    ],
  },
  STANDARD: {
    label: "표준",
    desc: "시작 3일 전까지 전액, 24시간 전까지 50% 환불",
    tiers: [
      { hoursBefore: 72, refundRate: 100 },
      { hoursBefore: 24, refundRate: 50 },
      { hoursBefore: 0, refundRate: 0 },
    ],
  },
  STRICT: {
    label: "엄격",
    desc: "시작 7일 전까지 전액, 3일 전까지 50% 환불",
    tiers: [
      { hoursBefore: 168, refundRate: 100 },
      { hoursBefore: 72, refundRate: 50 },
      { hoursBefore: 0, refundRate: 0 },
    ],
  },
} as const satisfies Record<string, { label: string; desc: string; tiers: CancellationTier[] }>;

export type CancellationPresetKey = keyof typeof CANCELLATION_PRESETS;

/** 저장된 JSON 을 안전하게 구간 배열로 바꾼다(형식이 틀리면 표준 정책). */
export function parseCancellationTiers(value: unknown): CancellationTier[] {
  if (Array.isArray(value)) {
    const tiers = value
      .filter(
        (t): t is CancellationTier =>
          typeof t === "object" &&
          t !== null &&
          typeof (t as CancellationTier).hoursBefore === "number" &&
          typeof (t as CancellationTier).refundRate === "number",
      )
      .map((t) => ({
        hoursBefore: Math.max(0, t.hoursBefore),
        refundRate: Math.min(100, Math.max(0, Math.round(t.refundRate))),
      }))
      .sort((a, b) => b.hoursBefore - a.hoursBefore);
    if (tiers.length > 0) return tiers;
  }
  return [...CANCELLATION_PRESETS.STANDARD.tiers];
}

export function parseSeatTemplates(value: unknown): SeatTemplate[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (s): s is SeatTemplate =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as SeatTemplate).label === "string" &&
      typeof (s as SeatTemplate).capacity === "number" &&
      typeof (s as SeatTemplate).price === "number" &&
      ["ANY", "MALE", "FEMALE"].includes((s as SeatTemplate).gender),
  );
}

/**
 * 고객 취소 시 환불율(%) 계산. 기준점은 항상 회차 시작 시각이다.
 * - 예약 직후 graceMinutes 안이면(그리고 시작 전이면) 전액 환불.
 *   단, 예약 시점에 시작까지 graceMinLeadMinutes 미만으로 남았던 임박 예약에는 적용하지 않는다.
 * - 그 밖에는 시작까지 남은 시간이 처음으로 충족되는 구간의 환불율
 */
export function computeRefundRate(params: {
  tiers: CancellationTier[];
  startAt: Date;
  bookedAt: Date;
  now?: Date;
  graceMinutes?: number;
  graceMinLeadMinutes?: number;
}): number {
  const now = params.now ?? new Date();
  if (now.getTime() >= params.startAt.getTime()) return 0;
  const grace = (params.graceMinutes ?? 0) * 60_000;
  const leadAtBooking = params.startAt.getTime() - params.bookedAt.getTime();
  const graceApplies = leadAtBooking >= (params.graceMinLeadMinutes ?? 0) * 60_000;
  if (grace > 0 && graceApplies && now.getTime() - params.bookedAt.getTime() <= grace) return 100;
  const hoursLeft = (params.startAt.getTime() - now.getTime()) / 3_600_000;
  const tiers = [...params.tiers].sort((a, b) => b.hoursBefore - a.hoursBefore);
  for (const tier of tiers) {
    if (hoursLeft >= tier.hoursBefore) return tier.refundRate;
  }
  return 0;
}

/** 환불 정책을 사람이 읽는 문장 목록으로 */
export function describeCancellationTiers(tiers: CancellationTier[]): { when: string; refund: string }[] {
  const sorted = [...tiers].sort((a, b) => b.hoursBefore - a.hoursBefore);
  const label = (h: number) => (h >= 24 && h % 24 === 0 ? `${h / 24}일` : `${h}시간`);
  return sorted.map((tier, i) => {
    const refund = tier.refundRate === 100 ? "전액 환불" : tier.refundRate === 0 ? "환불 불가" : `${tier.refundRate}% 환불`;
    if (tier.hoursBefore === 0) {
      const prev = sorted[i - 1];
      return { when: prev ? `시작 ${label(prev.hoursBefore)} 전 이후` : "예약 후", refund };
    }
    return { when: `시작 ${label(tier.hoursBefore)} 전까지`, refund };
  });
}

// ── 좌석 표시 ─────────────────────────────────────────

export interface SeatAvailability {
  capacity: number;
  reserved: number;
}

export const seatsLeft = (s: SeatAvailability) => Math.max(0, s.capacity - s.reserved);

/** 남은 자리가 적을 때만 true — 실제 수량에 근거한 표시만 허용한다(허위 재고 압박 금지). */
export const isLowStock = (remaining: number) => remaining > 0 && remaining <= 2;
