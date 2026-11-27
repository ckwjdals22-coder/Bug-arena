import "server-only";
import { z } from "zod";
import { prisma } from "@/server/db";

/**
 * 플랫폼 운영 설정. 운영자 콘솔에서 바꿀 수 있고, 저장된 값이 없으면 아래 기본값을 쓴다.
 * 수수료율은 bps(100bps = 1%).
 */
export const settingsSchema = z.object({
  /** 남는자리 탐색으로 처음 온 고객의 예약 수수료 */
  commissionNewCustomerBps: z.number().int().min(0).max(3000),
  /** 남는자리 탐색으로 온 재방문 고객의 예약 수수료 */
  commissionReturningBps: z.number().int().min(0).max(3000),
  /** 사업자 전용 예약 링크·직접 입력 예약의 수수료 */
  commissionDirectBps: z.number().int().min(0).max(3000),
  /** 온라인 결제 대행(PG) 수수료 — 사업자 정산에서 실비 차감 */
  pgFeeBps: z.number().int().min(0).max(1000),
  /** 결제 대기 중 좌석을 잡아 두는 시간(분) */
  holdMinutes: z.number().int().min(3).max(60),
  /** 대기자에게 자리를 제안하고 기다리는 시간(분) */
  waitlistOfferMinutes: z.number().int().min(5).max(180),
  /** 시작까지 이 시간(분) 이내면 순차 제안 대신 대기자 전원에게 동시에 알린다(선착순) */
  waitlistBroadcastWithinMinutes: z.number().int().min(0).max(1440),
  /** 예약 직후 무료 취소 가능 시간(분) — 실수 예약 보호 */
  cancelGraceMinutes: z.number().int().min(0).max(120),
  /** 최근 noShowWindowDays 일 동안 노쇼가 이 횟수에 이르면 예약 제한 */
  noShowLimit: z.number().int().min(1).max(10),
  noShowWindowDays: z.number().int().min(7).max(365),
  /** 예약 제한 기간(일) */
  noShowRestrictDays: z.number().int().min(1).max(365),
  /** 프로 플랜 월 구독료(원, VAT 포함) */
  proPriceMonthly: z.number().int().min(0),
  /** 베이직 플랜에서 한 달에 보낼 수 있는 자동 문자 건수 */
  freeMonthlyMessages: z.number().int().min(0),
  /** 프로 플랜 월 포함 문자 건수 */
  proMonthlyMessages: z.number().int().min(0),
  /** 종료 후 이 시간(시간)이 지나면 확정 예약을 자동으로 이용 완료 처리 */
  autoCompleteAfterHours: z.number().int().min(0).max(168),
});

export type PlatformSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: PlatformSettings = {
  commissionNewCustomerBps: 1000,
  commissionReturningBps: 300,
  commissionDirectBps: 0,
  pgFeeBps: 330,
  holdMinutes: 10,
  waitlistOfferMinutes: 20,
  waitlistBroadcastWithinMinutes: 180,
  cancelGraceMinutes: 10,
  noShowLimit: 2,
  noShowWindowDays: 90,
  noShowRestrictDays: 30,
  proPriceMonthly: 29000,
  freeMonthlyMessages: 50,
  proMonthlyMessages: 1000,
  autoCompleteAfterHours: 12,
};

const SETTINGS_KEY = "platform";
let cache: { value: PlatformSettings; at: number } | undefined;
const CACHE_MS = 30_000;

export async function getSettings(): Promise<PlatformSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await prisma.platformSetting.findUnique({ where: { key: SETTINGS_KEY } });
  const merged = { ...DEFAULT_SETTINGS, ...(typeof row?.value === "object" && row.value !== null ? row.value : {}) };
  const parsed = settingsSchema.safeParse(merged);
  const value = parsed.success ? parsed.data : DEFAULT_SETTINGS;
  cache = { value, at: Date.now() };
  return value;
}

export async function updateSettings(patch: Partial<PlatformSettings>, updatedById: string): Promise<PlatformSettings> {
  const next = settingsSchema.parse({ ...(await getSettings()), ...patch });
  await prisma.platformSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: next, updatedById },
    update: { value: next, updatedById },
  });
  cache = { value: next, at: Date.now() };
  return next;
}

/** 테스트에서 캐시를 비울 때 사용 */
export function resetSettingsCache(): void {
  cache = undefined;
}

/** 플랜별 기능 범위 */
export const PLAN_FEATURES = {
  FREE: {
    label: "베이직",
    maxActiveProducts: 3,
    maxTeamMembers: 1,
    customMessageTemplates: false,
    advancedAnalytics: false,
    customerExport: false,
    recurringSlots: false,
  },
  PRO: {
    label: "프로",
    maxActiveProducts: 100,
    maxTeamMembers: 10,
    customMessageTemplates: true,
    advancedAnalytics: true,
    customerExport: true,
    recurringSlots: true,
  },
} as const;
