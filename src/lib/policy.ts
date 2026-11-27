/**
 * 약관·정책 버전과 문구 규칙. 서버·클라이언트 양쪽에서 쓴다(비밀값 없음).
 */

/** 문서 버전 — 약관·방침을 고치면 날짜를 올리고, 동의 기록(ConsentRecord.version)에 함께 남긴다 */
export const POLICY_VERSIONS = {
  TERMS: "2026-11-27",
  PRIVACY: "2026-11-27",
  MARKETING: "2026-11-27",
  NIGHT_ALERT: "2026-11-27",
  THIRD_PARTY: "2026-11-27",
  REFUND_POLICY: "2026-11-27",
} as const;

export type PolicyKind = keyof typeof POLICY_VERSIONS;

/** 가입 가능한 최소 나이(만) */
export const MIN_SIGNUP_AGE = 14;

/**
 * 상품·회차 문구에 쓸 수 없는 표현.
 * - 떨이 인식을 만드는 표현(서비스 정체성: 정가 거래도 가능한 "남는 자리")
 * - 결혼중개·성혼을 보장하는 표현(결혼중개업법 경계)
 * - 플랫폼 밖 결제를 유도하는 표현
 */
export const BANNED_PHRASES: { phrase: string; reason: string }[] = [
  { phrase: "땡처리", reason: "떨이 판매로 보이는 표현은 쓸 수 없어요." },
  { phrase: "떨이", reason: "떨이 판매로 보이는 표현은 쓸 수 없어요." },
  { phrase: "마감세일", reason: "떨이 판매로 보이는 표현은 쓸 수 없어요." },
  { phrase: "마감 세일", reason: "떨이 판매로 보이는 표현은 쓸 수 없어요." },
  { phrase: "폭탄세일", reason: "떨이 판매로 보이는 표현은 쓸 수 없어요." },
  { phrase: "성혼 보장", reason: "결과를 보장하는 표현은 쓸 수 없어요." },
  { phrase: "성혼보장", reason: "결과를 보장하는 표현은 쓸 수 없어요." },
  { phrase: "결혼 보장", reason: "결과를 보장하는 표현은 쓸 수 없어요." },
  { phrase: "결혼보장", reason: "결과를 보장하는 표현은 쓸 수 없어요." },
  { phrase: "매칭 보장", reason: "결과를 보장하는 표현은 쓸 수 없어요." },
  { phrase: "매칭보장", reason: "결과를 보장하는 표현은 쓸 수 없어요." },
  { phrase: "100% 매칭", reason: "결과를 보장하는 표현은 쓸 수 없어요." },
  { phrase: "100%매칭", reason: "결과를 보장하는 표현은 쓸 수 없어요." },
  { phrase: "커플 보장", reason: "결과를 보장하는 표현은 쓸 수 없어요." },
  { phrase: "계좌이체", reason: "남는자리 밖에서 결제하도록 안내할 수 없어요." },
  { phrase: "계좌 이체", reason: "남는자리 밖에서 결제하도록 안내할 수 없어요." },
  { phrase: "입금 시", reason: "남는자리 밖에서 결제하도록 안내할 수 없어요." },
  { phrase: "현금 할인", reason: "남는자리 밖에서 결제하도록 안내할 수 없어요." },
  { phrase: "현금할인", reason: "남는자리 밖에서 결제하도록 안내할 수 없어요." },
];

/** 문구에서 금칙 표현을 찾는다(대소문자·연속 공백 무시). 없으면 빈 배열 */
export function findBannedPhrases(...texts: (string | null | undefined)[]): { phrase: string; reason: string }[] {
  const joined = texts
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!joined) return [];
  const found = new Map<string, { phrase: string; reason: string }>();
  for (const item of BANNED_PHRASES) {
    if (joined.includes(item.phrase.toLowerCase())) found.set(item.phrase, item);
  }
  return [...found.values()];
}

/** 사업자 화면에서 쓰는 수수료 규칙 설명 */
export const COMMISSION_RULE_LABEL: Record<string, { label: string; desc: string }> = {
  MARKET_NEW: { label: "남는자리 신규 고객", desc: "남는자리 탐색·검색·알림·대기로 처음 온 고객이에요." },
  MARKET_RETURNING: { label: "남는자리 재방문 고객", desc: "최근 1년 안에 이용한 적이 있는 고객이 남는자리로 다시 예약했어요." },
  OVERRIDE: { label: "개별 요율", desc: "사업자 또는 업종에 따로 정한 요율이 적용됐어요." },
  PROMO: { label: "입점 프로모션", desc: "프로모션 기간이라 중개 수수료가 없어요. 결제 실비만 차감돼요." },
  OWN_CUSTOMER: { label: "내 고객", desc: "직접 등록하거나 가져온 고객이라 중개 수수료가 없어요. 결제 실비만 차감돼요." },
  DIRECT: { label: "내 예약 링크", desc: "사업자 전용 링크·QR 로 들어온 예약이라 중개 수수료가 없어요. 결제 실비만 차감돼요." },
  MANUAL: { label: "직접 입력", desc: "전화·현장 등 직접 입력한 예약은 수수료가 없어요." },
};
