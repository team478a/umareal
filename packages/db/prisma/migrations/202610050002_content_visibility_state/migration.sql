ALTER TABLE content_items ADD COLUMN "isVisible" BOOLEAN NOT NULL DEFAULT false;

UPDATE content_items
SET "isVisible" = true
WHERE status IN ('PUBLISHED', 'SCHEDULED')
  AND EXISTS (SELECT 1 FROM content_versions WHERE "contentId" = content_items.id);

CREATE INDEX content_items_isVisible_updatedAt_idx ON content_items("isVisible", "updatedAt");
