-- 图片管线结构/接线只读断言。
\set ON_ERROR_STOP on
\timing off
\pset pager off

DO $$
DECLARE
  v_src text;
BEGIN
  IF to_regprocedure('ingest.apply_page_images(integer,jsonb,timestamp with time zone,boolean)') IS NULL THEN
    RAISE EXCEPTION '[image-1] 缺 ingest.apply_page_images';
  END IF;
  SELECT p.prosrc INTO v_src
    FROM pg_proc p
   WHERE p.oid =
     'ingest.apply_page_images(integer,jsonb,timestamp with time zone,boolean)'::regprocedure;
  IF v_src NOT LIKE '%assert_writes_allowed(''content'')%' THEN
    RAISE EXCEPTION '[image-2] apply_page_images 未接 content 写冻结';
  END IF;
  IF has_function_privilege(
       'public',
       'ingest.apply_page_images(integer,jsonb,timestamp with time zone,boolean)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION '[image-3] SECURITY DEFINER apply_page_images 仍对 PUBLIC 开放';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'serve.image_asset'::regclass
       AND contype = 'p'
       AND conkey = ARRAY[
         (SELECT attnum::smallint FROM pg_attribute
           WHERE attrelid = 'serve.image_asset'::regclass AND attname = 'hash_sha256')
       ]::smallint[]
  ) THEN
    RAISE EXCEPTION '[image-4] image_asset 不是以 hash_sha256 为主键，内容去重失效';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'meta.image_ingest_job'::regclass
       AND conname = 'image_ingest_job_page_image_fk'
       AND contype = 'f'
       AND convalidated
  ) THEN
    RAISE EXCEPTION '[image-5] job→page_image 自然键外键缺失或未验证';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM meta.image_ingest_job job
      LEFT JOIN serve.page_image image
        USING (page_id, normalized_url)
     WHERE image.page_id IS NULL
  ) THEN
    RAISE EXCEPTION '[image-6] image_ingest_job 存在孤儿任务';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM serve.page_image image
      LEFT JOIN meta.image_ingest_job job
        USING (page_id, normalized_url)
     WHERE image.asset_sha IS NULL
       AND image.status IN ('pending','queued')
       AND job.page_id IS NULL
  ) THEN
    RAISE EXCEPTION '[image-7] 未解析 page_image 没有下载任务';
  END IF;
  RAISE NOTICE '[checks/0004] 图片引用/队列/内容哈希去重接线通过。';
END $$;
