-- =====================================================================================
-- 0037_adaptive_egress.sql —— 全站共享的 Wikidot 自适应退让与滚动小时预算
-- =====================================================================================
-- 背景（2026-08-02 实测）：
--   * 3,663--3,847 请求/小时可连续运行且失败率 <= 0.6%；
--   * 下一档观测直接跳到 22.6%，随后即使降到 1,813/h 仍有 78.5% 失败；
--   * 约 460/h 后才恢复，说明是带惩罚期的站点限流，不是线性拥塞。
--
-- 因此状态必须跨 L0/L1/Tier2/sitemap 等短进程共享，且请求预算按真实 HTTP attempt
-- 记账，不能等 ingest_run 结束后才发现已经踩线。状态机实现在 TS；本迁移只提供：
--   1. 单例状态（当前档位、原因、最早恢复时刻、健康窗口进度）；
--   2. 分钟 × 通道请求桶（滚动 60 分钟护栏）；
--   3. 可持久查询、不会发送 QQ 的告警审计。
-- =====================================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS meta.egress_control (
  site_key                    text PRIMARY KEY,
  level                       smallint NOT NULL DEFAULT 0,
  reason                      text NOT NULL DEFAULT 'initial_normal',
  changed_at                  timestamptz NOT NULL DEFAULT now(),
  recover_not_before          timestamptz,
  next_permit_at              timestamptz NOT NULL DEFAULT now(),
  current_window_requests     int NOT NULL DEFAULT 0,
  current_window_failures     int NOT NULL DEFAULT 0,
  elevated_windows            int NOT NULL DEFAULT 0,
  healthy_windows             int NOT NULL DEFAULT 0,
  last_window_failure_rate    real,
  last_window_completed_at    timestamptz,
  rolling_hour_requests       int NOT NULL DEFAULT 0,
  budget_limit                int NOT NULL DEFAULT 3200,
  budget_breached             boolean NOT NULL DEFAULT false,
  last_pruned_at              timestamptz NOT NULL DEFAULT now(),
  policy                      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT egress_control_site_ck CHECK (site_key = 'wikidot'),
  CONSTRAINT egress_control_level_ck CHECK (level BETWEEN 0 AND 3),
  CONSTRAINT egress_control_counts_ck CHECK (
    current_window_requests >= 0 AND current_window_failures >= 0
    AND current_window_failures <= current_window_requests
    AND elevated_windows >= 0 AND healthy_windows >= 0
    AND rolling_hour_requests >= 0 AND budget_limit > 0
  )
);

CREATE TABLE IF NOT EXISTS meta.egress_request_bucket (
  site_key     text NOT NULL REFERENCES meta.egress_control(site_key) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  channel      text NOT NULL,
  requests     int NOT NULL DEFAULT 0,
  failures     int NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_key, bucket_start, channel),
  CONSTRAINT egress_request_bucket_minute_ck CHECK (
    bucket_start = date_trunc('minute', bucket_start)
  ),
  CONSTRAINT egress_request_bucket_counts_ck CHECK (
    requests >= 0 AND failures >= 0 AND failures <= requests
  )
);

CREATE INDEX IF NOT EXISTS erb_recent
  ON meta.egress_request_bucket(site_key, bucket_start DESC);

CREATE TABLE IF NOT EXISTS meta.egress_alert (
  id                    bigserial PRIMARY KEY,
  site_key              text NOT NULL REFERENCES meta.egress_control(site_key) ON DELETE CASCADE,
  kind                  text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  from_level            smallint NOT NULL,
  to_level              smallint NOT NULL,
  reason                text NOT NULL,
  rolling_hour_requests int,
  failure_rate          real,
  details               jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at       timestamptz,
  CONSTRAINT egress_alert_kind_ck CHECK (
    kind IN ('failure_backoff','budget_breach','recovery')
  ),
  CONSTRAINT egress_alert_level_ck CHECK (
    from_level BETWEEN 0 AND 3 AND to_level BETWEEN 0 AND 3
  )
);

CREATE INDEX IF NOT EXISTS ea_created
  ON meta.egress_alert(site_key, created_at DESC);
CREATE INDEX IF NOT EXISTS ea_unacknowledged
  ON meta.egress_alert(site_key, created_at DESC)
  WHERE acknowledged_at IS NULL;

INSERT INTO meta.egress_control(
  site_key, level, reason, budget_limit, policy
)
VALUES (
  'wikidot', 0, 'initial_normal', 3200,
  jsonb_build_object(
    'window_requests', 100,
    'elevated_failure_rate', 0.02,
    'severe_failure_rate', 0.05,
    'healthy_failure_rate', 0.01,
    'elevated_windows_to_backoff', 2,
    'healthy_windows_to_recover', 6,
    'rolling_budget_minutes', 60,
    'rolling_budget_requests', 3200,
    'tiers', jsonb_build_array(
      jsonb_build_object('level',0,'name','normal','min_interval_ms',333,'minimum_hold_minutes',0),
      jsonb_build_object('level',1,'name','cautious','min_interval_ms',667,'minimum_hold_minutes',30),
      jsonb_build_object('level',2,'name','protective','min_interval_ms',2000,'minimum_hold_minutes',45),
      jsonb_build_object('level',3,'name','cooldown','min_interval_ms',8000,'minimum_hold_minutes',60)
    )
  )
)
ON CONFLICT (site_key) DO UPDATE
SET budget_limit = EXCLUDED.budget_limit,
    policy = EXCLUDED.policy,
    updated_at = now();

-- 首次上线时把过去 60 分钟的已完成 ingest_run attempt 保守地归到 run 启动分钟，
-- 避免护栏在部署后的第一个小时从 0 开始失明。仅空表时执行，重复迁移不会重复计数。
INSERT INTO meta.egress_request_bucket(
  site_key, bucket_start, channel, requests, failures
)
SELECT 'wikidot', date_trunc('minute', r.started_at), 'bootstrap_pre_adaptive',
       sum(coalesce((r.stats->'http'->>'attempts')::int,
                    (r.stats->'http'->>'requests')::int, 0))::int,
       sum(coalesce(pressure.failures, 0))::int
  FROM meta.ingest_run r
  LEFT JOIN LATERAL (
    SELECT sum(bucket.value::int)::int AS failures
      FROM jsonb_each_text(coalesce(r.stats->'http'->'statusBuckets', '{}'::jsonb)) bucket
     WHERE bucket.key = 'transport'
        OR bucket.key = '429'
        OR (bucket.key ~ '^[0-9]+$' AND bucket.key::int >= 500)
  ) pressure ON true
 WHERE r.started_at >= now() - interval '60 minutes'
   AND coalesce((r.stats->'http'->>'attempts')::int,
                (r.stats->'http'->>'requests')::int, 0) > 0
   AND NOT EXISTS (SELECT 1 FROM meta.egress_request_bucket)
 GROUP BY date_trunc('minute', r.started_at)
ON CONFLICT DO NOTHING;

COMMENT ON TABLE meta.egress_control IS
  'Wikidot 全站共享出口反馈控制器单例。level/reason/recover_not_before/healthy_windows 可直接解释当前为何变慢、最早何时及还差多少健康窗口恢复。';
COMMENT ON COLUMN meta.egress_control.level IS
  '0 normal(3 QPS), 1 cautious(1.5 QPS), 2 protective(0.5 QPS), 3 cooldown(0.125 QPS≈450/h)。所有通道共享。';
COMMENT ON COLUMN meta.egress_control.recover_not_before IS
  '最早开始累计恢复健康窗口的时刻；持续失败或预算仍超限会向后延，禁止一轮好转立即恢复。';
COMMENT ON TABLE meta.egress_request_bucket IS
  '真实 HTTP attempt 的分钟×通道账。滚动 60 分钟 >3200 即强制 cooldown；permit 已预留但进程退出也保守计数。';
COMMENT ON TABLE meta.egress_alert IS
  '退让/预算越界/逐档恢复的持久告警；只写库与 stderr，不连接 QQ。';

DO $$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      meta.egress_control, meta.egress_request_bucket, meta.egress_alert
    TO ingestor_role;
    GRANT USAGE ON SEQUENCE meta.egress_alert_id_seq TO ingestor_role;
  END IF;
END $$;

COMMIT;
