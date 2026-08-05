-- =====================================================================================
-- 0035_vote_sweep_scheduler.sql —— 投票追平进度 + 墙钟播种预算
-- =====================================================================================
--
-- 背景：
--   * v1 回填把 3 万多页的 last_complete_vote_snapshot_at 写在同一时刻；按“时间戳 +
--     固定周期”判断会在周期边界形成惊群。
--   * seed_vote_sweep 曾在每一轮 work-queue 固定 LIMIT 50；队列跑得越快，播种也越快，
--     吞吐提升被新增需求抵消。
--
-- 本迁移只保存两类调度状态，不改写历史快照：
--   1. vote_sweep_page_state：哪一页已经被 v2 Tier2 真正完整抓过；
--   2. vote_seed_budget：每条播种车道在当前墙钟小时已经用掉多少额度。
-- 到期相位仍由代码按 page_id 的稳定 MD5 计算，last_complete_vote_snapshot_at 的语义不变。
-- =====================================================================================

BEGIN;

DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn') THEN
    RAISE EXCEPTION '拒绝执行：当前库是 %，0035 只能作用于 v2 库。', current_database();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS meta.vote_sweep_page_state (
  page_id              int PRIMARY KEY,
  first_v2_complete_at timestamptz NOT NULL,
  last_v2_complete_at  timestamptz NOT NULL,
  CONSTRAINT vsps_time_order_ck CHECK (last_v2_complete_at >= first_v2_complete_at)
);

COMMENT ON TABLE meta.vote_sweep_page_state IS
  '投票首轮追平的持久进度：存在一行表示该页至少被 wikidot_tier2 完整抓取过一次。'
  '不替代 serve.page_current.last_complete_vote_snapshot_at；后者仍是最近完整快照时间。';
COMMENT ON COLUMN meta.vote_sweep_page_state.first_v2_complete_at IS
  '首次 v2 Tier2 完整 WhoRated 快照时间；用于区分 v1 回填与 v2 真实抓取。';
COMMENT ON COLUMN meta.vote_sweep_page_state.last_v2_complete_at IS
  '最近一次 v2 Tier2 完整 WhoRated 快照时间；成功任务单调推进。';

-- 升级前已经真实抓过的页不能重新算进 34k 首轮追平。page_scan 的保留期有限，
-- 因此只在迁移时把当前仍可见的证据固化一次；迁移后由 work-queue 成功路径持续维护。
INSERT INTO meta.vote_sweep_page_state AS state
       (page_id, first_v2_complete_at, last_v2_complete_at)
SELECT ps.page_id, min(ps.scanned_at), max(ps.scanned_at)
  FROM meta.page_scan ps
  JOIN meta.ingest_run ir ON ir.id = ps.run_id
 WHERE ps.kind = 'votes'
   AND ps.status = 'ok'
   AND ir.source = 'wikidot_tier2'
   -- tier2_replay 是 2026-07-28 的 v1 观测重放（33,175 页），不是远端 WhoRated 真抓；
   -- 把它算成完成会让本次首轮追平形同虚设。
   AND ir.stats ->> 'mode' = 'tier2'
   AND ir.stats ->> 'domain' = 'work_queue'
 GROUP BY ps.page_id
ON CONFLICT (page_id) DO UPDATE
  SET first_v2_complete_at = LEAST(
        state.first_v2_complete_at,
        EXCLUDED.first_v2_complete_at
      ),
      last_v2_complete_at = GREATEST(
        state.last_v2_complete_at,
        EXCLUDED.last_v2_complete_at
      );

CREATE TABLE IF NOT EXISTS meta.vote_seed_budget (
  budget_key        text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  used              int NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vsb_key_nonempty_ck CHECK (btrim(budget_key) <> '')
);

COMMENT ON TABLE meta.vote_seed_budget IS
  'work-queue 投票播种的持久墙钟小时账本。轮次频率或进程重启不重置 used。';
COMMENT ON COLUMN meta.vote_seed_budget.budget_key IS
  '车道键；生产为 vote:catchup / vote:sweep，测试使用 test:* 隔离。';
COMMENT ON COLUMN meta.vote_seed_budget.window_started_at IS
  'UTC 整点小时窗起点；跨窗时在同一行原子清零 used。';
COMMENT ON COLUMN meta.vote_seed_budget.used IS
  '本小时已经新建的任务数；已有队列行的幂等冲突不消耗额度。';

-- 0035 在 9002 之前执行时会被显式授权覆盖；单独热应用 0035 时也要立即可用。
DO $$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      meta.vote_sweep_page_state, meta.vote_seed_budget
    TO ingestor_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT ON meta.vote_sweep_page_state, meta.vote_seed_budget TO projector_role;
  END IF;
  IF to_regrole('migration_role') IS NOT NULL THEN
    GRANT ALL ON meta.vote_sweep_page_state, meta.vote_seed_budget TO migration_role;
  END IF;
END $$;

COMMIT;
