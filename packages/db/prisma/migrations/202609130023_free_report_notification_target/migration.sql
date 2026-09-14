ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_target_check";
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_target_check" CHECK (
  (("versionId" IS NOT NULL)::integer + ("announcementId" IS NOT NULL)::integer + ("freeReportVersionId" IS NOT NULL)::integer) = 1
);
