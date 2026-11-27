import "server-only";
import { prisma } from "@/server/db";
import { err } from "@/server/errors";

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * 고정 윈도 요청 제한. Postgres 원자적 upsert 로 세기 때문에 서버가 여러 대여도 정확하다.
 * key 예: "login:ip:1.2.3.4", "booking:user:<id>"
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
  const windowMs = windowSec * 1000;
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key", "windowStart", "count")
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "RateLimit"."count" + 1
    RETURNING "count"`;
  const count = Number(rows[0]?.count ?? 1);
  const retryAfterSec = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now) / 1000));
  return { ok: count <= limit, remaining: Math.max(0, limit - count), retryAfterSec };
}

/** 한도를 넘으면 RATE_LIMITED 오류를 던진다. */
export async function enforceRateLimit(key: string, limit: number, windowSec: number, message?: string): Promise<void> {
  const result = await rateLimit(key, limit, windowSec);
  if (!result.ok) throw err.rateLimited(message);
}

/** 오래된 카운터 정리(크론에서 호출) */
export async function purgeRateLimits(olderThanHours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
  const result = await prisma.rateLimit.deleteMany({ where: { windowStart: { lt: cutoff } } });
  return result.count;
}
