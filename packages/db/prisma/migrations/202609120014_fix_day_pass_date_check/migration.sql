ALTER TABLE "day_passes" DROP CONSTRAINT "day_passes_values_check";
ALTER TABLE "day_passes" ADD CONSTRAINT "day_passes_values_check" CHECK (
  "raceDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND
  "status" IN ('PENDING','ACTIVE','USED','EXPIRED','REFUNDED') AND
  "priceYen" >= 0 AND "endsAt" > "startsAt"
);
