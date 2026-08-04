-- =====================================================================================
-- checks/backfill_rebuild_l1.sql —— 批量历史回填后的 Tier-1 投影显式重建
-- =====================================================================================
-- 历史回填可能以 migration_role 直接批量装载 ingest/serve 事实，因而绕过
-- apply_vote_* / apply_revision_batch / apply_attributions 对 page_current 的同事务维护。
-- 本脚本只从目标库内的权威事实重建可无歧义折叠的列，并在提交前复验不变式：
--   vote_current        → rating / vote_up / vote_down / vote_revoked
--   ingest.revision     → revision_count（直接 COUNT，不加 REVISION_COUNT_OFFSET）
--   attribution_current → attribution_count
--
-- source_sha/search_text 与 comment_count 不在这里盲目覆盖：
--   * source_sha 必须与最新 page_source 一致；不一致会硬失败。
--   * search_text 是一次页面观测的提取文本。同一源码 SHA 可复用 canonical content_blob，
--     blob.text_content 不一定等于该页当前观测文本；这里只断言它已填充。
--   * comment_count 是远端页面元数据声明值，不是本地 forum_post 的 COUNT；本地论坛完整度
--     应单独对账，不能反写声明值。
--
-- 用法（只允许目标 scpper-v2）：
--   psql "$SYNCER2_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f checks/backfill_rebuild_l1.sql
-- =====================================================================================

\set ON_ERROR_STOP on
\timing on
\pset pager off

BEGIN;

DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION 'refusing L1 rebuild on protected database %', current_database();
  END IF;
END $$;

SELECT pg_advisory_xact_lock(hashtext('backfill:rebuild-l1'));

-- 固定本轮折叠输入；回填收尾窗口不应同时运行采集器。
LOCK TABLE serve.page_current IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE serve.vote_current, serve.attribution_current, ingest.revision,
           ingest.page_source, ingest.content_blob IN SHARE MODE;

\echo ''
\echo '--- 重建前漂移 ---'
WITH per_voter AS (
  SELECT page_id, voter_id, sign(sum(direction))::int AS direction
    FROM serve.vote_current
   WHERE direction <> 0
   GROUP BY page_id, voter_id
), unique_agg AS (
  SELECT page_id, count(*)::int AS unique_voter_count,
         COALESCE(sum(direction), 0)::int AS unique_voter_rating
    FROM per_voter
   GROUP BY page_id
), vote_agg AS (
  SELECT v.page_id,
         COALESCE(sum(v.direction), 0)::int AS rating,
         count(*) FILTER (WHERE v.direction = 1)::int AS vote_up,
         count(*) FILTER (WHERE v.direction = -1)::int AS vote_down,
         count(*) FILTER (WHERE v.direction = 0)::int AS vote_revoked,
         COALESCE(u.unique_voter_count, 0)::int AS unique_voter_count,
         COALESCE(u.unique_voter_rating, 0)::int AS unique_voter_rating
    FROM serve.vote_current v
    LEFT JOIN unique_agg u USING (page_id)
   GROUP BY v.page_id, u.unique_voter_count, u.unique_voter_rating
), revision_agg AS (
  SELECT page_id, count(*)::int AS revision_count
    FROM ingest.revision
   GROUP BY page_id
), attribution_agg AS (
  SELECT page_id, count(*)::int AS attribution_count
    FROM serve.attribution_current
   GROUP BY page_id
)
SELECT count(*) FILTER (
         WHERE (pc.rating, pc.vote_up, pc.vote_down, pc.vote_revoked,
                pc.unique_voter_count, pc.unique_voter_rating)
            IS DISTINCT FROM
               (COALESCE(v.rating, 0), COALESCE(v.vote_up, 0),
                COALESCE(v.vote_down, 0), COALESCE(v.vote_revoked, 0),
                COALESCE(v.unique_voter_count, 0),
                COALESCE(v.unique_voter_rating, 0))
       ) AS vote_pages,
       count(*) FILTER (
         WHERE pc.revision_count IS DISTINCT FROM COALESCE(r.revision_count, 0)
       ) AS revision_pages,
       count(*) FILTER (
         WHERE pc.attribution_count IS DISTINCT FROM COALESCE(a.attribution_count, 0)
       ) AS attribution_pages
  FROM serve.page_current pc
  LEFT JOIN vote_agg v USING (page_id)
  LEFT JOIN revision_agg r USING (page_id)
  LEFT JOIN attribution_agg a USING (page_id);

\echo ''
\echo '--- 执行重建 ---'
WITH per_voter AS (
  SELECT page_id, voter_id, sign(sum(direction))::int AS direction
    FROM serve.vote_current
   WHERE direction <> 0
   GROUP BY page_id, voter_id
), unique_agg AS (
  SELECT page_id, count(*)::int AS unique_voter_count,
         COALESCE(sum(direction), 0)::int AS unique_voter_rating
    FROM per_voter GROUP BY page_id
), vote_agg AS (
  SELECT pc.page_id,
         COALESCE(sum(vc.direction), 0)::int AS rating,
         count(vc.*) FILTER (WHERE vc.direction = 1)::int AS vote_up,
         count(vc.*) FILTER (WHERE vc.direction = -1)::int AS vote_down,
         count(vc.*) FILTER (WHERE vc.direction = 0)::int AS vote_revoked,
         COALESCE(u.unique_voter_count, 0)::int AS unique_voter_count,
         COALESCE(u.unique_voter_rating, 0)::int AS unique_voter_rating
    FROM serve.page_current pc
    LEFT JOIN serve.vote_current vc ON vc.page_id = pc.page_id
    LEFT JOIN unique_agg u ON u.page_id = pc.page_id
   GROUP BY pc.page_id, u.unique_voter_count, u.unique_voter_rating
), changed AS (
  UPDATE serve.page_current pc
     SET rating = a.rating,
         vote_up = a.vote_up,
         vote_down = a.vote_down,
         vote_revoked = a.vote_revoked,
         unique_voter_count = a.unique_voter_count,
         unique_voter_rating = a.unique_voter_rating,
         updated_at = now()
    FROM vote_agg a
   WHERE pc.page_id = a.page_id
     AND (pc.rating, pc.vote_up, pc.vote_down, pc.vote_revoked,
          pc.unique_voter_count, pc.unique_voter_rating)
      IS DISTINCT FROM (a.rating, a.vote_up, a.vote_down, a.vote_revoked,
                        a.unique_voter_count, a.unique_voter_rating)
  RETURNING 1
)
SELECT count(*) AS rebuilt_vote_pages FROM changed;

WITH revision_agg AS (
  SELECT pc.page_id, count(r.*)::int AS revision_count
    FROM serve.page_current pc
    LEFT JOIN ingest.revision r ON r.page_id = pc.page_id
   GROUP BY pc.page_id
), changed AS (
  UPDATE serve.page_current pc
     SET revision_count = a.revision_count,
         updated_at = now()
    FROM revision_agg a
   WHERE pc.page_id = a.page_id
     AND pc.revision_count IS DISTINCT FROM a.revision_count
  RETURNING 1
)
SELECT count(*) AS rebuilt_revision_pages FROM changed;

WITH attribution_agg AS (
  SELECT pc.page_id, count(ac.*)::int AS attribution_count
    FROM serve.page_current pc
    LEFT JOIN serve.attribution_current ac ON ac.page_id = pc.page_id
   GROUP BY pc.page_id
), changed AS (
  UPDATE serve.page_current pc
     SET attribution_count = a.attribution_count,
         updated_at = now()
    FROM attribution_agg a
   WHERE pc.page_id = a.page_id
     AND pc.attribution_count IS DISTINCT FROM a.attribution_count
  RETURNING 1
)
SELECT count(*) AS rebuilt_attribution_pages FROM changed;

\echo ''
\echo '--- 内容/论坛语义审计（只读，不反写） ---'
WITH latest_source AS (
  SELECT DISTINCT ON (ps.page_id)
         ps.page_id, ps.blob_sha
    FROM ingest.page_source ps
   ORDER BY ps.page_id, ps.observed_at DESC, ps.id DESC
), local_forum AS (
  SELECT ft.page_id,
         count(*) FILTER (WHERE NOT fp.is_deleted)::int AS visible_posts
    FROM ingest.forum_thread ft
    JOIN ingest.forum_post fp ON fp.thread_id = ft.id
   WHERE ft.page_id IS NOT NULL AND NOT ft.is_deleted
   GROUP BY ft.page_id
)
SELECT count(*) FILTER (
         WHERE ls.page_id IS NOT NULL AND pc.source_sha IS DISTINCT FROM ls.blob_sha
       ) AS source_sha_bad,
       count(*) FILTER (WHERE pc.source_sha IS NULL) AS source_sha_missing,
       count(*) FILTER (WHERE pc.search_text IS NULL) AS search_text_missing,
       count(*) FILTER (WHERE pc.comment_count <> 0) AS nonzero_comment_claim_pages,
       count(*) FILTER (WHERE lf.page_id IS NOT NULL) AS local_forum_pages,
       count(*) FILTER (
         WHERE lf.page_id IS NOT NULL
           AND pc.comment_count IS DISTINCT FROM lf.visible_posts
       ) AS comment_claim_vs_local_diff
  FROM serve.page_current pc
  LEFT JOIN latest_source ls USING (page_id)
  LEFT JOIN local_forum lf USING (page_id);

\echo ''
\echo '--- 提交前硬断言 ---'
DO $$
DECLARE
  v_vote_bad       bigint;
  v_revision_bad   bigint;
  v_attr_bad       bigint;
  v_vote_pk_bad    bigint;
  v_vote_orphan    bigint;
  v_attr_orphan    bigint;
  v_source_bad     bigint;
  v_search_missing bigint;
BEGIN
  WITH per_voter AS (
    SELECT page_id, voter_id, sign(sum(direction))::int AS direction
      FROM serve.vote_current
     WHERE direction <> 0
     GROUP BY page_id, voter_id
  ), unique_agg AS (
    SELECT page_id, count(*)::int AS unique_voter_count,
           COALESCE(sum(direction), 0)::int AS unique_voter_rating
      FROM per_voter
     GROUP BY page_id
  ), vote_agg AS (
    SELECT v.page_id,
           COALESCE(sum(direction), 0)::int AS rating,
           count(*) FILTER (WHERE direction = 1)::int AS vote_up,
           count(*) FILTER (WHERE direction = -1)::int AS vote_down,
           count(*) FILTER (WHERE direction = 0)::int AS vote_revoked,
           COALESCE(u.unique_voter_count, 0)::int AS unique_voter_count,
           COALESCE(u.unique_voter_rating, 0)::int AS unique_voter_rating
      FROM serve.vote_current v
      LEFT JOIN unique_agg u USING (page_id)
     GROUP BY v.page_id, u.unique_voter_count, u.unique_voter_rating
  )
  SELECT count(*) INTO v_vote_bad
    FROM serve.page_current pc
    LEFT JOIN vote_agg v USING (page_id)
   WHERE (pc.rating, pc.vote_up, pc.vote_down, pc.vote_revoked,
          pc.unique_voter_count, pc.unique_voter_rating)
      IS DISTINCT FROM
         (COALESCE(v.rating, 0), COALESCE(v.vote_up, 0),
          COALESCE(v.vote_down, 0), COALESCE(v.vote_revoked, 0),
          COALESCE(v.unique_voter_count, 0),
          COALESCE(v.unique_voter_rating, 0));

  SELECT count(*) INTO v_revision_bad
    FROM serve.page_current pc
   WHERE pc.revision_count <>
         (SELECT count(*)::int FROM ingest.revision r WHERE r.page_id = pc.page_id);

  SELECT count(*) INTO v_attr_bad
    FROM serve.page_current pc
   WHERE pc.attribution_count <>
         (SELECT count(*)::int
            FROM serve.attribution_current ac
           WHERE ac.page_id = pc.page_id);

  SELECT count(*) INTO v_vote_pk_bad
    FROM (
      SELECT page_id, voter_id, source_row_ordinal
        FROM serve.vote_current
       GROUP BY page_id, voter_id, source_row_ordinal
      HAVING count(*) > 1
    ) d;

  SELECT count(*) INTO v_vote_orphan
    FROM serve.vote_current vc
    LEFT JOIN serve.page_current pc ON pc.page_id = vc.page_id
   WHERE pc.page_id IS NULL;

  SELECT count(*) INTO v_attr_orphan
    FROM serve.attribution_current ac
    LEFT JOIN serve.page_current pc ON pc.page_id = ac.page_id
   WHERE pc.page_id IS NULL;

  WITH latest_source AS (
    SELECT DISTINCT ON (ps.page_id) ps.page_id, ps.blob_sha
      FROM ingest.page_source ps
     ORDER BY ps.page_id, ps.observed_at DESC, ps.id DESC
  )
  SELECT count(*) INTO v_source_bad
    FROM latest_source ls
    JOIN serve.page_current pc USING (page_id)
   WHERE pc.source_sha IS DISTINCT FROM ls.blob_sha;

  SELECT count(*) INTO v_search_missing
    FROM serve.page_current
   WHERE search_text IS NULL;

  IF v_vote_bad <> 0 OR v_revision_bad <> 0 OR v_attr_bad <> 0
     OR v_vote_pk_bad <> 0 OR v_vote_orphan <> 0 OR v_attr_orphan <> 0
     OR v_source_bad <> 0 OR v_search_missing <> 0 THEN
    RAISE EXCEPTION
      'L1 rebuild assertion failed: vote=% revision=% attribution=% vote_pk=% vote_orphan=% attr_orphan=% source_sha=% search_text_missing=%',
      v_vote_bad, v_revision_bad, v_attr_bad, v_vote_pk_bad, v_vote_orphan,
      v_attr_orphan, v_source_bad, v_search_missing;
  END IF;

  RAISE NOTICE
    'L1 rebuild PASS: vote=% revision=% attribution=% vote_pk=% vote_orphan=% attr_orphan=% source_sha=% search_text_missing=%',
    v_vote_bad, v_revision_bad, v_attr_bad, v_vote_pk_bad, v_vote_orphan,
    v_attr_orphan, v_source_bad, v_search_missing;
END $$;

COMMIT;
