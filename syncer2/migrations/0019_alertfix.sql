-- =====================================================================================
-- 0019_alertfix.sql
-- 确定性矛盾收敛终态 + 独立每周复查；L0/L1 覆盖率基线初始化语义。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0019] 拒绝在受保护库 % 上执行 ALERTFIX；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

ALTER TABLE meta.irreconcilable
  ADD COLUMN IF NOT EXISTS result_hash bytea,
  ADD COLUMN IF NOT EXISTS next_review_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

-- 旧实现虽写了终态，却把同一任务继续留在常规队列。先继承其稳定哈希，再真正出队。
UPDATE meta.irreconcilable i
   SET result_hash = st.last_result_hash,
       next_review_at = COALESCE(i.next_review_at, i.last_checked + interval '7 days')
  FROM meta.scan_task st
 WHERE st.page_id = i.page_id
   AND st.kind = i.kind
   AND st.stable_count >= 3
   AND st.last_result_hash IS NOT NULL
   AND i.resolved_at IS NULL
   AND i.result_hash IS NULL;

UPDATE meta.irreconcilable
   SET next_review_at = COALESCE(next_review_at, last_checked + interval '7 days')
 WHERE resolved_at IS NULL
   AND result_hash IS NOT NULL;

DELETE FROM meta.scan_task st
 USING meta.irreconcilable i
 WHERE i.page_id = st.page_id
   AND i.kind = st.kind
   AND i.resolved_at IS NULL
   AND i.result_hash IS NOT NULL
   AND st.stable_count >= 3
   AND st.last_result_hash = i.result_hash;

CREATE INDEX IF NOT EXISTS irr_review_due
  ON meta.irreconcilable(next_review_at, kind)
  WHERE resolved_at IS NULL AND result_hash IS NOT NULL;

COMMENT ON COLUMN meta.irreconcilable.result_hash IS
  '触发终态的稳定确定性结果哈希；每周复查以同哈希判未变化，以新哈希重新放回 scan_task。';
COMMENT ON COLUMN meta.irreconcilable.next_review_at IS
  '独立终态队列的下次复查时间。常态每 7 天一次；临时故障只在本表退避，不污染常规 scan_task。';

ALTER TABLE meta.revision_coverage_metric
  ADD COLUMN IF NOT EXISTS is_baseline_init boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS baseline_init_reason text;

-- 历史表的首行没有可比较基线；明显超出 30 分钟调度抖动阈值的窗口也只是重新建基线。
WITH first_metric AS (
  SELECT l1_run_id
    FROM meta.revision_coverage_metric
   ORDER BY measured_at, l1_run_id
   LIMIT 1
)
UPDATE meta.revision_coverage_metric m
   SET is_baseline_init = true,
       baseline_init_reason = CASE
         WHEN m.l1_run_id = (SELECT l1_run_id FROM first_metric)
           THEN 'migration_first_l1_baseline'
         ELSE 'migration_l1_gap_exceeded'
       END
 WHERE m.l1_run_id = (SELECT l1_run_id FROM first_metric)
    OR m.window_ended_at - m.window_started_at > interval '52 minutes 30 seconds';

-- 旧表先写过一行 0/0 bootstrap，紧接着的首个非空窗口仍在比较部署前后两套基线；
-- 它就是 21:37 的 143/4 坏窗口，必须作为首个可见基线留痕而非进入 rolling。
WITH first_effective_metric AS (
  SELECT l1_run_id
    FROM meta.revision_coverage_metric
   WHERE l1_revision_changes > 0
   ORDER BY measured_at, l1_run_id
   LIMIT 1
)
UPDATE meta.revision_coverage_metric m
   SET is_baseline_init = true,
       baseline_init_reason = COALESCE(
         m.baseline_init_reason,
         'migration_first_effective_l1_baseline'
       )
 WHERE m.l1_run_id = (SELECT l1_run_id FROM first_effective_metric);

-- 若 L1 的比较起点早于第一轮成功 L0，则该窗口同样只用于初始化。
WITH first_l0 AS (
  SELECT min(started_at) AS started_at
    FROM meta.ingest_run
   WHERE source = 'wikidot_listpages'
     AND status = 'ok'
     AND stats ->> 'layer' = 'L0'
)
UPDATE meta.revision_coverage_metric m
   SET is_baseline_init = true,
       baseline_init_reason = COALESCE(
         m.baseline_init_reason,
         'migration_l1_baseline_predates_l0'
       )
  FROM first_l0
 WHERE first_l0.started_at IS NOT NULL
   AND m.window_started_at < first_l0.started_at;

-- 缓存的 rolling 列也按新语义重算，避免等下一轮之前最新行仍展示旧坏窗口。
WITH rolling AS (
  SELECT current.l1_run_id,
         COALESCE(sum(
           CASE WHEN history.is_baseline_init THEN 0 ELSE history.l1_revision_changes END
         ), 0)::int AS changes,
         COALESCE(sum(
           CASE WHEN history.is_baseline_init THEN 0 ELSE history.l0_captured_changes END
         ), 0)::int AS captured
    FROM meta.revision_coverage_metric current
    JOIN meta.revision_coverage_metric history
      ON history.measured_at > current.measured_at - interval '7 days'
     AND history.measured_at <= current.measured_at
   GROUP BY current.l1_run_id
)
UPDATE meta.revision_coverage_metric m
   SET rolling_7d_changes = rolling.changes,
       rolling_7d_captured = rolling.captured,
       rolling_7d_coverage = CASE
         WHEN rolling.changes = 0 THEN NULL
         ELSE rolling.captured::numeric / rolling.changes
       END
  FROM rolling
 WHERE rolling.l1_run_id = m.l1_run_id;

COMMENT ON COLUMN meta.revision_coverage_metric.is_baseline_init IS
  '比较基线早于 L0 启动或 L1 间隔超阈值时为真；保留审计，但不进入 rolling 且不触发告警。';

COMMIT;
