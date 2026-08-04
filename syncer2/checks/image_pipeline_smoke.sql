-- 图片引用/队列/资产内容去重写路径烟测；末尾 ROLLBACK，不留数据。
\set ON_ERROR_STOP on
\timing off
\pset pager off

BEGIN;
SET LOCAL scpper.freeze_bypass = 'on';

DO $$
DECLARE
  v_page int;
  v_hash bytea := decode(repeat('ab', 32), 'hex');
  v_result jsonb;
BEGIN
  SELECT page_id INTO v_page FROM serve.page_current ORDER BY page_id LIMIT 1;
  IF v_page IS NULL THEN
    RAISE NOTICE '[image-smoke] 空库：无页面可测，跳过写路径';
    RETURN;
  END IF;

  v_result := ingest.apply_page_images(
    v_page,
    jsonb_build_array(
      jsonb_build_object(
        'normalized_url', 'https://smoke.invalid/a.png',
        'origin_url', 'http://SMOKE.invalid/A.PNG?x=1',
        'display_url', 'https://smoke.invalid/A.PNG?x=1',
        'metadata', '{"sources":["html_img"]}'::jsonb
      ),
      jsonb_build_object(
        'normalized_url', 'https://smoke.invalid/b.png',
        'origin_url', 'B.png',
        'display_url', 'https://smoke.invalid/B.png',
        'metadata', '{"sources":["wikidot_image"]}'::jsonb
      )
    ),
    now(),
    false
  );
  IF (v_result ->> 'references')::int <> 2
     OR (SELECT count(*) FROM serve.page_image
          WHERE page_id = v_page AND normalized_url LIKE 'https://smoke.invalid/%') <> 2
     OR (SELECT count(*) FROM meta.image_ingest_job
          WHERE page_id = v_page AND normalized_url LIKE 'https://smoke.invalid/%'
            AND status = 'pending') <> 2 THEN
    RAISE EXCEPTION '[image-smoke-1] 两条引用/任务未成对写入：%', v_result;
  END IF;

  PERFORM ingest.apply_page_images(
    v_page,
    jsonb_build_array(jsonb_build_object(
      'normalized_url', 'https://smoke.invalid/a.png',
      'origin_url', 'https://smoke.invalid/A.PNG',
      'display_url', 'https://smoke.invalid/A.PNG',
      'metadata', '{"sources":["html_img"]}'::jsonb
    )),
    now(),
    true
  );
  IF EXISTS (
    SELECT 1 FROM serve.page_image
     WHERE page_id = v_page AND normalized_url = 'https://smoke.invalid/b.png'
  ) OR EXISTS (
    SELECT 1 FROM meta.image_ingest_job
     WHERE page_id = v_page AND normalized_url = 'https://smoke.invalid/b.png'
  ) THEN
    RAISE EXCEPTION '[image-smoke-2] 完整集合替换没有级联清掉过期引用/任务';
  END IF;

  INSERT INTO serve.image_asset(hash_sha256, status, canonical_url)
  VALUES (v_hash, 'ready', 'https://smoke.invalid/A.PNG')
  ON CONFLICT (hash_sha256) DO NOTHING;
  UPDATE serve.page_image
     SET asset_sha = v_hash, status = 'resolved'
   WHERE page_id = v_page AND normalized_url = 'https://smoke.invalid/a.png';
  UPDATE meta.image_ingest_job
     SET status = 'completed'
   WHERE page_id = v_page AND normalized_url = 'https://smoke.invalid/a.png';

  -- 同 URL 再提取不得退回 pending；同一内容 hash 仍只有一个 image_asset。
  PERFORM ingest.apply_page_images(
    v_page,
    jsonb_build_array(jsonb_build_object(
      'normalized_url', 'https://smoke.invalid/a.png',
      'origin_url', 'https://smoke.invalid/A.PNG?cache=2',
      'display_url', 'https://smoke.invalid/A.PNG?cache=2',
      'metadata', '{"sources":["html_img","wikidot_image"]}'::jsonb
    )),
    now(),
    false
  );
  IF (SELECT status FROM serve.page_image
       WHERE page_id = v_page AND normalized_url = 'https://smoke.invalid/a.png') <> 'resolved'
     OR (SELECT status FROM meta.image_ingest_job
          WHERE page_id = v_page AND normalized_url = 'https://smoke.invalid/a.png') <> 'completed'
     OR (SELECT count(*) FROM serve.image_asset WHERE hash_sha256 = v_hash) <> 1 THEN
    RAISE EXCEPTION '[image-smoke-3] resolved 引用被重排队，或内容哈希去重失效';
  END IF;

  BEGIN
    PERFORM ingest.apply_page_images(
      v_page,
      '[{"normalized_url":"https://smoke.invalid/a.png?bad=1",'
      '"origin_url":"a","display_url":"https://smoke.invalid/a.png"}]'::jsonb,
      now(),
      false
    );
    RAISE EXCEPTION '[image-smoke-4] 带 query 的 normalized_url 未被拒绝';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  RAISE NOTICE '[image-smoke] 4/4 通过；事务将回滚。';
END $$;

ROLLBACK;
