-- Add search_text column to PageVersion to store precomputed search payload
ALTER TABLE "PageVersion"
ADD COLUMN IF NOT EXISTS "search_text" text;

-- Backfill search_text for current (validTo IS NULL) PageVersions using existing textContent or latest SourceVersion
WITH payload AS (
  SELECT
    pv.id,
    COALESCE(
      NULLIF(pv."textContent", ''),
      (
        SELECT COALESCE(NULLIF(s."textContent", ''), s.source)
        FROM "SourceVersion" s
        WHERE s."pageVersionId" = pv.id
        ORDER BY s."isLatest" DESC, s.timestamp DESC
        LIMIT 1
      ),
      ''
    ) AS computed
  FROM "PageVersion" pv
  WHERE pv."validTo" IS NULL
)
UPDATE "PageVersion" pv
SET "search_text" = payload.computed
FROM payload
WHERE pv.id = payload.id
  AND (pv."search_text" IS DISTINCT FROM payload.computed OR pv."search_text" IS NULL);

-- Helper function to recompute search_text on demand
CREATE OR REPLACE FUNCTION public.refresh_pageversion_search_text(p_page_version_id integer)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_text text;
BEGIN
  SELECT NULLIF("textContent", '')
  INTO v_text
  FROM "PageVersion"
  WHERE id = p_page_version_id;

  IF v_text IS NOT NULL THEN
    UPDATE "PageVersion"
    SET "search_text" = v_text
    WHERE id = p_page_version_id;
    RETURN;
  END IF;

  SELECT COALESCE(NULLIF(s."textContent", ''), s.source, '')
  INTO v_text
  FROM "SourceVersion" s
  WHERE s."pageVersionId" = p_page_version_id
  ORDER BY s."isLatest" DESC, s.timestamp DESC
  LIMIT 1;

  UPDATE "PageVersion"
  SET "search_text" = COALESCE(v_text, '')
  WHERE id = p_page_version_id;
END;
$$;

-- Supporting trigger function for PageVersion updates
CREATE OR REPLACE FUNCTION public.trg_pageversion_set_search_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fallback text;
BEGIN
  IF COALESCE(NULLIF(NEW."textContent", ''), '') <> '' THEN
    NEW."search_text" := NEW."textContent";
  ELSE
    SELECT COALESCE(NULLIF(s."textContent", ''), s.source)
    INTO fallback
    FROM "SourceVersion" s
    WHERE s."pageVersionId" = NEW.id
    ORDER BY s."isLatest" DESC, s.timestamp DESC
    LIMIT 1;

    NEW."search_text" := COALESCE(fallback, COALESCE(NEW."search_text", ''));
  END IF;

  IF NEW."search_text" IS NULL THEN
    NEW."search_text" := '';
  END IF;

  RETURN NEW;
END;
$$;

-- Ensure PageVersion trigger is in place
DROP TRIGGER IF EXISTS trg_pageversion_search_text ON "PageVersion";
CREATE TRIGGER trg_pageversion_search_text
BEFORE INSERT OR UPDATE OF "textContent"
ON "PageVersion"
FOR EACH ROW
EXECUTE FUNCTION public.trg_pageversion_set_search_text();

-- Supporting trigger function for SourceVersion updates
CREATE OR REPLACE FUNCTION public.trg_sourceversion_refresh_search_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_id integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_id := OLD."pageVersionId";
  ELSE
    target_id := NEW."pageVersionId";
  END IF;

  PERFORM public.refresh_pageversion_search_text(target_id);
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Ensure SourceVersion trigger is in place
DROP TRIGGER IF EXISTS trg_sourceversion_refresh_search_text ON "SourceVersion";
CREATE TRIGGER trg_sourceversion_refresh_search_text
AFTER INSERT OR UPDATE OR DELETE
ON "SourceVersion"
FOR EACH ROW
EXECUTE FUNCTION public.trg_sourceversion_refresh_search_text();

-- PGroonga index on search_text for current PageVersions
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pv_search_text_current_pgroonga
ON "PageVersion" USING pgroonga ("search_text")
WHERE "validTo" IS NULL AND "search_text" IS NOT NULL;
