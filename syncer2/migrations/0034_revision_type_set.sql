-- =====================================================================================
-- 0034_revision_type_set.sql —— revision.type 从混合 text 收敛为规范 text[] 集合
-- =====================================================================================
-- 历史形态：
--   SOURCE_CHANGED                         -> {SOURCE_CHANGED}
--   ["SOURCE_CHANGED","TITLE_CHANGED"]    -> {SOURCE_CHANGED,TITLE_CHANGED}
--   unknown                                -> NULL（信息未观测，不伪装成空集合）
--
-- 可重复执行：已是 text[] 时不再改列类型；函数、约束、索引均可重建/复用。
-- ALTER COLUMN TYPE 是 DDL 表重写，不触发 revision 的行级 UPDATE 守卫；同时显式打开
-- migration context，后续如在本事务增加数据修整也不会绕开既有迁移审计边界。
-- =====================================================================================

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0034] 拒绝在受保护库 % 上修改 revision.type；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

SET LOCAL scpper.bypass_guard = 'on';

-- 数组在库内按固定业务顺序去重；UNKNOWN:* 再按 C collation 排序。
CREATE OR REPLACE FUNCTION ingest.canonical_revision_types(p_types text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    array_agg(s.type ORDER BY s.type_rank, s.type COLLATE "C"),
    ARRAY[]::text[]
  )
    FROM (
      SELECT DISTINCT v.type,
             CASE v.type
               WHEN 'PAGE_CREATED'  THEN 1
               WHEN 'SOURCE_CHANGED' THEN 2
               WHEN 'TITLE_CHANGED'  THEN 3
               WHEN 'TAGS_CHANGED'   THEN 4
               WHEN 'PAGE_RENAMED'   THEN 5
               WHEN 'META_CHANGED'   THEN 6
               WHEN 'FILES_CHANGED'  THEN 7
               ELSE 8
             END AS type_rank
        FROM unnest(p_types) AS v(type)
       WHERE v.type IS NOT NULL AND btrim(v.type) <> ''
    ) s
$function$;

CREATE OR REPLACE FUNCTION ingest.revision_types_valid(p_types text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT cardinality(p_types) > 0
     AND p_types = ingest.canonical_revision_types(p_types)
     AND COALESCE(
           (SELECT bool_and(
                     v.type IN (
                       'PAGE_CREATED', 'SOURCE_CHANGED', 'TITLE_CHANGED',
                       'TAGS_CHANGED', 'PAGE_RENAMED', 'META_CHANGED', 'FILES_CHANGED'
                     )
                     OR (starts_with(v.type, 'UNKNOWN:') AND length(v.type) > length('UNKNOWN:'))
                   )
              FROM unnest(p_types) AS v(type)),
           false
         )
$function$;

-- apply_revision_batch 的唯一 JSONB -> text[] 边界。标量、空数组、空元素和未声明词汇
-- 都在写事实前被拒绝；重复/乱序会收敛为规范集合，返回值可直接写入约束列。
CREATE OR REPLACE FUNCTION ingest.revision_types_from_jsonb(p_types jsonb)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_types text[];
  v_canonical text[];
BEGIN
  IF jsonb_typeof(p_types) <> 'array' THEN
    RAISE EXCEPTION 'revision.type 必须是 JSON array 或 null，收到 %', jsonb_typeof(p_types)
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_types) AS e(value)
     WHERE jsonb_typeof(e.value) <> 'string'
  ) THEN
    RAISE EXCEPTION 'revision.type 数组元素必须全部是 string'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(e.value #>> '{}' ORDER BY e.ord) INTO v_types
    FROM jsonb_array_elements(p_types) WITH ORDINALITY AS e(value, ord)
  ;
  v_canonical := ingest.canonical_revision_types(COALESCE(v_types, ARRAY[]::text[]));
  IF NOT ingest.revision_types_valid(v_canonical) THEN
    RAISE EXCEPTION 'revision.type 不是非空合法类型集合：%', p_types
      USING ERRCODE = '22023';
  END IF;
  RETURN v_canonical;
END
$function$;

-- 仅供 text -> text[] 的一次性/可重跑转换使用。
CREATE OR REPLACE FUNCTION ingest.migrate_revision_type_text(p_type text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_json jsonb;
  v_result text[];
BEGIN
  IF p_type = 'unknown' THEN
    RETURN NULL;
  END IF;
  IF starts_with(ltrim(p_type), '[') THEN
    BEGIN
      v_json := p_type::jsonb;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'revision.type JSON 旧值无法解析：%', p_type USING ERRCODE = '22023';
    END;
    RETURN ingest.revision_types_from_jsonb(v_json);
  END IF;
  v_result := ingest.canonical_revision_types(ARRAY[p_type]);
  IF NOT ingest.revision_types_valid(v_result) THEN
    RAISE EXCEPTION 'revision.type 明文旧值不在合法词表：%', p_type USING ERRCODE = '22023';
  END IF;
  RETURN v_result;
END
$function$;

DO $convert$
DECLARE
  v_udt text;
  v_before bigint;
  v_after bigint;
BEGIN
  SELECT c.udt_name INTO v_udt
    FROM information_schema.columns c
   WHERE c.table_schema = 'ingest'
     AND c.table_name = 'revision'
     AND c.column_name = 'type';
  IF v_udt IS NULL THEN
    RAISE EXCEPTION '[0034] ingest.revision.type 不存在';
  END IF;

  -- 把 before/转换/after 固定在同一个事实集合上；否则并发 INSERT 会制造假行数漂移。
  LOCK TABLE ingest.revision IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO v_before FROM ingest.revision;
  RAISE NOTICE '[0034] revision rows before=% type_udt=%', v_before, v_udt;
  IF v_udt = 'text' THEN
    ALTER TABLE ingest.revision
      ALTER COLUMN type TYPE text[]
      USING ingest.migrate_revision_type_text(type);
  ELSIF v_udt <> '_text' THEN
    RAISE EXCEPTION '[0034] ingest.revision.type 是意外类型 %（期望 text 或 text[]）', v_udt;
  END IF;
  SELECT count(*) INTO v_after FROM ingest.revision;
  RAISE NOTICE '[0034] revision rows after=%', v_after;
  IF v_after <> v_before THEN
    RAISE EXCEPTION '[0034] 行数在列转换中改变：before=% after=%', v_before, v_after;
  END IF;
END
$convert$;

DROP FUNCTION ingest.migrate_revision_type_text(text);

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'ingest.revision'::regclass
       AND conname = 'revision_type_set_ck'
  ) THEN
    ALTER TABLE ingest.revision
      ADD CONSTRAINT revision_type_set_ck
      CHECK (type IS NULL OR ingest.revision_types_valid(type)) NOT VALID;
  END IF;
END
$constraint$;
ALTER TABLE ingest.revision VALIDATE CONSTRAINT revision_type_set_ck;

CREATE INDEX IF NOT EXISTS rev_type
  ON ingest.revision USING gin(type)
  WHERE type IS NOT NULL;

COMMENT ON COLUMN ingest.revision.type IS
  '规范修订类型集合(text[])；单修订可同时有多个类型。NULL=来源未提供/无法恢复类型信息；'
  '空数组非法，不能用来表达未知。元素去重并按 canonical_revision_types 固定排序。';

-- unknown 已统一表达为 NULL：正常路径仍只允许 NULL -> 具体集合的单向后补。
CREATE OR REPLACE FUNCTION ingest.fn_revision_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_whitelist text[] := ARRAY['wikidot_revision_id','type','source_sha'];
BEGIN
  IF meta.is_migration_context() THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ingest.revision 是 append-only,禁止 DELETE' USING ERRCODE = '25006';
  END IF;
  IF COALESCE(current_setting('scpper.revision_backfill', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'ingest.revision 禁止直接 UPDATE;wid/type/source_sha 的后补只能经 '
      'ingest.apply_revision_batch(它会 SET LOCAL scpper.revision_backfill=''on'')'
      USING ERRCODE = '25006';
  END IF;
  IF (to_jsonb(NEW) - v_whitelist) IS DISTINCT FROM (to_jsonb(OLD) - v_whitelist) THEN
    RAISE EXCEPTION
      'ingest.revision 后补只允许改 %,本次 UPDATE 触碰了白名单外的列(seq=%)',
      array_to_string(v_whitelist, '/'), OLD.seq
      USING ERRCODE = '25006';
  END IF;
  IF OLD.wikidot_revision_id IS NOT NULL
     AND NEW.wikidot_revision_id IS DISTINCT FROM OLD.wikidot_revision_id THEN
    RAISE EXCEPTION 'wikidot_revision_id 只允许 NULL→值 的单向后补(seq=%)', OLD.seq
      USING ERRCODE = '25006';
  END IF;
  IF OLD.type IS NOT NULL AND NEW.type IS DISTINCT FROM OLD.type THEN
    RAISE EXCEPTION
      'revision.type 只允许 NULL→具体集合的单向后补;跨源冲突必须进 '
      'meta.fact_quarantine 而不是覆盖(seq=%)', OLD.seq
      USING ERRCODE = '25006';
  END IF;
  IF OLD.source_sha IS NOT NULL AND NEW.source_sha IS DISTINCT FROM OLD.source_sha THEN
    RAISE EXCEPTION 'revision.source_sha 只允许 NULL→值 的单向后补(seq=%)', OLD.seq
      USING ERRCODE = '25006';
  END IF;
  RETURN NEW;
END
$function$;

-- p_revisions.type 的 API 形态是 JSON array 或 null；库内列只接收规范 text[]。
CREATE OR REPLACE FUNCTION ingest.apply_revision_batch(
  p_page          int,
  p_revisions     jsonb,
  p_claimed_total int         DEFAULT NULL,
  p_observed      timestamptz DEFAULT now(),
  p_source        text        DEFAULT 'wikidot',
  p_run           bigint      DEFAULT NULL,
  p_wikidot_id    int         DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_raw      int;
  v_typefill int := 0;
  v_backfill int := 0;
  v_ins_wid  int := 0;
  v_ins_pend int := 0;
  v_quar     int := 0;
  v_total    int;
  v_expected int;
  v_status   text;
  v_reason   text := NULL;
  v_guc_prev text;
BEGIN
  IF p_revisions IS NULL OR jsonb_typeof(p_revisions) <> 'array' THEN
    RAISE EXCEPTION 'apply_revision_batch: p_revisions 必须是 jsonb array' USING ERRCODE = '22023';
  END IF;

  -- 先完整校验输入，再打开 ingest gate 或写 quarantine，保证坏形态零副作用。
  PERFORM CASE
            WHEN r ? 'type' AND r -> 'type' <> 'null'::jsonb
              THEN ingest.revision_types_from_jsonb(r -> 'type')
            ELSE NULL::text[]
          END
    FROM jsonb_array_elements(p_revisions) AS e(r);

  PERFORM meta.assert_writes_allowed('revision');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  SELECT count(*)::int INTO v_raw FROM jsonb_array_elements(p_revisions) AS e(r);
  v_expected := meta.revision_list_count(p_claimed_total);

  INSERT INTO meta.fact_quarantine(domain, page_id, natural_key, raw, reason, source,
                                   run_id, observed_at)
  SELECT 'revision', p_page, r ->> 'wikidot_revision_id', r,
         'wid_bound_to_other_page', p_source, p_run, p_observed
    FROM jsonb_array_elements(p_revisions) AS e(r)
   WHERE NULLIF(r ->> 'wikidot_revision_id','') IS NOT NULL
     AND EXISTS (SELECT 1 FROM ingest.revision rv
                  WHERE rv.wikidot_revision_id = (r ->> 'wikidot_revision_id')::bigint
                    AND rv.page_id <> p_page);
  GET DIAGNOSTICS v_quar = ROW_COUNT;

  INSERT INTO meta.fact_quarantine(domain, page_id, natural_key, raw, reason, source,
                                   run_id, observed_at)
  SELECT 'revision', p_page, r ->> 'wikidot_revision_id',
         r || jsonb_build_object('existing_type', to_jsonb(rv.type)),
         'type_conflict_across_sources', p_source, p_run, p_observed
    FROM jsonb_array_elements(p_revisions) AS e(r)
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN r ? 'type' AND r -> 'type' <> 'null'::jsonb
                 THEN ingest.revision_types_from_jsonb(r -> 'type')
               ELSE NULL::text[]
             END AS type
    ) i
    JOIN ingest.revision rv
      ON rv.wikidot_revision_id = NULLIF(r ->> 'wikidot_revision_id','')::bigint
   WHERE rv.type IS NOT NULL
     AND i.type IS NOT NULL
     AND rv.type IS DISTINCT FROM i.type;

  v_guc_prev := current_setting('scpper.revision_backfill', true);
  PERFORM set_config('scpper.revision_backfill', 'on', true);

  WITH inc AS (
    SELECT (r ->> 'wikidot_revision_id')::bigint AS wid,
           (r ->> 'rev_no')::int                 AS rev_no,
           CASE
             WHEN r ? 'type' AND r -> 'type' <> 'null'::jsonb
               THEN ingest.revision_types_from_jsonb(r -> 'type')
             ELSE NULL::text[]
           END AS type,
           decode(NULLIF(r ->> 'source_sha',''), 'hex') AS sha
      FROM jsonb_array_elements(p_revisions) AS e(r)
     WHERE NULLIF(r ->> 'wikidot_revision_id','') IS NOT NULL
  ), type_upd AS (
    UPDATE ingest.revision rv
       SET type = i.type
      FROM inc i
     WHERE rv.page_id = p_page
       AND rv.wikidot_revision_id = i.wid
       AND rv.type IS NULL
       AND i.type IS NOT NULL
    RETURNING 1
  ), upd AS (
    UPDATE ingest.revision rv
       SET wikidot_revision_id = i.wid,
           type       = COALESCE(rv.type, i.type),
           source_sha = COALESCE(rv.source_sha, i.sha)
      FROM inc i
     WHERE rv.page_id = p_page
       AND rv.rev_no  = i.rev_no
       AND rv.wikidot_revision_id IS NULL
       AND i.rev_no IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ingest.revision x WHERE x.wikidot_revision_id = i.wid)
       AND (i.sha IS NULL OR EXISTS (SELECT 1 FROM ingest.content_blob b WHERE b.sha256 = i.sha))
    RETURNING 1
  )
  SELECT (SELECT count(*)::int FROM type_upd),
         (SELECT count(*)::int FROM upd)
    INTO v_typefill, v_backfill;

  PERFORM set_config('scpper.revision_backfill', COALESCE(v_guc_prev, 'off'), true);

  WITH ins AS (
    INSERT INTO ingest.revision(page_id, wikidot_revision_id, rev_no, type, author_id,
                                occurred_at, comment, source_sha, observed_at, source)
    SELECT p_page,
           (r ->> 'wikidot_revision_id')::bigint,
           NULLIF(r ->> 'rev_no','')::int,
           CASE
             WHEN r ? 'type' AND r -> 'type' <> 'null'::jsonb
               THEN ingest.revision_types_from_jsonb(r -> 'type')
             ELSE NULL::text[]
           END,
           NULLIF(r ->> 'author_id','')::int,
           COALESCE(NULLIF(r ->> 'occurred_at','')::timestamptz, p_observed),
           NULLIF(r ->> 'comment',''),
           CASE WHEN NULLIF(r ->> 'source_sha','') IS NOT NULL
                 AND EXISTS (SELECT 1 FROM ingest.content_blob b
                              WHERE b.sha256 = decode(r ->> 'source_sha','hex'))
                THEN decode(r ->> 'source_sha','hex') END,
           p_observed, p_source
      FROM jsonb_array_elements(p_revisions) AS e(r)
     WHERE NULLIF(r ->> 'wikidot_revision_id','') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ingest.revision x
                        WHERE x.wikidot_revision_id = (r ->> 'wikidot_revision_id')::bigint)
     ORDER BY (r ->> 'wikidot_revision_id')::bigint
    ON CONFLICT (wikidot_revision_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO v_ins_wid FROM ins;

  WITH ins AS (
    INSERT INTO ingest.revision(page_id, wikidot_revision_id, rev_no, type, author_id,
                                occurred_at, comment, source_sha, observed_at, source)
    SELECT p_page, NULL,
           (r ->> 'rev_no')::int,
           CASE
             WHEN r ? 'type' AND r -> 'type' <> 'null'::jsonb
               THEN ingest.revision_types_from_jsonb(r -> 'type')
             ELSE NULL::text[]
           END,
           NULLIF(r ->> 'author_id','')::int,
           COALESCE(NULLIF(r ->> 'occurred_at','')::timestamptz, p_observed),
           NULLIF(r ->> 'comment',''),
           CASE WHEN NULLIF(r ->> 'source_sha','') IS NOT NULL
                 AND EXISTS (SELECT 1 FROM ingest.content_blob b
                              WHERE b.sha256 = decode(r ->> 'source_sha','hex'))
                THEN decode(r ->> 'source_sha','hex') END,
           p_observed, p_source
      FROM jsonb_array_elements(p_revisions) AS e(r)
     WHERE NULLIF(r ->> 'wikidot_revision_id','') IS NULL
       AND NULLIF(r ->> 'rev_no','') IS NOT NULL
     ORDER BY (r ->> 'rev_no')::int
    ON CONFLICT (page_id, rev_no) WHERE wikidot_revision_id IS NULL DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO v_ins_pend FROM ins;

  SELECT count(*)::int INTO v_total FROM ingest.revision WHERE page_id = p_page;
  UPDATE serve.page_current
     SET revision_count = v_total, updated_at = now()
   WHERE page_id = p_page AND revision_count <> v_total;

  IF v_expected > 1 AND v_raw = 1 THEN
    v_status := 'failed';
    v_reason := format(
      '疑似漏传 perpage:仅解析到 1 条；远端零基声明 %s，期望真实 %s 条(P0-8)',
      p_claimed_total, v_expected);
  ELSIF p_claimed_total IS NULL THEN
    v_status := 'ok';
  ELSIF v_raw = v_expected THEN
    v_status := 'ok';
  ELSE
    v_status := 'partial';
    v_reason := format(
      'RevisionList 解析 %s 条 ≠ 远端零基声明 %s + offset（期望 %s 条）',
      v_raw, p_claimed_total, v_expected);
  END IF;
  PERFORM meta.record_page_scan(p_run, p_page, 'revisions', v_status,
                                p_claimed_total, v_raw, NULL, NULL, NULL, NULL, v_reason);

  RETURN jsonb_build_object(
    'raw', v_raw, 'type_backfilled', v_typefill, 'backfilled', v_backfill,
    'inserted_with_wid', v_ins_wid,
    'inserted_pending', v_ins_pend, 'quarantined', v_quar,
    'revision_count', v_total, 'scan_status', v_status, 'reason', v_reason);
END
$function$;

COMMENT ON FUNCTION ingest.apply_revision_batch(int, jsonb, int, timestamptz, text, bigint, int) IS
  '修订批量：p_revisions.type 只接受 JSON array/null，规范化后写 text[]；'
  'type 仅允许 NULL→具体集合单向后补，跨源冲突进入 fact_quarantine。';

DO $assert$
DECLARE
  v_bad bigint;
  v_constraint_valid boolean;
BEGIN
  SELECT convalidated INTO v_constraint_valid
    FROM pg_constraint
   WHERE conrelid = 'ingest.revision'::regclass
     AND conname = 'revision_type_set_ck';
  IF v_constraint_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION '[0034] revision_type_set_ck 不存在或未完成全表验证';
  END IF;
  SELECT count(*) INTO v_bad
    FROM ingest.revision
   WHERE type::text LIKE '[%';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '[0034] 迁移后仍有 % 行 JSON 文本形态 type', v_bad;
  END IF;
END
$assert$;

COMMIT;
