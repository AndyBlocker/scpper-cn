-- =====================================================================================
-- 0054_page_scan_intermediate_health.sql
-- 分链路成功率把 claim_only 声明载体与可判定扫描分账。
--
-- page_scan 是高频写入表；现有采集器已用稳定的 *_claim_only: error 前缀标记这类
-- 「只登记声明、等待完整抓取」中间态，因此本迁移只替换视图，不 ALTER/重写热表。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0054] 拒绝在受保护库 % 上修改 page_scan 监控口径', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.page_scan') IS NULL
     OR to_regclass('meta.page_scan_kind_health') IS NULL
     OR to_regclass('meta.pending_collection_current') IS NULL
     OR to_regclass('meta.pending_collection_current_pre0053') IS NULL THEN
    RAISE EXCEPTION '[0054] 缺少 0053 page_scan 监控前置对象' USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

CREATE OR REPLACE VIEW meta.page_scan_kind_health AS
WITH kinds(kind) AS (
  VALUES ('meta'::text), ('votes'), ('revisions'), ('content'), ('attributions'),
         ('forum'), ('discussion'), ('files'), ('revision_source')
), classified AS (
  SELECT ps.*,
         (
           ps.status = 'partial'
           AND COALESCE(ps.error, '') ~ '^(l0|l1|tier1|listpages)_claim_only:'
         ) AS is_intermediate
    FROM meta.page_scan ps
   WHERE ps.scanned_at >= now() - interval '1 hour'
), rollup AS (
  SELECT ps.kind,
         count(*)::bigint AS scan_count,
         count(*) FILTER (WHERE ps.is_intermediate)::bigint AS intermediate_count,
         count(*) FILTER (WHERE NOT ps.is_intermediate)::bigint AS evaluated_count,
         count(*) FILTER (
           WHERE NOT ps.is_intermediate AND ps.status = 'ok'
         )::bigint AS success_count,
         count(*) FILTER (
           WHERE NOT ps.is_intermediate AND ps.status = 'partial'
         )::bigint AS partial_count,
         count(*) FILTER (
           WHERE NOT ps.is_intermediate AND ps.status = 'failed'
         )::bigint AS failed_count,
         min(ps.scanned_at) AS first_scan_at,
         max(ps.scanned_at) AS last_scan_at
    FROM classified ps
   GROUP BY ps.kind
)
SELECT k.kind,
       now() - interval '1 hour' AS window_started_at,
       now() AS window_ended_at,
       COALESCE(r.scan_count, 0)::bigint AS scan_count,
       COALESCE(r.success_count, 0)::bigint AS success_count,
       COALESCE(r.partial_count, 0)::bigint AS partial_count,
       COALESCE(r.failed_count, 0)::bigint AS failed_count,
       CASE WHEN COALESCE(r.evaluated_count, 0) = 0 THEN NULL
            ELSE r.success_count::numeric / r.evaluated_count::numeric END AS success_rate,
       r.first_scan_at,
       r.last_scan_at,
       10::bigint AS critical_min_scans,
       CASE
         WHEN COALESCE(r.evaluated_count, 0) >= 10 AND COALESCE(r.success_count, 0) = 0
           THEN 'critical'
         ELSE 'ok'
       END::text AS severity,
       CASE
         WHEN COALESCE(r.scan_count, 0) = 0 THEN 'no_tasks'
         WHEN COALESCE(r.evaluated_count, 0) = 0 THEN 'intermediate_only'
         WHEN COALESCE(r.evaluated_count, 0) >= 10 AND COALESCE(r.success_count, 0) = 0
           THEN 'rolling_zero_success'
         ELSE 'has_success_or_below_sample_threshold'
       END::text AS decision,
       COALESCE(r.intermediate_count, 0)::bigint AS intermediate_count,
       COALESCE(r.evaluated_count, 0)::bigint AS evaluated_count
  FROM kinds k
  LEFT JOIN rollup r USING (kind);

COMMENT ON VIEW meta.page_scan_kind_health IS
  '逐 page_scan kind 的最近 1h 成功率。scan_count 是原始证据数；intermediate_count 是 '
  '*_claim_only 声明中间态；evaluated_count 才是成功率与零成功 critical 的分母。';

CREATE OR REPLACE VIEW meta.pending_collection_current AS
SELECT p.collection, p.family, p.pending_count, p.oldest_item_at,
       p.oldest_item_key, p.catchup, p.evidence
  FROM meta.pending_collection_current_pre0053 p
UNION ALL
SELECT 'page_scan_success:' || h.kind AS collection,
       'page_scan_zero_success'::text AS family,
       h.evaluated_count AS pending_count,
       h.first_scan_at AS oldest_item_at,
       h.kind AS oldest_item_key,
       false AS catchup,
       jsonb_build_object(
         'window', '1 hour',
         'scans', h.scan_count,
         'intermediates', h.intermediate_count,
         'evaluated', h.evaluated_count,
         'successes', h.success_count,
         'partial', h.partial_count,
         'failed', h.failed_count,
         'success_rate', h.success_rate,
         'critical_min_scans', h.critical_min_scans,
         'decision', h.decision
       ) AS evidence
  FROM meta.page_scan_kind_health h
 WHERE h.severity = 'critical'
UNION ALL
SELECT 'revision_regression_identity:' || r.layer AS collection,
       'revision_regression_identity'::text AS family,
       count(*)::bigint AS pending_count,
       min(r.first_seen_at) AS oldest_item_at,
       (array_agg(r.page_id::text ORDER BY r.first_seen_at, r.page_id))[1]
         AS oldest_item_key,
       false AS catchup,
       jsonb_build_object(
         'layer', r.layer,
         'oldest_slug', (array_agg(r.slug ORDER BY r.first_seen_at, r.page_id))[1],
         'oldest_previous_revision',
           (array_agg(r.previous_revision ORDER BY r.first_seen_at, r.page_id))[1],
         'oldest_observed_revision',
           (array_agg(r.observed_revision ORDER BY r.first_seen_at, r.page_id))[1]
       ) AS evidence
  FROM meta.revision_regression_identity_state r
 WHERE r.status = 'pending'
 GROUP BY r.layer;

COMMENT ON VIEW meta.pending_collection_current IS
  '0054：既有 oldest-pending 集合 + 仅按可判定 page_scan 触发的分 kind 滚动零成功 + '
  '修订倒退身份复核状态；claim_only 中间态不进入失败集合。';

COMMIT;
