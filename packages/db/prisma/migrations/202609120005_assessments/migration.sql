CREATE TABLE "assessments" (
 "id" UUID PRIMARY KEY, "entryId" UUID NOT NULL UNIQUE REFERENCES "race_entries"("id"),
 "content" JSONB NOT NULL CHECK (jsonb_typeof("content") = 'object'),
 "revision" INTEGER NOT NULL CHECK ("revision" > 0), "updatedBy" UUID NOT NULL,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "assessment_versions" (
 "id" UUID PRIMARY KEY, "assessmentId" UUID NOT NULL REFERENCES "assessments"("id"),
 "revision" INTEGER NOT NULL CHECK ("revision" > 0), "content" JSONB NOT NULL,
 "entrySnapshot" JSONB NOT NULL, "actorId" UUID NOT NULL, "reason" TEXT NOT NULL CHECK (length(trim("reason")) > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("assessmentId", "revision")
);
CREATE FUNCTION protect_assessment_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Assessment history is append only'; END;
$$;
CREATE TRIGGER assessment_history_immutable BEFORE UPDATE OR DELETE ON "assessment_versions"
 FOR EACH ROW EXECUTE FUNCTION protect_assessment_history();
CREATE TRIGGER assessment_history_no_truncate BEFORE TRUNCATE ON "assessment_versions"
 FOR EACH STATEMENT EXECUTE FUNCTION protect_assessment_history();
