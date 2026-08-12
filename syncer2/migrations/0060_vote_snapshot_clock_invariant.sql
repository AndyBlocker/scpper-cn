-- =====================================================================================
-- 0060_vote_snapshot_clock_invariant.sql
--
-- 0059 把 votes/ok 的 INSERT/指定列 UPDATE 接到快照时钟；本迁移补上两道数据库级闭环：
--   1. page_scan 的任意 UPDATE 都复核成功证书，避免 record_page_scan 将来改 SET 列时漏触发；
--   2. page_current INSERT 或显式改写时钟/status 时从成功证据取上界，任何重建/UPSERT
--      都不能把已经推进的时钟覆盖回旧值或 NULL。
--
-- 迁移先提交两端保护，再无锁计算并回填存量 live 页；依赖这些不变式的代码只能后生效。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN (
    'scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_syncer', 'scpper_user'
  ) THEN
    RAISE EXCEPTION '[0060] 拒绝在受保护库 % 上修改投票快照时钟', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.page_scan') IS NULL
     OR to_regclass('serve.page_current') IS NULL
     OR to_regprocedure('meta.advance_vote_snapshot_clock_from_scan()') IS NULL THEN
    RAISE EXCEPTION '[0060] 缺少 0059 投票快照时钟前置 schema'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

-- page_scan 很大；这个部分索引同时服务逐行保护与存量候选计算。CONCURRENTLY 避免
-- 为建索引阻塞正在落库的扫描。
CREATE INDEX CONCURRENTLY IF NOT EXISTS ps_votes_ok_latest
ON meta.page_scan(page_id, scanned_at DESC)
WHERE kind = 'votes' AND status = 'ok';

-- 会话锁跨越下面两个短事务；任何错误断开连接时 PostgreSQL 会自动释放。
SELECT pg_advisory_lock(20260813);

BEGIN;

CREATE OR REPLACE FUNCTION meta.advance_vote_snapshot_clock_from_scan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.kind = 'votes' AND NEW.status = 'ok' THEN
    UPDATE serve.page_current
       SET last_complete_vote_snapshot_at = NEW.scanned_at,
           updated_at = now()
     WHERE page_id = NEW.page_id
       AND status = 'live'
       AND (
         last_complete_vote_snapshot_at IS NULL
         OR last_complete_vote_snapshot_at < NEW.scanned_at
       );
  END IF;
  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION meta.advance_vote_snapshot_clock_from_scan() IS
  '任意 votes/ok page_scan INSERT/UPDATE 都复核 live 页时钟；仅在证据更新时写 page_current。';

REVOKE ALL ON FUNCTION meta.advance_vote_snapshot_clock_from_scan() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_vote_snapshot_success_clock ON meta.page_scan;
CREATE TRIGGER trg_vote_snapshot_success_clock
AFTER INSERT OR UPDATE ON meta.page_scan
FOR EACH ROW
WHEN (NEW.kind = 'votes' AND NEW.status = 'ok')
EXECUTE FUNCTION meta.advance_vote_snapshot_clock_from_scan();

CREATE OR REPLACE FUNCTION serve.preserve_vote_snapshot_clock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_latest_ok timestamptz;
BEGIN
  IF NEW.status <> 'live' THEN
    RETURN NEW;
  END IF;

  SELECT ps.scanned_at
    INTO v_latest_ok
    FROM meta.page_scan ps
   WHERE ps.page_id = NEW.page_id
     AND ps.kind = 'votes'
     AND ps.status = 'ok'
   ORDER BY ps.scanned_at DESC
   LIMIT 1;

  IF v_latest_ok IS NOT NULL THEN
    NEW.last_complete_vote_snapshot_at := GREATEST(
      COALESCE(NEW.last_complete_vote_snapshot_at, v_latest_ok),
      v_latest_ok
    );
  END IF;
  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION serve.preserve_vote_snapshot_clock() IS
  'live page_current 的投票时钟不得早于最新 votes/ok；覆盖 INSERT、重建 UPSERT、显式清空/回退与恢复为 live。';

REVOKE ALL ON FUNCTION serve.preserve_vote_snapshot_clock() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_preserve_vote_snapshot_clock ON serve.page_current;

COMMIT;

-- scan 端保护已提交；候选计算和存量回填不持有 DDL 锁。逐行 page_current 保护要在
-- 大回填之后安装，否则每个历史修正都重复点查 page_scan。安装后再补扫一次竞态窗口。
CREATE TEMP TABLE vote_snapshot_clock_lagged AS
SELECT pc.page_id, latest.scanned_at
  FROM serve.page_current pc
  CROSS JOIN LATERAL (
    SELECT ps.scanned_at
      FROM meta.page_scan ps
     WHERE ps.page_id = pc.page_id
       AND ps.kind = 'votes'
       AND ps.status = 'ok'
     ORDER BY ps.scanned_at DESC
     LIMIT 1
  ) latest
 WHERE pc.status = 'live'
   AND (
     pc.last_complete_vote_snapshot_at IS NULL
     OR pc.last_complete_vote_snapshot_at < latest.scanned_at
   );

CREATE UNIQUE INDEX ON vote_snapshot_clock_lagged(page_id);

-- 500 行一提交：历史上 JavaScript 毫秒精度的 observed_at 与 PostgreSQL 微秒精度的
-- scanned_at 形成了约 3.6 万个亚毫秒差值。分批把单次行锁窗口压到约 1 秒，避免一次
-- 大 UPDATE 让在线 apply_page_meta 长时间等待同一事务。
CREATE PROCEDURE pg_temp.backfill_vote_snapshot_clock(p_batch_size int)
LANGUAGE plpgsql
AS $procedure$
BEGIN
  LOOP
    EXIT WHEN NOT EXISTS (SELECT 1 FROM vote_snapshot_clock_lagged);

    WITH batch AS MATERIALIZED (
      SELECT page_id
        FROM vote_snapshot_clock_lagged
       ORDER BY page_id
       LIMIT p_batch_size
    ), removed AS (
      DELETE FROM vote_snapshot_clock_lagged lagged
       USING batch
       WHERE lagged.page_id = batch.page_id
       RETURNING lagged.page_id, lagged.scanned_at
    )
    UPDATE serve.page_current pc
       SET last_complete_vote_snapshot_at = removed.scanned_at,
           updated_at = now()
      FROM removed
     WHERE pc.page_id = removed.page_id
       AND pc.status = 'live';

    COMMIT;
  END LOOP;
END
$procedure$;

CALL pg_temp.backfill_vote_snapshot_clock(500);

BEGIN;

CREATE TRIGGER trg_preserve_vote_snapshot_clock
BEFORE INSERT OR UPDATE OF last_complete_vote_snapshot_at, status ON serve.page_current
FOR EACH ROW
EXECUTE FUNCTION serve.preserve_vote_snapshot_clock();

COMMIT;

INSERT INTO vote_snapshot_clock_lagged(page_id, scanned_at)
SELECT pc.page_id, latest.scanned_at
  FROM serve.page_current pc
  CROSS JOIN LATERAL (
    SELECT ps.scanned_at
      FROM meta.page_scan ps
     WHERE ps.page_id = pc.page_id
       AND ps.kind = 'votes'
       AND ps.status = 'ok'
     ORDER BY ps.scanned_at DESC
     LIMIT 1
  ) latest
 WHERE pc.status = 'live'
   AND (
     pc.last_complete_vote_snapshot_at IS NULL
     OR pc.last_complete_vote_snapshot_at < latest.scanned_at
   );

CALL pg_temp.backfill_vote_snapshot_clock(500);

DO $invariant$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM serve.page_current pc
      CROSS JOIN LATERAL (
        SELECT ps.scanned_at
          FROM meta.page_scan ps
         WHERE ps.page_id = pc.page_id
           AND ps.kind = 'votes'
           AND ps.status = 'ok'
         ORDER BY ps.scanned_at DESC
         LIMIT 1
      ) latest
     WHERE pc.status = 'live'
       AND (
         pc.last_complete_vote_snapshot_at IS NULL
         OR pc.last_complete_vote_snapshot_at < latest.scanned_at
       )
  ) THEN
    RAISE EXCEPTION '[0060] 回填后仍存在 votes/ok 时钟落后的 live 页'
      USING ERRCODE = '23514';
  END IF;
END
$invariant$;

DROP TABLE vote_snapshot_clock_lagged;
SELECT pg_advisory_unlock(20260813);
