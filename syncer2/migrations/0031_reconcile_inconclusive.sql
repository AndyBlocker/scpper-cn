-- =====================================================================================
-- 0031_reconcile_inconclusive.sql
-- 把“输入未走完、没有形成测量”与“完整测量后不合格”从持久化层分离。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0031] 拒绝在受保护库 % 上修改对账状态；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

ALTER TABLE meta.reconcile_report
  DROP CONSTRAINT IF EXISTS reconcile_report_status_ck;

ALTER TABLE meta.reconcile_report
  ADD CONSTRAINT reconcile_report_status_ck
  CHECK (status IN ('ok', 'partial', 'inconclusive', 'failed', 'aborted'));

COMMENT ON COLUMN meta.reconcile_report.status IS
  'ok=测量通过；partial=有效结果仍在暖机；inconclusive=输入不完整、本轮未形成差异计数；failed=完整测量后不合格；aborted=主动中止。';
