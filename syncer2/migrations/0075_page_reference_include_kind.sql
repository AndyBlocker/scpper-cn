-- =====================================================================================
-- 0075_page_reference_include_kind.sql — page_reference 纳入 Wikidot include 引用
--
-- [[include page]] / [[include :site:page]] 是页面源码中的结构依赖；把 INCLUDE 纳入
-- kind 约束后，projector 才能在不借用 SHORT 伪分类的前提下保存模板引用。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0075] 拒绝在受保护库 % 上修改 page_reference', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('serve.page_reference') IS NULL THEN
    RAISE EXCEPTION '[0075] 需要既有 serve.page_reference';
  END IF;
END
$guard$;

BEGIN;

ALTER TABLE serve.page_reference
  DROP CONSTRAINT IF EXISTS page_reference_kind_check;
ALTER TABLE serve.page_reference
  DROP CONSTRAINT IF EXISTS page_reference_kind_ck;
ALTER TABLE serve.page_reference
  ADD CONSTRAINT page_reference_kind_ck
  CHECK (kind IN ('TRIPLE', 'SHORT', 'DIRECT', 'INCLUDE'));

COMMENT ON CONSTRAINT page_reference_kind_ck ON serve.page_reference IS
  '源码引用语法：三括号页链、单括号命名 URL、裸 URL、Wikidot include 结构依赖。';

COMMIT;
