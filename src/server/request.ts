import "server-only";
import { headers } from "next/headers";
import { env } from "@/lib/env";

/**
 * 클라이언트 IP.
 * X-Forwarded-For 는 클라이언트가 임의로 채울 수 있으므로, 신뢰하는 프록시가 덧붙인 값만 쓴다:
 * 오른쪽에서 TRUSTED_PROXY_HOPS 번째 값. 알 수 없으면 "unknown".
 */
export async function getClientIp(): Promise<string> {
  const h = await headers();
  const hops = env().TRUSTED_PROXY_HOPS;
  if (hops > 0) {
    const parts = (h.get("x-forwarded-for") ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const picked = parts[parts.length - hops] ?? parts[0];
    if (picked) return picked.slice(0, 64);
    const real = h.get("x-real-ip")?.trim();
    if (real) return real.slice(0, 64);
  }
  return "unknown";
}

export async function getUserAgent(): Promise<string | null> {
  const h = await headers();
  return h.get("user-agent")?.slice(0, 300) ?? null;
}
