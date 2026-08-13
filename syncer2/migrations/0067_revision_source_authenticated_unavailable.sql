-- =====================================================================================
-- 0067_revision_source_authenticated_unavailable.sql
--
-- history/PageSourceModule 匿名 no_permission 不是目标级终态：这些任务需要先经固定
-- 7890 的已登录 session 复核。复核后仍 no_permission 才表示该修订对采集账号不可得；
-- 这不是本地/远端事实冲突，也不是重试可恢复故障，使用 unavailable 语义终态。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0067] 拒绝在受保护库 % 上修改历史源码权限终态', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.revision_source_backfill_job') IS NULL THEN
    RAISE EXCEPTION '[0067] 缺少 meta.revision_source_backfill_job，请先应用 0027';
  END IF;
END
$guard$;

BEGIN;

ALTER TABLE meta.revision_source_backfill_job DROP CONSTRAINT IF EXISTS rsbj_status_ck;
ALTER TABLE meta.revision_source_backfill_job
  ADD CONSTRAINT rsbj_status_ck CHECK (
    status IN (
      'pending','processing','retry','done','irreconcilable','skipped_deleted','unavailable'
    )
  );

-- 旧 anonymous no_permission 结论尚未经过账号复核，不能继续留在 retry/irreconcilable。
-- 新访问方式改变了失败前提，因此重置 attempt；原错误继续留在 last_error 供审计。
WITH requeued AS (
  UPDATE meta.revision_source_backfill_job j
     SET status = 'pending',
         attempts = 0,
         consecutive_failures = 0,
         not_before = now(),
         locked_by = NULL,
         locked_at = NULL,
         completed_at = NULL,
         last_error = left(
           concat_ws('; ', j.last_error, 'requeued_for_authenticated_7890_recheck'),
           4000
         ),
         updated_at = now()
   WHERE j.status IN ('retry','irreconcilable')
     AND j.last_error LIKE '%history/PageSourceModule%status=no_permission%'
  RETURNING j.revision_seq
)
UPDATE meta.irreconcilable i
   SET resolved_at = now(),
       last_checked = now(),
       next_review_at = NULL,
       locked_by = NULL,
       locked_at = NULL
  FROM requeued r
 WHERE i.kind = 'revision_source'
   AND i.instance_id = r.revision_seq
   AND i.resolved_at IS NULL;

COMMENT ON COLUMN meta.revision_source_backfill_job.status IS
  'pending/processing/retry=活动队列；done=源码已保存；skipped_deleted=页面已非 live；'
  'unavailable=固定 7890 登录账号复核后该历史修订仍 no_permission；'
  'irreconcilable=其它稳定的目标级契约冲突。';

COMMIT;
