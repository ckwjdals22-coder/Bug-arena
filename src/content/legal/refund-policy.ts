import { CANCELLATION_PRESETS, computeRefundRate, describeCancellationTiers, type CancellationPresetKey } from "@/lib/domain";
import { formatKRW } from "@/lib/money";
import { POLICY_VERSIONS } from "@/lib/policy";
import type { LegalDoc } from "./types";

const HOUR_MS = 3_600_000;
const PRESET_ORDER: readonly CancellationPresetKey[] = ["FLEXIBLE", "STANDARD", "STRICT"];

/**
 * 환불 기준 3종의 표. 숫자를 따로 적지 않고 CANCELLATION_PRESETS 에서 만든다
 * (판매자 화면·환불 계산과 같은 값을 쓰기 위해).
 */
export const REFUND_PRESET_ROWS: string[][] = PRESET_ORDER.flatMap((key) => {
  const preset = CANCELLATION_PRESETS[key];
  return describeCancellationTiers([...preset.tiers]).map(({ when, refund }) => [preset.label, when, refund]);
});

/** 재판매 연동 환불 예시의 가정. 금액 계산은 엔진과 같은 식(computeRefundRate, 원 단위 미만 버림)을 쓴다 */
export const RESALE_EXAMPLE = {
  preset: "STANDARD",
  /** 남는자리에서 온라인으로 결제한 금액(1명) */
  paidAmount: 40_000,
  /** 판매자가 정한 재판매 연동 환불율(%) */
  resaleRefundRate: 80,
  /** 취소 시점(회차 시작 몇 시간 전) */
  cancelHoursBefore: [48, 12],
} as const satisfies { preset: CancellationPresetKey; paidAmount: number; resaleRefundRate: number; cancelHoursBefore: readonly number[] };

export interface ResaleExampleCase {
  hoursBefore: number;
  /** 취소 시점의 기본 환불율(%) */
  baseRate: number;
  baseRefund: number;
  /** 자리가 모두 다시 팔렸을 때의 추가 환불액 */
  extraRefund: number;
  totalRefund: number;
}

export const RESALE_EXAMPLE_CASES: ResaleExampleCase[] = RESALE_EXAMPLE.cancelHoursBefore.map((hoursBefore) => {
  const startAt = new Date(Date.UTC(2030, 0, 10, 10, 0, 0));
  const baseRate = computeRefundRate({
    tiers: [...CANCELLATION_PRESETS[RESALE_EXAMPLE.preset].tiers],
    startAt,
    bookedAt: new Date(startAt.getTime() - 30 * 24 * HOUR_MS),
    now: new Date(startAt.getTime() - hoursBefore * HOUR_MS),
  });
  const baseRefund = Math.floor((RESALE_EXAMPLE.paidAmount * baseRate) / 100);
  const extraRefund = Math.floor((RESALE_EXAMPLE.paidAmount * Math.max(0, RESALE_EXAMPLE.resaleRefundRate - baseRate)) / 100);
  return { hoursBefore, baseRate, baseRefund, extraRefund, totalRefund: baseRefund + extraRefund };
});

const examplePresetLabel = CANCELLATION_PRESETS[RESALE_EXAMPLE.preset].label;

const exampleRows: string[][] = RESALE_EXAMPLE_CASES.map((c) => [
  `시작 ${c.hoursBefore}시간 전에 취소`,
  `${c.baseRate}% · ${formatKRW(c.baseRefund)}`,
  formatKRW(c.extraRefund),
  formatKRW(c.totalRefund),
]);

/**
 * 취소·환불 기준(초안). 예약 화면의 "취소·환불 기준 확인" 동의가 가리키는 문서다.
 * 엔진 규칙은 docs/02-architecture.md 6.4 와 src/lib/domain.ts 의 computeRefundRate 를 따른다.
 */
const refundPolicy: LegalDoc = {
  slug: "refund-policy",
  title: "취소·환불 기준",
  summary: "예약을 취소하면 언제, 얼마를 돌려받는지 설명합니다.",
  version: POLICY_VERSIONS.REFUND_POLICY,
  effectiveDate: POLICY_VERSIONS.REFUND_POLICY,
  audience: "all",
  keyPoints: [
    "취소하면 얼마를 돌려받는지 예약 화면과 취소 화면에서 미리 보여 줍니다.",
    "환불율은 회차 시작 시각까지 남은 시간으로 정해지고, 예약 당시의 기준을 그대로 적용합니다.",
    "예약한 뒤 {{settings.cancelGraceMinutes|min}} 안에 취소하면 전액 환불합니다. 시작이 임박한 예약은 예외입니다.",
    "판매자나 회사 사정으로 취소되거나 최소 인원이 모이지 않으면 언제나 전액 환불합니다.",
    "재판매 연동 환불이 켜진 상품은 늦게 취소했더라도 그 자리가 다시 팔리면 더 돌려받습니다.",
  ],
  sections: [
    {
      id: "basics",
      heading: "기본 원칙",
      blocks: [
        {
          type: "ul",
          items: [
            "회차가 시작하기 전까지 예약 상세 화면에서 직접 취소할 수 있습니다. 취소하기 전에 지금 취소하면 돌려받는 금액을 먼저 보여 줍니다.",
            "환불 기준은 판매자(화면에서는 '호스트')가 상품마다 정합니다. 결제하기 전에 예약 화면에서 확인하고 동의합니다.",
            "예약할 때의 기준이 예약에 기록됩니다. 판매자가 나중에 기준을 바꿔도 이미 한 예약에는 예약 당시의 기준을 적용합니다.",
            "환불율은 언제나 회차 시작 시각까지 남은 시간으로 계산합니다. 예약 마감 시각이나 신청한 날짜가 기준이 아닙니다.",
            "환불 금액은 남는자리에서 온라인으로 결제한 금액에 환불율을 곱해 계산합니다.",
            "회차가 시작한 뒤에는 취소해도 환불하지 않습니다.",
          ],
        },
        {
          type: "note",
          tone: "info",
          text: "이 문서의 시간과 비율은 현재 기준입니다. 관련 법령이 회원에게 더 유리한 권리를 정한 경우에는 그 법령을 따릅니다.",
        },
      ],
    },
    {
      id: "presets",
      heading: "환불 기준 세 가지",
      blocks: [
        { type: "p", text: "판매자는 아래 세 가지 기준 가운데 하나를 골라 상품에 적용합니다. 어떤 기준인지는 상품 상세와 예약 화면에 표시합니다." },
        { type: "table", head: ["기준", "취소하는 때", "환불"], rows: REFUND_PRESET_ROWS },
        {
          type: "ul",
          items: [
            "표의 '시작 ○시간(○일) 전까지'는 회차 시작 시각에서 정확히 그 시간만큼 앞선 때까지를 포함합니다.",
            "판매자가 상품에 맞게 구간을 따로 정한 경우에는 예약 화면에 표시된 기준이 적용됩니다.",
          ],
        },
      ],
    },
    {
      id: "grace",
      heading: "예약 직후 무료 취소",
      blocks: [
        {
          type: "ul",
          items: [
            "실수로 한 예약을 보호하기 위해, 예약한 때부터 {{settings.cancelGraceMinutes|min}}(현재 기준) 안에 취소하면 환불 기준과 관계없이 전액 환불합니다.",
            "다만 예약할 때 회차 시작까지 {{settings.cancelGraceMinLeadMinutes|min}}보다 적게 남았던 임박 예약에는 무료 취소 시간을 적용하지 않습니다. 임박한 자리는 취소되면 다시 채우기 어렵기 때문입니다.",
            "무료 취소 시간이 적용되는지는 결제하기 전에 예약 화면에 표시합니다.",
            "무료 취소 시간 안이라도 회차가 이미 시작했다면 환불하지 않습니다.",
          ],
        },
      ],
    },
    {
      id: "full-refund-cases",
      heading: "언제나 전액 환불하는 경우",
      blocks: [
        {
          type: "ul",
          items: [
            "판매자 사정으로 예약이나 회차가 취소된 경우",
            "회사(운영자)가 예약이나 회차를 취소한 경우",
            "판매자 승인이 필요한 자리에서 판매자가 승인하지 않은 경우",
            "최소 인원이 정해진 회차가 판정 시각까지 인원을 채우지 못해 자동으로 취소된 경우",
          ],
        },
        { type: "p", text: "이 경우에는 취소 시점과 관계없이 결제한 금액 전부를 돌려드리며, 회원이 따로 신청하지 않아도 자동으로 환불합니다." },
      ],
    },
    {
      id: "resale-refund",
      heading: "재판매 연동 환불",
      blocks: [
        {
          type: "p",
          text: "환불이 적거나 없는 시점에 취소했더라도, 취소한 자리가 회차 시작 전에 다시 팔리면 판매자가 정한 비율까지 추가로 환불하는 제도입니다. 판매자가 이 제도를 켠 상품에만 적용하며, 상품 상세와 예약 화면에 '다시 팔리면 최대 몇 %까지 환불'인지 표시합니다.",
        },
        {
          type: "ul",
          items: [
            "예약할 때의 설정이 예약에 기록됩니다. 남는자리에서 온라인으로 결제한 금액에만 적용합니다.",
            "같은 회차의 같은 좌석 유형에서 새 예약이 확정되어야 다시 팔린 것으로 봅니다. 판매자가 직접 입력한 예약은 세지 않습니다.",
            "같은 좌석 유형에 다른 빈자리가 남아 있으면 그 자리가 먼저 팔린 것으로 봅니다. 빈자리가 모두 팔린 뒤의 예약부터 취소한 자리가 다시 팔린 것으로 셉니다.",
            "판매자가 아직 다시 열지 않은 자리는 팔린 것으로 보지 않습니다.",
            "취소한 회원이 여럿이면 먼저 취소한 예약부터 차례로 추가 환불합니다.",
            "여러 명을 예약했다가 취소했는데 일부 인원의 자리만 다시 팔리면 그 인원만큼만 추가 환불합니다.",
            "추가 환불액은 '온라인 결제 금액 × (재판매 연동 환불율 − 취소할 때의 환불율) × 다시 팔린 인원 ÷ 예약 인원'이며 원 단위 미만은 버립니다.",
            "추가 환불은 자동으로, 결제한 수단으로 돌려드립니다. 추가 환불을 받은 뒤 새 예약이 취소되더라도 돌려받은 금액을 다시 가져가지 않습니다.",
            "회차가 시작할 때까지 다시 팔리지 않으면 추가 환불은 없습니다.",
          ],
        },
        {
          type: "p",
          text: `예시: '${examplePresetLabel}' 기준의 자리를 1명 ${formatKRW(RESALE_EXAMPLE.paidAmount)}에 결제했고, 판매자가 재판매 연동 환불율을 ${RESALE_EXAMPLE.resaleRefundRate}%로 정한 경우입니다.`,
        },
        { type: "table", head: ["취소하는 때", "바로 환불", "자리가 다시 팔리면 추가 환불", "합계"], rows: exampleRows },
        { type: "p", text: "자리가 다시 팔리지 않으면 '바로 환불' 금액만 돌려받습니다." },
      ],
    },
    {
      id: "refund-timing",
      heading: "환불 방법과 걸리는 시간",
      blocks: [
        {
          type: "ul",
          items: [
            "환불은 결제한 수단으로 돌려드립니다. 취소가 처리되면 회사가 결제 대행사에 바로 환불을 요청합니다.",
            "실제로 카드 대금이나 계좌에 반영되는 때는 카드사와 결제 수단에 따라 다릅니다. 보통 영업일 기준 3~7일 정도 걸릴 수 있습니다.",
            "환불이 끝나면 알림으로 알려 드립니다.",
            "환불 요청이 결제 대행사에서 실패하면 회사가 다시 처리합니다. 오래 걸린다고 느껴지면 고객센터({{operator.email}}, {{operator.phone}})로 알려 주십시오.",
            "예약금만 결제한 예약은 결제한 예약금을 기준으로 환불합니다. 현장에서 판매자에게 직접 낸 금액의 환불은 판매자에게 요청해야 하며, 해결되지 않으면 회사에 분쟁을 접수할 수 있습니다.",
          ],
        },
      ],
    },
    {
      id: "no-show",
      heading: "노쇼",
      blocks: [
        {
          type: "ul",
          items: [
            "예약을 취소하지 않고 참석하지 않으면 판매자가 노쇼로 처리할 수 있고, 이 경우 환불하지 않습니다.",
            "노쇼 처리가 잘못됐다면 노쇼로 처리된 때부터 72시간 안에 예약 상세 화면에서 이의를 제기할 수 있습니다.",
            "최근 {{settings.noShowWindowDays|days}} 동안 노쇼가 {{settings.noShowLimit}}회에 이르면 {{settings.noShowRestrictDays|days}} 동안 새 예약이 제한됩니다(현재 기준).",
          ],
        },
      ],
    },
    {
      id: "disputes",
      heading: "환불에 동의하지 않을 때",
      blocks: [
        {
          type: "ol",
          items: [
            "예약 상세 화면의 신고·분쟁 접수 또는 고객센터({{operator.email}}, {{operator.phone}})로 알립니다.",
            "회사는 접수한 날부터 3영업일 안에 진행 상황을 알립니다.",
            "접수한 날부터 10영업일 안에 조사 결과 또는 처리 방안을 알립니다.",
          ],
        },
        {
          type: "p",
          text: "회사의 처리 결과에 동의하지 않으면 한국소비자원(1372 소비자상담센터)이나 전자거래분쟁조정위원회에 조정을 신청할 수 있습니다.",
        },
      ],
    },
  ],
  reviewRequired: true,
  reviewNotes: [
    "날짜와 시간이 정해진 예약 상품의 청약철회(7일) 제한과 구간별 환불율의 유효성. 소개팅·모임·클래스에 적용할 공식 위약금 기준(확인된 수치는 음식점 대상의 권고 기준)",
    "'엄격' 기준처럼 환불이 없는 구간이 긴 기준이 과도한 위약금에 해당하지 않는지, 업종별 상한이 필요한지",
    "예약 직후 무료 취소의 임박 예외를 예약 화면에 어떻게 표시해야 충분한 사전 고지가 되는지",
    "재판매 연동 환불의 적법성(직접 선례를 찾지 못한 자체 제도)과 고지 문구",
    "환불 처리 기간 안내 문구(영업일 기준 3~7일)의 적정성과 환불이 늦어질 때의 지연배상 조항 필요 여부",
    "예약금·현장 결제분의 환불 책임 주체와 안내 방식",
    "취소·환불 기준의 사전 고지와 동의 기록(동의 시각, 문서 버전)이 분쟁 때 증빙 요건을 충족하는지",
    "시행일(effectiveDate)을 실제 출시일에 맞춰 수정",
  ],
};

export default refundPolicy;
