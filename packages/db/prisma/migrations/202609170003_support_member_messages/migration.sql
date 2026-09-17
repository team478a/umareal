ALTER TABLE "support_events" DROP CONSTRAINT "support_events_values_check";
ALTER TABLE "support_events" ADD CONSTRAINT "support_events_values_check" CHECK (
  "eventType" IN ('CREATED','MEMBER_MESSAGE','IN_PROGRESS','RESOLVED','REOPENED') AND
  "actorRole" IN ('MEMBER','OPERATOR','ADMIN') AND
  char_length("reason") BETWEEN 1 AND 2000 AND
  ("publicMessage" IS NULL OR char_length("publicMessage") BETWEEN 1 AND 2000) AND
  (("eventType" IN ('RESOLVED','MEMBER_MESSAGE') AND "publicMessage" IS NOT NULL) OR
   ("eventType" NOT IN ('RESOLVED','MEMBER_MESSAGE') AND "publicMessage" IS NULL)) AND
  ("eventType" <> 'MEMBER_MESSAGE' OR "actorRole" = 'MEMBER')
);
