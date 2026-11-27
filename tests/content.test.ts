import { afterEach, describe, expect, it, vi } from "vitest";
import { GUIDES } from "@/content/help/guides";
import {
  FAQ_GROUPS,
  HELP_BASE_PATH,
  HELP_FACTS,
  HELP_SAFETY_PATH,
  faqGroupsFor,
  getFaqItem,
  splitParagraphs,
  visiblePendingNotes,
  type FaqItem,
} from "@/content/help/faq";
import {
  BOOKING_SAFETY_TIPS,
  CONSUMER_HELP_CONTACTS,
  EMERGENCY_CONTACTS,
  EMERGENCY_GUIDE,
  HOST_SAFETY_RULES,
  PARTICIPANT_SAFETY_RULES,
  REPORT_GUIDE,
  REPORT_REASON_OPTIONS,
  SAFETY_PAGE,
} from "@/content/help/safety";
import {
  INTERMEDIARY_NOTICE,
  LEGAL_BASE_PATH,
  LEGAL_DOCS,
  LEGAL_DOC_LIST,
  LEGAL_FOOTER_LINKS,
  LEGAL_SLUGS,
  OPERATOR_DISCLOSURE_ITEMS,
  PROCESSORS,
  PROCESSOR_ENABLED_KEYS,
  getLegalDoc,
  isLegalSlug,
  legalDocHref,
  type LegalBlock,
  type LegalDoc,
  type ProcessorEnabledKey,
} from "@/content/legal";
import { REFUND_PRESET_ROWS, RESALE_EXAMPLE, RESALE_EXAMPLE_CASES } from "@/content/legal/refund-policy";
import { REVIEW_MIN_COUNT_FOR_RATING } from "@/content/legal/review-policy";
import { PLAN_LIMITS } from "@/content/legal/seller-terms";
import { OPERATOR_ENV_KEYS, getEnabledProcessorKeys, getOperatorInfo, isOperatorInfoComplete } from "@/content/operator";
import {
  ContentPlaceholderError,
  EMPTY_OPERATOR_INFO,
  FORMATTERS,
  OPERATOR_FIELDS,
  OPERATOR_FIELD_LABELS,
  collectPlaceholders,
  formatSettingValue,
  missingOperatorMarker,
  overseasProcessors,
  processorsForBlock,
  resolveDeep,
  resolveDoc,
  resolveText,
  visibleProcessors,
  type OperatorInfo,
  type RenderContext,
} from "@/content/render";
import { REF_COOKIE_MAX_AGE } from "@/lib/cookies";
import { CANCELLATION_PRESETS, REPORT_REASON_LABEL, type CancellationPresetKey } from "@/lib/domain";
import { formatKRW } from "@/lib/money";
import { BANNED_PHRASES, MIN_SIGNUP_AGE, POLICY_VERSIONS, findBannedPhrases } from "@/lib/policy";
import { isNightKst } from "@/lib/time";
import { MAX_ALERT_RULES, VACANCY_DAILY_LIMIT } from "@/server/services/alerts";
import { MAX_OWNED_BUSINESSES } from "@/server/services/business";
import { NO_SHOW_DISPUTE_HOURS, REPORT_DAILY_LIMIT, REPORT_DETAIL_MIN } from "@/server/services/reports";
import { REVIEW_NEW_THRESHOLD } from "@/server/services/reviews";
import { DEFAULT_SETTINGS, PLAN_FEATURES, settingsSchema } from "@/server/settings";

/**
 * 콘텐츠(약관·정책·도움말) 검증. DB 행을 쓰지 않는다.
 * - 자리표시자가 모두 실제 설정 키·운영자 항목을 가리키는지
 * - 문서의 숫자가 엔진 상수와 같은지(환불 기준, 플랜 한도, 후기·신고·알림 한도)
 * - 문서 형식(고정 앵커, 핵심 요약, 검토 필요 표시)과 말투, 금칙 표현
 */

const SETTING_KEYS = Object.keys(settingsSchema.shape);
const FILLED_OPERATOR: OperatorInfo = {
  companyName: "테스트상호",
  representative: "테스트대표",
  businessRegNo: "000-00-00000",
  mailOrderRegNo: "제0000-테스트-0000호",
  address: "테스트 주소",
  phone: "0000-0000",
  email: "help@example.com",
  privacyOfficer: "테스트책임자",
  hostingProvider: "테스트호스팅",
};
const ctx = (operator: OperatorInfo = EMPTY_OPERATOR_INFO, settings: Record<string, number> = DEFAULT_SETTINGS): RenderContext => ({
  operator,
  settings,
});

/** 값 안의 모든 문자열을 모은다 */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) allStrings(item, out);
  return out;
}

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const HELP_CONTENT = {
  FAQ_GROUPS,
  SAFETY_PAGE,
  PARTICIPANT_SAFETY_RULES,
  HOST_SAFETY_RULES,
  EMERGENCY_CONTACTS,
  CONSUMER_HELP_CONTACTS,
  EMERGENCY_GUIDE,
  REPORT_GUIDE,
  REPORT_REASON_OPTIONS,
  BOOKING_SAFETY_TIPS,
  GUIDES,
};

/** 자리표시자가 들어갈 수 있는 모든 콘텐츠 */
const ALL_CONTENT: Record<string, unknown> = {
  ...Object.fromEntries(LEGAL_DOC_LIST.map((doc) => [`legal:${doc.slug}`, doc])),
  PROCESSORS,
  INTERMEDIARY_NOTICE,
  OPERATOR_DISCLOSURE_ITEMS,
  LEGAL_FOOTER_LINKS,
  ...HELP_CONTENT,
};

const allFaqItems = (): FaqItem[] => FAQ_GROUPS.flatMap((group) => group.items);

/** 같은 사이트 경로가 실제 문서·앵커를 가리키는지 확인한다(약관 경로만 깊이 검사) */
function expectValidHref(href: string): void {
  expect(href.startsWith("/"), href).toBe(true);
  expect(href.startsWith("//"), href).toBe(false);
  expect(href).not.toMatch(/\s/);
  if (href.startsWith(`${HELP_BASE_PATH}#`)) {
    expect(getFaqItem(href.slice(HELP_BASE_PATH.length + 1)), `없는 질문을 가리키는 링크: ${href}`).toBeDefined();
    return;
  }
  if (!href.startsWith(`${LEGAL_BASE_PATH}/`)) return;
  const [slug = "", anchor] = href.slice(LEGAL_BASE_PATH.length + 1).split("#");
  const doc = getLegalDoc(slug);
  expect(doc, `없는 문서를 가리키는 링크: ${href}`).toBeDefined();
  if (anchor !== undefined) {
    expect(
      doc?.sections.some((section) => section.id === anchor),
      `없는 섹션을 가리키는 링크: ${href}`,
    ).toBe(true);
  }
}

function allLinks(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) allLinks(item, out);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "href" && typeof item === "string") out.push(item);
      else allLinks(item, out);
    }
  }
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── 자리표시자 ────────────────────────────────────────

describe("자리표시자", () => {
  it("모든 콘텐츠의 자리표시자가 실제 설정 키·운영자 항목·표시 형식을 가리킨다", () => {
    for (const [name, content] of Object.entries(ALL_CONTENT)) {
      for (const p of collectPlaceholders(content)) {
        const where = `${name} 의 ${p.raw}`;
        expect(p.scope, where).not.toBe("unknown");
        if (p.scope === "settings") {
          expect(SETTING_KEYS, where).toContain(p.key);
          if (p.formatter !== undefined) expect(FORMATTERS as readonly string[], where).toContain(p.formatter);
        } else {
          expect(OPERATOR_FIELDS as readonly string[], where).toContain(p.key);
          expect(p.formatter, where).toBeUndefined();
        }
      }
    }
  });

  it("설정값마다 단위에 맞는 표시 형식을 쓴다(요율은 percent, 분은 min, 금액은 krw …)", () => {
    const expectedFormatter = (key: string): string => {
      if (key.endsWith("Bps")) return "percent";
      if (key.endsWith("Minutes")) return "min";
      if (key.endsWith("Days")) return "days";
      if (key.endsWith("Hours")) return "hours";
      if (key === "commissionCapPerSeat" || key === "proPriceMonthly") return "krw";
      return "none";
    };
    for (const [name, content] of Object.entries(ALL_CONTENT)) {
      for (const p of collectPlaceholders(content)) {
        if (p.scope !== "settings") continue;
        expect(p.formatter ?? "none", `${name} 의 ${p.raw}`).toBe(expectedFormatter(p.key));
      }
    }
  });

  it("기본 설정으로 모든 콘텐츠를 그릴 수 있고 자리표시자가 남지 않는다", () => {
    for (const [name, content] of Object.entries(ALL_CONTENT)) {
      const rendered = resolveDeep(content, ctx());
      for (const text of allStrings(rendered)) {
        expect(text, name).not.toContain("{{");
        expect(text, name).not.toContain("}}");
        expect(text, name).not.toContain("[내용 확인 필요]");
        expect(text, name).not.toMatch(/undefined|NaN/);
      }
    }
  });

  it("요율·금액·시간은 문서에 직접 적지 않고 설정에서 그린다", () => {
    // 기본 설정값이 글자 그대로 박혀 있으면 운영자가 값을 바꿔도 문서가 따라가지 않는다.
    const literals = ["9.9%", "6.9%", "4.9%", "3.74%", "10,000원", "19,900원"];
    for (const [name, content] of Object.entries(ALL_CONTENT)) {
      for (const text of allStrings(content)) {
        for (const literal of literals) expect(text, `${name}: ${literal}`).not.toContain(literal);
      }
    }

    const sellerTerms = allStrings(resolveDoc(LEGAL_DOCS["seller-terms"], ctx())).join("\n");
    for (const literal of literals) expect(sellerTerms).toContain(literal);

    const changed = { ...DEFAULT_SETTINGS, holdMinutes: 15, cancelGraceMinutes: 45, commissionNewCustomerBps: 1250 };
    const terms = allStrings(resolveDoc(LEGAL_DOCS.terms, ctx(EMPTY_OPERATOR_INFO, changed))).join("\n");
    expect(terms).toContain("결제를 시작하면 15분");
    expect(terms).toContain("예약한 때부터 45분");
    const sellerChanged = allStrings(resolveDoc(LEGAL_DOCS["seller-terms"], ctx(EMPTY_OPERATOR_INFO, changed))).join("\n");
    expect(sellerChanged).toContain("12.5%");
    expect(sellerChanged).not.toContain("9.9%");
  });
});

// ── resolveText ───────────────────────────────────────

describe("resolveText", () => {
  it("표시 형식: percent · krw · min · hours · days · none", () => {
    expect(formatSettingValue(990, "percent")).toBe("9.9%");
    expect(formatSettingValue(374, "percent")).toBe("3.74%");
    expect(formatSettingValue(0, "percent")).toBe("0%");
    expect(formatSettingValue(1000, "percent")).toBe("10%");
    expect(formatSettingValue(10_000, "krw")).toBe("10,000원");
    expect(formatSettingValue(30, "min")).toBe("30분");
    expect(formatSettingValue(180, "min")).toBe("3시간");
    expect(formatSettingValue(90, "min")).toBe("1시간 30분");
    expect(formatSettingValue(12, "hours")).toBe("12시간");
    expect(formatSettingValue(14, "days")).toBe("14일");
    expect(formatSettingValue(2000, "none")).toBe("2,000");
    expect(formatSettingValue(2000)).toBe("2,000");

    const text = resolveText(
      "수수료 {{settings.commissionNewCustomerBps|percent}}, 상한 {{settings.commissionCapPerSeat|krw}}, 홀드 {{settings.holdMinutes|min}}, 자동 완료 {{settings.autoCompleteAfterHours|hours}}, 후기 {{settings.reviewWindowDays|days}}, 노쇼 {{settings.noShowLimit}}회, 문자 {{settings.proMonthlyMessages|none}}건",
      ctx(),
    );
    expect(text).toBe("수수료 9.9%, 상한 10,000원, 홀드 10분, 자동 완료 12시간, 후기 14일, 노쇼 2회, 문자 2,000건");
  });

  it("운영자 정보가 있으면 그 값으로, 비어 있으면 눈에 보이는 표시로 바꾼다", () => {
    expect(resolveText("운영: {{operator.companyName}}", ctx(FILLED_OPERATOR))).toBe("운영: 테스트상호");
    expect(resolveText("운영: {{operator.companyName}}", ctx())).toBe("운영: [운영자 정보 입력 필요: 상호]");
    expect(resolveText("{{operator.phone}}", ctx({ ...FILLED_OPERATOR, phone: "   " }))).toBe("[운영자 정보 입력 필요: 고객센터 전화번호]");
    for (const field of OPERATOR_FIELDS) {
      expect(missingOperatorMarker(field)).toBe(`[운영자 정보 입력 필요: ${OPERATOR_FIELD_LABELS[field]}]`);
      expect(resolveText(`{{operator.${field}}}`, ctx())).toBe(missingOperatorMarker(field));
    }
  });

  it("모르는 자리표시자는 개발·테스트에서 예외를 던진다(오타 방지)", () => {
    const bad = [
      "{{settings.holdMinute|min}}", // 없는 설정 키
      "{{settings.holdMinutes|minutes}}", // 없는 표시 형식
      "{{operator.ceo}}", // 없는 운영자 항목
      "{{operator.companyName|krw}}", // 운영자 정보에는 표시 형식을 붙일 수 없다
      "{{setting.holdMinutes}}", // 형식 오류
      "{{holdMinutes}}",
      "{{}}",
    ];
    for (const text of bad) {
      expect(() => resolveText(text, ctx()), text).toThrow(ContentPlaceholderError);
      const [found] = collectPlaceholders(text);
      expect(found?.raw).toBe(text);
    }
    // 숫자가 아닌 설정값
    expect(() => resolveText("{{settings.holdMinutes|min}}", { operator: EMPTY_OPERATOR_INFO, settings: { holdMinutes: Number.NaN } })).toThrow(
      ContentPlaceholderError,
    );
    // 객체의 기본 속성 이름은 설정 키가 아니다
    expect(() => resolveText("{{settings.constructor}}", ctx())).toThrow(ContentPlaceholderError);
    expect(() => resolveText("{{settings.toString}}", ctx())).toThrow(ContentPlaceholderError);
  });

  it("운영 환경에서는 예외 대신 눈에 띄는 표시로 바꾸고 로그를 남긴다", () => {
    vi.stubEnv("NODE_ENV", "production");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(resolveText("가격 {{settings.nope|krw}}", ctx())).toBe("가격 [내용 확인 필요]");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("자리표시자가 없는 글과 중괄호 하나짜리 글은 그대로 둔다", () => {
    expect(resolveText("그대로 둡니다 {설정} #{고객명}", ctx())).toBe("그대로 둡니다 {설정} #{고객명}");
    expect(collectPlaceholders("그대로 둡니다 {설정} #{고객명}")).toEqual([]);
  });

  it("collectPlaceholders 는 같은 표기를 한 번만 돌려주고 원본을 바꾸지 않는다", () => {
    const doc = { a: "{{settings.holdMinutes|min}} {{settings.holdMinutes|min}}", b: ["{{operator.email}}", { c: "{{settings.holdMinutes}}" }] };
    const found = collectPlaceholders(doc);
    expect(found.map((p) => p.raw).sort()).toEqual(["{{operator.email}}", "{{settings.holdMinutes|min}}", "{{settings.holdMinutes}}"].sort());
    const before = JSON.stringify(doc);
    const resolved = resolveDeep(doc, ctx());
    expect(JSON.stringify(doc)).toBe(before);
    expect(resolved.b[1]).toEqual({ c: "10" });
  });
});

// ── 약관·정책 문서 ────────────────────────────────────

describe("약관·정책 문서", () => {
  it("정해진 일곱 문서가 모두 있고 주소 이름과 맞는다", () => {
    expect([...LEGAL_SLUGS].sort()).toEqual(
      ["marketing-consent", "privacy", "ranking-policy", "refund-policy", "review-policy", "seller-terms", "terms"].sort(),
    );
    expect(Object.keys(LEGAL_DOCS).sort()).toEqual([...LEGAL_SLUGS].sort());
    expect(LEGAL_DOC_LIST).toHaveLength(LEGAL_SLUGS.length);
    for (const slug of LEGAL_SLUGS) {
      expect(LEGAL_DOCS[slug].slug).toBe(slug);
      expect(getLegalDoc(slug)).toBe(LEGAL_DOCS[slug]);
      expect(isLegalSlug(slug)).toBe(true);
    }
    expect(getLegalDoc("nope")).toBeUndefined();
    expect(getLegalDoc("constructor")).toBeUndefined();
    expect(legalDocHref("refund-policy")).toBe(`${LEGAL_BASE_PATH}/refund-policy`);
    expect(legalDocHref("terms", "disputes")).toBe(`${LEGAL_BASE_PATH}/terms#disputes`);
  });

  it("모든 문서: 섹션 ID 가 겹치지 않고, 핵심 요약이 있고, 검토 필요 표시가 켜져 있다", () => {
    for (const doc of LEGAL_DOC_LIST) {
      const where = doc.slug;
      expect(doc.title.trim(), where).not.toBe("");
      expect(doc.summary.trim(), where).not.toBe("");
      expect(doc.summary, where).not.toContain("\n");
      expect(doc.version, where).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(doc.effectiveDate, where).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["all", "customer", "seller"], where).toContain(doc.audience);

      expect(doc.keyPoints.length, where).toBeGreaterThanOrEqual(3);
      expect(doc.keyPoints.length, where).toBeLessThanOrEqual(6);
      for (const point of doc.keyPoints) expect(point.trim(), where).not.toBe("");

      expect(doc.reviewRequired, where).toBe(true);
      expect(doc.reviewNotes.length, where).toBeGreaterThanOrEqual(3);
      for (const note of doc.reviewNotes) expect(note.trim(), where).not.toBe("");

      expect(doc.sections.length, where).toBeGreaterThan(0);
      const ids = doc.sections.map((section) => section.id);
      expect(new Set(ids).size, `${where}: 섹션 ID 중복`).toBe(ids.length);
      for (const section of doc.sections) {
        expect(section.id, where).toMatch(KEBAB);
        expect(section.heading.trim(), `${where}#${section.id}`).not.toBe("");
        expect(section.blocks.length, `${where}#${section.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("블록 형식: 빈 문단·빈 목록이 없고 표의 칸 수가 머리글과 같다", () => {
    const checkBlock = (block: LegalBlock, where: string) => {
      switch (block.type) {
        case "p":
        case "note":
          expect(block.text.trim(), where).not.toBe("");
          break;
        case "ul":
        case "ol":
          expect(block.items.length, where).toBeGreaterThan(0);
          for (const item of block.items) expect(item.trim(), where).not.toBe("");
          break;
        case "table":
          expect(block.head.length, where).toBeGreaterThan(1);
          expect(block.rows.length, where).toBeGreaterThan(0);
          for (const row of block.rows) {
            expect(row.length, `${where}: ${row[0]}`).toBe(block.head.length);
            for (const cell of row) expect(cell.trim(), `${where}: ${row[0]}`).not.toBe("");
          }
          break;
        case "processors":
          expect(["all", "overseas", undefined], where).toContain(block.scope);
          break;
      }
    };
    for (const doc of LEGAL_DOC_LIST) {
      for (const section of doc.sections) {
        for (const block of section.blocks) checkBlock(block, `${doc.slug}#${section.id}`);
      }
    }
  });

  it("동의 기록에 남는 문서는 POLICY_VERSIONS 의 버전을 그대로 쓴다", () => {
    expect(LEGAL_DOCS.terms.version).toBe(POLICY_VERSIONS.TERMS);
    expect(LEGAL_DOCS.privacy.version).toBe(POLICY_VERSIONS.PRIVACY);
    expect(LEGAL_DOCS["refund-policy"].version).toBe(POLICY_VERSIONS.REFUND_POLICY);
    expect(LEGAL_DOCS["marketing-consent"].version).toBe(POLICY_VERSIONS.MARKETING);
  });

  it("문서는 합니다체로 쓴다(화면 문구를 따옴표로 옮긴 부분 제외)", () => {
    for (const doc of LEGAL_DOC_LIST) {
      for (const text of allStrings({ keyPoints: doc.keyPoints, sections: doc.sections, summary: doc.summary })) {
        const withoutQuotes = text.replace(/'[^']*'/g, "");
        expect(withoutQuotes, `${doc.slug}: ${text}`).not.toMatch(/(어요|아요|해요|예요|에요|세요|네요|게요|돼요|드려요)[.!?]?(\s|$)/);
      }
    }
  });

  it("이용약관에 필요한 조항이 모두 있고, 판매자와 호스트가 같은 뜻임을 밝힌다", () => {
    const ids = LEGAL_DOCS.terms.sections.map((section) => section.id);
    for (const id of [
      "purpose",
      "definitions",
      "company-role",
      "signup",
      "account",
      "booking-payment",
      "cancellation-refund",
      "waitlist",
      "attendance-noshow",
      "reviews",
      "prohibited",
      "restrictions",
      "liability",
      "disputes",
      "changes",
      "governing-law",
    ]) {
      expect(ids, id).toContain(id);
    }
    const text = allStrings(LEGAL_DOCS.terms).join("\n");
    expect(text).toContain("통신판매중개자");
    expect(text).toContain("'판매자'와 화면의 '호스트'는 같은 뜻");
    expect(text).toContain(`만 ${MIN_SIGNUP_AGE}세 이상`);
    expect(text).toContain("3영업일");
    expect(text).toContain("10영업일");
    expect(text).toContain(`${HELP_FACTS.noShowDisputeHours}시간 안에`);
    // 탈퇴는 마이 첫 단계, 선택 동의는 미리 선택하지 않는다(다크패턴 방지)
    expect(text).toContain("마이 화면의 첫 단계에서 언제든 탈퇴");
    expect(text).toContain("선택 항목을 미리 선택해 두지 않습니다");
    expect(text).toContain("취소 절차는 예약 절차보다 길지 않게");
  });

  it("개인정보처리방침·판매자 약관·정책 문서에 필요한 섹션이 있다", () => {
    const sectionIds = (doc: LegalDoc) => doc.sections.map((section) => section.id);
    for (const id of ["collected-items", "purposes", "retention", "third-party", "processors", "overseas-transfer", "rights", "security", "cookies", "officer", "changes"]) {
      expect(sectionIds(LEGAL_DOCS.privacy), id).toContain(id);
    }
    for (const id of [
      "onboarding",
      "obligations",
      "listing-rules",
      "commission",
      "rate-changes",
      "settlement",
      "cancellations-noshow",
      "seller-cancellation",
      "customer-data",
      "off-platform",
      "subscription",
      "termination",
    ]) {
      expect(sectionIds(LEGAL_DOCS["seller-terms"]), id).toContain(id);
    }
    for (const id of ["presets", "grace", "full-refund-cases", "resale-refund", "refund-timing", "no-show", "disputes"]) {
      expect(sectionIds(LEGAL_DOCS["refund-policy"]), id).toContain(id);
    }
    for (const id of ["eligibility", "posting", "rating", "seller-reply", "hiding", "appeal"]) {
      expect(sectionIds(LEGAL_DOCS["review-policy"]), id).toContain(id);
    }
    for (const id of ["default-order", "sort-options", "no-paid-placement", "no-discount-sort", "filters", "quality-score"]) {
      expect(sectionIds(LEGAL_DOCS["ranking-policy"]), id).toContain(id);
    }
    for (const id of ["channels", "contents", "night", "withdraw", "reconfirm"]) {
      expect(sectionIds(LEGAL_DOCS["marketing-consent"]), id).toContain(id);
    }
  });

  it("푸터 링크와 고지 문구가 실제 문서를 가리키고 운영자 항목을 모두 보여 준다", () => {
    for (const link of LEGAL_FOOTER_LINKS) {
      expect(link.href).toBe(legalDocHref(link.slug));
      expectValidHref(link.href);
      expect(link.label.trim()).not.toBe("");
    }
    expect(LEGAL_FOOTER_LINKS.map((link) => link.slug)).toEqual(expect.arrayContaining(["terms", "privacy", "refund-policy"]));
    expect(LEGAL_FOOTER_LINKS.find((link) => link.slug === "privacy")?.emphasis).toBe(true);

    expect(INTERMEDIARY_NOTICE).toContain("통신판매중개자");
    expect(resolveText(INTERMEDIARY_NOTICE, ctx(FILLED_OPERATOR))).toContain("테스트상호");

    const disclosed = OPERATOR_DISCLOSURE_ITEMS.flatMap((item) => collectPlaceholders(item.value).map((p) => p.key)).sort();
    expect(disclosed).toEqual([...OPERATOR_FIELDS].sort());
  });
});

// ── 운영자 정보 표시 ──────────────────────────────────

describe("운영자 정보가 비어 있을 때", () => {
  it("문서에 '[운영자 정보 입력 필요: …]' 표시가 그대로 드러난다", () => {
    const terms = allStrings(resolveDoc(LEGAL_DOCS.terms, ctx())).join("\n");
    for (const field of ["companyName", "representative", "businessRegNo", "mailOrderRegNo", "address", "phone", "email", "hostingProvider"] as const) {
      expect(terms, field).toContain(missingOperatorMarker(field));
    }
    const privacy = allStrings(resolveDoc(LEGAL_DOCS.privacy, ctx())).join("\n");
    expect(privacy).toContain("[운영자 정보 입력 필요: 개인정보 보호책임자]");
    expect(privacy).toContain("[운영자 정보 입력 필요: 상호]");

    const footer = resolveDeep(OPERATOR_DISCLOSURE_ITEMS, ctx());
    expect(footer.map((item) => item.value)).toEqual(OPERATOR_FIELDS.map((field) => missingOperatorMarker(field)));
    expect(resolveText(INTERMEDIARY_NOTICE, ctx())).toContain("[운영자 정보 입력 필요: 상호]");
  });

  it("운영자 정보를 채우면 표시가 하나도 남지 않는다", () => {
    for (const [name, content] of Object.entries(ALL_CONTENT)) {
      for (const text of allStrings(resolveDeep(content, ctx(FILLED_OPERATOR)))) {
        expect(text, name).not.toContain("운영자 정보 입력 필요");
      }
    }
    const terms = allStrings(resolveDoc(LEGAL_DOCS.terms, ctx(FILLED_OPERATOR))).join("\n");
    expect(terms).toContain("테스트상호");
    expect(terms).toContain("제0000-테스트-0000호");
  });

  it("문서에는 회사 정보를 직접 적지 않는다(자리표시자로만 가리킨다)", () => {
    // 사업자등록번호·전화번호 모양의 글자가 문서 원문에 있으면 안 된다.
    for (const doc of LEGAL_DOC_LIST) {
      for (const text of allStrings(doc.sections)) {
        expect(text, doc.slug).not.toMatch(/\d{3}-\d{2}-\d{5}/);
        expect(text, doc.slug).not.toMatch(/0\d{1,2}-\d{3,4}-\d{4}/);
        expect(text, doc.slug).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      }
    }
  });
});

describe("getOperatorInfo · isOperatorInfoComplete", () => {
  it("환경 변수 목록이 운영자 항목과 하나씩 맞는다", () => {
    expect(OPERATOR_ENV_KEYS.map((item) => item.field).sort()).toEqual([...OPERATOR_FIELDS].sort());
    expect(OPERATOR_ENV_KEYS.map((item) => item.key)).toEqual([
      "OPERATOR_COMPANY_NAME",
      "OPERATOR_REPRESENTATIVE",
      "OPERATOR_BUSINESS_REG_NO",
      "OPERATOR_MAIL_ORDER_REG_NO",
      "OPERATOR_ADDRESS",
      "OPERATOR_PHONE",
      "OPERATOR_EMAIL",
      "OPERATOR_PRIVACY_OFFICER",
      "OPERATOR_HOSTING_PROVIDER",
    ]);
    for (const item of OPERATOR_ENV_KEYS) {
      expect(item.label).toBe(OPERATOR_FIELD_LABELS[item.field]);
      expect(item.help.trim()).not.toBe("");
    }
  });

  it("값이 없으면 빈 문자열이고, 빠진 항목을 한국어 이름으로 알려 준다", () => {
    for (const item of OPERATOR_ENV_KEYS) vi.stubEnv(item.key, "");
    expect(getOperatorInfo()).toEqual(EMPTY_OPERATOR_INFO);
    expect(isOperatorInfoComplete()).toEqual({ complete: false, missing: OPERATOR_ENV_KEYS.map((item) => item.label) });

    vi.stubEnv("OPERATOR_COMPANY_NAME", "  테스트상호  ");
    vi.stubEnv("OPERATOR_EMAIL", "help@example.com");
    const info = getOperatorInfo();
    expect(info.companyName).toBe("테스트상호");
    expect(info.email).toBe("help@example.com");
    const partial = isOperatorInfoComplete();
    expect(partial.complete).toBe(false);
    expect(partial.missing).not.toContain("상호");
    expect(partial.missing).toContain("통신판매업 신고번호");
    expect(partial.missing).toHaveLength(OPERATOR_ENV_KEYS.length - 2);
  });

  it("모두 채우면 complete 가 true 다", () => {
    for (const item of OPERATOR_ENV_KEYS) vi.stubEnv(item.key, `값-${item.field}`);
    expect(isOperatorInfoComplete()).toEqual({ complete: true, missing: [] });
    expect(getOperatorInfo().privacyOfficer).toBe("값-privacyOfficer");
  });
});

// ── 수탁자 표 ─────────────────────────────────────────

describe("개인정보 처리 수탁자", () => {
  const names = (list: readonly { name: string }[]) => list.map((p) => p.name);

  it("모든 수탁자에 켜지는 조건이 있고, 항목이 비어 있지 않다", () => {
    for (const p of PROCESSORS) {
      expect(PROCESSOR_ENABLED_KEYS, p.name).toContain(p.enabledWhen);
      for (const value of [p.name, p.purpose, p.items, p.retention]) expect(value.trim(), p.name).not.toBe("");
    }
    // 결제·문자·이메일·저장소·본인확인은 각각 자기 연동 키로만 켜진다.
    const byKey = (key: ProcessorEnabledKey) => PROCESSORS.filter((p) => p.enabledWhen === key);
    expect(names(byKey("payment:toss"))).toEqual(["토스페이먼츠"]);
    expect(byKey("sms:solapi")).toHaveLength(1);
    expect(byKey("email:resend")).toHaveLength(1);
    expect(byKey("storage:s3")).toHaveLength(1);
    expect(byKey("identity")).toHaveLength(1);
    expect(names(byKey("always"))).toEqual(["{{operator.hostingProvider}}"]);
  });

  it("연동이 켜진 수탁자만 보여 준다(호스팅은 항상)", () => {
    expect(names(visibleProcessors(PROCESSORS, []))).toEqual(["{{operator.hostingProvider}}"]);

    const withToss = visibleProcessors(PROCESSORS, ["payment:toss"]);
    expect(names(withToss)).toEqual(["{{operator.hostingProvider}}", "토스페이먼츠"]);

    const withMessaging = visibleProcessors(PROCESSORS, new Set<ProcessorEnabledKey>(["sms:solapi", "email:resend"]));
    expect(withMessaging).toHaveLength(3);
    expect(names(withMessaging)).not.toContain("토스페이먼츠");

    expect(visibleProcessors(PROCESSORS, PROCESSOR_ENABLED_KEYS)).toEqual([...PROCESSORS]);
    // 수탁자가 없는 연동 키(카카오 로그인)를 켜도 표는 달라지지 않는다.
    expect(visibleProcessors(PROCESSORS, ["kakaoLogin"])).toHaveLength(1);
    // 원본 순서를 지킨다.
    expect(names(visibleProcessors(PROCESSORS, ["identity", "payment:toss"]))).toEqual(
      names(PROCESSORS.filter((p) => ["always", "payment:toss", "identity"].includes(p.enabledWhen))),
    );
  });

  it("국외 이전 표에는 처리 국가가 있는 수탁자만 나온다 — 그 연동이 켜졌을 때만", () => {
    expect(overseasProcessors(visibleProcessors(PROCESSORS, []))).toEqual([]);
    expect(overseasProcessors(visibleProcessors(PROCESSORS, ["payment:toss", "sms:solapi"]))).toEqual([]);
    const overseas = overseasProcessors(visibleProcessors(PROCESSORS, ["email:resend"]));
    expect(overseas).toHaveLength(1);
    expect(overseas[0]?.country).toBeTruthy();
  });

  it("문서의 수탁자 블록에 그릴 목록: 전체 표와 국외 이전 표", () => {
    expect(processorsForBlock({}, PROCESSORS, [])).toEqual(visibleProcessors(PROCESSORS, []));
    expect(processorsForBlock({ scope: "all" }, PROCESSORS, ["payment:toss"])).toEqual(visibleProcessors(PROCESSORS, ["payment:toss"]));
    expect(processorsForBlock({ scope: "overseas" }, PROCESSORS, ["payment:toss"])).toEqual([]);
    expect(names(processorsForBlock({ scope: "overseas" }, PROCESSORS, PROCESSOR_ENABLED_KEYS))).toEqual(
      names(PROCESSORS.filter((p) => p.country)),
    );
  });

  it("켜진 연동은 환경 변수로 판단한다 — 토스페이먼츠는 실결제 키일 때만", () => {
    for (const key of ["PAYMENT_PROVIDER", "TOSS_CLIENT_KEY", "SMS_PROVIDER", "RESEND_API_KEY", "STORAGE_DRIVER", "KAKAO_CLIENT_ID"]) {
      vi.stubEnv(key, "");
    }
    expect(getEnabledProcessorKeys()).toEqual(["always"]);

    vi.stubEnv("PAYMENT_PROVIDER", "mock");
    vi.stubEnv("SMS_PROVIDER", "none");
    vi.stubEnv("STORAGE_DRIVER", "local");
    expect(getEnabledProcessorKeys()).toEqual(["always"]);

    // 테스트 키로는 실제 청구가 없으므로 수탁자 표에 올리지 않는다.
    vi.stubEnv("PAYMENT_PROVIDER", "toss");
    vi.stubEnv("TOSS_CLIENT_KEY", "test_ck_xxxxxxxx");
    expect(getEnabledProcessorKeys()).toEqual(["always"]);
    vi.stubEnv("TOSS_CLIENT_KEY", "live_ck_xxxxxxxx");
    expect(getEnabledProcessorKeys()).toEqual(["always", "payment:toss"]);

    vi.stubEnv("SMS_PROVIDER", "solapi");
    vi.stubEnv("RESEND_API_KEY", "re_xxxxxxxx");
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("KAKAO_CLIENT_ID", "kakao-rest-key");
    const all = getEnabledProcessorKeys();
    expect(all).toEqual(["always", "payment:toss", "sms:solapi", "email:resend", "storage:s3", "kakaoLogin"]);
    for (const key of all) expect(PROCESSOR_ENABLED_KEYS).toContain(key);
    // 본인확인은 연동 설정이 생기기 전까지 켜지지 않는다.
    expect(all).not.toContain("identity");
    expect(names(visibleProcessors(PROCESSORS, all))).not.toContain("본인확인 서비스 제공사(계약을 맺은 뒤 상호를 적습니다)");
    expect(visibleProcessors(PROCESSORS, all)).toHaveLength(PROCESSORS.length - 1);
  });

  it("처리방침은 수탁자 표를 데이터에서 그린다", () => {
    const blocks = LEGAL_DOCS.privacy.sections.flatMap((section) => section.blocks);
    const processorBlocks = blocks.filter((block) => block.type === "processors");
    expect(processorBlocks).toHaveLength(2);
    expect(processorBlocks.map((block) => (block.type === "processors" ? (block.scope ?? "all") : ""))).toEqual(["all", "overseas"]);
    // 수탁자 이름을 문서 본문에 직접 적지 않는다(켜지지 않은 연동이 드러나지 않게).
    const body = allStrings(LEGAL_DOCS.privacy.sections).join("\n");
    for (const name of ["토스페이먼츠", "솔라피", "SOLAPI", "Resend"]) expect(body).not.toContain(name);
  });
});

// ── 취소·환불 기준 ────────────────────────────────────

describe("취소·환불 기준", () => {
  const duration = (hours: number) => (hours >= 24 && hours % 24 === 0 ? `${hours / 24}일` : `${hours}시간`);
  const refundLabel = (rate: number) => (rate === 100 ? "전액 환불" : rate === 0 ? "환불 불가" : `${rate}% 환불`);

  const presetTable = () => {
    const section = LEGAL_DOCS["refund-policy"].sections.find((s) => s.id === "presets");
    const table = section?.blocks.find((block) => block.type === "table");
    if (!table || table.type !== "table") throw new Error("환불 기준 표가 없어요");
    return table;
  };

  it("환불 기준 표의 숫자가 CANCELLATION_PRESETS 와 같다", () => {
    const table = presetTable();
    expect(table.rows).toBe(REFUND_PRESET_ROWS);
    expect(table.head).toHaveLength(3);

    const expected: string[][] = [];
    for (const key of ["FLEXIBLE", "STANDARD", "STRICT"] as CancellationPresetKey[]) {
      const preset = CANCELLATION_PRESETS[key];
      const tiers = [...preset.tiers].sort((a, b) => b.hoursBefore - a.hoursBefore);
      tiers.forEach((tier, i) => {
        const previous = tiers[i - 1];
        const when = tier.hoursBefore === 0 ? `시작 ${duration(previous?.hoursBefore ?? 0)} 전 이후` : `시작 ${duration(tier.hoursBefore)} 전까지`;
        expected.push([preset.label, when, refundLabel(tier.refundRate)]);
      });
    }
    expect(table.rows).toEqual(expected);
    expect(Object.keys(CANCELLATION_PRESETS).sort()).toEqual(["FLEXIBLE", "STANDARD", "STRICT"]);
  });

  it("지금의 세 기준을 글자 그대로 확인한다(값이 바뀌면 약관 버전도 올려야 한다)", () => {
    expect(presetTable().rows).toEqual([
      ["유연", "시작 1일 전까지", "전액 환불"],
      ["유연", "시작 3시간 전까지", "50% 환불"],
      ["유연", "시작 3시간 전 이후", "환불 불가"],
      ["표준", "시작 3일 전까지", "전액 환불"],
      ["표준", "시작 1일 전까지", "50% 환불"],
      ["표준", "시작 1일 전 이후", "환불 불가"],
      ["엄격", "시작 7일 전까지", "전액 환불"],
      ["엄격", "시작 3일 전까지", "50% 환불"],
      ["엄격", "시작 3일 전 이후", "환불 불가"],
    ]);
  });

  it("재판매 연동 환불 예시 금액이 엔진 계산식과 같다", () => {
    const tiers = [...CANCELLATION_PRESETS[RESALE_EXAMPLE.preset].tiers].sort((a, b) => b.hoursBefore - a.hoursBefore);
    expect(RESALE_EXAMPLE.resaleRefundRate).toBeGreaterThanOrEqual(50);
    expect(RESALE_EXAMPLE.resaleRefundRate).toBeLessThanOrEqual(100);
    expect(RESALE_EXAMPLE_CASES).toHaveLength(RESALE_EXAMPLE.cancelHoursBefore.length);

    RESALE_EXAMPLE_CASES.forEach((c, i) => {
      expect(c.hoursBefore).toBe(RESALE_EXAMPLE.cancelHoursBefore[i]);
      const baseRate = tiers.find((tier) => c.hoursBefore >= tier.hoursBefore)?.refundRate ?? 0;
      const baseRefund = Math.floor((RESALE_EXAMPLE.paidAmount * baseRate) / 100);
      // docs/02-architecture.md 6.4: floor(결제액 × (재판매 환불율 − 환불율) / 100 × 매칭수량 / 수량), 1명 전부 매칭
      const extraRefund = Math.floor((RESALE_EXAMPLE.paidAmount * (RESALE_EXAMPLE.resaleRefundRate - baseRate)) / 100);
      expect(c).toEqual({ hoursBefore: c.hoursBefore, baseRate, baseRefund, extraRefund, totalRefund: baseRefund + extraRefund });
      // 재판매 환불은 기본 환불율이 더 낮을 때만 의미가 있다.
      expect(baseRate).toBeLessThan(RESALE_EXAMPLE.resaleRefundRate);
    });

    const section = LEGAL_DOCS["refund-policy"].sections.find((s) => s.id === "resale-refund");
    const table = section?.blocks.find((block) => block.type === "table");
    if (!table || table.type !== "table") throw new Error("재판매 예시 표가 없어요");
    expect(table.rows).toEqual(
      RESALE_EXAMPLE_CASES.map((c) => [
        `시작 ${c.hoursBefore}시간 전에 취소`,
        `${c.baseRate}% · ${formatKRW(c.baseRefund)}`,
        formatKRW(c.extraRefund),
        formatKRW(c.totalRefund),
      ]),
    );
    // 지금의 예시: 표준 기준 40,000원, 재판매 환불율 80%
    expect(table.rows).toEqual([
      ["시작 48시간 전에 취소", "50% · 20,000원", "12,000원", "32,000원"],
      ["시작 12시간 전에 취소", "0% · 0원", "32,000원", "32,000원"],
    ]);
  });

  it("무료 취소 시간과 임박 예외, 환불 처리 기간을 설정값·일반 안내로 적는다", () => {
    const raw = allStrings(LEGAL_DOCS["refund-policy"]).join("\n");
    expect(raw).toContain("{{settings.cancelGraceMinutes|min}}");
    expect(raw).toContain("{{settings.cancelGraceMinLeadMinutes|min}}");
    const rendered = allStrings(resolveDoc(LEGAL_DOCS["refund-policy"], ctx())).join("\n");
    expect(rendered).toContain("예약한 때부터 30분(현재 기준) 안에 취소하면");
    expect(rendered).toContain("회차 시작까지 3시간보다 적게 남았던 임박 예약");
    // 환불 반영 시점은 단정하지 않는다.
    expect(rendered).toContain("보통 영업일 기준 3~7일 정도 걸릴 수 있습니다");
    expect(rendered).toContain("카드사와 결제 수단에 따라 다릅니다");
  });

  it("도움말의 환불 기준 설명도 같은 값에서 나온다", () => {
    const answer = getFaqItem("refund-amount")?.a ?? "";
    for (const preset of Object.values(CANCELLATION_PRESETS)) {
      expect(answer).toContain(`'${preset.label}' 기준은 ${preset.desc}이에요.`);
    }
    const resale = getFaqItem("resale-refund")?.a ?? "";
    const late = RESALE_EXAMPLE_CASES.find((c) => c.baseRate === 0);
    expect(late).toBeDefined();
    expect(resale).toContain(`${formatKRW(RESALE_EXAMPLE.paidAmount)}에 결제`);
    expect(resale).toContain(`${RESALE_EXAMPLE.resaleRefundRate}%로`);
    expect(resale).toContain(`시작 ${late?.hoursBefore}시간 전에 취소하면 바로 받는 환불은 ${formatKRW(late?.baseRefund ?? -1)}이에요`);
    expect(resale).toContain(`${formatKRW(late?.extraRefund ?? -1)}을 더 돌려받아요`);
  });
});

// ── 엔진 상수와의 일치 ────────────────────────────────

describe("문서에 적은 숫자가 엔진 상수와 같다", () => {
  it("플랜 한도", () => {
    expect(PLAN_LIMITS.FREE.maxActiveProducts).toBe(PLAN_FEATURES.FREE.maxActiveProducts);
    expect(PLAN_LIMITS.PRO.maxActiveProducts).toBe(PLAN_FEATURES.PRO.maxActiveProducts);
    expect(PLAN_LIMITS.FREE.maxTeamMembers).toBe(PLAN_FEATURES.FREE.maxTeamMembers);
    expect(PLAN_LIMITS.PRO.maxTeamMembers).toBe(PLAN_FEATURES.PRO.maxTeamMembers);
    const sellerTerms = allStrings(LEGAL_DOCS["seller-terms"]).join("\n");
    expect(sellerTerms).toContain(`베이직 ${PLAN_FEATURES.FREE.maxActiveProducts}개, 프로 ${PLAN_FEATURES.PRO.maxActiveProducts}개`);
    expect(sellerTerms).toContain(`베이직 ${PLAN_FEATURES.FREE.maxTeamMembers}명, 프로 ${PLAN_FEATURES.PRO.maxTeamMembers}명`);
  });

  it("후기·신고·알림·예약 링크 한도", () => {
    expect(REVIEW_MIN_COUNT_FOR_RATING).toBe(REVIEW_NEW_THRESHOLD);
    expect(HELP_FACTS.noShowDisputeHours).toBe(NO_SHOW_DISPUTE_HOURS);
    expect(HELP_FACTS.reportDailyLimit).toBe(REPORT_DAILY_LIMIT);
    expect(HELP_FACTS.reportDetailMin).toBe(REPORT_DETAIL_MIN);
    expect(HELP_FACTS.vacancyDailyLimit).toBe(VACANCY_DAILY_LIMIT);
    expect(HELP_FACTS.maxAlertRules).toBe(MAX_ALERT_RULES);
    expect(HELP_FACTS.maxOwnedBusinesses).toBe(MAX_OWNED_BUSINESSES);
    expect(HELP_FACTS.directLinkDays).toBe(REF_COOKIE_MAX_AGE / 86_400);
    expect(Number.isInteger(HELP_FACTS.directLinkDays)).toBe(true);
    // 처리방침의 쿠키 표도 같은 기간을 적는다.
    expect(allStrings(LEGAL_DOCS.privacy).join("\n")).toContain(`판매자의 예약 링크로 들어온 방문을 ${HELP_FACTS.directLinkDays}일 동안 기억합니다`);
  });

  it("광고성 정보의 야간은 밤 9시부터 아침 8시까지다", () => {
    const kst = (hour: number, minute = 0) => new Date(Date.UTC(2026, 10, 27, hour - 9, minute));
    expect(isNightKst(kst(20, 59))).toBe(false);
    expect(isNightKst(kst(21))).toBe(true);
    expect(isNightKst(kst(7, 59))).toBe(true);
    expect(isNightKst(kst(8))).toBe(false);
    const marketing = allStrings(LEGAL_DOCS["marketing-consent"]).join("\n");
    expect(marketing).toContain("밤 9시부터 다음 날 아침 8시 사이에는 광고성 문자를 보내지 않습니다");
    expect(marketing).toContain("2년마다");
    expect(getFaqItem("notifications")?.a).toContain("밤 9시부터 아침 8시 사이");
  });

  it("판매자 약관의 금칙 표현 목록이 policy.ts 와 같다", () => {
    const text = allStrings(LEGAL_DOCS["seller-terms"]).join("\n").replace(/\s+/g, "");
    for (const item of BANNED_PHRASES) expect(text, item.phrase).toContain(item.phrase.replace(/\s+/g, ""));
  });

  it("판매자 약관의 수수료 표가 판정 순서 일곱 가지를 모두 담는다", () => {
    const section = LEGAL_DOCS["seller-terms"].sections.find((s) => s.id === "commission");
    const table = section?.blocks.find((block) => block.type === "table");
    if (!table || table.type !== "table") throw new Error("수수료 표가 없어요");
    expect(table.rows.map((row) => row[0])).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    const used = collectPlaceholders(section).map((p) => p.key);
    for (const key of [
      "commissionDirectBps",
      "pgFeeBps",
      "launchPromoMonths",
      "launchPromoBookings",
      "returningWindowDays",
      "commissionReturningBps",
      "commissionNewCustomerBps",
      "proCommissionNewCustomerBps",
      "commissionCapPerSeat",
    ]) {
      expect(used, key).toContain(key);
    }
  });
});

// ── 자주 묻는 질문 ────────────────────────────────────

describe("자주 묻는 질문", () => {
  it("25~35개이고 고객·호스트 양쪽에 필요한 주제가 모두 있다", () => {
    const items = allFaqItems();
    expect(items.length).toBeGreaterThanOrEqual(25);
    expect(items.length).toBeLessThanOrEqual(35);

    const customerIds = faqGroupsFor("customer").flatMap((group) => group.items.map((item) => item.id));
    const sellerIds = faqGroupsFor("seller").flatMap((group) => group.items.map((item) => item.id));
    expect(customerIds.length + sellerIds.length).toBe(items.length);
    for (const id of [
      "what-is",
      "price",
      "how-to-book",
      "payment-methods",
      "hold",
      "cancel-how",
      "refund-amount",
      "free-cancel",
      "resale-refund",
      "waitlist-join",
      "waitlist-offer",
      "go-confirmed",
      "no-show",
      "identity",
      "notifications",
      "reviews",
      "safety",
    ]) {
      expect(customerIds, id).toContain(id);
    }
    for (const id of [
      "seller-onboarding",
      "commission",
      "manual-booking",
      "direct-link",
      "relist",
      "seller-waitlist",
      "checkin",
      "settlement",
      "pro-plan",
      "customer-data",
    ]) {
      expect(sellerIds, id).toContain(id);
    }
  });

  it("묶음·질문 ID 가 겹치지 않고, 빈 질문·빈 답변·빈 문단이 없다", () => {
    const groupIds = FAQ_GROUPS.map((group) => group.id);
    expect(new Set(groupIds).size).toBe(groupIds.length);
    const itemIds = allFaqItems().map((item) => item.id);
    expect(new Set(itemIds).size).toBe(itemIds.length);

    for (const group of FAQ_GROUPS) {
      expect(group.id).toMatch(KEBAB);
      expect(group.title.trim()).not.toBe("");
      expect(["customer", "seller"]).toContain(group.audience);
      expect(group.items.length, group.id).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(item.id).toMatch(KEBAB);
        expect(item.q.trim(), item.id).not.toBe("");
        expect(item.q.trim().endsWith("?"), `${item.id}: 질문은 물음표로 끝난다`).toBe(true);
        expect(item.a.trim(), item.id).not.toBe("");
        expect(item.a, item.id).toBe(item.a.trim());
        // 문단은 빈 줄로만 나눈다(줄바꿈 하나는 쓰지 않는다).
        expect(item.a.replace(/\n\n/g, ""), item.id).not.toContain("\n");
        const paragraphs = item.a.split("\n\n");
        expect(splitParagraphs(item.a), item.id).toEqual(paragraphs);
        for (const paragraph of paragraphs) expect(paragraph.trim().length, `${item.id}: 빈 문단`).toBeGreaterThan(5);
        expect(getFaqItem(item.id)).toBe(item);
      }
    }
    expect(getFaqItem("nope")).toBeUndefined();
  });

  it("링크는 같은 사이트 경로이고 약관 링크는 실제 문서·섹션을 가리킨다", () => {
    const links = allLinks(HELP_CONTENT);
    expect(links.length).toBeGreaterThan(10);
    for (const href of links) expectValidHref(href);
    for (const item of allFaqItems()) {
      for (const link of item.links ?? []) expect(link.label.trim(), item.id).not.toBe("");
    }
    expect(HELP_SAFETY_PATH.startsWith(`${HELP_BASE_PATH}/`)).toBe(true);
    expect(SAFETY_PAGE.path).toBe(HELP_SAFETY_PATH);
  });

  it("'연동 전' 안내는 그 연동이 켜지면 사라진다", () => {
    const withNotes = allFaqItems().filter((item) => (item.pendingNotes ?? []).length > 0);
    expect(withNotes.length).toBeGreaterThan(0);
    for (const item of withNotes) {
      for (const note of item.pendingNotes ?? []) {
        expect(PROCESSOR_ENABLED_KEYS, item.id).toContain(note.until);
        expect(note.until, item.id).not.toBe("always");
        expect(note.text.trim(), item.id).not.toBe("");
      }
      expect(visiblePendingNotes(item, [])).toEqual(item.pendingNotes);
      expect(visiblePendingNotes(item, PROCESSOR_ENABLED_KEYS)).toEqual([]);
    }
    const payment = getFaqItem("payment-methods");
    expect(visiblePendingNotes(payment ?? {}, ["sms:solapi"])).toHaveLength(1);
    expect(visiblePendingNotes(payment ?? {}, ["payment:toss"])).toEqual([]);
    expect(visiblePendingNotes({}, [])).toEqual([]);
    // 결제·문자·본인확인이 연동 전이라는 사실을 숨기지 않는다.
    const pendingKeys = new Set(withNotes.flatMap((item) => (item.pendingNotes ?? []).map((note) => note.until)));
    for (const key of ["payment:toss", "sms:solapi", "identity"] as const) expect(pendingKeys.has(key), key).toBe(true);
  });

  it("답변이 엔진 규칙의 설정값을 가리킨다", () => {
    const uses = (id: string) => collectPlaceholders(getFaqItem(id)).map((p) => p.raw);
    expect(uses("hold")).toContain("{{settings.holdMinutes|min}}");
    expect(uses("free-cancel")).toEqual(expect.arrayContaining(["{{settings.cancelGraceMinutes|min}}", "{{settings.cancelGraceMinLeadMinutes|min}}"]));
    expect(uses("waitlist-offer")).toEqual(
      expect.arrayContaining([
        "{{settings.waitlistOfferMinutes|min}}",
        "{{settings.waitlistOfferMinMinutes|min}}",
        "{{settings.waitlistBroadcastWithinMinutes|min}}",
      ]),
    );
    expect(uses("no-show")).toEqual(
      expect.arrayContaining(["{{settings.noShowWindowDays|days}}", "{{settings.noShowLimit}}", "{{settings.noShowRestrictDays|days}}"]),
    );
    expect(uses("reviews")).toContain("{{settings.reviewWindowDays|days}}");
    expect(uses("commission")).toEqual(
      expect.arrayContaining([
        "{{settings.commissionNewCustomerBps|percent}}",
        "{{settings.proCommissionNewCustomerBps|percent}}",
        "{{settings.commissionReturningBps|percent}}",
        "{{settings.commissionDirectBps|percent}}",
        "{{settings.pgFeeBps|percent}}",
        "{{settings.commissionCapPerSeat|krw}}",
        "{{settings.returningWindowDays|days}}",
      ]),
    );
    expect(uses("launch-promo")).toEqual(expect.arrayContaining(["{{settings.launchPromoMonths}}", "{{settings.launchPromoBookings}}"]));
    expect(uses("checkin")).toContain("{{settings.autoCompleteAfterHours|hours}}");
    expect(uses("pro-plan")).toEqual(
      expect.arrayContaining(["{{settings.proPriceMonthly|krw}}", "{{settings.proMonthlyMessages}}", "{{settings.freeMonthlyMessages}}"]),
    );

    const rendered = resolveDeep(FAQ_GROUPS, ctx());
    const answer = (id: string) => rendered.flatMap((group) => group.items).find((item) => item.id === id)?.a ?? "";
    expect(answer("hold")).toContain("결제를 시작하면 10분 동안 자리를 잡아 둬요");
    expect(answer("free-cancel")).toContain("예약한 뒤 30분 안에 취소하면");
    expect(answer("free-cancel")).toContain("시작까지 3시간보다 적게 남았던 임박 예약");
    expect(answer("waitlist-offer")).toContain("30분 동안 자리를 잡아 둬요");
    expect(answer("waitlist-offer")).toContain("15분보다 짧아지지는 않아요");
    expect(answer("waitlist-offer")).toContain("시작까지 3시간 이내로 남았으면");
    expect(answer("no-show")).toContain("최근 365일 동안 노쇼가 2회에 이르면 30일 동안 새 예약이 제한돼요");
    expect(answer("no-show")).toContain("72시간 안에");
    expect(answer("no-show")).toContain("48시간 안에는");
    expect(answer("reviews")).toContain("14일 안에");
    expect(answer("reviews")).toContain("3개보다 적으면 평점 대신 '신규'");
    expect(answer("commission")).toContain("9.9%예요(프로 플랜은 6.9%)");
    expect(answer("commission")).toContain("결제 실비(3.74%)를 차감해요");
    expect(answer("commission")).toContain("1인당 10,000원을 넘지 않아요");
    expect(answer("direct-link")).toContain("7일 안에");
    expect(answer("pro-plan")).toContain("월 19,900원(부가세 포함)");
    expect(answer("pro-plan")).toContain("5명까지(베이직 1명)");
    expect(answer("pro-plan")).toContain("200개까지(베이직 10개)");
    expect(answer("pro-plan")).toContain("2,000건까지(베이직 300건)");
    expect(answer("notifications")).toContain("하루에 5건까지만");
  });

  it("대기 제안은 예약 보장이 아니라고 분명히 말한다", () => {
    expect(getFaqItem("waitlist-missed")?.a).toContain("예약 보장이 아니에요");
    expect(getFaqItem("waitlist-missed")?.a).toContain("두 번 놓치면 대기가 끝나요");
    expect(allStrings(LEGAL_DOCS.terms).join("\n")).toContain("자리 제안과 알림은 예약 보장이 아닙니다");
  });
});

// ── 안전 수칙 · 안내 목록 ─────────────────────────────

describe("안전 수칙", () => {
  it("참가자용 8~10개, 호스트용 6~8개이고 ID 가 겹치지 않는다", () => {
    expect(PARTICIPANT_SAFETY_RULES.length).toBeGreaterThanOrEqual(8);
    expect(PARTICIPANT_SAFETY_RULES.length).toBeLessThanOrEqual(10);
    expect(HOST_SAFETY_RULES.length).toBeGreaterThanOrEqual(6);
    expect(HOST_SAFETY_RULES.length).toBeLessThanOrEqual(8);
    const ids = [...PARTICIPANT_SAFETY_RULES, ...HOST_SAFETY_RULES].map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of [...PARTICIPANT_SAFETY_RULES, ...HOST_SAFETY_RULES]) {
      expect(rule.id).toMatch(KEBAB);
      expect(rule.title.trim()).not.toBe("");
      expect(rule.body.trim().length).toBeGreaterThan(10);
    }
    expect(BOOKING_SAFETY_TIPS).toHaveLength(3);
  });

  it("긴급 연락처에는 공공 번호만 적는다", () => {
    const numbers = EMERGENCY_CONTACTS.map((contact) => contact.number);
    expect(numbers).toEqual(expect.arrayContaining(["112", "119"]));
    for (const contact of [...EMERGENCY_CONTACTS, ...CONSUMER_HELP_CONTACTS]) {
      expect(contact.number, contact.name).toMatch(/^1\d{2,3}$/);
      expect(contact.name.trim()).not.toBe("");
      expect(contact.when.trim()).not.toBe("");
      expect(collectPlaceholders(contact)).toEqual([]);
    }
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(EMERGENCY_GUIDE.steps.join(" ")).toContain("112");
    expect(EMERGENCY_GUIDE.note).toContain("112");
  });

  it("신고 방법: 기한과 한도가 엔진과 같고 신고자를 알리지 않는다고 밝힌다", () => {
    const text = allStrings(REPORT_GUIDE).join("\n");
    expect(text).toContain(`${REPORT_DETAIL_MIN}자 이상`);
    expect(text).toContain(`하루에 ${REPORT_DAILY_LIMIT}건까지`);
    expect(text).toContain("3영업일 안에 진행 상황을, 10영업일 안에 처리 결과를");
    expect(text).toContain("누가 신고했는지는 신고 대상에게 알리지 않아요");
    expect(REPORT_GUIDE.steps.length).toBeGreaterThanOrEqual(3);
    for (const option of REPORT_REASON_OPTIONS) expect(option.label).toBe(REPORT_REASON_LABEL[option.key]);
    expect(REPORT_REASON_OPTIONS.map((option) => option.key)).toContain("SAFETY");
    expect(new Set(REPORT_REASON_OPTIONS.map((option) => option.key)).size).toBe(REPORT_REASON_OPTIONS.length);
  });
});

describe("안내 목록(온보딩·빈 화면)", () => {
  it("호스트 온보딩은 입점 신청 → 상품 1개 → 회차 1개 세 단계다", () => {
    expect(GUIDES.sellerOnboarding.steps.map((step) => step.id)).toEqual(["apply", "product", "slot"]);
  });

  it("각 목록의 항목 ID 가 겹치지 않고 내용이 비어 있지 않다", () => {
    const lists: { name: string; items: readonly { id: string; title: string; body: string }[] }[] = [
      { name: "sellerOnboarding", items: GUIDES.sellerOnboarding.steps },
      { name: "firstBooking", items: GUIDES.firstBooking.steps },
      { name: "vacancyWriting", items: GUIDES.vacancyWriting.tips },
    ];
    for (const { name, items } of lists) {
      expect(items.length, name).toBeGreaterThanOrEqual(3);
      expect(items.length, name).toBeLessThanOrEqual(8);
      const ids = items.map((item) => item.id);
      expect(new Set(ids).size, name).toBe(ids.length);
      for (const item of items) {
        expect(item.id, name).toMatch(KEBAB);
        expect(item.title.trim(), name).not.toBe("");
        expect(item.body.trim().length, name).toBeGreaterThan(10);
      }
    }
    for (const guide of Object.values(GUIDES)) {
      expect(guide.title.trim()).not.toBe("");
      expect(guide.summary.trim()).not.toBe("");
    }
  });
});

// ── 도움말 공통 ───────────────────────────────────────

describe("도움말 문구", () => {
  it("금칙 표현을 쓰지 않는다(자리표시자를 바꾼 뒤에도)", () => {
    expect(findBannedPhrases(...allStrings(HELP_CONTENT))).toEqual([]);
    expect(findBannedPhrases(...allStrings(resolveDeep(HELP_CONTENT, ctx(FILLED_OPERATOR))))).toEqual([]);
    // 검사가 실제로 동작하는지 확인
    expect(findBannedPhrases("오늘만 마감 세일").length).toBeGreaterThan(0);
  });

  it("해요체로 쓴다(약관식 말투를 섞지 않는다)", () => {
    for (const text of allStrings(HELP_CONTENT)) {
      expect(text).not.toMatch(/습니다|십시오|합니다|입니다|됩니다/);
    }
  });

  it("영어 약어·내부 용어를 고객에게 그대로 쓰지 않는다", () => {
    for (const text of allStrings(HELP_CONTENT)) {
      if (text.startsWith("/")) continue; // 경로
      expect(text, text).not.toMatch(/\b(PG|CRM|SMS|OTP|TOTP|API|bps|withheld|SIMULATED)\b/);
    }
  });
});
