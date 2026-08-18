-- =====================================================================================
-- 0074_observed_empty_title_projection.sql
--
-- page_attr_history 已能区分「没有 title 观测行」与「远端明确返回空字符串」，但
-- apply_page_meta 旧投影用 NULLIF(..., '') 把两者重新折叠成 page_current.title=NULL。
-- standard 页保留远端明确空串；hidden 页仍以 enumeration_scope 显式归类且允许 NULL。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN (
    'scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_syncer', 'scpper_user'
  ) THEN
    RAISE EXCEPTION '[0074] 拒绝在受保护库 % 上修改 title 投影语义', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('serve.page_current') IS NULL
     OR to_regclass('ingest.page_attr_history') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'serve'
          AND table_name = 'page_current'
          AND column_name = 'enumeration_scope'
     ) THEN
    RAISE EXCEPTION '[0074] 缺少 0072/0073 页面枚举域与属性历史前置对象'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

SELECT pg_advisory_xact_lock(2026081801);

CREATE OR REPLACE FUNCTION serve.project_observed_empty_title()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- title JSON string "" 是一次真实观测；JSON null 或无当前行仍表示未知。
  IF NEW.enumeration_scope = 'standard'
     AND NEW.title IS NULL
     AND EXISTS (
       SELECT 1
         FROM ingest.page_attr_history h
        WHERE h.page_id = NEW.page_id
          AND h.attr = 'title'
          AND h.valid_to IS NULL
          AND h.source = 'observed'
          AND h.value = '""'::jsonb
     ) THEN
    NEW.title := '';
  END IF;
  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION serve.project_observed_empty_title() IS
  'standard 页保留 observed title 空字符串，使其不与从未观测的 NULL 混淆；'
  'listpages_hidden 页继续由 enumeration_scope 表达不可枚举。';

REVOKE ALL ON FUNCTION serve.project_observed_empty_title() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_project_observed_empty_title ON serve.page_current;
CREATE TRIGGER trg_project_observed_empty_title
BEFORE INSERT OR UPDATE OF title, enumeration_scope ON serve.page_current
FOR EACH ROW EXECUTE FUNCTION serve.project_observed_empty_title();

-- 存量只改当前有 observed 空串证据的 standard 页，不猜标题、不触碰 hidden 页。
UPDATE serve.page_current pc
   SET title = ''
  FROM ingest.page_attr_history h
 WHERE pc.page_id = h.page_id
   AND pc.status = 'live'
   AND pc.enumeration_scope = 'standard'
   AND pc.title IS NULL
   AND h.attr = 'title'
   AND h.valid_to IS NULL
   AND h.source = 'observed'
   AND h.value = '""'::jsonb;

COMMENT ON COLUMN serve.page_current.title IS
  'NULL=尚无当前 title 观测（或 listpages_hidden 不要求观测）；空字符串=standard 页远端明确返回空 title。';

COMMIT;
