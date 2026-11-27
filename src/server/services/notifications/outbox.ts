import "server-only";
import { z } from "zod";
import { Prisma, type MessageChannel, type MessageOutbox, type MessageStatus } from "@/generated/prisma/client";
import { env } from "@/lib/env";
import { maskEmail, maskPhone, normalizePhone } from "@/lib/format";
import { MINUTE, addDays, isNightKst, kstDate, kstParts } from "@/lib/time";
import { assertBusinessAccess } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { getSettings } from "@/server/settings";
import { isResendConfigured, sendResendEmail } from "./providers/resend";
import { shortError, type ProviderResult } from "./providers/shared";
import { sendSolapiMessage, solapiConfig } from "./providers/solapi";
import { SELLER_TEMPLATE_KEYS, isSellerTemplateKey } from "./templates";

/**
 * 외부 채널(문자·알림톡·이메일) 발송 대기열.
 * - enqueueMessage: 대기열에 넣는다. 광고성 메시지의 수신 동의·표기·야간 제한과 사업자 월 한도를 여기서 지킨다.
 * - dispatchOutbox: 주기 작업이 호출한다. 동시에 여러 번 호출돼도 한 건을 두 번 보내지 않는다.
 */

export const ADVERTISING_PREFIX = "(광고) 남는자리";
export const ADVERTISING_OPT_OUT = "무료수신거부: 마이 > 알림 설정";
export const QUOTA_EXCEEDED_ERROR = "월 발송 한도를 넘었어요";
const CONSENT_MISSING_ERROR = "수신 동의가 없어 보내지 않았어요";
const ATTEMPTS_EXHAUSTED_ERROR = "발송을 끝내지 못하고 시도 횟수를 넘겼어요";

export const MAX_SEND_ATTEMPTS = 3;
/** 발송기가 한 건을 붙잡고 있는 시간. 이 안에 결과를 기록하지 못하면(프로세스 종료 등) 다시 발송 대상이 된다. */
const CLAIM_LEASE_MS = 5 * MINUTE;
/** n번째 시도가 실패한 뒤 다음 시도까지 기다리는 시간 */
const RETRY_BACKOFF_MS = [1 * MINUTE, 5 * MINUTE];
const SEND_CONCURRENCY = 8;
const DISPATCH_LIMIT_MAX = 200;

// ── 시간 계산 ─────────────────────────────────────────

/** 야간 시각(21~08시 KST)을 받아 그 뒤 처음 오는 08:00 KST 를 돌려준다. */
export function nextMorningKst(from: Date): Date {
  const p = kstParts(from);
  const eightToday = kstDate(p.year, p.month, p.day, 8);
  return p.hour >= 21 ? addDays(eightToday, 1) : eightToday;
}

/** KST 달력 기준 이번 달 [시작, 다음 달 시작) */
function kstMonthRange(now: Date): { from: Date; to: Date } {
  const p = kstParts(now);
  return { from: kstDate(p.year, p.month, 1), to: kstDate(p.year, p.month + 1, 1) };
}

// ── 대기열에 넣기 ─────────────────────────────────────

const enqueueSchema = z.object({
  userId: z.string().min(1).max(64).nullish(),
  businessId: z.string().min(1).max(64).nullish(),
  channel: z.enum(["SMS", "ALIMTALK", "EMAIL"]),
  recipient: z.string().trim().min(1).max(254),
  templateKey: z.string().min(1).max(64),
  subject: z.string().trim().max(120).optional(),
  body: z.string().trim().min(1).max(2000),
  isAdvertising: z.boolean().optional(),
  dedupeKey: z.string().min(1).max(190).optional(),
  scheduledAt: z.date().optional(),
});

export interface EnqueueMessageInput {
  /** 수신 회원. 광고성 메시지는 동의 확인을 위해 반드시 필요하다. */
  userId?: string | null;
  /** 관련 사업장. 사업자 템플릿 키와 함께 오면 월 발송 한도에 포함된다. */
  businessId?: string | null;
  channel: MessageChannel;
  /** 휴대전화 번호 또는 이메일 주소 */
  recipient: string;
  templateKey: string;
  subject?: string;
  body: string;
  isAdvertising?: boolean;
  dedupeKey?: string;
  scheduledAt?: Date;
}

export interface EnqueueResult {
  /** 대기열 행. 보내지 않기로 한 경우(잘못된 수신처·광고 미동의) null */
  row: MessageOutbox | null;
  /** 이번 호출로 새로 만들어졌는지(중복 키로 기존 행을 돌려준 경우 false) */
  created: boolean;
}

const emailSchema = z.email().max(254);

function normalizeRecipient(channel: MessageChannel, recipient: string): string | null {
  if (channel === "EMAIL") {
    const parsed = emailSchema.safeParse(recipient.toLowerCase());
    return parsed.success ? parsed.data : null;
  }
  return normalizePhone(recipient);
}

/** 광고성 정보 표기(정보통신망법 제50조): 맨 앞에 (광고)와 전송자 이름, 끝에 무료 수신거부 방법 */
function decorateAdvertising(body: string): string {
  const head = body.startsWith("(광고)") ? body : `${ADVERTISING_PREFIX}\n${body}`;
  return head.includes(ADVERTISING_OPT_OUT) ? head : `${head}\n${ADVERTISING_OPT_OUT}`;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

type Db = Prisma.TransactionClient;

async function countMonthlyUsage(db: Db, businessId: string, now: Date): Promise<number> {
  const { from, to } = kstMonthRange(now);
  return db.messageOutbox.count({
    where: {
      businessId,
      templateKey: { in: [...SELLER_TEMPLATE_KEYS] },
      status: { in: ["SENT", "SIMULATED", "QUEUED"] },
      createdAt: { gte: from, lt: to },
    },
  });
}

async function monthlyQuota(db: Db, businessId: string): Promise<number> {
  const [settings, business] = await Promise.all([
    getSettings(),
    db.business.findUnique({ where: { id: businessId }, select: { plan: true } }),
  ]);
  if (!business) return 0;
  return business.plan === "PRO" ? settings.proMonthlyMessages : settings.freeMonthlyMessages;
}

/** 사업장의 이번 달(KST) 자동 문자 사용량과 플랜 한도 */
export async function getMonthlyMessageUsage(businessId: string, now: Date = new Date()): Promise<{ used: number; quota: number }> {
  const [used, quota] = await Promise.all([countMonthlyUsage(prisma, businessId, now), monthlyQuota(prisma, businessId)]);
  return { used, quota };
}

/**
 * 한도 확인과 기록을 사업장 단위로 직렬화한다(동시에 여러 건이 들어와도 한도를 넘겨 쌓이지 않게).
 * 행 잠금 대신 권고 잠금을 써서 예약 트랜잭션과 서로 기다리지 않는다.
 */
async function createWithinQuota(data: Prisma.MessageOutboxUncheckedCreateInput, businessId: string, now: Date) {
  // 설정 캐시를 미리 채워 잠금 구간에서 다른 연결을 쓰지 않게 한다.
  await getSettings();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`outbox-quota:${businessId}`}, 0))`;
    const [used, quota] = await Promise.all([countMonthlyUsage(tx, businessId, now), monthlyQuota(tx, businessId)]);
    if (used >= quota) {
      return tx.messageOutbox.create({ data: { ...data, status: "SKIPPED", error: QUOTA_EXCEEDED_ERROR } });
    }
    return tx.messageOutbox.create({ data });
  });
}

/**
 * 메시지를 대기열에 넣고, 새로 만들었는지 여부까지 돌려준다.
 * 수신처가 잘못됐거나 광고 수신에 동의하지 않은 회원이면 넣지 않는다({ row: null }).
 */
export async function enqueueMessageDetailed(input: EnqueueMessageInput): Promise<EnqueueResult> {
  const parsed = enqueueSchema.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    console.error(`[outbox] 발송 요청 형식 오류 — ${input.templateKey}: ${fields}`);
    return { row: null, created: false };
  }
  const m = parsed.data;
  const recipient = normalizeRecipient(m.channel, m.recipient);
  if (!recipient) return { row: null, created: false };

  if (m.dedupeKey) {
    const existing = await prisma.messageOutbox.findUnique({ where: { dedupeKey: m.dedupeKey } });
    if (existing) return { row: existing, created: false };
  }

  const now = new Date();
  let body = m.body;
  let subject = m.subject || null;
  let scheduledAt = m.scheduledAt ?? now;

  if (m.isAdvertising) {
    if (!m.userId) return { row: null, created: false };
    const user = await prisma.user.findUnique({
      where: { id: m.userId },
      select: { status: true, marketingConsentAt: true, nightAlertConsentAt: true },
    });
    if (!user || user.status !== "ACTIVE" || !user.marketingConsentAt) return { row: null, created: false };
    body = decorateAdvertising(body);
    // 이메일은 제목에도 (광고)를 붙인다.
    if (m.channel === "EMAIL" && subject && !subject.startsWith("(광고)")) subject = `(광고) ${subject}`;
    if (isNightKst(scheduledAt) && !user.nightAlertConsentAt) scheduledAt = nextMorningKst(scheduledAt);
  }

  const data: Prisma.MessageOutboxUncheckedCreateInput = {
    userId: m.userId ?? null,
    businessId: m.businessId ?? null,
    channel: m.channel,
    recipient,
    templateKey: m.templateKey,
    subject,
    body,
    isAdvertising: m.isAdvertising ?? false,
    dedupeKey: m.dedupeKey ?? null,
    scheduledAt,
  };

  try {
    const row =
      m.businessId && isSellerTemplateKey(m.templateKey)
        ? await createWithinQuota(data, m.businessId, now)
        : await prisma.messageOutbox.create({ data });
    return { row, created: true };
  } catch (e) {
    // 같은 키로 동시에 들어온 요청: 먼저 저장된 행을 돌려준다.
    if (m.dedupeKey && isUniqueViolation(e)) {
      return { row: await prisma.messageOutbox.findUnique({ where: { dedupeKey: m.dedupeKey } }), created: false };
    }
    throw e;
  }
}

/** 메시지를 대기열에 넣는다. dedupeKey 가 이미 있으면 새로 만들지 않고 기존 행을 돌려준다. */
export async function enqueueMessage(input: EnqueueMessageInput): Promise<MessageOutbox | null> {
  return (await enqueueMessageDetailed(input)).row;
}

// ── 발송 ──────────────────────────────────────────────

export interface MessagingProviderStatus {
  /** provider 가 "none" 이면 미연동(기록만 남김). configured 가 false 면 연동을 켰지만 키가 빠진 상태 */
  sms: { provider: "solapi" | "none"; configured: boolean };
  email: { provider: "resend" | "none"; configured: boolean };
}

/** 화면의 "미연동" 표시용 연동 상태 */
export function getMessagingProviderStatus(): MessagingProviderStatus {
  const smsOn = env().SMS_PROVIDER === "solapi";
  const emailOn = isResendConfigured();
  return {
    sms: { provider: smsOn ? "solapi" : "none", configured: smsOn && solapiConfig() !== null },
    email: { provider: emailOn ? "resend" : "none", configured: emailOn },
  };
}

interface ClaimedMessage {
  id: string;
  userId: string | null;
  channel: MessageChannel;
  recipient: string;
  subject: string | null;
  body: string;
  isAdvertising: boolean;
  attempts: number;
}

/** 해당 채널의 발송 사업자가 연동돼 있지 않으면 null(= 기록만 남김) */
async function sendViaProvider(message: ClaimedMessage): Promise<ProviderResult | null> {
  if (message.channel === "EMAIL") {
    if (!isResendConfigured()) return null;
    return sendResendEmail({
      to: message.recipient,
      subject: message.subject ?? "남는자리 알림",
      text: message.body,
      idempotencyKey: `outbox-${message.id}`,
    });
  }
  if (env().SMS_PROVIDER !== "solapi") return null;
  return sendSolapiMessage({ to: message.recipient, text: message.body, subject: message.subject, channel: message.channel });
}

/**
 * 점유한 행에만 결과를 기록한다(임대가 끝나 다른 발송기가 다시 잡은 행은 건드리지 않는다).
 * 최종 상태로 닫을 때는 임대 만료 시각이 들어 있던 scheduledAt 을 처리 시각으로 되돌려 내역에 미래 시각이 남지 않게 한다.
 */
async function settle(message: ClaimedMessage, data: Prisma.MessageOutboxUpdateManyMutationInput): Promise<void> {
  await prisma.messageOutbox.updateMany({
    where: { id: message.id, status: "QUEUED", attempts: message.attempts },
    data: data.status ? { scheduledAt: new Date(), ...data } : data,
  });
}

type Outcome = "sent" | "simulated" | "failed" | "deferred" | "skipped";

interface ConsentState {
  status: string;
  marketingConsentAt: Date | null;
  nightAlertConsentAt: Date | null;
}

async function deliver(message: ClaimedMessage, consent: ConsentState | undefined): Promise<Outcome> {
  const now = new Date();

  // 대기 중에 동의를 철회했거나 야간이 된 광고성 메시지는 보내기 직전에 한 번 더 걸러 낸다.
  if (message.isAdvertising) {
    if (!consent || consent.status !== "ACTIVE" || !consent.marketingConsentAt) {
      await settle(message, { status: "SKIPPED", error: CONSENT_MISSING_ERROR });
      return "skipped";
    }
    if (isNightKst(now) && !consent.nightAlertConsentAt) {
      await settle(message, { scheduledAt: nextMorningKst(now), attempts: { decrement: 1 } });
      return "deferred";
    }
  }

  let result: ProviderResult | null;
  try {
    result = await sendViaProvider(message);
  } catch (e) {
    result = { ok: false, provider: "unknown", retryable: true, error: shortError(e instanceof Error ? e.message : "알 수 없는 오류") };
  }

  if (result === null) {
    await settle(message, { status: "SIMULATED", provider: "none", sentAt: now, error: null });
    return "simulated";
  }
  if (result.ok) {
    await settle(message, { status: "SENT", provider: result.provider, providerMessageId: result.messageId, sentAt: now, error: null });
    return "sent";
  }

  // 수신처·본문은 남기지 않고 식별자와 사유만 기록한다.
  console.error(`[outbox] 발송 실패 id=${message.id} channel=${message.channel} attempt=${message.attempts} — ${result.error}`);
  const backoff = RETRY_BACKOFF_MS[message.attempts - 1];
  if (result.retryable && message.attempts < MAX_SEND_ATTEMPTS && backoff !== undefined) {
    await settle(message, { provider: result.provider, error: result.error, scheduledAt: new Date(now.getTime() + backoff) });
  } else {
    await settle(message, { status: "FAILED", provider: result.provider, error: result.error });
  }
  return "failed";
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export interface DispatchResult {
  /** 발송 사업자가 접수한 건수 */
  sent: number;
  /** 미연동 상태라 기록만 남긴 건수 */
  simulated: number;
  /** 이번 실행에서 실패한 시도 수(재시도 예정 포함) */
  failed: number;
}

/**
 * 발송 시각이 된 대기 건을 점유해 보낸다.
 * 점유는 한 문장(UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING)으로 하고,
 * 점유한 행은 scheduledAt 을 임대 만료 시각으로 밀어 두어 다른 발송기의 대상에서 빠진다.
 */
export async function dispatchOutbox(options: { limit?: number } = {}): Promise<DispatchResult> {
  const limit = Math.min(DISPATCH_LIMIT_MAX, Math.max(1, Math.floor(options.limit ?? 50)));
  const now = new Date();

  // 발송 도중 프로세스가 죽기를 반복해 시도 횟수만 다 쓴 건은 실패로 닫는다.
  await prisma.messageOutbox.updateMany({
    where: { status: "QUEUED", attempts: { gte: MAX_SEND_ATTEMPTS }, scheduledAt: { lte: now } },
    data: { status: "FAILED", error: ATTEMPTS_EXHAUSTED_ERROR },
  });

  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS);
  const claimed = await prisma.$queryRaw<ClaimedMessage[]>`
    WITH due AS MATERIALIZED (
      SELECT "id" FROM "MessageOutbox"
      WHERE "status" = 'QUEUED' AND "scheduledAt" <= ${now}::timestamp AND "attempts" < ${MAX_SEND_ATTEMPTS}
      ORDER BY "scheduledAt" ASC, "id" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "MessageOutbox" AS m
    SET "attempts" = m."attempts" + 1, "scheduledAt" = ${leaseUntil}::timestamp
    WHERE m."id" IN (SELECT "id" FROM due)
    RETURNING m."id", m."userId", m."channel"::text AS "channel", m."recipient", m."subject", m."body", m."isAdvertising", m."attempts"`;

  const result: DispatchResult = { sent: 0, simulated: 0, failed: 0 };
  if (claimed.length === 0) return result;

  const adUserIds = [...new Set(claimed.filter((m) => m.isAdvertising && m.userId).map((m) => m.userId!))];
  const consents = new Map<string, ConsentState>();
  if (adUserIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: adUserIds } },
      select: { id: true, status: true, marketingConsentAt: true, nightAlertConsentAt: true },
    });
    for (const u of users) consents.set(u.id, u);
  }

  await runPool(claimed, SEND_CONCURRENCY, async (message) => {
    try {
      const outcome = await deliver(message, message.userId ? consents.get(message.userId) : undefined);
      if (outcome === "sent") result.sent += 1;
      else if (outcome === "simulated") result.simulated += 1;
      else if (outcome === "failed") result.failed += 1;
    } catch (e) {
      // 결과 기록 실패: 임대가 끝나면 다시 발송 대상이 된다.
      console.error(`[outbox] 발송 결과 기록 실패 id=${message.id}`, e);
    }
  });

  return result;
}

// ── 조회(사업자 발송 내역·운영자 콘솔) ─────────────────

const MESSAGE_STATUSES = ["QUEUED", "SENT", "SIMULATED", "FAILED", "SKIPPED"] as const satisfies readonly MessageStatus[];
const MESSAGE_CHANNELS = ["SMS", "ALIMTALK", "EMAIL"] as const satisfies readonly MessageChannel[];

const listSchema = z.object({
  businessId: z.string().min(1).max(64).optional(),
  status: z.enum(MESSAGE_STATUSES).optional(),
  channel: z.enum(MESSAGE_CHANNELS).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(100).default(30),
});

export interface OutboxFilter {
  businessId?: string;
  status?: MessageStatus;
  channel?: MessageChannel;
  cursor?: string;
  limit?: number;
}

export interface OutboxListItem {
  id: string;
  userId: string | null;
  businessId: string | null;
  channel: MessageChannel;
  /** 가려진 수신처(010-****-5678, ho**@example.com) */
  recipientMasked: string;
  templateKey: string;
  subject: string | null;
  body: string;
  isAdvertising: boolean;
  status: MessageStatus;
  provider: string | null;
  error: string | null;
  attempts: number;
  scheduledAt: Date;
  sentAt: Date | null;
  createdAt: Date;
}

export interface OutboxPage {
  items: OutboxListItem[];
  nextCursor: string | null;
}

/**
 * 발송 내역 목록(최신순, 커서 페이지). 수신처는 가려서 돌려준다.
 * 권한 확인이 없으므로 운영자 콘솔·내부 작업에서만 직접 쓰고, 사업자 화면은 listBusinessOutbox 를 쓴다.
 */
/** 본문에 일회용 인증 링크·코드가 들어가는 템플릿 */
const SENSITIVE_TEMPLATE_KEYS = new Set(["PLATFORM_PASSWORD_RESET", "PLATFORM_EMAIL_VERIFY", "PLATFORM_PHONE_OTP"]);

export async function listOutbox(filter: OutboxFilter = {}): Promise<OutboxPage> {
  const f = listSchema.parse(filter);
  const rows = await prisma.messageOutbox.findMany({
    where: { businessId: f.businessId, status: f.status, channel: f.channel },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, f.limit);
  return {
    items: page.map((r) => ({
      id: r.id,
      userId: r.userId,
      businessId: r.businessId,
      channel: r.channel,
      recipientMasked: r.channel === "EMAIL" ? maskEmail(r.recipient) : maskPhone(r.recipient),
      templateKey: r.templateKey,
      subject: r.subject,
      // 비밀번호 재설정 링크처럼 본문 자체가 인증 수단인 메시지는 운영 화면에 내보내지 않는다.
      body: SENSITIVE_TEMPLATE_KEYS.has(r.templateKey) ? "(보안상 본문을 표시하지 않아요)" : r.body,
      isAdvertising: r.isAdvertising,
      status: r.status,
      provider: r.provider,
      error: r.error,
      attempts: r.attempts,
      scheduledAt: r.scheduledAt,
      sentAt: r.sentAt,
      createdAt: r.createdAt,
    })),
    nextCursor: rows.length > f.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** 사업자 화면용 발송 내역 — 행위자가 그 사업장 소속인지 확인한 뒤 해당 사업장 건만 돌려준다. */
export async function listBusinessOutbox(
  actorUserId: string,
  businessId: string,
  filter: Omit<OutboxFilter, "businessId"> = {},
): Promise<OutboxPage> {
  await assertBusinessAccess(actorUserId, businessId, "STAFF");
  return listOutbox({ ...filter, businessId });
}

export interface OutboxStats {
  total: number;
  byStatus: Record<MessageStatus, number>;
  byChannel: Record<MessageChannel, number>;
  /** 가장 오래 기다리고 있는 대기 건의 발송 예정 시각(대기 건이 없으면 null) */
  oldestQueuedAt: Date | null;
  providers: MessagingProviderStatus;
}

/** 발송 현황 집계. businessId 를 주면 그 사업장 건만, since 를 주면 그 뒤에 만들어진 건만 센다. */
export async function getOutboxStats(filter: { businessId?: string; since?: Date } = {}): Promise<OutboxStats> {
  const where: Prisma.MessageOutboxWhereInput = {
    businessId: filter.businessId,
    createdAt: filter.since ? { gte: filter.since } : undefined,
  };
  const [byStatusRows, byChannelRows, oldest] = await Promise.all([
    prisma.messageOutbox.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.messageOutbox.groupBy({ by: ["channel"], where, _count: { _all: true } }),
    prisma.messageOutbox.findFirst({ where: { ...where, status: "QUEUED" }, orderBy: { scheduledAt: "asc" }, select: { scheduledAt: true } }),
  ]);
  const byStatus: Record<MessageStatus, number> = { QUEUED: 0, SENT: 0, SIMULATED: 0, FAILED: 0, SKIPPED: 0 };
  const byChannel: Record<MessageChannel, number> = { SMS: 0, ALIMTALK: 0, EMAIL: 0 };
  for (const row of byStatusRows) byStatus[row.status] = row._count._all;
  for (const row of byChannelRows) byChannel[row.channel] = row._count._all;
  return {
    total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
    byStatus,
    byChannel,
    oldestQueuedAt: oldest?.scheduledAt ?? null,
    providers: getMessagingProviderStatus(),
  };
}
