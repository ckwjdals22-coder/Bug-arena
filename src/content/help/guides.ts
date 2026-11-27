/**
 * 짧은 안내 목록 — 온보딩 화면과 빈 화면(예약 없음, 상품 없음 등)에 쓴다. 해요체. 순수 데이터.
 *
 * 시간·기간은 운영 설정이므로 {{settings.*}} 자리표시자로 적는다(src/content/render.ts 의 resolveDeep 로 바꾼다).
 * 0 이 "없음"을 뜻하는 설정(무료 취소 시간, 입점 프로모션)은 [[if settings.*]]…[[end]] 로 감싸 0 일 때 문장을 바꾼다.
 * 금칙 표현(src/lib/policy.ts 의 BANNED_PHRASES)은 예시로도 적지 않는다 — 어떤 종류인지만 설명한다.
 */
import { legalDocHref } from "../legal/types";
import { HELP_SAFETY_PATH, faqHref } from "./faq";

export interface GuideLink {
  label: string;
  /** 같은 사이트 안의 경로 */
  href: string;
}

export interface GuideStep {
  /** 고정 ID(kebab-case) */
  id: string;
  title: string;
  body: string;
  /** 더 읽을 곳(선택) */
  link?: GuideLink;
}

export interface Guide {
  id: string;
  title: string;
  /** 제목 아래 한 문장 */
  summary: string;
  steps: GuideStep[];
  /** 목록 아래 덧붙이는 한 줄(선택) */
  footnote?: string;
}

/** 호스트 3분 온보딩: 입점 신청 → 상품 1개 → 회차 1개 */
export const SELLER_ONBOARDING_GUIDE: Guide = {
  id: "seller-onboarding",
  title: "3분이면 첫 자리를 올릴 수 있어요",
  summary: "입점 신청, 상품 1개, 회차 1개. 이 세 가지만 하면 돼요.",
  steps: [
    {
      id: "apply",
      title: "입점 신청하기",
      body: "사업장 이름, 업종, 대표 전화번호, 주소, 사업자등록번호, 대표자 이름을 입력해요. 운영자가 확인한 뒤 결과를 알려 드려요.",
      link: { label: "입점에 필요한 정보 보기", href: faqHref("seller-onboarding") },
    },
    {
      id: "product",
      title: "상품 1개 만들기",
      body: "무슨 자리인지, 가격, 좌석 구성, 환불 기준을 정해요. 좌석은 '일반 8석'처럼 하나로 두거나 '남성 4석, 여성 4석'처럼 나눌 수 있어요.",
      link: { label: "환불 기준 세 가지 보기", href: legalDocHref("refund-policy", "presets") },
    },
    {
      id: "slot",
      title: "회차 1개 열기",
      body: "날짜와 시작 시간을 고르면 끝이에요. 다른 곳에서 이미 받은 예약이 있으면 직접 입력으로 넣어 남은 자리 수를 맞춰 주세요.",
      link: { label: "직접 입력 예약 알아보기", href: faqHref("manual-booking") },
    },
  ],
  footnote:
    "자리는 입점이 승인된 뒤에 고객에게 공개돼요.[[if settings.launchPromoMonths & settings.launchPromoBookings]] 승인된 때부터 {{settings.launchPromoMonths}}개월 동안, 프로모션을 적용받은 예약 {{settings.launchPromoBookings}}건까지는 중개 수수료가 없어요.[[end]]",
};

export interface WritingTip {
  /** 고정 ID(kebab-case) */
  id: string;
  title: string;
  body: string;
}

/** 좋은 공석 글 쓰는 법 — 상품·회차 등록 화면의 도움말 */
export const VACANCY_WRITING_TIPS: { id: string; title: string; summary: string; tips: WritingTip[]; link: GuideLink } = {
  id: "vacancy-writing",
  title: "좋은 공석 글 쓰는 법",
  summary: "곧 시작하는 자리는 빨리 읽혀야 해요. 사실만 짧게 적어 주세요.",
  tips: [
    {
      id: "title-says-what",
      title: "제목만 봐도 어떤 자리인지 알 수 있게",
      body: "무엇을 하는 자리인지와 분위기를 제목에 담아 주세요. 날짜와 시간, 남은 자리 수는 화면이 따로 보여 주니 제목에 적지 않아도 돼요.",
    },
    {
      id: "total-price",
      title: "가격은 고객이 내는 총액으로",
      body: "표시한 가격 말고는 받을 수 없어요. 음료나 재료처럼 포함된 것과 포함되지 않은 것을 적어 주세요.",
    },
    {
      id: "clear-conditions",
      title: "참가 조건은 분명하게",
      body: "성별 좌석, 나이 조건, 최소 인원과 판정 시각이 있으면 빠짐없이 정해 주세요. 술이 나오거나 성인만 참가하는 자리는 참가 나이를 19세 이상으로 정해 주세요. 늦게 온 고객이 언제까지 입장할 수 있는지도 유의 사항에 적어 주세요. 정한 조건은 고객이 예약하기 전에 화면에 그대로 보여요.",
    },
    {
      id: "honest-origin",
      title: "자리가 생긴 이유는 사실대로",
      body: "취소로 생긴 자리인지, 노쇼로 생긴 자리인지, 아직 안 팔린 자리인지 그대로 골라 주세요. 남은 자리 수는 화면이 실제 값으로 보여 주니 글에 따로 적지 않아요.",
    },
    {
      id: "refund-choice",
      title: "환불 기준과 '다시 팔리면 환불'을 골라 두기",
      body: "환불 기준은 예약 화면에 그대로 보여요. 다시 팔리면 환불해 주는 설정을 켜 두면, 늦게 취소한 고객도 그 자리가 다시 예약된 채로 모임이 시작됐을 때 정해 둔 비율까지 돌려받아요. 온라인으로 결제받는 상품에서만 쓸 수 있어요.",
    },
    {
      id: "place-and-photos",
      title: "장소와 사진은 실제 그대로",
      body: "공개 화면에는 장소 이름과 동네까지만 보이고, 모임 장소의 정확한 주소는 예약이 확정된 고객에게만 보여요. 사업장 주소는 법에 따라 항상 공개돼요. 사진은 실제 공간과 진행 모습을 올려 주세요.",
    },
    {
      id: "no-banned-phrases",
      title: "쓸 수 없는 표현은 피하기",
      body: "만남이나 수업의 결과를 약속하는 표현, 헐값에 처분하는 것처럼 보이는 표현, 남는자리 밖에서 결제하도록 안내하는 표현이 들어가면 글이 저장되지 않아요.",
    },
  ],
  link: { label: "표시 규칙과 쓸 수 없는 표현 보기", href: legalDocHref("seller-terms", "listing-rules") },
};

/** 고객 "처음 예약하기" */
export const FIRST_BOOKING_GUIDE: Guide = {
  id: "first-booking",
  title: "처음 예약하기",
  summary: "곧 시작하는 자리를 찾아 바로 예약해 보세요.",
  steps: [
    {
      id: "find",
      title: "자리 찾기",
      body: "목록은 시작이 가까운 순서로 나와요. 분류, 동네, 날짜로 좁히거나 내 조건으로 예약할 수 있는 자리만 볼 수 있어요.",
      link: { label: "노출·정렬 기준 보기", href: legalDocHref("ranking-policy") },
    },
    {
      id: "check",
      title: "총액과 환불 기준 확인하기",
      body: "화면에 보이는 가격이 내는 돈의 전부예요. 취소하면 얼마를 돌려받는지도 결제 전에 확인할 수 있어요.",
      link: { label: "취소하면 얼마를 돌려받나요?", href: faqHref("refund-amount") },
    },
    {
      id: "pay",
      title: "결제하고 확정하기",
      body: "결제를 시작하면 {{settings.holdMinutes|min}} 동안 자리를 잡아 둬요. [[if settings.cancelGraceMinutes]]예약한 뒤 {{settings.cancelGraceMinutes|min}} 안에는 전액 환불로 취소할 수 있어요.[[else]]취소하면 얼마를 돌려받는지는 결제하기 전에 확인할 수 있어요.[[end]][[if settings.cancelGraceMinutes & settings.cancelGraceMinLeadMinutes]] 시작이 임박한 예약은 예외예요.[[end]]",
      link: { label: "무료 취소 알아보기", href: faqHref("free-cancel") },
    },
    {
      id: "attend",
      title: "예약 패스 들고 참석하기",
      body: "예약이 확정되면 모임 장소의 정확한 주소와 예약 패스가 예약 상세 화면에 나와요. 못 가게 되면 일찍 취소해 주세요.",
      link: { label: "안전 수칙 보기", href: HELP_SAFETY_PATH },
    },
  ],
  footnote: "자리가 다 찼다면 대기를 신청해 보세요. 자리가 나면 순번대로 먼저 알려 드려요.",
};

/** 화면에서 한 번에 가져다 쓰는 목록 */
export const GUIDES = {
  sellerOnboarding: SELLER_ONBOARDING_GUIDE,
  vacancyWriting: VACANCY_WRITING_TIPS,
  firstBooking: FIRST_BOOKING_GUIDE,
} as const;
