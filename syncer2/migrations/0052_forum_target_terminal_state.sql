-- =====================================================================================
-- 0052_forum_target_terminal_state.sql
-- 单个论坛对象的确定性失败（对象不存在、no_permission、结构性拒绝）不是可重试故障。
-- 保留任务行作为可审计终态，并从认领/待处理口径排除；发现侧 ON CONFLICT 不会复活它。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0052] 拒绝在受保护库 % 上修改论坛任务终态', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.forum_scan_task') IS NULL
     OR to_regclass('meta.pending_collection_current_pre0044') IS NULL THEN
    RAISE EXCEPTION '[0052] 缺少 0012/0044 前置对象' USING ERRCODE = '55000';
  END IF;
END
$guard$;

ALTER TABLE meta.forum_scan_task
  ADD COLUMN IF NOT EXISTS terminal_at timestamptz,
  ADD COLUMN IF NOT EXISTS terminal_family text,
  ADD COLUMN IF NOT EXISTS terminal_reason text;

ALTER TABLE meta.forum_scan_task
  DROP CONSTRAINT IF EXISTS forum_scan_task_terminal_ck;
ALTER TABLE meta.forum_scan_task
  ADD CONSTRAINT forum_scan_task_terminal_ck CHECK (
    (terminal_at IS NULL AND terminal_family IS NULL AND terminal_reason IS NULL)
    OR (
      terminal_at IS NOT NULL
      AND terminal_family IN ('identity_absent', 'structural')
      AND btrim(terminal_reason) <> ''
    )
  );

DROP INDEX IF EXISTS meta.fst_claim;
CREATE INDEX fst_claim
  ON meta.forum_scan_task(kind, priority DESC, not_before NULLS FIRST, id)
  WHERE locked_by IS NULL AND terminal_at IS NULL;

DROP INDEX IF EXISTS meta.fst_lane_claim;
CREATE INDEX fst_lane_claim
  ON meta.forum_scan_task(lane, kind, priority DESC, not_before NULLS FIRST, id)
  WHERE locked_by IS NULL AND terminal_at IS NULL;

COMMENT ON COLUMN meta.forum_scan_task.terminal_at IS
  '确定性失败进入 irreconcilable 终态的时刻；非 NULL 行不得再由常规 consumer 认领。';
COMMENT ON COLUMN meta.forum_scan_task.terminal_family IS
  '复用 classifyWorkFailure 的确定性 family；当前只允许 identity_absent/structural。';
COMMENT ON COLUMN meta.forum_scan_task.terminal_reason IS
  '终态的人类可读证据；发现侧重复看到同一 target 不得清空或复活。';

CREATE OR REPLACE VIEW meta.pending_collection_current AS
SELECT p.collection, p.family, p.pending_count, p.oldest_item_at,
       p.oldest_item_key, p.catchup, p.evidence
  FROM meta.pending_collection_current_pre0044 p
 WHERE p.family <> 'forum_scan_task'
   AND p.collection NOT IN ('scan_task:discussion', 'scan_task:forum')
UNION ALL
SELECT 'forum_scan_task:' || fst.lane || ':' || fst.kind AS collection,
       CASE fst.lane
         WHEN 'catchup' THEN 'forum_scan_task_catchup'
         ELSE 'forum_scan_task_steady'
       END AS family,
       count(*)::bigint AS pending_count,
       min(fst.first_seen_at) AS oldest_item_at,
       (array_agg(fst.id::text ORDER BY fst.first_seen_at, fst.id))[1] AS oldest_item_key,
       (fst.lane = 'catchup') AS catchup,
       jsonb_build_object(
         'lane', fst.lane, 'kind', fst.kind,
         'due', count(*) FILTER (WHERE fst.not_before IS NULL OR fst.not_before <= now()),
         'max_attempts', max(fst.attempts), 'max_stable_count', max(fst.stable_count)
       ) AS evidence
  FROM meta.forum_scan_task fst
 WHERE fst.terminal_at IS NULL
 GROUP BY fst.lane, fst.kind
UNION ALL
SELECT 'scan_task:discussion:' || lane.lane AS collection,
       CASE lane.lane
         WHEN 'catchup' THEN 'forum_link_catchup'
         ELSE 'forum_discussion_steady'
       END AS family,
       count(*)::bigint AS pending_count,
       min(st.created_at) AS oldest_item_at,
       (array_agg(st.id::text ORDER BY st.created_at, st.id))[1] AS oldest_item_key,
       (lane.lane = 'catchup') AS catchup,
       jsonb_build_object(
         'lane', lane.lane,
         'kinds', array_agg(DISTINCT st.kind ORDER BY st.kind),
         'due', count(*) FILTER (WHERE st.not_before IS NULL OR st.not_before <= now()),
         'max_attempts', max(st.attempts),
         'oldest_reasons', (array_agg(to_jsonb(st.reasons) ORDER BY st.created_at, st.id))[1]
       ) AS evidence
  FROM meta.scan_task st
 CROSS JOIN LATERAL (
    SELECT CASE WHEN 'forum_link_initial_catchup' = ANY(st.reasons)
                THEN 'catchup' ELSE 'steady' END AS lane
  ) lane
 WHERE st.kind IN ('forum', 'discussion')
 GROUP BY lane.lane;

COMMENT ON VIEW meta.pending_collection_current IS
  '待处理集合当前态；forum target 的确定性 terminal 行是已归类终态，不计 pending。';

UPDATE meta.pending_collection_audit_registry
   SET rationale = 'terminal_at IS NULL 的论坛目标；确定性 terminal 行已归类为终态'
 WHERE schema_name = 'meta' AND relation_name = 'forum_scan_task';

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT ON meta.pending_collection_current TO ingestor_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT ON meta.pending_collection_current TO projector_role;
  END IF;
END
$grants$;

DO $verify$
DECLARE v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad
    FROM meta.forum_scan_task
   WHERE terminal_at IS NOT NULL
     AND (locked_by IS NOT NULL OR locked_at IS NOT NULL);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '[0052] terminal forum target 仍持有锁：% 行', v_bad;
  END IF;
END
$verify$;
