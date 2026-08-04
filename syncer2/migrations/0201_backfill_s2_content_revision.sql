-- =====================================================================================
-- 0201_backfill_s2_content_revision.sql —— v1→v2 S2 内容/修订回填支撑
-- =====================================================================================
-- 回填本体在 src/backfill/s2.ts；本迁移只补：
--   1) content_blob.text_content_basis，显式区分 CROM、整页 HTML 与已删页源码兜底；
--   2) page_source 的 NULL rev_no 幂等自然键；
--   3) provenance 词表与保护库安全闸。
-- =====================================================================================

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      'refusing to apply v2 S2 backfill DDL to protected database % (v1 is read-only)',
      current_database();
  END IF;
END $$;

ALTER TABLE ingest.content_blob
  ADD COLUMN IF NOT EXISTS text_content_basis text NOT NULL DEFAULT 'wikidot_html';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'ingest.content_blob'::regclass
       AND conname = 'content_blob_text_basis_ck'
  ) THEN
    ALTER TABLE ingest.content_blob
      ADD CONSTRAINT content_blob_text_basis_ck
      CHECK (text_content_basis IN ('wikidot_html', 'v1_crom', 'v1_source_fallback'));
  END IF;
END $$;

COMMENT ON COLUMN ingest.content_blob.text_content_basis IS
  '正文提取口径：wikidot_html=整页 #page-content（v2 权威 A1）；'
  'v1_crom=v1 PageVersion.textContent 原样；'
  'v1_source_fallback=页面已删/HTML 不可得，只能从留存 wikitext 保守去标记提取。'
  '最后一种与 HTML 口径不等价，必须显式保留以便搜索/embedding 对账分层。';

-- rev_no 有值时已有 ps_rev(page_id, rev_no)；rev_no 为空时，(page_id, blob_sha)
-- 是 apply_page_meta 与 S2 回填共同采用的幂等键。把应用层 NOT EXISTS 提升成数据库约束，
-- 避免两个并发写者都通过检查后插入副本。
CREATE UNIQUE INDEX IF NOT EXISTS ps_backfill_null
  ON ingest.page_source(page_id, blob_sha)
  WHERE rev_no IS NULL;

COMMENT ON INDEX ingest.ps_backfill_null IS
  'NULL rev_no 的 page_source 幂等键；同页同源码只留一次观测指认。';

COMMIT;
