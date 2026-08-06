-- =====================================================================================
-- 0043_adult_listpages_content.sql
-- 受限分类无法匿名 ViewSource；保存 ListPages %%content%% 的原始渲染 HTML 与纯文本。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0043] 拒绝在受保护库 % 上创建受限分类内容入口', current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

-- content_blob.source 的契约是 wikidot wikitext，不能把 ListPages 渲染 HTML 冒充源码。
-- 单独内容寻址；page_current 只保留当前 sha 与既有 search_text 投影。
CREATE TABLE IF NOT EXISTS ingest.rendered_content_blob (
  sha256       bytea PRIMARY KEY,
  rendered_html text NOT NULL,
  text_content text,
  byte_len     int NOT NULL,
  text_len     int NOT NULL DEFAULT 0,
  source       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rendered_content_blob_sha_ck CHECK (octet_length(sha256) = 32),
  CONSTRAINT rendered_content_blob_len_ck CHECK (byte_len >= 0 AND text_len >= 0),
  CONSTRAINT rendered_content_blob_source_ck CHECK (source IN ('wikidot_listpages'))
);

ALTER TABLE serve.page_current
  ADD COLUMN IF NOT EXISTS rendered_content_sha bytea;

DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'serve.page_current'::regclass
       AND conname = 'page_current_rendered_content_sha_fk'
  ) THEN
    ALTER TABLE serve.page_current
      ADD CONSTRAINT page_current_rendered_content_sha_fk
      FOREIGN KEY (rendered_content_sha) REFERENCES ingest.rendered_content_blob(sha256);
  END IF;
END
$fk$;

COMMENT ON TABLE ingest.rendered_content_blob IS
  'ListPages %%content%% 的原始渲染 HTML，按 UTF-8 sha256 内容寻址；'
  '受限分类匿名 ViewSource 不可用时仍能保存真实正文，但绝不冒充 wikitext source。';
COMMENT ON COLUMN serve.page_current.rendered_content_sha IS
  '当前 ListPages 渲染正文；与 source_sha(wikidot wikitext)分开，search_text 仍是统一纯文本投影。';

-- 与 content_blob 相同：渲染内容事实只增不改，也禁止 TRUNCATE 绕开行触发器。
DROP TRIGGER IF EXISTS trg_immutable ON ingest.rendered_content_blob;
CREATE TRIGGER trg_immutable
BEFORE UPDATE OR DELETE ON ingest.rendered_content_blob
FOR EACH ROW EXECUTE FUNCTION ingest.fn_fact_immutable();

DROP TRIGGER IF EXISTS trg_no_truncate ON ingest.rendered_content_blob;
CREATE TRIGGER trg_no_truncate
BEFORE TRUNCATE ON ingest.rendered_content_blob
FOR EACH STATEMENT EXECUTE FUNCTION ingest.fn_no_truncate();

CREATE OR REPLACE FUNCTION ingest.apply_listpages_rendered_content(
  p_page          int,
  p_sha           bytea,
  p_rendered_html text,
  p_text_content  text,
  p_observed      timestamptz,
  p_run           bigint DEFAULT NULL,
  p_wikidot_id    int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_inserted int := 0;
  v_hit int := 0;
BEGIN
  IF p_sha IS NULL OR octet_length(p_sha) <> 32 THEN
    RAISE EXCEPTION 'apply_listpages_rendered_content: sha 必须是 32 字节 sha256'
      USING ERRCODE = '22023';
  END IF;
  IF p_rendered_html IS NULL THEN
    RAISE EXCEPTION 'apply_listpages_rendered_content: rendered_html 不得为 NULL'
      USING ERRCODE = '22004';
  END IF;
  IF sha256(convert_to(p_rendered_html, 'UTF8')) <> p_sha THEN
    RAISE EXCEPTION 'apply_listpages_rendered_content: sha 与 rendered_html UTF-8 字节不一致'
      USING ERRCODE = '22000';
  END IF;

  PERFORM meta.assert_writes_allowed('content');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  INSERT INTO ingest.rendered_content_blob(
    sha256, rendered_html, text_content, byte_len, text_len, source, created_at
  ) VALUES (
    p_sha, p_rendered_html, p_text_content,
    octet_length(p_rendered_html), COALESCE(length(p_text_content), 0),
    'wikidot_listpages', now()
  )
  ON CONFLICT (sha256) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- sha 相同却正文不同只能是摘要碰撞/调用方 bug；不能借 ON CONFLICT 静默择一。
  IF NOT EXISTS (
    SELECT 1 FROM ingest.rendered_content_blob b
     WHERE b.sha256 = p_sha
       AND b.rendered_html IS NOT DISTINCT FROM p_rendered_html
       AND b.text_content IS NOT DISTINCT FROM p_text_content
  ) THEN
    RAISE EXCEPTION 'apply_listpages_rendered_content: sha 已存在但正文/纯文本不同'
      USING ERRCODE = '23505';
  END IF;

  UPDATE serve.page_current
     SET rendered_content_sha = p_sha,
         search_text = p_text_content,
         updated_at = now()
   WHERE page_id = p_page;
  GET DIAGNOSTICS v_hit = ROW_COUNT;
  IF v_hit = 0 THEN
    RAISE EXCEPTION 'apply_listpages_rendered_content: page_current 缺 page_id=%', p_page
      USING ERRCODE = '23503';
  END IF;

  PERFORM meta.record_page_scan(
    p_run, p_page, 'content', 'ok', 1, 1, true, NULL, NULL, p_sha, NULL
  );

  RETURN jsonb_build_object(
    'sha256', encode(p_sha, 'hex'),
    'inserted', v_inserted = 1,
    'html_bytes', octet_length(p_rendered_html),
    'text_chars', COALESCE(length(p_text_content), 0)
  );
END
$fn$;

REVOKE ALL ON FUNCTION ingest.apply_listpages_rendered_content(
  int, bytea, text, text, timestamptz, bigint, int
) FROM PUBLIC;

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION ingest.apply_listpages_rendered_content(
      int, bytea, text, text, timestamptz, bigint, int
    ) TO ingestor_role;
    GRANT SELECT ON ingest.rendered_content_blob TO ingestor_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT ON ingest.rendered_content_blob TO projector_role;
  END IF;
  IF to_regrole('migration_role') IS NOT NULL THEN
    GRANT ALL ON ingest.rendered_content_blob TO migration_role;
    GRANT EXECUTE ON FUNCTION ingest.apply_listpages_rendered_content(
      int, bytea, text, text, timestamptz, bigint, int
    ) TO migration_role;
  END IF;
END
$grants$;

COMMIT;
