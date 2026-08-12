-- =====================================================================================
-- 0058_egress_budget_pressure_split.sql
--
-- 总量预算是我方容量规划，pressure 才是站点拒绝信号；两者不能再共用一个 level、
-- 冷却和恢复计数。本迁移先提供独立持久状态，代码只能在本迁移之后启用：
--   * pressure_* 保留既有 5% 两窗 / 10% 单窗 / <=3% 六窗合同；
--   * budget_* 只保存比例节流状态，不继承 pressure 的 30/45/60 分钟冷却；
--   * recovery_window_* 保存 5 分钟非空证据窗，避免低吞吐时凑不满 100-request 窗；
--   * 预算按当前已启用链路稳态 4,657/h + 15% 余量、向上取整到 5,400/h。
--
-- 迁移不会发送任何外部消息；policy_rebase 仅写 meta.egress_alert 审计表。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0058] 拒绝在受保护库 % 上修改出口护栏', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.egress_control') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema='meta' AND table_name='egress_control'
          AND column_name='connection_failure_streak'
     ) THEN
    RAISE EXCEPTION '[0058] 缺少 0037/0056 自适应出口前置 schema'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

SELECT pg_advisory_xact_lock(20260805);

ALTER TABLE meta.egress_control
  ADD COLUMN IF NOT EXISTS pressure_level smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pressure_reason text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS pressure_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS pressure_recover_not_before timestamptz,
  ADD COLUMN IF NOT EXISTS budget_level smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_reason text NOT NULL DEFAULT 'within_budget',
  ADD COLUMN IF NOT EXISTS budget_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS budget_min_interval_ms int NOT NULL DEFAULT 333,
  ADD COLUMN IF NOT EXISTS budget_throttle_ratio real NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS recovery_window_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS recovery_window_requests int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_window_failures int NOT NULL DEFAULT 0;

ALTER TABLE meta.egress_control
  DROP CONSTRAINT IF EXISTS egress_control_split_levels_ck,
  DROP CONSTRAINT IF EXISTS egress_control_budget_pacing_ck,
  DROP CONSTRAINT IF EXISTS egress_control_recovery_window_ck;

ALTER TABLE meta.egress_control
  ADD CONSTRAINT egress_control_split_levels_ck CHECK (
    pressure_level BETWEEN 0 AND 3
    AND budget_level BETWEEN 0 AND 1
  ),
  ADD CONSTRAINT egress_control_budget_pacing_ck CHECK (
    budget_min_interval_ms > 0
    AND budget_throttle_ratio > 0
    AND budget_throttle_ratio <= 1
  ),
  ADD CONSTRAINT egress_control_recovery_window_ck CHECK (
    recovery_window_requests >= 0
    AND recovery_window_failures >= 0
    AND recovery_window_failures <= recovery_window_requests
    AND (
      (recovery_window_started_at IS NULL
       AND recovery_window_requests = 0
       AND recovery_window_failures = 0)
      OR recovery_window_started_at IS NOT NULL
    )
  );

INSERT INTO meta.egress_alert(
  site_key, kind, from_level, to_level, reason,
  rolling_hour_requests, failure_rate, details
)
SELECT site_key, 'policy_rebase', level,
       CASE
         WHEN reason LIKE 'rolling_60m_requests_%' THEN 0
         ELSE level
       END,
       'policy_v7_split_budget_pressure_5400',
       rolling_hour_requests, last_window_failure_rate,
       jsonb_build_object(
         'old_policy', policy,
         'old_budget_limit', budget_limit,
         'capacity_steady_requests_per_hour', 4657,
         'capacity_headroom_ratio', 0.15,
         'rolling_budget_requests', 5400,
         'budget_response', 'proportional_target_pace',
         'pressure_recovery_window_minutes', 5,
         'empty_recovery_windows_count', false,
         'no_qq_delivery', true
       )
  FROM meta.egress_control
 WHERE site_key='wikidot'
   AND (
     budget_limit <> 5400
     OR coalesce((policy->>'version')::int, 0) <> 7
   );

WITH previous AS (
  SELECT c.*,
         CASE
           WHEN c.reason LIKE 'rolling_60m_requests_%' THEN 0
           ELSE c.level
         END::smallint AS next_pressure_level
    FROM meta.egress_control c
   WHERE c.site_key='wikidot'
     AND (
       c.budget_limit <> 5400
       OR coalesce((c.policy->>'version')::int, 0) <> 7
     )
)
UPDATE meta.egress_control c
   SET pressure_level = p.next_pressure_level,
       pressure_reason = CASE
         WHEN p.next_pressure_level = 0 AND p.reason LIKE 'rolling_60m_requests_%'
           THEN 'normal_after_budget_pressure_split'
         ELSE p.reason
       END,
       pressure_changed_at = p.changed_at,
       pressure_recover_not_before = CASE
         WHEN p.next_pressure_level > 0 THEN p.recover_not_before
         ELSE NULL
       END,
       budget_level = CASE WHEN p.rolling_hour_requests > 5400 THEN 1 ELSE 0 END,
       budget_reason = CASE
         WHEN p.rolling_hour_requests > 5400
           THEN 'rolling_60m_requests_' || p.rolling_hour_requests || '_gt_5400_proportional'
         ELSE 'within_budget_5400'
       END,
       budget_changed_at = clock_timestamp(),
       budget_min_interval_ms = CASE
         WHEN p.rolling_hour_requests > 5400 THEN ceil(3600000.0 / 5400)::int
         ELSE 333
       END,
       budget_throttle_ratio = CASE
         WHEN p.rolling_hour_requests > 5400 THEN 5400.0 / p.rolling_hour_requests
         ELSE 1
       END,
       recovery_window_started_at = NULL,
       recovery_window_requests = 0,
       recovery_window_failures = 0,
       level = GREATEST(
         p.next_pressure_level,
         CASE WHEN p.rolling_hour_requests > 5400 THEN 1 ELSE 0 END
       ),
       reason = CASE
         WHEN p.next_pressure_level > 0 THEN
           CASE
             WHEN p.reason LIKE 'rolling_60m_requests_%'
               THEN 'normal_after_budget_pressure_split'
             ELSE p.reason
           END
         WHEN p.rolling_hour_requests > 5400
           THEN 'rolling_60m_requests_' || p.rolling_hour_requests || '_gt_5400_proportional'
         ELSE p.reason
       END,
       recover_not_before = CASE
         WHEN p.next_pressure_level > 0 THEN p.recover_not_before
         ELSE NULL
       END,
       budget_limit = 5400,
       budget_breached = p.rolling_hour_requests > 5400,
       healthy_windows = 0,
       policy = p.policy || jsonb_build_object(
         'version', 7,
         'rolling_budget_minutes', 60,
         'rolling_budget_requests', 5400,
         'budget_response', 'proportional_target_pace',
         'budget_has_cooldown', false,
         'budget_recovery', 'rolling_count_lte_limit',
         'pressure_recovery_window_minutes', 5,
         'pressure_recovery_requires_nonempty_window', true,
         'capacity_steady_requests_per_hour', 4657,
         'capacity_headroom_ratio', 0.15
       ),
       updated_at = clock_timestamp()
  FROM previous p
 WHERE c.site_key=p.site_key;

COMMENT ON COLUMN meta.egress_control.pressure_level IS
  '站点拒绝/连接失败独立档位；仅由既有 5% 两窗、10% 单窗与稀疏连接失败判据改变。';
COMMENT ON COLUMN meta.egress_control.pressure_recover_not_before IS
  'pressure 独立最低保持截止；预算越界不得读写此字段。';
COMMENT ON COLUMN meta.egress_control.budget_level IS
  '我方容量预算独立状态：0=未越界，1=按预算目标 pace 比例压回；不使用 pressure 的 level 2/3。';
COMMENT ON COLUMN meta.egress_control.budget_min_interval_ms IS
  '预算控制器计算的全站最小间隔；越界时 ceil(rolling_window_ms / budget_limit)。';
COMMENT ON COLUMN meta.egress_control.budget_throttle_ratio IS
  '预算比例响应因子 min(1,budget_limit/rolling_hour_requests)。';
COMMENT ON COLUMN meta.egress_control.recovery_window_started_at IS
  'pressure 恢复使用的 5 分钟证据窗起点；空窗不计入连续六窗。';
COMMENT ON COLUMN meta.egress_control.level IS
  '兼容字段：max(pressure_level,budget_level)；判据、冷却与恢复必须读取各自独立字段。';
COMMENT ON COLUMN meta.egress_control.recover_not_before IS
  '兼容字段：仅镜像活动 pressure 的最早恢复时刻；预算控制无固定冷却。';

COMMIT;
