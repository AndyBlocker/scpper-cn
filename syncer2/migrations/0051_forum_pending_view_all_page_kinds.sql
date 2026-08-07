-- =====================================================================================
-- 0051_forum_pending_view_all_page_kinds.sql
-- 0044 首版只把 kind=discussion 拆成 catchup/steady；既有 kind=forum 页级任务也由同一
-- consumer 处理，必须进入相同车道，不能残留一条会按旧年龄策略误报的重复集合。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0051] 拒绝在受保护库 % 上替换待处理视图', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.pending_collection_current_pre0044') IS NULL THEN
    RAISE EXCEPTION '[0051] 缺少 0044 底层待处理视图' USING ERRCODE = '55000';
  END IF;
END
$guard$;

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
  '待处理集合当前态；论坛 thread 与页级 forum/discussion 均显式区分 catchup 趋势和 steady 年龄。';

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
