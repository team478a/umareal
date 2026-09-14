CREATE TABLE "audio_assets" (
  "id" UUID NOT NULL,
  "contentType" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audio_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audio_assets_size_check" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 8388608),
  CONSTRAINT "audio_assets_content_type_check" CHECK ("contentType" IN ('audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/aac'))
);

CREATE INDEX "audio_assets_createdAt_idx" ON "audio_assets"("createdAt");
ALTER TABLE "audio_assets" ADD CONSTRAINT "audio_assets_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_audio_asset_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audio assets are append-only';
END;
$$;
CREATE TRIGGER audio_assets_no_update_delete BEFORE UPDATE OR DELETE ON "audio_assets" FOR EACH ROW EXECUTE FUNCTION reject_audio_asset_mutation();
CREATE TRIGGER audio_assets_no_truncate BEFORE TRUNCATE ON "audio_assets" FOR EACH STATEMENT EXECUTE FUNCTION reject_audio_asset_mutation();
