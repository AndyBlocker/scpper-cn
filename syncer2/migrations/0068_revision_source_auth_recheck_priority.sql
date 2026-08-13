-- =====================================================================================
-- 0068_revision_source_auth_recheck_priority.sql
--
-- 0067 重排的匿名 no_permission 是已经失败过的认证复核债务。通过 not_before 提前
-- 到既有 FIFO 队头，既让新账号链路及时重新分类，又不改变 claim 的稳定排序合同。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0068] 拒绝在受保护库 % 上调整历史源码复核队列', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.revision_source_backfill_job') IS NULL THEN
    RAISE EXCEPTION '[0068] 缺少 meta.revision_source_backfill_job，请先应用 0027';
  END IF;
END
$guard$;

UPDATE meta.revision_source_backfill_job
   SET not_before = TIMESTAMPTZ '1970-01-01 00:00:00+00',
       updated_at = now()
 WHERE status = 'pending'
   AND last_error LIKE '%requeued_for_authenticated_7890_recheck%'
   AND not_before > TIMESTAMPTZ '1970-01-01 00:00:00+00';
