import "server-only";
import { OPERATOR_FIELD_LABELS, type OperatorField, type OperatorInfo } from "./render";

/**
 * 운영자(회사) 정보. 약관·개인정보처리방침·푸터의 법정 표시 사항에 들어간다.
 * 값은 환경 변수에서만 읽는다 — 코드나 문서에 회사 정보를 직접 적지 않는다.
 * 비어 있는 항목은 문서에 "[운영자 정보 입력 필요: …]" 로 그대로 드러난다.
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
