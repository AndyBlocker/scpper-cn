\set ON_ERROR_STOP on
\timing on

BEGIN;

\echo 'Step 1/3: Build candidates & active targets (set-based)'

-- 今日已结束的“删除版本”
DROP TABLE IF EXISTS tmp_bad_page_versions;
CREATE TEMP TABLE tmp_bad_page_versions
ON COMMIT DROP
AS
SELECT id, "pageId"
FROM "PageVersion"
WHERE "isDeleted" = true
  AND "validFrom" >= date_trunc('day', now())
  AND "validTo"   IS NOT NULL;

-- 给临时表加轻量索引，便于后续 JOIN
CREATE INDEX ON tmp_bad_page_versions (id);
CREATE INDEX ON tmp_bad_page_versions ("pageId");

SELECT COUNT(*) AS candidate_versions FROM tmp_bad_page_versions;

-- 每个 page 的“当前活动版本”（若存在多条，取 validFrom 最大/ID 最大的那条）
DROP TABLE IF EXISTS tmp_active_pv;
CREATE TEMP TABLE tmp_active_pv
ON COMMIT DROP
AS
SELECT DISTINCT ON ("pageId")
       "pageId",
       id AS target_id
FROM "PageVersion"
WHERE "validTo" IS NULL
ORDER BY "pageId", "validFrom" DESC, id DESC;

CREATE UNIQUE INDEX ON tmp_active_pv ("pageId");

-- 让优化器了解行数分布
ANALYZE tmp_bad_page_versions;
ANALYZE tmp_active_pv;

\echo 'Guard: ensure every candidate page has an active target'
DO $$
DECLARE missing int;
BEGIN
  SELECT COUNT(*) INTO missing
  FROM tmp_bad_page_versions b
  LEFT JOIN tmp_active_pv t USING ("pageId")
  WHERE t.target_id IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'Found % pages without an active PageVersion target. Aborting.', missing;
  END IF;
END $$;

\echo 'Step 2/3: Migrate attributions in one shot'
WITH ins AS (
  INSERT INTO "Attribution" ("pageVerId","type","order","date","userId","anonKey")
  SELECT t.target_id, a."type", a."order", a."date", a."userId", a."anonKey"
  FROM "Attribution" a
  JOIN tmp_bad_page_versions b ON b.id = a."pageVerId"
  JOIN tmp_active_pv t USING ("pageId")
  WHERE a."pageVerId" <> t.target_id
  ON CONFLICT DO NOTHING
  RETURNING 1
)
SELECT COUNT(*) AS migrated_attributions FROM ins;

\echo 'Step 2b: Delete original attributions on redundant versions'
DELETE FROM "Attribution" a
USING tmp_bad_page_versions b
WHERE a."pageVerId" = b.id;

\echo 'Step 3/3: Delete redundant PageVersion rows'
DELETE FROM "PageVersion" pv
USING tmp_bad_page_versions b
WHERE pv.id = b.id;

COMMIT;

\echo 'Final check'
SELECT COUNT(*) AS remaining_todays_deletions
FROM "PageVersion"
WHERE "isDeleted" = true
  AND "validFrom" >= date_trunc('day', now())
  AND "validTo"   IS NOT NULL;

\echo 'Cleanup finished.'
