ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_finite_period"
  CHECK ("endsAt" > "startsAt" AND isfinite("startsAt") AND isfinite("endsAt") AND length(trim("reason")) > 0);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_aal" CHECK ("aal" IN (1, 2));
ALTER TABLE "races" ADD CONSTRAINT "race_number_positive" CHECK ("number" BETWEEN 1 AND 12);

CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER audit_no_update_delete BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
