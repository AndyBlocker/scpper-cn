-- =====================================================================================
-- checks/0002_write_freeze_wiring.sql —— R10 熔断开关的接线断言(CI 用,只读)
-- =====================================================================================
-- 断言「每一个写事实/身份的函数都真的调了 meta.assert_writes_allowed」。
--
-- 为什么需要它:0007 建出了开关,0006 在各入口调用它 —— 但**新加一个 apply_\* 却忘了调**
-- 是最容易发生、也最难发现的事:熔断依然"存在",只是对新函数无效。
-- 本文件直接查 pg_proc.prosrc(函数源码)做接线检查,漏一个就红灯。
--
-- 只读。失败以非零码退出。
-- 用法: psql "$SYNCER2_DATABASE_URL" -v ON_ERROR_STOP=1 -f checks/0002_write_freeze_wiring.sql
-- =====================================================================================

\set ON_ERROR_STOP on
\timing off
\pset pager off

DO $$
DECLARE
  -- 必须接线的函数名(与 0006 第 5 节的写入型函数清单一致)。
  -- 只读/纯计算函数(precision_rank / norm_direction / resolve_thread_page / 触发器函数…)不在内。
  v_must text[] := ARRAY[
    'register_page','ensure_user','put_content_blob','put_content_blob_sha',
    'apply_page_meta','apply_page_images','apply_page_life','apply_slug_reuse_identity',
    'apply_vote_observation','apply_vote_cas_batch','apply_vote_history','apply_vote_snapshot',
    'promote_revoke_candidates','apply_revision_batch','apply_revision_source_full',
    'apply_attribution_snapshot',
    'apply_forum_batch',
    -- 0211：门禁首次全量执行抓到的四个漏网写入函数（TITLE/PROV/DEGRADE 波次新增）
    'apply_current_page_source','apply_identity_missing_deletion',
    'apply_listpages_rendered_content','apply_vote_snapshot_state_replace_v0072'
  ];
  v_bad text[];
  v_n   int;
BEGIN
  IF to_regclass('meta.write_freeze') IS NULL THEN
    RAISE EXCEPTION 'checks/0002:缺 meta.write_freeze —— 先跑 migrations/0007_meta_gaps.sql';
  END IF;
  IF to_regprocedure('meta.assert_writes_allowed(text)') IS NULL THEN
    RAISE EXCEPTION 'checks/0002:缺 meta.assert_writes_allowed(text)';
  END IF;

  -- ---- 1. 清单里的函数必须存在 --------------------------------------------------------
  SELECT array_agg(m ORDER BY m) INTO v_bad
    FROM unnest(v_must) AS t(m)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'ingest' AND p.proname = m);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[freeze-1] 清单里的写入函数不存在(改名了?):%', v_bad;
  END IF;

  -- ---- 2. 每个都必须调 assert_writes_allowed ------------------------------------------
  -- 0205 的 apply_forum_batch 是保真 wrapper；唯一第一步是调用原 core。允许这一层
  -- 明确委托，但必须同时证明被委托 core 本身仍含熔断断言，不能因 wrapper 产生假红灯。
  SELECT array_agg(p.proname ORDER BY p.proname) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ingest' AND p.proname = ANY (v_must)
     AND p.prosrc NOT LIKE '%assert_writes_allowed%'
     AND NOT (
       p.proname = 'apply_forum_batch'
       AND p.prosrc LIKE '%forum_batch_core_0205%'
       AND EXISTS (
         SELECT 1
           FROM pg_proc core
           JOIN pg_namespace core_ns ON core_ns.oid = core.pronamespace
          WHERE core_ns.nspname = 'ingest'
            AND core.proname = 'forum_batch_core_0205'
            AND core.prosrc LIKE '%assert_writes_allowed%'
       )
     );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[freeze-2] 这些写入函数没有接 R10 熔断开关(冻结对它们无效):%'
                    ' —— 在入口加 PERFORM meta.assert_writes_allowed(''<域>'')', v_bad;
  END IF;

  -- ---- 3. 反向:任何 ingest.apply_* 都必须在清单内(新增函数不许绕过本检查)----------
  SELECT array_agg(p.proname ORDER BY p.proname) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ingest' AND p.proname LIKE 'apply\_%'
     AND NOT (p.proname = ANY (v_must));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[freeze-3] 新增的 ingest.apply_* 未登记进本检查清单:%'
                    ' —— 要么接熔断开关并加进 v_must,要么在此显式说明为何豁免', v_bad;
  END IF;

  -- ---- 4. 传给 assert_writes_allowed 的域必须都在 write_freeze 词表内 ----------------
  --   (assert_writes_allowed 运行期也会拦,但那要等到真的被调用;这里提前到 CI)
  SELECT array_agg(DISTINCT format('%s → %L', p.proname, m[1]) ORDER BY format('%s → %L', p.proname, m[1]))
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL regexp_matches(p.prosrc, 'assert_writes_allowed\(''([a-z_]+)''\)', 'g') AS m
   WHERE n.nspname = 'ingest'
     AND NOT EXISTS (SELECT 1 FROM meta.write_freeze w WHERE w.domain = m[1]);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[freeze-4] 函数传了未登记的写入域(拼写错误会让熔断静默失效):%', v_bad;
  END IF;

  -- ---- 5. 词表内每个域都必须预置一行(缺行 ⇒ assert 会抛 23503 挡住正常写入)---------
  SELECT array_agg(d ORDER BY d) INTO v_bad
    FROM unnest(ARRAY['all','identity','page','vote','revision','attribution',
                      'content','forum','projection']) AS t(d)
   WHERE NOT EXISTS (SELECT 1 FROM meta.write_freeze w WHERE w.domain = d);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[freeze-5] meta.write_freeze 缺预置行:%', v_bad;
  END IF;

  -- ---- 6. 状态提示(冻结中不算失败,但必须在 CI 输出里刺眼)-------------------------
  SELECT count(*)::int INTO v_n FROM meta.write_freeze WHERE frozen;
  IF v_n > 0 THEN
    RAISE WARNING '[freeze-6] 当前有 % 个写入域处于**冻结**态:%', v_n,
      (SELECT string_agg(format('%s(%s)', domain, reason), ', ' ORDER BY domain)
         FROM meta.write_freeze WHERE frozen);
  END IF;

  RAISE NOTICE '[checks/0002] 通过:% 个写入函数全部接了 R10 熔断开关,域词表自洽,当前冻结域 %。',
    array_length(v_must, 1), v_n;
END $$;
