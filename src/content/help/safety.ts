/**
 * 오프라인 모임 안전 수칙. 화면 문구와 같은 해요체로 쓴다. 순수 데이터라 서버·클라이언트 어디서든 가져다 쓸 수 있다.
 *
 * 쓰는 곳: 안전 수칙 화면, 예약 확정 화면·확정 알림의 짧은 안내, 호스트 온보딩.
 * 긴급 연락처에는 누구나 아는 공공 번호만 적는다. 남는자리 고객센터는 {{operator.*}} 자리표시자로만 가리킨다.
 */
import { REPORT_REASON_LABEL } from "@/lib/domain";
import { legalDocHref } from "../legal/types";
import { HELP_FACTS, HELP_SAFETY_PATH } from "./faq";

export interface SafetyRule {
  /** 화면 앵커로 쓰는 고정 ID(kebab-case) */
  id: string;
  /** 한 줄 수칙 */
  title: string;
  /** 왜, 어떻게 */
  body: string;
}

export const SAFETY_PAGE = {
  path: HELP_SAFETY_PATH,
  title: "오프라인 모임 안전 수칙",
  summary: "처음 만나는 사람들과의 자리예요. 즐겁게 다녀오도록 몇 가지만 미리 챙겨 주세요.",
  /** 남는자리가 안전을 위해 해 두는 일(사실만) */
  platformMeasures: [
    "입점 심사를 거친 사업자만 자리를 올릴 수 있어요. 호스트의 상호, 대표자, 사업자등록번호, 연락처는 자리 상세 화면에서 볼 수 있어요.",
    "심사에서는 사업자 정보를 확인해요. 모임의 내용과 현장 안전까지 남는자리가 보증하는 것은 아니에요.",
    "호스트는 영업장이나 공개된 상업 시설에서만 모임을 열어야 해요. 개인 주거지에서는 열 수 없어요.",
    "모임 장소의 정확한 주소는 예약이 확정된 분께만 보여 드려요. 호스트의 사업장 주소는 법에 따라 항상 공개돼요.",
    "참가자의 연락처는 다른 참가자에게 공개하지 않아요.",
    "누가 신고했는지는 신고 대상에게 알리지 않아요.",
  ],
} as const;

/** 참가자용 수칙 */
export const PARTICIPANT_SAFETY_RULES: readonly SafetyRule[] = [
  {
    id: "meet-at-confirmed-place",
    title: "안내된 장소에서만 만나요",
    body: "모임 장소의 정확한 주소는 예약이 확정되면 예약 상세 화면에 나와요. 그곳이 아닌 다른 장소로 따로 오라는 연락을 받았다면 가지 말고 남는자리에 알려 주세요.",
  },
  {
    id: "tell-someone",
    title: "가까운 사람에게 일정을 알려 둬요",
    body: "어떤 모임에, 어디로, 몇 시에 가는지 가족이나 친구에게 알려 주세요. 끝나는 시간과 돌아오는 방법도 함께 알려 두면 좋아요.",
  },
  {
    id: "check-host",
    title: "호스트 정보를 미리 확인해요",
    body: "자리 상세 화면에서 호스트의 상호, 대표자, 연락처와 후기를 볼 수 있어요. 안내받은 내용과 현장이 다르면 참여하지 않아도 돼요.",
  },
  {
    id: "pay-on-platform",
    title: "결제는 남는자리 안에서만 해요",
    body: "남는자리 밖에서 따로 돈을 보내 달라고 하거나, 예약 화면에 없던 금액을 현장에서 요구하면 응하지 말고 알려 주세요. 남는자리 밖에서 한 거래는 환불과 분쟁 해결을 도와 드리기 어려워요.",
  },
  {
    id: "keep-contact-private",
    title: "연락처는 내가 원할 때만 알려 줘요",
    body: "남는자리는 참가자의 연락처를 다른 참가자에게 알려 주지 않아요. 누가 연락처를 물어도 내키지 않으면 거절해도 괜찮아요.",
  },
  {
    id: "limit-personal-details",
    title: "자세한 개인 정보는 천천히 나눠요",
    body: "집 주소, 직장 위치, 금융 정보처럼 나를 찾아낼 수 있는 정보는 처음 만난 자리에서 말하지 않는 편이 안전해요.",
  },
  {
    id: "watch-drinks-and-belongings",
    title: "음료와 소지품은 직접 챙겨요",
    body: "자리를 비운 사이 놓아 둔 음료는 마시지 않는 편이 좋아요. 술이 있는 자리라면 평소 마시는 만큼만 마셔요.",
  },
  {
    id: "leave-when-uncomfortable",
    title: "불편하면 언제든 자리를 떠나도 돼요",
    body: "이유를 설명할 필요는 없어요. 진행하는 호스트에게 먼저 도움을 청하고, 그래도 불편하면 바로 나오세요.",
  },
  {
    id: "plan-way-home",
    title: "돌아가는 길을 미리 정해 둬요",
    body: "막차 시간이나 택시 타는 곳을 미리 확인해 두세요. 처음 만난 사람의 차에 타거나 사람이 없는 곳으로 함께 가는 일은 피해 주세요.",
  },
  {
    id: "report-problems",
    title: "불쾌한 일은 참지 말고 신고해요",
    body: "원하지 않는 연락, 촬영, 신체 접촉은 남는자리 약관이 금지하는 행동이에요. 예약 상세 화면에서 신고할 수 있고, 급한 상황이면 먼저 112에 신고하세요.",
  },
];

/** 호스트용 수칙 */
export const HOST_SAFETY_RULES: readonly SafetyRule[] = [
  {
    id: "host-public-venue",
    title: "영업장이나 공개된 상업 시설에서만 열어요",
    body: "개인 주거지에서는 모임을 열 수 없어요. 올린 주소와 실제 장소가 같아야 해요.",
  },
  {
    id: "host-run-as-listed",
    title: "올린 내용 그대로 진행해요",
    body: "시간, 장소, 인원, 진행 내용이 달라지면 참가자가 미리 알 수 있게 해 주세요. 열기 어려워졌다면 되도록 빨리 회차를 취소해 주세요. 결제한 금액은 전액 환불돼요.",
  },
  {
    id: "host-check-in",
    title: "체크인으로 참석자를 확인해요",
    body: "예약 패스의 QR이나 예약번호로 예약한 분인지 확인해 주세요. 예약하지 않은 사람이 함께 들어오지 않도록 살펴 주세요.",
  },
  {
    id: "host-protect-contacts",
    title: "참가자의 연락처를 지켜요",
    body: "참가자의 연락처를 본인 동의 없이 다른 참가자에게 알려 주면 안 돼요. 명단은 다른 사람이 볼 수 없는 곳에 두고, 예약 진행에만 써 주세요.",
  },
  {
    id: "host-make-it-easy-to-speak-up",
    title: "불편을 말하기 쉽게 해 줘요",
    body: "시작할 때 불편한 일이 생기면 누구에게 말하면 되는지 알려 주세요. 다른 참가자를 불편하게 하는 사람은 자리에서 분리하고, 필요하면 내보내 주세요.",
  },
  {
    id: "host-alcohol-care",
    title: "술이 있는 자리는 더 살펴요",
    body: "술을 억지로 권하지 않게 해 주세요. 많이 취한 참가자가 있으면 안전하게 돌아갈 수 있도록 도와주세요.",
  },
  {
    id: "host-emergency-ready",
    title: "비상 상황을 미리 준비해요",
    body: "비상구와 소화기 위치를 확인해 두세요. 다치거나 위험한 일이 생기면 먼저 119나 112에 신고하고, 그다음 남는자리에 알려 주세요.",
  },
  {
    id: "host-no-off-platform",
    title: "현장에서 추가 금액을 요구하지 않아요",
    body: "예약 화면에 나온 금액이 고객이 내는 돈의 전부예요. 남는자리 밖에서 따로 결제하도록 권하는 것도 약관이 금지해요.",
  },
];

export interface EmergencyContact {
  name: string;
  /** 전화번호(국번 없이 누르는 공공 번호) */
  number: string;
  /** 언제 연락하는지 */
  when: string;
}

/** 긴급 연락처 — 공공 번호만 */
export const EMERGENCY_CONTACTS: readonly EmergencyContact[] = [
  { name: "경찰", number: "112", when: "위협을 느끼거나 범죄 피해를 겪었을 때. 지금 위험하다면 가장 먼저 연락하세요." },
  { name: "소방·구급", number: "119", when: "다친 사람이 있거나 불이 났을 때" },
  { name: "여성긴급전화", number: "1366", when: "폭력 피해로 상담과 보호가 필요할 때" },
];

/** 급하지 않은 소비자 분쟁 상담 — 공공 번호만 */
export const CONSUMER_HELP_CONTACTS: readonly EmergencyContact[] = [
  { name: "1372 소비자상담센터", number: "1372", when: "환불이나 계약 문제를 남는자리와 풀지 못했을 때" },
];

export const EMERGENCY_GUIDE = {
  title: "급한 상황이라면",
  steps: [
    "지금 위험하다면 먼저 그 자리를 벗어나 사람이 많은 곳으로 가세요.",
    "112나 119에 신고하세요. 남는자리에 알리는 것은 그다음에 해도 괜찮아요.",
    "안전해진 뒤에 예약 상세 화면에서 신고해 주세요. 남는자리가 사실을 확인하고 필요한 조치를 해요.",
  ],
  /** 남는자리는 긴급 출동 기관이 아니라는 점을 분명히 한다 */
  note: "남는자리 고객센터는 긴급 출동을 할 수 없어요. 급한 위험은 반드시 112나 119로 먼저 알려 주세요.",
} as const;

/** 신고할 때 고를 수 있는 사유(고객 화면에 보이는 것) — 이름은 src/lib/domain.ts 의 라벨을 그대로 쓴다 */
export const REPORT_REASON_OPTIONS: readonly { key: keyof typeof REPORT_REASON_LABEL; label: string }[] = (
  ["SAFETY", "INAPPROPRIATE", "FALSE_INFO", "FAKE_VACANCY", "NO_SERVICE", "REFUND_DISPUTE", "OFF_PLATFORM", "OTHER"] as const
).map((key) => ({ key, label: REPORT_REASON_LABEL[key] }));

export const REPORT_GUIDE = {
  title: "신고하는 방법",
  steps: [
    "예약 상세 화면에서 '신고·분쟁 접수'를 눌러요. 예약하지 않은 상품이나 호스트, 후기도 신고할 수 있어요.",
    `사유를 고르고 무슨 일이 있었는지 적어요. 내용은 ${HELP_FACTS.reportDetailMin}자 이상 적어 주세요.`,
    "다른 참가자의 행동을 신고할 때는 함께 참여한 회차의 예약 상세 화면에서 접수하고, 누구였는지 알 수 있게 자리나 옷차림 같은 단서를 적어 주세요.",
    `접수한 날부터 ${HELP_FACTS.disputeProgressBusinessDays}영업일 안에 진행 상황을, ${HELP_FACTS.disputeResultBusinessDays}영업일 안에 처리 결과를 알려 드려요.`,
  ],
  notes: [
    "누가 신고했는지는 신고 대상에게 알리지 않아요.",
    "폭력이나 성범죄처럼 안전에 관한 중대한 신고는 사실을 확인하기 전에 먼저 상대의 이용을 멈출 수 있어요.",
    "예약과 관련된 신고는 그 예약의 당사자만 접수할 수 있어요.",
    `신고는 하루에 ${HELP_FACTS.reportDailyLimit}건까지 접수할 수 있어요.`,
    "남는자리 고객센터({{operator.email}}, {{operator.phone}})로도 알릴 수 있어요.",
  ],
  links: [
    { label: "분쟁 해결 절차 보기", href: legalDocHref("terms", "disputes") },
    { label: "하면 안 되는 일 보기", href: legalDocHref("terms", "prohibited") },
  ],
} as const;

/**
 * 모임이 끝난 뒤 보내는 확인 알림의 문안("불편한 일은 없었나요?").
 * 이 알림은 아직 만들어지지 않았다. 알림 기능을 만든 뒤에만 쓰고, 그 전에는 화면이나 도움말에 "보낸다"고 적지 않는다.
 */
export const POST_EVENT_CHECK = {
  title: "모임은 잘 다녀오셨나요?",
  body: "불편한 일은 없었나요? 불편하거나 위험한 일이 있었다면 예약 상세 화면에서 알려 주세요. 누가 알렸는지는 상대에게 알리지 않아요.",
} as const;

/** 예약 확정 화면과 확정 알림에 넣는 짧은 안내(세 줄) */
export const BOOKING_SAFETY_TIPS: readonly string[] = [
  "안내된 장소에서만 만나고, 가까운 사람에게 일정을 알려 두세요.",
  "결제와 환불은 남는자리 안에서만 해요. 따로 돈을 요구받으면 알려 주세요.",
  "불편한 일이 있으면 예약 상세 화면에서 신고해 주세요. 급하면 112예요.",
];
