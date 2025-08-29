-- Search performance indexes and backfill firstPublishedAt

-- 1) PGroonga indexes for text search
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pv_title_pgroonga
ON "PageVersion" USING pgroonga (title);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pv_text_pgroonga
ON "PageVersion" USING pgroonga ("textContent");

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_displayname_pgroonga
ON "User" USING pgroonga ("displayName");

-- 2) GIN index for tags array filters
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pv_tags_gin
ON "PageVersion" USING GIN (tags);

-- 3) Partial indexes for current PageVersion filtering/sorting
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pv_validfrom_current
ON "PageVersion" ("validFrom") WHERE "validTo" IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pv_rating_current
ON "PageVersion" (rating) WHERE "validTo" IS NULL;

-- 4) Composite index for fast first-revision lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rev_wikidot_ts
ON "Revision" ("wikidotId", timestamp);

-- 5) Backfill Page.firstPublishedAt from earliest Revision timestamp per wikidotId
DO $$
DECLARE
  __has_col boolean;
BEGIN
  -- Ensure column exists (defensive; Prisma schema already defines it)
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Page' AND column_name = 'firstPublishedAt'
  ) INTO __has_col;

  IF __has_col THEN
    WITH firsts AS (
      SELECT r."wikidotId", MIN(r.timestamp) AS min_ts
      FROM "Revision" r
      GROUP BY r."wikidotId"
    )
    UPDATE "Page" p
    SET "firstPublishedAt" = f.min_ts
    FROM firsts f
    WHERE p."wikidotId" = f."wikidotId"
      AND (p."firstPublishedAt" IS NULL OR p."firstPublishedAt" > f.min_ts);
  END IF;
END $$;


