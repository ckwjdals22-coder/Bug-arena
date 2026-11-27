import "server-only";
import { z } from "zod";
import { prisma } from "@/server/db";

/**
 * 플랫폼 운영 설정. 운영자 콘솔에서 바꿀 수 있고, 저장된 값이 없으면 아래 기본값을 쓴다.
 * 수수료율은 bps(100bps = 1%).
 */
export const settingsSchema = z.object({
  /**
   * 남는자리 탐색·검색·빈자리 알림·대기 승격으로 온 "신규" 고객 예약의 중개 수수료.
   * 사업자에게 보이는 단일 요율이며 결제 대행 수수료를 포함한다(따로 떼지 않는다).
   */
  commissionNewCustomerBps: z.number().int().min(0).max(3000),
  /** 프로 플랜 사업자의 신규 고객 요율 */
  proCommissionNewCustomerBps: z.number().int().min(0).max(3000),
  /** 남는자리로 다시 온 재방문 고객(최근 returningWindowDays 안에 이용 이력) 요율 */
  commissionReturningBps: z.number().int().min(0).max(3000),
  /** 사업자 자체 링크·QR·미니 페이지로 온 예약의 중개 수수료(직접 입력 예약은 항상 0) */
  commissionDirectBps: z.number().int().min(0).max(3000),
  /** 1인(좌석 1개)당 중개 수수료 상한(원). 0 이면 상한 없음 */
  commissionCapPerSeat: z.number().int().min(0).max(1_000_000),
  /** 재방문 판정 기간(일) */
  returningWindowDays: z.number().int().min(30).max(1095),
  /**
   * 결제 실비율. 중개 수수료가 0 인 온라인 결제(자체 링크, 입점 프로모션, 가져온 고객)에만
   * 정산에서 실비로 차감한다. 카드 3.4% + 부가세 기준.
   */
  pgFeeBps: z.number().int().min(0).max(1000),
  /** 입점 프로모션: 승인 후 이 건수만큼 또는 이 개월 수 동안 중개 수수료 0% */
  launchPromoBookings: z.number().int().min(0).max(1000),
  launchPromoMonths: z.number().int().min(0).max(36),
  /** 결제 대기 중 좌석을 잡아 두는 시간(분) */
  holdMinutes: z.number().int().min(3).max(60),
  /** 대기자에게 자리를 제안하고 기다리는 기본 시간(분) — 시작 24시간 이상 전 */
  waitlistOfferMinutes: z.number().int().min(5).max(180),
  /** 시작 24시간 이내에는 남은 시간의 10%를 기다리되 이 값(분)보다 짧아지지 않는다 */
  waitlistOfferMinMinutes: z.number().int().min(5).max(120),
  /** 시작까지 이 시간(분) 이내면 순차 제안 대신 대기자 전원에게 동시에 알린다(선착순) */
  waitlistBroadcastWithinMinutes: z.number().int().min(0).max(1440),
  /** 예약 직후 무료 취소 가능 시간(분) — 실수 예약 보호 */
  cancelGraceMinutes: z.number().int().min(0).max(120),
  /** 예약 시점에 시작까지 이 시간(분) 미만으로 남은 임박 예약에는 무료 취소 시간을 주지 않는다 */
  cancelGraceMinLeadMinutes: z.number().int().min(0).max(2880),
  /** 최근 noShowWindowDays 일 동안 노쇼가 이 횟수에 이르면 예약 제한 */
  noShowLimit: z.number().int().min(1).max(10),
  noShowWindowDays: z.number().int().min(7).max(365),
  /** 예약 제한 기간(일) */
  noShowRestrictDays: z.number().int().min(1).max(365),
  /** 이용 완료 후 후기를 쓸 수 있는 기간(일) */
  reviewWindowDays: z.number().int().min(1).max(90),
  /** 프로 플랜 월 구독료(원, VAT 포함) */
  proPriceMonthly: z.number().int().min(0),
  /** 베이직 플랜에서 한 달에 보낼 수 있는 자동 문자 건수(공정 사용 한도) */
  freeMonthlyMessages: z.number().int().min(0),
  /** 프로 플랜 월 포함 문자 건수 */
  proMonthlyMessages: z.number().int().min(0),
  /** 종료 후 이 시간(시간)이 지나면 확정 예약을 자동으로 이용 완료 처리 */
  autoCompleteAfterHours: z.number().int().min(0).max(168),
});

export type PlatformSettings = z.infer<typeof settingsSchema>;

/**
 * 기본값은 docs/01-market-research.md 6장의 "제안값"이다(벤치마크에서 나온 가설).
 * 출시 전 초기 사업자 인터뷰로 확정하고 운영자 콘솔에서 바꾼다.
 */
export const DEFAULT_SETTINGS: PlatformSettings = {
  commissionNewCustomerBps: 990,
  proCommissionNewCustomerBps: 690,
  commissionReturningBps: 490,
  commissionDirectBps: 0,
  commissionCapPerSeat: 10_000,
  returningWindowDays: 365,
  pgFeeBps: 374,
  launchPromoBookings: 30,
  launchPromoMonths: 6,
  holdMinutes: 10,
  waitlistOfferMinutes: 30,
  waitlistOfferMinMinutes: 15,
  waitlistBroadcastWithinMinutes: 180,
  cancelGraceMinutes: 30,
  cancelGraceMinLeadMinutes: 180,
  noShowLimit: 2,
  noShowWindowDays: 365,
  noShowRestrictDays: 30,
  reviewWindowDays: 14,
  proPriceMonthly: 19_900,
  freeMonthlyMessages: 300,
  proMonthlyMessages: 2000,
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

/**
 * 플랜별 기능 범위.
 * 원칙: 자리를 채우는 기능(대기, 취소석 재등록, 직접 입력 예약, 자체 링크, 체크인, 환불 정책, 회차 일괄 등록)은
 * 요금제로 막지 않는다. 구독은 운영 효율·성장 도구에 받는다.
 */
export const PLAN_FEATURES = {
  FREE: {
    label: "베이직",
    maxActiveProducts: 10,
    maxTeamMembers: 1,
    customMessageTemplates: false,
    advancedAnalytics: false,
    customerExport: false,
    recurringSlots: true,
  },
  PRO: {
    label: "프로",
    maxActiveProducts: 200,
    maxTeamMembers: 5,
    customMessageTemplates: true,
    advancedAnalytics: true,
    customerExport: true,
    recurringSlots: true,
  },
} as const;
