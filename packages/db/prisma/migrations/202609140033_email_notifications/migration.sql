ALTER TABLE "notification_preferences"
  ADD COLUMN "emailEnabled" BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE "notification_events"
  ADD COLUMN "emailExpandedAt" TIMESTAMPTZ(3);

-- Never deliver historical events when email delivery is enabled for the first time.
UPDATE "notification_events"
SET "emailExpandedAt" = COALESCE("expandedAt", CURRENT_TIMESTAMP);

ALTER TABLE "system_settings"
  ADD COLUMN "emailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE "notification_deliveries"
  DROP CONSTRAINT IF EXISTS "notification_deliveries_channel_check";

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_channel_check"
  CHECK ("channel" IN ('LINE', 'EMAIL'));
