import "server-only";
import { z } from "zod";
import type { MessageStatus, Prisma } from "@/generated/prisma/client";
import { safeNextPath } from "@/lib/cookies";
import { env } from "@/lib/env";
import { fmtDateTimeNumeric } from "@/lib/time";
import { audit } from "@/server/audit";
import { prisma } from "@/server/db";
import { err } from "@/server/errors";
import { sha256 } from "@/server/security/crypto";
import { enqueueMessageDetailed } from "./outbox";

/**
 * 알림의 단일 진입점.
 * - 앱 내 알림(Notification)은 항상 기록한다.
 * - 문자·이메일은 회원의 수신 설정을 확인한 뒤 발송 대기열(MessageOutbox)에 넣는다.
 * - notify() 는 호출부의 트랜잭션이 끝난 뒤 불리므로 어떤 경우에도 예외를 던지지 않는다.
 */

export const NOTIFICATION_TYPES = [
  "BOOKING_CONFIRMED",
  "BOOKING_PENDING_APPROVAL",
  "BOOKING_APPROVED",
  "BOOKING_REJECTED",
  "BOOKING_CANCELLED",
  "BOOKING_EXPIRED",
  "BOOKING_REMINDER",
  "REVIEW_REQUEST",
  "REFUND_DONE",
  "WAITLIST_OFFER",
  "WAITLIST_EXPIRED",
  "VACANCY_ALERT",
  "SELLER_NEW_BOOKING",
  "SELLER_BOOKING_CANCELLED",
  "SELLER_APPROVAL_NEEDED",
  "SELLER_SEAT_RELEASED",
  "SELLER_REVIEW",
  "SELLER_BUSINESS_APPROVED",
  "SELLER_BUSINESS_REJECTED",
  "SELLER_SETTLEMENT",
  "SYSTEM",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const TITLE_MAX = 80;
const BODY_MAX = 500;

// ── 수신 설정 ─────────────────────────────────────────

export interface NotificationPrefs {
  /** 예약 확정·리마인드·자리 제안 등 예약 관련 문자 */
  bookingSms: boolean;
  /** 빈자리 알림(앱) */
  vacancyInApp: boolean;
  /** 빈자리 알림(문자) — 광고성 정보 수신 동의가 있어야 한다 */
  vacancySms: boolean;
  /** 이용 후 후기 요청 문자 */
  reviewRequest: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  bookingSms: true,
  vacancyInApp: true,
  vacancySms: false,
  reviewRequest: true,
};

const PREF_KEYS = Object.keys(DEFAULT_NOTIFICATION_PREFS) as (keyof NotificationPrefs)[];

/** 저장된 JSON 에 기본값을 합친다. 형식이 틀린 값은 무시한다. */
export function getNotificationPrefs(user: { notificationPrefs?: unknown } | null | undefined): NotificationPrefs {
  const prefs = { ...DEFAULT_NOTIFICATION_PREFS };
  const raw = user?.notificationPrefs;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const saved = raw as Record<string, unknown>;
    for (const key of PREF_KEYS) {
      if (typeof saved[key] === "boolean") prefs[key] = saved[key];
    }
  }
  return prefs;
}

const prefsPatchSchema = z
  .object({
    bookingSms: z.boolean(),
    vacancyInApp: z.boolean(),
    vacancySms: z.boolean(),
    reviewRequest: z.boolean(),
  })
  .partial()
  .strict();

/** 수신 설정 일부를 바꾼다. 다른 항목은 그대로 두며, 동시에 들어온 변경끼리 덮어쓰지 않도록 DB 에서 병합한다. */
export async function updateNotificationPrefs(userId: string, patch: unknown): Promise<NotificationPrefs> {
  const parsed = prefsPatchSchema.parse(patch);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true, notificationPrefs: true, marketingConsentAt: true },
  });
  if (!user || user.status === "WITHDRAWN") throw err.notFound("회원 정보를 찾을 수 없어요.");
  if (parsed.vacancySms === true && !user.marketingConsentAt) {
    throw err.validation("빈자리 문자 알림을 받으려면 광고성 정보 수신에 먼저 동의해 주세요.", {
      vacancySms: "광고성 정보 수신 동의가 필요해요.",
    });
  }
  if (Object.keys(parsed).length === 0) return getNotificationPrefs(user);

  const rows = await prisma.$queryRaw<{ notificationPrefs: unknown }[]>`
    UPDATE "User"
    SET "notificationPrefs" = COALESCE("notificationPrefs", '{}'::jsonb) || ${JSON.stringify(parsed)}::jsonb,
        "updatedAt" = ${new Date()}::timestamp
    WHERE "id" = ${userId}
    RETURNING "notificationPrefs"`;
  return getNotificationPrefs(rows[0]);
}

export interface NotificationSettings {
  prefs: NotificationPrefs;
  marketingConsentAt: Date | null;
  nightAlertConsentAt: Date | null;
  /** 문자를 받을 휴대전화 번호가 등록돼 있는지 */
  hasPhone: boolean;
}

/** 마이 > 알림 설정 화면용 */
export async function getNotificationSettings(userId: string): Promise<NotificationSettings> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true, phone: true, notificationPrefs: true, marketingConsentAt: true, nightAlertConsentAt: true },
  });
  if (!user || user.status === "WITHDRAWN") throw err.notFound("회원 정보를 찾을 수 없어요.");
  return {
    prefs: getNotificationPrefs(user),
    marketingConsentAt: user.marketingConsentAt,
    nightAlertConsentAt: user.nightAlertConsentAt,
    hasPhone: Boolean(user.phone),
  };
}

const consentSchema = z
  .object({ marketing: z.boolean(), night: z.boolean() })
  .partial()
  .strict()
  .refine((v) => v.marketing !== undefined || v.night !== undefined, "바꿀 항목을 골라 주세요.");

const CONSENT_WITHDRAWN_ERROR = "수신 동의를 철회했어요";

/**
 * 광고성 정보 수신 동의·철회(문자의 "무료수신거부" 가 가리키는 기능).
 * - 철회하면 야간 수신 동의와 빈자리 문자 설정도 함께 꺼지고, 대기 중인 광고성 메시지는 보내지 않는다.
 * - 처리 결과는 앱 내 알림으로 알려 주고(정보통신망법 제50조 제7항) 감사 로그에 남긴다.
 */
export async function updateMarketingConsent(userId: string, input: unknown): Promise<NotificationSettings> {
  const parsed = consentSchema.parse(input);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true, marketingConsentAt: true, nightAlertConsentAt: true },
  });
  if (!user || user.status === "WITHDRAWN") throw err.notFound("회원 정보를 찾을 수 없어요.");

  const now = new Date();
  const marketingOn = parsed.marketing ?? Boolean(user.marketingConsentAt);
  if (parsed.night === true && !marketingOn) {
    throw err.validation("야간 알림을 받으려면 광고성 정보 수신에 먼저 동의해 주세요.", {
      night: "광고성 정보 수신 동의가 필요해요.",
    });
  }
  const nightOn = marketingOn && (parsed.night ?? Boolean(user.nightAlertConsentAt));
  const marketingChanged = marketingOn !== Boolean(user.marketingConsentAt);
  const nightChanged = nightOn !== Boolean(user.nightAlertConsentAt);

  if (marketingChanged || nightChanged) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        marketingConsentAt: marketingOn ? (user.marketingConsentAt ?? now) : null,
        nightAlertConsentAt: nightOn ? (user.nightAlertConsentAt ?? now) : null,
      },
    });
  }

  if (marketingChanged && !marketingOn) {
    await updateNotificationPrefs(userId, { vacancySms: false });
    await prisma.messageOutbox.updateMany({
      where: { userId, isAdvertising: true, status: "QUEUED" },
      data: { status: "SKIPPED", error: CONSENT_WITHDRAWN_ERROR },
    });
  }

  if (marketingChanged || nightChanged) {
    await audit({
      actorId: userId,
      actorType: "CUSTOMER",
      action: "user.marketing_consent",
      targetType: "User",
      targetId: userId,
      meta: { marketing: marketingOn, night: nightOn },
    });
    const title = marketingChanged
      ? marketingOn
        ? "광고성 정보 수신에 동의했어요"
        : "광고성 정보 수신 동의를 철회했어요"
      : nightOn
        ? "야간 알림 수신에 동의했어요"
        : "야간 알림 수신 동의를 철회했어요";
    await notify({
      userId,
      type: "SYSTEM",
      title,
      body: [
        `광고성 정보 ${marketingOn ? "수신 동의" : "수신 거부"} · 야간(21~08시) ${nightOn ? "수신 동의" : "수신 거부"}`,
        `남는자리 · 처리 일시 ${fmtDateTimeNumeric(now)}`,
        "마이 > 알림 설정에서 언제든 바꿀 수 있어요.",
      ].join("\n"),
    });
  }

  return getNotificationSettings(userId);
}

/**
 * 이 종류의 알림을 외부 채널(문자·이메일)로 보내도 되는지.
 * essential 은 사업장·운영 사정 취소처럼 반드시 전달해야 하는 안내에만 쓴다(수신 설정과 무관하게 발송).
 */
export function isExternalAllowed(prefs: NotificationPrefs, type: NotificationType, options: { essential?: boolean } = {}): boolean {
  if (options.essential) return true;
  if (type === "VACANCY_ALERT") return prefs.vacancySms;
  if (type === "REVIEW_REQUEST") return prefs.reviewRequest;
  if (type.startsWith("BOOKING_") || type.startsWith("WAITLIST_") || type === "REFUND_DONE") return prefs.bookingSms;
  return true;
}

// ── 알림 보내기 ───────────────────────────────────────

export interface InAppNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** 같은 사이트 안의 경로만 허용한다(예: /my/bookings/NJ-7K3M9Q). */
  linkUrl?: string | null;
  data?: Prisma.InputJsonObject;
  /** 같은 키로는 앱 내 알림을 한 번만 만든다(재시도·중복 호출 대비). */
  dedupeKey?: string;
}

export interface ExternalMessageInput {
  channel: "SMS" | "EMAIL";
  templateKey: string;
  /** 외부 채널 본문. 없으면 제목·본문·링크로 만든다. */
  text?: string;
  /** 이메일 제목(없으면 알림 제목) */
  subject?: string;
  /** 광고성 정보 여부 — true 면 수신 동의·(광고) 표기·야간 제한이 적용된다. */
  isAdvertising?: boolean;
  dedupeKey?: string;
  businessId?: string;
  /** 수신처를 직접 지정(예: 예약 시 입력한 연락처). 없으면 회원의 휴대전화/이메일 */
  recipient?: string;
  /** 수신 설정과 무관하게 보내야 하는 필수 안내 */
  essential?: boolean;
}

export interface NotifyInput extends InAppNotificationInput {
  external?: ExternalMessageInput;
}

export interface NotifyResult {
  /** 이번에 만들었거나 이미 있던 앱 내 알림 ID. 기록에 실패하면 null */
  notificationId: string | null;
  /** 앱 내 알림을 이번 호출에서 새로 만들었는지 */
  created: boolean;
  /** 외부 발송 대기열에 들어간 메시지(보내지 않았으면 null) */
  message: { id: string; status: MessageStatus; created: boolean } | null;
}

const dedupeId = (key: string) => `n_${sha256(key).slice(0, 30)}`;

function toRow(input: InAppNotificationInput): Prisma.NotificationCreateManyInput {
  const link = input.linkUrl ? safeNextPath(input.linkUrl, "") : "";
  return {
    ...(input.dedupeKey ? { id: dedupeId(input.dedupeKey) } : {}),
    userId: input.userId,
    type: input.type,
    title: input.title.trim().slice(0, TITLE_MAX),
    body: input.body.trim().slice(0, BODY_MAX),
    linkUrl: link || null,
    data: input.data,
  };
}

/**
 * 앱 내 알림 여러 건을 한 번에 기록한다(외부 발송 없음). 새로 만들어진 행만 돌려준다.
 * notify() 와 달리 DB 오류를 그대로 던진다 — 호출부가 직접 처리한다.
 */
export async function notifyMany(inputs: InAppNotificationInput[]): Promise<{ id: string; userId: string }[]> {
  const created: { id: string; userId: string }[] = [];
  for (let i = 0; i < inputs.length; i += 500) {
    const rows = await prisma.notification.createManyAndReturn({
      data: inputs.slice(i, i + 500).map(toRow),
      skipDuplicates: true,
      select: { id: true, userId: true },
    });
    created.push(...rows);
  }
  return created;
}

function defaultExternalText(input: NotifyInput): string {
  const base = env().APP_URL.replace(/\/+$/, "");
  const link = input.linkUrl ? safeNextPath(input.linkUrl, "") : "";
  return [`[남는자리] ${input.title.trim()}`, input.body.trim(), link ? `${base}${link}` : ""].filter(Boolean).join("\n");
}

/**
 * 알림을 보낸다. 앱 내 알림은 항상 기록하고, external 이 있으면 수신 설정을 확인한 뒤 발송 대기열에 넣는다.
 * 전달 과정의 어떤 문제도 예외로 던지지 않는다(로그만 남김).
 */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const result: NotifyResult = { notificationId: null, created: false, message: null };

  try {
    const row = toRow(input);
    if (row.id) {
      const createdRows = await prisma.notification.createMany({ data: [row], skipDuplicates: true });
      result.notificationId = row.id;
      result.created = createdRows.count > 0;
    } else {
      const createdRow = await prisma.notification.create({ data: row, select: { id: true } });
      result.notificationId = createdRow.id;
      result.created = true;
    }
  } catch (e) {
    console.error(`[notify] 앱 내 알림 기록 실패 type=${input.type}`, e);
  }

  const ext = input.external;
  if (!ext) return result;
  // 이미 전달한 알림의 중복 호출이면, 자체 중복 방지 키가 없는 외부 메시지는 다시 보내지 않는다.
  if (input.dedupeKey && result.notificationId && !result.created && !ext.dedupeKey) return result;

  try {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { phone: true, email: true, status: true, notificationPrefs: true },
    });
    if (!user || user.status === "WITHDRAWN") return result;
    if (!isExternalAllowed(getNotificationPrefs(user), input.type, { essential: ext.essential })) return result;
    const recipient = ext.recipient ?? (ext.channel === "EMAIL" ? user.email : user.phone);
    if (!recipient) return result;

    const queued = await enqueueMessageDetailed({
      userId: input.userId,
      businessId: ext.businessId,
      channel: ext.channel,
      recipient,
      templateKey: ext.templateKey,
      subject: ext.subject ?? (ext.channel === "EMAIL" ? input.title.trim().slice(0, 120) : undefined),
      body: ext.text ?? defaultExternalText(input),
      isAdvertising: ext.isAdvertising,
      dedupeKey: ext.dedupeKey,
    });
    if (queued.row) result.message = { id: queued.row.id, status: queued.row.status, created: queued.created };
  } catch (e) {
    console.error(`[notify] 외부 발송 등록 실패 type=${input.type}`, e);
  }
  return result;
}

// ── 알림함 ────────────────────────────────────────────

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  linkUrl: string | null;
  data: Prisma.JsonValue | null;
  readAt: Date | null;
  createdAt: Date;
}

const listSchema = z.object({
  cursor: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  unreadOnly: z.boolean().default(false),
});

/** 내 알림 목록(최신순). nextCursor 를 다음 호출의 cursor 로 넘기면 이어서 볼 수 있다. */
export async function listNotifications(
  userId: string,
  options: { cursor?: string; limit?: number; unreadOnly?: boolean } = {},
): Promise<{ items: NotificationItem[]; nextCursor: string | null }> {
  const o = listSchema.parse(options);
  // 커서가 남의 알림이면 무시한다(목록 자체는 항상 본인 것만 나온다).
  const cursor = o.cursor
    ? await prisma.notification.findFirst({ where: { id: o.cursor, userId }, select: { id: true } })
    : null;
  const rows = await prisma.notification.findMany({
    where: { userId, ...(o.unreadOnly ? { readAt: null } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: o.limit + 1,
    ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
    select: { id: true, type: true, title: true, body: true, linkUrl: true, data: true, readAt: true, createdAt: true },
  });
  const items = rows.slice(0, o.limit);
  return { items, nextCursor: rows.length > o.limit ? (items[items.length - 1]?.id ?? null) : null };
}

export async function countUnread(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

const idsSchema = z.union([z.literal("all"), z.array(z.string().min(1).max(64)).min(1).max(100)]);

/** 읽음 처리. 본인 알림만 바뀌며, 바뀐 건수를 돌려준다. */
export async function markNotificationsRead(userId: string, ids: string[] | "all"): Promise<number> {
  const target = idsSchema.parse(ids);
  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null, ...(target === "all" ? {} : { id: { in: target } }) },
    data: { readAt: new Date() },
  });
  return result.count;
}
