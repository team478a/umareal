ALTER TABLE "billing_events"
  ADD COLUMN "createdTxId" BIGINT NOT NULL DEFAULT txid_current();

ALTER TABLE "notification_events" ADD COLUMN "billingEventId" UUID;
CREATE UNIQUE INDEX "notification_events_billingEventId_key" ON "notification_events"("billingEventId");
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_billingEventId_fkey"
  FOREIGN KEY ("billingEventId") REFERENCES "billing_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_target_check";
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_target_check" CHECK (
  (("versionId" IS NOT NULL)::integer
    + ("announcementId" IS NOT NULL)::integer
    + ("freeReportVersionId" IS NOT NULL)::integer
    + ("productVersionId" IS NOT NULL)::integer
    + ("raceResultVersionId" IS NOT NULL)::integer
    + ("win5EvaluationVersionId" IS NOT NULL)::integer
    + ("supportEventId" IS NOT NULL)::integer
    + ("billingEventId" IS NOT NULL)::integer) = 1
);

CREATE FUNCTION enforce_billing_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_tx BIGINT; source_type TEXT; expected_type TEXT;
BEGIN
  IF NEW."billingEventId" IS NULL THEN RETURN NEW; END IF;
  SELECT "createdTxId", "eventType" INTO source_tx, source_type FROM "billing_events" WHERE "id" = NEW."billingEventId";
  IF source_tx IS NULL OR source_tx <> txid_current() THEN
    RAISE EXCEPTION 'Billing notification must be created in the billing event transaction';
  END IF;
  expected_type := CASE source_type
    WHEN 'SUBSCRIPTION_STARTED' THEN 'BILLING_PAYMENT_SUCCEEDED'
    WHEN 'SUBSCRIPTION_RENEWED' THEN 'BILLING_PAYMENT_SUCCEEDED'
    WHEN 'DAY_PASS_PENDING' THEN 'BILLING_PAYMENT_SUCCEEDED'
    WHEN 'DAY_PASS_STARTED' THEN 'BILLING_PAYMENT_SUCCEEDED'
    WHEN 'PAYMENT_FAILED' THEN 'BILLING_PAYMENT_FAILED'
    WHEN 'PAYMENT_RECOVERED' THEN 'BILLING_PAYMENT_RECOVERED'
    WHEN 'CANCELLATION_SCHEDULED' THEN 'BILLING_CANCELLATION_SCHEDULED'
    WHEN 'CANCELLATION_REVERSED' THEN 'BILLING_CANCELLATION_REVERSED'
    WHEN 'SUBSCRIPTION_ENDED' THEN 'BILLING_SUBSCRIPTION_ENDED'
    WHEN 'DAY_PASS_REFUNDED' THEN 'BILLING_REFUND_COMPLETED'
    ELSE NULL
  END;
  IF expected_type IS NULL OR NEW."eventType" <> expected_type THEN
    RAISE EXCEPTION 'Billing notification type is invalid';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER billing_notification_event_guard
  BEFORE INSERT ON "notification_events"
  FOR EACH ROW EXECUTE FUNCTION enforce_billing_notification_event();
