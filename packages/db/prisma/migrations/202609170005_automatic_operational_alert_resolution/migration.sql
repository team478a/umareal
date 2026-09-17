ALTER TABLE "operational_alerts" DROP CONSTRAINT "operational_alerts_ack_complete_check";
ALTER TABLE "operational_alerts" DROP CONSTRAINT "operational_alerts_resolution_complete_check";

ALTER TABLE "operational_alerts" ADD CONSTRAINT "operational_alerts_ack_complete_check" CHECK (
  ("status" = 'OPEN' AND "acknowledgedAt" IS NULL AND "acknowledgedBy" IS NULL AND "acknowledgeReason" IS NULL) OR
  ("status" = 'ACKNOWLEDGED' AND "acknowledgedAt" IS NOT NULL AND "acknowledgedBy" IS NOT NULL AND "acknowledgeReason" IS NOT NULL) OR
  ("status" = 'RESOLVED' AND (
    ("acknowledgedAt" IS NULL AND "acknowledgedBy" IS NULL AND "acknowledgeReason" IS NULL) OR
    ("acknowledgedAt" IS NOT NULL AND "acknowledgedBy" IS NOT NULL AND "acknowledgeReason" IS NOT NULL)
  ))
);

ALTER TABLE "operational_alerts" ADD CONSTRAINT "operational_alerts_resolution_complete_check" CHECK (
  ("status" <> 'RESOLVED' AND "resolvedAt" IS NULL AND "resolvedBy" IS NULL AND "resolutionReason" IS NULL) OR
  ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "resolutionReason" IS NOT NULL AND
    ("resolvedBy" IS NOT NULL OR "resolutionReason" LIKE 'SYSTEM:%'))
);
