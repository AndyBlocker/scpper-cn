-- =====================================================================================
-- 0016_targeted_queue_parse_health.sql
-- 定向差异队列的聚合完整性指标只告警，不冻结全站。
--
-- work queue 会主动富集 Tier1 差异、历史 partial 与待撤票页，因此
-- fetched_claimed_ratio / checksum_ok_rate 在 targeted_queue 中有选择偏差。
-- 逐页四重门控与 partial 退避不变；传输、HTTP 与解析结构指标仍可冻结全站。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0016] 拒绝在受保护库 % 上修改 R10；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

UPDATE meta.parse_health_baseline
   SET action = 'warn',
       computed_at = now()
 WHERE population_type = 'targeted_queue'
   AND metric IN ('fetched_claimed_ratio', 'checksum_ok_rate')
   AND action IS DISTINCT FROM 'warn';

COMMENT ON COLUMN meta.parse_health_baseline.population_type IS
  '抓取总体类型。targeted_queue 会富集差异/partial；其 fetched/claimed 与 checksum'
  ' 聚合比率只告警，安全性由逐页四重门控和 run 非零退出保证。';

COMMIT;
