ALTER TABLE "member_journey_events"
  DROP CONSTRAINT "member_journey_events_type_check";

ALTER TABLE "member_journey_events"
  ADD CONSTRAINT "member_journey_events_type_check"
  CHECK ("eventType" IN ('FIRST_LOGIN', 'LINE_GUIDANCE_VIEWED', 'PLAN_VIEWED', 'CHECKOUT_REVIEWED', 'REGISTRATION_BENEFIT_VIEWED'));
