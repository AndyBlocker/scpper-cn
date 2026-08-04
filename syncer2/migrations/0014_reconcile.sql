-- =====================================================================================
-- 0014_reconcile.sql
-- M10 对账层的持久化载体。
--
-- SPEC-projector §3 明确要求三轨对账、CROM 金丝雀与站内三角结果写入
-- meta.reconcile_report；0001–0013 的实库结构中尚无此表，因此在这里补齐。
--
-- 本表只保存管道证据，不保存业务事实。详细差异只留有界样本，完整判据与计数放 report；
-- qq_summary 是可由 qqbot 直接转发的紧凑 JSON，不含密钥、连接串或个人联系方式。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0014] 拒绝在受保护库 % 上创建 M10 对账表；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS meta.reconcile_report (
  id                bigserial PRIMARY KEY,
  run_id            bigint REFERENCES meta.ingest_run(id) ON DELETE SET NULL,
  mode              text        NOT NULL,
  status            text        NOT NULL,
  observed_at       timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  lag_window_seconds int        NOT NULL DEFAULT 3600,
  compared_count    int         NOT NULL DEFAULT 0,
  difference_count  int         NOT NULL DEFAULT 0,
  unexplained_count int         NOT NULL DEFAULT 0,
  report            jsonb       NOT NULL,
  qq_summary        jsonb       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reconcile_report_mode_ck
    CHECK (mode IN ('all', 'parity', 'crom', 'triangle')),
  CONSTRAINT reconcile_report_status_ck
    CHECK (status IN ('ok', 'partial', 'inconclusive', 'failed', 'aborted')),
  CONSTRAINT reconcile_report_nonnegative_ck
    CHECK (
      lag_window_seconds >= 0
      AND compared_count >= 0
      AND difference_count >= 0
      AND unexplained_count >= 0
    ),
  CONSTRAINT reconcile_report_counts_ck
    CHECK (
        unexplained_count <= difference_count
        AND difference_count <= compared_count
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS rr_run
  ON meta.reconcile_report(run_id)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rr_mode_observed
  ON meta.reconcile_report(mode, observed_at DESC);
CREATE INDEX IF NOT EXISTS rr_status_observed
  ON meta.reconcile_report(status, observed_at DESC);

COMMENT ON TABLE meta.reconcile_report IS
  'M10 对账证据：§3.2 三轨、§3.3 CROM 全量五项、§3.4 站内三角及 §3.5 QQ 单行摘要。禁止用裸行数差替代逐页状态判据。';
COMMENT ON COLUMN meta.reconcile_report.report IS
  '完整、有界的机器可读报告。差异详情只保存样本与计数，避免一次异常把数万页全文塞进 meta。';
COMMENT ON COLUMN meta.reconcile_report.qq_summary IS
  'qqbot 可直接转发的紧凑 JSON 对象；CLI --qq-summary 将它序列化为恰好一行 stdout。';
COMMENT ON COLUMN meta.reconcile_report.lag_window_seconds IS
  '状态对齐的管线滞后排除窗；规格要求排除任一侧 60 分钟内刚更新的页面，默认 3600 秒。';

DO $grant$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT, INSERT ON meta.reconcile_report TO ingestor_role;
    GRANT USAGE, SELECT ON SEQUENCE meta.reconcile_report_id_seq TO ingestor_role;
  END IF;
END
$grant$;
