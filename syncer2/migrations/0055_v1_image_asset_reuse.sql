-- =====================================================================================
-- 0055_v1_image_asset_reuse.sql
-- v1 READY 图片元数据复用索引：保留 canonicalUrl 与 PageVersionImage.normalizedUrl
-- 归一化后的 URL→内容 SHA 候选。一个 URL 可以对应多个 SHA；worker 只复用唯一候选，
-- 歧义必须保留并显式排除，不能用任意一行或最新一行猜测。
--
-- 迁移必须先于 image-asset-import/image-ingest 新代码生效。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0055] 拒绝在受保护库 % 上修改图片复用索引', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('serve.image_asset') IS NULL
     OR to_regclass('meta.pending_collection_audit_registry') IS NULL THEN
    RAISE EXCEPTION '[0055] 需要先执行 0002_serve.sql 与 0040_pending_collection_observability.sql';
  END IF;
END
$guard$;

BEGIN;

CREATE TABLE IF NOT EXISTS serve.image_asset_url_alias (
  normalized_url text        NOT NULL,
  asset_sha      bytea       NOT NULL REFERENCES serve.image_asset(hash_sha256),
  source         text        NOT NULL,
  source_url     text,
  first_seen_at  timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (normalized_url, asset_sha, source),
  CONSTRAINT image_asset_url_alias_normalized_ck CHECK (
    normalized_url <> ''
    AND normalized_url = lower(normalized_url)
    AND normalized_url ~ '^https://'
    AND normalized_url !~ '[?#]'
  ),
  CONSTRAINT image_asset_url_alias_source_ck CHECK (
    source IN ('v1_canonical', 'v1_page_version')
  )
);

CREATE INDEX IF NOT EXISTS iaua_normalized
  ON serve.image_asset_url_alias(normalized_url, asset_sha);
CREATE INDEX IF NOT EXISTS iaua_asset
  ON serve.image_asset_url_alias(asset_sha);
-- 批量复用以 normalized_url 驱动 79k 当前引用；原 PK(page_id, normalized_url) 无法服务
-- 这个方向，缺索引会退化成每个 alias 扫一次 page_image（实测重跑需 2 分钟）。
CREATE INDEX IF NOT EXISTS pi_normalized
  ON serve.page_image(normalized_url);
CREATE INDEX IF NOT EXISTS iij_normalized
  ON meta.image_ingest_job(normalized_url);

COMMENT ON TABLE serve.image_asset_url_alias IS
  'rebuild_from=v1 ImageAsset.canonicalUrl + PageVersionImage.normalizedUrl（只读导入）。'
  '保留 normalized_url 的全部 SHA 候选；只有 count(DISTINCT asset_sha)=1 才允许免下载复用。';
COMMENT ON COLUMN serve.image_asset_url_alias.normalized_url IS
  '与 src/content/extractImages.normalizeImageUrl 完全相同的大小写、wikidot→wdfiles、百分号解码及 query/fragment 口径。';
COMMENT ON COLUMN serve.image_asset_url_alias.source_url IS
  '归一化前的 v1 URL 样本，仅供审计；不得作为 worker 下载地址。';

-- 新表没有 pending 状态；显式登记仍是必需的，否则 checks/0005 双向差集会失败。
INSERT INTO meta.pending_collection_audit_registry(
  schema_name, relation_name, classification, collection_families, rationale
) VALUES (
  'serve', 'image_asset_url_alias', 'not_pending', '{}',
  'URL→内容 SHA 的可重建候选索引；多 SHA 是歧义证据而不是待消费状态'
)
ON CONFLICT (schema_name, relation_name) DO UPDATE
  SET classification = EXCLUDED.classification,
      collection_families = EXCLUDED.collection_families,
      rationale = EXCLUDED.rationale;

-- 0044 在 0040 全表审计之后才建该表，历史上漏登；它确有“新信号尚未 sweep”的 pending
-- 语义，不能为了让 coverage 变绿而错标 not_pending。
INSERT INTO meta.pending_collection_audit_registry(
  schema_name, relation_name, classification, collection_families, rationale
) VALUES (
  'meta', 'forum_incremental_category_state', 'covered',
  ARRAY['forum_incremental_category_state'],
  'observed_* 与 swept_* 不同或从未 swept 的分类信号待增量扫描'
)
ON CONFLICT (schema_name, relation_name) DO UPDATE
  SET classification = EXCLUDED.classification,
      collection_families = EXCLUDED.collection_families,
      rationale = EXCLUDED.rationale;

DO $grants$
BEGIN
  IF to_regrole('avatar_worker_role') IS NOT NULL THEN
    GRANT SELECT ON serve.image_asset_url_alias TO avatar_worker_role;
  END IF;
  IF to_regrole('migration_role') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON serve.image_asset_url_alias TO migration_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT ON serve.image_asset_url_alias TO projector_role;
  END IF;
END
$grants$;

-- 图片链路沿用 0054 的最近 1h「可判定结果」成功率口径，但按 egress_class 分账。
-- processing 是中间态；completed/pending-retry/failed 才进入成功率分母。
CREATE OR REPLACE VIEW meta.image_ingest_egress_health AS
WITH classes(egress_class) AS (
  VALUES ('wikidot_site'::text), ('external'::text)
), rollup AS (
  SELECT job.egress_class,
         count(*)::bigint AS observation_count,
         count(*) FILTER (WHERE job.status = 'processing')::bigint AS intermediate_count,
         count(*) FILTER (
           WHERE job.status = 'completed'
              OR (job.status IN ('pending','failed') AND job.attempts > 0)
         )::bigint AS evaluated_count,
         count(*) FILTER (WHERE job.status = 'completed')::bigint AS success_count,
         count(*) FILTER (
           WHERE job.status IN ('pending','failed') AND job.attempts > 0
         )::bigint AS failed_count,
         min(job.updated_at) FILTER (
           WHERE job.status = 'completed'
              OR (job.status IN ('pending','failed') AND job.attempts > 0)
         ) AS first_evaluated_at,
         max(job.updated_at) AS last_observed_at
    FROM meta.image_ingest_job job
   WHERE job.updated_at >= now() - interval '1 hour'
     AND job.egress_class IS NOT NULL
   GROUP BY job.egress_class
)
SELECT c.egress_class,
       now() - interval '1 hour' AS window_started_at,
       now() AS window_ended_at,
       COALESCE(r.observation_count, 0)::bigint AS observation_count,
       COALESCE(r.intermediate_count, 0)::bigint AS intermediate_count,
       COALESCE(r.evaluated_count, 0)::bigint AS evaluated_count,
       COALESCE(r.success_count, 0)::bigint AS success_count,
       COALESCE(r.failed_count, 0)::bigint AS failed_count,
       CASE WHEN COALESCE(r.evaluated_count, 0) = 0 THEN NULL
            ELSE r.success_count::numeric / r.evaluated_count::numeric END AS success_rate,
       r.first_evaluated_at,
       r.last_observed_at,
       10::bigint AS critical_min_observations,
       CASE
         WHEN COALESCE(r.evaluated_count, 0) >= 10 AND COALESCE(r.success_count, 0) = 0
           THEN 'critical'
         ELSE 'ok'
       END::text AS severity,
       CASE
         WHEN COALESCE(r.observation_count, 0) = 0 THEN 'no_tasks'
         WHEN COALESCE(r.evaluated_count, 0) = 0 THEN 'intermediate_only'
         WHEN COALESCE(r.evaluated_count, 0) >= 10 AND COALESCE(r.success_count, 0) = 0
           THEN 'rolling_zero_success'
         ELSE 'has_success_or_below_sample_threshold'
       END::text AS decision
  FROM classes c
  LEFT JOIN rollup r USING (egress_class);

COMMENT ON VIEW meta.image_ingest_egress_health IS
  '图片 worker 最近 1h 分链路成功率；wikidot_site 与 external 完全分账，processing 不进入分母。';

DO $view$
BEGIN
  IF to_regclass('meta.pending_collection_current_pre0055') IS NULL THEN
    ALTER VIEW meta.pending_collection_current RENAME TO pending_collection_current_pre0055;
  END IF;
END
$view$;

CREATE OR REPLACE VIEW meta.pending_collection_current AS
SELECT p.collection, p.family, p.pending_count, p.oldest_item_at,
       p.oldest_item_key, p.catchup, p.evidence
  FROM meta.pending_collection_current_pre0055 p
UNION ALL
SELECT 'image_ingest_success:' || h.egress_class AS collection,
       'image_ingest_zero_success'::text AS family,
       h.evaluated_count AS pending_count,
       h.first_evaluated_at AS oldest_item_at,
       h.egress_class AS oldest_item_key,
       false AS catchup,
       jsonb_build_object(
         'window', '1 hour',
         'scans', h.observation_count,
         'intermediates', h.intermediate_count,
         'evaluated', h.evaluated_count,
         'successes', h.success_count,
         'failed', h.failed_count,
         'success_rate', h.success_rate,
         'critical_min_scans', h.critical_min_observations,
         'decision', h.decision,
         'external_failures_affect_wikidot_health', false
       ) AS evidence
  FROM meta.image_ingest_egress_health h
 WHERE h.severity = 'critical'
UNION ALL
SELECT 'forum_incremental_category_state:unswept'::text AS collection,
       'forum_incremental_category_state'::text AS family,
       count(*)::bigint AS pending_count,
       min(state.signal_observed_at) AS oldest_item_at,
       (array_agg(state.category_id::text ORDER BY state.signal_observed_at, state.category_id))[1]
         AS oldest_item_key,
       false AS catchup,
       jsonb_build_object(
         'last_signal_observed_at', max(state.signal_observed_at),
         'never_swept', count(*) FILTER (WHERE state.swept_at IS NULL),
         'with_error', count(*) FILTER (WHERE state.last_error IS NOT NULL)
       ) AS evidence
  FROM meta.forum_incremental_category_state state
 WHERE state.swept_at IS NULL
    OR state.observed_thread_count IS DISTINCT FROM state.swept_thread_count
    OR state.observed_post_count IS DISTINCT FROM state.swept_post_count
    OR state.observed_last_post_at IS DISTINCT FROM state.swept_last_post_at
    OR state.observed_last_thread_id IS DISTINCT FROM state.swept_last_thread_id
    OR state.observed_last_post_id IS DISTINCT FROM state.swept_last_post_id
HAVING count(*) > 0;

COMMENT ON VIEW meta.pending_collection_current IS
  '0055：既有 oldest-pending 集合 + 图片 wikidot_site/external 分链路滚动零成功；两条链路互不污染。';

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT ON meta.image_ingest_egress_health, meta.pending_collection_current
      TO ingestor_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT ON meta.image_ingest_egress_health, meta.pending_collection_current
      TO projector_role;
  END IF;
END
$grants$;

COMMIT;
