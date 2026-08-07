-- =====================================================================================
-- 0206_page_source_provenance.sql
-- page_source 来源可追溯 + 当前源码专用写入口。
--
-- 迁移前的 page_source 同时含 v1 S2 回填和 v2 直抓，却没有任何来源列。旧行无法在
-- 事后无损还原，统一标 legacy_unattributed；adult 建页前已有的 102 页已由 v1
-- PageVersion 回填链路核实，单独标 v1_backfill。迁移后的每次直抓必须显式给 origin。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0206] 拒绝在受保护库 % 上修改 page_source', current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

ALTER TABLE ingest.page_source
  ADD COLUMN IF NOT EXISTS observation_source text NOT NULL DEFAULT 'legacy_unattributed',
  ADD COLUMN IF NOT EXISTS run_id bigint;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'ingest.page_source'::regclass
       AND conname = 'page_source_observation_source_ck'
  ) THEN
    ALTER TABLE ingest.page_source
      ADD CONSTRAINT page_source_observation_source_ck
      CHECK (observation_source IN (
        'legacy_unattributed',
        'v1_backfill',
        'wikidot_anonymous',
        'wikidot_authenticated'
      ));
  END IF;
END
$constraint$;

COMMENT ON COLUMN ingest.page_source.observation_source IS
  '本条源码指认的采集来源。legacy_unattributed=0206 前无法无损反推的旧行；'
  'v1_backfill=v1 PageVersion 结转；wikidot_anonymous/authenticated=v2 实际 AMC 抓取。';
COMMENT ON COLUMN ingest.page_source.run_id IS
  '产生本条源码指认的 meta.ingest_run.id；旧回填没有 run id 时可空。';

-- 这些行的 observed_at 全早于 adult 身份建页，且已与 v1 PageVersion 回填逐项核实。
-- page_source 是 append-only；来源列属于这次迁移补录的元数据，显式开启迁移上下文。
SET LOCAL scpper.bypass_guard = 'on';
UPDATE ingest.page_source ps
   SET observation_source = 'v1_backfill'
  FROM serve.page_current pc
 WHERE pc.page_id = ps.page_id
   AND pc.slug LIKE 'adult:%'
   -- 实测 adult 遗留源码最晚 2026-07-21，受限身份建页在 2026-08-06；限制历史
   -- 窗口保证迁移文件重跑时不会把未来的 unattributed 行误标成 v1。
   AND ps.observed_at < '2026-08-01T00:00:00Z'::timestamptz
   AND ps.observation_source = 'legacy_unattributed';

-- NULL rev_no 是“当前源码观测”，同一字节可分别被 v1 与 v2 真实观测；来源不能再被
-- 旧 (page_id, blob_sha) 唯一键吞掉。
DROP INDEX IF EXISTS ingest.ps_backfill_null;
CREATE UNIQUE INDEX IF NOT EXISTS ps_current_observation
  ON ingest.page_source(page_id, blob_sha, observation_source)
  WHERE rev_no IS NULL;

COMMENT ON INDEX ingest.ps_current_observation IS
  'NULL rev_no 当前源码按 page/blob/采集来源幂等；保留 v1 遗留与 v2 实抓的独立证据。';

CREATE OR REPLACE FUNCTION ingest.apply_current_page_source(
  p_page               int,
  p_source_wikitext    text,
  p_text_content       text,
  p_observed           timestamptz,
  p_observation_source text,
  p_run                 bigint DEFAULT NULL,
  p_wikidot_id          int DEFAULT NULL,
  p_rev_no              int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_sha bytea;
  v_inserted int := 0;
  v_hit int := 0;
BEGIN
  IF p_source_wikitext IS NULL THEN
    RAISE EXCEPTION 'apply_current_page_source: source_wikitext 不得为 NULL'
      USING ERRCODE = '22004';
  END IF;
  IF p_observation_source NOT IN ('wikidot_anonymous', 'wikidot_authenticated') THEN
    RAISE EXCEPTION 'apply_current_page_source: 非法 v2 来源 %', p_observation_source
      USING ERRCODE = '22023';
  END IF;

  PERFORM meta.assert_writes_allowed('content');
  PERFORM meta.assert_writes_allowed('page');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  v_sha := ingest.put_content_blob(p_source_wikitext, p_text_content);

  IF p_rev_no IS NULL THEN
    INSERT INTO ingest.page_source(
      page_id, rev_no, blob_sha, observed_at, observation_source, run_id
    ) VALUES (
      p_page, NULL, v_sha, p_observed, p_observation_source, p_run
    )
    ON CONFLICT (page_id, blob_sha, observation_source) WHERE rev_no IS NULL
    DO NOTHING;
  ELSE
    INSERT INTO ingest.page_source(
      page_id, rev_no, blob_sha, observed_at, observation_source, run_id
    ) VALUES (
      p_page, p_rev_no, v_sha, p_observed, p_observation_source, p_run
    )
    ON CONFLICT (page_id, rev_no) WHERE rev_no IS NOT NULL DO NOTHING;
  END IF;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE serve.page_current pc
     SET source_sha = v_sha,
         search_text = CASE
           WHEN p_text_content IS NULL OR p_text_content = '' THEN pc.search_text
           ELSE p_text_content
         END,
         updated_at = now()
   WHERE pc.page_id = p_page;
  GET DIAGNOSTICS v_hit = ROW_COUNT;
  IF v_hit = 0 THEN
    RAISE EXCEPTION 'apply_current_page_source: page_current 缺 page_id=%', p_page
      USING ERRCODE = '23503';
  END IF;

  RETURN jsonb_build_object(
    'source_sha', encode(v_sha, 'hex'),
    'page_source_inserted', v_inserted = 1,
    'observation_source', p_observation_source,
    'run_id', p_run
  );
END
$fn$;

REVOKE ALL ON FUNCTION ingest.apply_current_page_source(
  int, text, text, timestamptz, text, bigint, int, int
) FROM PUBLIC;

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION ingest.apply_current_page_source(
      int, text, text, timestamptz, text, bigint, int, int
    ) TO ingestor_role;
  END IF;
  IF to_regrole('migration_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION ingest.apply_current_page_source(
      int, text, text, timestamptz, text, bigint, int, int
    ) TO migration_role;
  END IF;
END
$grants$;

COMMIT;
