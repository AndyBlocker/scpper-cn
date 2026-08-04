-- =====================================================================================
-- 0005_indexes_pgroonga.sql —— 全文检索索引(pgroonga,带降级)
-- =====================================================================================
-- 为什么单独成文件:
--   pgroonga 不是 trusted extension,CREATE EXTENSION pgroonga 需要 superuser。
--   当前连接用户 user_dxzbdi 有 CREATEDB 但**没有 CREATEROLE、不是 superuser**,
--   所以新库 scpper-v2 里 pgroonga 未必装得上。若把这些索引混进 0001/0002,
--   一次扩展缺失就会让整个 schema 迁移回滚 —— 试跑阶段完全不可接受。
--
-- 本文件的行为(全部在 DO 块里,任何一步失败都不会中断迁移):
--   1) 若 pgroonga 已安装(pg_extension 里有)→ 建全部 pgroonga 索引。
--   2) 否则尝试 CREATE EXTENSION pgroonga(装了二进制但没建扩展的情况;非 superuser 会失败,
--      失败即吞掉并进入 3)。
--   3) 降级方案:改建 pg_trgm GIN 索引(pg_trgm 自 PG13 起是 trusted extension,库 owner 可建)。
--      trgm 只能加速 ILIKE '%kw%',**不能**支撑 &@~ 查询 —— 读侧代码必须能在两种模式间切换,
--      否则 BFF 搜索会直接报错而不是变慢。
--   4) 两条路都不通 → RAISE WARNING 留 TODO,不建任何索引,迁移照常成功。
--      此时全文搜索是全表扫,上线前必须由 DBA 补装 pgroonga。
--
-- TODO(DBA):在 scpper-v2 上执行(需 superuser)
--     CREATE EXTENSION IF NOT EXISTS pgroonga;
--   然后重跑本文件(可重复执行)。
--
-- 索引清单(来自设计文档 §4.2 / §4.3 / §4.4,名字与文档一致):
--   ingest."user"        u_display_pgroonga(display_name)  u_username_pgroonga(username)
--   ingest.forum_post    fp_search(text_plain)             fp_title_search(title)
--   serve.page_current   pc_search(search_text)  pc_title_search(title)  pc_alt_search(alternate_title)
--   serve.page_current 三条用 to_regclass 守卫 —— 0002 未跑时自动跳过,不报错。
-- =====================================================================================

BEGIN;

DO $$
DECLARE
  has_pgroonga boolean;
  has_trgm     boolean := false;
  built        int := 0;

  -- (schema-qualified 表名, 索引名, 索引表达式)
  pgroonga_targets text[][] := ARRAY[
    ARRAY['ingest."user"',      'u_display_pgroonga',  'display_name'],
    ARRAY['ingest."user"',      'u_username_pgroonga', 'username'],
    ARRAY['ingest.forum_post',  'fp_search',           'text_plain'],
    ARRAY['ingest.forum_post',  'fp_title_search',     'title'],
    ARRAY['serve.page_current', 'pc_search',           'search_text'],
    ARRAY['serve.page_current', 'pc_title_search',     'title'],
    ARRAY['serve.page_current', 'pc_alt_search',       'alternate_title']
  ];
  t text[];
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgroonga') INTO has_pgroonga;

  IF NOT has_pgroonga THEN
    BEGIN
      EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgroonga';
      has_pgroonga := true;
      RAISE NOTICE '[0005] pgroonga 扩展创建成功';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[0005] pgroonga 扩展不可用(%),转入降级方案', SQLERRM;
    END;
  END IF;

  IF has_pgroonga THEN
    FOREACH t SLICE 1 IN ARRAY pgroonga_targets LOOP
      IF to_regclass(t[1]) IS NULL THEN
        RAISE NOTICE '[0005] 跳过 %:表尚未创建(对应 migration 未执行)', t[1];
        CONTINUE;
      END IF;
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s USING pgroonga (%I)', t[2], t[1], t[3]);
      built := built + 1;
    END LOOP;
    RAISE NOTICE '[0005] pgroonga 索引就绪:% 条', built;
    RETURN;
  END IF;

  -- ---------------- 降级:pg_trgm GIN ----------------
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_trgm';
    has_trgm := true;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[0005] pg_trgm 也不可用(%)', SQLERRM;
  END;

  IF NOT has_trgm THEN
    RAISE WARNING '[0005] TODO:pgroonga 与 pg_trgm 均不可用,本次未创建任何全文索引。'
                  '搜索将退化为全表扫;上线前须由 DBA 执行 CREATE EXTENSION pgroonga 并重跑本文件。';
    RETURN;
  END IF;

  FOREACH t SLICE 1 IN ARRAY pgroonga_targets LOOP
    IF to_regclass(t[1]) IS NULL THEN
      CONTINUE;
    END IF;
    -- 降级索引另起名(*_trgm),与 pgroonga 名字不冲突:将来补装 pgroonga 后可以先建后删,不停机。
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s USING gin (%I gin_trgm_ops)',
                   t[2] || '_trgm', t[1], t[3]);
    built := built + 1;
  END LOOP;

  RAISE WARNING '[0005] 已降级为 pg_trgm GIN 索引 % 条。'
                'trgm 只加速 ILIKE ''%%kw%%'',不支撑 &@~;读侧必须走 ILIKE 分支。'
                'TODO:补装 pgroonga 后重跑本文件,再 DROP 掉 *_trgm 索引。', built;
END $$;

COMMIT;
