import "server-only";
import type { ProcessorEnabledKey, ProcessorRegionKey } from "./legal/types";
import {
  OPERATOR_FIELD_LABELS,
  PROCESSOR_REGION_LABELS,
  type OperatorField,
  type OperatorInfo,
  type ProcessorRegion,
  type ProcessorRegions,
} from "./render";

/**
 * 운영자(회사) 정보. 약관·개인정보처리방침·푸터의 법정 표시 사항에 들어간다.
 * 값은 환경 변수에서만 읽는다 — 코드나 문서에 회사 정보를 직접 적지 않는다.
 * 비어 있는 항목은 문서에 "[운영자 정보 입력 필요: …]" 로 그대로 드러난다.
 *
 * 함께 두는 것
 * - 지금 켜진 외부 연동의 키(getEnabledProcessorKeys) — 문서가 실제로 쓰는 곳만 보여 주는 데 쓴다.
 * - 개인정보를 처리하는 서버의 나라와 그 회사의 연락처(getProcessorRegions) — 처리방침의 국외 이전 표에 쓴다.
 */

export interface OperatorEnvKey {
  /** 환경 변수 이름 */
  key: string;
  /** OperatorInfo 의 항목 */
  field: OperatorField;
  /** 화면에 보여 줄 이름 */
  label: string;
  /** 무엇을 넣어야 하는지, 어디에 쓰이는지 */
  help: string;
}

export const OPERATOR_ENV_KEYS: readonly OperatorEnvKey[] = [
  {
    key: "OPERATOR_COMPANY_NAME",
    field: "companyName",
    label: OPERATOR_FIELD_LABELS.companyName,
    help: "사업자등록증에 적힌 상호(법인명)를 그대로 넣어요. 약관·처리방침과 푸터에 표시돼요.",
  },
  {
    key: "OPERATOR_REPRESENTATIVE",
    field: "representative",
    label: OPERATOR_FIELD_LABELS.representative,
    help: "대표자 이름이에요. 푸터의 사업자 정보에 표시돼요.",
  },
  {
    key: "OPERATOR_BUSINESS_REG_NO",
    field: "businessRegNo",
    label: OPERATOR_FIELD_LABELS.businessRegNo,
    help: "사업자등록번호 10자리예요(예: 123-45-67890 형식). 푸터에 표시돼요.",
  },
  {
    key: "OPERATOR_MAIL_ORDER_REG_NO",
    field: "mailOrderRegNo",
    label: OPERATOR_FIELD_LABELS.mailOrderRegNo,
    help: "통신판매업 신고를 마친 뒤 받은 신고번호예요. 신고 전에는 비워 두면 입력 필요 표시가 나와요.",
  },
  {
    key: "OPERATOR_ADDRESS",
    field: "address",
    label: OPERATOR_FIELD_LABELS.address,
    help: "사업자등록증의 사업장 소재지예요. 푸터와 약관에 표시돼요.",
  },
  {
    key: "OPERATOR_PHONE",
    field: "phone",
    label: OPERATOR_FIELD_LABELS.phone,
    help: "고객이 문의하고 분쟁을 접수할 수 있는 전화번호예요.",
  },
  {
    key: "OPERATOR_EMAIL",
    field: "email",
    label: OPERATOR_FIELD_LABELS.email,
    help: "고객 문의와 개인정보 관련 요청을 받는 이메일 주소예요.",
  },
  {
    key: "OPERATOR_PRIVACY_OFFICER",
    field: "privacyOfficer",
    label: OPERATOR_FIELD_LABELS.privacyOfficer,
    help: "개인정보 보호책임자의 이름과 직책이에요(예: 이름 · 직책 형식). 개인정보처리방침에 표시돼요.",
  },
  {
    key: "OPERATOR_HOSTING_PROVIDER",
    field: "hostingProvider",
    label: OPERATOR_FIELD_LABELS.hostingProvider,
    help: "서버·데이터베이스를 맡긴 클라우드 회사 이름이에요. 푸터와 처리방침의 처리 위탁 표에 표시돼요.",
  },
];

/** 환경 변수에서 운영자 정보를 읽는다. 없는 값은 빈 문자열 */
export function getOperatorInfo(): OperatorInfo {
  const info = {} as OperatorInfo;
  for (const item of OPERATOR_ENV_KEYS) {
    info[item.field] = (process.env[item.key] ?? "").trim();
  }
  return info;
}

/** 법정 표시 사항이 모두 채워졌는지. missing 은 비어 있는 항목의 한국어 이름 */
export function isOperatorInfoComplete(): { complete: boolean; missing: string[] } {
  const info = getOperatorInfo();
  const missing = OPERATOR_ENV_KEYS.filter((item) => info[item.field] === "").map((item) => item.label);
  return { complete: missing.length === 0, missing };
}

/**
 * 지금 실제로 켜져 있는 외부 연동의 키. 처리방침의 표(processorsForBlock)와
 * "연동 전" 안내(문서의 visibleBlocks, 도움말의 visiblePendingNotes)가 이 값으로 보여 줄 내용을 고른다.
 * 환경 변수만 보고 판단한다(src/lib/env.ts 의 연동 설정과 같은 이름).
 * - payment:toss  토스페이먼츠 실결제 키일 때만(테스트 키는 실제 청구가 없으므로 켜진 것으로 보지 않는다)
 * - sms:solapi    문자 발송을 켰고 API 키·비밀값·발신번호가 모두 있을 때(하나라도 빠지면 한 통도 나가지 않는다)
 * - email:resend  이메일 발송 키가 있을 때
 * - storage:s3    이미지를 외부 저장소에 둘 때
 * - kakaoLogin    카카오 로그인 키가 있을 때
 * - identity      본인확인 연동은 아직 설정 항목이 없어 항상 꺼져 있다. 연동을 붙일 때 여기에 조건을 더한다
 */
export function getEnabledProcessorKeys(): ProcessorEnabledKey[] {
  const value = (key: string) => (process.env[key] ?? "").trim();
  const keys: ProcessorEnabledKey[] = ["always"];
  const tossClientKey = value("TOSS_CLIENT_KEY");
  if (value("PAYMENT_PROVIDER") === "toss" && tossClientKey !== "" && !tossClientKey.startsWith("test_")) keys.push("payment:toss");
  const solapiReady = value("SOLAPI_API_KEY") !== "" && value("SOLAPI_API_SECRET") !== "" && value("SOLAPI_SENDER").replace(/\D/g, "") !== "";
  if (value("SMS_PROVIDER") === "solapi" && solapiReady) keys.push("sms:solapi");
  if (value("RESEND_API_KEY") !== "") keys.push("email:resend");
  if (value("STORAGE_DRIVER") === "s3") keys.push("storage:s3");
  if (value("KAKAO_CLIENT_ID") !== "") keys.push("kakaoLogin");
  return keys;
}

// ── 처리 국가 ─────────────────────────────────────────

export interface ProcessorRegionEnvKey {
  /** 환경 변수 이름 */
  key: string;
  region: ProcessorRegionKey;
  field: keyof ProcessorRegion;
  /** 화면에 보여 줄 이름 */
  label: string;
  /** 무엇을 넣어야 하는지 */
  help: string;
}

const regionEnvKeys = (region: ProcessorRegionKey, prefix: string, what: string): ProcessorRegionEnvKey[] => [
  {
    key: `${prefix}_COUNTRY`,
    region,
    field: "country",
    label: `${PROCESSOR_REGION_LABELS[region]} 처리 국가`,
    help: `${what}의 서버(리전)가 있는 나라예요. 국내면 '대한민국'이라고 넣어요. 비워 두면 처리방침의 표에 입력 필요 표시가 나와요.`,
  },
  {
    key: `${prefix}_CONTACT`,
    region,
    field: "contact",
    label: `${PROCESSOR_REGION_LABELS[region]} 연락처`,
    help: `${what}를 맡긴 회사의 개인정보 문의 연락처예요. 국외에서 처리할 때 처리방침의 국외 이전 표에 표시돼요.`,
  },
];

/**
 * 개인정보를 처리하는 서버의 나라와 그 회사의 연락처. 계약과 설정(리전)에 따라 달라지므로 코드에 적지 않고 환경 변수로 받는다.
 * 처리 국가를 비워 두면 국내 처리로 단정하지 않고 "[운영자 정보 입력 필요: 호스팅 처리 국가]" 처럼 표에 드러낸다.
 */
export const PROCESSOR_REGION_ENV_KEYS: readonly ProcessorRegionEnvKey[] = [
  ...regionEnvKeys("hosting", "OPERATOR_HOSTING", "서버와 데이터베이스"),
  ...regionEnvKeys("storage", "OPERATOR_STORAGE", "이미지 저장소"),
  ...regionEnvKeys("email", "OPERATOR_EMAIL_SENDER", "이메일 발송 서비스"),
];

/** 환경 변수에서 처리 국가와 연락처를 읽는다. 없는 값은 빈 문자열 */
export function getProcessorRegions(): ProcessorRegions {
  const regions: ProcessorRegions = {
    hosting: { country: "", contact: "" },
    storage: { country: "", contact: "" },
    email: { country: "", contact: "" },
  };
  for (const item of PROCESSOR_REGION_ENV_KEYS) {
    regions[item.region][item.field] = (process.env[item.key] ?? "").trim();
  }
  return regions;
}
