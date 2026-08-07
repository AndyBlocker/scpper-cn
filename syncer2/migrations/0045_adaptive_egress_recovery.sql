-- =====================================================================================
-- 0045_adaptive_egress_recovery.sql
--
-- 自适应出口护栏 v2 的兼容 schema：
--   * 压力失败与既有失败分类确认的确定性失败分账；
--   * 记录 L1 五分钟轮次 SLO 退化及预期恢复窗口；
--   * 放行新的持久审计 kind。
--
-- 本迁移只扩 schema，不在迁移瞬间改变档位或阈值。策略激活由 0046 完成，确保所有
-- 依赖新列的代码只能在本迁移成功之后生效。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0045] 拒绝在受保护库 % 上修改出口护栏', current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

ALTER TABLE meta.egress_request_bucket
  ADD COLUMN IF NOT EXISTS deterministic_failures int NOT NULL DEFAULT 0;

ALTER TABLE meta.egress_request_bucket
  DROP CONSTRAINT IF EXISTS egress_request_bucket_counts_ck;
ALTER TABLE meta.egress_request_bucket
  ADD CONSTRAINT egress_request_bucket_counts_ck CHECK (
    requests >= 0
    AND failures >= 0
    AND deterministic_failures >= 0
    AND failures + deterministic_failures <= requests
  );

ALTER TABLE meta.egress_control
  ADD COLUMN IF NOT EXISTS current_window_deterministic_failures int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_window_deterministic_failure_rate real,
  ADD COLUMN IF NOT EXISTS l1_last_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS l1_slo_degraded_since timestamptz,
  ADD COLUMN IF NOT EXISTS l1_slo_expected_recovery_at timestamptz,
  ADD COLUMN IF NOT EXISTS l1_slo_last_gap_seconds int,
  ADD COLUMN IF NOT EXISTS l1_slo_overdue boolean NOT NULL DEFAULT false;

ALTER TABLE meta.egress_control
  DROP CONSTRAINT IF EXISTS egress_control_deterministic_counts_ck;
ALTER TABLE meta.egress_control
  ADD CONSTRAINT egress_control_deterministic_counts_ck CHECK (
    current_window_deterministic_failures >= 0
    AND current_window_failures + current_window_deterministic_failures
          <= current_window_requests
    AND (
      last_window_deterministic_failure_rate IS NULL
      OR last_window_deterministic_failure_rate BETWEEN 0 AND 1
    )
  );

ALTER TABLE meta.egress_control
  DROP CONSTRAINT IF EXISTS egress_control_l1_slo_ck;
ALTER TABLE meta.egress_control
  ADD CONSTRAINT egress_control_l1_slo_ck CHECK (
    l1_slo_last_gap_seconds IS NULL OR l1_slo_last_gap_seconds >= 0
  );

ALTER TABLE meta.egress_alert
  DROP CONSTRAINT IF EXISTS egress_alert_kind_ck;
ALTER TABLE meta.egress_alert
  ADD CONSTRAINT egress_alert_kind_ck CHECK (
    kind IN (
      'failure_backoff', 'budget_breach', 'recovery',
      'slo_degradation', 'slo_degradation_overdue', 'policy_rebase'
    )
  );

COMMENT ON COLUMN meta.egress_request_bucket.deterministic_failures IS
  '既有业务失败分类确认的确定性失败 attempt；保留分母与审计，但不进入站点压力分子。';
COMMENT ON COLUMN meta.egress_control.current_window_deterministic_failures IS
  '当前反馈窗口内被既有分类排除的确定性失败数；与 current_window_failures 压力分账。';
COMMENT ON COLUMN meta.egress_control.l1_slo_degraded_since IS
  '首次观测到 L1 轮次间隔超过 5 分钟目标加 1 分钟抖动宽限的时刻；恢复频率后清空。';
COMMENT ON COLUMN meta.egress_control.l1_slo_expected_recovery_at IS
  '按当前档位最低保持期与六个健康窗吞吐计算的全程逐档预期恢复截止。';
COMMENT ON COLUMN meta.egress_control.l1_slo_overdue IS
  'L1 SLO 退化是否已超过预期恢复截止；只有此状态才把调度单元退出码升级为非零。';

COMMIT;
