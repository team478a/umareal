CREATE TABLE "member_notification_reads" (
  "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "eventId" UUID NOT NULL REFERENCES "notification_events"("id") ON DELETE CASCADE,
  "readAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "eventId")
);

CREATE INDEX "member_notification_reads_userId_readAt_idx" ON "member_notification_reads"("userId", "readAt");
