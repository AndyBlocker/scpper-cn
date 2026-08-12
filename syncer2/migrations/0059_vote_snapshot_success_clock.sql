-- =====================================================================================
-- 0059_vote_snapshot_success_clock.sql
--
-- `ingest.apply_vote_snapshot` 的幂等快照分支会在写下 votes/ok page_scan 后提前返回。
-- 对已有票页，这是“内容未变化”的正常重放；对零票页，初始空 current 与第一次空快照
-- 天然相等。两者此前都不会推进 last_complete_vote_snapshot_at，导致高频播种永久认为
-- 页面从未完成。本迁移把「votes/ok 是完整快照证书」落实为数据库不变式：无论 apply
-- 走整体替换还是幂等短路，成功证据落库时都在同一事务推进页面快照时钟。
--
-- 迁移必须先于依赖该不变式的认领/播种代码启用。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN (
    'scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_syncer', 'scpper_user'
  ) THEN
    RAISE EXCEPTION '[0059] 拒绝在受保护库 % 上修改投票快照时钟', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.page_scan') IS NULL
     OR to_regclass('serve.page_current') IS NULL THEN
    RAISE EXCEPTION '[0059] 缺少 meta.page_scan / serve.page_current 前置 schema'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

SELECT pg_advisory_xact_lock(20260813);

CREATE OR REPLACE FUNCTION meta.advance_vote_snapshot_clock_from_scan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.kind = 'votes' AND NEW.status = 'ok' THEN
    UPDATE serve.page_current
       SET last_complete_vote_snapshot_at = GREATEST(
             COALESCE(last_complete_vote_snapshot_at, NEW.scanned_at),
             NEW.scanned_at
           ),
           updated_at = now()
     WHERE page_id = NEW.page_id
       AND status = 'live';
  END IF;
  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION meta.advance_vote_snapshot_clock_from_scan() IS
  'votes/ok page_scan 是完整 WhoRated 快照证书；证据 INSERT/UPDATE 与页面快照时钟在同一事务推进。'
  '覆盖整体替换、内容不变的幂等重放，以及初始 current 为空的零票页。';

REVOKE ALL ON FUNCTION meta.advance_vote_snapshot_clock_from_scan() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_vote_snapshot_success_clock ON meta.page_scan;
CREATE TRIGGER trg_vote_snapshot_success_clock
AFTER INSERT OR UPDATE OF kind, status, scanned_at ON meta.page_scan
FOR EACH ROW
WHEN (NEW.kind = 'votes' AND NEW.status = 'ok')
EXECUTE FUNCTION meta.advance_vote_snapshot_clock_from_scan();

COMMIT;
