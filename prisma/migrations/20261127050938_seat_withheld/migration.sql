-- AlterTable
ALTER TABLE "SlotSeat" ADD COLUMN     "withheld" INTEGER NOT NULL DEFAULT 0;

-- 보류 좌석은 항상 reserved 안에 포함된다.
ALTER TABLE "SlotSeat" ADD CONSTRAINT "SlotSeat_withheld_check" CHECK ("withheld" >= 0 AND "withheld" <= "reserved");
