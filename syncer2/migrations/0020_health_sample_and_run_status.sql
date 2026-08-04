-- =====================================================================================
-- 0020_health_sample_and_run_status.sql
--   * run 级 partial 与真正 failed 分离；
--   * parse-health 的每指标样本分母保存在 parse_fingerprint.sample_counts（JSON，无 DDL）。
-- =====================================================================================

BEGIN;

DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      'refusing to apply health/run-status migration to protected database %',
      current_database();
  END IF;
END $$;

ALTER TABLE meta.ingest_run DROP CONSTRAINT IF EXISTS ingest_run_status_ck;
ALTER TABLE meta.ingest_run
  ADD CONSTRAINT ingest_run_status_ck
  CHECK (status IN ('running','ok','partial','failed','aborted'));

COMMENT ON COLUMN meta.ingest_run.status IS
  'running=执行中；ok=整轮完整；partial=执行完成但含正常的不完整证据，'
  '不计作 run 失败；failed=请求耗尽/解析失效/身份冲突等真失败；aborted=主动熔断停止。';

COMMENT ON COLUMN meta.ingest_run.parse_fingerprint IS
  '每轮解析健康指纹。sample_counts 对每项指标保存本轮真实请求/页面/记录分母；'
  '分母不足时指标仍落库但不参与熔断，也不训练七日动态基线；'
  'HTTP 分布及 transport_failure_rate 只统计业务逻辑请求的最终结果，'
  '探针与重试后成功的瞬时错误不计入失败率。';

COMMIT;
