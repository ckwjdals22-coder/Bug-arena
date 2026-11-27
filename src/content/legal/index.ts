/**
 * 약관·정책 문서 모음. 모두 초안이며(reviewRequired: true) 출시 전에 변호사 검토가 필요하다.
 * 문서 안의 {{operator.*}}, {{settings.*}} 자리표시자는 src/content/render.ts 의 resolveText / resolveDoc 로 바꿔서 보여 준다.
 */
import marketingConsent from "./marketing-consent";
import privacy from "./privacy";
import rankingPolicy from "./ranking-policy";
import refundPolicy from "./refund-policy";
import reviewPolicy from "./review-policy";
import sellerTerms from "./seller-terms";
import terms from "./terms";
import { LEGAL_SLUGS, legalDocHref, type LegalDoc, type LegalSlug } from "./types";

export * from "./types";
export { PROCESSORS } from "./privacy";

export const LEGAL_DOCS: Record<LegalSlug, LegalDoc> = {
  terms,
  privacy,
  "refund-policy": refundPolicy,
  "review-policy": reviewPolicy,
  "ranking-policy": rankingPolicy,
  "seller-terms": sellerTerms,
  "marketing-consent": marketingConsent,
};

/** 정해진 순서의 전체 문서 목록 */
export const LEGAL_DOC_LIST: readonly LegalDoc[] = LEGAL_SLUGS.map((slug) => LEGAL_DOCS[slug]);

export function isLegalSlug(slug: string): slug is LegalSlug {
  return (LEGAL_SLUGS as readonly string[]).includes(slug);
}

/** 주소의 slug 로 문서를 찾는다. 없으면 undefined */
export function getLegalDoc(slug: string): LegalDoc | undefined {
  return isLegalSlug(slug) ? LEGAL_DOCS[slug] : undefined;
}

export interface LegalFooterLink {
  slug: LegalSlug;
  /** 푸터에 보여 줄 짧은 이름 */
  label: string;
  href: string;
  /** 개인정보처리방침은 다른 링크보다 눈에 띄게(굵게) 표시한다 */
  emphasis?: boolean;
}

/** 푸터에 거는 문서. 광고성 정보 수신 동의 안내는 가입·알림 설정 화면에서 연결하므로 뺐다 */
export const LEGAL_FOOTER_LINKS: readonly LegalFooterLink[] = [
  { slug: "terms", label: "이용약관", href: legalDocHref("terms") },
  { slug: "privacy", label: "개인정보처리방침", href: legalDocHref("privacy"), emphasis: true },
  { slug: "refund-policy", label: "취소·환불 기준", href: legalDocHref("refund-policy") },
  { slug: "review-policy", label: "후기 운영정책", href: legalDocHref("review-policy") },
  { slug: "ranking-policy", label: "노출·정렬 기준", href: legalDocHref("ranking-policy") },
  { slug: "seller-terms", label: "판매자 이용약관", href: legalDocHref("seller-terms") },
];

/**
 * 통신판매중개자 고지. 푸터, 자리 상세, 결제 확인 화면에 그대로 쓴다.
 * 자리표시자가 들어 있으므로 resolveText 를 거쳐야 한다.
 */
export const INTERMEDIARY_NOTICE =
  "남는자리(운영: {{operator.companyName}})는 통신판매중개자이며 통신판매의 당사자가 아닙니다. 자리의 내용, 진행, 환불 등 거래에 관한 책임은 각 호스트(판매자)에게 있습니다.";

/** 푸터의 사업자 정보(법정 표시 사항). 값이 비어 있으면 입력 필요 표시가 그대로 보인다 */
export const OPERATOR_DISCLOSURE_ITEMS: readonly { label: string; value: string }[] = [
  { label: "상호", value: "{{operator.companyName}}" },
  { label: "대표자", value: "{{operator.representative}}" },
  { label: "사업자등록번호", value: "{{operator.businessRegNo}}" },
  { label: "통신판매업 신고번호", value: "{{operator.mailOrderRegNo}}" },
  { label: "주소", value: "{{operator.address}}" },
  { label: "고객센터 전화", value: "{{operator.phone}}" },
  { label: "고객센터 이메일", value: "{{operator.email}}" },
  { label: "개인정보 보호책임자", value: "{{operator.privacyOfficer}}" },
  { label: "호스팅 서비스 제공자", value: "{{operator.hostingProvider}}" },
];
