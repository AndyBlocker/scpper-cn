-- =====================================================================================
-- 0056_adaptive_egress_connection_pressure.sql
--
-- 连接失败会先于 HTTP 响应发生；连续 reset 打开进程内断路器后，原 100-attempt 窗口
-- 永远凑不满，导致 5/5 全坏仍停在 level 0。本迁移先提供兼容 schema：
--   * request bucket / 当前窗口单列连接失败（它仍是 pressure failures 的子集）；
--   * 跨短进程保存连接失败 streak 与上次连接信号降档时间；
--   * 保存 ingest_run 与 egress bucket 的滚动 1h 对账状态，并接入 oldest-pending。
--
-- 策略代码只能在本迁移之后生效。迁移本身不根据历史失败改变当前档位。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0056] 拒绝在受保护库 % 上修改出口护栏', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.egress_control') IS NULL
     OR to_regclass('meta.egress_request_bucket') IS NULL
     OR to_regclass('meta.pending_collection_current') IS NULL
     OR to_regclass('meta.pending_collection_audit_registry') IS NULL THEN
    RAISE EXCEPTION '[0056] 缺少 0037/0040 自适应出口与 pending 观测前置对象'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

SELECT pg_advisory_xact_lock(20260805);

ALTER TABLE meta.egress_request_bucket
  ADD COLUMN IF NOT EXISTS connection_failures int NOT NULL DEFAULT 0;

ALTER TABLE meta.egress_request_bucket
  DROP CONSTRAINT IF EXISTS egress_request_bucket_counts_ck;
ALTER TABLE meta.egress_request_bucket
  ADD CONSTRAINT egress_request_bucket_counts_ck CHECK (
    requests >= 0
    AND failures >= 0
    AND deterministic_failures >= 0
    AND connection_failures >= 0
    AND failures + deterministic_failures <= requests
    AND connection_failures <= failures
  );

ALTER TABLE meta.egress_control
  ADD COLUMN IF NOT EXISTS current_window_connection_failures int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_window_connection_failure_rate real,
  ADD COLUMN IF NOT EXISTS connection_failure_streak int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_connection_failure_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_connection_backoff_at timestamptz;

ALTER TABLE meta.egress_control
  DROP CONSTRAINT IF EXISTS egress_control_connection_counts_ck;
ALTER TABLE meta.egress_control
  ADD CONSTRAINT egress_control_connection_counts_ck CHECK (
    current_window_connection_failures >= 0
    AND current_window_connection_failures <= current_window_failures
    AND connection_failure_streak >= 0
    AND (
      last_window_connection_failure_rate IS NULL
      OR last_window_connection_failure_rate BETWEEN 0 AND 1
    )
  );

COMMENT ON COLUMN meta.egress_request_bucket.connection_failures IS
  '未取得 HTTP 响应的 DNS/代理/connect/TLS/timeout/reset attempt；是 failures 子集。permit 已预留，因此请求未上 wire 也不会失账。';
COMMENT ON COLUMN meta.egress_control.connection_failure_streak IS
  '全站共享的短时连续无响应连接失败数；任一取得 HTTP 响应的 outcome 清零。用于未满 100-request 时的稀疏压力判据。';
COMMENT ON COLUMN meta.egress_control.last_connection_backoff_at IS
  '最近一次由连接稀疏信号消费的逐级降档/保持时刻；限制同一抖动不能瞬间连跳到 cooldown。';

CREATE TABLE IF NOT EXISTS meta.egress_accounting_check (
  site_key                  text PRIMARY KEY
    REFERENCES meta.egress_control(site_key) ON DELETE CASCADE,
  status                    text NOT NULL,
  observed_at               timestamptz NOT NULL,
  window_started_at         timestamptz NOT NULL,
  ingest_failures           bigint NOT NULL,
  ingest_total              bigint NOT NULL,
  ingest_failure_rate       real,
  egress_failures           bigint NOT NULL,
  egress_total              bigint NOT NULL,
  egress_failure_rate       real,
  absolute_rate_gap         real,
  rate_ratio                real,
  divergent_since           timestamptz,
  details                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT egress_accounting_check_status_ck CHECK (
    status IN ('insufficient', 'aligned', 'divergent')
  ),
  CONSTRAINT egress_accounting_check_counts_ck CHECK (
    ingest_failures >= 0 AND ingest_total >= ingest_failures
    AND egress_failures >= 0 AND egress_total >= egress_failures
    AND (ingest_failure_rate IS NULL OR ingest_failure_rate BETWEEN 0 AND 1)
    AND (egress_failure_rate IS NULL OR egress_failure_rate BETWEEN 0 AND 1)
    AND (absolute_rate_gap IS NULL OR absolute_rate_gap BETWEEN 0 AND 1)
    AND (rate_ratio IS NULL OR rate_ratio >= 1)
    AND ((status = 'divergent') = (divergent_since IS NOT NULL))
  )
);

COMMENT ON TABLE meta.egress_accounting_check IS
  '最近 1h ingest_run 批级可重试失败率与 gate pressure attempt 失败率的持久对账；确定性失败从 ingest 分子排除。';
COMMENT ON COLUMN meta.egress_accounting_check.divergent_since IS
  '连续满足最小样本、至少 5 个百分点且至少 3 倍背离的起点；恢复对齐即清空。';

INSERT INTO meta.pending_collection_audit_registry(
  schema_name, relation_name, classification, collection_families, rationale
) VALUES (
  'meta', 'egress_accounting_check', 'covered', ARRAY['egress_accounting_divergence'],
  'ingest_run 与 egress bucket 最近 1h 失败率持续背离时进入 oldest-pending'
)
ON CONFLICT (schema_name, relation_name) DO UPDATE
  SET classification = EXCLUDED.classification,
      collection_families = EXCLUDED.collection_families,
      rationale = EXCLUDED.rationale;

DO $view$
BEGIN
  IF to_regclass('meta.pending_collection_current_pre0056') IS NULL THEN
    ALTER VIEW meta.pending_collection_current RENAME TO pending_collection_current_pre0056;
  END IF;
END
$view$;

CREATE OR REPLACE VIEW meta.pending_collection_current AS
SELECT p.collection, p.family, p.pending_count, p.oldest_item_at,
       p.oldest_item_key, p.catchup, p.evidence
  FROM meta.pending_collection_current_pre0056 p
UNION ALL
SELECT 'egress_accounting:wikidot'::text AS collection,
       'egress_accounting_divergence'::text AS family,
       GREATEST(c.ingest_failures, c.egress_failures, 1)::bigint AS pending_count,
       c.divergent_since AS oldest_item_at,
       c.site_key AS oldest_item_key,
       false AS catchup,
       jsonb_build_object(
         'window', '1 hour',
         'ingest_failures', c.ingest_failures,
         'ingest_total', c.ingest_total,
         'ingest_failure_rate', c.ingest_failure_rate,
         'egress_failures', c.egress_failures,
         'egress_total', c.egress_total,
         'egress_failure_rate', c.egress_failure_rate,
         'absolute_rate_gap', c.absolute_rate_gap,
         'rate_ratio', c.rate_ratio,
         'ratio_unbounded', c.rate_ratio IS NULL AND c.absolute_rate_gap > 0,
         'minimum_samples_each', 100,
         'minimum_absolute_gap', 0.05,
         'minimum_rate_ratio', 3,
         'deterministic_failures_excluded', true,
         'observed_at', c.observed_at
       ) AS evidence
  FROM meta.egress_accounting_check c
 WHERE c.status = 'divergent';

COMMENT ON VIEW meta.pending_collection_current IS
  '0056：既有 pending 集合 + ingest_run/egress bucket 最近 1h 失败率连续背离。';

INSERT INTO meta.egress_alert(
  site_key, kind, from_level, to_level, reason,
  rolling_hour_requests, failure_rate, details
)
SELECT site_key, 'policy_rebase', level, level,
       'policy_v6_connection_pressure_visibility',
       rolling_hour_requests, last_window_failure_rate,
       jsonb_build_object(
         'old_policy', policy,
         'connection_failure_streak_to_backoff', 5,
         'connection_failure_streak_window_seconds', 120,
         'connection_backoff_min_interval_seconds', 300,
         'max_connection_levels_per_outcome', 1,
         'deterministic_failures_excluded', true,
         'no_qq_delivery', true
       )
  FROM meta.egress_control
 WHERE site_key = 'wikidot'
   AND coalesce((policy->>'version')::int, 0) <> 6;

UPDATE meta.egress_control
   SET policy = policy || jsonb_build_object(
         'version', 6,
         'connection_failures_in_pressure_numerator', true,
         'connection_failure_streak_to_backoff', 5,
         'connection_failure_streak_window_seconds', 120,
         'connection_backoff_min_interval_seconds', 300,
         'max_connection_levels_per_outcome', 1,
         'egress_accounting_window_minutes', 60,
         'egress_accounting_minimum_samples_each', 100,
         'egress_accounting_minimum_absolute_gap', 0.05,
         'egress_accounting_minimum_rate_ratio', 3
       ),
       updated_at = clock_timestamp()
 WHERE site_key = 'wikidot'
   AND coalesce((policy->>'version')::int, 0) <> 6;

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON meta.egress_accounting_check TO ingestor_role;
    GRANT SELECT ON meta.pending_collection_current TO ingestor_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT ON meta.egress_accounting_check, meta.pending_collection_current
      TO projector_role;
  END IF;
END
$grants$;

COMMIT;
