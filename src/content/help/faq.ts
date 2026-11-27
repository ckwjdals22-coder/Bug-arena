/**
 * 자주 묻는 질문. 화면 문구와 같은 해요체로 쓴다. 순수 데이터라 서버·클라이언트 어디서든 가져다 쓸 수 있다.
 *
 * - 답변의 문단은 빈 줄("\n\n")로 나눈다. splitParagraphs 로 나눠서 그린다.
 * - 시간·요율·횟수는 운영 설정이므로 {{settings.*}} 자리표시자로 적는다(src/content/render.ts 의 resolveText / resolveDeep 로 바꾼다).
 * - 약관·정책 문서는 '판매자', 도움말과 화면은 '호스트'라고 부른다. 같은 뜻이다.
 * - 모든 답변은 docs/02-architecture.md 6장의 엔진 규칙과 같아야 한다. 규칙이 바뀌면 여기를 함께 고친다.
 */
import { REF_COOKIE_MAX_AGE } from "@/lib/cookies";
import { CANCELLATION_PRESETS } from "@/lib/domain";
import { formatKRW } from "@/lib/money";
import { THIRD_PARTY_PROVISION } from "../legal/consents";
import { RESALE_EXAMPLE, RESALE_EXAMPLE_CASES } from "../legal/refund-policy";
import { REVIEW_MIN_COUNT_FOR_RATING } from "../legal/review-policy";
import { PLAN_LIMITS } from "../legal/seller-terms";
import { legalDocHref, type ProcessorEnabledKey } from "../legal/types";

// ── 경로 ──────────────────────────────────────────────

/** 도움말 화면의 기본 경로. 라우트를 다른 곳에 두면 이 값들만 바꾼다 */
export const HELP_BASE_PATH = "/help";
/** 오프라인 모임 안전 수칙 화면 */
export const HELP_SAFETY_PATH = `${HELP_BASE_PATH}/safety`;

/** 자주 묻는 질문의 한 항목으로 바로 가는 주소 — 예: faqHref("free-cancel") → "/help#free-cancel" */
export function faqHref(itemId?: string): string {
  return itemId ? `${HELP_BASE_PATH}#${itemId}` : HELP_BASE_PATH;
}

// ── 엔진 상수의 사본 ──────────────────────────────────

/**
 * 도움말에 숫자로 적는 엔진 상수. 원본은 서버 전용 모듈에 있어 여기서 가져올 수 없다.
 * 값이 달라지면 tests/content.test.ts 가 실패하므로 그때 함께 고친다.
 */
export const HELP_FACTS = {
  /** 노쇼 처리 후 고객이 이의제기할 수 있는 시간 — reports.ts NO_SHOW_DISPUTE_HOURS */
  noShowDisputeHours: 72,
  /** 호스트가 노쇼 처리를 직접 되돌릴 수 있는 시간 — docs/02-architecture.md 6.8 */
  noShowRevertHours: 48,
  /** 회원 한 명이 하루에 받는 빈자리 알림 최대 건수 — alerts.ts VACANCY_DAILY_LIMIT */
  vacancyDailyLimit: 5,
  /** 저장할 수 있는 빈자리 알림 조건 수 — alerts.ts MAX_ALERT_RULES */
  maxAlertRules: 10,
  /** 회원 한 명이 하루에 접수할 수 있는 신고 건수 — reports.ts REPORT_DAILY_LIMIT */
  reportDailyLimit: 5,
  /** 신고 내용 최소 글자 수 — reports.ts REPORT_DETAIL_MIN */
  reportDetailMin: 10,
  /** 한 계정이 대표로 둘 수 있는 사업장 수 — business.ts MAX_OWNED_BUSINESSES */
  maxOwnedBusinesses: 3,
  /** 내 예약 링크로 들어온 방문을 기억하는 기간(일) — src/lib/cookies.ts REF_COOKIE_MAX_AGE */
  directLinkDays: REF_COOKIE_MAX_AGE / 86_400,
  /** 분쟁 접수 후 진행 상황 안내 기한(영업일) — 이용약관 '분쟁 해결' */
  disputeProgressBusinessDays: 3,
  /** 분쟁 접수 후 처리 결과 통지 기한(영업일) — 이용약관 '분쟁 해결' */
  disputeResultBusinessDays: 10,
} as const;

// ── 형식 ──────────────────────────────────────────────

export type FaqAudience = "customer" | "seller";

export interface FaqLink {
  label: string;
  /** 같은 사이트 안의 경로 */
  href: string;
}

/**
 * 외부 연동이 켜지기 전까지만 보여 주는 안내("아직 연동 전이에요").
 * until 의 연동이 켜지면 화면에서 뺀다 — visiblePendingNotes 참고.
 */
export interface FaqPendingNote {
  until: ProcessorEnabledKey;
  text: string;
}

export interface FaqItem {
  /** 화면 앵커로 쓰는 고정 ID(kebab-case). 모든 묶음을 통틀어 겹치지 않는다 */
  id: string;
  q: string;
  /** 답변. 문단은 빈 줄로 나눈다 */
  a: string;
  links?: FaqLink[];
  pendingNotes?: FaqPendingNote[];
}

export interface FaqGroup {
  id: string;
  title: string;
  audience: FaqAudience;
  items: FaqItem[];
}

/** 문단을 빈 줄로 이어 붙인다 */
const paras = (...paragraphs: string[]): string => paragraphs.join("\n\n");

/** 답변을 문단 배열로 나눈다 */
export function splitParagraphs(answer: string): string[] {
  return answer
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/** 지금 보여 줘야 하는 "연동 전" 안내만 고른다. enabledKeys 에는 켜져 있는 연동의 키를 넘긴다 */
export function visiblePendingNotes(item: Pick<FaqItem, "pendingNotes">, enabledKeys: Iterable<ProcessorEnabledKey>): FaqPendingNote[] {
  const enabled = new Set<ProcessorEnabledKey>(enabledKeys);
  return (item.pendingNotes ?? []).filter((note) => !enabled.has(note.until));
}

// ── 답변에 쓰는 값 ────────────────────────────────────

const presetLine = (key: keyof typeof CANCELLATION_PRESETS): string => {
  const preset = CANCELLATION_PRESETS[key];
  return `'${preset.label}' 기준은 ${preset.desc}이에요.`;
};

/**
 * 재판매 연동 환불 예시 — 취소 시점의 환불이 없는 경우를 골라 쓴다(금액은 취소·환불 기준 문서와 같은 계산).
 * 추가 환불은 자리가 다시 예약된 채로 모임이 시작됐을 때, 시작한 뒤에 들어온다(docs/02-architecture.md 6.4).
 */
const resaleCase = RESALE_EXAMPLE_CASES.find((c) => c.baseRate === 0) ?? RESALE_EXAMPLE_CASES[0];
const resaleExample = resaleCase
  ? `예를 들어 '${CANCELLATION_PRESETS[RESALE_EXAMPLE.preset].label}' 기준의 자리를 ${formatKRW(RESALE_EXAMPLE.paidAmount)}에 결제했고, 호스트가 재판매 연동 환불률을 ${RESALE_EXAMPLE.resaleRefundRate}%로 정했다고 할게요. 시작 ${resaleCase.hoursBefore}시간 전에 취소하면 바로 받는 환불은 ${formatKRW(resaleCase.baseRefund)}이에요. 그 자리가 다시 예약된 채로 모임이 시작되면, 시작한 뒤에 ${formatKRW(resaleCase.extraRefund)}을 더 돌려받아요.`
  : "";

const SMS_PENDING: FaqPendingNote = {
  until: "sms:solapi",
  text: "문자 발송은 아직 연동 전이에요. 지금은 알림이 서비스 안의 알림함으로만 전달돼요.",
};

// ── 고객 ──────────────────────────────────────────────

const CUSTOMER_GROUPS: FaqGroup[] = [
  {
    id: "about",
    title: "남는자리 알아보기",
    audience: "customer",
    items: [
      {
        id: "what-is",
        q: "남는자리는 어떤 서비스인가요?",
        a: paras(
          "취소됐거나 아직 채워지지 않은 예약 자리를 모아서 보여 주는 서비스예요. 호스트가 남은 자리를 올리면, 곧 시작하는 순서대로 보고 바로 예약할 수 있어요.",
          "지금은 대전의 소개팅과 소셜 모임 자리부터 다루고 있어요.",
          "남는자리는 자리를 연결하는 중개 서비스예요. 모임을 열고 진행하는 곳은 각 호스트예요. 호스트의 상호, 대표자, 사업자등록번호, 사업장 주소, 연락처는 자리 상세 화면에서 예약하기 전에 볼 수 있어요.",
          "결제와 환불은 남는자리가 예약할 때의 취소·환불 기준대로 처리해요.",
          "약관과 정책 문서에서는 호스트를 '판매자'라고 불러요. 같은 뜻이에요.",
        ),
        links: [{ label: "이용약관 보기", href: legalDocHref("terms", "company-role") }],
      },
      {
        id: "price",
        q: "남는 자리는 할인된 가격인가요?",
        a: paras(
          "꼭 그렇지는 않아요. 남는자리의 자리는 정가가 기본이에요. 자리가 남았다고 해서 값이 자동으로 내려가지 않아요.",
          "호스트가 가격을 낮춘 자리는 원래 가격과 함께 보여 드려요. 원래 가격은 그 상품의 정가보다 높게 적을 수 없어요.",
          "화면에 보이는 가격이 내는 돈의 전부예요. 남는자리가 고객에게 따로 받는 수수료는 없어요.",
          "남은 자리 수와 '취소석', '노쇼 공석', '미판매' 표시는 모두 실제 값이에요. 목록은 시작이 가까운 순서로 보여 드리고, 돈을 받고 순서를 올려 주는 광고는 없어요.",
        ),
        links: [{ label: "노출·정렬 기준 보기", href: legalDocHref("ranking-policy") }],
      },
    ],
  },
  {
    id: "booking",
    title: "예약과 결제",
    audience: "customer",
    items: [
      {
        id: "how-to-book",
        q: "예약은 어떻게 하나요?",
        a: paras(
          "자리를 고르고, 총액과 취소·환불 기준을 확인한 뒤 결제하면 예약이 확정돼요.",
          "예약할 때는 두 가지에 동의해요. 취소·환불 기준을 확인했다는 것과, 예약 정보를 그 자리의 호스트에게 전달한다는 것이에요.",
          "호스트 승인이 필요한 자리는 호스트가 승인해야 확정돼요. 승인되지 않으면 결제한 금액은 전액 환불돼요.",
          "성별 좌석이나 나이 조건이 있는 자리는 회원 정보의 성별과 출생 연도가 조건에 맞아야 예약할 수 있어요. 한 회차에는 진행 중인 예약을 하나만 가질 수 있어요.",
          "모임 장소의 정확한 주소는 예약이 확정된 뒤에 보여 드려요.",
          "호스트가 특정 고객의 예약을 받지 않도록 설정한 경우에는 그 호스트의 자리를 예약할 수 없어요. 부당하다고 생각하면 남는자리에 분쟁을 접수해 주세요.",
        ),
      },
      {
        id: "payment-methods",
        q: "결제는 어떤 방식으로 하나요?",
        a: paras(
          "결제 방식은 호스트가 상품마다 정해요. 전액을 미리 결제하는 방식, 예약금만 결제하고 나머지를 현장에서 내는 방식, 전액을 현장에서 내는 방식, 무료가 있어요. 어떤 방식인지는 예약 화면에 나와요.",
          "온라인 결제는 결제 화면에 나오는 수단(카드, 간편결제 등)으로 해요. 남는자리는 카드 번호 전체를 저장하지 않아요. 결제 대행사가 알려 준 승인 결과(일부를 가린 카드 번호, 카드사, 승인번호 등)만 결제 기록으로 보관해요.",
          "현장에서 내는 금액은 호스트에게 직접 내요. 예약 화면에 나온 금액 말고 다른 돈을 요구받았다면 남는자리에 알려 주세요.",
        ),
        pendingNotes: [
          {
            until: "payment:toss",
            text: "결제 대행사는 아직 연동 전이에요. 지금은 테스트 결제만 동작하고 실제로 청구되지 않아요.",
          },
        ],
      },
      {
        id: "hold",
        q: "결제하는 동안 자리는 어떻게 되나요?",
        a: paras(
          "결제를 시작하면 {{settings.holdMinutes|min}} 동안 자리를 잡아 둬요. 그동안 다른 사람은 그 자리를 예약할 수 없어요.",
          "시간 안에 결제를 마치지 않으면 예약은 자동으로 취소되고 자리는 다시 열려요. 이때 결제는 이루어지지 않아요.",
          "시간이 남아 있으면 예약 내역에서 이어서 결제할 수 있어요. 시간이 지났더라도 자리가 남아 있으면 다시 예약할 수 있어요.",
        ),
      },
    ],
  },
  {
    id: "cancel",
    title: "취소와 환불",
    audience: "customer",
    items: [
      {
        id: "cancel-how",
        q: "예약을 취소하려면 어떻게 하나요?",
        a: paras(
          "회차가 시작하기 전까지 예약 상세 화면에서 직접 취소할 수 있어요. 취소하기 전에 지금 취소하면 얼마를 돌려받는지 먼저 보여 드려요.",
          "취소 절차는 예약 절차보다 길지 않아요. 전화로 따로 요청할 필요가 없어요.",
          "못 가게 됐다면 일찍 취소해 주세요. 빨리 취소할수록 다른 분이 그 자리를 쓸 수 있어요.",
        ),
        links: [{ label: "내 예약 보기", href: "/my/bookings" }],
      },
      {
        id: "refund-amount",
        q: "취소하면 얼마를 돌려받나요?",
        a: paras(
          "환불 기준은 호스트가 상품마다 정하고, 예약할 때의 기준이 그대로 적용돼요. 호스트가 나중에 기준을 바꿔도 이미 한 예약에는 영향이 없어요.",
          "환불률은 회차 시작 시각까지 남은 시간으로 정해져요. 호스트는 보통 아래 세 가지 가운데 하나를 골라요.",
          presetLine("FLEXIBLE"),
          presetLine("STANDARD"),
          presetLine("STRICT"),
          "회차가 시작한 뒤에 취소하면 환불되지 않아요. 다만 모임이 열리지 않았거나 안내와 크게 달랐다면 예약 상세 화면에서 분쟁을 접수해 주세요.",
          "내 예약에 적용되는 기준은 결제하기 전 예약 화면과 예약 상세에서 볼 수 있어요.",
        ),
        links: [{ label: "취소·환불 기준 보기", href: legalDocHref("refund-policy", "presets") }],
      },
      {
        id: "free-cancel",
        q: "예약하자마자 취소하면 전액 환불되나요?",
        a: paras(
          "[[if settings.cancelGraceMinutes]]예약한 뒤 {{settings.cancelGraceMinutes|min}} 안에 취소하면 환불 기준과 관계없이 전액 환불돼요. 실수로 한 예약을 보호하기 위한 시간이에요.[[else]]지금은 예약 직후 무료 취소 시간을 운영하지 않아요. 취소하면 예약할 때의 환불 기준이 적용돼요.[[end]]",
          "[[if settings.cancelGraceMinutes & settings.cancelGraceMinLeadMinutes]]다만 예약할 때 시작까지 {{settings.cancelGraceMinLeadMinutes|min}}보다 적게 남았던 임박 예약에는 적용되지 않아요. 임박한 자리는 취소되면 다시 채우기 어렵기 때문이에요.[[else]]내 예약에 어떤 기준이 적용되는지는 예약 화면에서 확인할 수 있어요.[[end]]",
          "[[if settings.cancelGraceMinutes]]무료 취소가 되는 예약인지는 결제하기 전에 예약 화면에서 알려 드려요. [[end]]결제하는 때에 이미 환불이 없는 구간이라면 그 점도 예약 화면에 따로 알려 드려요.",
        ),
        links: [{ label: "무료 취소 기준 보기", href: legalDocHref("refund-policy", "grace") }],
      },
      {
        id: "host-cancel",
        q: "호스트 사정으로 취소되거나 인원이 모이지 않으면 어떻게 되나요?",
        a: paras(
          "결제한 금액을 전액 환불해 드려요. 따로 신청하지 않아도 자동으로 환불돼요.",
          "다음 네 경우가 모두 해당돼요. 첫째, 호스트 사정으로 예약이나 회차가 취소된 경우예요. 둘째, 남는자리 운영 사정으로 취소된 경우예요. 셋째, 호스트가 예약을 승인하지 않은 경우예요. 넷째, 최소 인원이 모이지 않아 회차가 취소된 경우예요.",
          "확정된 예약이 호스트나 운영 사정으로 취소되면, 헛걸음하지 않도록 알림 설정과 관계없이 문자로도 알려 드려요.",
          "호스트 사정으로 취소돼 손해가 생겼다면 예약 상세 화면에서 분쟁을 접수할 수 있어요.",
        ),
        pendingNotes: [SMS_PENDING],
      },
      {
        id: "refund-timing",
        q: "환불은 언제 들어오나요?",
        a: paras(
          "취소가 처리되면 결제한 수단으로 바로 환불을 요청해요. 환불이 끝나면 알림으로 알려 드려요.",
          "실제로 반영되는 때는 카드사와 결제 수단에 따라 달라요. 며칠 걸릴 수 있어요.",
          "현장에서 호스트에게 직접 낸 금액은 호스트에게 환불을 요청해야 해요. 해결되지 않으면 남는자리에 분쟁을 접수할 수 있어요.",
        ),
        links: [{ label: "환불 방법과 걸리는 시간 보기", href: legalDocHref("refund-policy", "refund-timing") }],
      },
      {
        id: "resale-refund",
        q: "'다시 팔리면 환불'은 무엇인가요?",
        a: paras(
          "환불이 적거나 없는 시점에 취소했더라도, 그 자리가 다시 예약된 채로 모임이 시작되면 호스트가 정한 비율까지 더 돌려받는 제도예요. 호스트가 이 제도를 켠 상품에만 적용되고, 예약 화면에 다시 팔리면 최대 몇 %까지 환불되는지 나와요.",
          resaleExample,
          "다시 팔렸는지는 모임이 시작할 때 한 번만 확인해요. 그 전에 새 예약이 들어와도 바로 환불되지는 않고, 취소할 때 더 받을 수 있는 금액을 '환불 예정'으로 알려 드려요.",
          "시작할 때 같은 좌석 유형에 안 팔린 자리가 남아 있으면 그만큼은 다시 팔린 것으로 계산하지 않아요. 호스트가 직접 입력한 예약과, 취소한 본인이 다시 한 예약도 빼고 계산해요.",
          "취소한 분이 여럿이면 먼저 취소한 예약부터 차례로 적용돼요. 시작할 때 다시 팔린 자리가 없으면 추가 환불은 없어요.",
          "추가 환불은 남는자리에서 온라인으로 결제한 금액에만 적용돼요. 따로 신청하지 않아도 모임이 시작한 뒤에 자동으로 들어와요.",
        ),
        links: [{ label: "재판매 연동 환불 자세히 보기", href: legalDocHref("refund-policy", "resale-refund") }],
      },
    ],
  },
  {
    id: "waitlist",
    title: "대기와 자리 제안",
    audience: "customer",
    items: [
      {
        id: "waitlist-join",
        q: "자리가 다 찼어요. 대기할 수 있나요?",
        a: paras(
          "네. 매진된 회차에는 좌석 유형별로 대기를 신청할 수 있어요. 예를 들어 남성석 대기와 여성석 대기는 따로 줄을 서요. 순번은 신청한 순서예요.",
          "대기는 무료이고 언제든 취소할 수 있어요. 결제는 자리를 제안받아 예약할 때 해요.",
          "자리가 다시 나면 대기 중인 분께 먼저 알려요. 호스트가 자리를 자동으로 다시 열지 않도록 설정한 경우에는 호스트가 자리를 다시 연 뒤에 알려요.",
        ),
      },
      {
        id: "waitlist-offer",
        q: "자리 제안을 받으면 얼마 안에 예약해야 하나요?",
        a: paras(
          "시작까지 남은 시간에 따라 달라요.",
          "시작까지 24시간 이상 남았으면 순번대로 한 분씩 제안하고, {{settings.waitlistOfferMinutes|min}} 동안 자리를 잡아 둬요.",
          "24시간보다 적게 남았으면 남은 시간의 10% 동안 잡아 둬요. 다만 {{settings.waitlistOfferMinMinutes|min}}보다 짧아지지는 않아요.",
          "시작까지 {{settings.waitlistBroadcastWithinMinutes|min}} 이내로 남았으면 같은 좌석 유형의 대기자 모두에게 동시에 알려요. 이때는 자리를 잡아 두지 않아서 먼저 예약한 분이 자리를 얻어요.",
          "밤 10시부터 아침 8시 사이에 받은 제안은, 시작까지 12시간 이상 남았다면 돌아오는 오전 9시까지로 늘어나요. 응답 시간은 예약 마감 시각을 넘지 않으니 알림에 적힌 마감 시각을 확인해 주세요.",
          "자리 제안은 예약에 필요한 알림이라 밤에도 보내요. 빈자리 광고 문자를 보내지 않는 밤 시간(밤 9시부터 아침 8시)과는 기준이 달라요.",
        ),
        links: [{ label: "대기와 자리 제안 규칙 보기", href: legalDocHref("terms", "waitlist") }],
      },
      {
        id: "waitlist-missed",
        q: "자리 제안을 받으면 예약이 확정된 건가요? 놓치면 어떻게 되나요?",
        a: paras(
          "아니에요. 자리 제안과 알림은 예약 보장이 아니에요. 응답 시간 안에 예약과 결제를 마쳐야 자리가 확정돼요.",
          "제안을 한 번 놓치면 대기는 유지되지만 순번이 맨 뒤로 가요. 두 번 놓치면 대기가 끝나요.",
          "내 차례가 지나간 자리는 다음 대기자에게 넘어가고, 대기자가 더 없으면 모두에게 공개돼요.",
        ),
      },
    ],
  },
  {
    id: "attendance",
    title: "개최 확정과 참석",
    audience: "customer",
    items: [
      {
        id: "go-confirmed",
        q: "'모으는 중'과 '개최 확정'은 무슨 뜻인가요?",
        a: paras(
          "호스트가 회차를 여는 데 필요한 최소 인원을 정해 둔 경우에 보여요. '모으는 중'은 아직 최소 인원이 차지 않았다는 뜻이고, 확정까지 몇 명이 남았는지 함께 보여 드려요.",
          "모든 좌석 유형이 최소 인원을 채우면 '개최 확정'으로 바뀌어요. 한 번 확정되면 그 뒤에 취소하는 분이 나와도 되돌리지 않아요.",
          "판정 시각까지 인원이 모이지 않으면 회차는 자동으로 취소되고 결제한 금액은 전액 환불돼요.",
          "이 표시가 없는 회차는 최소 인원 조건 없이 열리는 회차예요.",
        ),
      },
      {
        id: "attendance-check",
        q: "시작 전 알림은 언제 오고, 현장에서는 무엇을 보여 주나요?",
        a: paras(
          "보통 시작 전날과 시작 몇 시간 전에 알림이 와요. 알림에서 예약을 확인하고, 못 가게 됐다면 바로 취소할 수 있어요. 알림 시점이 지난 뒤에 한 예약에는 그 알림이 오지 않아요.",
          "서비스 안의 알림은 항상 와요. 문자로도 오는지는 호스트의 설정에 따라 달라요.",
          "현장에서는 예약 패스의 QR이나 예약번호를 보여 주세요. 호스트가 확인하면 체크인이 끝나요. 늦을 것 같으면 상품의 유의 사항에 적힌 입장 기준을 미리 확인해 주세요.",
        ),
        links: [{ label: "내 예약 보기", href: "/my/bookings" }],
      },
      {
        id: "no-show",
        q: "노쇼가 되면 어떻게 되나요? 참석했는데 노쇼로 처리됐다면요?",
        a: paras(
          "예약을 취소하지 않고 오지 않으면 호스트가 회차 시작 뒤에 노쇼로 처리할 수 있어요. 노쇼로 처리된 예약은 환불되지 않아요. 노쇼로 처리되면 바로 알려 드려요.",
          "노쇼가 처음 기록되면 경고 알림을 보내요. 최근 {{settings.noShowWindowDays|days}} 동안 노쇼가 {{settings.noShowLimit}}회에 이르면 {{settings.noShowRestrictDays|days}} 동안 새 예약이 제한돼요. 노쇼 횟수만으로 계정이 자동으로 영구 정지되지는 않아요.",
          `처리가 잘못됐다면 노쇼로 처리된 때부터 ${HELP_FACTS.noShowDisputeHours}시간 안에 예약 상세 화면에서 이의를 제기해 주세요. 남는자리가 양쪽의 설명과 체크인 기록을 확인하고, 잘못된 처리였다면 노쇼 기록을 되돌려요.`,
          `호스트도 노쇼 처리 후 ${HELP_FACTS.noShowRevertHours}시간 안에는 직접 되돌릴 수 있어요.`,
        ),
        links: [{ label: "체크인과 노쇼 규칙 보기", href: legalDocHref("terms", "attendance-noshow") }],
      },
    ],
  },
  {
    id: "account",
    title: "계정과 알림",
    audience: "customer",
    items: [
      {
        id: "identity",
        q: "본인확인은 꼭 해야 하나요?",
        a: paras(
          "모든 자리에 필요한 것은 아니에요. 호스트가 본인확인이 필요하다고 정한 자리만 본인확인을 마친 회원이 예약할 수 있어요.",
          "본인확인을 마친 뒤에는 이름, 성별, 출생 연도를 직접 바꿀 수 없어요.",
        ),
        pendingNotes: [
          {
            until: "identity",
            text: "본인확인 서비스는 아직 연동 전이에요. 지금은 본인확인이 필요한 자리라는 안내만 보여 드려요.",
          },
        ],
      },
      {
        id: "notifications",
        q: "알림은 어떻게 설정하나요?",
        a: paras(
          "마이 > 알림 설정에서 바꿀 수 있어요.",
          "예약 확정, 취소, 환불, 자리 제안 같은 예약 알림은 서비스 안의 알림함에 항상 남아요. 문자로도 받을지는 직접 고를 수 있고, 후기 요청 문자도 끌 수 있어요.",
          `빈자리 알림은 팔로우한 호스트, 찜한 상품, 저장해 둔 조건에 맞는 자리가 열릴 때 와요. 조건은 ${HELP_FACTS.maxAlertRules}개까지 저장할 수 있어요. 한 회차에 한 번만, 하루에 ${HELP_FACTS.vacancyDailyLimit}건까지만 보내요.`,
          "빈자리 소식을 문자로 받으려면 광고성 정보 수신에 먼저 동의해야 해요. 이 동의는 선택이고 언제든 철회할 수 있어요. 밤 9시부터 아침 8시 사이에는 야간 수신에 따로 동의한 분께만 보내요.",
        ),
        links: [{ label: "광고성 정보 수신 동의 안내 보기", href: legalDocHref("marketing-consent") }],
        pendingNotes: [SMS_PENDING],
      },
      {
        id: "withdraw",
        q: "탈퇴는 어떻게 하나요?",
        a: paras(
          "마이 화면에서 바로 보이는 '회원 탈퇴'에서 직접 할 수 있어요. 진행 중인 예약이나 끝나지 않은 환불이 있으면 정리된 뒤에 탈퇴할 수 있어요.",
          "본인 확인을 위해 비밀번호를 한 번 입력해요. 카카오로만 가입했다면 비밀번호 대신 확인 문구를 입력해요.",
          "탈퇴하면 계정의 이메일, 이름, 연락처는 바로 지워요. 다만 예약할 때 남긴 이름과 연락처가 들어 있는 예약·결제 기록은 법령이 정한 기간 동안 보관해요.",
          "쓴 후기는 '탈퇴한 회원'의 후기로 남으니, 지우고 싶다면 탈퇴 전에 마이 > 내가 쓴 후기에서 지워 주세요.",
          "탈퇴한 계정은 되살릴 수 없어요.",
        ),
        links: [{ label: "탈퇴하면 지우는 정보와 남는 기록 보기", href: legalDocHref("privacy", "retention") }],
      },
    ],
  },
  {
    id: "trust",
    title: "후기와 안전",
    audience: "customer",
    items: [
      {
        id: "reviews",
        q: "후기는 누가, 언제 쓸 수 있나요?",
        a: paras(
          "이용을 마친 예약에만 쓸 수 있어요. 이용을 마친 날부터 {{settings.reviewWindowDays|days}} 안에, 예약 한 건에 하나를 쓸 수 있어요. 취소했거나 노쇼로 처리된 예약에는 쓸 수 없어요.",
          "후기는 쓰는 즉시 공개되고, 작성자 이름은 일부를 가려서 보여 드려요. 내가 쓴 후기는 직접 지울 수 있어요.",
          `호스트는 답글만 달 수 있어요. 후기를 지우거나 숨길 수 없어요. 평점은 공개된 후기의 평균이고, 공개된 후기가 ${REVIEW_MIN_COUNT_FOR_RATING}개보다 적으면 평점 대신 '신규'로 표시해요.`,
        ),
        links: [{ label: "후기 운영정책 보기", href: legalDocHref("review-policy") }],
      },
      {
        id: "safety",
        q: "처음 보는 사람들과의 모임, 안전한가요? 문제가 생기면 어디에 알리나요?",
        a: paras(
          "남는자리에는 입점 심사를 거친 사업자만 자리를 올릴 수 있어요. 심사에서는 사업자 정보를 확인해요. 모임의 내용과 현장 안전까지 남는자리가 보증하는 것은 아니에요.",
          "호스트는 영업장이나 공개된 상업 시설에서만 모임을 열어야 해요. 모임 장소의 정확한 주소는 예약이 확정된 분께만 보여 드리고, 참가자의 연락처는 다른 참가자에게 공개하지 않아요.",
          "불편하거나 위험한 일이 있었다면 예약 상세 화면에서 신고해 주세요. 누가 신고했는지는 상대에게 알리지 않아요. 급한 상황이면 먼저 112에 신고하세요.",
          `신고나 분쟁을 접수하면 ${HELP_FACTS.disputeProgressBusinessDays}영업일 안에 진행 상황을, ${HELP_FACTS.disputeResultBusinessDays}영업일 안에 처리 결과를 알려 드려요.`,
        ),
        links: [
          { label: "안전 수칙 보기", href: HELP_SAFETY_PATH },
          { label: "분쟁 해결 절차 보기", href: legalDocHref("terms", "disputes") },
        ],
      },
    ],
  },
];

// ── 호스트 ────────────────────────────────────────────

const SELLER_GROUPS: FaqGroup[] = [
  {
    id: "seller-start",
    title: "입점과 요금",
    audience: "seller",
    items: [
      {
        id: "seller-onboarding",
        q: "입점하려면 무엇이 필요한가요?",
        a: paras(
          "남는자리에 가입한 뒤 입점을 신청하면 돼요. 사업장 이름(상호), 업종, 대표 전화번호, 사업장 주소, 사업자등록번호, 대표자 이름을 입력해요.",
          "운영자가 내용을 확인한 뒤 승인하거나, 사유를 알려 반려해요. 심사 결과는 알림과 이메일로 알려 드려요. 반려된 신청은 내용을 고쳐 다시 낼 수 있어요.",
          "상호, 대표자, 사업자등록번호, 사업장 주소, 전화번호는 법에 따라 고객에게 공개돼요. 통신판매업 신고가 필요한 경우에는 호스트가 직접 신고하고 신고번호를 남는자리에 알려 주세요.",
          "정산을 받으려면 대표 계정으로 정산 계좌를 등록해 주세요.",
          `한 계정이 대표로 둘 수 있는 사업장은 ${HELP_FACTS.maxOwnedBusinesses}곳까지예요.`,
        ),
        links: [{ label: "입점 심사와 필요한 정보 보기", href: legalDocHref("seller-terms", "onboarding") }],
        pendingNotes: [
          {
            until: "email:resend",
            text: "이메일 발송은 아직 연동 전이에요. 지금은 심사 결과를 서비스 안의 알림으로만 알려 드려요.",
          },
        ],
      },
      {
        id: "commission",
        q: "수수료는 얼마인가요? 언제 0%인가요?",
        a: paras(
          "남는자리가 채운 자리에만 수수료를 받아요. 고객에게는 수수료를 받지 않아요.",
          "남는자리의 탐색, 검색, 알림, 대기로 처음 온 고객의 예약은 {{settings.commissionNewCustomerBps|percent}}예요(프로 플랜은 {{settings.proCommissionNewCustomerBps|percent}}). 이 요율에는 결제 대행 수수료가 들어 있어서 따로 떼지 않아요. 같은 고객에게는 처음 한 번만 받는 것이 원칙이에요.",
          "최근 {{settings.returningWindowDays|days}} 안에 우리 사업장을 이용한 적이 있는 고객이 남는자리로 다시 예약하면 {{settings.commissionReturningBps|percent}}예요. 내 예약 링크로 들어온 예약은 {{settings.commissionDirectBps|percent}}예요. 직접 입력한 예약과, 직접 등록하거나 가져온 고객 명단에 예약 전부터 있던 고객의 예약에는 중개 수수료가 없어요.",
          "중개 요율이 0%인 예약에 온라인 결제가 있으면 결제 실비({{settings.pgFeeBps|percent}})를 차감해요. 직접 입력한 예약에는 아무것도 차감하지 않아요.",
          "[[if settings.commissionMinPerSeat & settings.commissionMinMaxRatioBps]]중개 요율이 0%보다 큰 예약에는 1인당 최소 {{settings.commissionMinPerSeat|krw}}을 받아요. 다만 좌석 가격의 {{settings.commissionMinMaxRatioBps|percent}}를 넘지 않아요.[[else]]1인당 최소 수수료는 지금 두지 않아요.[[end]] [[if settings.commissionCapPerSeat]]중개 수수료는 1인당 {{settings.commissionCapPerSeat|krw}}을 넘지 않아요.[[else]]1인당 상한은 지금 두지 않아요.[[end]]",
          "어떤 규칙이 적용됐는지는 정산서에서 예약마다 볼 수 있어요.",
        ),
        links: [{ label: "수수료 규칙 표 보기", href: legalDocHref("seller-terms", "commission") }],
      },
      {
        id: "launch-promo",
        q: "입점 프로모션은 어떻게 적용되나요?",
        a: paras(
          "[[if settings.launchPromoMonths & settings.launchPromoBookings]]입점이 승인된 때부터 {{settings.launchPromoMonths}}개월 동안, 프로모션을 적용받은 예약 {{settings.launchPromoBookings}}건까지 중개 수수료가 없어요. 둘 가운데 먼저 끝나는 때에 프로모션이 끝나요.[[else]]지금은 새로 입점하는 호스트에게 입점 프로모션을 운영하지 않아요. 이미 받은 프로모션은 승인할 때 정해진 기간과 건수까지 유지돼요.[[end]]",
          "프로모션을 적용받은 예약에도 온라인 결제가 있으면 결제 실비({{settings.pgFeeBps|percent}})가 차감돼요.",
          "직접 입력한 예약, 내 예약 링크로 들어온 예약, 내 고객의 예약, 다시 온 고객의 예약은 프로모션보다 먼저 판정해요. 그래서 프로모션 건수에 들어가지 않아요.",
        ),
      },
      {
        id: "pro-plan",
        q: "프로 플랜은 무엇이 다른가요?",
        a: paras(
          "프로 플랜은 월 {{settings.proPriceMonthly|krw}}(부가세 포함)이에요. 남는자리 신규 고객 요율이 {{settings.commissionNewCustomerBps|percent}}에서 {{settings.proCommissionNewCustomerBps|percent}}로 낮아져요.",
          `자동 메시지의 문구와 발송 시점을 바꿀 수 있고, 상세 분석과 고객 명단 내려받기를 쓸 수 있어요. 구성원은 대표를 포함해 ${PLAN_LIMITS.PRO.maxTeamMembers}명까지(베이직 ${PLAN_LIMITS.FREE.maxTeamMembers}명), 판매 중인 상품은 ${PLAN_LIMITS.PRO.maxActiveProducts}개까지(베이직 ${PLAN_LIMITS.FREE.maxActiveProducts}개) 둘 수 있어요. 자동 문자는 한 달에 {{settings.proMonthlyMessages}}건까지(베이직 {{settings.freeMonthlyMessages}}건) 보낼 수 있어요.`,
          "대기, 취소된 자리 다시 올리기, 직접 입력 예약, 내 예약 링크, 체크인, 환불 기준 설정처럼 자리를 채우는 기능은 베이직에서도 모두 쓸 수 있어요.",
          "약정 기간이나 해지 위약금은 없어요. 지금은 구독료 자동결제가 연동되지 않아서, 신청하면 운영자가 확인한 뒤 플랜을 적용해 드려요.",
        ),
        links: [{ label: "구독 조건 보기", href: legalDocHref("seller-terms", "subscription") }],
      },
    ],
  },
  {
    id: "seller-bookings",
    title: "예약 받기",
    audience: "seller",
    items: [
      {
        id: "manual-booking",
        q: "전화나 현장으로 받은 예약도 넣을 수 있나요?",
        a: paras(
          "네. 전화, 메시지, 현장에서 받은 예약은 '직접 입력'으로 넣어 주세요. 좌석 수가 바로 줄어서 같은 자리가 두 번 팔리지 않아요.",
          "직접 입력한 예약에는 수수료가 없어요. 결제 실비도 차감하지 않아요.",
          "직접 입력한 예약도 개최 확정에 필요한 최소 인원에 들어가요. 다만 회원 계정으로 한 예약이 아니어서 후기는 쓸 수 없어요.",
        ),
      },
      {
        id: "direct-link",
        q: "내 예약 링크는 무엇인가요?",
        a: paras(
          "우리 사업장 전용 페이지의 주소예요. 인스타그램 프로필이나 메신저, QR로 알리면 고객이 바로 우리 자리를 보고 예약할 수 있어요.",
          `이 링크로 들어온 고객이 ${HELP_FACTS.directLinkDays}일 안에 우리 자리를 예약하면 '내 예약 링크' 예약으로 기록돼요. 중개 수수료는 {{settings.commissionDirectBps|percent}}예요. 중개 요율이 0%이면 온라인 결제에 결제 실비({{settings.pgFeeBps|percent}})만 차감돼요.`,
          "우리 사업장의 예약 링크 코드가 붙은 주소나 QR로 들어온 방문은 언제나 해당해요. 코드가 없는 사업장 페이지 주소는 남는자리 밖에서 바로 열고 들어온 경우에만 해당해요.",
          "남는자리 안에서 사업장 이름을 눌러 들어온 방문은 남는자리 탐색으로 온 것으로 봐요.",
        ),
      },
      {
        id: "seller-waitlist",
        q: "대기자는 어떻게 관리되나요?",
        a: paras(
          "대기는 좌석 유형별로 받아요. 자리가 나면 남는자리가 순번대로 알아서 제안하니 직접 연락할 필요가 없어요.",
          "시작까지 24시간 이상 남았으면 한 분씩 {{settings.waitlistOfferMinutes|min}} 동안 자리를 잡아 두고 제안해요. 시작이 가까워지면 응답 시간이 짧아지고, {{settings.waitlistBroadcastWithinMinutes|min}} 이내에는 대기자 모두에게 동시에 알려서 먼저 예약한 분이 자리를 얻어요.",
          "제안 중인 자리는 잡힌 자리로 세어서 다른 고객에게는 보이지 않아요.",
          "대기에서 넘어온 예약의 수수료는 남는자리 탐색으로 온 예약과 같은 기준으로 판정해요.",
        ),
      },
      {
        id: "checkin",
        q: "체크인과 노쇼 처리는 어떻게 하나요?",
        a: paras(
          "현장에서 고객의 예약 패스 QR을 찍거나, 예약번호를 입력하거나, 명단에서 골라 체크인해요. 체크인한 예약은 이용 완료로 처리돼요.",
          `오지 않은 고객은 회차가 시작한 뒤에 노쇼로 처리할 수 있어요. 잘못 처리했다면 ${HELP_FACTS.noShowRevertHours}시간 안에 직접 되돌릴 수 있어요. 고객은 ${HELP_FACTS.noShowDisputeHours}시간 안에 이의를 제기할 수 있어요.`,
          "회차가 끝나고 {{settings.autoCompleteAfterHours|hours}}이 지나도록 처리하지 않은 확정 예약은 자동으로 이용 완료가 돼요. 노쇼가 있었다면 그 전에 처리해 주세요.",
        ),
      },
    ],
  },
  {
    id: "seller-vacancy",
    title: "빈자리 채우기",
    audience: "seller",
    items: [
      {
        id: "relist",
        q: "취소된 자리는 어떻게 다시 채우나요?",
        a: paras(
          "자동 재등록을 켜 두면(기본값) 취소된 자리가 바로 다시 열려요. 대기자가 있으면 대기자에게 먼저 제안하고, 대기자가 없거나 제안이 모두 지나가면 모두에게 공개해요. 이때 '취소석' 표시가 붙고, 팔로워와 찜한 고객, 조건이 맞는 고객에게 빈자리 알림이 가요.",
          "자동 재등록을 꺼 두면 취소된 자리는 닫힌 채로 남아요. 취소로 자리가 생겼다는 알림을 받고 '다시 올리기'를 누르면 그때 위와 같은 순서로 열려요.",
          "다른 경로로 이미 채운 자리라면 다시 올리지 말고 직접 입력 예약으로 반영해 주세요.",
        ),
      },
      {
        id: "seller-cancel",
        q: "사정이 생겨 회차를 취소해야 하면 어떻게 되나요?",
        a: paras(
          "호스트 사정으로 예약이나 회차를 취소하면 고객이 결제한 금액은 시점과 관계없이 전액 환불돼요. 이 예약에는 수수료가 없어요.",
          "취소 사실은 고객의 알림 설정과 관계없이 문자와 알림으로 전달돼요.",
          "호스트 사정의 취소는 기록에 남아요. 반복되면 경고나 이용 제한을 받을 수 있어요. 천재지변처럼 막을 수 없는 사정이었다면 제재에 반영하지 않아요.",
          "열기 어려운 회차는 되도록 빨리 취소해 주세요.",
        ),
        links: [{ label: "판매자 사정으로 취소할 때 보기", href: legalDocHref("seller-terms", "seller-cancellation") }],
        pendingNotes: [SMS_PENDING],
      },
    ],
  },
  {
    id: "seller-money",
    title: "정산과 고객 정보",
    audience: "seller",
    items: [
      {
        id: "settlement",
        q: "정산은 언제, 어떻게 받나요?",
        a: paras(
          "정산은 주 단위로 집계해요. 회차가 끝난 예약만 집계에 들어가요.",
          "예약 한 건의 지급액은 환불을 뺀 온라인 결제 금액에서 중개 수수료와 결제 실비를 뺀 금액이에요. 현장에서 받은 금액은 남는자리가 받은 돈이 아니어서 수수료만 차감해요. 차감할 금액이 더 많으면 다음 정산 금액에서 빼요.",
          `정산서에는 예약마다 유입 경로와 적용된 수수료 규칙이 나와요. 판정이 잘못됐다고 생각하면 건별로 이의를 제기할 수 있고, ${HELP_FACTS.disputeResultBusinessDays}영업일 안에 결과와 이유를 알려 드려요.`,
          "지금은 정산 송금이 연동되지 않았어요. 실제 결제가 열리기 전에는 집계와 기록만 볼 수 있어요. 송금 방식과 지급 요일은 정식 운영 전에 정해서 알려 드려요.",
        ),
        links: [{ label: "정산 기준 보기", href: legalDocHref("seller-terms", "settlement") }],
      },
      {
        id: "customer-data",
        q: "고객 정보는 어디까지 쓸 수 있나요?",
        a: paras(
          `예약을 진행하고 재방문·노쇼 이력을 관리하는 데만 쓸 수 있어요. ${THIRD_PARTY_PROVISION.purpose}가 여기에 해당해요.`,
          "광고나 홍보 연락에 다시 쓸 수 없어요. 다른 사람이나 다른 서비스에 넘길 수도 없고, 참가자의 연락처를 본인 동의 없이 다른 참가자에게 알려 줄 수도 없어요.",
          "고객별 메모와 태그, 예약 받지 않기 설정도 같은 목적으로만 써 주세요. 고객이 부당하다고 분쟁을 접수하면 남는자리가 사유를 확인해요.",
          "명단을 내려받거나 따로 적어 둔 정보는 그 예약의 정산·환불·분쟁 처리가 끝나면 바로 지워 주세요. 입점을 해지하면 남은 정보를 모두 지워야 해요.",
          "직접 등록하거나 가져온 고객 명단은 호스트가 적법하게 모은 정보여야 해요.",
        ),
        links: [{ label: "고객 개인정보 조항 보기", href: legalDocHref("seller-terms", "customer-data") }],
      },
    ],
  },
];

// ── 내보내기 ──────────────────────────────────────────

export const FAQ_GROUPS: readonly FaqGroup[] = [...CUSTOMER_GROUPS, ...SELLER_GROUPS];

/** 고객용 또는 호스트용 묶음만 */
export function faqGroupsFor(audience: FaqAudience): FaqGroup[] {
  return FAQ_GROUPS.filter((group) => group.audience === audience);
}

/** ID 로 질문 하나를 찾는다(빈 화면·도움말 링크에서 특정 답변을 보여 줄 때) */
export function getFaqItem(id: string): FaqItem | undefined {
  for (const group of FAQ_GROUPS) {
    const found = group.items.find((item) => item.id === id);
    if (found) return found;
  }
  return undefined;
}
