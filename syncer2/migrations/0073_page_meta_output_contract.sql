-- =====================================================================================
-- 0073_page_meta_output_contract.sql
--
-- 1. 把全站 ListPages 系统性排除的模板/系统 namespace 归入 listpages_hidden；
-- 2. 把「meta 已报 ok，但当前 title/tags 没有 observed 属性行」建成可查询、可告警集合；
-- 3. 复用 oldest-pending 的历史/阈值/告警写入，不另造一套只在日志里的监控。
--
-- 本迁移必须先于依赖扩展分类与 meta.page_meta_output_gap 的 TS 代码生效。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN (
    'scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_syncer', 'scpper_user'
  ) THEN
    RAISE EXCEPTION '[0073] 拒绝在受保护库 % 上修改页面元数据产出契约', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('serve.page_current') IS NULL
     OR to_regclass('ingest.page_attr_history') IS NULL
     OR to_regclass('meta.page_scan') IS NULL
     OR to_regclass('meta.pending_collection_current') IS NULL
     OR to_regclass('meta.pending_collection_audit_registry') IS NULL
     OR to_regprocedure('serve.classify_page_enumeration_scope()') IS NULL THEN
    RAISE EXCEPTION '[0073] 缺少 0040/0072 页面分类与 oldest-pending 前置对象'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

SELECT pg_advisory_xact_lock(20260818);

-- ── ListPages 枚举域：隐藏名 + 明确的模板/系统 namespace ────────────────────────
CREATE OR REPLACE FUNCTION serve.classify_page_enumeration_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  NEW.enumeration_scope := CASE
    -- `_template` / `category:_template` / `_theme` / `_404` 等隐藏名。
    WHEN lower(btrim(NEW.slug)) ~ '(^|:)_' THEN 'listpages_hidden'
    -- fragment/component/theme/system 是站点渲染零件或系统页，不是主内容枚举域。
    WHEN lower(btrim(NEW.slug)) ~ '^(fragment|component|theme|system):'
      THEN 'listpages_hidden'
    ELSE 'standard'
  END;
  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION serve.classify_page_enumeration_scope() IS
  '按 Wikidot 隐藏名与 fragment/component/theme/system namespace 维护枚举域；'
  'listpages_hidden 的 L1 缺席、title 空值和属性无产出均不构成主内容缺口。';

UPDATE serve.page_current
   SET enumeration_scope = CASE
     WHEN lower(btrim(slug)) ~ '(^|:)_'
       OR lower(btrim(slug)) ~ '^(fragment|component|theme|system):'
       THEN 'listpages_hidden'
     ELSE 'standard'
   END
 WHERE enumeration_scope IS DISTINCT FROM CASE
     WHEN lower(btrim(slug)) ~ '(^|:)_'
       OR lower(btrim(slug)) ~ '^(fragment|component|theme|system):'
       THEN 'listpages_hidden'
     ELSE 'standard'
   END;

COMMENT ON COLUMN serve.page_current.enumeration_scope IS
  'standard=应由完整/定向 ListPages 产生 title/tags observed 行；'
  'listpages_hidden=隐藏名或 fragment/component/theme/system 模板系统页，'
  '不作为 ListPages 缺席、元数据无产出或删除推断的异常。';

-- ── 成功却无产出：页级、字段级正面检测 ─────────────────────────────────────────
CREATE OR REPLACE VIEW meta.page_meta_output_gap AS
WITH current_observed_attrs AS (
  SELECT pah.page_id,
         bool_or(pah.attr = 'title') AS has_title,
         bool_or(pah.attr = 'tags') AS has_tags
    FROM ingest.page_attr_history pah
   WHERE pah.valid_to IS NULL
     AND pah.source = 'observed'
     AND pah.attr IN ('title', 'tags')
   GROUP BY pah.page_id
), latest_meta AS (
  SELECT DISTINCT ON (ps.page_id)
         ps.page_id,
         ps.status,
         ps.scanned_at,
         ps.error
    FROM meta.page_scan ps
   WHERE ps.kind = 'meta'
   ORDER BY ps.page_id, ps.scanned_at DESC, ps.run_id DESC
), successful_meta AS (
  SELECT ps.page_id,
         min(ps.scanned_at) AS first_meta_ok_at,
         max(ps.scanned_at) AS last_meta_ok_at,
         count(*)::bigint AS meta_ok_count
    FROM meta.page_scan ps
   WHERE ps.kind = 'meta'
     AND ps.status = 'ok'
   GROUP BY ps.page_id
)
SELECT pc.page_id,
       pc.wikidot_id,
       pc.slug,
       pc.enumeration_scope,
       sm.first_meta_ok_at,
       sm.last_meta_ok_at,
       sm.meta_ok_count,
       ARRAY_REMOVE(ARRAY[
         CASE WHEN NOT COALESCE(a.has_title, false) THEN 'title' END,
         CASE WHEN NOT COALESCE(a.has_tags, false) THEN 'tags' END
       ]::text[], NULL) AS missing_attrs
  FROM serve.page_current pc
  JOIN successful_meta sm ON sm.page_id = pc.page_id
  JOIN latest_meta lm ON lm.page_id = pc.page_id AND lm.status = 'ok'
  LEFT JOIN current_observed_attrs a ON a.page_id = pc.page_id
 WHERE pc.status = 'live'
   AND pc.enumeration_scope = 'standard'
   AND (
     NOT COALESCE(a.has_title, false)
     OR NOT COALESCE(a.has_tags, false)
   );

COMMENT ON VIEW meta.page_meta_output_gap IS
  'live standard 页的 meta 成功无产出检测：最新一次 page_scan(meta) 仍为 ok，且当前 title/tags '
  '缺少 source=observed 的 SCD2 行。字段值可合法为空；缺的是观测行本身。'
  'listpages_hidden 模板/系统页显式排除；最新 meta 已 failed 的页转由失败/irreconcilable 告警。';

-- 0054 当前视图先冻结为底座；0073 只叠加新集合，避免复制其它二十余类口径。
DO $pending_view$
BEGIN
  IF to_regclass('meta.pending_collection_current_pre0073') IS NULL THEN
    ALTER VIEW meta.pending_collection_current RENAME TO pending_collection_current_pre0073;
  END IF;
END
$pending_view$;

CREATE OR REPLACE VIEW meta.pending_collection_current AS
SELECT p.collection, p.family, p.pending_count, p.oldest_item_at,
       p.oldest_item_key, p.catchup, p.evidence
  FROM meta.pending_collection_current_pre0073 p
UNION ALL
SELECT 'page_meta_output:missing_observed_attrs'::text AS collection,
       'page_scan_no_output'::text AS family,
       count(*)::bigint AS pending_count,
       min(g.first_meta_ok_at) AS oldest_item_at,
       (array_agg(g.page_id::text ORDER BY g.first_meta_ok_at, g.page_id))[1]
         AS oldest_item_key,
       false AS catchup,
       jsonb_build_object(
         'contract', 'meta ok requires current observed title+tags rows',
         'missing_title', count(*) FILTER (WHERE 'title' = ANY(g.missing_attrs)),
         'missing_tags', count(*) FILTER (WHERE 'tags' = ANY(g.missing_attrs)),
         'oldest_slug', (array_agg(g.slug ORDER BY g.first_meta_ok_at, g.page_id))[1],
         'oldest_missing_attrs',
           (array_agg(to_jsonb(g.missing_attrs) ORDER BY g.first_meta_ok_at, g.page_id))[1],
         'latest_meta_ok_at', max(g.last_meta_ok_at)
       ) AS evidence
  FROM meta.page_meta_output_gap g
HAVING count(*) > 0;

COMMENT ON VIEW meta.pending_collection_current IS
  '0073：既有 oldest-pending 全量集合 + meta 成功但 title/tags observed 行缺失；'
  'page_scan_no_output 由 schedule:oldest-pending 持久化样本并开/关告警。';

INSERT INTO meta.pending_collection_audit_registry(
  schema_name, relation_name, classification, collection_families, rationale
) VALUES (
  'meta', 'page_scan', 'covered',
  ARRAY['page_scan_zero_success', 'page_scan_no_output'],
  'page_scan kind 零成功由 0054 覆盖；meta ok 但 title/tags 无 observed 行由 0073 覆盖'
)
ON CONFLICT (schema_name, relation_name) DO UPDATE
  SET classification = EXCLUDED.classification,
      collection_families = EXCLUDED.collection_families,
      rationale = EXCLUDED.rationale;

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT ON meta.page_meta_output_gap, meta.pending_collection_current
      TO ingestor_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT ON meta.page_meta_output_gap, meta.pending_collection_current
      TO projector_role;
  END IF;
END
$grants$;

COMMIT;
