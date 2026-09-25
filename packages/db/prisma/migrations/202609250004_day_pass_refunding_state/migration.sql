ALTER TABLE "day_passes" DROP CONSTRAINT "day_passes_values_check";
ALTER TABLE "day_passes" ADD CONSTRAINT "day_passes_values_check" CHECK (
  "raceDate" ~ '^\d{4}-\d{2}-\d{2}$' AND
  "status" IN ('PENDING','REFUNDING','ACTIVE','USED','EXPIRED','REFUNDED') AND
  "priceYen" >= 0 AND
  (
    ("status" IN ('PENDING','REFUNDING','REFUNDED') AND "startsAt" IS NULL AND "entitlementId" IS NULL) OR
    ("status" IN ('ACTIVE','USED','EXPIRED','REFUNDED') AND "startsAt" IS NOT NULL AND "entitlementId" IS NOT NULL AND "endsAt" > "startsAt")
  )
);
