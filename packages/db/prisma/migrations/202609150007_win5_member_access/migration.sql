ALTER TABLE "day_passes" DROP CONSTRAINT "day_passes_values_check";
ALTER TABLE "day_passes" ALTER COLUMN "startsAt" DROP NOT NULL;
ALTER TABLE "day_passes" ALTER COLUMN "entitlementId" DROP NOT NULL;

ALTER TABLE "day_passes" ADD CONSTRAINT "day_passes_values_check" CHECK (
  "raceDate" ~ '^\d{4}-\d{2}-\d{2}$' AND
  "status" IN ('PENDING','ACTIVE','USED','EXPIRED','REFUNDED') AND
  "priceYen" >= 0 AND
  (
    ("status" = 'PENDING' AND "startsAt" IS NULL AND "entitlementId" IS NULL) OR
    ("startsAt" IS NOT NULL AND "entitlementId" IS NOT NULL AND "endsAt" > "startsAt")
  )
);
