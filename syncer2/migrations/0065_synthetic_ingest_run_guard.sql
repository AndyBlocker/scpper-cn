-- =====================================================================================
-- 0065_synthetic_ingest_run_guard.sql
--
-- PENDCLEAN 的 0042 只守住 serve/ingest 身份表。测试对保留 wikidot_id 段调用
-- meta.record_page_scan(run_id => NULL) 时，函数会先创建 source='synthetic' 的 run；
-- 固件随后删除测试页与 page_scan，却无法再从已删除的 page_scan 找回这条 run，最终每次
-- npm test 都在活库留下新的 running 行。本迁移把同一组合特征守卫延伸到 ingest_run：
-- 只拒绝“record_page_scan 合成 run + 当前 page_id 属于测试保留身份”的交集，不按库名、
-- source 前缀或 test-* slug 泛化，真实页面缺 run_id 的既有留证退路不受影响。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0065] 拒绝在受保护库 % 上修改合成 run 写入门', current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

CREATE OR REPLACE FUNCTION meta.is_synthetic_test_page_id(p_page_id int)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM ingest.page p
      LEFT JOIN serve.page_current pc ON pc.page_id = p.id
     WHERE p.id = p_page_id
       AND (
         p.wikidot_id BETWEEN 2100000000 AND 2109999999
         OR COALESCE(pc.slug, '') LIKE 'ts2test:%'
         OR meta.is_synthetic_test_page(p.wikidot_id, pc.slug)
         OR EXISTS (
           SELECT 1
             FROM ingest.page_slug_history h
            WHERE h.page_id = p.id
              AND (
                h.slug LIKE 'ts2test:%'
                OR meta.is_synthetic_test_page(p.wikidot_id, h.slug)
              )
         )
       )
  )
$fn$;

CREATE OR REPLACE FUNCTION meta.reject_synthetic_test_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_wikidot_id int;
  v_page_id int;
BEGIN
  IF TG_TABLE_SCHEMA = 'meta' AND TG_TABLE_NAME = 'ingest_run' THEN
    v_page_id := CASE
      WHEN COALESCE(NEW.stats ->> 'first_page_id', '') ~ '^[0-9]{1,10}$'
        THEN (NEW.stats ->> 'first_page_id')::int
      ELSE NULL
    END;
    IF NEW.source = 'synthetic'
       AND NEW.stats @> '{"synthetic":true}'::jsonb
       AND v_page_id IS NOT NULL
       AND meta.is_synthetic_test_page_id(v_page_id) THEN
      RAISE EXCEPTION
        '拒绝测试合成扫描写入 meta.ingest_run：page_id=%, source=%',
        v_page_id, NEW.source
        USING ERRCODE = 'P2T01';
    END IF;
  ELSIF TG_TABLE_SCHEMA = 'ingest' AND TG_TABLE_NAME = 'page_slug_history' THEN
    SELECT wikidot_id INTO v_wikidot_id FROM ingest.page WHERE id = NEW.page_id;
    IF meta.is_synthetic_test_page(v_wikidot_id, NEW.slug) THEN
      RAISE EXCEPTION '拒绝测试合成页写入 ingest：wikidot_id=%, slug=%', v_wikidot_id, NEW.slug
        USING ERRCODE = 'P2T01';
    END IF;
  ELSIF TG_TABLE_SCHEMA = 'serve' AND TG_TABLE_NAME = 'page_current' THEN
    IF meta.is_synthetic_test_page(NEW.wikidot_id, NEW.slug) THEN
      RAISE EXCEPTION '拒绝测试合成页写入 serve：wikidot_id=%, slug=%', NEW.wikidot_id, NEW.slug
        USING ERRCODE = 'P2T01';
    END IF;
  ELSIF TG_TABLE_SCHEMA = 'ingest' AND TG_TABLE_NAME = 'user' THEN
    IF meta.is_synthetic_test_user(NEW.kind, NEW.anon_key, NEW.username, NEW.display_name) THEN
      RAISE EXCEPTION '拒绝测试合成用户写入 ingest：anon_key=%, username=%', NEW.anon_key, NEW.username
        USING ERRCODE = 'P2T01';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION meta.is_synthetic_test_page_id(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION meta.reject_synthetic_test_identity() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_reject_synthetic_test_run ON meta.ingest_run;
CREATE TRIGGER trg_reject_synthetic_test_run
BEFORE INSERT OR UPDATE OF source, stats ON meta.ingest_run
FOR EACH ROW EXECUTE FUNCTION meta.reject_synthetic_test_identity();

COMMENT ON FUNCTION meta.is_synthetic_test_page_id(int) IS
  '0065：按保留 wikidot_id、ts2test slug 或 0042 生成器分类器识别当前测试页；'
  '供 meta.ingest_run 合成扫描写入门使用，不按数据库名或普通 test-* slug 猜测。';
COMMENT ON TRIGGER trg_reject_synthetic_test_run ON meta.ingest_run IS
  'P2T01 拒绝 record_page_scan(NULL, synthetic-test-page, ...) 遗留 synthetic running run。';

COMMIT;
