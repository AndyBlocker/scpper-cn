-- =====================================================================================
-- 0017_page_scan_retention.sql
-- meta.page_scan 保留策略：
--   * 每个 finished run 先汇总到 page_scan_run_summary；
--   * failed/partial 页级证据保留 30 天；
--   * 成功页级证据默认保留 1 小时，但每 (page,kind) 最新成功永不删；
--   * 删除推断依赖的 sitemap full / Tier1 各最近两轮完整 run 永不被本轮维护删除；
--   * tier1_claim_only 是声明载体，不是真失败，按成功证据期限处理。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0017] 拒绝在受保护库 % 上修改 page_scan；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

CREATE TABLE IF NOT EXISTS meta.page_scan_run_summary (
  run_id              bigint NOT NULL REFERENCES meta.ingest_run(id) ON DELETE CASCADE,
  kind                text NOT NULL,
  status              text NOT NULL,
  pages               bigint NOT NULL,
  claimed_pages       bigint NOT NULL,
  fetched_pages       bigint NOT NULL,
  checksum_ok_pages   bigint NOT NULL,
  checksum_bad_pages  bigint NOT NULL,
  first_scanned_at    timestamptz NOT NULL,
  last_scanned_at     timestamptz NOT NULL,
  refreshed_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, kind, status)
);

CREATE INDEX IF NOT EXISTS psrs_run ON meta.page_scan_run_summary(run_id);
CREATE INDEX IF NOT EXISTS ps_scanned_at ON meta.page_scan(scanned_at);

COMMENT ON TABLE meta.page_scan_run_summary IS
  'page_scan 的 run 级持久聚合。页级成功证据过期删除后，run 的数量/checksum 口径仍可审计。';

CREATE OR REPLACE FUNCTION meta.maintain_page_scan(
  p_success_retention interval DEFAULT interval '1 hour',
  p_failure_retention interval DEFAULT interval '30 days'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, meta
AS $fn$
DECLARE
  v_before bigint;
  v_after bigint;
  v_summarized bigint;
  v_deleted bigint;
BEGIN
  IF p_success_retention < interval '1 hour'
     OR p_failure_retention < interval '7 days' THEN
    RAISE EXCEPTION
      'page_scan retention 过短：success=% failure=%（最小 1 hour / 7 days）',
      p_success_retention, p_failure_retention;
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('meta.maintain_page_scan', 0)) THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'already_running');
  END IF;

  SELECT count(*) INTO v_before FROM meta.page_scan;

  INSERT INTO meta.page_scan_run_summary AS summary
    (run_id, kind, status, pages, claimed_pages, fetched_pages,
     checksum_ok_pages, checksum_bad_pages,
     first_scanned_at, last_scanned_at, refreshed_at)
  SELECT ps.run_id,
         ps.kind,
         ps.status,
         count(*)::bigint,
         count(*) FILTER (WHERE ps.claimed_total IS NOT NULL)::bigint,
         count(*) FILTER (WHERE ps.fetched_total IS NOT NULL)::bigint,
         count(*) FILTER (WHERE ps.checksum_ok IS TRUE)::bigint,
         count(*) FILTER (WHERE ps.checksum_ok IS FALSE)::bigint,
         min(ps.scanned_at),
         max(ps.scanned_at),
         now()
    FROM meta.page_scan ps
    JOIN meta.ingest_run ir ON ir.id=ps.run_id
   WHERE ir.finished_at IS NOT NULL
   GROUP BY ps.run_id, ps.kind, ps.status
  ON CONFLICT (run_id, kind, status) DO UPDATE
    SET pages = GREATEST(summary.pages, EXCLUDED.pages),
        claimed_pages = GREATEST(summary.claimed_pages, EXCLUDED.claimed_pages),
        fetched_pages = GREATEST(summary.fetched_pages, EXCLUDED.fetched_pages),
        checksum_ok_pages = GREATEST(summary.checksum_ok_pages, EXCLUDED.checksum_ok_pages),
        checksum_bad_pages = GREATEST(summary.checksum_bad_pages, EXCLUDED.checksum_bad_pages),
        first_scanned_at = LEAST(summary.first_scanned_at, EXCLUDED.first_scanned_at),
        last_scanned_at = GREATEST(summary.last_scanned_at, EXCLUDED.last_scanned_at),
        refreshed_at = now();
  GET DIAGNOSTICS v_summarized = ROW_COUNT;

  WITH ranked_enumerations AS (
    SELECT ir.id,
           row_number() OVER (
             PARTITION BY ir.source, ir.stats->>'mode'
             ORDER BY ir.started_at DESC, ir.id DESC
           ) AS ordinal
      FROM meta.ingest_run ir
     WHERE ir.status='ok'
       AND (
         (ir.source='wikidot' AND ir.stats->>'mode'='tier1')
         OR
         (ir.source='wikidot_sitemap' AND ir.stats->>'mode'='full')
       )
  ),
  retained_enumerations AS (
    SELECT id FROM ranked_enumerations WHERE ordinal <= 2
  )
  DELETE FROM meta.page_scan ps
   WHERE (
     ps.error LIKE 'tier1_claim_only:%'
     AND ps.scanned_at < now() - p_success_retention
     AND EXISTS (
       SELECT 1 FROM meta.ingest_run finished
        WHERE finished.id=ps.run_id AND finished.finished_at IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1 FROM retained_enumerations retained WHERE retained.id=ps.run_id
     )
   )
   OR (
     ps.status='ok'
     AND ps.scanned_at < now() - p_success_retention
     AND EXISTS (
       SELECT 1 FROM meta.ingest_run finished
        WHERE finished.id=ps.run_id AND finished.finished_at IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1 FROM retained_enumerations retained WHERE retained.id=ps.run_id
     )
     AND EXISTS (
       SELECT 1
         FROM meta.page_scan newer
        WHERE newer.page_id=ps.page_id
          AND newer.kind=ps.kind
          AND newer.status='ok'
          AND (newer.scanned_at, newer.run_id) > (ps.scanned_at, ps.run_id)
     )
   )
   OR (
     ps.status IN ('partial','failed')
     AND COALESCE(ps.error, '') NOT LIKE 'tier1_claim_only:%'
     AND ps.scanned_at < now() - p_failure_retention
   );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  SELECT count(*) INTO v_after FROM meta.page_scan;
  RETURN jsonb_build_object(
    'skipped', false,
    'before_rows', v_before,
    'after_rows', v_after,
    'deleted_rows', v_deleted,
    'summary_rows_touched', v_summarized,
    'success_retention', p_success_retention::text,
    'failure_retention', p_failure_retention::text,
    'retained_enumeration_runs_per_family', 2
  );
END
$fn$;

COMMENT ON FUNCTION meta.maintain_page_scan(interval, interval) IS
  '先固化 run 聚合，再清理过期页级证据。保留每页最新成功、最近两轮完整 sitemap/Tier1，'
  '真实 partial/failed 默认保留 30 天；tier1_claim_only 不冒充失败。';

-- 新对象不能等下一次 9002 重跑才获得权限；维护进程可能以 ingestor_role 运行。
-- BFF/projector 不需要看这张运维聚合表，PUBLIC 也不应借默认 EXECUTE 暴露维护入口。
REVOKE ALL ON meta.page_scan_run_summary FROM PUBLIC;
REVOKE ALL ON FUNCTION meta.maintain_page_scan(interval, interval) FROM PUBLIC;

DO $grant$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON meta.page_scan_run_summary TO ingestor_role;
    GRANT EXECUTE
      ON FUNCTION meta.maintain_page_scan(interval, interval) TO ingestor_role;
  END IF;
END
$grant$;

COMMIT;
