-- =====================================================================================
-- 0205_forum_backfill.sql
-- v1 论坛回填保真列 + apply_forum_batch A4 兼容层
-- =====================================================================================
-- ForumThread.description 是真实用户内容；ForumPost.createdByType 决定 deleted 徽章。
-- 两者都不能在 v1→v2 时静默丢失。
--
-- v1 的 ForumThread.pageId 是 title-as-slug 历史猜测，只能以 inferred 结转：
--   * ForumCommentsListModule / resolve_thread_page() 的 verified 真值优先；
--   * inferred 可以补空或更新旧 inferred；
--   * inferred 永远不能覆盖 verified。
--
-- 既有 6 参数 apply_forum_batch 被原位改名为内部 core；同签名的新 wrapper 仍是论坛
-- 唯一入口。这样在线采集器和回填器都无需绕过函数直写，同时避免复制一整份易漂移的
-- upsert 主体。
-- =====================================================================================

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      'refusing to apply v2 forum backfill migration to protected database %',
      current_database();
  END IF;
  IF to_regclass('ingest.forum_thread') IS NULL
     OR to_regclass('ingest.forum_post') IS NULL
     OR to_regprocedure(
       'ingest.apply_forum_batch(jsonb,jsonb,jsonb,timestamp with time zone,text,bigint)'
     ) IS NULL THEN
    RAISE EXCEPTION '0205_forum_backfill.sql 需要先执行 0001_ingest.sql 与 0006_functions.sql';
  END IF;
END $$;

ALTER TABLE ingest.forum_thread
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE ingest.forum_post
  ADD COLUMN IF NOT EXISTS created_by_type text;

COMMENT ON COLUMN ingest.forum_thread.description IS
  '上游 ForumThread.description 原文。v1 有 31k+ 非空值；这是用户内容，不得在迁移时静默丢弃。';
COMMENT ON COLUMN ingest.forum_post.created_by_type IS
  '上游作者展示类型(user/deleted/guest/anonymous/system 等)。与 author_user_id 正交：'
  'deleted 帖仍可由稳定 wikidot id 归一到 user，同时保留 deleted 徽章和 author_name 快照。';
COMMENT ON COLUMN ingest.forum_post.author_name IS
  '作者姓名快照。普通正 wid 作者通常由 author_user_id 展示；created_by_type=deleted 时'
  '即使 author_user_id 可解析也必须保留快照，不得把所有注销作者塌成一个 actor。';

-- 首次应用：把 0006 的实现保留为内部 core。完整 apply.sh 重跑时，0006 会暂时重建
-- 公共同名函数；本迁移检测到 core 已存在后不再 rename，并在下方重新覆盖 wrapper。
DO $$
BEGIN
  IF to_regprocedure(
       'ingest.forum_batch_core_0205(jsonb,jsonb,jsonb,timestamp with time zone,text,bigint)'
     ) IS NULL THEN
    ALTER FUNCTION ingest.apply_forum_batch(
      jsonb, jsonb, jsonb, timestamptz, text, bigint
    ) RENAME TO forum_batch_core_0205;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION ingest.apply_forum_batch(
  p_categories jsonb,
  p_threads    jsonb,
  p_posts      jsonb,
  p_observed   timestamptz DEFAULT now(),
  p_source     text        DEFAULT 'wikidot',
  p_run        bigint      DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_result       jsonb;
  v_thread_extra int := 0;
  v_post_extra   int := 0;
BEGIN
  -- core 负责参数类型、写闸、外键隔离、身份 FK、当前态 upsert 与扫描证据。
  v_result := ingest.forum_batch_core_0205(
    p_categories, p_threads, p_posts, p_observed, p_source, p_run
  );

  -- 只有 payload 显式携带字段时才覆盖；在线旧调用方不会因缺 key 清空回填内容。
  -- created_at 是上游稳定排序键，回填必须把既有少量行也校正到 v1 的楼层顺序。
  WITH src AS (
    SELECT DISTINCT ON ((r ->> 'id')::bigint)
           (r ->> 'id')::bigint AS id,
           (r ? 'description') AS has_description,
           NULLIF(r ->> 'description', '') AS description,
           NULLIF(r ->> 'created_at', '')::timestamptz AS created_at,
           NULLIF(r ->> 'page_id', '')::int AS inferred_page_id,
           r ->> 'page_id_source' AS page_id_source
      FROM jsonb_array_elements(COALESCE(p_threads, '[]'::jsonb)) AS e(r)
     WHERE NULLIF(r ->> 'id', '') IS NOT NULL
     ORDER BY (r ->> 'id')::bigint
  ), updated AS (
    UPDATE ingest.forum_thread ft
       SET description = CASE WHEN s.has_description THEN s.description ELSE ft.description END,
           created_at = COALESCE(s.created_at, ft.created_at),
           page_id = CASE
             WHEN ft.page_id_source IS DISTINCT FROM 'verified'
              AND s.page_id_source = 'inferred'
              AND s.inferred_page_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM ingest.page p WHERE p.id = s.inferred_page_id)
             THEN s.inferred_page_id
             ELSE ft.page_id
           END,
           page_id_source = CASE
             WHEN ft.page_id_source IS DISTINCT FROM 'verified'
              AND s.page_id_source = 'inferred'
              AND s.inferred_page_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM ingest.page p WHERE p.id = s.inferred_page_id)
             THEN 'inferred'
             ELSE ft.page_id_source
           END
      FROM src s
     WHERE ft.id = s.id
       AND (
         (s.has_description AND ft.description IS DISTINCT FROM s.description)
         OR (s.created_at IS NOT NULL AND ft.created_at IS DISTINCT FROM s.created_at)
         OR (
           ft.page_id_source IS DISTINCT FROM 'verified'
           AND s.page_id_source = 'inferred'
           AND s.inferred_page_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM ingest.page p WHERE p.id = s.inferred_page_id)
           AND (
             ft.page_id IS DISTINCT FROM s.inferred_page_id
             OR ft.page_id_source IS DISTINCT FROM 'inferred'
           )
         )
       )
    RETURNING 1
  )
  SELECT count(*)::int INTO v_thread_extra FROM updated;

  WITH src AS (
    SELECT DISTINCT ON ((r ->> 'id')::bigint)
           (r ->> 'id')::bigint AS id,
           (r ? 'created_by_type') AS has_created_by_type,
           NULLIF(r ->> 'created_by_type', '') AS created_by_type,
           NULLIF(r ->> 'created_at', '')::timestamptz AS created_at
      FROM jsonb_array_elements(COALESCE(p_posts, '[]'::jsonb)) AS e(r)
     WHERE NULLIF(r ->> 'id', '') IS NOT NULL
     ORDER BY (r ->> 'id')::bigint
  ), updated AS (
    UPDATE ingest.forum_post fp
       SET created_by_type = CASE
             WHEN s.has_created_by_type THEN s.created_by_type
             ELSE fp.created_by_type
           END,
           created_at = COALESCE(s.created_at, fp.created_at)
      FROM src s
     WHERE fp.id = s.id
       AND (
         (s.has_created_by_type AND fp.created_by_type IS DISTINCT FROM s.created_by_type)
         OR (s.created_at IS NOT NULL AND fp.created_at IS DISTINCT FROM s.created_at)
       )
    RETURNING 1
  )
  SELECT count(*)::int INTO v_post_extra FROM updated;

  RETURN v_result || jsonb_build_object(
    'threads_enriched', v_thread_extra,
    'posts_enriched', v_post_extra
  );
END;
$$;

COMMENT ON FUNCTION ingest.apply_forum_batch(
  jsonb, jsonb, jsonb, timestamptz, text, bigint
) IS
  '论坛当前态唯一批量入口。0205 wrapper 在既有 upsert 后保真 thread.description / '
  'post.created_by_type / created_at，并接受 page_id_source=inferred 的 v1 A4 结转；'
  'resolve_thread_page() 反解的 verified 永远优先且绝不被 inferred 覆盖。';

REVOKE ALL ON FUNCTION ingest.forum_batch_core_0205(
  jsonb, jsonb, jsonb, timestamptz, text, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION ingest.apply_forum_batch(
  jsonb, jsonb, jsonb, timestamptz, text, bigint
) FROM PUBLIC;

DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['ingestor_role', 'migration_role']
  LOOP
    IF to_regrole(v_role) IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION ingest.apply_forum_batch'
        '(jsonb,jsonb,jsonb,timestamptz,text,bigint) TO %I',
        v_role
      );
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION ingest.forum_batch_core_0205'
        '(jsonb,jsonb,jsonb,timestamptz,text,bigint) FROM %I',
        v_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
