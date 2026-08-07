-- =====================================================================================
-- 0046_adaptive_egress_policy_v2.sql
--
-- 激活自适应出口护栏 v2 schema，但保持生产已标定的 2%/5%、1% 恢复线和
-- 3,200/h 总量护栏。0045 必须已经先应用；本迁移绝不擅自解除已有降档。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0046] 拒绝在受保护库 % 上激活出口护栏策略', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='meta' AND table_name='egress_control'
       AND column_name='current_window_deterministic_failures'
  ) THEN
    RAISE EXCEPTION '[0046] 缺少 0045 自适应出口兼容 schema'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

SELECT pg_advisory_xact_lock(20260805);

-- 记录 schema 兼容升级，但 from/to 档位相同：迁移不替恢复状态机做升档决定。
INSERT INTO meta.egress_alert(
  site_key, kind, from_level, to_level, reason,
  rolling_hour_requests, failure_rate, details
)
SELECT site_key, 'policy_rebase', level, level,
       'policy_v2_schema_compat_existing_thresholds',
       rolling_hour_requests, last_window_failure_rate,
       jsonb_build_object(
         'old_policy', policy,
         'old_reason', reason,
         'elevated_failure_rate', 0.02,
         'severe_failure_rate', 0.05,
         'healthy_failure_rate', 0.01,
         'rolling_budget_requests', 3200,
         'deterministic_failures_excluded', true,
         'no_qq_delivery', true
       )
  FROM meta.egress_control
 WHERE site_key='wikidot'
   AND coalesce(policy->>'version', '') <> '2'
;

WITH prior AS (
  SELECT max(started_at) AS l1_started_at
    FROM meta.ingest_run
   WHERE source='wikidot_listpages'
     AND stats->>'layer'='L1'
)
UPDATE meta.egress_control c
   SET budget_limit = 3200,
       budget_breached = c.rolling_hour_requests > 3200,
       l1_last_started_at = coalesce(c.l1_last_started_at, prior.l1_started_at),
       policy = jsonb_build_object(
         'version', 2,
         'window_requests', 100,
         'elevated_failure_rate', 0.02,
         'severe_failure_rate', 0.05,
         'healthy_failure_rate', 0.01,
         'elevated_windows_to_backoff', 2,
         'healthy_windows_to_recover', 6,
         'healthy_windows_accumulate_during_hold', false,
         'deterministic_failures_excluded', true,
         'rolling_budget_minutes', 60,
         'rolling_budget_requests', 3200,
         'l1_slo_target_minutes', 5,
         'l1_slo_grace_minutes', 1,
         'tiers', jsonb_build_array(
           jsonb_build_object('level',0,'name','normal','min_interval_ms',333,'minimum_hold_minutes',0),
           jsonb_build_object('level',1,'name','cautious','min_interval_ms',667,'minimum_hold_minutes',30),
           jsonb_build_object('level',2,'name','protective','min_interval_ms',2000,'minimum_hold_minutes',45),
           jsonb_build_object('level',3,'name','cooldown','min_interval_ms',8000,'minimum_hold_minutes',60)
         )
       ),
       updated_at = clock_timestamp()
  FROM prior
 WHERE c.site_key='wikidot'
   AND coalesce(c.policy->>'version', '') <> '2';

COMMENT ON TABLE meta.egress_control IS
  'Wikidot 全站共享出口反馈控制器；压力/确定性失败分账，通道共享档位，并记录 L1 五分钟 SLO 退化。';
COMMENT ON COLUMN meta.egress_control.level IS
  '0 normal, 1 cautious, 2 protective, 3 cooldown；所有 Wikidot 通道共享，禁止独立通道绕过全局保护。';
COMMENT ON COLUMN meta.egress_control.recover_not_before IS
  '逐档最早开始累计恢复证据的时刻；之后仍须连续六窗 <=1% 才能逐档恢复。';

COMMIT;
