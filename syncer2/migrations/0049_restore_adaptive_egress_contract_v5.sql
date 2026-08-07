-- =====================================================================================
-- 0049_restore_adaptive_egress_contract_v5.sql
--
-- 0048 在并行工作中再次把用户明确给定的既有 2%/5%、1% 恢复线与滚动 60 分钟
-- 3,200 attempts 合同放宽。本前向迁移不改写迁移历史，只恢复既有合同；保留当前
-- 保护档位，且预算已经越线时只能收紧到 cooldown，不能借迁移解除护栏。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0049] 拒绝在受保护库 % 上修改出口护栏', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='meta' AND table_name='egress_control'
       AND column_name='current_window_deterministic_failures'
  ) THEN
    RAISE EXCEPTION '[0049] 缺少 0045 自适应出口兼容 schema'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

SELECT pg_advisory_xact_lock(20260805);

INSERT INTO meta.egress_alert(
  site_key, kind, from_level, to_level, reason,
  rolling_hour_requests, failure_rate, details
)
SELECT site_key, 'policy_rebase', level,
       CASE WHEN rolling_hour_requests > 3200 THEN 3 ELSE level END,
       'restore_existing_2pct_5pct_3200_contract_v5',
       rolling_hour_requests, last_window_failure_rate,
       jsonb_build_object(
         'old_policy', policy,
         'elevated_failure_rate', 0.02,
         'severe_failure_rate', 0.05,
         'healthy_failure_rate', 0.01,
         'rolling_budget_requests', 3200,
         'preserve_existing_downshift', true,
         'deterministic_failures_excluded', true,
         'no_qq_delivery', true
       )
  FROM meta.egress_control
 WHERE site_key='wikidot'
   AND (
     budget_limit <> 3200
     OR coalesce(policy->>'version', '') <> '5'
     OR coalesce((policy->>'elevated_failure_rate')::numeric, -1) <> 0.02
     OR coalesce((policy->>'severe_failure_rate')::numeric, -1) <> 0.05
     OR coalesce((policy->>'healthy_failure_rate')::numeric, -1) <> 0.01
   );

UPDATE meta.egress_control
   SET level = CASE WHEN rolling_hour_requests > 3200 THEN 3 ELSE level END,
       reason = CASE
         WHEN rolling_hour_requests > 3200
           THEN 'rolling_60m_requests_' || rolling_hour_requests || '_gt_3200'
         ELSE reason
       END,
       changed_at = CASE
         WHEN rolling_hour_requests > 3200 AND level <> 3 THEN clock_timestamp()
         ELSE changed_at
       END,
       recover_not_before = CASE
         WHEN rolling_hour_requests > 3200
           THEN greatest(
             coalesce(recover_not_before, '-infinity'::timestamptz),
             clock_timestamp() + interval '60 minutes'
           )
         ELSE recover_not_before
       END,
       current_window_requests = 0,
       current_window_failures = 0,
       current_window_deterministic_failures = 0,
       elevated_windows = 0,
       healthy_windows = 0,
       last_window_deterministic_failure_rate = NULL,
       budget_limit = 3200,
       budget_breached = rolling_hour_requests > 3200,
       policy = jsonb_build_object(
         'version', 5,
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
 WHERE site_key='wikidot'
   AND (
     budget_limit <> 3200
     OR coalesce(policy->>'version', '') <> '5'
     OR coalesce((policy->>'elevated_failure_rate')::numeric, -1) <> 0.02
     OR coalesce((policy->>'severe_failure_rate')::numeric, -1) <> 0.05
     OR coalesce((policy->>'healthy_failure_rate')::numeric, -1) <> 0.01
   );

COMMENT ON COLUMN meta.egress_control.recover_not_before IS
  '逐档最早恢复时刻；最低保持期结束后再累计连续六窗 <=1%，超过预计窗口才视为恢复失效。';

COMMIT;
