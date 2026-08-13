-- =====================================================================================
-- 0069_revision_regression_convergence.sql
-- 修订倒退身份确认超过一小时仍无可靠身份结论时，必须离开 pending 并显式升级人工复核。
-- 本迁移只扩展兼容状态；分类、退避和既有数据收口由随后部署的采集代码完成。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0069] 拒绝在受保护库 % 上修改修订倒退状态', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.revision_regression_identity_state') IS NULL THEN
    RAISE EXCEPTION '[0069] 缺少 0053 revision_regression_identity_state 前置对象'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

ALTER TABLE meta.revision_regression_identity_state
  DROP CONSTRAINT rris_status_ck;

ALTER TABLE meta.revision_regression_identity_state
  ADD CONSTRAINT rris_status_ck CHECK (
    status IN ('pending', 'accepted_same_identity', 'slug_reused', 'deleted', 'manual_review')
  );

COMMENT ON TABLE meta.revision_regression_identity_state IS
  'ListPages 修订号倒退的显式身份复核状态。同 wikidotId 可 CAS 接受较低新水位；'
  'wikidotId 改变/slug 消失走 lineage/删除；一小时仍无可靠结论升级 manual_review。';

COMMIT;
