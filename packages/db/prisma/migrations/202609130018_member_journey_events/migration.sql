CREATE TABLE "member_journey_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "eventType" TEXT NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "member_journey_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "member_journey_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "member_journey_events_userId_eventType_key" ON "member_journey_events"("userId", "eventType");
CREATE INDEX "member_journey_events_eventType_occurredAt_idx" ON "member_journey_events"("eventType", "occurredAt");
