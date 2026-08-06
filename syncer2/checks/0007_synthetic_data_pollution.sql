-- 生产库不得残留测试合成身份。只读检查；命中即失败。
\set ON_ERROR_STOP on

DO $check$
DECLARE
  v_pages int;
  v_users int;
BEGIN
  IF to_regprocedure('meta.is_synthetic_test_page(integer,text)') IS NULL
     OR to_regprocedure('meta.is_synthetic_test_user(text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '0042 合成数据分类器/写入门尚未落地';
  END IF;

  SELECT count(*) INTO v_pages
    FROM serve.page_current pc
   WHERE meta.is_synthetic_test_page(pc.wikidot_id, pc.slug)
      OR pc.slug LIKE 'ts2test:%'
      OR pc.wikidot_id BETWEEN 2100000000 AND 2109999999;

  SELECT count(*) INTO v_users
    FROM ingest."user" u
   WHERE meta.is_synthetic_test_user(u.kind, u.anon_key, u.username, u.display_name)
      OR u.anon_key LIKE 'ts2test:%'
      OR u.wikidot_id BETWEEN 2110000000 AND 2119999999;

  IF v_pages > 0 OR v_users > 0 THEN
    RAISE EXCEPTION '生产库存在测试合成身份：pages=%, users=%', v_pages, v_users;
  END IF;

  -- 分类器不能退化成 test- 前缀删除器；这两种都是真实页面形态。
  IF meta.is_synthetic_test_page(1312422282, 'test-log-046-de-03')
     OR meta.is_synthetic_test_page(1, 'smoke-and-snow') THEN
    RAISE EXCEPTION '合成页分类器误伤真实 test-* 页面';
  END IF;
END
$check$;
