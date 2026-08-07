-- =====================================================================================
-- 0048_adaptive_egress_policy_v4.sql
--
-- 0047 在并行交付期间把 policy 元数据恢复成旧 2%/5%、1%、3,200/h 合同；该合同正是
-- 本次已确诊单向棘轮的根因。以前向迁移重新建立经 2026-08-07 实测标定的最终合同，
-- 同时保留新 schema 的确定性失败分账与 L1 SLO 状态。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0048] 拒绝在受保护库 % 上激活出口护栏策略', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='meta' AND table_name='egress_control'
       AND column_name='current_window_deterministic_failures'
  ) THEN
    RAISE EXCEPTION '[0048] 缺少 0045 自适应出口兼容 schema'
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
       CASE
         WHEN level > 0
          AND rolling_hour_requests <= 3500
          AND coalesce(last_window_failure_rate, 0) < 0.10
          AND (
            reason LIKE 'rolling_60m_requests_%_gt_3200'
            OR reason LIKE 'failure_rate_%_gte_2.0pct%'
            OR reason LIKE 'failure_rate_%_gte_5.0pct_single_window'
          )
           THEN 0
         ELSE level
       END,
       'policy_v4_calibrated_5pct_10pct_3pct_3500',
       rolling_hour_requests, last_window_failure_rate,
       jsonb_build_object(
         'old_policy', policy,
         'old_reason', reason,
         'elevated_failure_rate', 0.05,
         'severe_failure_rate', 0.10,
         'healthy_failure_rate', 0.03,
         'rolling_budget_requests', 3500,
         'healthy_windows_accumulate_during_hold', true,
         'deterministic_failures_excluded', true,
         'no_qq_delivery', true
       )
  FROM meta.egress_control
 WHERE site_key='wikidot'
   AND (
     budget_limit <> 3500
     OR coalesce(policy->>'version', '') <> '4'
     OR coalesce((policy->>'elevated_failure_rate')::numeric, -1) <> 0.05
     OR coalesce((policy->>'severe_failure_rate')::numeric, -1) <> 0.10
     OR coalesce((policy->>'healthy_failure_rate')::numeric, -1) <> 0.03
   );

WITH current_state AS (
  SELECT c.*,
         c.level > 0
           AND c.rolling_hour_requests <= 3500
           AND coalesce(c.last_window_failure_rate, 0) < 0.10
           AND (
             c.reason LIKE 'rolling_60m_requests_%_gt_3200'
             OR c.reason LIKE 'failure_rate_%_gte_2.0pct%'
             OR c.reason LIKE 'failure_rate_%_gte_5.0pct_single_window'
           ) AS old_policy_only_downshift
    FROM meta.egress_control c
   WHERE c.site_key='wikidot'
)
UPDATE meta.egress_control c
   SET level = CASE WHEN s.old_policy_only_downshift THEN 0 ELSE c.level END,
       reason = CASE
         WHEN s.old_policy_only_downshift
           THEN 'policy_v4_rebase_old_triggers_below_new_thresholds'
         ELSE c.reason
       END,
       changed_at = CASE
         WHEN s.old_policy_only_downshift THEN clock_timestamp()
         ELSE c.changed_at
       END,
       recover_not_before = CASE
         WHEN s.old_policy_only_downshift THEN NULL
         ELSE c.recover_not_before
       END,
       next_permit_at = CASE
         WHEN s.old_policy_only_downshift THEN clock_timestamp()
         ELSE c.next_permit_at
       END,
       current_window_requests = 0,
       current_window_failures = 0,
       current_window_deterministic_failures = 0,
       elevated_windows = 0,
       healthy_windows = 0,
       last_window_deterministic_failure_rate = NULL,
       budget_limit = 3500,
       budget_breached = c.rolling_hour_requests > 3500,
       policy = jsonb_build_object(
         'version', 4,
         'window_requests', 100,
         'elevated_failure_rate', 0.05,
         'severe_failure_rate', 0.10,
         'healthy_failure_rate', 0.03,
         'elevated_windows_to_backoff', 2,
         'healthy_windows_to_recover', 6,
         'healthy_windows_accumulate_during_hold', true,
         'deterministic_failures_excluded', true,
         'rolling_budget_minutes', 60,
         'rolling_budget_requests', 3500,
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
  FROM current_state s
 WHERE c.site_key=s.site_key
   AND (
     c.budget_limit <> 3500
     OR coalesce(c.policy->>'version', '') <> '4'
     OR coalesce((c.policy->>'elevated_failure_rate')::numeric, -1) <> 0.05
     OR coalesce((c.policy->>'severe_failure_rate')::numeric, -1) <> 0.10
     OR coalesce((c.policy->>'healthy_failure_rate')::numeric, -1) <> 0.03
   );

COMMENT ON COLUMN meta.egress_control.recover_not_before IS
  '逐档最早恢复时刻；健康窗可在保持期内累计，但变档必须同时满足保持期与连续六窗 <=3%。';

COMMIT;
