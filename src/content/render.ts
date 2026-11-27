/**
 * 콘텐츠 문구의 자리표시자를 실제 값으로 바꾼다. 순수 함수만 있다(서버 전용 모듈을 가져오지 않는다).
 *
 *   {{operator.companyName}}                  운영자 정보. 값이 비어 있으면 눈에 보이는 표시로 바뀐다
 *   {{settings.commissionNewCustomerBps|percent}}   운영 설정값 + 표시 형식
 *   [[if settings.cancelGraceMinutes]]A[[else]]B[[end]]   설정값이 0 보다 크면 A, 0 이면 B([[else]] 는 생략할 수 있다)
 *   [[if settings.launchPromoMonths & settings.launchPromoBookings]]…[[end]]   여러 값이 모두 0 보다 클 때
 *
 * 표시 형식
 *   percent  bps → "9.9%"            krw    원 → "10,000원"
 *   min      분 → "30분", "3시간"     hours  시간 → "12시간"
 *   days     일 → "14일"             none   단위 없이 숫자만 → "2,000" (형식을 생략해도 같다)
 *
 * 조건문은 0 이 "없음"을 뜻하는 설정(1인당 상한·최소 수수료, 입점 프로모션, 무료 취소 시간)에 쓴다.
 * "0원을 넘지 않습니다", "0분 안에 취소하면" 같은 틀린 문장이 나가지 않게 하기 위해서다. 겹쳐 쓸 수는 없다.
 */
import { formatKRW, formatNumber } from "@/lib/money";
import {
  PROCESSOR_REGION_KEYS,
  type LegalBlock,
  type LegalDoc,
  type Processor,
  type ProcessorEnabledKey,
  type ProcessorRegionKey,
} from "./legal/types";

// ── 운영자 정보 ───────────────────────────────────────

export const OPERATOR_FIELDS = [
  "companyName",
  "representative",
  "businessRegNo",
  "mailOrderRegNo",
  "address",
  "phone",
  "email",
  "privacyOfficer",
  "hostingProvider",
] as const;

export type OperatorField = (typeof OPERATOR_FIELDS)[number];

/** 운영자(회사) 정보. 아직 정해지지 않은 값은 빈 문자열이다 */
export type OperatorInfo = Record<OperatorField, string>;

export const OPERATOR_FIELD_LABELS: Record<OperatorField, string> = {
  companyName: "상호",
  representative: "대표자",
  businessRegNo: "사업자등록번호",
  mailOrderRegNo: "통신판매업 신고번호",
  address: "사업장 주소",
  phone: "고객센터 전화번호",
  email: "고객센터 이메일",
  privacyOfficer: "개인정보 보호책임자",
  hostingProvider: "호스팅 서비스 제공자",
};

export const EMPTY_OPERATOR_INFO: OperatorInfo = {
  companyName: "",
  representative: "",
  businessRegNo: "",
  mailOrderRegNo: "",
  address: "",
  phone: "",
  email: "",
  privacyOfficer: "",
  hostingProvider: "",
};

/** 빠진 값을 문서에 그대로 드러내는 표시. 숨기지 않는다 — 빈칸으로 두면 빠진 줄 모르고 공개하게 된다 */
const missingMarker = (label: string): string => `[운영자 정보 입력 필요: ${label}]`;

/** 운영자 정보가 비어 있을 때 문서에 그대로 드러나는 표시 */
export function missingOperatorMarker(field: OperatorField): string {
  return missingMarker(OPERATOR_FIELD_LABELS[field]);
}

const isOperatorField = (key: string): key is OperatorField => (OPERATOR_FIELDS as readonly string[]).includes(key);

// ── 표시 형식 ─────────────────────────────────────────

export const FORMATTERS = ["percent", "krw", "min", "hours", "days", "none"] as const;
export type Formatter = (typeof FORMATTERS)[number];

const isFormatter = (name: string): name is Formatter => (FORMATTERS as readonly string[]).includes(name);

/** 990 → "9.9%", 374 → "3.74%", 0 → "0%" (소수 둘째 자리까지, 끝의 0 은 뗀다) */
function formatPercent(bps: number): string {
  const text = (bps / 100).toFixed(2).replace(/\.?0+$/, "");
  return `${text}%`;
}

/** 30 → "30분", 180 → "3시간", 90 → "1시간 30분" */
function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${formatNumber(minutes)}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${formatNumber(hours)}시간` : `${formatNumber(hours)}시간 ${rest}분`;
}

export function formatSettingValue(value: number, formatter: Formatter = "none"): string {
  switch (formatter) {
    case "percent":
      return formatPercent(value);
    case "krw":
      return formatKRW(value);
    case "min":
      return formatMinutes(value);
    case "hours":
      return `${formatNumber(value)}시간`;
    case "days":
      return `${formatNumber(value)}일`;
    case "none":
      return formatNumber(value);
  }
}

// ── 자리표시자 ────────────────────────────────────────

export interface Placeholder {
  /** 문서에 적힌 그대로 — 예: "{{settings.holdMinutes|min}}" */
  raw: string;
  /** unknown 은 형식이 틀린 자리표시자다(오타) */
  scope: "operator" | "settings" | "unknown";
  key: string;
  formatter?: string;
}

const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;
const PLACEHOLDER_BODY = /^(operator|settings)\.([A-Za-z][A-Za-z0-9]*)(?:\|([A-Za-z]+))?$/;

function parsePlaceholder(raw: string, body: string): Placeholder {
  const match = PLACEHOLDER_BODY.exec(body.trim());
  if (!match) return { raw, scope: "unknown", key: body.trim() };
  const [, scope, key, formatter] = match;
  return {
    raw,
    scope: scope === "operator" ? "operator" : "settings",
    key: key ?? "",
    ...(formatter ? { formatter } : {}),
  };
}

export interface RenderContext {
  operator: OperatorInfo;
  /** 운영 설정값(getSettings() 결과를 그대로 넘긴다) */
  settings: Record<string, number>;
}

export class ContentPlaceholderError extends Error {
  constructor(
    readonly placeholder: string,
    reason: string,
  ) {
    super(`콘텐츠 자리표시자 오류 ${placeholder}: ${reason}`);
    this.name = "ContentPlaceholderError";
  }
}

/** 개발·테스트에서는 오타를 바로 드러내고, 운영에서는 화면이 깨지지 않도록 눈에 띄는 표시로 바꾼다 */
function unresolved(raw: string, reason: string): string {
  if (process.env.NODE_ENV !== "production") throw new ContentPlaceholderError(raw, reason);
  console.error(`[content] 자리표시자를 바꾸지 못했어요 ${raw}: ${reason}`);
  return "[내용 확인 필요]";
}

// ── 조건문 ────────────────────────────────────────────

export interface ConditionUse {
  /** 문서에 적힌 조건 머리 — 예: "[[if settings.cancelGraceMinutes]]" */
  raw: string;
  /** 조건에 쓴 설정 키. 형식이 틀렸으면 빈 배열 */
  keys: string[];
}

const CONDITION_PATTERN = /\[\[if ([^[\]]*)\]\]([\s\S]*?)(?:\[\[else\]\]([\s\S]*?))?\[\[end\]\]/g;
const CONDITION_HEAD = /\[\[if ([^[\]]*)\]\]/g;
const CONDITION_KEY = /^settings\.([A-Za-z][A-Za-z0-9]*)$/;
/** 짝이 맞지 않아 남은 조건 표시 */
const CONDITION_LEFTOVER = /\[\[(?:if [^[\]]*|else|end)\]\]/;

function parseConditionKeys(body: string): string[] {
  const keys: string[] = [];
  for (const part of body.split("&")) {
    const match = CONDITION_KEY.exec(part.trim());
    if (!match?.[1]) return [];
    keys.push(match[1]);
  }
  return keys;
}

/** 조건문을 풀어 설정값에 맞는 쪽 문장만 남긴다 */
function resolveConditions(text: string, ctx: RenderContext): string {
  if (!text.includes("[[")) return text;
  const resolved = text.replace(CONDITION_PATTERN, (_raw: string, body: string, whenPositive: string, whenZero: string | undefined) => {
    const head = `[[if ${body}]]`;
    const keys = parseConditionKeys(body);
    if (keys.length === 0) return unresolved(head, "조건 형식이 맞지 않아요");
    for (const key of keys) {
      if (!Object.hasOwn(ctx.settings, key)) return unresolved(head, "없는 설정 키예요");
      const value = ctx.settings[key];
      if (typeof value !== "number" || !Number.isFinite(value)) return unresolved(head, "설정값이 숫자가 아니에요");
    }
    return keys.every((key) => (ctx.settings[key] ?? 0) > 0) ? whenPositive : (whenZero ?? "");
  });
  const leftover = CONDITION_LEFTOVER.exec(resolved);
  return leftover ? resolved.replace(CONDITION_LEFTOVER, unresolved(leftover[0], "조건문의 짝이 맞지 않아요")) : resolved;
}

/**
 * 문구 안의 조건문과 자리표시자를 값으로 바꾼다.
 * - 모르는 자리표시자·설정 키·표시 형식은 개발·테스트에서 예외를 던진다(오타 방지).
 * - 운영자 정보가 비어 있으면 "[운영자 정보 입력 필요: 상호]" 같은 표시로 바뀐다.
 */
export function resolveText(text: string, ctx: RenderContext): string {
  return resolveConditions(text, ctx).replace(PLACEHOLDER_PATTERN, (raw: string, body: string) => {
    const p = parsePlaceholder(raw, body);
    if (p.scope === "unknown") return unresolved(raw, "형식이 맞지 않아요");

    if (p.scope === "operator") {
      if (!isOperatorField(p.key)) return unresolved(raw, "없는 운영자 정보 항목이에요");
      if (p.formatter) return unresolved(raw, "운영자 정보에는 표시 형식을 붙일 수 없어요");
      const value = (ctx.operator[p.key] ?? "").trim();
      return value || missingOperatorMarker(p.key);
    }

    if (!Object.hasOwn(ctx.settings, p.key)) return unresolved(raw, "없는 설정 키예요");
    const value = ctx.settings[p.key];
    if (typeof value !== "number" || !Number.isFinite(value)) return unresolved(raw, "설정값이 숫자가 아니에요");
    if (p.formatter !== undefined && !isFormatter(p.formatter)) return unresolved(raw, "없는 표시 형식이에요");
    return formatSettingValue(value, p.formatter);
  });
}

function walkStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const item of value) walkStrings(item, visit);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) walkStrings(item, visit);
}

/**
 * 문서(또는 처리를 맡긴 회사 목록·도움말 등 임의의 콘텐츠 데이터) 안에 든 자리표시자를 모두 찾는다. 같은 표기는 한 번만 돌려준다.
 * 조건문 안쪽(양쪽 문장 모두)의 자리표시자도 함께 찾는다.
 * 테스트에서 "모든 자리표시자가 실제 설정 키·운영자 항목을 가리키는지" 확인하는 데 쓴다.
 */
export function collectPlaceholders(doc: unknown): Placeholder[] {
  const found = new Map<string, Placeholder>();
  walkStrings(doc, (text) => {
    for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
      const raw = match[0];
      if (!found.has(raw)) found.set(raw, parsePlaceholder(raw, match[1] ?? ""));
    }
  });
  return [...found.values()];
}

/** 콘텐츠 데이터 안에 든 조건문의 머리를 모두 찾는다(같은 표기는 한 번만). 테스트에서 설정 키를 확인하는 데 쓴다 */
export function collectConditions(doc: unknown): ConditionUse[] {
  const found = new Map<string, ConditionUse>();
  walkStrings(doc, (text) => {
    for (const match of text.matchAll(CONDITION_HEAD)) {
      const raw = match[0];
      if (!found.has(raw)) found.set(raw, { raw, keys: parseConditionKeys(match[1] ?? "") });
    }
  });
  return [...found.values()];
}

/** 콘텐츠 데이터 안의 모든 문자열에 resolveText 를 적용한 사본을 돌려준다(원본은 바꾸지 않는다) */
export function resolveDeep<T>(value: T, ctx: RenderContext): T {
  if (typeof value === "string") return resolveText(value, ctx) as T;
  if (Array.isArray(value)) return value.map((item) => resolveDeep(item, ctx)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDeep(v, ctx)])) as T;
  }
  return value;
}

/**
 * "연동 전" 안내(until 이 있는 note)를 그 연동이 켜졌으면 뺀다.
 * enabledKeys 에는 지금 켜져 있는 연동의 키를 넘긴다(src/content/operator.ts 의 getEnabledProcessorKeys).
 */
export function visibleBlocks(blocks: readonly LegalBlock[], enabledKeys: Iterable<ProcessorEnabledKey>): LegalBlock[] {
  const enabled = new Set<ProcessorEnabledKey>(enabledKeys);
  return blocks.filter((block) => !(block.type === "note" && block.until !== undefined && enabled.has(block.until)));
}

/**
 * 문서 전체를 화면에 바로 그릴 수 있게 바꾼다.
 * enabledKeys 를 넘기면 이미 켜진 연동의 "연동 전" 안내를 함께 뺀다. 넘기지 않으면 모든 안내를 그대로 둔다.
 */
export function resolveDoc(doc: LegalDoc, ctx: RenderContext, enabledKeys?: Iterable<ProcessorEnabledKey>): LegalDoc {
  const resolved = resolveDeep(doc, ctx);
  if (enabledKeys === undefined) return resolved;
  const enabled = [...enabledKeys];
  return { ...resolved, sections: resolved.sections.map((section) => ({ ...section, blocks: visibleBlocks(section.blocks, enabled) })) };
}

// ── 개인정보 처리를 맡긴 회사의 표 ────────────────────

/**
 * 실제로 켜진 연동의 항목만 고른다. "always" 는 항상 포함한다.
 * enabledKeys 에는 지금 켜져 있는 연동의 키를 넘긴다(예: ["payment:toss", "sms:solapi"]).
 */
export function visibleProcessors(processors: readonly Processor[], enabledKeys: Iterable<ProcessorEnabledKey>): Processor[] {
  const enabled = new Set<ProcessorEnabledKey>(enabledKeys);
  enabled.add("always");
  return processors.filter((p) => enabled.has(p.enabledWhen));
}

/** 운영자가 입력하는 처리 국가와 그 회사의 연락처. 아직 모르면 빈 문자열 */
export interface ProcessorRegion {
  /** 개인정보를 처리하는 서버가 있는 나라 — 국내면 "대한민국" */
  country: string;
  /** 국외에서 처리하는 경우 그 회사의 연락처(개인정보 문의 창구) */
  contact: string;
}

export type ProcessorRegions = Record<ProcessorRegionKey, ProcessorRegion>;

export const EMPTY_PROCESSOR_REGIONS: ProcessorRegions = {
  hosting: { country: "", contact: "" },
  storage: { country: "", contact: "" },
  email: { country: "", contact: "" },
};

export const PROCESSOR_REGION_LABELS: Record<ProcessorRegionKey, string> = {
  hosting: "호스팅",
  storage: "이미지 저장소",
  email: "이메일 발송",
};

/** 처리 국가·연락처를 아직 입력하지 않았을 때 표에 그대로 드러나는 표시 */
export function missingRegionMarker(key: ProcessorRegionKey, field: keyof ProcessorRegion): string {
  return missingMarker(`${PROCESSOR_REGION_LABELS[key]} ${field === "country" ? "처리 국가" : "연락처"}`);
}

const DOMESTIC_COUNTRY_NAMES = new Set(["대한민국", "한국", "국내", "kr", "korea", "southkorea", "republicofkorea"]);

/** 운영자가 입력한 처리 국가가 국내인지 */
export function isDomesticCountry(country: string): boolean {
  return DOMESTIC_COUNTRY_NAMES.has(country.replace(/\s+/g, "").toLowerCase());
}

const isRegionKey = (key: string | undefined): key is ProcessorRegionKey =>
  key !== undefined && (PROCESSOR_REGION_KEYS as readonly string[]).includes(key);

/**
 * regionKey 가 있는 항목의 처리 국가와 연락처를 운영자 입력값으로 채운다.
 * - 국내("대한민국")로 입력했으면 국내 처리로 둔다(country 없음).
 * - 다른 나라면 그 나라와 연락처를 넣는다. 연락처가 비어 있으면 입력 필요 표시를 넣는다.
 * - 아직 입력하지 않았으면 처리 국가 자리에 입력 필요 표시를 넣는다 — 확인되지 않은 곳을 국내 처리로 단정하지 않는다.
 */
export function applyProcessorRegions(processors: readonly Processor[], regions: ProcessorRegions = EMPTY_PROCESSOR_REGIONS): Processor[] {
  return processors.map((p) => {
    if (!isRegionKey(p.regionKey)) return p;
    const region = regions[p.regionKey];
    const country = region.country.trim();
    const contact = region.contact.trim();
    const { country: _country, contact: _contact, ...rest } = p;
    if (country !== "" && isDomesticCountry(country)) return rest;
    return {
      ...rest,
      country: country || missingRegionMarker(p.regionKey, "country"),
      contact: contact || missingRegionMarker(p.regionKey, "contact"),
    };
  });
}

/** 국외에서 처리하는 곳만(처리방침의 국외 이전 표). applyProcessorRegions 를 거친 목록을 넘긴다 */
export function overseasProcessors(processors: readonly Processor[]): Processor[] {
  return processors.filter((p) => typeof p.country === "string" && p.country.trim() !== "");
}

/**
 * 문서의 { type: "processors" } 블록에 그릴 목록.
 * 켜진 연동의 항목만 고르고, 운영자가 입력한 처리 국가·연락처를 채운 뒤,
 * scope 가 "overseas" 면 그 가운데 국외에서 처리하는 곳(처리 국가를 아직 입력하지 않은 곳 포함)만 남긴다.
 * 빈 배열이면 화면은 "해당 없음"으로 표시한다. regions 는 src/content/operator.ts 의 getProcessorRegions 값이다.
 */
export function processorsForBlock(
  block: { scope?: "all" | "overseas" },
  processors: readonly Processor[],
  enabledKeys: Iterable<ProcessorEnabledKey>,
  regions: ProcessorRegions = EMPTY_PROCESSOR_REGIONS,
): Processor[] {
  const visible = applyProcessorRegions(visibleProcessors(processors, enabledKeys), regions);
  return block.scope === "overseas" ? overseasProcessors(visible) : visible;
}
