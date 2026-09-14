CREATE TABLE "account_closures" (
  "id" UUID PRIMARY KEY,
  "userId" UUID NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "reasonCode" TEXT NOT NULL,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "accessRevokedAt" TIMESTAMPTZ(3) NOT NULL,
  "retentionPolicyVersion" TEXT NOT NULL,
  CONSTRAINT "account_closure_reason" CHECK ("reasonCode" IN ('SERVICE_NO_LONGER_NEEDED', 'PRICE', 'CONTENT', 'OTHER')),
  CONSTRAINT "account_closure_retention_policy" CHECK (length(trim("retentionPolicyVersion")) > 0),
  CONSTRAINT "account_closure_revocation_order" CHECK ("accessRevokedAt" >= "requestedAt")
);

CREATE INDEX "account_closures_requestedAt_idx" ON "account_closures"("requestedAt");

CREATE FUNCTION reject_account_closure_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'account_closures is append-only' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER account_closure_no_update_delete BEFORE UPDATE OR DELETE ON "account_closures"
  FOR EACH ROW EXECUTE FUNCTION reject_account_closure_mutation();
CREATE TRIGGER account_closure_no_truncate BEFORE TRUNCATE ON "account_closures"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_account_closure_mutation();
