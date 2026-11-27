import "server-only";
import type { ConsentKind, Prisma } from "@/generated/prisma/client";
import { POLICY_VERSIONS } from "@/lib/policy";
import { prisma } from "@/server/db";

/**
 * 동의·철회 이력. 법적 증빙용이라 고치거나 지우지 않고 쌓기만 한다.
 * 트랜잭션 안에서 쓰려면 tx 를 넘긴다.
 */
export interface ConsentInput {
  userId: string;
  kind: ConsentKind;
  agreed: boolean;
  bookingId?: string | null;
  /** 제공받는 자(판매자 상호) 등 화면에 표시한 내용 */
  detail?: string | null;
  ip?: string | null;
}

type Db = Prisma.TransactionClient | typeof prisma;

const toRow = (input: ConsentInput) => ({
  userId: input.userId,
  kind: input.kind,
  agreed: input.agreed,
  version: POLICY_VERSIONS[input.kind],
  bookingId: input.bookingId ?? null,
  detail: input.detail ? input.detail.slice(0, 200) : null,
  ip: input.ip && input.ip !== "unknown" ? input.ip.slice(0, 64) : null,
});

export async function recordConsent(input: ConsentInput, db: Db = prisma): Promise<void> {
  await db.consentRecord.create({ data: toRow(input) });
}

export async function recordConsents(inputs: ConsentInput[], db: Db = prisma): Promise<void> {
  if (inputs.length === 0) return;
  await db.consentRecord.createMany({ data: inputs.map(toRow) });
}

export interface ConsentHistoryItem {
  id: string;
  kind: ConsentKind;
  agreed: boolean;
  version: string;
  bookingId: string | null;
  detail: string | null;
  createdAt: Date;
}

/** 본인 동의 이력(마이 > 개인정보·동의 내역) — IP 는 내보내지 않는다 */
export async function listConsentHistory(userId: string, limit = 50): Promise<ConsentHistoryItem[]> {
  return prisma.consentRecord.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: { id: true, kind: true, agreed: true, version: true, bookingId: true, detail: true, createdAt: true },
  });
}
