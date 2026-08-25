-- =====================================================================================
-- 0208_discussion_and_stalled_terminal_convergence.sql
--
-- 1. page discussion 的结构性终态不能被普通 seed 反复重建；为当前 6 页补齐 2026-08-25
--    的 CommentsList + ViewThread 双模块证据，并清掉终态旁边的普通任务。
-- 2. l1_stale 只能按 (slug,page_id) 精确身份判断，且 listpages_hidden 本来就不属于 L1
--    可枚举集合；旧视图仅按 page_id 连接，既重复旧 slug 状态又误报隐藏模板页。
-- 3. 已确认 slug_reused 的 revision regression 必须把增量水位重绑到 successor。
-- 4. revisions drift 已有开放 irreconcilable 时就是显式终态，不应继续显示为 pending。
--
-- 本迁移先于依赖这些终态语义的 TypeScript 代码部署。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0208] 拒绝在受保护库 % 上执行收敛迁移', current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

-- 当前实测：页面 GET 精确命中原 wikidot_id；CommentsList 返回 ok + threadId，但折叠容器
-- 0 帖；同一 threadId 的 ViewThread 也 status=ok、自报 0 帖。ListPages claim 则仍 >0。
WITH evidence(page_id, thread_id, comments_bytes, thread_bytes) AS (
  VALUES
    (11688, 12468676::bigint, 923, 2962),
    (15377,  5974036::bigint, 923, 2965),
    (22026, 13622934::bigint, 924, 2992),
    (23030, 14045830::bigint, 924, 2992),
    (24904,  4748616::bigint, 923, 2965),
    (29528, 13366749::bigint, 924, 2992)
)
UPDATE meta.irreconcilable i
   SET local_value = jsonb_build_object(
         'discussion_thread_id', pc.discussion_thread_id,
         'comment_count', pc.comment_count,
         'stored_wikidot_id', pc.wikidot_id
       ),
       remote_value = jsonb_build_object(
         'classification', 'wikidot_discussion_count_inconsistent',
         'claimed_total', pc.comment_count,
         'identity_status', 'ok',
         'observed_wikidot_id', pc.wikidot_id,
         'comments_status', 'ok',
         'comments_body_bytes', e.comments_bytes,
         'comments_posts', 0,
         'thread_id', e.thread_id,
         'thread_status', 'ok',
         'thread_body_bytes', e.thread_bytes,
         'thread_reported_posts', 0,
         'thread_posts', 0,
         'evidence_observed_at', '2026-08-25T00:35:42.392Z'
       ),
       result_hash = decode(
         '5204a7ec6baf2745577e1bc7e43a053be93f58057fde4eb9fa8131567bc8d072',
         'hex'
       ),
       last_checked = GREATEST(i.last_checked, '2026-08-25T00:35:42.392Z'::timestamptz),
       next_review_at = GREATEST(
         COALESCE(i.next_review_at, '-infinity'::timestamptz),
         '2026-09-01T00:35:42.392Z'::timestamptz
       ),
       locked_by = NULL,
       locked_at = NULL
  FROM evidence e
  JOIN serve.page_current pc ON pc.page_id = e.page_id
 WHERE i.page_id = e.page_id
   AND i.kind IN ('discussion', 'forum')
   AND i.resolved_at IS NULL;

-- 已有终态不再同时存在于普通队列。运行时代码会阻止后续 seed 再建。
DELETE FROM meta.scan_task st
 USING meta.irreconcilable i
 WHERE i.page_id = st.page_id
   AND i.kind IN ('discussion', 'forum')
   AND st.kind IN ('discussion', 'forum')
   AND i.resolved_at IS NULL;

-- 已确认 slug 复用时，旧身份上的 slug 主键水位应切到当前 live successor，并采用身份
-- regression 状态里已经落库的当前 L0/L1 观测。该更新幂等，且只碰仍绑 predecessor 的行。
WITH terminal AS (
  SELECT DISTINCT ON (r.slug, r.page_id)
         r.slug,
         r.page_id AS predecessor_page_id,
         successor.page_id AS successor_page_id
    FROM meta.revision_regression_identity_state r
    JOIN LATERAL (
      SELECT pc.page_id
        FROM serve.page_current pc
        JOIN ingest.page p ON p.id = pc.page_id
       WHERE pc.slug = r.slug
         AND pc.status = 'live'
         AND p.wikidot_id <> r.expected_wikidot_id
       ORDER BY pc.page_id DESC
       LIMIT 1
    ) successor ON true
   WHERE r.status = 'slug_reused'
   ORDER BY r.slug, r.page_id, r.last_seen_at DESC
), observations AS (
  SELECT t.*,
         l0.observed_revision AS l0_revision,
         l0.observed_updated_at AS l0_updated_at,
         l0.last_seen_at AS l0_seen_at,
         l1.observed_revision AS l1_revision,
         l1.observed_rating AS l1_rating,
         l1.observed_rating_votes AS l1_rating_votes,
         l1.last_seen_at AS l1_seen_at,
         l1.run_id AS l1_run_id
    FROM terminal t
    LEFT JOIN LATERAL (
      SELECT r.observed_revision, r.observed_updated_at, r.last_seen_at
        FROM meta.revision_regression_identity_state r
       WHERE r.page_id = t.predecessor_page_id AND r.layer = 'L0'
       ORDER BY r.last_seen_at DESC
       LIMIT 1
    ) l0 ON true
    LEFT JOIN LATERAL (
      SELECT r.observed_revision, r.observed_rating, r.observed_rating_votes,
             r.last_seen_at, r.run_id
        FROM meta.revision_regression_identity_state r
       WHERE r.page_id = t.predecessor_page_id AND r.layer = 'L1'
       ORDER BY r.last_seen_at DESC
       LIMIT 1
    ) l1 ON true
)
UPDATE meta.incremental_page_state ips
   SET page_id = o.successor_page_id,
       last_l0_revision = COALESCE(o.l0_revision, ips.last_l0_revision),
       last_l0_updated_at = COALESCE(o.l0_updated_at, ips.last_l0_updated_at),
       last_l0_seen_at = COALESCE(o.l0_seen_at, ips.last_l0_seen_at),
       last_l1_revision = COALESCE(o.l1_revision, ips.last_l1_revision),
       last_l1_rating = COALESCE(o.l1_rating, ips.last_l1_rating),
       last_l1_rating_votes = COALESCE(o.l1_rating_votes, ips.last_l1_rating_votes),
       last_l1_seen_at = COALESCE(o.l1_seen_at, ips.last_l1_seen_at),
       last_l1_run_id = COALESCE(o.l1_run_id, ips.last_l1_run_id),
       updated_at = GREATEST(
         ips.updated_at,
         COALESCE(o.l0_seen_at, '-infinity'::timestamptz),
         COALESCE(o.l1_seen_at, '-infinity'::timestamptz)
       )
  FROM observations o
 WHERE ips.slug = o.slug
   AND ips.page_id = o.predecessor_page_id;

-- 开放 irreconcilable 是该相同证据的终态；state 保留差值用于审计，但退出 pending 集合。
UPDATE meta.incremental_drift_state ds
   SET consecutive_observations = 0,
       resolved_at = GREATEST(ds.last_detected_at, i.last_checked)
  FROM meta.irreconcilable i
 WHERE ds.page_id = i.page_id
   AND ds.kind = i.kind
   AND ds.resolved_at IS NULL
   AND i.resolved_at IS NULL;

-- 0207 没有幂等 rename guard；0208 自身必须可安全复跑。
DO $pending_view$
BEGIN
  IF to_regclass('meta.pending_collection_current_pre0208') IS NULL THEN
    ALTER VIEW meta.pending_collection_current RENAME TO pending_collection_current_pre0208;
  END IF;
END
$pending_view$;

CREATE OR REPLACE VIEW meta.pending_collection_current AS
SELECT p.collection, p.family, p.pending_count, p.oldest_item_at,
       p.oldest_item_key, p.catchup, p.evidence
  FROM meta.pending_collection_current_pre0208 p
 WHERE p.collection <> 'incremental_page_state:l1_stale'

UNION ALL

SELECT 'incremental_page_state:l1_stale'::text AS collection,
       'incremental_page_state_l1'::text AS family,
       count(*)::bigint AS pending_count,
       min(COALESCE(ips.last_l1_seen_at, p.created_at)) AS oldest_item_at,
       (array_agg(pc.page_id::text ORDER BY
         COALESCE(ips.last_l1_seen_at, p.created_at), pc.page_id))[1] AS oldest_item_key,
       (count(*) >= 100)::boolean AS catchup,
       jsonb_build_object(
         'never_seen_l1', count(*) FILTER (WHERE ips.last_l1_seen_at IS NULL),
         'freshness_contract_minutes', 30,
         'identity_join', 'slug_and_page_id',
         'enumeration_scope', 'standard'
       ) AS evidence
  FROM serve.page_current pc
  JOIN ingest.page p ON p.id = pc.page_id
  LEFT JOIN meta.incremental_page_state ips
    ON ips.slug = pc.slug AND ips.page_id = pc.page_id
 WHERE pc.status = 'live'
   AND pc.enumeration_scope = 'standard'
   AND (ips.last_l1_seen_at IS NULL OR ips.last_l1_seen_at < now() - interval '30 minutes')
HAVING count(*) > 0;

COMMENT ON VIEW meta.pending_collection_current IS
  '0208：L1 stale 按当前 (slug,page_id) 精确身份且只统计 standard 可枚举页；'
  '已有 irreconcilable 的 drift 由终态证据而非 pending age 负责可观测性。';

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
BEGIN
  IF EXISTS (
    SELECT 1
      FROM meta.scan_task st
      JOIN meta.irreconcilable i
        ON i.page_id = st.page_id
       AND i.kind IN ('discussion', 'forum')
       AND i.resolved_at IS NULL
     WHERE st.kind IN ('discussion', 'forum')
  ) THEN
    RAISE EXCEPTION '[0208] discussion 终态仍与普通任务并存';
  END IF;
  IF EXISTS (
    SELECT 1 FROM meta.pending_collection_current
     WHERE collection = 'incremental_page_state:l1_stale'
       AND COALESCE(evidence->>'identity_join', '') <> 'slug_and_page_id'
  ) THEN
    RAISE EXCEPTION '[0208] l1_stale 仍使用旧身份连接口径';
  END IF;
END
$verify$;

COMMIT;
