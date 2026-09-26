ALTER TABLE "billing_events"
  ADD COLUMN "billingCheckoutId" UUID REFERENCES "billing_checkouts"("id");

CREATE INDEX "billing_events_billingCheckoutId_idx"
  ON "billing_events"("billingCheckoutId");

ALTER TABLE "billing_events" DROP CONSTRAINT "billing_events_target_check";
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_target_check" CHECK (
  (("subscriptionId" IS NOT NULL)::int + ("dayPassId" IS NOT NULL)::int + ("billingCheckoutId" IS NOT NULL)::int) = 1
);
