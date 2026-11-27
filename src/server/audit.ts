import "server-only";
import type { ActorType, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db";
import { getClientIp, getUserAgent } from "@/server/request";

export interface AuditInput {
  actorId?: string | null;
  actorType: ActorType;
  /** 점 표기 동사. 예: "business.approve", "booking.refund", "auth.login_failed" */
  action: string;
  targetType?: string;
  targetId?: string;
  /** 민감정보(비밀번호·계좌번호·토큰)는 절대 넣지 않는다. */
  meta?: Prisma.InputJsonValue;
}

/**
 * 감사 로그 기록. 본 작업을 막지 않도록 실패해도 예외를 던지지 않는다.
 * 요청 컨텍스트 밖(크론 등)에서 호출하면 IP·UA 는 비워 둔다.
 */
export async function audit(input: AuditInput): Promise<void> {
  let ip: string | null = null;
  let userAgent: string | null = null;
  try {
    ip = await getClientIp();
    userAgent = await getUserAgent();
  } catch {
    // 요청 컨텍스트가 없는 경우
  }
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorType: input.actorType,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        ip,
        userAgent,
        meta: input.meta,
      },
    });
  } catch (e) {
    console.error("[audit] 기록 실패", input.action, e);
  }
}
