-- CreateEnum
CREATE TYPE "ConsentKind" AS ENUM ('TERMS', 'PRIVACY', 'MARKETING', 'NIGHT_ALERT', 'THIRD_PARTY', 'REFUND_POLICY');

-- AlterEnum
ALTER TYPE "CustomerSource" ADD VALUE 'IMPORTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReportReason" ADD VALUE 'NO_SHOW_DISPUTE';
ALTER TYPE "ReportReason" ADD VALUE 'COMMISSION_DISPUTE';

-- DropIndex
DROP INDEX "WaitlistEntry_slotSeatId_status_createdAt_idx";

-- AlterTable
ALTER TABLE "AlertRule" ALTER COLUMN "categorySlugs" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "areaSlugs" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "daysOfWeek" SET DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "attendanceConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "commissionRule" TEXT,
ADD COLUMN     "policyAgreedAt" TIMESTAMP(3),
ADD COLUMN     "resaleMatchedAt" TIMESTAMP(3),
ADD COLUMN     "resalePendingQty" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resaleRefundRate" INTEGER,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "thirdPartyConsentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "launchPromoRemaining" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "launchPromoUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BusinessCustomer" ALTER COLUMN "tags" SET DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "maxPerBooking" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "resaleRefundRate" INTEGER,
ALTER COLUMN "images" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "tags" SET DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Slot" ADD COLUMN     "decideAt" TIMESTAMP(3),
ADD COLUMN     "goConfirmedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SlotSeat" ADD COLUMN     "minCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "kakaoId" TEXT;

-- AlterTable
ALTER TABLE "WaitlistEntry" ADD COLUMN     "missedOffers" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ConsentKind" NOT NULL,
    "agreed" BOOLEAN NOT NULL,
    "version" TEXT NOT NULL,
    "bookingId" TEXT,
    "detail" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsentRecord_userId_kind_createdAt_idx" ON "ConsentRecord"("userId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_bookingId_idx" ON "ConsentRecord"("bookingId");

-- CreateIndex
CREATE INDEX "Booking_slotSeatId_status_idx" ON "Booking"("slotSeatId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "User_kakaoId_key" ON "User"("kakaoId");

-- CreateIndex
CREATE INDEX "WaitlistEntry_slotSeatId_status_queuedAt_idx" ON "WaitlistEntry"("slotSeatId", "status", "queuedAt");

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 기존 대기 행의 순번 기준 시각은 신청 시각
UPDATE "WaitlistEntry" SET "queuedAt" = "createdAt";

-- 직접 추가한 제약
ALTER TABLE "SlotSeat" ADD CONSTRAINT "SlotSeat_minCount_check" CHECK ("minCount" >= 0 AND "minCount" <= "capacity");
ALTER TABLE "Product" ADD CONSTRAINT "Product_maxPerBooking_check" CHECK ("maxPerBooking" >= 1 AND "maxPerBooking" <= 20);
ALTER TABLE "Product" ADD CONSTRAINT "Product_resaleRefundRate_check" CHECK ("resaleRefundRate" IS NULL OR ("resaleRefundRate" >= 0 AND "resaleRefundRate" <= 100));
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_resale_check" CHECK ("resalePendingQty" >= 0 AND "resalePendingQty" <= "quantity" AND ("resaleRefundRate" IS NULL OR ("resaleRefundRate" >= 0 AND "resaleRefundRate" <= 100)));
ALTER TABLE "Business" ADD CONSTRAINT "Business_launchPromo_check" CHECK ("launchPromoRemaining" >= 0);
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_missedOffers_check" CHECK ("missedOffers" >= 0);
