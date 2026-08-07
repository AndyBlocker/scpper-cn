-- =====================================================================================
-- 0047_restore_adaptive_egress_contract.sql
--
-- 0046 曾在已运行的 v2 库短暂写入未经授权的 5%/10%、3,500/h 策略。本迁移既是
-- 已应用数据库的纠偏，也是以后部署的最终断言：恢复既有 2%/5%、1% 恢复线与
-- 滚动 60 分钟 3,200 attempts；保留任何当前保护档位，不把迁移当作解除护栏的捷径。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0047] 拒绝在受保护库 % 上修改出口护栏', current_database()
      USING ERRCODE = '42501';
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
       'restore_existing_2pct_5pct_3200_contract',
       rolling_hour_requests, last_window_failure_rate,
       jsonb_build_object(
         'elevated_failure_rate', 0.02,
         'severe_failure_rate', 0.05,
         'healthy_failure_rate', 0.01,
         'rolling_budget_requests', 3200,
         'preserve_existing_downshift', true,
         'no_qq_delivery', true
       )
  FROM meta.egress_control
 WHERE site_key='wikidot'
   AND (
     budget_limit <> 3200
     OR coalesce(policy->>'version', '') <> '3'
     OR coalesce((policy->>'elevated_failure_rate')::real, -1) <> 0.02
     OR coalesce((policy->>'severe_failure_rate')::real, -1) <> 0.05
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
       budget_limit = 3200,
       budget_breached = rolling_hour_requests > 3200,
       policy = jsonb_build_object(
         'version', 3,
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
 WHERE site_key='wikidot';

COMMIT;
