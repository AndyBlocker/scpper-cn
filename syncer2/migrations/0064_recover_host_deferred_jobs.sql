-- =====================================================================================
-- 0064_recover_host_deferred_jobs.sql
--
-- 0063/worker 语义就绪后的事故数据修复：
--   1. failed/host_deferred 恢复 pending，并归还造成终态的那一次 claim 尝试；
--   2. page_image 恢复 queued，并撤回同一次自我保护误记的 failure_count；
--   3. 清除已由 systemd 逐轮日志证实 attempts=0 的虚假外部图片 permit 时间窗，
--      重置由这些 permit 推到数日后的 pacing 债务；真实失败窗口/429 档位不重置。
--
-- 时间窗使用固定事故边界，避免迁移日后重跑时误删新的真实许可记录。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN (
    'scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_syncer', 'scpper_user'
  ) THEN
    RAISE EXCEPTION '[0064] 拒绝在受保护库 % 上执行 host_deferred 恢复', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.image_ingest_job') IS NULL
     OR to_regclass('serve.page_image') IS NULL
     OR to_regclass('meta.external_image_egress_request_bucket') IS NULL
     OR to_regclass('meta.external_image_egress_control') IS NULL
     OR to_regclass('meta.external_image_egress_global') IS NULL THEN
    RAISE EXCEPTION '[0064] 缺少 0055/0057 图片任务或站外出口前置 schema'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

SELECT pg_advisory_xact_lock(20260813);

CREATE TEMP TABLE host_deferred_recovery ON COMMIT DROP AS
SELECT id, page_id, normalized_url
  FROM meta.image_ingest_job
 WHERE status = 'failed'
   AND failure_class = 'host_deferred';

DO $count$
DECLARE
  affected bigint;
BEGIN
  SELECT count(*) INTO affected FROM host_deferred_recovery;
  RAISE NOTICE '[0064] 本次恢复 failed/host_deferred=%', affected;
END
$count$;

UPDATE serve.page_image image
   SET status = 'queued',
       failure_count = greatest(0, image.failure_count - 1),
       metadata = coalesce(image.metadata, '{}'::jsonb) || jsonb_build_object(
         'host_deferred_terminal_recovered', true,
         'host_deferred_terminal_recovered_at', clock_timestamp()
       )
  FROM host_deferred_recovery recovery
 WHERE image.page_id = recovery.page_id
   AND image.normalized_url = recovery.normalized_url
   AND image.asset_sha IS NULL;

UPDATE meta.image_ingest_job job
   SET status = 'pending',
       not_before = clock_timestamp(),
       attempts = greatest(0, job.attempts - 1),
       locked_by = NULL,
       locked_at = NULL,
       updated_at = clock_timestamp()
  FROM host_deferred_recovery recovery
 WHERE job.id = recovery.id;

-- 07:20–08:17 各轮 JSON 汇总均为 external attempts=0；固定上界留出一分钟余量。
-- 先保存本次确实找到的事故行：历史迁移会被执行器重跑，空集时绝不能再次 rebase
-- 届时可能已经形成的真实 gate 状态。
CREATE TEMP TABLE false_permit_recovery ON COMMIT DROP AS
SELECT host, bucket_start
  FROM meta.external_image_egress_request_bucket
 WHERE bucket_start >= timestamptz '2026-08-13 07:20:00+08'
   AND bucket_start <  timestamptz '2026-08-13 08:18:00+08'
   AND failures = 0;

DELETE FROM meta.external_image_egress_request_bucket bucket
 USING false_permit_recovery recovery
 WHERE bucket.host = recovery.host
   AND bucket.bucket_start = recovery.bucket_start;

-- rolling_* level=3 来自上述虚假 permit；其它真实 429/503/失败率档位保留，只重排
-- 它们下一次许可到“当前 + 该档正常间隔”，避免共享 global 假债务继续拖到数日后。
UPDATE meta.external_image_egress_control control
   SET level = CASE WHEN reason LIKE 'rolling\_%\_requests\_%\_gt\_%' ESCAPE '\'
                    THEN 0 ELSE level END,
       reason = CASE WHEN reason LIKE 'rolling\_%\_requests\_%\_gt\_%' ESCAPE '\'
                     THEN 'incident_0064_false_permit_debt_rebased' ELSE reason END,
       changed_at = CASE WHEN reason LIKE 'rolling\_%\_requests\_%\_gt\_%' ESCAPE '\'
                         THEN clock_timestamp() ELSE changed_at END,
       recover_not_before = CASE
         WHEN reason LIKE 'rolling\_%\_requests\_%\_gt\_%' ESCAPE '\' THEN NULL
         ELSE recover_not_before
       END,
       next_permit_at = clock_timestamp() + CASE
         WHEN reason LIKE 'rolling\_%\_requests\_%\_gt\_%' ESCAPE '\'
           THEN interval '12 seconds'
         ELSE CASE level
           WHEN 0 THEN interval '12 seconds'
           WHEN 1 THEN interval '30 seconds'
           WHEN 2 THEN interval '2 minutes'
           ELSE interval '10 minutes'
         END
       END,
       rolling_hour_requests = coalesce((
         SELECT sum(bucket.requests)::int
           FROM meta.external_image_egress_request_bucket bucket
          WHERE bucket.host = control.host
            AND bucket.bucket_start >= date_trunc('minute', clock_timestamp()) - interval '59 minutes'
       ), 0),
       budget_breached = false,
       updated_at = clock_timestamp()
 WHERE EXISTS (SELECT 1 FROM false_permit_recovery);

UPDATE meta.external_image_egress_global global_control
   SET next_permit_at = clock_timestamp(),
       rolling_hour_requests = coalesce((
         SELECT sum(bucket.requests)::int
           FROM meta.external_image_egress_request_bucket bucket
          WHERE bucket.bucket_start >= date_trunc('minute', clock_timestamp()) - interval '59 minutes'
       ), 0),
       budget_breached = false,
       updated_at = clock_timestamp()
 WHERE singleton
   AND EXISTS (SELECT 1 FROM false_permit_recovery);

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM meta.image_ingest_job
     WHERE status = 'failed' AND failure_class = 'host_deferred'
  ) THEN
    RAISE EXCEPTION '[0064] 仍有 failed/host_deferred 未恢复';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM meta.external_image_egress_request_bucket
     WHERE bucket_start >= timestamptz '2026-08-13 07:20:00+08'
       AND bucket_start <  timestamptz '2026-08-13 08:18:00+08'
       AND failures = 0
  ) THEN
    RAISE EXCEPTION '[0064] 固定事故窗虚假 permit 未清空';
  END IF;
END
$verify$;

COMMIT;
