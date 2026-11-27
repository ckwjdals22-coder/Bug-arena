/**
 * 콘텐츠 문구의 자리표시자를 실제 값으로 바꾼다. 순수 함수만 있다(서버 전용 모듈을 가져오지 않는다).
 *
 *   {{operator.companyName}}                  운영자 정보. 값이 비어 있으면 눈에 보이는 표시로 바뀐다
 *   {{settings.commissionNewCustomerBps|percent}}   운영 설정값 + 표시 형식
 *
 * 표시 형식
 *   percent  bps → "9.9%"            krw    원 → "10,000원"
 *   min      분 → "30분", "3시간"     hours  시간 → "12시간"
 *   days     일 → "14일"             none   단위 없이 숫자만 → "2,000" (형식을 생략해도 같다)
 */
import { formatKRW, formatNumber } from "@/lib/money";
import type { LegalDoc, Processor, ProcessorEnabledKey } from "./legal/types";

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

/** 운영자 정보가 비어 있을 때 문서에 그대로 드러나는 표시. 숨기지 않는다 — 빈칸으로 두면 빠진 줄 모르고 공개하게 된다 */
export function missingOperatorMarker(field: OperatorField): string {
  return `[운영자 정보 입력 필요: ${OPERATOR_FIELD_LABELS[field]}]`;
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

/**
 * 문구 안의 자리표시자를 값으로 바꾼다.
 * - 모르는 자리표시자·설정 키·표시 형식은 개발·테스트에서 예외를 던진다(오타 방지).
 * - 운영자 정보가 비어 있으면 "[운영자 정보 입력 필요: 상호]" 같은 표시로 바뀐다.
 */
export function resolveText(text: string, ctx: RenderContext): string {
  return text.replace(PLACEHOLDER_PATTERN, (raw: string, body: string) => {
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
 * 문서(또는 수탁자 목록·도움말 등 임의의 콘텐츠 데이터) 안에 든 자리표시자를 모두 찾는다. 같은 표기는 한 번만 돌려준다.
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

/** 콘텐츠 데이터 안의 모든 문자열에 resolveText 를 적용한 사본을 돌려준다(원본은 바꾸지 않는다) */
export function resolveDeep<T>(value: T, ctx: RenderContext): T {
  if (typeof value === "string") return resolveText(value, ctx) as T;
  if (Array.isArray(value)) return value.map((item) => resolveDeep(item, ctx)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDeep(v, ctx)])) as T;
  }
  return value;
}

/** 문서 전체를 화면에 바로 그릴 수 있게 바꾼다 */
export function resolveDoc(doc: LegalDoc, ctx: RenderContext): LegalDoc {
  return resolveDeep(doc, ctx);
}

// ── 수탁자 표 ─────────────────────────────────────────

/**
 * 실제로 켜진 연동의 수탁자만 고른다. "always" 는 항상 포함한다.
 * enabledKeys 에는 지금 켜져 있는 연동의 키를 넘긴다(예: ["payment:toss", "sms:solapi"]).
 */
export function visibleProcessors(processors: readonly Processor[], enabledKeys: Iterable<ProcessorEnabledKey>): Processor[] {
  const enabled = new Set<ProcessorEnabledKey>(enabledKeys);
  enabled.add("always");
  return processors.filter((p) => enabled.has(p.enabledWhen));
}

/** 국외에서 처리하는 수탁자만(처리방침의 국외 이전 표) */
export function overseasProcessors(processors: readonly Processor[]): Processor[] {
  return processors.filter((p) => typeof p.country === "string" && p.country.trim() !== "");
}

/**
 * 문서의 { type: "processors" } 블록에 그릴 수탁자 목록.
 * 켜진 연동의 수탁자만 고르고, scope 가 "overseas" 면 그 가운데 국외에서 처리하는 곳만 남긴다.
 * 빈 배열이면 화면은 "해당 없음"으로 표시한다.
 */
export function processorsForBlock(
  block: { scope?: "all" | "overseas" },
  processors: readonly Processor[],
  enabledKeys: Iterable<ProcessorEnabledKey>,
): Processor[] {
  const visible = visibleProcessors(processors, enabledKeys);
  return block.scope === "overseas" ? overseasProcessors(visible) : visible;
}
