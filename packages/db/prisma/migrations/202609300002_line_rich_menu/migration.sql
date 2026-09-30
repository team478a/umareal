ALTER TABLE "line_oauth_flows" ADD COLUMN "returnPath" TEXT;

CREATE TABLE "line_rich_menu_publications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "status" TEXT NOT NULL DEFAULT 'PUBLISHING',
  "providerRichMenuId" TEXT,
  "menuSnapshot" JSONB NOT NULL,
  "imageSha256" TEXT NOT NULL,
  "imageBytes" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(3),
  "errorCode" TEXT,
  CONSTRAINT "line_rich_menu_publications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "line_rich_menu_publications_status_check" CHECK ("status" IN ('PUBLISHING', 'PUBLISHED', 'FAILED')),
  CONSTRAINT "line_rich_menu_publications_image_check" CHECK ("imageBytes" BETWEEN 1 AND 1048576),
  CONSTRAINT "line_rich_menu_publications_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  CONSTRAINT "line_rich_menu_publications_completion_check" CHECK (
    ("status" = 'PUBLISHING' AND "completedAt" IS NULL AND "providerRichMenuId" IS NULL AND "errorCode" IS NULL)
    OR ("status" = 'PUBLISHED' AND "completedAt" IS NOT NULL AND "providerRichMenuId" IS NOT NULL AND "errorCode" IS NULL)
    OR ("status" = 'FAILED' AND "completedAt" IS NOT NULL AND "errorCode" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "line_rich_menu_publications_providerRichMenuId_key" ON "line_rich_menu_publications"("providerRichMenuId");
CREATE INDEX "line_rich_menu_publications_status_createdAt_idx" ON "line_rich_menu_publications"("status", "createdAt");
CREATE INDEX "line_rich_menu_publications_createdAt_idx" ON "line_rich_menu_publications"("createdAt");
CREATE UNIQUE INDEX "line_rich_menu_publications_single_publishing" ON "line_rich_menu_publications" (("status")) WHERE "status" = 'PUBLISHING';

ALTER TABLE "line_rich_menu_publications"
  ADD CONSTRAINT "line_rich_menu_publications_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION protect_line_rich_menu_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'line_rich_menu_publications is append-only' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'PUBLISHING' THEN
    RAISE EXCEPTION 'completed rich menu publication is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status NOT IN ('PUBLISHED', 'FAILED') THEN
    RAISE EXCEPTION 'invalid rich menu publication transition' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW."menuSnapshot", NEW."imageSha256", NEW."imageBytes", NEW.reason, NEW."createdBy", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD.id, OLD."menuSnapshot", OLD."imageSha256", OLD."imageBytes", OLD.reason, OLD."createdBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'rich menu publication content is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "line_rich_menu_publication_guard"
BEFORE UPDATE OR DELETE ON "line_rich_menu_publications"
FOR EACH ROW EXECUTE FUNCTION protect_line_rich_menu_publication();
