-- =====================================================================================
-- 0018_layered_incremental.sql
-- L0 updated_at 内容增量 + L1 同频全站投票扫描的跨短进程状态与持续覆盖证明。
--
-- 关键事实：
--   * 内容编辑（含标签/标题/附件/改名/新建）创建 revision 并推进 updated_at；
--   * 投票不创建 revision，也不推进 updated_at，因此 L1 必须全站扫描且禁止早停；
--   * L1 同批拿 revisions，与 L0 交叉核对并把覆盖率持续写进 meta。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0018] 拒绝在受保护库 % 上创建分层增量状态；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

CREATE TABLE IF NOT EXISTS meta.incremental_page_state (
  slug                  text PRIMARY KEY,
  page_id               int,
  last_l0_revision      int,
  last_l0_updated_at    timestamptz,
  last_l0_seen_at       timestamptz,
  last_l1_revision      int,
  last_l1_rating        int,
  last_l1_rating_votes  int,
  last_l1_seen_at       timestamptz,
  last_l1_run_id        bigint REFERENCES meta.ingest_run(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ips_slug_nonempty_ck CHECK (btrim(slug) <> ''),
  CONSTRAINT ips_revision_nonnegative_ck CHECK (
    (last_l0_revision IS NULL OR last_l0_revision >= 0)
    AND (last_l1_revision IS NULL OR last_l1_revision >= 0)
  ),
  CONSTRAINT ips_rating_votes_nonnegative_ck
    CHECK (last_l1_rating_votes IS NULL OR last_l1_rating_votes >= 0)
);

CREATE INDEX IF NOT EXISTS ips_page_id
  ON meta.incremental_page_state(page_id)
  WHERE page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ips_l0_seen
  ON meta.incremental_page_state(last_l0_seen_at DESC);
CREATE INDEX IF NOT EXISTS ips_l1_seen
  ON meta.incremental_page_state(last_l1_seen_at DESC);

CREATE TABLE IF NOT EXISTS meta.incremental_signal (
  run_id       bigint      NOT NULL REFERENCES meta.ingest_run(id) ON DELETE CASCADE,
  layer        text        NOT NULL,
  slug         text        NOT NULL,
  page_id      int,
  signal       text        NOT NULL,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  details      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, layer, slug, signal),
  CONSTRAINT is_layer_ck CHECK (layer IN ('L0','L1','L2','L3')),
  CONSTRAINT is_slug_nonempty_ck CHECK (btrim(slug) <> ''),
  CONSTRAINT is_signal_nonempty_ck CHECK (btrim(signal) <> '')
);

CREATE INDEX IF NOT EXISTS is_layer_signal_detected
  ON meta.incremental_signal(layer, signal, detected_at DESC);
CREATE INDEX IF NOT EXISTS is_slug_detected
  ON meta.incremental_signal(slug, detected_at DESC);
CREATE INDEX IF NOT EXISTS is_page_detected
  ON meta.incremental_signal(page_id, detected_at DESC)
  WHERE page_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS meta.revision_coverage_metric (
  l1_run_id             bigint PRIMARY KEY
    REFERENCES meta.ingest_run(id) ON DELETE CASCADE,
  window_started_at     timestamptz NOT NULL,
  window_ended_at       timestamptz NOT NULL,
  is_baseline_init      boolean     NOT NULL DEFAULT false,
  baseline_init_reason  text,
  l1_revision_changes   int         NOT NULL,
  l0_captured_changes   int         NOT NULL,
  l0_missed_changes     int         NOT NULL,
  coverage_rate         numeric,
  rolling_7d_changes    int         NOT NULL,
  rolling_7d_captured   int         NOT NULL,
  rolling_7d_coverage   numeric,
  sample_missed_slugs   text[]      NOT NULL DEFAULT '{}',
  measured_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rcm_window_ck CHECK (window_ended_at >= window_started_at),
  CONSTRAINT rcm_counts_ck CHECK (
    l1_revision_changes >= 0
    AND l0_captured_changes >= 0
    AND l0_missed_changes >= 0
    AND l0_captured_changes + l0_missed_changes = l1_revision_changes
    AND rolling_7d_changes >= 0
    AND rolling_7d_captured >= 0
    AND rolling_7d_captured <= rolling_7d_changes
  ),
  CONSTRAINT rcm_coverage_ck CHECK (
    (l1_revision_changes = 0 AND coverage_rate IS NULL)
    OR
    (l1_revision_changes > 0 AND coverage_rate BETWEEN 0 AND 1)
  ),
  CONSTRAINT rcm_rolling_coverage_ck CHECK (
    (rolling_7d_changes = 0 AND rolling_7d_coverage IS NULL)
    OR
    (rolling_7d_changes > 0 AND rolling_7d_coverage BETWEEN 0 AND 1)
  )
);

CREATE INDEX IF NOT EXISTS rcm_measured_at
  ON meta.revision_coverage_metric(measured_at DESC);
CREATE INDEX IF NOT EXISTS rcm_missed
  ON meta.revision_coverage_metric(measured_at DESC)
  WHERE l0_missed_changes > 0;

COMMENT ON TABLE meta.incremental_page_state IS
  'L0/L1 独立跨轮基线。只在完整成功轮最后推进；失败轮不得用空结果或半轮覆盖。';
COMMENT ON TABLE meta.incremental_signal IS
  'L0 revision/updated_at 与 L1 vote/revision 变化的页级证据；sitemap 不再承担投票信号。';
COMMENT ON TABLE meta.revision_coverage_metric IS
  'L1 revisions 全站快照对 L0 updated_at 内容增量的持续交叉证明。l0_missed_changes>0 必须告警，并由 L1 补入 content/revisions_full。';
COMMENT ON COLUMN meta.revision_coverage_metric.rolling_7d_coverage IS
  '最近 7 日按修订变化页数加权的 L0 覆盖率；不是一次性断言。';
COMMENT ON COLUMN meta.revision_coverage_metric.is_baseline_init IS
  '比较基线早于 L0 启动或 L1 间隔超阈值时为真；该窗口保留审计，但不进入 rolling 且不触发告警。';

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ingestor_role') THEN
    GRANT SELECT, INSERT, UPDATE ON
      meta.incremental_page_state,
      meta.incremental_signal,
      meta.revision_coverage_metric
    TO ingestor_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'projector_role') THEN
    GRANT SELECT ON
      meta.incremental_page_state,
      meta.incremental_signal,
      meta.revision_coverage_metric
    TO projector_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bff_role') THEN
    GRANT SELECT ON meta.revision_coverage_metric TO bff_role;
  END IF;
END
$grants$;

COMMIT;
