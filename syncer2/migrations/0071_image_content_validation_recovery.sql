-- =====================================================================================
-- 0071_image_content_validation_recovery.sql
--
-- 图片响应头只是代理信号。旧 worker 在读取字节后仍仅凭 Content-Type 终态拒绝，导致
-- Wikimedia 文件描述页与 wdfiles 的真实图片被大批误归为 invalid_content_type。
-- 本迁移先扩展稳定失败词表，再把已知误拒集合恢复为 pending；随后部署的 worker 才会
-- 用 magic bytes 判定并对 Wikimedia 描述页解析 og:image。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0071] 拒绝在受保护库 % 上修改图片失败分类', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.image_ingest_job') IS NULL
     OR to_regclass('serve.page_image') IS NULL THEN
    RAISE EXCEPTION '[0071] 缺少图片采集前置对象'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

ALTER TABLE meta.image_ingest_job
  DROP CONSTRAINT IF EXISTS image_ingest_job_failure_class_ck;

ALTER TABLE meta.image_ingest_job
  ADD CONSTRAINT image_ingest_job_failure_class_ck
  CHECK (
    failure_class IS NULL
    OR failure_class = ANY (ARRAY[
      'http_transient', 'http_permanent', 'timeout', 'network',
      'too_large', 'invalid_content_type', 'invalid_image_content',
      'description_page_unresolved', 'invalid_url', 'blocked_host',
      'storage', 'unknown', 'host_unresolvable', 'host_deferred'
    ])
  );

COMMENT ON COLUMN meta.image_ingest_job.failure_class IS
  '稳定失败分类；invalid_image_content 由字节签名判定，description_page_unresolved '
  '表示已识别的文件描述页没有安全、可下载的真实图片 URL；响应头不再单独决定失败。';

CREATE TEMP TABLE image_content_recovery_urls ON COMMIT DROP AS
SELECT page_id, normalized_url
  FROM meta.image_ingest_job
 WHERE failure_class = 'invalid_content_type'
   AND locked_by IS NULL
   AND split_part(normalized_url, '/', 3) IN (
     'commons.wikimedia.org',
     'en.wikipedia.org',
     'scp-wiki-cn.wdfiles.com',
     'scp-wiki.wdfiles.com',
     'scpsandboxcn.wdfiles.com',
     'scp-jp.wdfiles.com'
   );

UPDATE meta.image_ingest_job job
   SET status = 'pending',
       attempts = 0,
       not_before = now(),
       failure_class = NULL,
       http_status = NULL,
       error = NULL,
       locked_by = NULL,
       locked_at = NULL,
       updated_at = now()
  FROM image_content_recovery_urls recovered
 WHERE job.page_id = recovered.page_id
   AND job.normalized_url = recovered.normalized_url;

UPDATE serve.page_image image
   SET status = 'queued',
       last_error = NULL,
       metadata = COALESCE(image.metadata, '{}'::jsonb) || jsonb_build_object(
         'content_validation_recovered', true,
         'content_validation_recovered_at', clock_timestamp(),
         'content_validation_recovery_migration', '0071'
       )
  FROM image_content_recovery_urls recovered
 WHERE image.page_id = recovered.page_id
   AND image.normalized_url = recovered.normalized_url
   AND image.asset_sha IS NULL;

COMMIT;
