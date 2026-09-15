CREATE TABLE "operational_alert_settings" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "minimumSeverity" TEXT NOT NULL DEFAULT 'CRITICAL',
  "destinationEmails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "updatedBy" UUID,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operational_alert_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_alert_settings_severity_check" CHECK ("minimumSeverity" IN ('CRITICAL', 'WARNING'))
);

INSERT INTO "operational_alert_settings" ("id") VALUES ('global');

CREATE TABLE "operational_alerts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "dedupeKey" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "detectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastObservedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedAt" TIMESTAMPTZ(3),
  "acknowledgedBy" UUID,
  "acknowledgeReason" TEXT,
  "resolvedAt" TIMESTAMPTZ(3),
  "resolvedBy" UUID,
  "resolutionReason" TEXT,
  CONSTRAINT "operational_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_alerts_severity_check" CHECK ("severity" IN ('CRITICAL', 'WARNING')),
  CONSTRAINT "operational_alerts_status_check" CHECK ("status" IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  CONSTRAINT "operational_alerts_ack_complete_check" CHECK (("status" = 'OPEN' AND "acknowledgedAt" IS NULL AND "acknowledgedBy" IS NULL AND "acknowledgeReason" IS NULL) OR ("status" <> 'OPEN' AND "acknowledgedAt" IS NOT NULL AND "acknowledgedBy" IS NOT NULL AND "acknowledgeReason" IS NOT NULL)),
  CONSTRAINT "operational_alerts_resolution_complete_check" CHECK (("status" <> 'RESOLVED' AND "resolvedAt" IS NULL AND "resolvedBy" IS NULL AND "resolutionReason" IS NULL) OR ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "resolvedBy" IS NOT NULL AND "resolutionReason" IS NOT NULL))
);

CREATE UNIQUE INDEX "operational_alerts_dedupeKey_key" ON "operational_alerts"("dedupeKey");
CREATE INDEX "operational_alerts_status_detectedAt_idx" ON "operational_alerts"("status", "detectedAt");
CREATE INDEX "operational_alerts_severity_status_idx" ON "operational_alerts"("severity", "status");

CREATE TABLE "operational_alert_deliveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "alertId" UUID NOT NULL,
  "recipient" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMPTZ(3),
  "leaseToken" UUID,
  "lastErrorCode" TEXT,
  "providerMessageId" TEXT,
  "sentAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operational_alert_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_alert_deliveries_status_check" CHECK ("status" IN ('QUEUED', 'SENDING', 'SENT', 'FAILED')),
  CONSTRAINT "operational_alert_deliveries_attempt_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "operational_alert_deliveries_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "operational_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "operational_alert_deliveries_alertId_recipient_key" ON "operational_alert_deliveries"("alertId", "recipient");
CREATE INDEX "operational_alert_deliveries_status_nextAttemptAt_idx" ON "operational_alert_deliveries"("status", "nextAttemptAt");
