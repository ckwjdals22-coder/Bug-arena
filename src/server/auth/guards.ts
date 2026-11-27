import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { AdminRole, Business, MemberRole } from "@/generated/prisma/client";
import { BUSINESS_COOKIE } from "@/lib/cookies";
import { prisma } from "@/server/db";
import { err } from "@/server/errors";
import { readSession, type SessionUser } from "@/server/auth/session";

/**
 * 권한 가드.
 * - require*()        : 페이지·레이아웃용. 실패하면 로그인 화면 등으로 redirect 한다.
 * - require*OrThrow() : 서버 액션·라우트 핸들러·서비스용. 실패하면 AppError 를 던진다.
 * 모든 변경 작업은 화면의 가드와 별개로 액션/서비스 안에서 반드시 다시 확인한다.
 */

/** 프록시가 심어 주는 현재 경로(로그인 후 복귀용) */
async function currentPath(): Promise<string> {
  const h = await headers();
  return h.get("x-pathname") ?? "/";
}

// ── 회원 ──────────────────────────────────────────────

export async function getCurrentUser(): Promise<SessionUser | null> {
  return (await readSession("user"))?.user ?? null;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(await currentPath())}`);
  return user;
}

export async function requireUserOrThrow(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw err.unauthenticated();
  return user;
}

// ── 사업자 ────────────────────────────────────────────

export interface SellerContext {
  user: SessionUser;
  business: Business;
  role: MemberRole;
  /** 이 회원이 속한 모든 사업장(전환 메뉴용) */
  businesses: { id: string; name: string; role: MemberRole }[];
}

const ROLE_RANK: Record<MemberRole, number> = { STAFF: 1, MANAGER: 2, OWNER: 3 };

/** 현재 회원의 사업장 컨텍스트. 사업장이 없으면 null */
export const getSellerContext = cache(async (): Promise<SellerContext | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const memberships = await prisma.businessMember.findMany({
    where: { userId: user.id },
    include: { business: true },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length === 0) return null;
  const preferred = (await cookies()).get(BUSINESS_COOKIE)?.value;
  const active = memberships.find((m) => m.businessId === preferred) ?? memberships[0]!;
  return {
    user,
    business: active.business,
    role: active.role,
    businesses: memberships.map((m) => ({ id: m.businessId, name: m.business.name, role: m.role })),
  };
});

export interface SellerGuardOptions {
  /** 필요한 최소 역할. 기본 STAFF */
  minRole?: MemberRole;
  /** true 면 승인(APPROVED)된 사업장만 통과 */
  approvedOnly?: boolean;
}

export async function requireSeller(options: SellerGuardOptions = {}): Promise<SellerContext> {
  const user = await requireUser();
  const ctx = await getSellerContext();
  if (!ctx) redirect("/seller/onboarding");
  if (ROLE_RANK[ctx.role] < ROLE_RANK[options.minRole ?? "STAFF"]) redirect("/seller?denied=1");
  if (options.approvedOnly && ctx.business.status !== "APPROVED") redirect("/seller?pending=1");
  void user;
  return ctx;
}

export async function requireSellerOrThrow(options: SellerGuardOptions = {}): Promise<SellerContext> {
  await requireUserOrThrow();
  const ctx = await getSellerContext();
  if (!ctx) throw err.forbidden("사업자 등록이 필요해요.");
  if (ROLE_RANK[ctx.role] < ROLE_RANK[options.minRole ?? "STAFF"]) throw err.forbidden();
  if (options.approvedOnly && ctx.business.status !== "APPROVED") {
    throw err.forbidden("입점 심사가 끝난 뒤에 이용할 수 있어요.");
  }
  return ctx;
}

/**
 * 특정 사업장에 대한 권한 확인 — 리소스(상품·회차·예약)의 businessId 를 넣어 호출한다.
 * 다른 사업장의 데이터에 접근하려는 시도(IDOR)를 여기서 막는다.
 */
export async function assertBusinessAccess(
  userId: string,
  businessId: string,
  minRole: MemberRole = "STAFF",
): Promise<MemberRole> {
  const member = await prisma.businessMember.findUnique({
    where: { businessId_userId: { businessId, userId } },
    select: { role: true },
  });
  if (!member || ROLE_RANK[member.role] < ROLE_RANK[minRole]) throw err.forbidden();
  return member.role;
}

// ── 운영자 ────────────────────────────────────────────

export interface AdminContext {
  user: SessionUser;
  role: AdminRole;
}

function adminAllowed(role: AdminRole, allowed?: AdminRole[]): boolean {
  if (role === "SUPER") return true;
  return !allowed || allowed.includes(role);
}

export async function getAdminContext(): Promise<AdminContext | null> {
  const session = await readSession("admin");
  if (!session?.user.adminRole) return null;
  return { user: session.user, role: session.user.adminRole };
}

/** allowed 를 생략하면 모든 운영자 역할이 통과한다. SUPER 는 항상 통과. */
export async function requireAdmin(allowed?: AdminRole[]): Promise<AdminContext> {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/admin/login");
  if (!adminAllowed(ctx.role, allowed)) redirect("/admin?denied=1");
  return ctx;
}

export async function requireAdminOrThrow(allowed?: AdminRole[]): Promise<AdminContext> {
  const ctx = await getAdminContext();
  if (!ctx) throw err.unauthenticated("운영자 로그인이 필요해요.");
  if (!adminAllowed(ctx.role, allowed)) throw err.forbidden();
  return ctx;
}
