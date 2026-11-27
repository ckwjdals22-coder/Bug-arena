import { MIN_SIGNUP_AGE, POLICY_VERSIONS, type PolicyKind } from "@/lib/policy";
import { legalDocHref } from "./types";

/**
 * 동의 고지문(초안). 가입·예약·알림 설정 화면의 동의 항목이 그대로 가져다 쓰는 문안이다.
 * 동의 기록(ConsentRecord)의 종류마다 하나씩 있고, 기록에 남는 버전(POLICY_VERSIONS)이 이 문안을 가리킨다.
 * 문안을 고치면 src/lib/policy.ts 의 해당 버전 날짜도 함께 올린다.
 *
 * 원칙: 필수와 선택을 나눈다. 어떤 항목도 미리 선택해 두지 않는다. 선택 항목을 거부해도 이용에 제한이 없다.
 * 필수·선택 구분과 문안은 출시 전에 변호사 검토가 필요하다.
 */

/** 문안에서 판매자의 상호가 들어갈 자리. fillSellerName 으로 바꾼다 */
export const SELLER_NAME_TOKEN = "{판매자 상호}";

/**
 * 문안의 판매자 상호 자리를 실제 상호로 바꾼다. 상호가 비어 있으면 '해당 판매자'로 적는다
 * (상호가 비어 있는 사업장은 자리를 공개할 수 없으므로 실제로는 쓰이지 않는 안전장치다).
 * 문안에서는 상호 뒤에 받침에 따라 달라지지 않는 조사('에', '에서')만 쓴다.
 */
export function fillSellerName(text: string, sellerName: string): string {
  return text.split(SELLER_NAME_TOKEN).join(sellerName.trim() || "해당 판매자");
}

/**
 * 예약할 때 판매자에게 제공하는 개인정보. 개인정보처리방침의 제3자 제공 표, 예약 화면의 동의 고지,
 * 판매자 이용약관과 호스트 도움말이 모두 이 문구를 쓴다(문서마다 내용이 달라지지 않게).
 */
export const THIRD_PARTY_PROVISION = {
  /** 처리방침의 표에 적는 제공받는 자 */
  recipient: "회원이 예약한 자리의 판매자. 예약 화면의 동의 문구에 판매자의 상호를 표시합니다",
  items: "예약자 이름, 휴대전화 번호, 요청사항, 예약 내역(상품, 일시, 좌석 유형, 인원, 결제 금액)",
  /** 성별 좌석을 예약할 때 함께 알게 되는 정보 */
  itemsNote: "성별 좌석을 예약하면 좌석 유형으로 성별을 알 수 있습니다",
  purpose: "예약 확인, 참석 안내와 체크인, 문의 응대, 취소·환불과 분쟁 처리, 재방문 여부 확인과 노쇼 이력 관리",
  /** 판매자가 사업자 센터에서 보는 고객 이력의 항목 */
  historyItems: "이름, 연락처, 예약·방문·취소·노쇼 횟수, 누적 결제 금액",
  retention:
    "예약한 회차가 끝나고 정산·환불·분쟁 처리가 마무리될 때까지. 재방문 여부 확인과 노쇼 이력 관리를 위한 방문 이력(이름, 연락처, 예약·방문·취소·노쇼 횟수, 누적 결제 금액)은 회원이 탈퇴하거나 판매자가 남는자리 이용을 끝낼 때까지. 법령이 더 오래 보관하도록 정한 기록은 그 기간까지",
} as const;

export type ConsentStage = "signup" | "booking" | "settings";

export interface ConsentNotice {
  /** 동의 기록의 종류 */
  kind: PolicyKind;
  /** 동의 기록에 남기는 문안 버전 */
  version: string;
  /** 동의를 받는 화면. 광고성 정보와 야간 수신은 가입 화면과 알림 설정 양쪽에서 받는다 */
  stages: readonly ConsentStage[];
  /** 필수 동의인지. 선택 동의는 거부해도 이용에 제한이 없다 */
  required: boolean;
  /** 화면에서 미리 선택해 두는지 — 모든 항목이 false 다(다크패턴 방지) */
  preChecked: false;
  /** 체크박스 옆 문구 */
  label: string;
  /** 체크박스 아래에 펼쳐 보여 주는 고지 항목 */
  details: readonly { label: string; value: string }[];
  /** 동의하지 않을 권리와 그때 생기는 제한 */
  refusal: string;
  /** 전문을 볼 수 있는 문서 */
  href: string;
}

const notice = (kind: PolicyKind, body: Omit<ConsentNotice, "kind" | "version" | "preChecked">): ConsentNotice => ({
  kind,
  version: POLICY_VERSIONS[kind],
  preChecked: false,
  ...body,
});

export const CONSENT_NOTICES: Record<PolicyKind, ConsentNotice> = {
  TERMS: notice("TERMS", {
    stages: ["signup"],
    required: true,
    label: "이용약관에 동의합니다.",
    details: [{ label: "내용", value: "남는자리에서 자리를 예약하고 이용할 때 회사와 회원이 지키는 규칙입니다." }],
    refusal: "동의하지 않을 수 있으며, 이 경우 가입할 수 없습니다.",
    href: legalDocHref("terms"),
  }),
  PRIVACY: notice("PRIVACY", {
    stages: ["signup"],
    required: true,
    label: "개인정보 수집·이용에 동의합니다.",
    details: [
      { label: "목적", value: "회원 가입과 로그인, 예약·결제·환불 처리, 거래 알림 발송, 부정 이용 방지, 문의와 분쟁 처리" },
      {
        label: "항목",
        value: "이메일, 이름, 비밀번호(카카오로 가입하면 비밀번호 대신 카카오 회원 식별값). 입력한 경우 휴대전화 번호, 성별, 출생 연도",
      },
      { label: "보유 기간", value: "회원 탈퇴 때까지. 법령이 보관하도록 정한 거래 기록은 정해진 기간까지" },
    ],
    refusal: "동의하지 않을 수 있으며, 이 경우 가입할 수 없습니다.",
    href: legalDocHref("privacy", "collected-items"),
  }),
  MARKETING: notice("MARKETING", {
    stages: ["signup", "settings"],
    required: false,
    label: "광고성 정보(빈자리 소식 문자)를 받는 데 동의합니다.",
    details: [
      { label: "목적", value: "저장한 조건에 맞는 빈자리, 팔로우한 판매자와 찜한 상품의 새 자리 소식을 문자로 보내는 것" },
      { label: "이용 항목", value: "휴대전화 번호, 저장한 알림 조건, 팔로우한 판매자와 찜한 상품" },
      { label: "보유 기간", value: "동의를 철회하거나 탈퇴할 때까지" },
    ],
    refusal: "동의하지 않아도 가입과 예약에 제한이 없으며, 마이 > 알림 설정에서 언제든 철회할 수 있습니다.",
    href: legalDocHref("marketing-consent"),
  }),
  NIGHT_ALERT: notice("NIGHT_ALERT", {
    stages: ["signup", "settings"],
    required: false,
    label: "밤 9시부터 다음 날 아침 8시 사이에도 광고성 문자를 받는 데 동의합니다.",
    details: [{ label: "조건", value: "광고성 정보 수신에 동의한 경우에만 고를 수 있습니다." }],
    refusal: "동의하지 않아도 이용에 제한이 없으며 언제든 철회할 수 있습니다.",
    href: legalDocHref("marketing-consent", "night"),
  }),
  THIRD_PARTY: notice("THIRD_PARTY", {
    stages: ["booking"],
    required: true,
    label: `개인정보를 ${SELLER_NAME_TOKEN}에 제공하는 데 동의합니다.`,
    details: [
      { label: "제공받는 자", value: `${SELLER_NAME_TOKEN}(이 자리의 판매자)` },
      { label: "제공 항목", value: `${THIRD_PARTY_PROVISION.items}. ${THIRD_PARTY_PROVISION.itemsNote}` },
      { label: "이용 목적", value: THIRD_PARTY_PROVISION.purpose },
      { label: "보유·이용 기간", value: THIRD_PARTY_PROVISION.retention },
    ],
    refusal: "동의하지 않을 수 있으며, 이 경우 이 자리를 예약할 수 없습니다.",
    href: legalDocHref("privacy", "third-party"),
  }),
  REFUND_POLICY: notice("REFUND_POLICY", {
    stages: ["booking"],
    required: true,
    label: "취소·환불 기준을 확인했고 이에 동의합니다.",
    details: [
      {
        label: "내용",
        value: "이 예약에 적용되는 환불 기준과 지금 취소하면 돌려받는 금액은 이 화면에 표시된 내용과 같습니다. 예약 당시의 기준을 예약에 기록합니다.",
      },
    ],
    refusal: "동의하지 않을 수 있으며, 이 경우 이 자리를 예약할 수 없습니다.",
    href: legalDocHref("refund-policy"),
  }),
};

/** 화면별 동의 항목(보여 주는 순서대로). 필수 항목이 먼저 온다 */
export function consentNoticesFor(stage: ConsentStage): ConsentNotice[] {
  const order: readonly PolicyKind[] = ["TERMS", "PRIVACY", "REFUND_POLICY", "THIRD_PARTY", "MARKETING", "NIGHT_ALERT"];
  return order.map((kind) => CONSENT_NOTICES[kind]).filter((item) => item.stages.includes(stage));
}

/** 가입 화면의 나이 확인(동의 기록 종류는 아니지만 가입에 필요하다) */
export const AGE_CONFIRM_LABEL = `만 ${MIN_SIGNUP_AGE}세 이상입니다.`;

/**
 * 결제하는 시점에 이미 환불이 없는 구간인 예약에 따로 보여 주는 안내(취소·환불 기준 '기본 원칙').
 * 임박한 자리는 결제하자마자 환불이 없을 수 있으므로 동의 항목과 별개로 눈에 띄게 표시한다.
 */
export const NO_REFUND_AT_BOOKING_NOTICE = "결제한 뒤 취소해도 환불되지 않습니다.";
