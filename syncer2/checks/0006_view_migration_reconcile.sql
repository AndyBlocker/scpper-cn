-- 浏览迁移的可重复对账：source_rows 是完成/进行中 pass 固定下来的 v1 快照分母。
-- 成功行直接数目标表 v1_id；失败行直接数未 resolved 的逐行审计。三者必须闭合。

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF to_regclass('meta.view_migration_cursor') IS NULL
     OR to_regclass('meta.view_migration_reject') IS NULL
     OR to_regclass('app.user_page_view') IS NULL THEN
    RAISE EXCEPTION '浏览迁移对象不完整；先应用 migrations/0041_view_event_migration.sql';
  END IF;
END
$guard$;

WITH migrated(source_table,n) AS (
  SELECT 'PageViewEvent',count(*)::bigint FROM app.page_view_event WHERE v1_id IS NOT NULL
  UNION ALL
  SELECT 'UserPixelEvent',count(*)::bigint FROM app.user_pixel_event WHERE v1_id IS NOT NULL
  UNION ALL
  SELECT 'UserPageView',count(*)::bigint FROM app.user_page_view WHERE v1_id IS NOT NULL
), rejected AS (
  SELECT source_table,count(*)::bigint AS n
    FROM meta.view_migration_reject
   WHERE resolved_at IS NULL
   GROUP BY source_table
), reconciliation AS (
  SELECT c.source_table,c.mode,c.completed_at IS NOT NULL AS completed,
         c.snapshot_source_count AS v1_snapshot_rows,
         m.n AS migrated_rows,COALESCE(r.n,0) AS rejected_rows,
         c.snapshot_source_count-m.n-COALESCE(r.n,0) AS unaccounted_rows,
         c.snapshot_id,c.snapshot_updated_at,c.updated_at
    FROM meta.view_migration_cursor c
    JOIN migrated m USING (source_table)
    LEFT JOIN rejected r USING (source_table)
)
SELECT * FROM reconciliation ORDER BY source_table;

SELECT source_table,reason,count(*) AS rows,
       min(v1_id) AS first_v1_id,max(v1_id) AS last_v1_id
  FROM meta.view_migration_reject
 WHERE resolved_at IS NULL
 GROUP BY source_table,reason
 ORDER BY source_table,reason;

DO $assert_closed$
DECLARE v_bad text;
BEGIN
  WITH migrated(source_table,n) AS (
    SELECT 'PageViewEvent',count(*)::bigint FROM app.page_view_event WHERE v1_id IS NOT NULL
    UNION ALL
    SELECT 'UserPixelEvent',count(*)::bigint FROM app.user_pixel_event WHERE v1_id IS NOT NULL
    UNION ALL
    SELECT 'UserPageView',count(*)::bigint FROM app.user_page_view WHERE v1_id IS NOT NULL
  ), rejected AS (
    SELECT source_table,count(*)::bigint AS n
      FROM meta.view_migration_reject WHERE resolved_at IS NULL GROUP BY source_table
  )
  SELECT string_agg(format('%s=%s',c.source_table,
                    c.snapshot_source_count-m.n-COALESCE(r.n,0)),', ' ORDER BY c.source_table)
    INTO v_bad
    FROM meta.view_migration_cursor c
    JOIN migrated m USING (source_table)
    LEFT JOIN rejected r USING (source_table)
   WHERE c.completed_at IS NOT NULL
     AND c.snapshot_source_count<>m.n+COALESCE(r.n,0);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '浏览迁移对账不闭合：%',v_bad;
  END IF;
END
$assert_closed$;
