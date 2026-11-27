import "server-only";
import { headers } from "next/headers";

/** 프록시가 넘겨준 클라이언트 IP. 알 수 없으면 "unknown" */
export async function getClientIp(): Promise<string> {
  const h = await headers();
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return h.get("x-real-ip")?.trim() || "unknown";
}

export async function getUserAgent(): Promise<string | null> {
  const h = await headers();
  return h.get("user-agent")?.slice(0, 300) ?? null;
}
