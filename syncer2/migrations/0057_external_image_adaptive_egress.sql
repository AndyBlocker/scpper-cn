-- =====================================================================================
-- 0057_external_image_adaptive_egress.sql
--
-- 站外图片与 Wikidot 主站完全分账的按主机自适应出口：
--   * exact hostname 各自保存档位/健康窗口/小时预算；一个坏主机不污染其它主机；
--   * global 单例只做站外总量与相邻 attempt 节流，不接收失败反馈；
--   * 429/503/其它 5xx/transport 分列，避免 http_transient 丢掉限流证据；
--   * image job 保存结构化 http_status，跨轮重试继续由 attempts/not_before 承载。
--
-- 策略代码只能在本迁移之后生效。本迁移不改 Wikidot 的 meta.egress_* 三张表。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0057] 拒绝在受保护库 % 上修改站外图片出口护栏', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.image_ingest_job') IS NULL
     OR to_regclass('meta.egress_control') IS NULL THEN
    RAISE EXCEPTION '[0057] 缺少 0044 图片队列或 0037 Wikidot 出口前置对象'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

SELECT pg_advisory_xact_lock(20260812);

ALTER TABLE meta.image_ingest_job
  ADD COLUMN IF NOT EXISTS http_status smallint;

ALTER TABLE meta.image_ingest_job
  DROP CONSTRAINT IF EXISTS image_ingest_job_http_status_ck;
ALTER TABLE meta.image_ingest_job
  ADD CONSTRAINT image_ingest_job_http_status_ck CHECK (
    http_status IS NULL OR http_status BETWEEN 100 AND 599
  );

COMMENT ON COLUMN meta.image_ingest_job.http_status IS
  '最近一次 HTTP 失败状态；无响应 transport/circuit-open 为 NULL。用于把 429/503 与其它 http_transient 分账。';

CREATE TABLE IF NOT EXISTS meta.external_image_egress_global (
  singleton                 boolean PRIMARY KEY DEFAULT true,
  next_permit_at            timestamptz NOT NULL DEFAULT now(),
  rolling_hour_requests     int NOT NULL DEFAULT 0,
  budget_limit              int NOT NULL DEFAULT 650,
  budget_breached           boolean NOT NULL DEFAULT false,
  last_pruned_at            timestamptz NOT NULL DEFAULT now(),
  policy                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_image_egress_global_singleton_ck CHECK (singleton),
  CONSTRAINT external_image_egress_global_counts_ck CHECK (
    rolling_hour_requests >= 0 AND budget_limit > 0
  )
);

CREATE TABLE IF NOT EXISTS meta.external_image_egress_control (
  host                          text PRIMARY KEY,
  level                         smallint NOT NULL DEFAULT 0,
  reason                        text NOT NULL DEFAULT 'initial_normal',
  changed_at                    timestamptz NOT NULL DEFAULT now(),
  recover_not_before            timestamptz,
  next_permit_at                timestamptz NOT NULL DEFAULT now(),
  current_window_requests       int NOT NULL DEFAULT 0,
  current_window_failures       int NOT NULL DEFAULT 0,
  elevated_windows              int NOT NULL DEFAULT 0,
  healthy_windows               int NOT NULL DEFAULT 0,
  last_window_failure_rate      real,
  last_window_completed_at      timestamptz,
  rolling_hour_requests         int NOT NULL DEFAULT 0,
  budget_limit                  int NOT NULL DEFAULT 300,
  budget_breached               boolean NOT NULL DEFAULT false,
  policy                        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_image_egress_host_ck CHECK (
    host = lower(host) AND length(host) BETWEEN 1 AND 253
    AND host ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'
  ),
  CONSTRAINT external_image_egress_level_ck CHECK (level BETWEEN 0 AND 3),
  CONSTRAINT external_image_egress_counts_ck CHECK (
    current_window_requests >= 0
    AND current_window_failures >= 0
    AND current_window_failures <= current_window_requests
    AND elevated_windows >= 0
    AND healthy_windows >= 0
    AND rolling_hour_requests >= 0
    AND budget_limit > 0
    AND (last_window_failure_rate IS NULL OR last_window_failure_rate BETWEEN 0 AND 1)
  )
);

CREATE TABLE IF NOT EXISTS meta.external_image_egress_request_bucket (
  host                text NOT NULL
    REFERENCES meta.external_image_egress_control(host) ON DELETE CASCADE,
  bucket_start        timestamptz NOT NULL,
  requests            int NOT NULL DEFAULT 0,
  failures            int NOT NULL DEFAULT 0,
  status_429          int NOT NULL DEFAULT 0,
  status_503          int NOT NULL DEFAULT 0,
  other_5xx           int NOT NULL DEFAULT 0,
  transport_failures  int NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host, bucket_start),
  CONSTRAINT external_image_egress_bucket_minute_ck CHECK (
    bucket_start = date_trunc('minute', bucket_start)
  ),
  CONSTRAINT external_image_egress_bucket_counts_ck CHECK (
    requests >= 0 AND failures >= 0
    AND status_429 >= 0 AND status_503 >= 0
    AND other_5xx >= 0 AND transport_failures >= 0
    AND failures <= requests
    AND status_429 + status_503 + other_5xx + transport_failures = failures
  )
);

CREATE INDEX IF NOT EXISTS eie_rb_recent
  ON meta.external_image_egress_request_bucket(bucket_start DESC, host);
CREATE INDEX IF NOT EXISTS eie_host_next_permit
  ON meta.external_image_egress_control(next_permit_at, host);
CREATE INDEX IF NOT EXISTS iij_external_host_claim
  ON meta.image_ingest_job((split_part(normalized_url, '/', 3)), status, not_before NULLS FIRST, id)
  WHERE locked_by IS NULL AND status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS meta.external_image_egress_alert (
  id                    bigserial PRIMARY KEY,
  host                  text NOT NULL
    REFERENCES meta.external_image_egress_control(host) ON DELETE CASCADE,
  kind                  text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  from_level            smallint NOT NULL,
  to_level              smallint NOT NULL,
  reason                text NOT NULL,
  rolling_hour_requests int,
  failure_rate          real,
  details               jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at       timestamptz,
  CONSTRAINT external_image_egress_alert_kind_ck CHECK (
    kind IN ('rate_limit_backoff', 'failure_backoff', 'budget_breach', 'recovery')
  ),
  CONSTRAINT external_image_egress_alert_level_ck CHECK (
    from_level BETWEEN 0 AND 3 AND to_level BETWEEN 0 AND 3
  )
);

CREATE INDEX IF NOT EXISTS eie_alert_created
  ON meta.external_image_egress_alert(host, created_at DESC);
CREATE INDEX IF NOT EXISTS eie_alert_unacknowledged
  ON meta.external_image_egress_alert(host, created_at DESC)
  WHERE acknowledged_at IS NULL;

INSERT INTO meta.external_image_egress_global(
  singleton, budget_limit, policy
) VALUES (
  true, 650,
  jsonb_build_object(
    'scope', 'external_images_only',
    'normal_min_interval_ms', 3000,
    'rolling_budget_minutes', 60,
    'rolling_budget_requests', 650,
    'budget_breach_min_interval_ms', 30000
  )
)
ON CONFLICT (singleton) DO UPDATE
  SET budget_limit = EXCLUDED.budget_limit,
      policy = EXCLUDED.policy,
      updated_at = now();

COMMENT ON TABLE meta.external_image_egress_global IS
  '仅站外图片使用的总量护栏；只控制 aggregate pace/650 attempts per rolling hour，不接收失败反馈，不引用 Wikidot egress_control。';
COMMENT ON TABLE meta.external_image_egress_control IS
  '站外图片 exact-hostname 自适应状态；429/503 单次即逐级降档，普通 transport/5xx 走小窗口，恢复需保持期加连续健康窗口。';
COMMENT ON TABLE meta.external_image_egress_request_bucket IS
  '站外图片真实 attempt 的分钟×主机账；429/503/其它 5xx/transport 结构化分列。';
COMMENT ON TABLE meta.external_image_egress_alert IS
  '站外图片主机退让/恢复审计；只写库和 stderr，不连接 QQ。';

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      meta.external_image_egress_global,
      meta.external_image_egress_control,
      meta.external_image_egress_request_bucket,
      meta.external_image_egress_alert
    TO ingestor_role;
    GRANT USAGE ON SEQUENCE meta.external_image_egress_alert_id_seq TO ingestor_role;
  END IF;
  IF to_regrole('avatar_worker_role') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      meta.external_image_egress_global,
      meta.external_image_egress_control,
      meta.external_image_egress_request_bucket,
      meta.external_image_egress_alert
    TO avatar_worker_role;
    GRANT USAGE ON SEQUENCE meta.external_image_egress_alert_id_seq TO avatar_worker_role;
  END IF;
END
$grants$;

COMMIT;
