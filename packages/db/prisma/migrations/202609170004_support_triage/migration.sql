ALTER TABLE "support_requests"
  ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "assignedToId" UUID,
  ADD COLUMN "dueAt" TIMESTAMPTZ(3);

ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_priority_check"
  CHECK ("priority" IN ('LOW','NORMAL','HIGH','URGENT'));

CREATE INDEX "support_requests_status_priority_dueAt_idx" ON "support_requests"("status", "priority", "dueAt");
CREATE INDEX "support_requests_assignedToId_status_idx" ON "support_requests"("assignedToId", "status");

ALTER TABLE "support_events" DROP CONSTRAINT "support_events_values_check";
ALTER TABLE "support_events" ADD CONSTRAINT "support_events_values_check" CHECK (
  "eventType" IN ('CREATED','MEMBER_MESSAGE','IN_PROGRESS','RESOLVED','REOPENED','TRIAGED') AND
  "actorRole" IN ('MEMBER','OPERATOR','ADMIN') AND
  char_length("reason") BETWEEN 1 AND 2000 AND
  ("publicMessage" IS NULL OR char_length("publicMessage") BETWEEN 1 AND 2000) AND
  (("eventType" IN ('RESOLVED','MEMBER_MESSAGE') AND "publicMessage" IS NOT NULL) OR
   ("eventType" NOT IN ('RESOLVED','MEMBER_MESSAGE') AND "publicMessage" IS NULL)) AND
  ("eventType" <> 'MEMBER_MESSAGE' OR "actorRole" = 'MEMBER') AND
  ("eventType" <> 'TRIAGED' OR "actorRole" IN ('OPERATOR','ADMIN'))
);

CREATE FUNCTION validate_support_assignee() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."assignedToId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "users" WHERE "id" = NEW."assignedToId" AND "role" IN ('ADMIN','OPERATOR') AND "disabledAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'support assignee must be an active administrator or operator';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER support_requests_assignee_guard
  BEFORE INSERT OR UPDATE OF "assignedToId" ON "support_requests"
  FOR EACH ROW EXECUTE FUNCTION validate_support_assignee();
