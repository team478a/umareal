ALTER TABLE "line_oauth_flows" ADD COLUMN "acquisition" JSONB;
ALTER TABLE "line_registration_grants" ADD COLUMN "acquisition" JSONB;

CREATE TABLE "member_acquisitions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "medium" TEXT,
  "campaign" TEXT,
  "content" TEXT,
  "term" TEXT,
  "landingPath" TEXT,
  "referralCode" TEXT,
  "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "member_acquisitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "member_acquisitions_userId_key" UNIQUE ("userId"),
  CONSTRAINT "member_acquisitions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "member_acquisitions_source_campaign_capturedAt_idx" ON "member_acquisitions"("source", "campaign", "capturedAt");

CREATE FUNCTION reject_member_acquisition_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Member acquisition first-touch data is immutable';
END;
$$;

CREATE TRIGGER member_acquisitions_no_update_delete
BEFORE UPDATE OR DELETE ON "member_acquisitions"
FOR EACH ROW EXECUTE FUNCTION reject_member_acquisition_mutation();

CREATE TRIGGER member_acquisitions_no_truncate
BEFORE TRUNCATE ON "member_acquisitions"
FOR EACH STATEMENT EXECUTE FUNCTION reject_member_acquisition_mutation();
