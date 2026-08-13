-- =====================================================================================
-- 0066_image_asset_unavailable_terminal.sql
--
-- 0055 从 v1 导入的 asset 可能只有 URL/SHA 元数据，但共享目录中原文件已不存在。
-- 这些行没有 page_image 引用，也不是 image_ingest_job；留在 failed 会被 pending
-- 视图永久报警，而 worker 又不可能认领它们。增加 unavailable 语义终态保留
-- URL/SHA 审计证据；未来普通图片 job 若重新下载到同一 SHA，现有 UPSERT 仍会恢复 ready。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0066] 拒绝在受保护库 % 上修改图片资产终态', current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

ALTER TABLE serve.image_asset DROP CONSTRAINT IF EXISTS image_asset_status_check;
ALTER TABLE serve.image_asset
  ADD CONSTRAINT image_asset_status_check CHECK (
    status = ANY (ARRAY['pending','fetching','ready','failed','unavailable']::text[])
  );

UPDATE serve.image_asset asset
   SET status = 'unavailable',
       error_message = concat_ws(
         '; ', asset.error_message,
         'terminal:no_page_reference;preserve_v1_url_sha_evidence'
       ),
       updated_at = now()
 WHERE asset.status = 'failed'
   AND asset.error_message LIKE 'v1_import:file_missing:%'
   AND NOT EXISTS (
     SELECT 1 FROM serve.page_image image WHERE image.asset_sha = asset.hash_sha256
   );

COMMENT ON COLUMN serve.image_asset.status IS
  'ready=内容可用；failed=仍属待处理失败；unavailable=v1 导入文件缺失且无页面引用的终态证据。';

COMMIT;
