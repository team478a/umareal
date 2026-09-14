CREATE OR REPLACE FUNCTION reject_user_consent_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'User consent history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_consents_no_update_delete
BEFORE UPDATE OR DELETE ON "user_consents"
FOR EACH ROW EXECUTE FUNCTION reject_user_consent_mutation();

CREATE TRIGGER user_consents_no_truncate
BEFORE TRUNCATE ON "user_consents"
FOR EACH STATEMENT EXECUTE FUNCTION reject_user_consent_mutation();
