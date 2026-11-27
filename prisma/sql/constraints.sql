
-- ─────────────────────────────────────────────────────────────
-- Prisma 스키마로 표현할 수 없는 무결성 제약(수동 추가)
-- ─────────────────────────────────────────────────────────────

-- 재고: 초과 예약은 DB 가 거부한다(중복 예약 방지의 최종 방어선).
ALTER TABLE "SlotSeat" ADD CONSTRAINT "SlotSeat_capacity_check" CHECK ("capacity" >= 0);
ALTER TABLE "SlotSeat" ADD CONSTRAINT "SlotSeat_reserved_check" CHECK ("reserved" >= 0 AND "reserved" <= "capacity");
ALTER TABLE "SlotSeat" ADD CONSTRAINT "SlotSeat_price_check" CHECK ("price" >= 0 AND ("originalPrice" IS NULL OR "originalPrice" >= 0));

-- 회차 시각
ALTER TABLE "Slot" ADD CONSTRAINT "Slot_time_check" CHECK ("endAt" > "startAt" AND "bookingDeadlineAt" <= "startAt");

-- 예약 금액
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_amount_check" CHECK (
  "unitPrice" >= 0 AND "totalAmount" >= 0 AND "payNowAmount" >= 0 AND "payOnsiteAmount" >= 0
  AND "payNowAmount" + "payOnsiteAmount" = "totalAmount"
  AND "refundAmount" >= 0 AND "refundAmount" <= "payNowAmount"
  AND "commissionAmount" >= 0 AND "pgFeeAmount" >= 0
);

-- 결제·환불 금액
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_check" CHECK ("amount" >= 0 AND "cancelledAmount" >= 0 AND "cancelledAmount" <= "amount");
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_check" CHECK ("amount" > 0);

-- 후기 별점
ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_check" CHECK ("rating" BETWEEN 1 AND 5);

-- 한 회원은 한 회차에 진행 중인 예약을 하나만 가질 수 있다(이중 제출·중복 예약 방지).
CREATE UNIQUE INDEX "Booking_active_user_slot_key" ON "Booking" ("userId", "slotId")
  WHERE "userId" IS NOT NULL AND "status" IN ('PENDING_PAYMENT', 'PENDING_APPROVAL', 'CONFIRMED');

-- 같은 좌석 유형에 대한 진행 중 대기는 회원당 하나.
CREATE UNIQUE INDEX "WaitlistEntry_active_user_seat_key" ON "WaitlistEntry" ("userId", "slotSeatId")
  WHERE "status" IN ('WAITING', 'OFFERED');

-- 예약 한 건에 승인된 결제는 하나만 존재한다(이중 결제 방지).
CREATE UNIQUE INDEX "Payment_paid_booking_key" ON "Payment" ("bookingId")
  WHERE "status" IN ('PAID', 'PARTIAL_CANCELLED');

-- 사업자 한 곳에는 대표(OWNER)가 한 명.
CREATE UNIQUE INDEX "BusinessMember_single_owner_key" ON "BusinessMember" ("businessId") WHERE "role" = 'OWNER';
