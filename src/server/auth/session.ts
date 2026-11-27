import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import type { AdminRole, Gender, UserStatus } from "@/generated/prisma/client";
import { adminCookieName, cookieSecure, userCookieName } from "@/lib/cookies";
import { prisma } from "@/server/db";
import { getClientIp, getUserAgent } from "@/server/request";
import { randomToken, sha256 } from "@/server/security/crypto";

export type SessionKind = "user" | "admin";

const USER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일
const ADMIN_TTL_MS = 8 * 60 * 60 * 1000; // 8시간(절대 만료)
const ADMIN_IDLE_MS = 60 * 60 * 1000; // 운영자 세션은 60분간 활동이 없으면 만료
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  nickname: string | null;
  phone: string | null;
  gender: Gender | null;
  birthYear: number | null;
  status: UserStatus;
  adminRole: AdminRole | null;
  identityVerifiedAt: Date | null;
  bookingRestrictedUntil: Date | null;
  totpEnabledAt: Date | null;
}

export interface ActiveSession {
  sessionId: string;
  user: SessionUser;
}

const userSelect = {
  id: true,
  email: true,
  name: true,
  nickname: true,
  phone: true,
  gender: true,
  birthYear: true,
  status: true,
  adminRole: true,
  identityVerifiedAt: true,
  bookingRestrictedUntil: true,
  totpEnabledAt: true,
} as const;

const cookieName = (kind: SessionKind) => (kind === "admin" ? adminCookieName() : userCookieName());

/** 새 세션을 만들고 쿠키를 심는다. 서버 액션·라우트 핸들러에서만 호출할 수 있다. */
export async function createSession(userId: string, kind: SessionKind): Promise<void> {
  const token = randomToken(32);
  const ttl = kind === "admin" ? ADMIN_TTL_MS : USER_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);
  await prisma.authSession.create({
    data: {
      tokenHash: sha256(token),
      userId,
      isAdmin: kind === "admin",
      ip: await getClientIp(),
      userAgent: await getUserAgent(),
      expiresAt,
    },
  });
  const jar = await cookies();
  jar.set(cookieName(kind), token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: kind === "admin" ? "strict" : "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** 현재 요청의 세션을 읽는다(요청당 1회만 DB 조회). 없거나 무효면 null */
export const readSession = cache(async (kind: SessionKind): Promise<ActiveSession | null> => {
  const jar = await cookies();
  const token = jar.get(cookieName(kind))?.value;
  if (!token || token.length < 20 || token.length > 200) return null;

  const session = await prisma.authSession.findUnique({
    where: { tokenHash: sha256(token) },
    select: { id: true, isAdmin: true, expiresAt: true, revokedAt: true, lastSeenAt: true, user: { select: userSelect } },
  });
  if (!session || session.revokedAt) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) return null;
  if (session.isAdmin !== (kind === "admin")) return null;
  if (session.user.status !== "ACTIVE") return null;
  if (kind === "admin") {
    if (!session.user.adminRole) return null;
    if (now - session.lastSeenAt.getTime() > ADMIN_IDLE_MS) return null;
  }
  if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    // 활동 시각 갱신은 실패해도 요청을 막지 않는다.
    prisma.authSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  return { sessionId: session.id, user: session.user };
});

/** 현재 세션을 폐기하고 쿠키를 지운다. 서버 액션·라우트 핸들러에서만 호출할 수 있다. */
export async function destroySession(kind: SessionKind): Promise<void> {
  const jar = await cookies();
  const token = jar.get(cookieName(kind))?.value;
  if (token) {
    await prisma.authSession.updateMany({
      where: { tokenHash: sha256(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  // __Host- 접두사 쿠키는 Secure·Path=/ 속성이 같아야 브라우저가 삭제를 받아들인다.
  jar.set(cookieName(kind), "", {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: kind === "admin" ? "strict" : "lax",
    path: "/",
    maxAge: 0,
  });
}

/** 회원의 모든 세션 폐기(비밀번호 변경·정지·탈퇴 시). exceptSessionId 는 남긴다. */
export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> {
  await prisma.authSession.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
}

/** 만료·폐기된 세션 정리(크론에서 호출) */
export async function purgeSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await prisma.authSession.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });
  return result.count;
}
