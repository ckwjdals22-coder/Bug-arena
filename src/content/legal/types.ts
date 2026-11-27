/**
 * 약관·정책 문서의 데이터 형식. 순수 데이터라 서버·클라이언트 어디서든 가져다 쓸 수 있다.
 *
 * 문서 안의 글자에는 치환 자리표시자가 들어 있다(src/content/render.ts 의 resolveText 로 바꾼다).
 *   {{operator.companyName}}            운영자(회사) 정보 — 값이 없으면 "[운영자 정보 입력 필요: 상호]" 로 보인다
 *   {{settings.holdMinutes|min}}        운영 설정값 — 뒤의 |min 은 표시 형식
 *   [[if settings.cancelGraceMinutes]]…[[else]]…[[end]]   설정값이 0 보다 클 때와 0 일 때 문장을 바꾼다
 * 요율·시간·횟수는 운영자가 바꿀 수 있는 값이므로 문서에 숫자를 직접 적지 않는다.
 */

/**
 * 외부 연동의 키. 연동이 실제로 켜졌을 때만 처리방침의 표에 나타나야 하고,
 * "아직 연동 전" 안내는 그 연동이 켜지면 사라져야 한다.
 * - always: 항상(호스팅)
 * - payment:toss: 토스페이먼츠 실결제 연동
 * - sms:solapi: 문자 발송 연동
 * - email:resend: 이메일 발송 연동
 * - storage:s3: 외부 이미지 저장소 사용
 * - kakaoLogin: 카카오 로그인 연동
 * - identity: 본인확인 서비스 연동
 */
export type ProcessorEnabledKey = "always" | "payment:toss" | "sms:solapi" | "email:resend" | "storage:s3" | "kakaoLogin" | "identity";

export const PROCESSOR_ENABLED_KEYS: readonly ProcessorEnabledKey[] = [
  "always",
  "payment:toss",
  "sms:solapi",
  "email:resend",
  "storage:s3",
  "kakaoLogin",
  "identity",
];

export type LegalBlock =
  /** 문단 */
  | { type: "p"; text: string }
  /** 목록(ul: 순서 없음, ol: 순서 있음) */
  | { type: "ul" | "ol"; items: string[] }
  /** 표 — rows 의 각 행은 head 와 칸 수가 같다 */
  | { type: "table"; head: string[]; rows: string[][] }
  /**
   * 강조 안내(info: 알아 둘 점, warn: 주의).
   * until 이 있으면 그 연동이 켜지기 전까지만 보여 준다("연동 전" 안내) — src/content/render.ts 의 visibleBlocks 참고.
   */
  | { type: "note"; tone?: "info" | "warn"; text: string; until?: ProcessorEnabledKey }
  /**
   * 개인정보 처리를 맡긴 회사의 표. 내용은 문서가 아니라 PROCESSORS 데이터에서 그린다
   * (실제로 켜진 연동만 보여 주기 위해 — processorsForBlock 참고).
   * scope 가 "overseas" 면 국외에서 처리하는 곳(처리 국가가 국내로 확인되지 않은 곳 포함)만 그린다. 생략하면 전체.
   */
  | { type: "processors"; scope?: "all" | "overseas" };

/** 문서 주소에 쓰는 이름 */
export const LEGAL_SLUGS = [
  "terms",
  "privacy",
  "refund-policy",
  "review-policy",
  "ranking-policy",
  "seller-terms",
  "marketing-consent",
] as const;

export type LegalSlug = (typeof LEGAL_SLUGS)[number];

/** 문서 화면의 기본 경로. 라우트를 다른 곳에 두면 이 값만 바꾼다 */
export const LEGAL_BASE_PATH = "/legal";

/** 문서 화면 주소 — 예: legalDocHref("refund-policy") → "/legal/refund-policy" */
export function legalDocHref(slug: LegalSlug, sectionId?: string): string {
  return `${LEGAL_BASE_PATH}/${slug}${sectionId ? `#${sectionId}` : ""}`;
}

export interface LegalSection {
  /** 화면 앵커로 쓰는 고정 ID(kebab-case). 한 번 정하면 바꾸지 않는다 */
  id: string;
  heading: string;
  blocks: LegalBlock[];
}

export type LegalAudience = "all" | "customer" | "seller";

export interface LegalDoc {
  slug: string;
  title: string;
  /** 제목 아래 한 문장 */
  summary: string;
  /** 문서 버전. 동의 기록에 남는 종류는 POLICY_VERSIONS 의 값을 그대로 쓴다 */
  version: string;
  /** 시행일(YYYY-MM-DD). 초안 단계에서는 버전 날짜와 같으며 출시일에 맞춰 고친다 */
  effectiveDate: string;
  audience: LegalAudience;
  /** "핵심만 보기" 상자에 보여 줄 쉬운 말 요약 3~6개 */
  keyPoints: string[];
  sections: LegalSection[];
  /** 모든 문서는 초안이다. 출시 전에 변호사 검토가 필요하다 */
  reviewRequired: true;
  /** 변호사가 확인해야 할 구체적인 쟁점 */
  reviewNotes: string[];
}

/**
 * 처리 국가를 운영자가 계약·설정에 맞게 입력해야 하는 곳(어느 나라의 서버를 쓰는지는 계약과 설정에 따라 달라진다).
 * 값은 src/content/operator.ts 의 getProcessorRegions 가 환경 변수에서 읽는다.
 */
export const PROCESSOR_REGION_KEYS = ["hosting", "storage", "email"] as const;
export type ProcessorRegionKey = (typeof PROCESSOR_REGION_KEYS)[number];

export interface Processor {
  /** 회사 이름(자리표시자 가능) */
  name: string;
  /** 맡기는 일 */
  purpose: string;
  /** 넘어가는 개인정보 항목 */
  items: string;
  /** 보유·이용 기간 */
  retention: string;
  /**
   * 국외에서 처리하는 경우 그 나라. 없으면 국내 처리.
   * regionKey 가 있는 항목은 여기에 직접 적지 않고 applyProcessorRegions 가 운영자 입력값으로 채운다.
   */
  country?: string;
  /** 국외에서 처리하는 경우 그 회사의 연락처(국외 이전 고지 항목). applyProcessorRegions 가 채운다 */
  contact?: string;
  /** 처리 국가와 연락처를 운영자 입력값에서 가져오는 항목 */
  regionKey?: ProcessorRegionKey;
  enabledWhen: ProcessorEnabledKey;
}
