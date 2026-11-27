import "server-only";
import { z } from "zod";
import { BOOKING_SAFETY_TIPS } from "@/content/help/safety";
import type { MessageChannel } from "@/generated/prisma/client";
import { env } from "@/lib/env";
import { fmtDateTime } from "@/lib/time";
import { audit } from "@/server/audit";
import { assertBusinessAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { err } from "@/server/errors";
import { PLAN_FEATURES } from "@/server/settings";

/**
 * 사업자 자동 문자 템플릿.
 * - 저장된 행이 없으면 기본 문구를 쓴다.
 * - 문구·발송 시점 변경은 프로 플랜 기능이다. 베이직으로 내려가면 저장해 둔 문구는 남기되 기본 문구로 발송한다.
 * - 이 키로 나가는 문자는 사업자의 월 발송 한도에 포함된다(outbox.ts).
 */

export const SELLER_TEMPLATE_KEYS = [
  "BOOKING_CONFIRMED",
  "REMINDER_DAY_BEFORE",
  "REMINDER_HOURS_BEFORE",
  "REVIEW_REQUEST",
  "BOOKING_CANCELLED_BY_SELLER",
] as const;
export type SellerTemplateKey = (typeof SELLER_TEMPLATE_KEYS)[number];

export function isSellerTemplateKey(key: string): key is SellerTemplateKey {
  return (SELLER_TEMPLATE_KEYS as readonly string[]).includes(key);
}

export const TEMPLATE_BODY_MAX = 500;

// ── 변수 ──────────────────────────────────────────────

export const TEMPLATE_VARIABLES = [
  { name: "고객명", token: "#{고객명}", description: "예약자 이름", example: "김하늘" },
  { name: "상호", token: "#{상호}", description: "사업장 이름", example: "둔산 소셜클럽" },
  { name: "상품명", token: "#{상품명}", description: "예약한 상품 이름", example: "금요 와인 소셜" },
  { name: "일시", token: "#{일시}", description: "회차 시작 일시", example: "11월 27일 (금) 19:30" },
  { name: "장소", token: "#{장소}", description: "진행 장소", example: "대전 서구 둔산로 123, 2층" },
  { name: "인원", token: "#{인원}", description: "예약 인원", example: "2명" },
  { name: "예약번호", token: "#{예약번호}", description: "예약번호", example: "NJ-7K3M9Q" },
  { name: "링크", token: "#{링크}", description: "예약 확인 주소", example: "https://namneunjari.kr/my/bookings/NJ-7K3M9Q" },
] as const;

export type TemplateVariableName = (typeof TEMPLATE_VARIABLES)[number]["name"];
export type TemplateVars = Partial<Record<TemplateVariableName, string>>;

/** 설정 화면 미리보기에 쓰는 예시 값 */
export const TEMPLATE_SAMPLE_VARS: TemplateVars = Object.fromEntries(TEMPLATE_VARIABLES.map((v) => [v.name, v.example]));

const VARIABLE_PATTERN = /#\{([^{}\n]{1,20})\}/g;
const KNOWN_VARIABLES = new Set<string>(TEMPLATE_VARIABLES.map((v) => v.name));

/**
 * `#{변수}` 를 값으로 바꾼다. 모르는 변수와 값이 없는 변수는 빈칸이 된다.
 * 한 번만 치환하므로 값 안에 `#{...}` 가 들어 있어도 다시 해석하지 않는다.
 */
export function renderTemplate(body: string, vars: TemplateVars): string {
  const values = vars as Record<string, string | undefined>;
  return body
    .replace(VARIABLE_PATTERN, (_, name: string) => (KNOWN_VARIABLES.has(name.trim()) ? (values[name.trim()] ?? "") : ""))
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** 문구에 들어 있는 변수 가운데 지원하지 않는 것 */
export function findUnknownVariables(body: string): string[] {
  const unknown = new Set<string>();
  for (const match of body.matchAll(VARIABLE_PATTERN)) {
    const name = (match[1] ?? "").trim();
    if (!KNOWN_VARIABLES.has(name)) unknown.add(`#{${name}}`);
  }
  return [...unknown];
}

// ── 기본 템플릿 ───────────────────────────────────────

export interface TemplateKeyInfo {
  key: SellerTemplateKey;
  label: string;
  description: string;
  /** 리마인드류만: 시작 몇 분 전에 보낼지 고를 수 있는 범위 */
  offset: { min: number; max: number } | null;
}

export const TEMPLATE_KEYS: readonly TemplateKeyInfo[] = [
  {
    key: "BOOKING_CONFIRMED",
    label: "예약 확정 안내",
    description: "예약이 확정되면 바로 보내요. 꺼 두면 남는자리 기본 안내만 나가요.",
    offset: null,
  },
  {
    key: "REMINDER_DAY_BEFORE",
    label: "전날 리마인드",
    description: "시작 하루 전에 일정을 다시 알려 노쇼를 줄여요.",
    offset: { min: 720, max: 10080 },
  },
  {
    key: "REMINDER_HOURS_BEFORE",
    label: "당일 리마인드",
    description: "시작 몇 시간 전에 한 번 더 알려요. 임박해서 예약한 고객에게 특히 좋아요.",
    offset: { min: 30, max: 720 },
  },
  {
    key: "REVIEW_REQUEST",
    label: "후기 요청",
    description: "이용이 끝난 고객에게 후기를 부탁해요. 앱 알림은 켜지 않아도 나가요.",
    offset: null,
  },
  {
    key: "BOOKING_CANCELLED_BY_SELLER",
    label: "사업장 사정 취소 안내",
    description: "사업장 사정으로 예약을 취소할 때 보내요. 꺼 두면 남는자리 기본 안내가 나가요.",
    offset: null,
  },
];

export interface DefaultTemplate {
  channel: MessageChannel;
  body: string;
  isEnabled: boolean;
  offsetMinutes: number | null;
}

export const DEFAULT_TEMPLATES: Record<SellerTemplateKey, DefaultTemplate> = {
  BOOKING_CONFIRMED: {
    channel: "SMS",
    isEnabled: true,
    offsetMinutes: null,
    body: [
      "[#{상호}] #{고객명}님, 예약이 확정됐어요.",
      "",
      "#{상품명}",
      "일시: #{일시}",
      "장소: #{장소}",
      "인원: #{인원}",
      "예약번호: #{예약번호}",
      "",
      // 오프라인 모임 안전 수칙 한 줄(도움말의 문구를 그대로 쓴다)
      ...(BOOKING_SAFETY_TIPS[0] ? [BOOKING_SAFETY_TIPS[0]] : []),
      "예약 확인·취소: #{링크}",
    ].join("\n"),
  },
  REMINDER_DAY_BEFORE: {
    channel: "SMS",
    isEnabled: true,
    offsetMinutes: 1440,
    body: [
      "[#{상호}] #{고객명}님, 예약하신 날이 다가왔어요.",
      "",
      "#{상품명}",
      "일시: #{일시}",
      "장소: #{장소}",
      "",
      "못 오시게 되면 미리 취소해 주세요. 다른 분이 자리를 이어받을 수 있어요.",
      "참석 확정·취소: #{링크}",
    ].join("\n"),
  },
  REMINDER_HOURS_BEFORE: {
    channel: "SMS",
    isEnabled: true,
    offsetMinutes: 180,
    body: [
      "[#{상호}] #{고객명}님, 곧 만나요.",
      "#{상품명} · #{일시}",
      "장소: #{장소}",
      "",
      "못 오시게 되면 미리 취소해 주세요. 다른 분이 자리를 이어받을 수 있어요.",
      "참석 확정·취소: #{링크}",
    ].join("\n"),
  },
  REVIEW_REQUEST: {
    channel: "SMS",
    // 문자 후기 요청은 한도를 쓰므로 사업자가 직접 켠다(앱 내 요청은 항상 나간다).
    isEnabled: false,
    offsetMinutes: null,
    body: [
      "[#{상호}] #{고객명}님, #{상품명} 어떠셨어요?",
      "짧은 후기를 남겨 주시면 다음 손님께 큰 도움이 돼요.",
      "#{링크}",
    ].join("\n"),
  },
  BOOKING_CANCELLED_BY_SELLER: {
    channel: "SMS",
    isEnabled: true,
    offsetMinutes: null,
    body: [
      "[#{상호}] #{고객명}님, 죄송해요. 사업장 사정으로 아래 예약을 취소하게 됐어요.",
      "",
      "#{상품명}",
      "일시: #{일시}",
      "예약번호: #{예약번호}",
      "",
      "미리 결제하신 금액은 전액 환불돼요.",
      "#{링크}",
    ].join("\n"),
  },
};

// ── 조회 ──────────────────────────────────────────────

export interface BusinessTemplate {
  key: SellerTemplateKey;
  label: string;
  description: string;
  channel: MessageChannel;
  /** 실제 발송에 쓰이는 문구(베이직이면 기본 문구) */
  body: string;
  defaultBody: string;
  isEnabled: boolean;
  /** 리마인드류: 시작 N분 전 발송. 그 밖에는 null */
  offsetMinutes: number | null;
  offsetRange: { min: number; max: number } | null;
  /** 기본과 다른 문구가 지금 적용되고 있는지 */
  isCustomized: boolean;
  /** 현재 플랜에서 문구·발송 시점을 바꿀 수 있는지 */
  canCustomize: boolean;
  updatedAt: Date | null;
}

const normalizeBody = (body: string) => body.replace(/\r\n?/g, "\n").trim();

function keyInfo(key: SellerTemplateKey): TemplateKeyInfo {
  const info = TEMPLATE_KEYS.find((t) => t.key === key);
  if (!info) throw new Error(`알 수 없는 템플릿 키: ${key}`);
  return info;
}

interface SavedTemplate {
  key: string;
  body: string;
  isEnabled: boolean;
  offsetMinutes: number | null;
  updatedAt: Date;
}

function mergeTemplate(key: SellerTemplateKey, saved: SavedTemplate | undefined, canCustomize: boolean): BusinessTemplate {
  const info = keyInfo(key);
  const base = DEFAULT_TEMPLATES[key];
  const body = canCustomize && saved ? saved.body : base.body;
  const offsetMinutes = info.offset ? (canCustomize && saved?.offsetMinutes ? saved.offsetMinutes : base.offsetMinutes) : null;
  return {
    key,
    label: info.label,
    description: info.description,
    channel: base.channel,
    body,
    defaultBody: base.body,
    isEnabled: saved ? saved.isEnabled : base.isEnabled,
    offsetMinutes,
    offsetRange: info.offset,
    isCustomized: body !== base.body,
    canCustomize,
    updatedAt: saved?.updatedAt ?? null,
  };
}

async function loadPlan(businessId: string) {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { plan: true } });
  if (!business) throw err.notFound("사업장을 찾을 수 없어요.");
  return business.plan;
}

/** 사업장의 템플릿 전체(기본값 + 저장된 설정). 화면에 보이는 순서대로 돌려준다. */
export async function getBusinessTemplates(businessId: string): Promise<BusinessTemplate[]> {
  const [plan, saved] = await Promise.all([
    loadPlan(businessId),
    prisma.messageTemplate.findMany({ where: { businessId, key: { in: [...SELLER_TEMPLATE_KEYS] } } }),
  ]);
  const canCustomize = PLAN_FEATURES[plan].customMessageTemplates;
  const byKey = new Map(saved.map((t) => [t.key, t]));
  return SELLER_TEMPLATE_KEYS.map((key) => mergeTemplate(key, byKey.get(key), canCustomize));
}

export async function getBusinessTemplate(businessId: string, key: SellerTemplateKey): Promise<BusinessTemplate> {
  const [plan, saved] = await Promise.all([
    loadPlan(businessId),
    prisma.messageTemplate.findUnique({ where: { businessId_key: { businessId, key } } }),
  ]);
  return mergeTemplate(key, saved ?? undefined, PLAN_FEATURES[plan].customMessageTemplates);
}

// ── 저장 ──────────────────────────────────────────────

const saveSchema = z.object({
  body: z
    .string()
    .transform(normalizeBody)
    .pipe(z.string().min(1, "문구를 입력해 주세요.").max(TEMPLATE_BODY_MAX, `문구는 ${TEMPLATE_BODY_MAX}자까지 쓸 수 있어요.`)),
  isEnabled: z.boolean(),
  offsetMinutes: z.number().int().min(1).max(43200).nullish(),
});

export interface SaveTemplateInput {
  body: string;
  isEnabled: boolean;
  offsetMinutes?: number | null;
}

/**
 * 템플릿 저장. 매니저 이상만 가능하다.
 * 베이직 플랜에서는 발송 여부(isEnabled)만 바꿀 수 있고, 문구·발송 시점을 바꾸려 하면 거절한다.
 */
export async function saveBusinessTemplate(
  actorUserId: string,
  businessId: string,
  key: string,
  input: SaveTemplateInput,
): Promise<BusinessTemplate> {
  await assertBusinessAccess(actorUserId, businessId, "MANAGER");
  if (!isSellerTemplateKey(key)) throw err.validation("지원하지 않는 메시지 종류예요.");
  const parsed = saveSchema.parse(input);
  const info = keyInfo(key);
  const base = DEFAULT_TEMPLATES[key];

  const plan = await loadPlan(businessId);
  const canCustomize = PLAN_FEATURES[plan].customMessageTemplates;
  const existing = await prisma.messageTemplate.findUnique({ where: { businessId_key: { businessId, key } } });

  let body = existing?.body ?? base.body;
  let offsetMinutes = info.offset ? (existing?.offsetMinutes ?? base.offsetMinutes) : null;

  if (canCustomize) {
    const unknown = findUnknownVariables(parsed.body);
    if (unknown.length > 0) {
      throw err.validation(`쓸 수 없는 변수가 있어요: ${unknown.slice(0, 5).join(", ")}`, { body: "변수 이름을 확인해 주세요." });
    }
    body = parsed.body;
    if (info.offset && parsed.offsetMinutes != null) {
      if (parsed.offsetMinutes < info.offset.min || parsed.offsetMinutes > info.offset.max) {
        throw err.validation("발송 시점을 다시 골라 주세요.", { offsetMinutes: "고를 수 있는 범위를 벗어났어요." });
      }
      offsetMinutes = parsed.offsetMinutes;
    }
  } else {
    const bodyChanged = parsed.body !== normalizeBody(base.body);
    const offsetChanged = info.offset !== null && parsed.offsetMinutes != null && parsed.offsetMinutes !== base.offsetMinutes;
    if (bodyChanged || offsetChanged) {
      throw err.forbidden("문구와 발송 시점은 프로 플랜에서 바꿀 수 있어요. 베이직에서는 발송 여부만 바꿀 수 있어요.");
    }
  }

  const saved = await prisma.messageTemplate.upsert({
    where: { businessId_key: { businessId, key } },
    create: { businessId, key, channel: base.channel, body, isEnabled: parsed.isEnabled, offsetMinutes },
    update: { body, isEnabled: parsed.isEnabled, offsetMinutes },
  });

  await audit({
    actorId: actorUserId,
    actorType: "SELLER",
    action: "message_template.update",
    targetType: "Business",
    targetId: businessId,
    meta: { key, isEnabled: saved.isEnabled, offsetMinutes: saved.offsetMinutes, bodyChanged: (existing?.body ?? base.body) !== body },
  });

  return mergeTemplate(key, saved, canCustomize);
}

// ── 예약 → 변수 ───────────────────────────────────────

/** 변수 값을 만드는 데 필요한 예약 정보(관계 포함). 이 모양을 만족하는 조회 결과면 무엇이든 넣을 수 있다. */
export interface BookingTemplateSource {
  code: string;
  userId: string | null;
  guestName: string;
  quantity: number;
  business: { name: string; slug: string; address: string | null };
  product: { title: string; placeName: string | null; address: string | null };
  slot: { startAt: Date };
}

/** 문자에 넣을 절대 주소. 회원 예약은 예약 상세, 비회원(직접 입력) 예약은 사업장 페이지로 보낸다. */
export function bookingPublicUrl(booking: Pick<BookingTemplateSource, "code" | "userId" | "business">): string {
  const base = env().APP_URL.replace(/\/+$/, "");
  return booking.userId ? `${base}/my/bookings/${booking.code}` : `${base}/b/${booking.business.slug}`;
}

export function buildBookingTemplateVars(booking: BookingTemplateSource): Record<TemplateVariableName, string> {
  const place = [booking.product.placeName, booking.product.address ?? booking.business.address].filter(Boolean).join(" · ");
  return {
    고객명: booking.guestName,
    상호: booking.business.name,
    상품명: booking.product.title,
    일시: fmtDateTime(booking.slot.startAt),
    장소: place,
    인원: `${booking.quantity}명`,
    예약번호: booking.code,
    링크: bookingPublicUrl(booking),
  };
}
