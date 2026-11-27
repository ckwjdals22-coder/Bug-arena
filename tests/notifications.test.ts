import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELP_FACTS } from "@/content/help/faq";
import { BOOKING_SAFETY_TIPS } from "@/content/help/safety";
import type { Prisma } from "@/generated/prisma/client";
import { CANCELLATION_PRESETS, computeRefundRate } from "@/lib/domain";
import { POLICY_VERSIONS } from "@/lib/policy";
import { fmtDate, fmtDateTime, kstDate } from "@/lib/time";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_RETENTION_DAYS,
  OUTBOX_RETENTION_DAYS,
  countUnread,
  getNotificationPrefs,
  getNotificationSettings,
  listNotifications,
  markNotificationsRead,
  notify,
  purgeOldNotifications,
  updateMarketingConsent,
  updateNotificationPrefs,
} from "@/server/services/notifications";
import {
  notifyBusinessMembers,
  onBookingApproved,
  onBookingCancelled,
  onBookingConfirmed,
  onBookingExpired,
  onBookingPendingApproval,
  onBookingRejected,
  onBusinessReviewed,
  onNoShowMarked,
  onRefundDone,
  onResaleRefund,
  onSeatReleasedForSeller,
  onSlotCancelled,
  onSlotGoConfirmed,
  onWaitlistExpired,
  onWaitlistOffer,
  sendBookingReminder,
  sendDueReminders,
  sendReviewRequest,
} from "@/server/services/notifications/events";
import {
  ADVERTISING_OPT_OUT,
  ADVERTISING_PREFIX,
  CREDENTIAL_BODY_PLACEHOLDER,
  CREDENTIAL_TEMPLATE_KEYS,
  QUOTA_EXCEEDED_ERROR,
  dispatchOutbox,
  enqueueMessage,
  enqueueMessageDetailed,
  getMessagingProviderStatus,
  getMonthlyMessageUsage,
  getOutboxStats,
  listBusinessOutbox,
  listOutbox,
  nextMorningKst,
  scrubSensitiveOutbox,
} from "@/server/services/notifications/outbox";
import { buildSolapiAuthHeader, smsByteLength } from "@/server/services/notifications/providers/solapi";
import {
  DEFAULT_TEMPLATES,
  SELLER_TEMPLATE_KEYS,
  TEMPLATE_KEYS,
  TEMPLATE_SAMPLE_VARS,
  TEMPLATE_VARIABLES,
  buildBookingTemplateVars,
  findUnknownVariables,
  getBusinessTemplate,
  getBusinessTemplates,
  renderTemplate,
  saveBusinessTemplate,
} from "@/server/services/notifications/templates";
import { DEFAULT_SETTINGS, resetSettingsCache } from "@/server/settings";
import { createBusiness, createListing, createSlot, createUser, resetDb } from "./helpers";

type Listing = Awaited<ReturnType<typeof createListing>>;
type OutboxModule = typeof import("@/server/services/notifications/outbox");

const HOUR_MS = 3_600_000;
const code = () => `NJ-${randomBytes(4).toString("hex").toUpperCase()}`;

async function setSettings(value: Record<string, number>) {
  await prisma.platformSetting.upsert({ where: { key: "platform" }, create: { key: "platform", value }, update: { value } });
  resetSettingsCache();
}

/** 예약 한 건을 직접 만든다(예약 엔진을 거치지 않는 알림 테스트용). */
async function createBooking(
  listing: Listing,
  user: { id: string; name: string; phone: string | null } | null,
  overrides: Partial<Prisma.BookingUncheckedCreateInput> = {},
) {
  return prisma.booking.create({
    data: {
      code: code(),
      userId: user?.id ?? null,
      businessId: listing.business.id,
      productId: listing.product.id,
      slotId: listing.slot.id,
      slotSeatId: listing.seat.id,
      quantity: 2,
      unitPrice: 30000,
      totalAmount: 60000,
      payNowAmount: 60000,
      payOnsiteAmount: 0,
      status: "CONFIRMED",
      channel: "MARKETPLACE",
      paymentMethod: "ONLINE",
      paymentState: "PAID",
      guestName: user?.name ?? "전화예약 손님",
      guestPhone: user?.phone ?? "01055557777",
      policySnapshot: [],
      checkinToken: randomBytes(12).toString("hex"),
      confirmedAt: new Date(),
      ...overrides,
    },
  });
}

const smsInput = (overrides: Partial<Parameters<typeof enqueueMessage>[0]> = {}) => ({
  channel: "SMS" as const,
  recipient: "010-1234-5678",
  templateKey: "TEST",
  body: "테스트 문자예요",
  ...overrides,
});

/** 발송 사업자 연동 설정을 바꾼 새 모듈 인스턴스를 불러온다(env 는 처음 읽을 때 고정되므로 모듈을 다시 올린다). */
const ENV_KEYS = ["SMS_PROVIDER", "SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_SENDER", "SOLAPI_KAKAO_PFID", "RESEND_API_KEY", "EMAIL_FROM"];
const savedEnv = new Map<string, string | undefined>();

async function loadOutboxWithEnv(overrides: Record<string, string>): Promise<OutboxModule> {
  for (const key of ENV_KEYS) if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  Object.assign(process.env, overrides);
  vi.resetModules();
  return import("@/server/services/notifications/outbox");
}

const SOLAPI_ENV = {
  SMS_PROVIDER: "solapi",
  SOLAPI_API_KEY: "NCSTESTKEY000001",
  SOLAPI_API_SECRET: "test-secret-value",
  SOLAPI_SENDER: "042-123-4567",
};

const solapiOk = (messageId = "M4V20261127110044DTYYJBBYLPQZIB1") =>
  new Response(
    JSON.stringify({
      groupInfo: { groupId: "G4V20261127105937H3PTASXMNJG2JID", count: { total: 1, registeredSuccess: 1, registeredFailed: 0 } },
      failedMessageList: [],
      messageList: [{ messageId, statusCode: "2000", statusMessage: "정상 접수(이통사로 접수 예정) " }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

type FetchArgs = [input: string | URL | Request, init?: RequestInit];
const bodyOf = (call: FetchArgs) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
const headersOf = (call: FetchArgs) => call[1]?.headers as Record<string, string>;

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (savedEnv.size > 0) {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    vi.resetModules();
  }
});

// ───────────────────────── notify · 알림함 · 수신 설정 ─────────────────────────

describe("notify — 앱 내 알림과 외부 발송", () => {
  it("앱 내 알림을 기록하고, external 이 없으면 대기열에는 아무것도 넣지 않는다", async () => {
    const user = await createUser();
    const res = await notify({
      userId: user.id,
      type: "BOOKING_CONFIRMED",
      title: "  예약이 확정됐어요 ",
      body: "금요 와인 소셜",
      linkUrl: "/my/bookings/NJ-AAAAAA",
      data: { bookingId: "b1" },
    });
    expect(res.created).toBe(true);
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: res.notificationId! } });
    expect(row).toMatchObject({
      userId: user.id,
      type: "BOOKING_CONFIRMED",
      title: "예약이 확정됐어요",
      linkUrl: "/my/bookings/NJ-AAAAAA",
      data: { bookingId: "b1" },
      readAt: null,
    });
    expect(await prisma.messageOutbox.count()).toBe(0);
  });

  it("외부 주소로 가는 링크는 저장하지 않는다", async () => {
    const user = await createUser();
    const a = await notify({ userId: user.id, type: "SYSTEM", title: "공지", body: "내용", linkUrl: "https://evil.example.com/x" });
    const b = await notify({ userId: user.id, type: "SYSTEM", title: "공지", body: "내용", linkUrl: "//evil.example.com" });
    const rows = await prisma.notification.findMany({ where: { id: { in: [a.notificationId!, b.notificationId!] } } });
    expect(rows.map((r) => r.linkUrl)).toEqual([null, null]);
  });

  it("예약 문자를 받는 회원에게는 문자도 대기열에 넣는다(기본 본문 = 제목 + 본문 + 절대 주소)", async () => {
    const user = await createUser({ phone: "01011112222" });
    const res = await notify({
      userId: user.id,
      type: "WAITLIST_OFFER",
      title: "기다리던 자리가 났어요",
      body: "지금 확인해 보세요",
      linkUrl: "/slots/s1?offer=1",
      external: { channel: "SMS", templateKey: "PLATFORM_WAITLIST_OFFER" },
    });
    expect(res.message).toMatchObject({ status: "QUEUED", created: true });
    const queued = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: res.message!.id } });
    expect(queued).toMatchObject({ userId: user.id, channel: "SMS", recipient: "01011112222", isAdvertising: false, attempts: 0 });
    expect(queued.body).toBe("[남는자리] 기다리던 자리가 났어요\n지금 확인해 보세요\nhttp://localhost:3000/slots/s1?offer=1");
  });

  it("수신 설정을 지킨다: 예약 문자를 끈 회원은 앱 알림만 받고, 필수 안내는 그래도 문자로 간다", async () => {
    const user = await createUser({ notificationPrefs: { bookingSms: false } });
    const quiet = await notify({
      userId: user.id,
      type: "BOOKING_CONFIRMED",
      title: "예약이 확정됐어요",
      body: "본문",
      external: { channel: "SMS", templateKey: "PLATFORM_BOOKING_CONFIRMED" },
    });
    expect(quiet.created).toBe(true);
    expect(quiet.message).toBeNull();
    expect(await prisma.messageOutbox.count()).toBe(0);

    const essential = await notify({
      userId: user.id,
      type: "BOOKING_CANCELLED",
      title: "예약이 취소됐어요",
      body: "본문",
      external: { channel: "SMS", templateKey: "PLATFORM_BOOKING_CANCELLED", essential: true },
    });
    expect(essential.message?.status).toBe("QUEUED");
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(2);
  });

  it("빈자리 문자는 설정을 켠 회원에게만, 후기 요청 문자는 끄지 않은 회원에게만 간다", async () => {
    const off = await createUser({ marketingConsentAt: new Date() });
    const on = await createUser({ marketingConsentAt: new Date(), notificationPrefs: { vacancySms: true, reviewRequest: false } });
    const vacancy = (userId: string) =>
      notify({
        userId,
        type: "VACANCY_ALERT",
        title: "새 자리가 열렸어요",
        body: "본문",
        external: { channel: "SMS", templateKey: "VACANCY_ALERT", isAdvertising: true },
      });
    expect((await vacancy(off.id)).message).toBeNull();
    expect((await vacancy(on.id)).message?.status).toBe("QUEUED");

    const review = (userId: string) =>
      notify({ userId, type: "REVIEW_REQUEST", title: "어떠셨어요?", body: "본문", external: { channel: "SMS", templateKey: "REVIEW_REQUEST" } });
    expect((await review(off.id)).message?.status).toBe("QUEUED");
    expect((await review(on.id)).message).toBeNull();
  });

  it("광고성 메시지는 수신 동의가 없으면 대기열에 넣지 않는다(설정만 켜져 있어도)", async () => {
    const user = await createUser({ notificationPrefs: { vacancySms: true } });
    const res = await notify({
      userId: user.id,
      type: "VACANCY_ALERT",
      title: "새 자리가 열렸어요",
      body: "본문",
      external: { channel: "SMS", templateKey: "VACANCY_ALERT", isAdvertising: true },
    });
    expect(res.created).toBe(true);
    expect(res.message).toBeNull();
    expect(await prisma.messageOutbox.count()).toBe(0);
  });

  it("같은 dedupeKey 로 두 번 불러도 앱 알림과 문자는 한 번만 만들어진다", async () => {
    const user = await createUser();
    const input = {
      userId: user.id,
      type: "BOOKING_REMINDER" as const,
      title: "내일 예약이 있어요",
      body: "본문",
      dedupeKey: "REMINDER:DAY_BEFORE:b1",
      external: { channel: "SMS" as const, templateKey: "PLATFORM_TEST", dedupeKey: "REMINDER_SMS:b1" },
    };
    const first = await notify(input);
    const second = await notify(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.notificationId).toBe(first.notificationId);
    expect(second.message).toMatchObject({ id: first.message!.id, created: false });
    expect(await prisma.notification.count()).toBe(1);
    expect(await prisma.messageOutbox.count()).toBe(1);
  });

  it("앱 알림이 중복이면 중복 방지 키가 없는 문자도 다시 보내지 않는다", async () => {
    const user = await createUser();
    const input = {
      userId: user.id,
      type: "BOOKING_CONFIRMED" as const,
      title: "예약이 확정됐어요",
      body: "본문",
      dedupeKey: "BOOKING_CONFIRMED:b1",
      external: { channel: "SMS" as const, templateKey: "PLATFORM_TEST" },
    };
    await notify(input);
    await notify(input);
    expect(await prisma.messageOutbox.count()).toBe(1);
  });

  it("전달에 문제가 있어도 예외를 던지지 않는다(없는 회원 · 번호 없는 회원 · 탈퇴 회원)", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = await notify({
      userId: "no-such-user",
      type: "SYSTEM",
      title: "제목",
      body: "본문",
      external: { channel: "SMS", templateKey: "PLATFORM_TEST" },
    });
    expect(missing).toEqual({ notificationId: null, created: false, message: null });
    expect(errorLog).toHaveBeenCalled();

    const noPhone = await createUser({ phone: null });
    const withdrawn = await createUser({ status: "WITHDRAWN" });
    for (const u of [noPhone, withdrawn]) {
      const res = await notify({
        userId: u.id,
        type: "BOOKING_CONFIRMED",
        title: "제목",
        body: "본문",
        external: { channel: "SMS", templateKey: "PLATFORM_TEST" },
      });
      expect(res.created).toBe(true);
      expect(res.message).toBeNull();
    }
    expect(await prisma.messageOutbox.count()).toBe(0);
  });

  it("이메일은 회원 이메일로 보내고 제목이 없으면 알림 제목을 쓴다", async () => {
    const user = await createUser({ email: "Seller.Kim@Example.com" });
    const res = await notify({
      userId: user.id,
      type: "SELLER_BUSINESS_APPROVED",
      title: "입점이 승인됐어요",
      body: "이제 예약을 받을 수 있어요.",
      external: { channel: "EMAIL", templateKey: "PLATFORM_BUSINESS_APPROVED" },
    });
    const queued = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: res.message!.id } });
    expect(queued).toMatchObject({ channel: "EMAIL", recipient: "seller.kim@example.com", subject: "입점이 승인됐어요" });
  });
});

describe("알림함", () => {
  async function seed(userId: string, count: number) {
    for (let i = 0; i < count; i++) {
      await prisma.notification.create({
        data: { userId, type: "SYSTEM", title: `알림 ${i}`, body: "본문", createdAt: new Date(Date.now() - (count - i) * 60_000) },
      });
    }
  }

  it("내 알림만 최신순으로, 커서로 이어서 볼 수 있다", async () => {
    const me = await createUser();
    const other = await createUser();
    await seed(me.id, 5);
    await seed(other.id, 3);

    const first = await listNotifications(me.id, { limit: 2 });
    expect(first.items.map((n) => n.title)).toEqual(["알림 4", "알림 3"]);
    expect(first.nextCursor).toBe(first.items[1]!.id);

    const second = await listNotifications(me.id, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((n) => n.title)).toEqual(["알림 2", "알림 1"]);

    const third = await listNotifications(me.id, { limit: 2, cursor: second.nextCursor! });
    expect(third.items.map((n) => n.title)).toEqual(["알림 0"]);
    expect(third.nextCursor).toBeNull();
  });

  it("남의 알림 ID 를 커서로 넣어도 내 알림만 나온다", async () => {
    const me = await createUser();
    const other = await createUser();
    await seed(me.id, 2);
    await seed(other.id, 2);
    const theirs = await prisma.notification.findFirstOrThrow({ where: { userId: other.id } });
    const page = await listNotifications(me.id, { cursor: theirs.id });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((n) => n.title.startsWith("알림"))).toBe(true);
    expect(await prisma.notification.count({ where: { id: { in: page.items.map((n) => n.id) }, userId: me.id } })).toBe(2);
  });

  it("limit 범위를 벗어나면 거절한다", async () => {
    const me = await createUser();
    await expect(listNotifications(me.id, { limit: 0 })).rejects.toThrow();
    await expect(listNotifications(me.id, { limit: 51 })).rejects.toThrow();
  });

  it("안 읽은 개수를 세고, 본인 알림만 읽음 처리한다", async () => {
    const me = await createUser();
    const other = await createUser();
    await seed(me.id, 3);
    await seed(other.id, 2);
    const mine = await prisma.notification.findMany({ where: { userId: me.id }, orderBy: { createdAt: "asc" } });
    const theirs = await prisma.notification.findMany({ where: { userId: other.id } });

    expect(await countUnread(me.id)).toBe(3);
    // 남의 알림 ID 를 섞어 보내도 내 것만 바뀐다.
    expect(await markNotificationsRead(me.id, [mine[0]!.id, theirs[0]!.id])).toBe(1);
    expect(await countUnread(me.id)).toBe(2);
    expect(await countUnread(other.id)).toBe(2);

    expect(await markNotificationsRead(me.id, "all")).toBe(2);
    expect(await countUnread(me.id)).toBe(0);
    expect(await countUnread(other.id)).toBe(2);
    // 이미 읽은 알림은 다시 세지 않는다.
    expect(await markNotificationsRead(me.id, "all")).toBe(0);

    const unread = await listNotifications(other.id, { unreadOnly: true });
    expect(unread.items).toHaveLength(2);
  });
});

describe("수신 설정", () => {
  it("저장된 값이 없거나 형식이 틀리면 기본값을 쓴다", () => {
    expect(getNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual({ bookingSms: true, vacancyInApp: true, vacancySms: false, reviewRequest: true });
    expect(getNotificationPrefs({ notificationPrefs: "bad" })).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(getNotificationPrefs({ notificationPrefs: { bookingSms: "no", vacancyInApp: false, extra: 1 } })).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      vacancyInApp: false,
    });
  });

  it("바꾼 항목만 병합해 저장한다", async () => {
    const user = await createUser();
    expect(await updateNotificationPrefs(user.id, { bookingSms: false })).toEqual({ ...DEFAULT_NOTIFICATION_PREFS, bookingSms: false });
    expect(await updateNotificationPrefs(user.id, { reviewRequest: false })).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      bookingSms: false,
      reviewRequest: false,
    });
    const saved = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(saved.notificationPrefs).toEqual({ bookingSms: false, reviewRequest: false });
  });

  it("모르는 항목·불리언이 아닌 값은 거절한다", async () => {
    const user = await createUser();
    await expect(updateNotificationPrefs(user.id, { bookingSms: "yes" })).rejects.toThrow();
    await expect(updateNotificationPrefs(user.id, { isAdmin: true })).rejects.toThrow();
    await expect(updateNotificationPrefs("no-such-user", { bookingSms: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("빈자리 문자는 광고성 정보 수신에 동의해야 켤 수 있다", async () => {
    const user = await createUser();
    await expect(updateNotificationPrefs(user.id, { vacancySms: true })).rejects.toMatchObject({ code: "VALIDATION" });

    const settings = await updateMarketingConsent(user.id, { marketing: true });
    expect(settings.marketingConsentAt).toBeInstanceOf(Date);
    expect((await updateNotificationPrefs(user.id, { vacancySms: true })).vacancySms).toBe(true);
  });

  it("수신 동의를 철회하면 야간 동의·빈자리 문자가 꺼지고 대기 중인 광고 문자는 보내지 않는다", async () => {
    const user = await createUser({ phone: "01033334444" });
    await updateMarketingConsent(user.id, { marketing: true, night: true });
    await updateNotificationPrefs(user.id, { vacancySms: true });
    const ad = await enqueueMessage(smsInput({ userId: user.id, isAdvertising: true, templateKey: "VACANCY_ALERT" }));
    const info = await enqueueMessage(smsInput({ userId: user.id, templateKey: "PLATFORM_BOOKING_CONFIRMED" }));

    const after = await updateMarketingConsent(user.id, { marketing: false });
    expect(after).toMatchObject({ marketingConsentAt: null, nightAlertConsentAt: null, hasPhone: true });
    expect(after.prefs.vacancySms).toBe(false);
    expect((await prisma.messageOutbox.findUniqueOrThrow({ where: { id: ad!.id } })).status).toBe("SKIPPED");
    expect((await prisma.messageOutbox.findUniqueOrThrow({ where: { id: info!.id } })).status).toBe("QUEUED");

    // 처리 결과 통지와 감사 로그
    const notices = await prisma.notification.findMany({ where: { userId: user.id, type: "SYSTEM" }, orderBy: { createdAt: "asc" } });
    expect(notices.map((n) => n.title)).toEqual(["광고성 정보 수신에 동의했어요", "광고성 정보 수신 동의를 철회했어요"]);
    expect(notices[0]!.body).toContain("광고성 정보 수신 동의 · 야간(21~08시) 수신 동의");
    expect(notices[1]!.body).toContain("광고성 정보 수신 거부 · 야간(21~08시) 수신 거부");
    expect(notices[1]!.body).toContain("남는자리 · 처리 일시");
    const logs = await prisma.auditLog.findMany({ where: { action: "user.marketing_consent", targetId: user.id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.meta)).toEqual([
      { marketing: true, night: true },
      { marketing: false, night: false },
    ]);
  });

  it("야간 알림은 광고 수신 동의 없이 켤 수 없고, 바뀐 게 없으면 기록을 남기지 않는다", async () => {
    const user = await createUser();
    await expect(updateMarketingConsent(user.id, { night: true })).rejects.toBeInstanceOf(AppError);
    await expect(updateMarketingConsent(user.id, {})).rejects.toThrow();
    await updateMarketingConsent(user.id, { marketing: false });
    expect(await prisma.auditLog.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    expect(await getNotificationSettings(user.id)).toMatchObject({ marketingConsentAt: null, nightAlertConsentAt: null });
    // 바뀐 것이 없으면 동의 기록도 남기지 않는다.
    expect(await prisma.consentRecord.count()).toBe(0);
  });

  it("동의와 철회를 문서 버전·IP 와 함께 기록한다(야간 동의가 함께 꺼질 때도 따로 남긴다)", async () => {
    const user = await createUser();
    await updateMarketingConsent(user.id, { marketing: true, night: true }, { ip: "198.51.100.4" });
    await updateMarketingConsent(user.id, { night: false }, { ip: "198.51.100.5" });
    await updateMarketingConsent(user.id, { night: true });
    await updateMarketingConsent(user.id, { marketing: false }, { ip: "unknown" });

    const records = await prisma.consentRecord.findMany({ where: { userId: user.id }, orderBy: [{ createdAt: "asc" }, { kind: "asc" }] });
    expect(records.map((r) => [r.kind, r.agreed, r.ip])).toEqual([
      ["MARKETING", true, "198.51.100.4"],
      ["NIGHT_ALERT", true, "198.51.100.4"],
      ["NIGHT_ALERT", false, "198.51.100.5"],
      ["NIGHT_ALERT", true, null],
      ["MARKETING", false, null],
      ["NIGHT_ALERT", false, null],
    ]);
    expect(records.every((r) => r.version === POLICY_VERSIONS[r.kind] && r.bookingId === null)).toBe(true);
  });
});

// ───────────────────────── 발송 대기열 ─────────────────────────

describe("enqueueMessage", () => {
  it("전화번호를 숫자만 남겨 저장하고, 잘못된 수신처는 넣지 않는다", async () => {
    const ok = await enqueueMessage(smsInput());
    expect(ok).toMatchObject({ status: "QUEUED", recipient: "01012345678", attempts: 0 });

    expect(await enqueueMessage(smsInput({ recipient: "02-123-4567" }))).toBeNull();
    expect(await enqueueMessage(smsInput({ recipient: "not-a-number" }))).toBeNull();
    expect(await enqueueMessage({ channel: "EMAIL", recipient: "not-an-email", templateKey: "T", body: "본문" })).toBeNull();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await enqueueMessage(smsInput({ body: "   " }))).toBeNull();
    expect(await prisma.messageOutbox.count()).toBe(1);
  });

  it("dedupeKey 가 이미 있으면 새로 만들지 않고 기존 행을 돌려준다(동시에 들어와도 한 건)", async () => {
    const first = await enqueueMessageDetailed(smsInput({ dedupeKey: "K1" }));
    const second = await enqueueMessageDetailed(smsInput({ dedupeKey: "K1", body: "다른 본문" }));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row?.id).toBe(first.row?.id);
    expect(second.row?.body).toBe("테스트 문자예요");

    const results = await Promise.all(Array.from({ length: 8 }, () => enqueueMessageDetailed(smsInput({ dedupeKey: "K2" }))));
    expect(new Set(results.map((r) => r.row?.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await prisma.messageOutbox.count()).toBe(2);
  });

  it("광고성 메시지: 동의가 없으면 넣지 않고, 있으면 (광고) 표기와 무료 수신거부 안내를 붙인다", async () => {
    const noConsent = await createUser();
    const consented = await createUser({ marketingConsentAt: new Date(), nightAlertConsentAt: new Date() });
    const suspended = await createUser({ marketingConsentAt: new Date(), status: "SUSPENDED" });

    expect(await enqueueMessage(smsInput({ userId: noConsent.id, isAdvertising: true }))).toBeNull();
    expect(await enqueueMessage(smsInput({ userId: suspended.id, isAdvertising: true }))).toBeNull();
    // 누구에게 보내는지 모르면 동의를 확인할 수 없으므로 넣지 않는다.
    expect(await enqueueMessage(smsInput({ isAdvertising: true }))).toBeNull();

    const row = await enqueueMessage(smsInput({ userId: consented.id, isAdvertising: true, body: "둔산 소셜클럽에 새 자리가 열렸어요" }));
    expect(row?.isAdvertising).toBe(true);
    expect(row?.body).toBe(`${ADVERTISING_PREFIX}\n둔산 소셜클럽에 새 자리가 열렸어요\n${ADVERTISING_OPT_OUT}`);
    expect(row?.body.startsWith("(광고) 남는자리")).toBe(true);
    expect(row?.body.endsWith("무료수신거부: 마이 > 알림 설정")).toBe(true);
    expect(await prisma.messageOutbox.count()).toBe(1);

    // 표기는 한 번만 붙고, 이메일은 제목에도 (광고)를 붙인다.
    const again = await enqueueMessage(smsInput({ userId: consented.id, isAdvertising: true, body: row!.body }));
    expect(again?.body).toBe(row!.body);
    const email = await enqueueMessage({
      userId: consented.id,
      channel: "EMAIL",
      recipient: "hello@example.com",
      templateKey: "NEWSLETTER",
      subject: "이번 주 새 자리",
      body: "본문",
      isAdvertising: true,
    });
    expect(email?.subject).toBe("(광고) 이번 주 새 자리");
  });

  it("야간(21~08시 KST)의 광고성 메시지는 별도 동의가 없으면 다음 08:00 KST 로 예약한다", async () => {
    const dayOnly = await createUser({ marketingConsentAt: new Date() });
    const nightOk = await createUser({ marketingConsentAt: new Date(), nightAlertConsentAt: new Date() });
    vi.useFakeTimers({ toFake: ["Date"] });

    // 22:30 → 다음 날 08:00
    vi.setSystemTime(kstDate(2026, 11, 27, 22, 30));
    const late = await enqueueMessage(smsInput({ userId: dayOnly.id, isAdvertising: true }));
    expect(late?.scheduledAt).toEqual(kstDate(2026, 11, 28, 8, 0));
    // 야간 수신에 동의한 회원은 바로
    const lateOk = await enqueueMessage(smsInput({ userId: nightOk.id, isAdvertising: true }));
    expect(lateOk?.scheduledAt).toEqual(kstDate(2026, 11, 27, 22, 30));
    // 정보성 메시지는 야간에도 바로
    const info = await enqueueMessage(smsInput({ userId: dayOnly.id }));
    expect(info?.scheduledAt).toEqual(kstDate(2026, 11, 27, 22, 30));

    // 03:10 → 같은 날 08:00
    vi.setSystemTime(kstDate(2026, 11, 28, 3, 10));
    const early = await enqueueMessage(smsInput({ userId: dayOnly.id, isAdvertising: true }));
    expect(early?.scheduledAt).toEqual(kstDate(2026, 11, 28, 8, 0));

    // 낮에는 바로
    vi.setSystemTime(kstDate(2026, 11, 28, 14, 0));
    const day = await enqueueMessage(smsInput({ userId: dayOnly.id, isAdvertising: true }));
    expect(day?.scheduledAt).toEqual(kstDate(2026, 11, 28, 14, 0));

    // 예약 발송 시각이 야간이면 그 뒤의 08:00 으로 민다.
    const scheduled = await enqueueMessage(
      smsInput({ userId: dayOnly.id, isAdvertising: true, scheduledAt: kstDate(2026, 12, 31, 23, 0) }),
    );
    expect(scheduled?.scheduledAt).toEqual(kstDate(2027, 1, 1, 8, 0));
  });

  it("nextMorningKst: 경계 시각", () => {
    expect(nextMorningKst(kstDate(2026, 11, 27, 21, 0))).toEqual(kstDate(2026, 11, 28, 8, 0));
    expect(nextMorningKst(kstDate(2026, 11, 27, 23, 59))).toEqual(kstDate(2026, 11, 28, 8, 0));
    expect(nextMorningKst(kstDate(2026, 11, 28, 0, 0))).toEqual(kstDate(2026, 11, 28, 8, 0));
    expect(nextMorningKst(kstDate(2026, 11, 28, 7, 59))).toEqual(kstDate(2026, 11, 28, 8, 0));
  });
});

describe("사업자 월 발송 한도", () => {
  const sellerSms = (businessId: string, overrides: Partial<Parameters<typeof enqueueMessage>[0]> = {}) =>
    smsInput({ businessId, templateKey: "BOOKING_CONFIRMED", ...overrides });

  it("한도를 넘기면 SKIPPED 로 기록해 사업자가 내역에서 볼 수 있게 한다", async () => {
    await setSettings({ freeMonthlyMessages: 2, proMonthlyMessages: 4 });
    const { business } = await createBusiness();

    const a = await enqueueMessage(sellerSms(business.id));
    const b = await enqueueMessage(sellerSms(business.id, { templateKey: "REMINDER_DAY_BEFORE" }));
    const c = await enqueueMessage(sellerSms(business.id, { templateKey: "REVIEW_REQUEST" }));
    expect([a?.status, b?.status, c?.status]).toEqual(["QUEUED", "QUEUED", "SKIPPED"]);
    expect(c?.error).toBe(QUOTA_EXCEEDED_ERROR);
    expect(c?.error).toBe("월 발송 한도를 넘었어요");
    expect(await getMonthlyMessageUsage(business.id)).toEqual({ used: 2, quota: 2 });

    // 사업자 템플릿이 아닌 플랫폼 안내는 한도와 무관하다.
    const platform = await enqueueMessage(sellerSms(business.id, { templateKey: "PLATFORM_BOOKING_CONFIRMED" }));
    expect(platform?.status).toBe("QUEUED");
    expect(await getMonthlyMessageUsage(business.id)).toEqual({ used: 2, quota: 2 });

    // 다른 사업장은 영향이 없다.
    const { business: other } = await createBusiness();
    expect((await enqueueMessage(sellerSms(other.id)))?.status).toBe("QUEUED");
  });

  it("프로 플랜은 프로 한도를 쓰고, 지난달 발송분과 실패 건은 세지 않는다", async () => {
    await setSettings({ freeMonthlyMessages: 1, proMonthlyMessages: 3 });
    const { business } = await createBusiness({ plan: "PRO" });
    const lastMonth = new Date(Date.now() - 40 * 24 * HOUR_MS);
    await prisma.messageOutbox.createMany({
      data: [
        { businessId: business.id, channel: "SMS", recipient: "01012345678", templateKey: "BOOKING_CONFIRMED", body: "지난달", status: "SENT", createdAt: lastMonth },
        { businessId: business.id, channel: "SMS", recipient: "01012345678", templateKey: "BOOKING_CONFIRMED", body: "실패", status: "FAILED" },
        { businessId: business.id, channel: "SMS", recipient: "01012345678", templateKey: "BOOKING_CONFIRMED", body: "건너뜀", status: "SKIPPED" },
        { businessId: business.id, channel: "SMS", recipient: "01012345678", templateKey: "BOOKING_CONFIRMED", body: "기록만", status: "SIMULATED" },
      ],
    });
    expect(await getMonthlyMessageUsage(business.id)).toEqual({ used: 1, quota: 3 });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await enqueueMessage(sellerSms(business.id)))?.status);
    expect(statuses).toEqual(["QUEUED", "QUEUED", "SKIPPED"]);
  });

  it("동시에 여러 건이 들어와도 한도만큼만 대기열에 들어간다", async () => {
    await setSettings({ freeMonthlyMessages: 3 });
    const { business } = await createBusiness();
    const rows = await Promise.all(Array.from({ length: 10 }, () => enqueueMessage(sellerSms(business.id))));
    expect(rows.filter((r) => r?.status === "QUEUED")).toHaveLength(3);
    expect(rows.filter((r) => r?.status === "SKIPPED")).toHaveLength(7);
    expect(await getMonthlyMessageUsage(business.id)).toEqual({ used: 3, quota: 3 });
  });
});

describe("dispatchOutbox — 미연동 상태", () => {
  it("발송 사업자가 없으면 SIMULATED 로 기록만 남긴다(문자·이메일 모두)", async () => {
    expect(getMessagingProviderStatus()).toEqual({
      sms: { provider: "none", configured: false },
      email: { provider: "none", configured: false },
    });
    const sms = await enqueueMessage(smsInput());
    const email = await enqueueMessage({ channel: "EMAIL", recipient: "a@example.com", templateKey: "T", subject: "제목", body: "본문" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await dispatchOutbox()).toEqual({ sent: 0, simulated: 2, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const id of [sms!.id, email!.id]) {
      const row = await prisma.messageOutbox.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: "SIMULATED", provider: "none", attempts: 1, providerMessageId: null, error: null });
      expect(row.sentAt).toBeInstanceOf(Date);
      // 점유하면서 밀어 둔 발송 시각(임대 만료)이 내역에 미래 시각으로 남지 않는다.
      expect(row.scheduledAt.getTime()).toBeLessThanOrEqual(Date.now());
    }
    // 다시 돌려도 처리할 것이 없다.
    expect(await dispatchOutbox()).toEqual({ sent: 0, simulated: 0, failed: 0 });
  });

  it("발송 시각이 안 된 건은 건드리지 않고, limit 만큼만 오래된 순서로 처리한다", async () => {
    const future = await enqueueMessage(smsInput({ scheduledAt: new Date(Date.now() + HOUR_MS) }));
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const row = await enqueueMessage(smsInput({ scheduledAt: new Date(Date.now() - (10 - i) * 60_000) }));
      ids.push(row!.id);
    }
    expect(await dispatchOutbox({ limit: 2 })).toEqual({ sent: 0, simulated: 2, failed: 0 });
    const statuses = await prisma.messageOutbox.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
    const byId = new Map(statuses.map((s) => [s.id, s.status]));
    expect(ids.map((id) => byId.get(id))).toEqual(["SIMULATED", "SIMULATED", "QUEUED"]);
    expect((await prisma.messageOutbox.findUniqueOrThrow({ where: { id: future!.id } })).status).toBe("QUEUED");
  });

  it("보내기 직전에 광고 수신 동의를 다시 확인한다(철회했으면 SKIPPED)", async () => {
    const user = await createUser({ marketingConsentAt: new Date(), nightAlertConsentAt: new Date() });
    const row = await enqueueMessage(smsInput({ userId: user.id, isAdvertising: true }));
    await prisma.user.update({ where: { id: user.id }, data: { marketingConsentAt: null } });

    expect(await dispatchOutbox()).toEqual({ sent: 0, simulated: 0, failed: 0 });
    const after = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: row!.id } });
    expect(after.status).toBe("SKIPPED");
    expect(after.sentAt).toBeNull();
  });

  it("대기 중 야간이 된 광고성 메시지는 시도 횟수를 쓰지 않고 다음 08:00 으로 미룬다", async () => {
    const user = await createUser({ marketingConsentAt: new Date() });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(kstDate(2026, 11, 27, 20, 59));
    const row = await enqueueMessage(smsInput({ userId: user.id, isAdvertising: true }));
    expect(row?.scheduledAt).toEqual(kstDate(2026, 11, 27, 20, 59));

    vi.setSystemTime(kstDate(2026, 11, 27, 21, 1));
    expect(await dispatchOutbox()).toEqual({ sent: 0, simulated: 0, failed: 0 });
    const deferred = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: row!.id } });
    expect(deferred).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(deferred.scheduledAt).toEqual(kstDate(2026, 11, 28, 8, 0));

    vi.setSystemTime(kstDate(2026, 11, 28, 8, 0));
    expect(await dispatchOutbox()).toEqual({ sent: 0, simulated: 1, failed: 0 });
  });

  it("시도 횟수를 다 쓰고 대기 상태로 남은 건은 실패로 닫는다", async () => {
    const stuck = await enqueueMessage(smsInput());
    await prisma.messageOutbox.update({ where: { id: stuck!.id }, data: { attempts: 3, scheduledAt: new Date(Date.now() - 1000) } });
    expect(await dispatchOutbox()).toEqual({ sent: 0, simulated: 0, failed: 0 });
    const row = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: stuck!.id } });
    expect(row.status).toBe("FAILED");
    expect(row.error).toBeTruthy();
  });
});

describe("dispatchOutbox — SOLAPI 연동", () => {
  it("문자를 SOLAPI 로 보내고 SENT 로 기록한다(HMAC 서명·요청 본문 확인)", async () => {
    const mod = await loadOutboxWithEnv(SOLAPI_ENV);
    expect(mod.getMessagingProviderStatus().sms).toEqual({ provider: "solapi", configured: true });
    const fetchMock = vi.fn(async (..._args: FetchArgs) => solapiOk());
    vi.stubGlobal("fetch", fetchMock);

    const short = await mod.enqueueMessage(smsInput({ body: "예약이 확정됐어요" }));
    expect(await mod.dispatchOutbox()).toEqual({ sent: 1, simulated: 0, failed: 0 });

    const row = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: short!.id } });
    expect(row).toMatchObject({
      status: "SENT",
      provider: "solapi",
      providerMessageId: "M4V20261127110044DTYYJBBYLPQZIB1",
      attempts: 1,
      error: null,
    });
    expect(row.sentAt).toBeInstanceOf(Date);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("https://api.solapi.com/messages/v4/send-many/detail");
    expect(call[1]?.method).toBe("POST");
    expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(bodyOf(call)).toEqual({
      messages: [{ to: "01012345678", from: "0421234567", text: "예약이 확정됐어요", type: "SMS" }],
      showMessageList: true,
    });

    const auth = headersOf(call).Authorization!;
    const match = /^HMAC-SHA256 apiKey=([^,]+), date=([^,]+), salt=([0-9a-f]+), signature=([0-9a-f]{64})$/.exec(auth);
    expect(match).not.toBeNull();
    const [, apiKey, date, salt, signature] = match!;
    expect(apiKey).toBe(SOLAPI_ENV.SOLAPI_API_KEY);
    expect(Number.isNaN(Date.parse(date!))).toBe(false);
    expect(salt!.length).toBeGreaterThanOrEqual(12);
    expect(signature).toBe(createHmac("sha256", SOLAPI_ENV.SOLAPI_API_SECRET).update(date! + salt!).digest("hex"));
  });

  it("90바이트를 넘는 본문은 장문(LMS)으로, 알림톡 채널도 일반 문자로 보낸다", async () => {
    const mod = await loadOutboxWithEnv({ ...SOLAPI_ENV, SOLAPI_KAKAO_PFID: "KA01PF000000000000000000000000000" });
    const fetchMock = vi.fn(async (..._args: FetchArgs) => solapiOk());
    vi.stubGlobal("fetch", fetchMock);
    const longText = "가".repeat(46);
    expect(smsByteLength("가".repeat(45))).toBe(90);
    expect(smsByteLength(longText)).toBe(92);

    await mod.enqueueMessage(smsInput({ body: longText, scheduledAt: new Date(Date.now() - 2000) }));
    await mod.enqueueMessage(smsInput({ channel: "ALIMTALK", body: "짧은 알림", scheduledAt: new Date(Date.now() - 1000) }));
    expect(await mod.dispatchOutbox()).toEqual({ sent: 2, simulated: 0, failed: 0 });

    const messages = fetchMock.mock.calls.map((c) => (bodyOf(c).messages as Record<string, unknown>[])[0]!);
    const long = messages.find((m) => m.text === longText)!;
    const alimtalk = messages.find((m) => m.text === "짧은 알림")!;
    expect(long).toMatchObject({ type: "LMS", subject: "남는자리" });
    expect(alimtalk).toEqual({ to: "01012345678", from: "0421234567", text: "짧은 알림", type: "SMS" });
    expect(alimtalk).not.toHaveProperty("kakaoOptions");
  });

  it("일시적인 실패는 간격을 두고 다시 시도하고, 세 번 실패하면 FAILED 로 닫는다", async () => {
    const mod = await loadOutboxWithEnv(SOLAPI_ENV);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(
      async (..._args: FetchArgs) =>
        new Response(JSON.stringify({ errorCode: "InternalError", errorMessage: "01012345678 처리 중 오류가 발생했습니다." }), { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const row = await mod.enqueueMessage(smsInput());
    const reload = () => prisma.messageOutbox.findUniqueOrThrow({ where: { id: row!.id } });
    const makeDue = () => prisma.messageOutbox.update({ where: { id: row!.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });

    // 1차 실패 → 1분 뒤 재시도
    expect(await mod.dispatchOutbox()).toEqual({ sent: 0, simulated: 0, failed: 1 });
    let current = await reload();
    expect(current).toMatchObject({ status: "QUEUED", attempts: 1, provider: "solapi" });
    expect(current.error).toContain("SOLAPI 500 InternalError");
    // 오류 문구에 수신 번호를 남기지 않는다.
    expect(current.error).not.toContain("01012345678");
    expect(current.scheduledAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(current.scheduledAt.getTime()).toBeLessThan(Date.now() + 90_000);

    // 재시도 시각 전에는 다시 보내지 않는다.
    expect(await mod.dispatchOutbox()).toEqual({ sent: 0, simulated: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2차 실패 → 5분 뒤 재시도
    await makeDue();
    expect(await mod.dispatchOutbox()).toEqual({ sent: 0, simulated: 0, failed: 1 });
    current = await reload();
    expect(current).toMatchObject({ status: "QUEUED", attempts: 2 });
    expect(current.scheduledAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);

    // 3차 실패 → FAILED
    await makeDue();
    expect(await mod.dispatchOutbox()).toEqual({ sent: 0, simulated: 0, failed: 1 });
    current = await reload();
    expect(current).toMatchObject({ status: "FAILED", attempts: 3 });
    expect(current.sentAt).toBeNull();

    await makeDue();
    expect(await mod.dispatchOutbox()).toEqual({ sent: 0, simulated: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 로그에도 수신 번호·본문을 남기지 않는다.
    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).not.toContain("01012345678");
    expect(logged).not.toContain("테스트 문자예요");
  });

  it("재시도 중 성공하면 SENT 가 된다(네트워크 오류 → 성공)", async () => {
    const mod = await loadOutboxWithEnv(SOLAPI_ENV);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn<(...args: FetchArgs) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(solapiOk("M4V-RETRY"));
    vi.stubGlobal("fetch", fetchMock);
    const row = await mod.enqueueMessage(smsInput());

    expect(await mod.dispatchOutbox()).toEqual({ sent: 0, simulated: 0, failed: 1 });
    await prisma.messageOutbox.update({ where: { id: row!.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
    expect(await mod.dispatchOutbox()).toEqual({ sent: 1, simulated: 0, failed: 0 });
    expect(await prisma.messageOutbox.findUniqueOrThrow({ where: { id: row!.id } })).toMatchObject({
      status: "SENT",
      attempts: 2,
      providerMessageId: "M4V-RETRY",
      error: null,
    });
  });

  it("다시 시도해도 소용없는 오류(요청 오류·접수 거절)는 바로 FAILED 로 닫는다", async () => {
    const mod = await loadOutboxWithEnv(SOLAPI_ENV);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn<(...args: FetchArgs) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ errorCode: "ValidationError", errorMessage: "text 는 필수입니다." }), { status: 400 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            groupInfo: { groupId: "G4V-X", count: { total: 1, registeredSuccess: 0, registeredFailed: 1 } },
            failedMessageList: [{ to: "01012345678", from: "0421234567", statusCode: "3040", statusMessage: "등록되지 않은 발신번호입니다." }],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const first = await mod.enqueueMessage(smsInput({ scheduledAt: new Date(Date.now() - 2000) }));
    expect(await mod.dispatchOutbox({ limit: 1 })).toEqual({ sent: 0, simulated: 0, failed: 1 });
    const second = await mod.enqueueMessage(smsInput());
    expect(await mod.dispatchOutbox({ limit: 1 })).toEqual({ sent: 0, simulated: 0, failed: 1 });

    const a = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: first!.id } });
    const b = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: second!.id } });
    expect(a).toMatchObject({ status: "FAILED", attempts: 1, error: "SOLAPI 400 ValidationError: text 는 필수입니다." });
    expect(b).toMatchObject({ status: "FAILED", attempts: 1, error: "SOLAPI 접수 실패 3040: 등록되지 않은 발신번호입니다." });
  });

  it("연동을 켰는데 키가 빠져 있으면 보낸 척하지 않고 FAILED 로 남긴다", async () => {
    const mod = await loadOutboxWithEnv({ SMS_PROVIDER: "solapi", SOLAPI_API_KEY: "", SOLAPI_API_SECRET: "", SOLAPI_SENDER: "" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(mod.getMessagingProviderStatus().sms).toEqual({ provider: "solapi", configured: false });

    const row = await mod.enqueueMessage(smsInput());
    expect(await mod.dispatchOutbox()).toEqual({ sent: 0, simulated: 0, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    const after = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: row!.id } });
    expect(after.status).toBe("FAILED");
    expect(after.error).toContain("SOLAPI_API_KEY");
  });

  it("동시에 여러 발송기가 돌아도 한 건을 두 번 보내지 않는다", async () => {
    const mod = await loadOutboxWithEnv(SOLAPI_ENV);
    const sentTo: string[] = [];
    const fetchMock = vi.fn(async (...args: FetchArgs) => {
      const to = (bodyOf(args).messages as { to: string }[])[0]!.to;
      await new Promise((resolve) => setTimeout(resolve, 5));
      sentTo.push(to);
      return solapiOk(`M-${to}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const total = 40;
    const recipients = Array.from({ length: total }, (_, i) => `0107000${String(1000 + i)}`);
    await prisma.messageOutbox.createMany({
      data: recipients.map((recipient) => ({ channel: "SMS" as const, recipient, templateKey: "TEST", body: "동시 발송 테스트" })),
    });

    const results = await Promise.all([
      mod.dispatchOutbox({ limit: 40 }),
      mod.dispatchOutbox({ limit: 40 }),
      mod.dispatchOutbox({ limit: 40 }),
      mod.dispatchOutbox({ limit: 40 }),
    ]);
    expect(results.reduce((sum, r) => sum + r.sent, 0)).toBe(total);
    expect(results.every((r) => r.failed === 0 && r.simulated === 0)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(total);
    expect([...sentTo].sort()).toEqual([...recipients].sort());

    const rows = await prisma.messageOutbox.findMany();
    expect(rows).toHaveLength(total);
    expect(rows.every((r) => r.status === "SENT" && r.attempts === 1)).toBe(true);
    for (const r of rows) expect(r.providerMessageId).toBe(`M-${r.recipient}`);
  });
});

describe("dispatchOutbox — Resend 연동", () => {
  it("이메일을 Resend 로 보내고, 같은 건의 재시도에는 같은 멱등 키를 쓴다", async () => {
    const mod = await loadOutboxWithEnv({ RESEND_API_KEY: "re_test_key", EMAIL_FROM: "남는자리 <no-reply@namneunjari.kr>" });
    expect(mod.getMessagingProviderStatus().email).toEqual({ provider: "resend", configured: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn<(...args: FetchArgs) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests" }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const row = await mod.enqueueMessage({ channel: "EMAIL", recipient: "owner@example.com", templateKey: "PLATFORM_BUSINESS_APPROVED", subject: "입점이 승인됐어요", body: "본문" });
    // 문자는 여전히 미연동이므로 기록만 남는다.
    const sms = await mod.enqueueMessage(smsInput());

    expect(await mod.dispatchOutbox()).toEqual({ sent: 0, simulated: 1, failed: 1 });
    expect((await prisma.messageOutbox.findUniqueOrThrow({ where: { id: row!.id } })).error).toBe("Resend 429 rate_limit_exceeded: Too many requests");
    expect((await prisma.messageOutbox.findUniqueOrThrow({ where: { id: sms!.id } })).status).toBe("SIMULATED");

    await prisma.messageOutbox.update({ where: { id: row!.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
    expect(await mod.dispatchOutbox()).toEqual({ sent: 1, simulated: 0, failed: 0 });
    expect(await prisma.messageOutbox.findUniqueOrThrow({ where: { id: row!.id } })).toMatchObject({
      status: "SENT",
      provider: "resend",
      providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    });

    const [firstCall, secondCall] = fetchMock.mock.calls as [FetchArgs, FetchArgs];
    expect(String(firstCall[0])).toBe("https://api.resend.com/emails");
    expect(headersOf(firstCall).Authorization).toBe("Bearer re_test_key");
    expect(bodyOf(firstCall)).toEqual({
      from: "남는자리 <no-reply@namneunjari.kr>",
      to: ["owner@example.com"],
      subject: "입점이 승인됐어요",
      text: "본문",
    });
    expect(headersOf(firstCall)["Idempotency-Key"]).toBe(`outbox-${row!.id}`);
    expect(headersOf(secondCall)["Idempotency-Key"]).toBe(`outbox-${row!.id}`);
  });
});

describe("SOLAPI 인증 헤더", () => {
  it("date + salt 를 시크릿으로 서명한다", () => {
    const date = new Date("2026-11-27T05:00:00.000Z");
    const header = buildSolapiAuthHeader("KEY", "SECRET", date, "abcdef0123456789");
    const expected = createHmac("sha256", "SECRET").update("2026-11-27T05:00:00.000Zabcdef0123456789").digest("hex");
    expect(header).toBe(`HMAC-SHA256 apiKey=KEY, date=2026-11-27T05:00:00.000Z, salt=abcdef0123456789, signature=${expected}`);
    // salt 는 요청마다 달라진다.
    expect(buildSolapiAuthHeader("KEY", "SECRET", date)).not.toBe(buildSolapiAuthHeader("KEY", "SECRET", date));
  });
});

describe("발송 내역 조회", () => {
  it("사업장별로 걸러 보여 주고 수신처는 가린다. 다른 사업장 구성원은 볼 수 없다", async () => {
    const { business, owner } = await createBusiness();
    const { business: otherBiz, owner: otherOwner } = await createBusiness();
    await enqueueMessage(smsInput({ businessId: business.id, templateKey: "BOOKING_CONFIRMED", recipient: "01099998888" }));
    await enqueueMessage({ businessId: business.id, channel: "EMAIL", recipient: "hong@example.com", templateKey: "PLATFORM_X", subject: "제목", body: "본문" });
    await enqueueMessage(smsInput({ businessId: otherBiz.id }));
    await enqueueMessage(smsInput());
    await dispatchOutbox({ limit: 1 });

    const mine = await listBusinessOutbox(owner.id, business.id);
    expect(mine.items).toHaveLength(2);
    expect(mine.items.every((m) => m.businessId === business.id)).toBe(true);
    expect(mine.items.map((m) => m.recipientMasked).sort()).toEqual(["010-****-8888", "ho**@example.com"]);
    expect(mine.items[0]).not.toHaveProperty("recipient");

    await expect(listBusinessOutbox(otherOwner.id, business.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const all = await listOutbox({ limit: 3 });
    expect(all.items).toHaveLength(3);
    expect(all.nextCursor).not.toBeNull();
    const rest = await listOutbox({ limit: 3, cursor: all.nextCursor! });
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();

    expect((await listOutbox({ status: "SIMULATED" })).items).toHaveLength(1);
    expect((await listOutbox({ channel: "EMAIL" })).items).toHaveLength(1);

    const stats = await getOutboxStats();
    expect(stats.total).toBe(4);
    expect(stats.byStatus).toEqual({ QUEUED: 3, SENT: 0, SIMULATED: 1, FAILED: 0, SKIPPED: 0 });
    expect(stats.byChannel).toEqual({ SMS: 3, ALIMTALK: 0, EMAIL: 1 });
    expect(stats.oldestQueuedAt).toBeInstanceOf(Date);
    expect(stats.providers.sms.provider).toBe("none");
    expect((await getOutboxStats({ businessId: business.id })).total).toBe(2);
  });
});

// ───────────────────────── 보관 기한·정리 ─────────────────────────

describe("인증 메시지 본문 지우기 · 보관 기한 정리", () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
  const daysAgo = (days: number) => hoursAgo(days * 24);

  const outboxRow = (templateKey: string, status: "QUEUED" | "SENT" | "SIMULATED" | "FAILED" | "SKIPPED", createdAt: Date, body = "본문") =>
    prisma.messageOutbox.create({ data: { channel: "EMAIL", recipient: "haneul@example.com", templateKey, body, status, createdAt } });
  const bodyOfRow = async (id: string) => (await prisma.messageOutbox.findUniqueOrThrow({ where: { id } })).body;

  it("scrubSensitiveOutbox: 발송이 끝난 인증 메시지는 한 시간이 지나면 본문을 지운다", async () => {
    const link = "http://localhost:3000/reset-password?token=SECRET-TOKEN";
    const sent = await outboxRow(CREDENTIAL_TEMPLATE_KEYS.PASSWORD_RESET, "SENT", hoursAgo(2), link);
    const simulated = await outboxRow(CREDENTIAL_TEMPLATE_KEYS.PHONE_OTP, "SIMULATED", hoursAgo(3), "인증번호 123456");
    const failed = await outboxRow(CREDENTIAL_TEMPLATE_KEYS.EMAIL_VERIFY, "FAILED", hoursAgo(30), link);
    const skipped = await outboxRow(CREDENTIAL_TEMPLATE_KEYS.PASSWORD_RESET, "SKIPPED", hoursAgo(1.5), link);
    // 지우지 않는 것: 한 시간이 안 된 것, 아직 보내지 않은 것, 인증 메시지가 아닌 것
    const fresh = await outboxRow(CREDENTIAL_TEMPLATE_KEYS.PASSWORD_RESET, "SENT", hoursAgo(0.5), link);
    const queued = await outboxRow(CREDENTIAL_TEMPLATE_KEYS.PASSWORD_RESET, "QUEUED", hoursAgo(2), link);
    const ordinary = await outboxRow("PLATFORM_BOOKING_CONFIRMED", "SENT", daysAgo(3), "예약이 확정됐어요");

    expect(await scrubSensitiveOutbox()).toBe(4);
    for (const row of [sent, simulated, failed, skipped]) expect(await bodyOfRow(row.id)).toBe(CREDENTIAL_BODY_PLACEHOLDER);
    expect(await bodyOfRow(fresh.id)).toBe(link);
    expect(await bodyOfRow(queued.id)).toBe(link);
    expect(await bodyOfRow(ordinary.id)).toBe("예약이 확정됐어요");
    // 발송 이력은 그대로 남는다.
    expect(await prisma.messageOutbox.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({
      status: "SENT",
      recipient: "haneul@example.com",
      templateKey: CREDENTIAL_TEMPLATE_KEYS.PASSWORD_RESET,
    });

    // 다시 돌려도 더 지울 것이 없고, 기준 시각을 넘기면 그 시각으로 판단한다.
    expect(await scrubSensitiveOutbox()).toBe(0);
    expect(await scrubSensitiveOutbox(new Date(Date.now() + HOUR_MS))).toBe(1);
    expect(await bodyOfRow(fresh.id)).toBe(CREDENTIAL_BODY_PLACEHOLDER);

    // 아직 지우지 않은 인증 메시지도 발송 내역 화면에서는 같은 문구로 가려진다(목록은 한곳에서 관리).
    const listed = (await listOutbox()).items;
    expect(listed.find((item) => item.id === queued.id)?.body).toBe(CREDENTIAL_BODY_PLACEHOLDER);
    expect(listed.find((item) => item.id === ordinary.id)?.body).toBe("예약이 확정됐어요");
  });

  it("비밀번호 재설정 메일도 발송 뒤에는 본문(링크)이 지워진다", async () => {
    const user = await createUser({ email: "haneul@example.com" });
    await enqueueMessage({
      userId: user.id,
      channel: "EMAIL",
      recipient: user.email,
      templateKey: CREDENTIAL_TEMPLATE_KEYS.PASSWORD_RESET,
      subject: "[남는자리] 비밀번호 재설정 안내",
      body: "http://localhost:3000/reset-password?token=ONE-TIME-TOKEN",
    });
    expect(await dispatchOutbox()).toEqual({ sent: 0, simulated: 1, failed: 0 });
    expect(await scrubSensitiveOutbox()).toBe(0);
    expect(await scrubSensitiveOutbox(new Date(Date.now() + 61 * 60_000))).toBe(1);
    const row = await prisma.messageOutbox.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.body).not.toContain("ONE-TIME-TOKEN");
    expect(row).toMatchObject({ status: "SIMULATED", subject: "[남는자리] 비밀번호 재설정 안내" });
  });

  it("purgeOldNotifications: 읽은 알림은 180일, 발송 내역은 365일이 지나면 지운다", async () => {
    const user = await createUser();
    const notice = (createdAt: Date, readAt: Date | null) =>
      prisma.notification.create({ data: { userId: user.id, type: "SYSTEM", title: "안내", body: "내용", createdAt, readAt } });
    const oldRead = await notice(daysAgo(NOTIFICATION_RETENTION_DAYS + 1), daysAgo(NOTIFICATION_RETENTION_DAYS));
    const oldUnread = await notice(daysAgo(NOTIFICATION_RETENTION_DAYS + 60), null);
    const recentRead = await notice(daysAgo(NOTIFICATION_RETENTION_DAYS - 1), new Date());
    const oldSent = await outboxRow("PLATFORM_NOTICE", "SENT", daysAgo(OUTBOX_RETENTION_DAYS + 1));
    const oldQueued = await outboxRow("PLATFORM_NOTICE", "QUEUED", daysAgo(OUTBOX_RETENTION_DAYS + 1));
    const recentSent = await outboxRow("PLATFORM_NOTICE", "SENT", daysAgo(OUTBOX_RETENTION_DAYS - 1));

    expect(await purgeOldNotifications()).toEqual({ notifications: 1, outbox: 1 });
    const noticeIds = (await prisma.notification.findMany({ select: { id: true } })).map((n) => n.id).sort();
    expect(noticeIds).toEqual([oldUnread.id, recentRead.id].sort());
    expect(noticeIds).not.toContain(oldRead.id);
    const outboxIds = (await prisma.messageOutbox.findMany({ select: { id: true } })).map((m) => m.id).sort();
    expect(outboxIds).toEqual([oldQueued.id, recentSent.id].sort());
    expect(outboxIds).not.toContain(oldSent.id);

    // 다시 돌려도 결과가 같고, 기준 시각을 넘기면 그 시각으로 판단한다.
    expect(await purgeOldNotifications()).toEqual({ notifications: 0, outbox: 0 });
    expect(await purgeOldNotifications(new Date(Date.now() + 2 * 24 * HOUR_MS))).toEqual({ notifications: 1, outbox: 1 });
    expect(await prisma.notification.count()).toBe(1);
  });
});

// ───────────────────────── 사업자 템플릿 ─────────────────────────

describe("템플릿", () => {
  it("변수를 값으로 바꾸고, 모르는 변수·값이 없는 변수는 비운다", () => {
    const text = renderTemplate("[#{상호}] #{고객명}님, #{일시}에 만나요. #{없는변수}#{ 인원 }", {
      상호: "둔산 소셜클럽",
      고객명: "김하늘",
      일시: "11월 27일 (금) 19:30",
      인원: "2명",
    });
    expect(text).toBe("[둔산 소셜클럽] 김하늘님, 11월 27일 (금) 19:30에 만나요. 2명");
    expect(renderTemplate("장소: #{장소}\n#{링크}", {})).toBe("장소:");
    // 값 안의 변수 표기는 다시 해석하지 않는다.
    expect(renderTemplate("#{고객명}님", { 고객명: "#{링크}", 링크: "https://x" })).toBe("#{링크}님");
    expect(findUnknownVariables("#{고객명} #{고객이름} #{쿠폰}")).toEqual(["#{고객이름}", "#{쿠폰}"]);
  });

  it("기본 템플릿은 지원하는 변수만 쓰고, 설정 화면용 정보가 모든 키에 있다", () => {
    expect(TEMPLATE_VARIABLES.map((v) => v.token)).toEqual([
      "#{고객명}",
      "#{상호}",
      "#{상품명}",
      "#{일시}",
      "#{장소}",
      "#{인원}",
      "#{예약번호}",
      "#{링크}",
    ]);
    expect(TEMPLATE_KEYS.map((k) => k.key)).toEqual([...SELLER_TEMPLATE_KEYS]);
    for (const key of SELLER_TEMPLATE_KEYS) {
      const template = DEFAULT_TEMPLATES[key];
      expect(findUnknownVariables(template.body)).toEqual([]);
      expect(template.body.length).toBeLessThanOrEqual(500);
      expect(renderTemplate(template.body, TEMPLATE_SAMPLE_VARS)).not.toContain("#{");
    }
    expect(DEFAULT_TEMPLATES.REMINDER_DAY_BEFORE.offsetMinutes).toBe(1440);
    expect(DEFAULT_TEMPLATES.REMINDER_HOURS_BEFORE.offsetMinutes).toBe(180);
  });

  it("저장한 설정이 없으면 기본값을 돌려준다", async () => {
    const { business } = await createBusiness();
    const templates = await getBusinessTemplates(business.id);
    expect(templates.map((t) => t.key)).toEqual([...SELLER_TEMPLATE_KEYS]);
    const confirmed = templates.find((t) => t.key === "BOOKING_CONFIRMED")!;
    expect(confirmed).toMatchObject({
      body: DEFAULT_TEMPLATES.BOOKING_CONFIRMED.body,
      isEnabled: true,
      offsetMinutes: null,
      isCustomized: false,
      canCustomize: false,
      updatedAt: null,
    });
    expect(templates.find((t) => t.key === "REMINDER_DAY_BEFORE")!.offsetMinutes).toBe(1440);
    await expect(getBusinessTemplates("no-such-business")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("매니저 이상만 저장할 수 있다(스태프·다른 사업장 회원은 거절)", async () => {
    const { business } = await createBusiness({ plan: "PRO" });
    const staff = await createUser();
    const manager = await createUser();
    const outsider = await createUser();
    const { owner: otherOwner } = await createBusiness({ plan: "PRO" });
    await prisma.businessMember.createMany({
      data: [
        { businessId: business.id, userId: staff.id, role: "STAFF" },
        { businessId: business.id, userId: manager.id, role: "MANAGER" },
      ],
    });
    const input = { body: "#{고객명}님, 예약이 확정됐어요.", isEnabled: true };

    for (const actor of [staff, outsider, otherOwner]) {
      await expect(saveBusinessTemplate(actor.id, business.id, "BOOKING_CONFIRMED", input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await prisma.messageTemplate.count()).toBe(0);

    const saved = await saveBusinessTemplate(manager.id, business.id, "BOOKING_CONFIRMED", input);
    expect(saved).toMatchObject({ body: input.body, isCustomized: true, canCustomize: true, isEnabled: true });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "message_template.update" } });
    expect(log).toMatchObject({ actorId: manager.id, actorType: "SELLER", targetType: "Business", targetId: business.id });
    expect(log.meta).toMatchObject({ key: "BOOKING_CONFIRMED", bodyChanged: true });
  });

  it("베이직 플랜에서는 발송 여부만 바꿀 수 있다", async () => {
    const { business, owner } = await createBusiness();
    const base = DEFAULT_TEMPLATES.REMINDER_DAY_BEFORE;

    await expect(
      saveBusinessTemplate(owner.id, business.id, "REMINDER_DAY_BEFORE", { body: "내 마음대로 쓴 문구", isEnabled: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      saveBusinessTemplate(owner.id, business.id, "REMINDER_DAY_BEFORE", { body: base.body, isEnabled: true, offsetMinutes: 2880 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.messageTemplate.count()).toBe(0);

    // 기본 문구 그대로면(줄바꿈 표기 차이는 무시) 끄고 켜는 것은 된다.
    const off = await saveBusinessTemplate(owner.id, business.id, "REMINDER_DAY_BEFORE", {
      body: base.body.replace(/\n/g, "\r\n"),
      isEnabled: false,
      offsetMinutes: 1440,
    });
    expect(off).toMatchObject({ isEnabled: false, body: base.body, offsetMinutes: 1440, isCustomized: false, canCustomize: false });
    expect((await getBusinessTemplate(business.id, "REMINDER_DAY_BEFORE")).isEnabled).toBe(false);
  });

  it("프로 플랜은 문구와 발송 시점을 바꿀 수 있고, 베이직으로 내려가면 기본 문구로 돌아간다", async () => {
    const { business, owner } = await createBusiness({ plan: "PRO" });
    const custom = "[#{상호}] #{고객명}님, 모레 #{일시}에 뵐게요.";
    const saved = await saveBusinessTemplate(owner.id, business.id, "REMINDER_DAY_BEFORE", { body: custom, isEnabled: true, offsetMinutes: 2880 });
    expect(saved).toMatchObject({ body: custom, offsetMinutes: 2880, isCustomized: true });

    await prisma.business.update({ where: { id: business.id }, data: { plan: "FREE" } });
    const downgraded = await getBusinessTemplate(business.id, "REMINDER_DAY_BEFORE");
    expect(downgraded).toMatchObject({ body: DEFAULT_TEMPLATES.REMINDER_DAY_BEFORE.body, offsetMinutes: 1440, isCustomized: false, canCustomize: false });

    // 베이직에서 끄고 켜도 저장해 둔 문구는 지워지지 않는다.
    await saveBusinessTemplate(owner.id, business.id, "REMINDER_DAY_BEFORE", { body: DEFAULT_TEMPLATES.REMINDER_DAY_BEFORE.body, isEnabled: false });
    await prisma.business.update({ where: { id: business.id }, data: { plan: "PRO" } });
    expect(await getBusinessTemplate(business.id, "REMINDER_DAY_BEFORE")).toMatchObject({ body: custom, offsetMinutes: 2880, isEnabled: false });
  });

  it("입력 검증: 500자 초과·빈 문구·모르는 변수·범위를 벗어난 발송 시점·없는 키", async () => {
    const { business, owner } = await createBusiness({ plan: "PRO" });
    const save = (key: string, input: { body: string; isEnabled: boolean; offsetMinutes?: number }) =>
      saveBusinessTemplate(owner.id, business.id, key, input);

    await expect(save("BOOKING_CONFIRMED", { body: "가".repeat(501), isEnabled: true })).rejects.toThrow();
    await expect(save("BOOKING_CONFIRMED", { body: "   ", isEnabled: true })).rejects.toThrow();
    await expect(save("BOOKING_CONFIRMED", { body: "#{고객이름}님 안녕하세요", isEnabled: true })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(save("REMINDER_HOURS_BEFORE", { body: "곧 만나요", isEnabled: true, offsetMinutes: 10 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(save("REMINDER_DAY_BEFORE", { body: "곧 만나요", isEnabled: true, offsetMinutes: 60 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(save("NOT_A_TEMPLATE", { body: "문구", isEnabled: true })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await prisma.messageTemplate.count()).toBe(0);

    expect((await save("BOOKING_CONFIRMED", { body: "가".repeat(500), isEnabled: true })).body).toHaveLength(500);
    // 리마인드가 아닌 템플릿은 발송 시점을 저장하지 않는다.
    expect((await save("REVIEW_REQUEST", { body: "후기 부탁드려요 #{링크}", isEnabled: true, offsetMinutes: 120 })).offsetMinutes).toBeNull();
  });

  it("buildBookingTemplateVars: 예약 정보로 변수 값을 만든다", () => {
    const startAt = kstDate(2026, 11, 27, 19, 30);
    const source = {
      code: "NJ-7K3M9Q",
      userId: "u1" as string | null,
      guestName: "김하늘",
      quantity: 2,
      business: { name: "둔산 소셜클럽", slug: "dunsan-social", address: "대전 서구 둔산로 1" },
      product: { title: "금요 와인 소셜", placeName: "라운지 2층", address: null },
      slot: { startAt },
    };
    expect(buildBookingTemplateVars(source)).toEqual({
      고객명: "김하늘",
      상호: "둔산 소셜클럽",
      상품명: "금요 와인 소셜",
      일시: "11월 27일 (금) 19:30",
      장소: "라운지 2층 · 대전 서구 둔산로 1",
      인원: "2명",
      예약번호: "NJ-7K3M9Q",
      링크: "http://localhost:3000/my/bookings/NJ-7K3M9Q",
    });
    // 비회원(직접 입력) 예약은 로그인이 필요한 예약 상세 대신 사업장 페이지로 보낸다.
    expect(buildBookingTemplateVars({ ...source, userId: null }).링크).toBe("http://localhost:3000/b/dunsan-social");
  });
});

// ───────────────────────── 예약 이벤트 ─────────────────────────

describe("예약 이벤트 알림", () => {
  const inbox = (userId: string) => prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  const outboxOf = (templateKey: string) => prisma.messageOutbox.findMany({ where: { templateKey } });

  it("예약 확정: 고객에게 앱 알림 + 사업자 템플릿 문자, 사업장 구성원 모두에게 새 예약 알림", async () => {
    const listing = await createListing();
    const staff = await createUser();
    await prisma.businessMember.create({ data: { businessId: listing.business.id, userId: staff.id, role: "STAFF" } });
    const customer = await createUser({ name: "김하늘", phone: "01022223333" });
    const booking = await createBooking(listing, customer);

    await onBookingConfirmed(booking.id);

    const [mine] = await inbox(customer.id);
    expect(mine).toMatchObject({ type: "BOOKING_CONFIRMED", title: "예약이 확정됐어요", linkUrl: `/my/bookings/${booking.code}` });
    expect(mine!.body).toContain(listing.product.title);
    expect(mine!.body).toContain(fmtDateTime(listing.slot.startAt));
    expect(mine!.data).toMatchObject({ bookingId: booking.id, code: booking.code, slotId: listing.slot.id });

    const [sms] = await outboxOf("BOOKING_CONFIRMED");
    expect(sms).toMatchObject({ userId: customer.id, businessId: listing.business.id, channel: "SMS", recipient: "01022223333", status: "QUEUED", isAdvertising: false });
    expect(sms!.body).toContain(`[${listing.business.name}] 김하늘님, 예약이 확정됐어요.`);
    expect(sms!.body).toContain(`예약번호: ${booking.code}`);
    expect(sms!.body).toContain(`http://localhost:3000/my/bookings/${booking.code}`);
    expect(sms!.body).not.toContain("#{");
    expect(await outboxOf("PLATFORM_BOOKING_CONFIRMED")).toHaveLength(0);

    for (const member of [listing.owner, staff]) {
      const [n] = await inbox(member.id);
      expect(n).toMatchObject({ type: "SELLER_NEW_BOOKING", title: "새 예약이 들어왔어요", linkUrl: `/seller/bookings/${booking.id}` });
      expect(n!.body).toContain("김하늘님");
    }

    // 같은 이벤트가 두 번 와도(웹훅 재전송 등) 알림은 한 번만 나간다.
    await onBookingConfirmed(booking.id);
    expect(await prisma.notification.count()).toBe(3);
    expect(await prisma.messageOutbox.count()).toBe(1);
  });

  it("사업자가 템플릿을 껐거나 한도를 넘겼으면 남는자리 기본 안내로 보낸다", async () => {
    await setSettings({ freeMonthlyMessages: 1 });
    const listing = await createListing();
    const customer = await createUser({ phone: "01022223333" });

    // 1) 한도 안: 사업자 템플릿으로
    const first = await createBooking(listing, customer);
    await onBookingConfirmed(first.id);
    // 2) 한도 초과: 사업자 건은 SKIPPED 로 남고 기본 안내가 나간다
    const nextSlot = await createSlot(listing.product, [{ capacity: 4 }], { startsInHours: 72 });
    const second = await createBooking({ ...listing, slot: nextSlot, seat: nextSlot.seats[0]! }, customer);
    await onBookingConfirmed(second.id);

    const sellerRows = await prisma.messageOutbox.findMany({ where: { templateKey: "BOOKING_CONFIRMED" }, orderBy: { createdAt: "asc" } });
    expect(sellerRows.map((r) => r.status)).toEqual(["QUEUED", "SKIPPED"]);
    const fallback = await outboxOf("PLATFORM_BOOKING_CONFIRMED");
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({ status: "QUEUED", businessId: listing.business.id, recipient: "01022223333" });
    expect(fallback[0]!.body).toContain("[남는자리] 예약이 확정됐어요.");
    expect(fallback[0]!.body).toContain(`예약번호 ${second.code}`);

    // 3) 템플릿을 끈 사업장: 처음부터 기본 안내
    const quiet = await createListing();
    await saveBusinessTemplate(quiet.owner.id, quiet.business.id, "BOOKING_CONFIRMED", {
      body: DEFAULT_TEMPLATES.BOOKING_CONFIRMED.body,
      isEnabled: false,
    });
    const third = await createBooking(quiet, customer);
    await onBookingConfirmed(third.id);
    expect(await prisma.messageOutbox.count({ where: { businessId: quiet.business.id, templateKey: "BOOKING_CONFIRMED" } })).toBe(0);
    expect(await prisma.messageOutbox.count({ where: { businessId: quiet.business.id, templateKey: "PLATFORM_BOOKING_CONFIRMED" } })).toBe(1);
  });

  it("예약 문자를 끈 고객에게는 확정 문자를 보내지 않는다(사업자 한도도 쓰지 않음)", async () => {
    const listing = await createListing();
    const customer = await createUser({ notificationPrefs: { bookingSms: false } });
    const booking = await createBooking(listing, customer);
    await onBookingConfirmed(booking.id);
    expect(await prisma.notification.count({ where: { userId: customer.id } })).toBe(1);
    expect(await prisma.messageOutbox.count()).toBe(0);
  });

  it("사업자가 직접 넣은 비회원 예약: 고객 문자만 보내고 사업자에게는 다시 알리지 않는다", async () => {
    const listing = await createListing();
    const booking = await createBooking(listing, null, { channel: "MANUAL", guestName: "박손님", guestPhone: "010-4444-5555", paymentMethod: "ONSITE", paymentState: "UNPAID", payNowAmount: 0, payOnsiteAmount: 60000 });
    await onBookingConfirmed(booking.id);

    expect(await prisma.notification.count()).toBe(0);
    const [sms] = await outboxOf("BOOKING_CONFIRMED");
    expect(sms).toMatchObject({ userId: null, recipient: "01044445555" });
    expect(sms!.body).toContain("박손님님");
    expect(sms!.body).toContain(`http://localhost:3000/b/${listing.business.slug}`);
  });

  it("승인제: 요청 시 고객·사업자에게 알리고, 승인되면 승인 알림을 보낸다", async () => {
    const listing = await createListing();
    const customer = await createUser();
    const booking = await createBooking(listing, customer, { status: "PENDING_APPROVAL", confirmedAt: null });

    await onBookingPendingApproval(booking.id);
    expect((await inbox(customer.id)).map((n) => n.type)).toEqual(["BOOKING_PENDING_APPROVAL"]);
    const [ask] = await inbox(listing.owner.id);
    expect(ask).toMatchObject({ type: "SELLER_APPROVAL_NEEDED", linkUrl: `/seller/bookings/${booking.id}` });
    expect(await prisma.messageOutbox.count()).toBe(0);

    await prisma.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED", confirmedAt: new Date() } });
    await onBookingApproved(booking.id);
    const mine = await inbox(customer.id);
    expect(mine.map((n) => n.type)).toEqual(["BOOKING_PENDING_APPROVAL", "BOOKING_APPROVED"]);
    expect(mine[1]!.title).toBe("예약이 승인됐어요");
    // 방금 승인한 사업자에게 "새 예약" 알림을 또 보내지 않는다.
    expect((await inbox(listing.owner.id)).map((n) => n.type)).toEqual(["SELLER_APPROVAL_NEEDED"]);
    expect(await prisma.messageOutbox.count({ where: { templateKey: "BOOKING_CONFIRMED" } })).toBe(1);
  });

  it("거절·시간 초과: 고객에게 알린다(거절은 환불 안내와 문자 포함)", async () => {
    const listing = await createListing();
    const customer = await createUser();
    const rejected = await createBooking(listing, customer, { status: "REJECTED", refundAmount: 60000 });
    await onBookingRejected(rejected.id);
    const [n1] = await inbox(customer.id);
    expect(n1).toMatchObject({ type: "BOOKING_REJECTED" });
    expect(n1!.body).toContain("결제하신 60,000원은 전액 환불돼요.");
    expect(await outboxOf("PLATFORM_BOOKING_REJECTED")).toHaveLength(1);

    const expired = await createBooking(listing, customer, { status: "EXPIRED", paymentState: "UNPAID" });
    await onBookingExpired(expired.id);
    const n2 = (await inbox(customer.id)).find((n) => n.type === "BOOKING_EXPIRED");
    expect(n2).toMatchObject({ title: "결제 시간이 지나 예약이 취소됐어요", linkUrl: `/slots/${listing.slot.id}` });
    expect(await prisma.messageOutbox.count()).toBe(1);
  });

  it("고객 취소: 고객에게는 환불 금액을 담은 앱 알림만, 사업자에게는 취소 알림", async () => {
    const listing = await createListing();
    const customer = await createUser({ name: "김하늘" });
    const booking = await createBooking(listing, customer, {
      status: "CANCELLED",
      cancelledBy: "CUSTOMER",
      cancelledAt: new Date(),
      refundRate: 50,
      refundAmount: 30000,
      paymentState: "PARTIALLY_REFUNDED",
    });
    await onBookingCancelled(booking.id);

    const [mine] = await inbox(customer.id);
    expect(mine).toMatchObject({ type: "BOOKING_CANCELLED", title: "예약을 취소했어요" });
    expect(mine!.body).toContain("환불 금액은 30,000원이에요.");
    expect(mine!.data).toMatchObject({ cancelledBy: "CUSTOMER", refundAmount: 30000 });
    const [seller] = await inbox(listing.owner.id);
    expect(seller).toMatchObject({ type: "SELLER_BOOKING_CANCELLED", title: "고객이 예약을 취소했어요" });
    expect(seller!.body).toContain("김하늘님");
    expect(await prisma.messageOutbox.count()).toBe(0);

    // 환불이 없는 취소
    const late = await createBooking(listing, customer, { status: "CANCELLED", cancelledBy: "CUSTOMER", refundRate: 0, refundAmount: 0 });
    await onBookingCancelled(late.id);
    const lateNotice = (await inbox(customer.id)).find((n) => (n.data as { bookingId?: string }).bookingId === late.id);
    expect(lateNotice!.body).toContain("환불 금액은 없어요");
  });

  it("사업자 취소: 고객이 예약 문자를 꺼 두었어도 사업자 템플릿 문자를 보낸다. 사업자에게는 다시 알리지 않는다", async () => {
    const listing = await createListing();
    const customer = await createUser({ name: "김하늘", phone: "01022223333", notificationPrefs: { bookingSms: false } });
    const booking = await createBooking(listing, customer, {
      status: "CANCELLED",
      cancelledBy: "SELLER",
      cancelReason: "강사 사정으로 진행이 어려워요",
      cancelledAt: new Date(),
      refundRate: 100,
      refundAmount: 60000,
      paymentState: "REFUNDED",
    });
    await onBookingCancelled(booking.id);

    const [mine] = await inbox(customer.id);
    expect(mine).toMatchObject({ type: "BOOKING_CANCELLED", title: "사업장 사정으로 예약이 취소됐어요" });
    expect(mine!.body).toContain("사유: 강사 사정으로 진행이 어려워요");
    expect(mine!.body).toContain("결제하신 60,000원은 전액 환불돼요.");

    const [sms] = await outboxOf("BOOKING_CANCELLED_BY_SELLER");
    expect(sms).toMatchObject({ recipient: "01022223333", businessId: listing.business.id, status: "QUEUED" });
    expect(sms!.body).toContain("김하늘님, 죄송해요.");
    expect(sms!.body).toContain("전액 환불");
    expect(await inbox(listing.owner.id)).toHaveLength(0);

    await onBookingCancelled(booking.id);
    expect(await prisma.messageOutbox.count()).toBe(1);
    expect(await prisma.notification.count()).toBe(1);
  });

  it("운영자·시스템 취소: 고객에게 기본 안내 문자, 사업자에게도 알린다", async () => {
    const listing = await createListing();
    const customer = await createUser();
    const booking = await createBooking(listing, customer, {
      status: "CANCELLED",
      cancelledBy: "ADMIN",
      cancelReason: "신고 접수에 따른 운영 조치",
      refundAmount: 60000,
      paymentState: "REFUNDED",
    });
    await onBookingCancelled(booking.id);

    const mine = (await inbox(customer.id))[0]!;
    expect(mine).toMatchObject({ title: "예약이 취소됐어요" });
    // 운영자가 남긴 사유는 고객에게 보여 주지 않고 사업자에게만 전한다.
    expect(mine.body).not.toContain("신고 접수");
    expect((await inbox(listing.owner.id))[0]!.body).toContain("사유: 신고 접수에 따른 운영 조치");
    const [sms] = await outboxOf("PLATFORM_BOOKING_CANCELLED");
    expect(sms!.body).toContain("[남는자리] 예약이 취소됐어요.");
    expect(sms!.body).toContain("결제하신 60,000원은 전액 환불돼요.");
    expect(await outboxOf("BOOKING_CANCELLED_BY_SELLER")).toHaveLength(0);
    expect((await inbox(listing.owner.id))[0]).toMatchObject({ type: "SELLER_BOOKING_CANCELLED", title: "운영자가 예약을 취소했어요" });
  });

  it("예약 확정 안내에는 판매자 이름·일시·장소와 안전 수칙 한 줄이 들어간다", async () => {
    const listing = await createListing([{ capacity: 4 }], { product: { placeName: "둔산 라운지", address: "대전 서구 둔산로 123, 2층" } });
    const customer = await createUser({ name: "김하늘", phone: "01022223333" });
    const safety = BOOKING_SAFETY_TIPS[0]!;

    // 1) 사업자 기본 템플릿
    const booking = await createBooking(listing, customer);
    await onBookingConfirmed(booking.id);
    const [mine] = await inbox(customer.id);
    for (const part of [listing.business.name, fmtDateTime(listing.slot.startAt), "둔산 라운지", "대전 서구 둔산로 123, 2층", safety]) {
      expect(mine!.body).toContain(part);
    }
    const [sellerSmsRow] = await outboxOf("BOOKING_CONFIRMED");
    for (const part of [listing.business.name, fmtDateTime(listing.slot.startAt), "둔산 라운지", safety]) {
      expect(sellerSmsRow!.body).toContain(part);
    }

    // 2) 템플릿을 끈 사업장의 남는자리 기본 안내
    await saveBusinessTemplate(listing.owner.id, listing.business.id, "BOOKING_CONFIRMED", { body: DEFAULT_TEMPLATES.BOOKING_CONFIRMED.body, isEnabled: false });
    const nextSlot = await createSlot(listing.product, [{ capacity: 4 }], { startsInHours: 72 });
    const second = await createBooking({ ...listing, slot: nextSlot, seat: nextSlot.seats[0]! }, customer);
    await onBookingConfirmed(second.id);
    const [platformSms] = await outboxOf("PLATFORM_BOOKING_CONFIRMED");
    for (const part of [listing.business.name, fmtDateTime(nextSlot.startAt), "장소: 둔산 라운지", safety, `예약번호 ${second.code}`]) {
      expect(platformSms!.body).toContain(part);
    }
  });

  it("고객 취소: 재판매 연동 환불을 기다리는 예약에는 더 돌려받을 수 있는 최대 금액을 알린다", async () => {
    const listing = await createListing();
    const customer = await createUser();
    // 60,000원 결제, 환불 불가 구간에 2명 모두 취소, 다시 팔리면 50%까지
    const booking = await createBooking(listing, customer, {
      status: "CANCELLED",
      cancelledBy: "CUSTOMER",
      cancelledAt: new Date(),
      refundRate: 0,
      refundAmount: 0,
      resaleRefundRate: 50,
      resalePendingQty: 2,
    });
    await onBookingCancelled(booking.id);
    const [mine] = await inbox(customer.id);
    expect(mine!.body).toContain("환불 금액은 없어요");
    expect(mine!.body).toContain("자리가 다시 예약되면 회차 시작 후 최대 30,000원을 더 돌려드려요.");

    // 대기 중인 좌석이 없으면(판정이 끝났거나 대상이 아님) 알리지 않는다.
    const settled = await createBooking(listing, customer, { status: "CANCELLED", cancelledBy: "CUSTOMER", refundRate: 0, refundAmount: 0, resaleRefundRate: 50, resalePendingQty: 0 });
    await onBookingCancelled(settled.id);
    const other = (await inbox(customer.id)).find((n) => (n.data as { bookingId?: string }).bookingId === settled.id);
    expect(other!.body).not.toContain("자리가 다시 예약되면");
  });

  it("재판매 연동 환불 확정: 취소된 예약의 고객에게 추가 환불 금액을 한 번만 알린다", async () => {
    const listing = await createListing();
    const customer = await createUser({ phone: "01022223333" });
    const booking = await createBooking(listing, customer, {
      status: "CANCELLED",
      cancelledBy: "CUSTOMER",
      refundRate: 0,
      refundAmount: 30000,
      resaleRefundRate: 50,
      paymentState: "PARTIALLY_REFUNDED",
    });

    await onResaleRefund(booking.id, 30000);
    await onResaleRefund(booking.id, 30000);
    const notices = await inbox(customer.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "REFUND_DONE", title: "취소한 자리가 다시 예약돼 더 돌려드려요", linkUrl: `/my/bookings/${booking.code}` });
    expect(notices[0]!.body).toContain("30,000원을 결제 수단으로 더 돌려드릴게요.");
    expect(notices[0]!.data).toMatchObject({ kind: "RESALE", extraAmount: 30000, refundAmount: 30000 });
    const sms = await outboxOf("PLATFORM_RESALE_REFUND");
    expect(sms).toHaveLength(1);
    expect(sms[0]).toMatchObject({ recipient: "01022223333", dedupeKey: `RESALE_REFUND:${booking.id}:30000` });

    // 금액이 없거나 취소되지 않은 예약에는 보내지 않는다.
    const active = await createBooking(listing, await createUser());
    await onResaleRefund(active.id, 10000);
    await onResaleRefund(booking.id, 0);
    await onResaleRefund("missing-booking", 10000);
    expect(await prisma.notification.count()).toBe(1);
  });

  it("개최 확정: 확정 예약 고객과 사업장 구성원에게 한 번씩 알린다", async () => {
    const listing = await createListing([{ capacity: 6 }], { goConfirmedAt: new Date() });
    await prisma.slotSeat.update({ where: { id: listing.seat.id }, data: { minCount: 4 } });
    const customer = await createUser({ name: "김하늘", phone: "01022223333" });
    const quiet = await createUser({ notificationPrefs: { bookingSms: false } });
    const confirmed = await createBooking(listing, customer);
    await createBooking(listing, quiet);
    // 알리지 않는 예약: 승인 대기, 취소, 사업자가 직접 넣은 손님
    const pendingUser = await createUser();
    await createBooking(listing, pendingUser, { status: "PENDING_APPROVAL", confirmedAt: null });
    const cancelledUser = await createUser();
    await createBooking(listing, cancelledUser, { status: "CANCELLED", cancelledBy: "CUSTOMER" });
    await createBooking(listing, null, { channel: "MANUAL", guestName: "박손님", guestPhone: "01044445555" });

    await onSlotGoConfirmed(listing.slot.id);
    await onSlotGoConfirmed(listing.slot.id);

    const [mine] = await inbox(customer.id);
    expect(mine).toMatchObject({ type: "SLOT_GO_CONFIRMED", title: "개최가 확정됐어요", linkUrl: `/my/bookings/${confirmed.code}` });
    expect(mine!.body).toContain(listing.product.title);
    expect(mine!.body).toContain(fmtDateTime(listing.slot.startAt));
    expect((await inbox(quiet.id)).map((n) => n.type)).toEqual(["SLOT_GO_CONFIRMED"]);
    expect(await inbox(pendingUser.id)).toHaveLength(0);
    expect(await inbox(cancelledUser.id)).toHaveLength(0);

    // 문자는 예약 문자를 받는 고객에게만, 예약당 한 통
    const sms = await outboxOf("PLATFORM_SLOT_GO_CONFIRMED");
    expect(sms.map((m) => m.recipient)).toEqual(["01022223333"]);
    expect(sms[0]!.body).toContain("[남는자리] 개최가 확정됐어요.");

    const [seller] = await inbox(listing.owner.id);
    expect(seller).toMatchObject({ type: "SLOT_GO_CONFIRMED", linkUrl: `/seller/slots/${listing.slot.id}` });
    expect(await inbox(listing.owner.id)).toHaveLength(1);
  });

  it("개최 확정 알림은 확정되지 않았거나, 취소됐거나, 최소 인원 조건이 없는 회차에는 보내지 않는다", async () => {
    const customer = await createUser();
    const notConfirmed = await createListing();
    await prisma.slotSeat.update({ where: { id: notConfirmed.seat.id }, data: { minCount: 2 } });
    await createBooking(notConfirmed, customer);
    const cancelled = await createListing([{ capacity: 4 }], { goConfirmedAt: new Date(), status: "CANCELLED" });
    await prisma.slotSeat.update({ where: { id: cancelled.seat.id }, data: { minCount: 2 } });
    await createBooking(cancelled, customer);
    const noMinimum = await createListing([{ capacity: 4 }], { goConfirmedAt: new Date() });
    await createBooking(noMinimum, customer);
    const started = await createListing([{ capacity: 4 }], { goConfirmedAt: new Date(), startsInHours: -1 });
    await prisma.slotSeat.update({ where: { id: started.seat.id }, data: { minCount: 2 } });
    await createBooking(started, customer);

    for (const listing of [notConfirmed, cancelled, noMinimum, started]) await onSlotGoConfirmed(listing.slot.id);
    await onSlotGoConfirmed("missing-slot");
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.messageOutbox.count()).toBe(0);
  });

  it("회차 취소: 함께 취소된 예약 고객(문자 포함)·대기자·사업장 구성원에게 알리고, 예약 취소 알림과 겹치지 않는다", async () => {
    const cancelledAt = new Date();
    const listing = await createListing([{ capacity: 6 }], { status: "CANCELLED", cancelledAt, cancelReason: "최소 인원 미달" });
    const staff = await createUser();
    await prisma.businessMember.create({ data: { businessId: listing.business.id, userId: staff.id, role: "STAFF" } });
    const customer = await createUser({ name: "김하늘", phone: "01022223333", notificationPrefs: { bookingSms: false } });
    const earlier = await createUser();
    const waiter = await createUser();
    const withSlot = {
      status: "CANCELLED" as const,
      cancelledBy: "SYSTEM" as const,
      cancelReason: "최소 인원 미달",
      cancelledAt,
      refundRate: 100,
      refundAmount: 60000,
      paymentState: "REFUNDED" as const,
    };
    const booking = await createBooking(listing, customer, withSlot);
    // 회차 취소 전에 고객이 직접 취소한 예약, 사업자가 며칠 전에 따로 취소한 예약은 대상이 아니다.
    const selfCancelled = await createUser();
    await createBooking(listing, selfCancelled, { status: "CANCELLED", cancelledBy: "CUSTOMER", cancelledAt });
    await createBooking(listing, earlier, { ...withSlot, cancelledBy: "SELLER", cancelledAt: new Date(cancelledAt.getTime() - 3 * 86_400_000) });
    await prisma.waitlistEntry.create({ data: { userId: waiter.id, slotId: listing.slot.id, slotSeatId: listing.seat.id, status: "CLOSED" } });

    await onSlotCancelled(listing.slot.id, "최소 인원 미달", { excludeUserId: staff.id });

    const [mine] = await inbox(customer.id);
    expect(mine).toMatchObject({ type: "SLOT_CANCELLED", title: "회차가 취소돼 예약도 함께 취소됐어요", linkUrl: `/my/bookings/${booking.code}` });
    expect(mine!.body).toContain("사유: 최소 인원 미달");
    expect(mine!.body).toContain("결제하신 60,000원은 전액 환불돼요.");
    // 헛걸음하지 않도록 예약 문자를 꺼 둔 고객에게도 문자를 보낸다.
    const [sms] = await outboxOf("PLATFORM_BOOKING_CANCELLED");
    expect(sms).toMatchObject({ recipient: "01022223333", status: "QUEUED" });
    expect(sms!.body).toContain("[남는자리] 회차가 취소돼 예약도 함께 취소됐어요.");
    expect(await inbox(selfCancelled.id)).toHaveLength(0);
    expect(await inbox(earlier.id)).toHaveLength(0);

    const [waiting] = await inbox(waiter.id);
    expect(waiting).toMatchObject({ type: "SLOT_CANCELLED", title: "기다리던 회차가 취소됐어요", linkUrl: `/slots/${listing.slot.id}` });

    const [seller] = await inbox(listing.owner.id);
    expect(seller).toMatchObject({ type: "SLOT_CANCELLED", title: "회차가 취소됐어요", linkUrl: `/seller/slots/${listing.slot.id}` });
    expect(seller!.body).toContain("사유: 최소 인원 미달");
    expect(seller!.body).toContain("예약 1건이 함께 취소됐고");
    // 직접 취소한 구성원은 뺀다.
    expect(await inbox(staff.id)).toHaveLength(0);

    // 같은 회차 취소를 다시 알리거나, 예약별 취소 알림이 뒤따라 와도 고객 안내는 한 번뿐이다.
    await onSlotCancelled(listing.slot.id, "최소 인원 미달");
    await onBookingCancelled(booking.id);
    expect(await inbox(customer.id)).toHaveLength(1);
    expect(await inbox(waiter.id)).toHaveLength(1);
    expect(await outboxOf("PLATFORM_BOOKING_CANCELLED")).toHaveLength(1);
    expect((await inbox(listing.owner.id)).filter((n) => n.type === "SLOT_CANCELLED")).toHaveLength(1);

    // 취소되지 않은 회차에는 아무것도 보내지 않는다.
    const open = await createListing();
    await createBooking(open, await createUser());
    const before = await prisma.notification.count();
    await onSlotCancelled(open.slot.id, "실수로 호출");
    expect(await prisma.notification.count()).toBe(before);
  });

  it("회차 취소: 예약 취소 알림이 먼저 나갔다면 회차 취소에서 다시 보내지 않고, 운영자 취소 사유는 고객에게 보여 주지 않는다", async () => {
    const cancelledAt = new Date();
    const listing = await createListing([{ capacity: 4 }], { status: "CANCELLED", cancelledAt });
    const customer = await createUser({ phone: "01022223333" });
    const byAdmin = await createUser();
    const base = { status: "CANCELLED" as const, cancelledAt, refundAmount: 60000, paymentState: "REFUNDED" as const };
    const first = await createBooking(listing, customer, { ...base, cancelledBy: "SELLER" });
    await createBooking(listing, byAdmin, { ...base, cancelledBy: "ADMIN" });

    await onBookingCancelled(first.id);
    await onSlotCancelled(listing.slot.id, "신고 접수에 따른 운영 조치");

    const mine = await inbox(customer.id);
    expect(mine.map((n) => n.title)).toEqual(["사업장 사정으로 예약이 취소됐어요"]);
    expect(await outboxOf("BOOKING_CANCELLED_BY_SELLER")).toHaveLength(1);
    const [adminCase] = await inbox(byAdmin.id);
    expect(adminCase).toMatchObject({ type: "SLOT_CANCELLED" });
    expect(adminCase!.body).not.toContain("신고 접수");
  });

  it("노쇼 처리: 한도 전에는 경고를, 제한이 걸리면 기한을 알리고 이의제기 방법을 함께 안내한다", async () => {
    const { noShowLimit, noShowWindowDays, noShowRestrictDays } = DEFAULT_SETTINGS;
    const listing = await createListing([{ capacity: 4 }], { startsInHours: -3 });
    const customer = await createUser({ phone: "01022223333", notificationPrefs: { bookingSms: false } });
    const noShowAt = new Date();
    const booking = await createBooking(listing, customer, { status: "NO_SHOW", noShowAt });

    await onNoShowMarked(booking.id, { countInWindow: 1, limit: noShowLimit });
    await onNoShowMarked(booking.id, { countInWindow: 1, limit: noShowLimit });
    const [warning] = await inbox(customer.id);
    expect(warning).toMatchObject({ type: "NO_SHOW_NOTICE", title: "예약이 노쇼로 처리됐어요", linkUrl: `/my/bookings/${booking.code}` });
    expect(warning!.body).toContain(`최근 ${noShowWindowDays}일 동안 노쇼 1회예요.`);
    if (noShowLimit > 1) expect(warning!.body).toContain(`${noShowLimit}회가 되면 ${noShowRestrictDays}일 동안 새 예약이 제한돼요.`);
    expect(warning!.body).toContain(`${HELP_FACTS.noShowDisputeHours}시간 안에 예약 상세에서 이의를 제기해 주세요.`);
    expect(warning!.data).toMatchObject({
      countInWindow: 1,
      limit: noShowLimit,
      restrictedUntil: null,
      disputeUntil: new Date(noShowAt.getTime() + HELP_FACTS.noShowDisputeHours * HOUR_MS).toISOString(),
    });
    expect(await inbox(customer.id)).toHaveLength(1);
    // 경고 문자는 예약 문자 설정을 따른다(꺼 둔 고객에게는 보내지 않는다).
    expect(await outboxOf("PLATFORM_NO_SHOW_NOTICE")).toHaveLength(0);

    // 제한이 걸린 노쇼: 기한을 알리고, 문자는 수신 설정과 무관하게 보낸다.
    const second = await createListing([{ capacity: 4 }], { startsInHours: -2 });
    const restrictedUntil = new Date(Date.now() + noShowRestrictDays * 86_400_000);
    const again = await createBooking(second, customer, { status: "NO_SHOW", noShowAt: new Date() });
    await onNoShowMarked(again.id, { countInWindow: noShowLimit, limit: noShowLimit, restrictedUntil });
    const restricted = (await inbox(customer.id)).find((n) => (n.data as { bookingId?: string }).bookingId === again.id);
    expect(restricted).toMatchObject({ title: "노쇼로 처리돼 새 예약이 잠시 제한돼요" });
    expect(restricted!.body).toContain(`${fmtDate(restrictedUntil)}까지 새 예약을 할 수 없어요.`);
    expect(restricted!.data).toMatchObject({ restrictedUntil: restrictedUntil.toISOString() });
    const [sms] = await outboxOf("PLATFORM_NO_SHOW_NOTICE");
    expect(sms).toMatchObject({ recipient: "01022223333" });
    expect(sms!.body).toContain("이의를 제기해 주세요.");

    // 사업자가 되돌렸다가 다시 노쇼로 처리하면 새로 알린다.
    await prisma.booking.update({ where: { id: booking.id }, data: { noShowAt: new Date(noShowAt.getTime() + 60_000) } });
    await onNoShowMarked(booking.id, { countInWindow: 1, limit: noShowLimit });
    expect((await inbox(customer.id)).filter((n) => (n.data as { bookingId?: string }).bookingId === booking.id)).toHaveLength(2);
  });

  it("노쇼 알림은 노쇼 상태인 회원 예약에만 보낸다", async () => {
    const listing = await createListing([{ capacity: 4 }], { startsInHours: -3 });
    const customer = await createUser();
    const reverted = await createBooking(listing, customer, { status: "COMPLETED" });
    const manual = await createBooking(listing, null, { channel: "MANUAL", status: "NO_SHOW", noShowAt: new Date(), guestPhone: "01044445555" });

    await onNoShowMarked(reverted.id, { countInWindow: 1, limit: 2 });
    await onNoShowMarked(manual.id, { countInWindow: 1, limit: 2 });
    await onNoShowMarked("missing-booking", { countInWindow: 1, limit: 2 });
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.messageOutbox.count()).toBe(0);
  });

  it("환불 완료: 금액을 알리고, 같은 환불의 중복 호출은 한 번만 처리한다", async () => {
    const listing = await createListing();
    const customer = await createUser();
    const booking = await createBooking(listing, customer, { status: "CANCELLED", cancelledBy: "CUSTOMER", refundAmount: 30000, paymentState: "PARTIALLY_REFUNDED" });

    await onRefundDone(booking.id, 30000);
    await onRefundDone(booking.id, 30000);
    await onRefundDone(booking.id, 0);
    const notices = await inbox(customer.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "REFUND_DONE", title: "환불이 완료됐어요" });
    expect(notices[0]!.body).toContain("30,000원을 결제 수단으로 돌려드렸어요.");
    const sms = await outboxOf("PLATFORM_REFUND_DONE");
    expect(sms).toHaveLength(1);
    expect(sms[0]!.body).toContain("[남는자리] 30,000원 환불이 완료됐어요.");

    // 추가 환불(누적 금액이 달라짐)은 새 알림으로 나간다.
    await prisma.booking.update({ where: { id: booking.id }, data: { refundAmount: 60000, paymentState: "REFUNDED" } });
    await onRefundDone(booking.id, 30000);
    expect(await inbox(customer.id)).toHaveLength(2);
    expect(await outboxOf("PLATFORM_REFUND_DONE")).toHaveLength(2);
  });

  it("대기 자리 제안: 마감 시각을 담아 앱 알림과 문자를 보낸다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(kstDate(2026, 11, 27, 19, 30));
    const listing = await createListing();
    const waiter = await createUser({ phone: "01066667777" });
    const entry = await prisma.waitlistEntry.create({
      data: {
        userId: waiter.id,
        slotId: listing.slot.id,
        slotSeatId: listing.seat.id,
        quantity: 1,
        status: "OFFERED",
        offeredAt: kstDate(2026, 11, 27, 19, 30),
        offerExpiresAt: kstDate(2026, 11, 27, 19, 50),
      },
    });

    await onWaitlistOffer(entry.id);
    await onWaitlistOffer(entry.id);

    const notices = await inbox(waiter.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "WAITLIST_OFFER", title: "기다리던 자리가 났어요", linkUrl: `/slots/${listing.slot.id}?offer=1` });
    expect(notices[0]!.body).toContain("19:50까지 예약하면 자리가 확정돼요");
    expect(notices[0]!.data).toMatchObject({ waitlistEntryId: entry.id, slotId: listing.slot.id });

    const sms = await outboxOf("PLATFORM_WAITLIST_OFFER");
    expect(sms).toHaveLength(1);
    expect(sms[0]).toMatchObject({ recipient: "01066667777", isAdvertising: false, status: "QUEUED" });
    expect(sms[0]!.body).toContain("19:50까지 예약하면 자리가 확정돼요");
    expect(sms[0]!.body).toContain(`http://localhost:3000/slots/${listing.slot.id}?offer=1`);
    // 거래 관련 안내이므로 야간·광고 동의와 무관하게 바로 발송 대상이다.
    expect(sms[0]!.scheduledAt).toEqual(kstDate(2026, 11, 27, 19, 30));
  });

  it("대기 자리 제안: 마감이 자정을 넘기면 날짜를 붙이고, 선착순이면 마감 문구를 뺀다. 제안 만료도 알린다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(kstDate(2026, 11, 27, 23, 55));
    const listing = await createListing([{ capacity: 4 }, { capacity: 4, label: "여성", gender: "FEMALE" }]);
    const a = await createUser();
    const b = await createUser();
    const overnight = await prisma.waitlistEntry.create({
      data: { userId: a.id, slotId: listing.slot.id, slotSeatId: listing.seat.id, status: "OFFERED", offeredAt: new Date(), offerExpiresAt: kstDate(2026, 11, 28, 0, 15) },
    });
    const broadcast = await prisma.waitlistEntry.create({
      data: { userId: b.id, slotId: listing.slot.id, slotSeatId: listing.slot.seats[1]!.id, status: "WAITING" },
    });

    await onWaitlistOffer(overnight.id);
    await onWaitlistOffer(broadcast.id);
    expect((await inbox(a.id))[0]!.body).toContain("내일 00:15까지 예약하면 자리가 확정돼요");
    const open = (await inbox(b.id))[0]!;
    expect(open.body).toContain("먼저 예약하는 분께 자리가 돌아가요");
    expect(open.body).not.toContain("까지 예약하면");

    await prisma.waitlistEntry.update({ where: { id: overnight.id }, data: { status: "EXPIRED" } });
    await onWaitlistExpired(overnight.id);
    await onWaitlistExpired(overnight.id);
    const expired = (await inbox(a.id)).filter((n) => n.type === "WAITLIST_EXPIRED");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ title: "자리 제안 시간이 지났어요", linkUrl: `/slots/${listing.slot.id}` });
    // 만료된 제안은 다시 알리지 않는다.
    await onWaitlistOffer(overnight.id);
    expect((await inbox(a.id)).filter((n) => n.type === "WAITLIST_OFFER")).toHaveLength(1);
  });

  it("취소석이 닫힌 채 남았을 때 사업자에게 다시 올릴지 묻는다", async () => {
    const listing = await createListing();
    await onSeatReleasedForSeller(listing.slot.id, 1);
    const [n] = await inbox(listing.owner.id);
    expect(n).toMatchObject({ type: "SELLER_SEAT_RELEASED", title: "취소로 1자리가 생겼어요. 다시 올릴까요?" });
    expect(n!.data).toMatchObject({ slotId: listing.slot.id, quantity: 1 });
    expect(n!.body).toContain(listing.product.title);
  });

  it("입점 심사 결과: 구성원 모두에게 앱 알림과 이메일", async () => {
    const { business, owner } = await createBusiness({ reviewedAt: new Date() });
    const manager = await createUser();
    await prisma.businessMember.create({ data: { businessId: business.id, userId: manager.id, role: "MANAGER" } });

    await onBusinessReviewed(business.id, true);
    await onBusinessReviewed(business.id, true);
    for (const member of [owner, manager]) {
      const notices = await inbox(member.id);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ type: "SELLER_BUSINESS_APPROVED", linkUrl: "/seller" });
      expect(notices[0]!.title).toContain("입점이 승인됐어요");
    }
    const emails = await outboxOf("PLATFORM_BUSINESS_APPROVED");
    expect(emails.map((e) => e.recipient).sort()).toEqual([owner.email, manager.email].sort());
    expect(emails.every((e) => e.channel === "EMAIL" && e.subject?.startsWith("[남는자리]"))).toBe(true);

    const { business: rejectedBiz, owner: rejectedOwner } = await createBusiness({ status: "REJECTED", reviewedAt: new Date() });
    await onBusinessReviewed(rejectedBiz.id, false, "사업자등록증 사진이 흐려요");
    const [rejected] = await inbox(rejectedOwner.id);
    expect(rejected).toMatchObject({ type: "SELLER_BUSINESS_REJECTED" });
    expect(rejected!.body).toContain("사유: 사업자등록증 사진이 흐려요");
  });

  it("notifyBusinessMembers: 다른 모듈이 구성원 전체에게 알릴 때 쓴다", async () => {
    const { business, owner } = await createBusiness();
    const staff = await createUser();
    await prisma.businessMember.create({ data: { businessId: business.id, userId: staff.id, role: "STAFF" } });
    const sent = await notifyBusinessMembers(business.id, {
      type: "SELLER_REVIEW",
      title: "새 후기가 올라왔어요",
      body: "별점 5점",
      linkUrl: "/seller/reviews",
      excludeUserIds: [staff.id],
    });
    expect(sent).toBe(1);
    expect((await inbox(owner.id))[0]).toMatchObject({ type: "SELLER_REVIEW", linkUrl: "/seller/reviews" });
    expect(await inbox(staff.id)).toHaveLength(0);
  });

  it("상태가 맞지 않는 예약에는 알림을 보내지 않는다(호출 사이에 상태가 바뀐 경우)", async () => {
    const listing = await createListing();
    const customer = await createUser();
    const cancelled = await createBooking(listing, customer, { status: "CANCELLED", cancelledBy: "CUSTOMER" });
    await onBookingConfirmed(cancelled.id);
    await onBookingPendingApproval(cancelled.id);
    await onBookingRejected(cancelled.id);
    await onBookingExpired(cancelled.id);

    const other = await createUser();
    const confirmed = await createBooking(listing, other);
    await onBookingCancelled(confirmed.id);
    await onBookingPendingApproval(confirmed.id);

    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.messageOutbox.count()).toBe(0);
  });

  it("없는 예약·대기·회차·사업장을 넘겨도 예외를 던지지 않는다", async () => {
    await expect(onBookingConfirmed("nope")).resolves.toBeUndefined();
    await expect(onBookingPendingApproval("nope")).resolves.toBeUndefined();
    await expect(onBookingRejected("nope")).resolves.toBeUndefined();
    await expect(onBookingExpired("nope")).resolves.toBeUndefined();
    await expect(onBookingCancelled("nope")).resolves.toBeUndefined();
    await expect(onRefundDone("nope", 1000)).resolves.toBeUndefined();
    await expect(onWaitlistOffer("nope")).resolves.toBeUndefined();
    await expect(onWaitlistExpired("nope")).resolves.toBeUndefined();
    await expect(onSeatReleasedForSeller("nope", 1)).resolves.toBeUndefined();
    await expect(onBusinessReviewed("nope", true)).resolves.toBeUndefined();
    await expect(sendBookingReminder("nope", "DAY_BEFORE")).resolves.toBe(false);
    await expect(sendReviewRequest("nope")).resolves.toBe(false);
    expect(await prisma.notification.count()).toBe(0);
  });
});

describe("리마인드 · 후기 요청", () => {
  it("리마인드는 종류별로 예약당 한 번만 보낸다", async () => {
    const listing = await createListing([{ capacity: 4 }], { startsInHours: 23 });
    const customer = await createUser({ phone: "01022223333" });
    const booking = await createBooking(listing, customer);

    expect(await sendBookingReminder(booking.id, "DAY_BEFORE")).toBe(true);
    expect(await sendBookingReminder(booking.id, "DAY_BEFORE")).toBe(false);
    expect(await sendBookingReminder(booking.id, "HOURS_BEFORE")).toBe(true);
    expect(await sendBookingReminder(booking.id, "HOURS_BEFORE")).toBe(false);

    const notices = await prisma.notification.findMany({ where: { userId: customer.id, type: "BOOKING_REMINDER" }, orderBy: { createdAt: "asc" } });
    expect(notices.map((n) => (n.data as { kind: string }).kind).sort()).toEqual(["DAY_BEFORE", "HOURS_BEFORE"]);
    expect(notices.every((n) => n.linkUrl === `/my/bookings/${booking.code}`)).toBe(true);

    const sms = await prisma.messageOutbox.findMany({ orderBy: { createdAt: "asc" } });
    expect(sms.map((m) => m.templateKey).sort()).toEqual(["REMINDER_DAY_BEFORE", "REMINDER_HOURS_BEFORE"]);
    expect(sms.map((m) => m.dedupeKey).sort()).toEqual([`REMINDER_DAY_BEFORE:${booking.id}`, `REMINDER_HOURS_BEFORE:${booking.id}`]);
    expect(sms.every((m) => m.businessId === listing.business.id && m.recipient === "01022223333")).toBe(true);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).reminderSentAt).toBeInstanceOf(Date);
  });

  it("리마인드에는 참석 확정 권유, 이른 취소 권유, 지금 취소할 때의 환불 기준이 들어간다", async () => {
    const tiers = [...CANCELLATION_PRESETS.STANDARD.tiers];
    const cancelEarly = "못 오시게 되면 미리 취소해 주세요. 다른 분이 자리를 이어받을 수 있어요.";
    const bookedAt = new Date(Date.now() - 5 * 24 * HOUR_MS);
    const customer = await createUser({ phone: "01022223333" });
    const reminderOf = async (bookingId: string) => {
      const rows = await prisma.notification.findMany({ where: { userId: customer.id, type: "BOOKING_REMINDER" } });
      return rows.find((n) => (n.data as { bookingId: string }).bookingId === bookingId)!;
    };

    // 1) 시작 30시간 전, 아직 참석 확정 전
    const dayBefore = await createListing([{ capacity: 4 }], { startsInHours: 30 });
    const first = await createBooking(dayBefore, customer, { policySnapshot: tiers, createdAt: bookedAt });
    await sendBookingReminder(first.id, "DAY_BEFORE");
    const rate = computeRefundRate({ tiers, startAt: dayBefore.slot.startAt, bookedAt });
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(100);
    const n1 = await reminderOf(first.id);
    expect(n1.body).toContain("오실 수 있다면 '참석 확정'을 눌러 주세요.");
    expect(n1.body).toContain(cancelEarly);
    expect(n1.body).toContain(`지금 취소하면 결제 금액의 ${rate}%를 돌려드려요.`);
    expect(n1.data).toMatchObject({ kind: "DAY_BEFORE", attendanceConfirmed: false });
    expect(n1.linkUrl).toBe(`/my/bookings/${first.code}`);
    // 사업자 기본 문자에도 같은 권유와 참석 확정·취소 링크가 들어간다.
    const sms = await prisma.messageOutbox.findFirstOrThrow({ where: { templateKey: "REMINDER_DAY_BEFORE" } });
    expect(sms.body).toContain(cancelEarly);
    expect(sms.body).toContain(`참석 확정·취소: http://localhost:3000/my/bookings/${first.code}`);
    expect(DEFAULT_TEMPLATES.REMINDER_HOURS_BEFORE.body).toContain(cancelEarly);

    // 2) 시작 2시간 전, 참석 확정을 마쳤고 환불 불가 구간이지만 재판매 연동 환불이 있는 예약
    const soon = await createListing([{ capacity: 4 }], { startsInHours: 2 });
    const second = await createBooking(soon, customer, { policySnapshot: tiers, createdAt: bookedAt, attendanceConfirmedAt: new Date(), resaleRefundRate: 50 });
    await sendBookingReminder(second.id, "HOURS_BEFORE");
    const n2 = await reminderOf(second.id);
    expect(n2.body).not.toContain("참석 확정");
    expect(n2.body).toContain(cancelEarly);
    expect(n2.body).toContain("지금은 취소해도 환불되지 않아요. 자리가 다시 예약되면 50%까지 돌려드려요.");
    expect(n2.data).toMatchObject({ kind: "HOURS_BEFORE", attendanceConfirmed: true });

    // 3) 전액 환불 구간
    const far = await createListing([{ capacity: 4 }], { startsInHours: 24 * 5 });
    const third = await createBooking(far, customer, { policySnapshot: tiers, createdAt: bookedAt });
    await sendBookingReminder(third.id, "DAY_BEFORE");
    expect((await reminderOf(third.id)).body).toContain("지금 취소하면 결제 금액을 전액 돌려드려요.");

    // 4) 온라인으로 결제한 금액이 없거나 정책을 읽을 수 없는 예약에는 환불 문구를 넣지 않는다(추측한 값을 보여 주지 않는다).
    const onsiteSlot = await createListing([{ capacity: 4 }], { startsInHours: 20 });
    const onsite = await createBooking(onsiteSlot, customer, { policySnapshot: tiers, paymentMethod: "ONSITE", paymentState: "UNPAID", payNowAmount: 0, payOnsiteAmount: 60000 });
    const unreadableSlot = await createListing([{ capacity: 4 }], { startsInHours: 21 });
    const unreadable = await createBooking(unreadableSlot, customer, { policySnapshot: { memo: "형식이 다른 스냅샷" } });
    for (const booking of [onsite, unreadable]) {
      await sendBookingReminder(booking.id, "DAY_BEFORE");
      const body = (await reminderOf(booking.id)).body;
      expect(body).toContain(cancelEarly);
      expect(body).not.toContain("환불");
      expect(body).not.toContain("돌려드려요");
    }

    // 5) { tiers: [...] } 형태로 저장된 스냅샷도 읽는다.
    const nestedSlot = await createListing([{ capacity: 4 }], { startsInHours: 30 });
    const nested = await createBooking(nestedSlot, customer, { policySnapshot: { tiers }, createdAt: bookedAt });
    await sendBookingReminder(nested.id, "DAY_BEFORE");
    expect((await reminderOf(nested.id)).body).toContain(`지금 취소하면 결제 금액의 ${rate}%를 돌려드려요.`);
  });

  it("확정 상태가 아니거나 이미 시작한 예약에는 리마인드를 보내지 않는다. 템플릿을 끄면 앱 알림만 간다", async () => {
    const listing = await createListing();
    const customer = await createUser();
    const cancelled = await createBooking(listing, customer, { status: "CANCELLED", cancelledBy: "CUSTOMER" });
    expect(await sendBookingReminder(cancelled.id, "DAY_BEFORE")).toBe(false);

    const started = await createListing([{ capacity: 4 }], { startsInHours: -1 });
    const past = await createBooking(started, customer);
    expect(await sendBookingReminder(past.id, "HOURS_BEFORE")).toBe(false);
    expect(await prisma.notification.count()).toBe(0);

    await saveBusinessTemplate(listing.owner.id, listing.business.id, "REMINDER_DAY_BEFORE", {
      body: DEFAULT_TEMPLATES.REMINDER_DAY_BEFORE.body,
      isEnabled: false,
    });
    const other = await createUser();
    const booking = await createBooking(listing, other);
    expect(await sendBookingReminder(booking.id, "DAY_BEFORE")).toBe(true);
    expect(await prisma.notification.count({ where: { userId: other.id, type: "BOOKING_REMINDER" } })).toBe(1);
    expect(await prisma.messageOutbox.count()).toBe(0);
  });

  it("급하지 않은 문자(전날 리마인드·후기 요청)는 한밤중이면 아침 8시로 미룬다. 앱 알림은 바로 간다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(kstDate(2026, 11, 27, 23, 40));
    const listing = await createListing([{ capacity: 4 }], { startsInHours: 23.5 });
    const customer = await createUser();
    const booking = await createBooking(listing, customer);

    expect(await sendBookingReminder(booking.id, "DAY_BEFORE")).toBe(true);
    expect(await prisma.notification.count({ where: { userId: customer.id, type: "BOOKING_REMINDER" } })).toBe(1);
    const dayBefore = await prisma.messageOutbox.findFirstOrThrow({ where: { templateKey: "REMINDER_DAY_BEFORE" } });
    expect(dayBefore.scheduledAt).toEqual(kstDate(2026, 11, 28, 8, 0));
    // 당일 리마인드는 시간이 중요하므로 바로 보낸다.
    expect(await sendBookingReminder(booking.id, "HOURS_BEFORE")).toBe(true);
    const hoursBefore = await prisma.messageOutbox.findFirstOrThrow({ where: { templateKey: "REMINDER_HOURS_BEFORE" } });
    expect(hoursBefore.scheduledAt).toEqual(kstDate(2026, 11, 27, 23, 40));

    // 아침까지 미루면 너무 늦는 회차(오전 9시 시작)는 전날 리마인드도 바로 보낸다.
    const early = await createListing([{ capacity: 4 }], { startsInHours: 9 + 20 / 60 });
    const earlyBooking = await createBooking(early, await createUser());
    await sendBookingReminder(earlyBooking.id, "DAY_BEFORE");
    const urgent = await prisma.messageOutbox.findFirstOrThrow({ where: { businessId: early.business.id } });
    expect(urgent.scheduledAt).toEqual(kstDate(2026, 11, 27, 23, 40));

    // 후기 요청 문자
    await saveBusinessTemplate(listing.owner.id, listing.business.id, "REVIEW_REQUEST", { body: DEFAULT_TEMPLATES.REVIEW_REQUEST.body, isEnabled: true });
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "COMPLETED" } });
    expect(await sendReviewRequest(booking.id)).toBe(true);
    const review = await prisma.messageOutbox.findFirstOrThrow({ where: { templateKey: "REVIEW_REQUEST" } });
    expect(review.scheduledAt).toEqual(kstDate(2026, 11, 28, 8, 0));
    expect(review.isAdvertising).toBe(false);
  });

  it("sendDueReminders: 발송 시점이 된 예약만, 임박해서 잡은 예약에는 지난 리마인드를 보내지 않는다", async () => {
    const customer = await createUser();
    const dayAgo = new Date(Date.now() - 30 * HOUR_MS);
    // 시작 23시간 전: 전날 리마인드 대상
    const dayBefore = await createListing([{ capacity: 4 }], { startsInHours: 23 });
    const b1 = await createBooking(dayBefore, customer, { confirmedAt: dayAgo });
    // 시작 2.5시간 전: 당일 리마인드 대상(전날 리마인드는 이미 보냄)
    const hoursBefore = await createListing([{ capacity: 4 }], { startsInHours: 2.5 });
    const b2 = await createBooking(hoursBefore, customer, { confirmedAt: dayAgo, reminderSentAt: new Date(Date.now() - 21 * HOUR_MS) });
    // 시작 30시간 전: 아직 차례가 아님
    const notYet = await createListing([{ capacity: 4 }], { startsInHours: 30 });
    const b3 = await createBooking(notYet, customer, { confirmedAt: dayAgo });
    // 발송 시점(시작 3시간 전)이 지난 뒤에 방금 잡은 임박 예약: 어떤 리마인드도 보내지 않음
    const lastMinute = await createListing([{ capacity: 4 }], { startsInHours: 2.6 });
    const b4 = await createBooking(lastMinute, customer, { confirmedAt: new Date() });
    // 취소된 예약
    const b5 = await createBooking(dayBefore, await createUser(), { status: "CANCELLED", cancelledBy: "CUSTOMER", confirmedAt: dayAgo });

    expect(await sendDueReminders()).toEqual({ sent: 2 });
    const reminders = await prisma.notification.findMany({ where: { type: "BOOKING_REMINDER" } });
    const byBooking = new Map(reminders.map((n) => [(n.data as { bookingId: string }).bookingId, (n.data as { kind: string }).kind]));
    expect(byBooking.get(b1.id)).toBe("DAY_BEFORE");
    expect(byBooking.get(b2.id)).toBe("HOURS_BEFORE");
    expect([b3.id, b4.id, b5.id].some((id) => byBooking.has(id))).toBe(false);

    // 다시 돌려도 더 보내지 않는다.
    expect(await sendDueReminders()).toEqual({ sent: 0 });
    expect(await prisma.notification.count({ where: { type: "BOOKING_REMINDER" } })).toBe(2);
  });

  it("sendDueReminders: 프로 사업장이 정한 발송 시점을 따른다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(kstDate(2026, 11, 27, 10, 0));
    const customer = await createUser();
    const listing = await createListing([{ capacity: 4 }], { startsInHours: 47 });
    await prisma.business.update({ where: { id: listing.business.id }, data: { plan: "PRO" } });
    const booking = await createBooking(listing, customer, { confirmedAt: new Date(Date.now() - 72 * HOUR_MS) });

    // 기본(24시간 전) 기준으로는 아직 차례가 아니다.
    expect(await sendDueReminders()).toEqual({ sent: 0 });
    await saveBusinessTemplate(listing.owner.id, listing.business.id, "REMINDER_DAY_BEFORE", {
      body: DEFAULT_TEMPLATES.REMINDER_DAY_BEFORE.body,
      isEnabled: true,
      offsetMinutes: 2880,
    });
    expect(await sendDueReminders()).toEqual({ sent: 1 });
    const [reminder] = await prisma.notification.findMany({ where: { type: "BOOKING_REMINDER" } });
    expect(reminder!.data).toMatchObject({ bookingId: booking.id, kind: "DAY_BEFORE" });
    expect(reminder!.title).toBe("모레 예약이 있어요");
  });

  it("후기 요청은 이용 완료된 회원 예약에 한 번만, 문자는 사업자가 켰고 고객이 받기로 한 경우에만 보낸다", async () => {
    const listing = await createListing();
    const customer = await createUser({ phone: "01022223333" });
    const confirmed = await createBooking(listing, customer);
    expect(await sendReviewRequest(confirmed.id)).toBe(false);

    const done = await createBooking(listing, customer, { status: "COMPLETED", completedAt: new Date() });
    expect(await sendReviewRequest(done.id)).toBe(true);
    expect(await sendReviewRequest(done.id)).toBe(false);
    const requests = await prisma.notification.findMany({ where: { userId: customer.id, type: "REVIEW_REQUEST" } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.linkUrl).toBe(`/my/bookings/${done.code}`);
    // 후기 요청 문자는 기본이 꺼짐이다.
    expect(await prisma.messageOutbox.count()).toBe(0);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: done.id } })).reviewRequestedAt).toBeInstanceOf(Date);

    await saveBusinessTemplate(listing.owner.id, listing.business.id, "REVIEW_REQUEST", { body: DEFAULT_TEMPLATES.REVIEW_REQUEST.body, isEnabled: true });
    const next = await createBooking(listing, customer, { status: "COMPLETED", completedAt: new Date() });
    expect(await sendReviewRequest(next.id)).toBe(true);
    const sms = await prisma.messageOutbox.findMany({ where: { templateKey: "REVIEW_REQUEST" } });
    expect(sms).toHaveLength(1);
    expect(sms[0]!.body).toContain("어떠셨어요?");

    // 후기 요청을 끈 고객: 앱 알림만
    const quiet = await createUser({ notificationPrefs: { reviewRequest: false } });
    const quietBooking = await createBooking(listing, quiet, { status: "COMPLETED", completedAt: new Date() });
    expect(await sendReviewRequest(quietBooking.id)).toBe(true);
    expect(await prisma.messageOutbox.count({ where: { templateKey: "REVIEW_REQUEST" } })).toBe(1);

    // 이미 후기를 쓴 예약에는 요청하지 않는다.
    const reviewed = await createBooking(listing, customer, { status: "COMPLETED", completedAt: new Date() });
    await prisma.review.create({
      data: { bookingId: reviewed.id, userId: customer.id, businessId: listing.business.id, productId: listing.product.id, rating: 5, content: "좋았어요" },
    });
    expect(await sendReviewRequest(reviewed.id)).toBe(false);
  });
});
