ALTER TABLE "member_journey_events"
  ADD CONSTRAINT "member_journey_events_type_check"
  CHECK ("eventType" IN ('FIRST_LOGIN', 'LINE_GUIDANCE_VIEWED', 'PLAN_VIEWED', 'CHECKOUT_REVIEWED'));

CREATE FUNCTION reject_member_journey_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Member journey first-arrival data is immutable' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER member_journey_events_no_update_delete
BEFORE UPDATE OR DELETE ON "member_journey_events"
FOR EACH ROW EXECUTE FUNCTION reject_member_journey_event_mutation();

CREATE TRIGGER member_journey_events_no_truncate
BEFORE TRUNCATE ON "member_journey_events"
FOR EACH STATEMENT EXECUTE FUNCTION reject_member_journey_event_mutation();
