import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  POST_EVENT_CHECK,
  REPORT_GUIDE,
  REPORT_REASON_OPTIONS,
  SAFETY_PAGE,
} from "@/content/help/safety";
import {
  AGE_CONFIRM_LABEL,
  CONSENT_NOTICES,
  INTERMEDIARY_NOTICE,
  INTERMEDIARY_NOTICE_SHORT,
  LEGAL_BASE_PATH,
  LEGAL_DOCS,
  LEGAL_DOC_LIST,
  LEGAL_FOOTER_LINKS,
  LEGAL_SLUGS,
  NO_REFUND_AT_BOOKING_NOTICE,
  OPERATOR_DISCLOSURE_ITEMS,
  PROCESSORS,
  PROCESSOR_ENABLED_KEYS,
  PROCESSOR_REGION_KEYS,
  SELLER_NAME_TOKEN,
  THIRD_PARTY_PROVISION,
  consentNoticesFor,
  fillSellerName,
  getLegalDoc,
  isLegalSlug,
  legalDocHref,
  type LegalBlock,
  type LegalDoc,
  type ProcessorEnabledKey,
} from "@/content/legal";
import { TIME_BAND_HOURS } from "@/content/legal/ranking-policy";
import { REFUND_PRESET_ROWS, RESALE_EXAMPLE, RESALE_EXAMPLE_CASES } from "@/content/legal/refund-policy";
import { REVIEW_MIN_COUNT_FOR_RATING } from "@/content/legal/review-policy";
import { COMMISSION_RULE_ORDER, PLAN_LIMITS } from "@/content/legal/seller-terms";
import {
  OPERATOR_ENV_KEYS,
  PROCESSOR_REGION_ENV_KEYS,
  getEnabledProcessorKeys,
  getOperatorInfo,
  getProcessorRegions,
  isOperatorInfoComplete,
} from "@/content/operator";
import {
  ContentPlaceholderError,
  EMPTY_OPERATOR_INFO,
  EMPTY_PROCESSOR_REGIONS,
  FORMATTERS,
  OPERATOR_FIELDS,
  OPERATOR_FIELD_LABELS,
  applyProcessorRegions,
  collectConditions,
  collectPlaceholders,
  formatSettingValue,
  isDomesticCountry,
  missingOperatorMarker,
  missingRegionMarker,
  overseasProcessors,
  processorsForBlock,
  resolveDeep,
  resolveDoc,
  resolveText,
  visibleBlocks,
  visibleProcessors,
  type Formatter,
  type OperatorInfo,
  type ProcessorRegions,
  type RenderContext,
} from "@/content/render";
import { REF_COOKIE_MAX_AGE } from "@/lib/cookies";
import { CANCELLATION_PRESETS, REPORT_REASON_LABEL, type CancellationPresetKey } from "@/lib/domain";
import { formatKRW } from "@/lib/money";
import { BANNED_PHRASES, COMMISSION_RULE_LABEL, MIN_SIGNUP_AGE, POLICY_VERSIONS, findBannedPhrases, type PolicyKind } from "@/lib/policy";
import { isNightKst } from "@/lib/time";
import { MAX_ALERT_RULES, VACANCY_DAILY_LIMIT } from "@/server/services/alerts";
import { MAX_OWNED_BUSINESSES } from "@/server/services/business";
import { TIME_BANDS } from "@/server/services/catalog";
import { NO_SHOW_DISPUTE_HOURS, REPORT_DAILY_LIMIT, REPORT_DETAIL_MIN } from "@/server/services/reports";
import { REVIEW_NEW_THRESHOLD } from "@/server/services/reviews";
import { DEFAULT_SETTINGS, PLAN_FEATURES, settingsSchema, type PlatformSettings } from "@/server/settings";

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

/** 기본 설정값을 문서와 같은 표시 형식으로 그린다(기대값을 글자로 박아 두지 않기 위해) */
const shown = (key: keyof PlatformSettings, formatter: Formatter = "none", settings: PlatformSettings = DEFAULT_SETTINGS): string =>
  formatSettingValue(settings[key], formatter);

/** 0 이 "없음"을 뜻하는 설정을 모두 0 으로 둔 설정(1인당 상한·최소 수수료, 입점 프로모션, 무료 취소 시간) */
const ZERO_SETTINGS: PlatformSettings = {
  ...DEFAULT_SETTINGS,
  commissionCapPerSeat: 0,
  commissionMinPerSeat: 0,
  launchPromoBookings: 0,
  launchPromoMonths: 0,
  cancelGraceMinutes: 0,
  cancelGraceMinLeadMinutes: 0,
};

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
  POST_EVENT_CHECK,
  GUIDES,
};

/** 자리표시자가 들어갈 수 있는 모든 콘텐츠 */
const ALL_CONTENT: Record<string, unknown> = {
  ...Object.fromEntries(LEGAL_DOC_LIST.map((doc) => [`legal:${doc.slug}`, doc])),
  PROCESSORS,
  INTERMEDIARY_NOTICE,
  INTERMEDIARY_NOTICE_SHORT,
  OPERATOR_DISCLOSURE_ITEMS,
  LEGAL_FOOTER_LINKS,
  CONSENT_NOTICES,
  THIRD_PARTY_PROVISION,
  ...HELP_CONTENT,
};

/** 약관식 말투(합니다체)로 쓰는 콘텐츠: 문서 본문과 동의 고지문 */
const FORMAL_CONTENT: Record<string, unknown> = {
  ...Object.fromEntries(LEGAL_DOC_LIST.map((doc) => [`legal:${doc.slug}`, { keyPoints: doc.keyPoints, sections: doc.sections, summary: doc.summary }])),
  CONSENT_NOTICES,
  THIRD_PARTY_PROVISION,
  INTERMEDIARY_NOTICE,
  INTERMEDIARY_NOTICE_SHORT,
  AGE_CONFIRM_LABEL,
  NO_REFUND_AT_BOOKING_NOTICE,
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
      if (key === "commissionCapPerSeat" || key === "commissionMinPerSeat" || key === "proPriceMonthly") return "krw";
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
        expect(text, name).not.toContain("[[");
        expect(text, name).not.toContain("]]");
        expect(text, name).not.toContain("[내용 확인 필요]");
        expect(text, name).not.toMatch(/undefined|NaN/);
        expect(text.trim(), `${name}: 빈 문장`).not.toBe("");
      }
    }
  });

  it("조건문은 실제 설정 키만 쓰고 짝이 맞는다", () => {
    let count = 0;
    for (const [name, content] of Object.entries(ALL_CONTENT)) {
      for (const condition of collectConditions(content)) {
        count += 1;
        expect(condition.keys.length, `${name} 의 ${condition.raw}`).toBeGreaterThan(0);
        for (const key of condition.keys) expect(SETTING_KEYS, `${name} 의 ${condition.raw}`).toContain(key);
      }
      for (const text of allStrings(content)) {
        const opens = text.match(/\[\[if /g)?.length ?? 0;
        const closes = text.match(/\[\[end\]\]/g)?.length ?? 0;
        expect(opens, `${name}: ${text}`).toBe(closes);
        expect(text.match(/\[\[else\]\]/g)?.length ?? 0, `${name}: ${text}`).toBeLessThanOrEqual(opens);
      }
    }
    // 0 이 "없음"을 뜻하는 설정은 문장을 조건문으로 감싸 둔다.
    expect(count).toBeGreaterThan(5);
    const used = new Set(Object.values(ALL_CONTENT).flatMap((content) => collectConditions(content).flatMap((c) => c.keys)));
    for (const key of ["commissionCapPerSeat", "commissionMinPerSeat", "launchPromoMonths", "launchPromoBookings", "cancelGraceMinutes"]) {
      expect(used.has(key), key).toBe(true);
    }
  });

  it("0 이 '없음'을 뜻하는 설정이 0 이어도 틀린 문장이 나가지 않는다", () => {
    for (const [name, content] of Object.entries(ALL_CONTENT)) {
      for (const text of allStrings(resolveDeep(content, ctx(FILLED_OPERATOR, ZERO_SETTINGS)))) {
        expect(text.trim(), `${name}: 빈 문장`).not.toBe("");
        expect(text, name).not.toContain("[[");
        // "0원을 넘지 않습니다", "0분 안에 취소하면", "0개월 동안", "0건까지" 같은 문장
        expect(text, `${name}: ${text}`).not.toMatch(/(^|[^\d,])0(분|개월|건)|(^|[^\d,])0원을 넘지/);
      }
    }
    const sellerTerms = allStrings(resolveDoc(LEGAL_DOCS["seller-terms"], ctx(EMPTY_OPERATOR_INFO, ZERO_SETTINGS))).join("\n");
    expect(sellerTerms).toContain("1인당 중개 수수료 상한은 현재 두지 않습니다");
    expect(sellerTerms).toContain("1인당 최소 중개 수수료는 현재 두지 않습니다");
    expect(sellerTerms).toContain("입점 프로모션 — 현재 새로 입점하는 판매자에게는 운영하지 않습니다");
    expect(sellerTerms).toContain("예약 직후의 무료 취소 시간은 현재 운영하지 않습니다");
    const refund = allStrings(resolveDoc(LEGAL_DOCS["refund-policy"], ctx(EMPTY_OPERATOR_INFO, ZERO_SETTINGS))).join("\n");
    expect(refund).toContain("예약 직후의 무료 취소 시간은 현재 운영하지 않습니다");
    expect(refund).not.toContain("안에 취소하면 환불 기준과 관계없이 전액 환불합니다");
    const faq = resolveDeep(FAQ_GROUPS, ctx(EMPTY_OPERATOR_INFO, ZERO_SETTINGS)).flatMap((group) => group.items);
    expect(faq.find((item) => item.id === "commission")?.a).toContain("1인당 상한은 지금 두지 않아요");
    expect(faq.find((item) => item.id === "launch-promo")?.a).toContain("입점 프로모션을 운영하지 않아요");
    expect(faq.find((item) => item.id === "free-cancel")?.a).toContain("무료 취소 시간을 운영하지 않아요");
    // 답변의 문단이 비지 않는다.
    for (const item of faq) for (const paragraph of splitParagraphs(item.a)) expect(paragraph.length, item.id).toBeGreaterThan(5);
    expect(resolveDeep(GUIDES.sellerOnboarding.footnote, ctx(EMPTY_OPERATOR_INFO, ZERO_SETTINGS))).toBe("자리는 입점이 승인된 뒤에 고객에게 공개돼요.");
  });

  it("무료 취소 시간은 있고 임박 예외만 없는 설정에서는 임박 예외를 말하지 않는다", () => {
    const noLead: PlatformSettings = { ...DEFAULT_SETTINGS, cancelGraceMinLeadMinutes: 0 };
    for (const [name, content] of Object.entries(ALL_CONTENT)) {
      for (const text of allStrings(resolveDeep(content, ctx(FILLED_OPERATOR, noLead)))) {
        expect(text, `${name}: ${text}`).not.toMatch(/(^|[^\d,])0분/);
        expect(text, `${name}: ${text}`).not.toMatch(/임박한? 예약(은|에는) (예외|적용하지|무료 취소 시간을 적용하지)/);
      }
    }
    const terms = allStrings(resolveDoc(LEGAL_DOCS.terms, ctx(EMPTY_OPERATOR_INFO, noLead))).join("\n");
    expect(terms).toContain(`예약한 때부터 ${shown("cancelGraceMinutes", "min")}(현재 기준) 안에 취소하면 전액 환불합니다.`);
    // 기본 설정에서는 임박 예외를 함께 적는다.
    const defaults = allStrings(resolveDoc(LEGAL_DOCS.terms, ctx())).join("\n");
    expect(defaults).toContain(
      `안에 취소하면 전액 환불합니다. 다만 예약할 때 시작까지 ${shown("cancelGraceMinLeadMinutes", "min")}보다 적게 남았던 임박 예약에는 적용하지 않으며`,
    );
  });

  it("요율·금액·시간은 문서에 직접 적지 않고 설정에서 그린다", () => {
    // 기본 설정값이 글자 그대로 박혀 있으면 운영자가 값을 바꿔도 문서가 따라가지 않는다.
    // 기대값은 DEFAULT_SETTINGS 에서 만든다(기본값이 바뀌어도 이 테스트를 고칠 필요가 없게).
    const literals = [
      shown("commissionNewCustomerBps", "percent"),
      shown("proCommissionNewCustomerBps", "percent"),
      shown("pgFeeBps", "percent"),
      shown("commissionCapPerSeat", "krw"),
      shown("commissionMinPerSeat", "krw"),
      shown("proPriceMonthly", "krw"),
    ];
    // 0% 처럼 문장에 흔히 나오는 값은 검사하지 않는다.
    const distinctive = literals.filter((literal) => !/^0(%|원)$/.test(literal));
    expect(distinctive.length).toBeGreaterThanOrEqual(4);
    for (const [name, content] of Object.entries(ALL_CONTENT)) {
      for (const text of allStrings(content)) {
        for (const literal of distinctive) expect(text, `${name}: ${literal}`).not.toContain(literal);
      }
    }

    const sellerTerms = allStrings(resolveDoc(LEGAL_DOCS["seller-terms"], ctx())).join("\n");
    for (const literal of literals) expect(sellerTerms, literal).toContain(literal);
    // 다시 온 고객 요율과 내 예약 링크 요율도 설정값 그대로 나온다.
    expect(sellerTerms).toContain(`다시 온 고객은 ${shown("commissionReturningBps", "percent")}, 내 예약 링크로 온 예약은 ${shown("commissionDirectBps", "percent")}입니다`);

    const changed = {
      ...DEFAULT_SETTINGS,
      holdMinutes: 15,
      cancelGraceMinutes: 45,
      commissionNewCustomerBps: 1250,
      commissionReturningBps: 490,
      commissionMinPerSeat: 2500,
    };
    const terms = allStrings(resolveDoc(LEGAL_DOCS.terms, ctx(EMPTY_OPERATOR_INFO, changed))).join("\n");
    expect(terms).toContain("결제를 시작하면 15분");
    expect(terms).toContain("예약한 때부터 45분");
    const sellerChanged = allStrings(resolveDoc(LEGAL_DOCS["seller-terms"], ctx(EMPTY_OPERATOR_INFO, changed))).join("\n");
    expect(sellerChanged).toContain("12.5%");
    expect(sellerChanged).not.toContain(shown("commissionNewCustomerBps", "percent"));
    expect(sellerChanged).toContain("다시 온 고객은 4.9%");
    expect(sellerChanged).toContain("최소 중개 수수료 2,500원을 적용합니다");
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

  it("조건문: 설정값이 0 보다 크면 앞 문장, 0 이면 뒤 문장을 쓴다", () => {
    const text = "[[if settings.cancelGraceMinutes]]{{settings.cancelGraceMinutes|min}} 안에 무료 취소[[else]]무료 취소 없음[[end]].";
    expect(resolveText(text, ctx())).toBe(`${shown("cancelGraceMinutes", "min")} 안에 무료 취소.`);
    expect(resolveText(text, ctx(EMPTY_OPERATOR_INFO, ZERO_SETTINGS))).toBe("무료 취소 없음.");
    // [[else]] 를 생략하면 0 일 때 그 부분이 사라진다.
    expect(resolveText("공개돼요.[[if settings.launchPromoMonths]] 프로모션 있음.[[end]]", ctx(EMPTY_OPERATOR_INFO, ZERO_SETTINGS))).toBe("공개돼요.");
    expect(resolveText("공개돼요.[[if settings.launchPromoMonths]] 프로모션 있음.[[end]]", ctx())).toBe("공개돼요. 프로모션 있음.");
    // 여러 값을 & 로 이으면 모두 0 보다 클 때만 앞 문장이다.
    const both = "[[if settings.launchPromoMonths & settings.launchPromoBookings]]둘 다[[else]]하나라도 0[[end]]";
    expect(resolveText(both, ctx())).toBe("둘 다");
    expect(resolveText(both, ctx(EMPTY_OPERATOR_INFO, { ...DEFAULT_SETTINGS, launchPromoBookings: 0 }))).toBe("하나라도 0");
    // 한 문장에 조건문을 여러 번 쓸 수 있다(겹쳐 쓰지는 않는다).
    const twice = "[[if settings.commissionMinPerSeat]]최소 있음[[else]]최소 없음[[end]] · [[if settings.commissionCapPerSeat]]상한 있음[[else]]상한 없음[[end]]";
    expect(resolveText(twice, ctx(EMPTY_OPERATOR_INFO, { ...DEFAULT_SETTINGS, commissionMinPerSeat: 0 }))).toBe("최소 없음 · 상한 있음");
    expect(collectConditions(twice).map((c) => c.keys)).toEqual([["commissionMinPerSeat"], ["commissionCapPerSeat"]]);
    // 고르지 않은 쪽 문장의 자리표시자도 찾아낸다(오타 검사에서 빠지지 않게).
    expect(collectPlaceholders(text).map((p2) => p2.raw)).toEqual(["{{settings.cancelGraceMinutes|min}}"]);
  });

  it("조건문의 오타는 개발·테스트에서 예외를 던진다", () => {
    const bad = [
      "[[if settings.nope]]A[[end]]", // 없는 설정 키
      "[[if operator.companyName]]A[[end]]", // 설정이 아닌 값
      "[[if settings.holdMinutes | settings.noShowLimit]]A[[end]]", // 지원하지 않는 연산
      "[[if settings.holdMinutes]]A", // 닫지 않음
      "A[[else]]B[[end]]", // 열지 않음
      "[[if settings.holdMinutes]]A[[if settings.noShowLimit]]B[[end]]C[[end]]", // 겹쳐 씀
    ];
    for (const text of bad) expect(() => resolveText(text, ctx()), text).toThrow(ContentPlaceholderError);
    expect(collectConditions("[[if settings.holdMinutes | settings.noShowLimit]]A[[end]]")[0]?.keys).toEqual([]);

    vi.stubEnv("NODE_ENV", "production");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(resolveText("가격 [[if settings.nope]]A[[end]]", ctx())).toBe("가격 [내용 확인 필요]");
    expect(log).toHaveBeenCalled();
  });

  it("자리표시자가 없는 글과 중괄호 하나짜리 글은 그대로 둔다", () => {
    expect(resolveText("그대로 둡니다 {설정} #{고객명}", ctx())).toBe("그대로 둡니다 {설정} #{고객명}");
    expect(resolveText("[운영자 정보 입력 필요: 상호] [1] [[메모]]", ctx())).toBe("[운영자 정보 입력 필요: 상호] [1] [[메모]]");
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
          expect(block.text.trim(), where).not.toBe("");
          break;
        case "note":
          expect(block.text.trim(), where).not.toBe("");
          if (block.until !== undefined) {
            expect(PROCESSOR_ENABLED_KEYS, where).toContain(block.until);
            expect(block.until, where).not.toBe("always");
          }
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

  it("문서와 동의 고지문은 합니다체로 쓴다(화면 문구를 따옴표로 옮긴 부분 제외)", () => {
    for (const [name, content] of Object.entries(FORMAL_CONTENT)) {
      for (const text of allStrings(content)) {
        const withoutQuotes = text.replace(/'[^']*'/g, "");
        expect(withoutQuotes, `${name}: ${text}`).not.toMatch(/(어요|아요|해요|예요|에요|세요|네요|게요|돼요|드려요)[.!?]?(\s|$)/);
      }
    }
  });

  it("맞춤법: '환불율'이 아니라 '환불률'로 쓴다", () => {
    for (const [name, content] of Object.entries(ALL_CONTENT)) {
      for (const text of allStrings(content)) expect(text, name).not.toContain("환불율");
    }
    expect(allStrings(LEGAL_DOCS["refund-policy"]).join("\n")).toContain("환불률");
  });

  it("같은 기능은 같은 이름으로 부른다: 찜, 고객", () => {
    for (const [name, content] of Object.entries(ALL_CONTENT)) {
      for (const text of allStrings(content)) {
        expect(text, name).not.toContain("관심 목록");
        expect(text, name).not.toContain("손님");
        expect(text, name).not.toContain("수탁자");
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
    expect(text).toContain("마이 화면에서 바로 보이는 '회원 탈퇴'에서 언제든 탈퇴");
    expect(text).toContain("탈퇴 절차는 가입 절차보다 길지 않게");
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
    for (const id of ["default-order", "sort-options", "home", "no-paid-placement", "no-discount-sort", "filters", "quality-score"]) {
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
    // 결제와 환불은 회사가 처리한다 — 환불 책임을 호스트에게 돌리지 않는다(이용약관 '회사의 책임 범위'와 같은 내용).
    expect(INTERMEDIARY_NOTICE).toContain("자리의 내용과 진행은 각 호스트(판매자)가 책임집니다");
    expect(INTERMEDIARY_NOTICE).toContain("결제와 환불은 남는자리가");
    expect(INTERMEDIARY_NOTICE).not.toMatch(/환불[^.]*책임은 각 호스트/);
    expect(allStrings(LEGAL_DOCS.terms).join("\n")).toContain("결제와 환불을 이 약관과 예약 당시의 환불 기준대로 처리합니다");
    // 확정 알림용 짧은 고지
    expect(INTERMEDIARY_NOTICE_SHORT).toContain(SELLER_NAME_TOKEN);
    expect(fillSellerName(INTERMEDIARY_NOTICE_SHORT, "테스트모임")).toBe("남는자리는 통신판매중개자이며, 이 자리는 테스트모임에서 진행합니다.");
    expect(fillSellerName(INTERMEDIARY_NOTICE_SHORT, "  ")).toContain("해당 판매자에서");
    expect(collectPlaceholders(INTERMEDIARY_NOTICE_SHORT)).toEqual([]);

    const disclosed = OPERATOR_DISCLOSURE_ITEMS.flatMap((item) => collectPlaceholders(item.value).map((p) => p.key)).sort();
    expect(disclosed).toEqual([...OPERATOR_FIELDS].sort());
  });
});

// ── 연동 전 안내 ──────────────────────────────────────

describe("문서의 '연동 전' 안내", () => {
  const untilNotes = () =>
    LEGAL_DOC_LIST.flatMap((doc) =>
      doc.sections.flatMap((section) =>
        section.blocks.flatMap((block) => (block.type === "note" && block.until !== undefined ? [{ doc: doc.slug, section: section.id, block }] : [])),
      ),
    );

  it("그 연동이 켜지면 사라진다", () => {
    const notes = untilNotes();
    expect(notes.length).toBeGreaterThanOrEqual(5);
    // 결제·문자·카카오 로그인·본인확인이 연동 전이라는 사실을 숨기지 않는다.
    const keys = new Set(notes.map((item) => item.block.until));
    for (const key of ["payment:toss", "sms:solapi", "kakaoLogin", "identity"] as const) expect(keys.has(key), key).toBe(true);

    for (const { doc, section, block } of notes) {
      const blocks = LEGAL_DOCS[doc as keyof typeof LEGAL_DOCS].sections.find((s) => s.id === section)?.blocks ?? [];
      expect(visibleBlocks(blocks, [])).toEqual(blocks);
      expect(visibleBlocks(blocks, PROCESSOR_ENABLED_KEYS)).not.toContain(block);
      if (block.until) expect(visibleBlocks(blocks, [block.until])).not.toContain(block);
      // 안내를 빼도 섹션이 비지 않는다.
      expect(visibleBlocks(blocks, PROCESSOR_ENABLED_KEYS).length, `${doc}#${section}`).toBeGreaterThan(0);
    }
  });

  it("resolveDoc 에 켜진 연동을 넘기면 그 안내를 뺀 문서를 돌려준다", () => {
    const count = (doc: LegalDoc) => doc.sections.flatMap((section) => section.blocks).filter((block) => block.type === "note" && block.until).length;
    const before = count(resolveDoc(LEGAL_DOCS.privacy, ctx()));
    expect(before).toBe(2);
    expect(count(resolveDoc(LEGAL_DOCS.privacy, ctx(), []))).toBe(2);
    expect(count(resolveDoc(LEGAL_DOCS.privacy, ctx(), ["kakaoLogin"]))).toBe(1);
    expect(count(resolveDoc(LEGAL_DOCS.privacy, ctx(), ["kakaoLogin", "identity"]))).toBe(0);
    expect(count(resolveDoc(LEGAL_DOCS.terms, ctx(), PROCESSOR_ENABLED_KEYS))).toBe(0);
    // 원본 문서는 바뀌지 않는다.
    expect(count(LEGAL_DOCS.privacy)).toBe(2);
  });

  it("연동 상태에 따라 거짓이 될 수 있는 '아직 … 않았습니다' 문장은 조건 없이 두지 않는다", () => {
    // 연동 키가 없는 정산 송금 안내만 예외다(판매자 약관의 검토 사항에 '연동되면 고칠 문구'로 적어 둔다).
    const settlementNote = "판매자 정산의 송금은 아직 연동되지 않았습니다.";
    for (const doc of LEGAL_DOC_LIST) {
      for (const section of doc.sections) {
        for (const block of section.blocks) {
          for (const text of allStrings(block)) {
            if (!/아직[^.]*연동되지 않았습니다/.test(text)) continue;
            expect(text.startsWith(settlementNote), `${doc.slug}#${section.id}: ${text}`).toBe(true);
          }
        }
      }
    }
    expect(LEGAL_DOCS["seller-terms"].reviewNotes.join("\n")).toContain("연동이 끝나면 고쳐야 하는 안내 문구");
  });
});

// ── 동의 고지문 ───────────────────────────────────────

describe("동의 고지문", () => {
  const kinds = Object.keys(POLICY_VERSIONS) as PolicyKind[];

  it("동의 기록의 종류마다 문안이 하나씩 있고 버전이 POLICY_VERSIONS 와 같다", () => {
    expect(Object.keys(CONSENT_NOTICES).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      const notice = CONSENT_NOTICES[kind];
      expect(notice.kind).toBe(kind);
      expect(notice.version).toBe(POLICY_VERSIONS[kind]);
      expect(notice.label.trim()).not.toBe("");
      expect(notice.label.endsWith("."), notice.label).toBe(true);
      expect(notice.details.length, kind).toBeGreaterThan(0);
      for (const row of notice.details) {
        expect(row.label.trim(), kind).not.toBe("");
        expect(row.value.trim(), kind).not.toBe("");
      }
      expect(notice.stages.length, kind).toBeGreaterThan(0);
      expectValidHref(notice.href);
    }
  });

  it("필수와 선택을 나누고, 어떤 항목도 미리 선택해 두지 않는다", () => {
    const required = kinds.filter((kind) => CONSENT_NOTICES[kind].required).sort();
    expect(required).toEqual(["PRIVACY", "REFUND_POLICY", "TERMS", "THIRD_PARTY"]);
    for (const kind of kinds) {
      const notice = CONSENT_NOTICES[kind];
      expect(notice.preChecked, kind).toBe(false);
      // 동의하지 않을 권리와 그때 생기는 제한을 함께 알린다.
      if (notice.required) expect(notice.refusal, kind).toMatch(/동의하지 않을 수 있으며, 이 경우 .+ 수 없습니다\.$/);
      else expect(notice.refusal, kind).toContain("제한이 없으며");
    }
    // 가입 화면: 필수 두 가지가 먼저, 선택 두 가지가 뒤에 온다.
    expect(consentNoticesFor("signup").map((notice) => notice.kind)).toEqual(["TERMS", "PRIVACY", "MARKETING", "NIGHT_ALERT"]);
    expect(consentNoticesFor("booking").map((notice) => notice.kind)).toEqual(["REFUND_POLICY", "THIRD_PARTY"]);
    expect(consentNoticesFor("settings").map((notice) => notice.kind)).toEqual(["MARKETING", "NIGHT_ALERT"]);
    expect(AGE_CONFIRM_LABEL).toBe(`만 ${MIN_SIGNUP_AGE}세 이상입니다.`);
  });

  it("가입 동의의 수집 항목이 처리방침과 같다", () => {
    const items = CONSENT_NOTICES.PRIVACY.details.find((row) => row.label === "항목")?.value ?? "";
    for (const item of ["이메일", "이름", "비밀번호", "휴대전화 번호", "성별", "출생 연도"]) expect(items, item).toContain(item);
    const privacy = allStrings(LEGAL_DOCS.privacy.sections).join("\n");
    for (const item of ["이메일, 이름, 비밀번호", "휴대전화 번호, 성별, 출생 연도"]) expect(privacy).toContain(item);
    expect(CONSENT_NOTICES.PRIVACY.details.map((row) => row.label)).toEqual(["목적", "항목", "보유 기간"]);
  });

  it("판매자 제공 동의의 문구가 처리방침·판매자 약관·도움말과 같다", () => {
    const notice = CONSENT_NOTICES.THIRD_PARTY;
    expect(notice.label).toBe(`개인정보를 ${SELLER_NAME_TOKEN}에 제공하는 데 동의합니다.`);
    expect(fillSellerName(notice.label, "테스트모임")).toBe("개인정보를 테스트모임에 제공하는 데 동의합니다.");
    const detail = (label: string) => notice.details.find((row) => row.label === label)?.value;
    expect(detail("제공 항목")).toBe(`${THIRD_PARTY_PROVISION.items}. ${THIRD_PARTY_PROVISION.itemsNote}`);
    expect(detail("이용 목적")).toBe(THIRD_PARTY_PROVISION.purpose);
    expect(detail("보유·이용 기간")).toBe(THIRD_PARTY_PROVISION.retention);

    // 처리방침의 제3자 제공 표
    const section = LEGAL_DOCS.privacy.sections.find((s) => s.id === "third-party");
    const table = section?.blocks.find((block) => block.type === "table");
    if (!table || table.type !== "table") throw new Error("제3자 제공 표가 없어요");
    expect(table.rows).toEqual([
      [
        THIRD_PARTY_PROVISION.recipient,
        `${THIRD_PARTY_PROVISION.items}. ${THIRD_PARTY_PROVISION.itemsNote}`,
        THIRD_PARTY_PROVISION.purpose,
        THIRD_PARTY_PROVISION.retention,
      ],
    ]);
    // 판매자 약관과 호스트 도움말도 같은 목적을 말한다.
    const seller = allStrings(LEGAL_DOCS["seller-terms"].sections.find((s) => s.id === "customer-data")).join("\n");
    expect(seller).toContain(`받은 정보는 ${THIRD_PARTY_PROVISION.purpose}에만 씁니다.`);
    expect(seller).toContain(THIRD_PARTY_PROVISION.items);
    expect(seller).toContain(THIRD_PARTY_PROVISION.historyItems);
    expect(getFaqItem("customer-data")?.a).toContain(`${THIRD_PARTY_PROVISION.purpose}가 여기에 해당해요.`);
    // 목적에 재방문·노쇼 이력 관리가 들어 있고, 기간에 방문 이력의 항목이 들어 있다.
    expect(THIRD_PARTY_PROVISION.purpose).toContain("재방문 여부 확인과 노쇼 이력 관리");
    expect(THIRD_PARTY_PROVISION.retention).toContain(THIRD_PARTY_PROVISION.historyItems);
    // 판매자가 남기는 메모·태그, 예약 받지 않기, 명단 내려받기를 회원에게 알린다.
    const privacy = allStrings(section).join("\n");
    expect(privacy).toContain("고객별 메모와 태그를 남기거나 특정 고객의 예약을 받지 않도록 설정할 수 있습니다");
    expect(privacy).toContain("파일로 내려받을 수 있습니다");
    expect(allStrings(LEGAL_DOCS.terms.sections).join("\n")).toContain("판매자는 특정 회원의 예약을 받지 않도록 설정할 수 있습니다");
  });
});

// ── 처리방침: 실제와 다른 약속을 하지 않는다 ──────────

describe("개인정보처리방침의 사실 관계", () => {
  const body = () => allStrings({ keyPoints: LEGAL_DOCS.privacy.keyPoints, sections: LEGAL_DOCS.privacy.sections }).join("\n");

  it("결제 정보: 카드 번호 전체는 저장하지 않지만 승인 결과는 보관한다고 적는다", () => {
    expect(body()).toContain("카드 번호 전체는 저장하지 않습니다. 결제 대행사가 돌려준 승인 결과(일부를 가린 카드 번호, 카드사, 승인번호 등)는 결제 기록으로 보관합니다.");
    const everything = allStrings(ALL_CONTENT).join("\n");
    expect(everything).not.toContain("카드 번호는 저장하지 않습니다");
    expect(everything).not.toMatch(/결제 수단 정보[는를][^.]*저장하지 않/);
  });

  it("탈퇴: 지우는 것과 남는 것을 나눠 적고, 준비되지 않은 삭제를 약속하지 않는다", () => {
    const text = body();
    for (const kept of [
      "예약, 결제, 환불 기록",
      "노쇼·늦은 취소 횟수와 이용 제한·정지 기록",
      "서비스 이용 기록(조회, 검색어 등)과 접속·처리 기록",
      "이미 보낸 문자·이메일의 본문",
      "작성한 후기",
    ]) {
      expect(text, kept).toContain(kept);
    }
    expect(text).toContain("카카오 회원 식별값을 지우거나 알아볼 수 없는 값으로 바꿉니다");
    expect(text).toContain("보관 기간이 끝난 기록을 자동으로 지우는 기능은 아직 준비 중입니다");
    expect(text).not.toContain("보관 기간이 끝난 정보는 다시 살릴 수 없는 방법으로 지웁니다");
    // 도움말도 "개인정보는 바로 지워요"라고 뭉뚱그리지 않는다.
    expect(getFaqItem("withdraw")?.a).toContain("예약할 때 남긴 이름과 연락처가 들어 있는 예약·결제 기록은 법령이 정한 기간 동안 보관해요");
    expect(getFaqItem("withdraw")?.a).toContain("탈퇴 전에 마이 > 내가 쓴 후기에서 지워 주세요");
  });

  it("수집 항목: 실제로 저장하는 것을 적고, 없는 것은 적지 않는다", () => {
    const text = body();
    for (const item of ["노쇼 횟수, 늦은 취소 횟수, 예약 제한 기한, 이용 정지 사유", "찜한 상품, 팔로우한 판매자, 빈자리 알림 조건", "문자·이메일 발송 내역", "판매자가 적은 메모와 태그"]) {
      expect(text, item).toContain(item);
    }
    // 후기에는 사진을 올릴 수 없고, 앱 안의 문의 기록은 없다.
    expect(text).not.toContain("올린 사진");
    expect(text).not.toContain("후기, 신고, 문의");
    // 이용 통계를 "누구인지 알아볼 수 없다"고 단정하지 않는다.
    expect(text).not.toContain("누구인지 알아볼 수 없습니다");
    expect(text).toContain("로그인한 뒤에도 남아 있어, 이용 기록에 회원을 구분하는 값과 함께 기록될 수 있습니다");
    // 자동화된 결정과 권리 행사 기한
    expect(text).toContain("노쇼 횟수에 따른 예약 제한은 정해진 기준에 따라 자동으로 적용됩니다");
    expect(text).toContain("요청을 받은 날부터 10일 안에 처리 결과를 알립니다");
  });

  it("문자 발송 대행사는 문자만 보낸다고 적는다(알림톡은 아직 보내지 않는다)", () => {
    const everything = allStrings({ docs: LEGAL_DOC_LIST.map((doc) => doc.sections), PROCESSORS, HELP_CONTENT }).join("\n");
    expect(everything).not.toContain("알림톡");
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

describe("개인정보 처리를 맡긴 회사", () => {
  const names = (list: readonly { name: string }[]) => list.map((p) => p.name);
  const HOSTING = "{{operator.hostingProvider}}";
  const regions = (patch: Partial<ProcessorRegions>): ProcessorRegions => ({ ...EMPTY_PROCESSOR_REGIONS, ...patch });

  it("모든 항목에 켜지는 조건이 있고, 내용이 비어 있지 않다", () => {
    for (const p of PROCESSORS) {
      expect(PROCESSOR_ENABLED_KEYS, p.name).toContain(p.enabledWhen);
      for (const value of [p.name, p.purpose, p.items, p.retention]) expect(value.trim(), p.name).not.toBe("");
      if (p.regionKey !== undefined) expect(PROCESSOR_REGION_KEYS, p.name).toContain(p.regionKey);
      // 처리 국가와 연락처는 코드에 적지 않는다(계약·리전에 따라 달라지므로 운영자 입력값으로 채운다).
      expect(p.country, p.name).toBeUndefined();
      expect(p.contact, p.name).toBeUndefined();
    }
    // 결제·문자·이메일·저장소·카카오 로그인·본인확인은 각각 자기 연동 키로만 켜진다.
    const byKey = (key: ProcessorEnabledKey) => PROCESSORS.filter((p) => p.enabledWhen === key);
    expect(names(byKey("payment:toss"))).toEqual(["토스페이먼츠"]);
    expect(byKey("sms:solapi")).toHaveLength(1);
    expect(byKey("email:resend")).toHaveLength(1);
    expect(byKey("storage:s3")).toHaveLength(1);
    expect(names(byKey("kakaoLogin"))).toEqual(["카카오"]);
    expect(byKey("identity")).toHaveLength(1);
    expect(names(byKey("always"))).toEqual([HOSTING]);
    // 모든 연동 키에 항목이 하나씩 있다(켰는데 처리방침에 아무것도 나타나지 않는 연동이 없게).
    for (const key of PROCESSOR_ENABLED_KEYS) expect(byKey(key).length, key).toBeGreaterThan(0);
    // 처리 국가를 운영자가 입력해야 하는 곳: 호스팅, 이미지 저장소, 이메일 발송
    expect(PROCESSORS.filter((p) => p.regionKey).map((p) => p.regionKey).sort()).toEqual([...PROCESSOR_REGION_KEYS].sort());
    // 실제로 하지 않는 일을 적지 않는다: 알림톡은 아직 보내지 않고, 후기에는 사진을 올릴 수 없다.
    expect(byKey("sms:solapi")[0]?.purpose).toBe("문자 발송");
    expect(byKey("storage:s3")[0]?.purpose).not.toContain("후기");
  });

  it("연동이 켜진 항목만 보여 준다(호스팅은 항상)", () => {
    expect(names(visibleProcessors(PROCESSORS, []))).toEqual([HOSTING]);

    const withToss = visibleProcessors(PROCESSORS, ["payment:toss"]);
    expect(names(withToss)).toEqual([HOSTING, "토스페이먼츠"]);

    const withMessaging = visibleProcessors(PROCESSORS, new Set<ProcessorEnabledKey>(["sms:solapi", "email:resend"]));
    expect(withMessaging).toHaveLength(3);
    expect(names(withMessaging)).not.toContain("토스페이먼츠");

    expect(visibleProcessors(PROCESSORS, PROCESSOR_ENABLED_KEYS)).toEqual([...PROCESSORS]);
    // 카카오 로그인을 켜면 카카오가 표에 나타난다.
    expect(names(visibleProcessors(PROCESSORS, ["kakaoLogin"]))).toEqual([HOSTING, "카카오"]);
    // 원본 순서를 지킨다.
    expect(names(visibleProcessors(PROCESSORS, ["identity", "payment:toss"]))).toEqual(
      names(PROCESSORS.filter((p) => ["always", "payment:toss", "identity"].includes(p.enabledWhen))),
    );
  });

  it("처리 국가는 운영자 입력값으로 채우고, 비어 있으면 입력 필요 표시가 드러난다", () => {
    expect(isDomesticCountry("대한민국")).toBe(true);
    expect(isDomesticCountry(" 한국 ")).toBe(true);
    expect(isDomesticCountry("South Korea")).toBe(true);
    expect(isDomesticCountry("미국")).toBe(false);
    expect(isDomesticCountry("")).toBe(false);
    expect(missingRegionMarker("hosting", "country")).toBe("[운영자 정보 입력 필요: 호스팅 처리 국가]");
    expect(missingRegionMarker("email", "contact")).toBe("[운영자 정보 입력 필요: 이메일 발송 연락처]");

    const hosting = (list: readonly { name: string; country?: string; contact?: string }[]) => list.find((p) => p.name === HOSTING);
    // 아직 입력하지 않음: 국내 처리로 단정하지 않는다.
    const unknown = applyProcessorRegions(PROCESSORS);
    expect(hosting(unknown)?.country).toBe(missingRegionMarker("hosting", "country"));
    expect(hosting(unknown)?.contact).toBe(missingRegionMarker("hosting", "contact"));
    // 국내로 입력: 국외 이전 표에 나오지 않는다.
    const domestic = applyProcessorRegions(PROCESSORS, regions({ hosting: { country: "대한민국", contact: "" } }));
    expect(hosting(domestic)?.country).toBeUndefined();
    expect(hosting(domestic)?.contact).toBeUndefined();
    // 다른 나라로 입력: 그 나라와 연락처가 나온다. 연락처가 비어 있으면 입력 필요 표시.
    const abroad = applyProcessorRegions(PROCESSORS, regions({ hosting: { country: "미국", contact: "privacy@host.example" } }));
    expect(hosting(abroad)).toMatchObject({ country: "미국", contact: "privacy@host.example" });
    const noContact = applyProcessorRegions(PROCESSORS, regions({ hosting: { country: "일본", contact: " " } }));
    expect(hosting(noContact)).toMatchObject({ country: "일본", contact: missingRegionMarker("hosting", "contact") });
    // 운영자 입력 대상이 아닌 항목은 그대로 둔다. 원본도 바꾸지 않는다.
    expect(abroad.find((p) => p.name === "토스페이먼츠")).toBe(PROCESSORS.find((p) => p.name === "토스페이먼츠"));
    expect(PROCESSORS.every((p) => p.country === undefined)).toBe(true);
  });

  it("국외 이전 표: 국외이거나 처리 국가가 확인되지 않은 곳만 — 그 연동이 켜졌을 때만", () => {
    const allDomestic = regions({
      hosting: { country: "대한민국", contact: "" },
      storage: { country: "대한민국", contact: "" },
      email: { country: "대한민국", contact: "" },
    });
    expect(processorsForBlock({ scope: "overseas" }, PROCESSORS, PROCESSOR_ENABLED_KEYS, allDomestic)).toEqual([]);
    // 호스팅의 처리 국가를 입력하지 않았으면 "국외 이전 없음"으로 보이지 않고 입력 필요 표시가 나온다.
    const unknown = processorsForBlock({ scope: "overseas" }, PROCESSORS, []);
    expect(names(unknown)).toEqual([HOSTING]);
    expect(unknown[0]?.country).toContain("운영자 정보 입력 필요");
    // 이메일 발송이 국외 리전이면 그 연동이 켜졌을 때만 나온다.
    const emailAbroad = { ...allDomestic, email: { country: "미국", contact: "privacy@mail.example" } };
    expect(processorsForBlock({ scope: "overseas" }, PROCESSORS, ["payment:toss", "sms:solapi"], emailAbroad)).toEqual([]);
    const overseas = processorsForBlock({ scope: "overseas" }, PROCESSORS, ["email:resend"], emailAbroad);
    expect(overseas).toHaveLength(1);
    expect(overseas[0]).toMatchObject({ name: "Resend", country: "미국", contact: "privacy@mail.example" });
    expect(overseasProcessors(applyProcessorRegions(visibleProcessors(PROCESSORS, ["email:resend"]), emailAbroad))).toEqual(overseas);
  });

  it("문서의 블록에 그릴 목록: 전체 표와 국외 이전 표", () => {
    expect(names(processorsForBlock({}, PROCESSORS, []))).toEqual(names(visibleProcessors(PROCESSORS, [])));
    expect(names(processorsForBlock({ scope: "all" }, PROCESSORS, ["payment:toss"]))).toEqual(names(visibleProcessors(PROCESSORS, ["payment:toss"])));
    // 전체 표에도 처리 국가(또는 입력 필요 표시)가 채워져 나온다.
    expect(processorsForBlock({}, PROCESSORS, [])[0]?.country).toBe(missingRegionMarker("hosting", "country"));
    // 국외 이전 표는 전체 표의 일부다.
    const all = processorsForBlock({ scope: "all" }, PROCESSORS, PROCESSOR_ENABLED_KEYS);
    const overseas = processorsForBlock({ scope: "overseas" }, PROCESSORS, PROCESSOR_ENABLED_KEYS);
    expect(names(overseas)).toEqual(names(all.filter((p) => p.country)));
    expect(names(overseas)).toEqual(names(PROCESSORS.filter((p) => p.regionKey)));
  });

  it("처리 국가와 연락처는 환경 변수에서 읽는다", () => {
    expect(PROCESSOR_REGION_ENV_KEYS.map((item) => item.key)).toEqual([
      "OPERATOR_HOSTING_COUNTRY",
      "OPERATOR_HOSTING_CONTACT",
      "OPERATOR_STORAGE_COUNTRY",
      "OPERATOR_STORAGE_CONTACT",
      "OPERATOR_EMAIL_SENDER_COUNTRY",
      "OPERATOR_EMAIL_SENDER_CONTACT",
    ]);
    for (const item of PROCESSOR_REGION_ENV_KEYS) {
      expect(PROCESSOR_REGION_KEYS).toContain(item.region);
      expect(item.label.trim()).not.toBe("");
      expect(item.help.trim()).not.toBe("");
      vi.stubEnv(item.key, "");
    }
    expect(getProcessorRegions()).toEqual(EMPTY_PROCESSOR_REGIONS);
    vi.stubEnv("OPERATOR_HOSTING_COUNTRY", "  대한민국 ");
    vi.stubEnv("OPERATOR_EMAIL_SENDER_COUNTRY", "미국");
    vi.stubEnv("OPERATOR_EMAIL_SENDER_CONTACT", "privacy@mail.example");
    const read = getProcessorRegions();
    expect(read.hosting).toEqual({ country: "대한민국", contact: "" });
    expect(read.email).toEqual({ country: "미국", contact: "privacy@mail.example" });
    expect(names(processorsForBlock({ scope: "overseas" }, PROCESSORS, ["email:resend"], read))).toEqual(["Resend"]);
  });

  it("켜진 연동은 환경 변수로 판단한다 — 토스페이먼츠는 실결제 키, 문자는 키·발신번호가 모두 있을 때만", () => {
    for (const key of [
      "PAYMENT_PROVIDER",
      "TOSS_CLIENT_KEY",
      "SMS_PROVIDER",
      "SOLAPI_API_KEY",
      "SOLAPI_API_SECRET",
      "SOLAPI_SENDER",
      "RESEND_API_KEY",
      "STORAGE_DRIVER",
      "KAKAO_CLIENT_ID",
    ]) {
      vi.stubEnv(key, "");
    }
    expect(getEnabledProcessorKeys()).toEqual(["always"]);

    vi.stubEnv("PAYMENT_PROVIDER", "mock");
    vi.stubEnv("SMS_PROVIDER", "none");
    vi.stubEnv("STORAGE_DRIVER", "local");
    expect(getEnabledProcessorKeys()).toEqual(["always"]);

    // 테스트 키로는 실제 청구가 없으므로 표에 올리지 않는다.
    vi.stubEnv("PAYMENT_PROVIDER", "toss");
    vi.stubEnv("TOSS_CLIENT_KEY", "test_ck_xxxxxxxx");
    expect(getEnabledProcessorKeys()).toEqual(["always"]);
    vi.stubEnv("TOSS_CLIENT_KEY", "live_ck_xxxxxxxx");
    expect(getEnabledProcessorKeys()).toEqual(["always", "payment:toss"]);

    // 문자 발송을 켰어도 키나 발신번호가 빠져 있으면 한 통도 나가지 않으므로 켜진 것으로 보지 않는다.
    vi.stubEnv("SMS_PROVIDER", "solapi");
    expect(getEnabledProcessorKeys()).not.toContain("sms:solapi");
    vi.stubEnv("SOLAPI_API_KEY", "key");
    vi.stubEnv("SOLAPI_API_SECRET", "secret");
    vi.stubEnv("SOLAPI_SENDER", "---");
    expect(getEnabledProcessorKeys()).not.toContain("sms:solapi");
    vi.stubEnv("SOLAPI_SENDER", "0000-0000");
    expect(getEnabledProcessorKeys()).toContain("sms:solapi");

    vi.stubEnv("RESEND_API_KEY", "re_xxxxxxxx");
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("KAKAO_CLIENT_ID", "kakao-rest-key");
    const all = getEnabledProcessorKeys();
    expect(all).toEqual(["always", "payment:toss", "sms:solapi", "email:resend", "storage:s3", "kakaoLogin"]);
    for (const key of all) expect(PROCESSOR_ENABLED_KEYS).toContain(key);
    // 본인확인은 연동 설정이 생기기 전까지 켜지지 않는다.
    expect(all).not.toContain("identity");
    expect(names(visibleProcessors(PROCESSORS, all))).not.toContain("본인확인 서비스 제공사(계약을 맺은 뒤 상호를 적습니다)");
    expect(names(visibleProcessors(PROCESSORS, all))).toContain("카카오");
    expect(visibleProcessors(PROCESSORS, all)).toHaveLength(PROCESSORS.length - 1);
  });

  it("처리방침은 표를 데이터에서 그리고, 확인되지 않은 것을 단정하지 않는다", () => {
    const blocks = LEGAL_DOCS.privacy.sections.flatMap((section) => section.blocks);
    const processorBlocks = blocks.filter((block) => block.type === "processors");
    expect(processorBlocks).toHaveLength(2);
    expect(processorBlocks.map((block) => (block.type === "processors" ? (block.scope ?? "all") : ""))).toEqual(["all", "overseas"]);
    // 회사 이름을 문서 본문에 직접 적지 않는다(켜지지 않은 연동이 드러나지 않게).
    const body = allStrings(LEGAL_DOCS.privacy.sections).join("\n");
    for (const name of ["토스페이먼츠", "솔라피", "SOLAPI", "Resend"]) expect(body).not.toContain(name);
    // "국외로 이전하는 개인정보가 없다"고 단정하지 않는다.
    expect(body).not.toContain("국외로 이전하는 개인정보도 없습니다");
    expect(body).toContain("표가 비어 있으면 현재 국외에서 처리하는 것으로 확인된 곳이 없다는 뜻입니다");
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
    expect(rendered).toContain(`예약한 때부터 ${shown("cancelGraceMinutes", "min")}(현재 기준) 안에 취소하면`);
    expect(rendered).toContain(`회차 시작까지 ${shown("cancelGraceMinLeadMinutes", "min")}보다 적게 남았던 임박 예약`);
    // 환불이 반영되는 기간은 근거 없는 숫자로 적지 않는다(환불 완료 알림과 다른 숫자가 나가지 않게).
    expect(rendered).toContain("카드사와 결제 수단에 따라 다르며, 며칠 걸릴 수 있습니다");
    for (const doc of LEGAL_DOC_LIST) {
      for (const text of allStrings({ keyPoints: doc.keyPoints, sections: doc.sections })) expect(text, doc.slug).not.toMatch(/영업일 기준 \d+~\d+일/);
    }
    for (const text of allStrings(HELP_CONTENT)) expect(text).not.toMatch(/영업일 기준 \d+~\d+일/);
    expect(getFaqItem("refund-timing")?.a).toContain("며칠 걸릴 수 있어요");
  });

  it("회차가 시작한 뒤에도 구제 경로가 있고, 청약철회 권리를 제한하지 않는다고 밝힌다", () => {
    const remedy = "다만 모임이 열리지 않았거나 안내한 내용과 크게 달랐다면 예약 상세 화면에서 분쟁을 접수할 수 있고, 회사는 사실을 확인해 환불 등 필요한 조치를 합니다.";
    expect(allStrings(LEGAL_DOCS["refund-policy"].sections).join("\n")).toContain(`회차가 시작한 뒤에 회원이 취소하면 환불하지 않습니다. ${remedy}`);
    expect(allStrings(LEGAL_DOCS.terms.sections).join("\n")).toContain(`회차가 시작한 뒤에 회원이 취소하면 환불하지 않습니다. ${remedy}`);
    expect(getFaqItem("refund-amount")?.a).toContain("다만 모임이 열리지 않았거나 안내와 크게 달랐다면 예약 상세 화면에서 분쟁을 접수해 주세요.");
    // 분쟁 사유에 '서비스를 받지 못함', '허위·과장 정보'가 실제로 있다.
    expect(REPORT_REASON_OPTIONS.map((option) => option.key)).toEqual(expect.arrayContaining(["NO_SERVICE", "FALSE_INFO"]));

    const refund = allStrings(LEGAL_DOCS["refund-policy"].sections).join("\n");
    expect(refund).toContain("청약철회 권리를 제한하지 않습니다");
    expect(refund).toContain(`'${NO_REFUND_AT_BOOKING_NOTICE.replace(/\.$/, "")}'를 따로 표시합니다`);
    expect(allStrings(LEGAL_DOCS.terms.sections).join("\n")).toContain("전액 환불과 별도로, 판매자 사정의 취소로 손해가 생겼다면 회원은 판매자에게 배상을 요구할 수 있고");
  });

  it("재판매 연동 환불은 회차가 시작할 때 한 번 판정한다고 적는다(새 예약이 확정되는 순간에 환불하지 않는다)", () => {
    const refund = allStrings(LEGAL_DOCS["refund-policy"]).join("\n");
    expect(refund).toContain("다시 팔렸는지는 회차가 시작하는 때에 한 번만 확인합니다");
    expect(refund).toContain("'환불 예정'");
    expect(refund).toContain("취소한 회원 본인이 같은 회차를 다시 예약한 경우(같은 회원 계정이거나 같은 전화번호)는 다시 팔린 것으로 보지 않습니다");
    expect(refund).toContain("추가 환불은 회차가 시작한 뒤에 자동으로");
    // 이전 설계("새 예약이 확정되면 바로 환불, 그 뒤 취소돼도 되가져가지 않음")의 문장이 남아 있지 않다.
    const everything = allStrings(ALL_CONTENT).join("\n");
    expect(everything).not.toContain("새 예약이 확정되어야 다시 팔린 것으로 봅니다");
    expect(everything).not.toContain("다시 가져가지 않습니다");
    expect(everything).not.toContain("회차 시작 전에 다시 팔리면");
    expect(everything).not.toContain("그 뒤 자리가 다시 팔리면");
    // 약관·판매자 약관·도움말도 같은 규칙을 말한다.
    expect(allStrings(LEGAL_DOCS.terms).join("\n")).toContain("그 자리가 다시 팔린 채로 회차가 시작되면 정해진 비율까지 추가로 환불합니다");
    expect(allStrings(LEGAL_DOCS["seller-terms"]).join("\n")).toContain("취소된 자리가 다시 팔린 채로 회차가 시작되면");
    expect(getFaqItem("resale-refund")?.a).toContain("다시 팔렸는지는 모임이 시작할 때 한 번만 확인해요");
    expect(getFaqItem("resale-refund")?.a).toContain("취소한 본인이 다시 한 예약도 빼고 계산해요");
    expect(GUIDES.vacancyWriting.tips.find((tip) => tip.id === "refund-choice")?.body).toContain("다시 예약된 채로 모임이 시작됐을 때");
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
    expect(resale).toContain(`모임이 시작되면, 시작한 뒤에 ${formatKRW(late?.extraRefund ?? -1)}을 더 돌려받아요`);
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
    // 2년 주기 재확인은 아직 자동화되지 않았다 — 하고 있는 것처럼 적지 않는다.
    expect(marketing).toContain("이 확인을 자동으로 보내는 기능은 아직 없습니다");
    expect(marketing).not.toContain("회사는 2년마다 동의가 유지되고 있는지 다시 확인합니다");
    expect(marketing).toContain("로그인하지 않고도 쓸 수 있는 무료 수신거부 수단");
    expect(getFaqItem("notifications")?.a).toContain("밤 9시부터 아침 8시 사이");
    expect(CONSENT_NOTICES.NIGHT_ALERT.label).toContain("밤 9시부터 다음 날 아침 8시 사이");
    // 자리 제안의 밤 시간(밤 10시)과 광고성 문자의 밤 시간(밤 9시)이 다르다는 점을 알린다.
    expect(allStrings(LEGAL_DOCS.terms).join("\n")).toContain("광고성 문자를 보내지 않는 시간(밤 9시부터 아침 8시)과 다릅니다");
  });

  it("판매자 약관의 금칙 표현 목록이 policy.ts 와 같다", () => {
    // 등록된 표기를 하나도 줄이지 않고 그대로 적는다(검사는 등록된 표기와 글자 그대로 견준다).
    const section = LEGAL_DOCS["seller-terms"].sections.find((s) => s.id === "listing-rules");
    const text = allStrings(section).join("\n");
    expect(text).toContain(`쓸 수 없는 표현(현재 기준): ${BANNED_PHRASES.map((item) => item.phrase).join(", ")}.`);
    // 띄어쓰기만 바꾼 표기가 모두 걸리는 것은 아니므로 그렇게 말하지 않는다.
    expect(findBannedPhrases("커플보장")).toEqual([]);
    expect(text).not.toContain("띄어쓰기를 바꿔 써도 같은 표현으로 봅니다");
  });

  it("판매자 약관의 수수료 표가 설계 문서의 판정 순서와 같다", () => {
    const section = LEGAL_DOCS["seller-terms"].sections.find((s) => s.id === "commission");
    const table = section?.blocks.find((block) => block.type === "table");
    if (!table || table.type !== "table") throw new Error("수수료 표가 없어요");

    // docs/02-architecture.md 6.6 의 표(순서 | `규칙` | …)에서 판정 순서를 읽는다.
    const architecture = readFileSync(resolve(process.cwd(), "docs/02-architecture.md"), "utf8");
    const documented = [...architecture.matchAll(/^\| (\d) \| `([A-Z_]+)` \|/gm)].map((match) => match[2]);
    expect(documented).toEqual(["MANUAL", "DIRECT", "OWN_CUSTOMER", "MARKET_RETURNING", "PROMO", "OVERRIDE", "MARKET_NEW"]);
    expect([...COMMISSION_RULE_ORDER]).toEqual(documented);
    for (const rule of COMMISSION_RULE_ORDER) expect(Object.keys(COMMISSION_RULE_LABEL), rule).toContain(rule);

    expect(table.head).toEqual(["순서", "경우", "중개 수수료"]);
    expect(table.rows.map((row) => row[0])).toEqual(COMMISSION_RULE_ORDER.map((_, index) => String(index + 1)));
    const starts = ["직접 입력", "내 예약 링크", "내 고객", "다시 온 고객", "입점 프로모션", "개별 요율", "남는자리 신규 고객"];
    table.rows.forEach((row, index) => expect(row[1]?.startsWith(`${starts[index]} — `) || row[1]?.includes(`${starts[index]} — `), row[1]).toBe(true));
    // 프로모션보다 먼저 판정하는 규칙은 1~4번이다(다시 온 고객 포함).
    const promoIndex = COMMISSION_RULE_ORDER.indexOf("PROMO");
    expect(table.rows[promoIndex]?.[1]).toContain(`1~${promoIndex}번에 해당하는 예약은 이 건수에 넣지 않습니다`);

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
      "commissionMinPerSeat",
      "commissionMinMaxRatioBps",
    ]) {
      expect(used, key).toContain(key);
    }

    const rendered = resolveDoc(LEGAL_DOCS["seller-terms"], ctx());
    const renderedSection = rendered.sections.find((s) => s.id === "commission");
    const renderedTable = renderedSection?.blocks.find((block) => block.type === "table");
    if (!renderedTable || renderedTable.type !== "table") throw new Error("수수료 표가 없어요");
    const returningRow = renderedTable.rows[COMMISSION_RULE_ORDER.indexOf("MARKET_RETURNING")];
    expect(returningRow?.[2]).toBe(shown("commissionReturningBps", "percent"));
    expect(renderedTable.rows[COMMISSION_RULE_ORDER.indexOf("MARKET_NEW")]?.[2]).toBe(
      `${shown("commissionNewCustomerBps", "percent")} (프로 플랜은 ${shown("proCommissionNewCustomerBps", "percent")})`,
    );
    // 결제 실비는 규칙마다 적지 않고 "중개 요율이 0%이면 차감"이라는 한 가지 원칙으로 적는다.
    const text = allStrings(renderedSection).join("\n");
    expect(text).toContain(`중개 요율이 0%인 예약은 온라인으로 결제한 금액의 ${shown("pgFeeBps", "percent")}를 결제 실비로 차감합니다`);
    expect(text).toContain("중개 요율이 0%보다 크면 요율에 들어 있어 따로 떼지 않습니다");
    expect(text).not.toContain("없음(요율에 포함)");
    // 1인당 최소 수수료와 상한
    expect(text).toContain(
      `1인(좌석 1개)당 최소 중개 수수료 ${shown("commissionMinPerSeat", "krw")}을 적용합니다. 다만 최소 중개 수수료는 좌석 가격의 ${shown("commissionMinMaxRatioBps", "percent")}를 넘지 않습니다`,
    );
    expect(text).toContain("요율이 0%인 예약과, 취소한 뒤 남은 금액에는 최소 중개 수수료를 적용하지 않습니다");
    expect(text).toContain(`1인(좌석 1개)당 ${shown("commissionCapPerSeat", "krw")}을 넘지 않습니다`);
    expect(text).toContain("고객과 판매자 한 쌍에 처음 한 번만");
    // 이전 규칙의 문장이 남아 있지 않다.
    expect(text).not.toContain("재방문 요율과 견주어 낮은 쪽");
  });

  it("정산 송금과 판매자 품질 점수처럼 아직 없는 것을 있는 것처럼 적지 않는다", () => {
    const seller = allStrings(LEGAL_DOCS["seller-terms"]).join("\n");
    expect(seller).toContain("판매자 정산의 송금은 아직 연동되지 않았습니다. 결제 대행사와 연동하기 전에는 실제 대금이 오가지 않으며");
    expect(seller).not.toContain("직접 송금하고");
    expect(getFaqItem("settlement")?.a).toContain("지금은 정산 송금이 연동되지 않았어요");
    expect(getFaqItem("settlement")?.a).not.toContain("직접 보내고");

    const everything = allStrings({ docs: LEGAL_DOC_LIST.map((doc) => ({ keyPoints: doc.keyPoints, sections: doc.sections })), HELP_CONTENT }).join("\n");
    expect(everything).not.toContain("품질 점수에 반영");
    expect(everything).not.toContain("품질 점수를 계산하고");
    const ranking = allStrings(LEGAL_DOCS["ranking-policy"].sections).join("\n");
    expect(ranking).toContain("이 기록을 점수로 만들어 쓰게 되면 계산 항목 전부와 반영 방식을 이 문서에 먼저 적고 알립니다");
    expect(ranking).toContain("후기 평점이 낮다는 이유만으로 제재하지 않습니다");
  });

  it("노출·정렬 기준: 홈 화면의 묶음과 시간대 구분을 적는다", () => {
    expect(LEGAL_DOCS["ranking-policy"].sections.map((section) => section.id)).toContain("home");
    // 시간대 구분의 이름이 목록 검색 조건과 같다(시각은 catalog.ts 의 TIME_BAND_SQL 과 함께 고친다).
    expect(Object.keys(TIME_BAND_HOURS).sort()).toEqual([...TIME_BANDS].sort());
    const ranking = allStrings(LEGAL_DOCS["ranking-policy"].sections).join("\n");
    for (const band of Object.values(TIME_BAND_HOURS)) {
      expect(ranking).toContain(`${band.label}(${band.from}시부터 ${band.to < band.from ? "다음 날 " : ""}${band.to}시 전)`);
    }
    expect(ranking).toContain("'방금 나온 취소·노쇼 자리'");
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
        "{{settings.commissionMinPerSeat|krw}}",
        "{{settings.commissionMinMaxRatioBps|percent}}",
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
    expect(answer("hold")).toContain(`결제를 시작하면 ${shown("holdMinutes", "min")} 동안 자리를 잡아 둬요`);
    expect(answer("free-cancel")).toContain(`예약한 뒤 ${shown("cancelGraceMinutes", "min")} 안에 취소하면`);
    expect(answer("free-cancel")).toContain(`시작까지 ${shown("cancelGraceMinLeadMinutes", "min")}보다 적게 남았던 임박 예약`);
    expect(answer("waitlist-offer")).toContain(`${shown("waitlistOfferMinutes", "min")} 동안 자리를 잡아 둬요`);
    expect(answer("waitlist-offer")).toContain(`${shown("waitlistOfferMinMinutes", "min")}보다 짧아지지는 않아요`);
    expect(answer("waitlist-offer")).toContain(`시작까지 ${shown("waitlistBroadcastWithinMinutes", "min")} 이내로 남았으면`);
    expect(answer("no-show")).toContain(
      `최근 ${shown("noShowWindowDays", "days")} 동안 노쇼가 ${shown("noShowLimit")}회에 이르면 ${shown("noShowRestrictDays", "days")} 동안 새 예약이 제한돼요`,
    );
    expect(answer("no-show")).toContain(`${NO_SHOW_DISPUTE_HOURS}시간 안에`);
    expect(answer("no-show")).toContain(`${HELP_FACTS.noShowRevertHours}시간 안에는`);
    expect(answer("reviews")).toContain(`${shown("reviewWindowDays", "days")} 안에`);
    expect(answer("reviews")).toContain(`${REVIEW_NEW_THRESHOLD}개보다 적으면 평점 대신 '신규'`);
    // 수수료: 신규 한 번만, 다시 온 고객 요율, 요율 0% 예약의 결제 실비, 1인당 최소액과 상한
    expect(answer("commission")).toContain(
      `${shown("commissionNewCustomerBps", "percent")}예요(프로 플랜은 ${shown("proCommissionNewCustomerBps", "percent")})`,
    );
    expect(answer("commission")).toContain(`남는자리로 다시 예약하면 ${shown("commissionReturningBps", "percent")}예요`);
    expect(answer("commission")).toContain(`내 예약 링크로 들어온 예약은 ${shown("commissionDirectBps", "percent")}예요`);
    expect(answer("commission")).toContain(`중개 요율이 0%인 예약에 온라인 결제가 있으면 결제 실비(${shown("pgFeeBps", "percent")})를 차감해요`);
    expect(answer("commission")).toContain(`1인당 최소 ${shown("commissionMinPerSeat", "krw")}을 받아요`);
    expect(answer("commission")).toContain(`1인당 ${shown("commissionCapPerSeat", "krw")}을 넘지 않아요`);
    expect(answer("commission")).toContain("처음 한 번만");
    // 이전 규칙의 문장이 남아 있지 않다.
    expect(answer("commission")).not.toContain("중개 수수료가 없는 경우는 세 가지예요");
    expect(answer("launch-promo")).toContain("다시 온 고객의 예약은 프로모션보다 먼저 판정해요");
    expect(answer("launch-promo")).not.toContain("원래 중개 수수료가 없어서");
    expect(answer("direct-link")).toContain(`${HELP_FACTS.directLinkDays}일 안에`);
    expect(answer("direct-link")).toContain("예약 링크 코드가 붙은 주소나 QR로 들어온 방문은 언제나 해당해요");
    expect(answer("pro-plan")).toContain(`월 ${shown("proPriceMonthly", "krw")}(부가세 포함)`);
    expect(answer("pro-plan")).toContain(`${PLAN_FEATURES.PRO.maxTeamMembers}명까지(베이직 ${PLAN_FEATURES.FREE.maxTeamMembers}명)`);
    expect(answer("pro-plan")).toContain(`${PLAN_FEATURES.PRO.maxActiveProducts}개까지(베이직 ${PLAN_FEATURES.FREE.maxActiveProducts}개)`);
    expect(answer("pro-plan")).toContain(`${shown("proMonthlyMessages")}건까지(베이직 ${shown("freeMonthlyMessages")}건)`);
    expect(answer("notifications")).toContain(`하루에 ${VACANCY_DAILY_LIMIT}건까지만`);
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
    // 다른 참가자를 신고하는 방법과, 심사가 안전까지 보증하는 것은 아니라는 점을 알린다.
    expect(text).toContain("다른 참가자의 행동을 신고할 때는 함께 참여한 회차의 예약 상세 화면에서 접수하고");
    expect(SAFETY_PAGE.platformMeasures.join("\n")).toContain("모임의 내용과 현장 안전까지 남는자리가 보증하는 것은 아니에요");
    expect(SAFETY_PAGE.platformMeasures.join("\n")).toContain("호스트의 사업장 주소는 법에 따라 항상 공개돼요");
    expect(POST_EVENT_CHECK.title.trim()).not.toBe("");
    expect(POST_EVENT_CHECK.body).toContain("불편한 일은 없었나요?");
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
