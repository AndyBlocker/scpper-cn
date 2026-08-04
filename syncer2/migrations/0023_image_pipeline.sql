-- =====================================================================================
-- 0023_image_pipeline.sql
-- 正文图片管线：page_image 当前引用集 + image_ingest_job 待下载队列。
--
-- 本迁移不下载图片，也不按 URL 创建 image_asset。image_asset 的主键是下载字节的 sha256；
-- worker 只有在拿到内容后才能 INSERT/复用资产，因此 URL 引用阶段的 asset_sha 必须为 NULL。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0023] 拒绝在受保护库 % 上修改图片管线；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('serve.page_image') IS NULL
     OR to_regclass('serve.image_asset') IS NULL
     OR to_regclass('meta.image_ingest_job') IS NULL THEN
    RAISE EXCEPTION '[0023] 图片三表不完整，请先执行 0002_serve.sql 与 0003_meta.sql';
  END IF;
END
$guard$;

BEGIN;

-- 队列与引用使用同一自然键。v1 的 ImageIngestJob 通过 pageVersionImageId 外键关联；
-- v2 没有 PageVersion 行，等价关系就是 (page_id, normalized_url)，并在删掉过期引用时级联清队。
DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'meta.image_ingest_job'::regclass
       AND conname = 'image_ingest_job_page_image_fk'
  ) THEN
    ALTER TABLE meta.image_ingest_job
      ADD CONSTRAINT image_ingest_job_page_image_fk
      FOREIGN KEY (page_id, normalized_url)
      REFERENCES serve.page_image(page_id, normalized_url)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$constraint$;
ALTER TABLE meta.image_ingest_job
  VALIDATE CONSTRAINT image_ingest_job_page_image_fk;

CREATE OR REPLACE FUNCTION ingest.apply_page_images(
  p_page      int,
  p_images    jsonb,
  p_observed  timestamptz DEFAULT now(),
  p_replace   boolean     DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_input_count int;
  v_removed     int := 0;
  v_queued      int := 0;
BEGIN
  IF p_page IS NULL OR NOT EXISTS (SELECT 1 FROM ingest.page p WHERE p.id = p_page) THEN
    RAISE EXCEPTION 'apply_page_images: 未知 page_id=%', p_page USING ERRCODE = '23503';
  END IF;
  IF p_images IS NULL OR jsonb_typeof(p_images) <> 'array' THEN
    RAISE EXCEPTION 'apply_page_images: p_images 必须是 jsonb array' USING ERRCODE = '22023';
  END IF;

  v_input_count := jsonb_array_length(p_images);
  IF v_input_count > 2000 THEN
    RAISE EXCEPTION
      'apply_page_images: 单页候选 % 超过 2000，疑似把导航/源码示例当成正文图片',
      v_input_count
      USING ERRCODE = '54000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_images) AS x(
        normalized_url text,
        origin_url     text,
        display_url    text,
        metadata       jsonb
      )
     WHERE x.normalized_url IS NULL
        OR btrim(x.normalized_url) = ''
        OR x.normalized_url <> lower(x.normalized_url)
        OR x.normalized_url !~ '^https://'
        OR x.normalized_url ~ '[?#]'
        OR x.origin_url IS NULL
        OR btrim(x.origin_url) = ''
        OR x.display_url IS NULL
        OR x.display_url !~ '^https://'
        OR (x.metadata IS NOT NULL AND jsonb_typeof(x.metadata) <> 'object')
  ) THEN
    RAISE EXCEPTION
      'apply_page_images: 候选必须含规范小写 HTTPS normalized_url（无 query/fragment）、'
      '非空 origin_url 与 HTTPS display_url'
      USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT count(*) <> count(DISTINCT x.normalized_url)
      FROM jsonb_to_recordset(p_images) AS x(normalized_url text)
  ) THEN
    RAISE EXCEPTION 'apply_page_images: normalized_url 重复，采集层必须先去重'
      USING ERRCODE = '23505';
  END IF;

  -- 与其它页级 apply_* 共用 advisory lock，保证同一页两个 content worker 不会交叉删引用。
  PERFORM meta.assert_writes_allowed('content');
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  INSERT INTO serve.page_image(
    page_id, normalized_url, origin_url, display_url, status, asset_sha,
    extracted_at, last_queued_at, failure_count, last_error, metadata
  )
  SELECT p_page,
         x.normalized_url,
         x.origin_url,
         x.display_url,
         'pending',
         NULL,
         p_observed,
         p_observed,
         0,
         NULL,
         COALESCE(x.metadata, '{}'::jsonb)
    FROM jsonb_to_recordset(p_images) AS x(
      normalized_url text,
      origin_url     text,
      display_url    text,
      metadata       jsonb
    )
  ON CONFLICT (page_id, normalized_url) DO UPDATE
    SET origin_url = EXCLUDED.origin_url,
        display_url = EXCLUDED.display_url,
        status = CASE
          WHEN serve.page_image.asset_sha IS NOT NULL THEN 'resolved'
          WHEN serve.page_image.status = 'fetching' THEN 'fetching'
          ELSE 'pending'
        END,
        extracted_at = EXCLUDED.extracted_at,
        last_queued_at = CASE
          WHEN serve.page_image.asset_sha IS NULL
            THEN EXCLUDED.last_queued_at
          ELSE serve.page_image.last_queued_at
        END,
        failure_count = CASE
          WHEN serve.page_image.asset_sha IS NULL
               AND serve.page_image.status = 'failed'
            THEN 0
          ELSE serve.page_image.failure_count
        END,
        last_error = CASE
          WHEN serve.page_image.asset_sha IS NULL
               AND serve.page_image.status <> 'fetching'
            THEN NULL
          ELSE serve.page_image.last_error
        END,
        metadata = COALESCE(serve.page_image.metadata, '{}'::jsonb)
                   || COALESCE(EXCLUDED.metadata, '{}'::jsonb);

  -- 只给尚未解析到内容资产的引用建任务。已 resolved 的 URL 即使再次出现在正文也不重下；
  -- 多个 URL 下载出相同字节时，worker 以 image_asset(hash_sha256 PK) 复用同一行。
  INSERT INTO meta.image_ingest_job(
    page_id, normalized_url, status, attempts, locked_by, locked_at,
    error, created_at, updated_at
  )
  SELECT pi.page_id, pi.normalized_url, 'pending', 0, NULL, NULL,
         NULL, p_observed, p_observed
    FROM serve.page_image pi
    JOIN jsonb_to_recordset(p_images) AS x(normalized_url text)
      ON x.normalized_url = pi.normalized_url
   WHERE pi.page_id = p_page
     AND pi.asset_sha IS NULL
  ON CONFLICT (page_id, normalized_url) DO UPDATE
    SET status = CASE
          WHEN meta.image_ingest_job.status = 'processing' THEN 'processing'
          ELSE 'pending'
        END,
        attempts = CASE
          WHEN meta.image_ingest_job.status = 'failed' THEN 0
          ELSE meta.image_ingest_job.attempts
        END,
        locked_by = CASE
          WHEN meta.image_ingest_job.status = 'processing'
            THEN meta.image_ingest_job.locked_by
          ELSE NULL
        END,
        locked_at = CASE
          WHEN meta.image_ingest_job.status = 'processing'
            THEN meta.image_ingest_job.locked_at
          ELSE NULL
        END,
        error = CASE
          WHEN meta.image_ingest_job.status = 'processing'
            THEN meta.image_ingest_job.error
          ELSE NULL
        END,
        updated_at = EXCLUDED.updated_at;
  GET DIAGNOSTICS v_queued = ROW_COUNT;

  IF p_replace THEN
    -- page_image 是当前引用投影，不是历史事实。过期引用可删；其资产按内容寻址保留，
    -- 以后任何页面再次出现相同字节都可复用。FK 会级联删除尚存的对应 job。
    DELETE FROM serve.page_image pi
     WHERE pi.page_id = p_page
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_to_recordset(p_images) AS x(normalized_url text)
          WHERE x.normalized_url = pi.normalized_url
       );
    GET DIAGNOSTICS v_removed = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'page_id', p_page,
    'references', v_input_count,
    'jobs_upserted', v_queued,
    'removed', v_removed,
    'replace', p_replace
  );
END;
$function$;

COMMENT ON FUNCTION ingest.apply_page_images(int, jsonb, timestamptz, boolean) IS
  '同步页面正文图片当前引用并填 meta.image_ingest_job。只写 URL 引用/待下载任务；'
  'asset_sha 保持 NULL，worker 下载后按字节 sha256 去重写 serve.image_asset。'
  'p_replace=true 表示 HTML+source 完整集合；source-only 冷回填必须传 false。';

REVOKE ALL ON FUNCTION ingest.apply_page_images(int, jsonb, timestamptz, boolean) FROM PUBLIC;

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION ingest.apply_page_images(int, jsonb, timestamptz, boolean)
      TO ingestor_role;
  END IF;
  IF to_regrole('migration_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION ingest.apply_page_images(int, jsonb, timestamptz, boolean)
      TO migration_role;
  END IF;
END
$grants$;

COMMENT ON CONSTRAINT image_ingest_job_page_image_fk ON meta.image_ingest_job IS
  'v2 等价于 v1 ImageIngestJob.pageVersionImageId 外键；自然键关联，引用删除时任务级联删除。';

COMMIT;
