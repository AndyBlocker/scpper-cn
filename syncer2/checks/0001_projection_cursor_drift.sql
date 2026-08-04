-- =====================================================================================
-- checks/0001_projection_cursor_drift.sql —— 投影登记漂移断言(CI 用,只读)
-- =====================================================================================
-- 断言 meta.projection_cursor 与 serve.* 的 COMMENT ON TABLE 没有漂移。
--
-- 为什么需要一条独立的 CI 断言:0007 §3 用注释生成登记清单,应用那一刻是逐字一致的;
-- 但**之后**任何一次「改了 0002 的 COMMENT 却没重跑 0007」就会让两者分叉,而分叉的后果
-- 不是报错,是 projector 拿着一份过期的重建契约继续跑 —— 典型的静默失败。
-- 本文件把这件事变成 CI 的红灯。
--
-- 只读:不写任何表,可对生产库直接执行。失败以非零码退出(RAISE EXCEPTION)。
--
-- 用法:
--   psql "$SYNCER2_DATABASE_URL" -v ON_ERROR_STOP=1 -f checks/0001_projection_cursor_drift.sql
--   或   ./checks/run_checks.sh --database-url <url>
-- =====================================================================================

\set ON_ERROR_STOP on
\timing off
\pset pager off

DO $$
DECLARE
  v_tier1 text[] := ARRAY['vote_current','attribution_current','page_current'];
  v_bad   text[];
  v_n     int;
  v_reg   int;
BEGIN
  IF to_regclass('meta.projection_cursor') IS NULL OR to_regclass('serve.page_current') IS NULL THEN
    RAISE EXCEPTION 'checks/0001:缺 meta.projection_cursor 或 serve.* —— 先跑 apply.sh';
  END IF;

  -- ---- 1. 注释格式:每张 Tier-2 表都必须声明 rebuild_from ----------------------------
  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'serve' AND c.relkind = 'r'
     AND NOT (c.relname = ANY (v_tier1))
     AND COALESCE(obj_description(c.oid, 'pg_class'), '') NOT LIKE 'rebuild_from=%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[drift-1] serve.* 表的 COMMENT 不以 rebuild_from= 开头:%', v_bad;
  END IF;

  -- ---- 2. 覆盖:每张 Tier-2 表都必须在 projection_cursor 里有一行 --------------------
  SELECT array_agg('serve.' || c.relname ORDER BY c.relname) INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'serve' AND c.relkind = 'r'
     AND NOT (c.relname = ANY (v_tier1))
     AND NOT EXISTS (SELECT 1 FROM meta.projection_cursor pc
                      WHERE pc.projection = 'serve.' || c.relname);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[drift-2] Tier-2 投影未登记(projection_window() 会对它抛 23503):%'
                    ' —— 重跑 migrations/0007_meta_gaps.sql', v_bad;
  END IF;

  -- ---- 3. 反向覆盖:登记项必须指向存在的、非 Tier-1 的 serve 表 ----------------------
  --   (只检查 'serve.%' 前缀的登记项;冒烟测试用的 'smoke.%' 之类不在管辖范围)
  SELECT array_agg(pc.projection ORDER BY pc.projection) INTO v_bad
    FROM meta.projection_cursor pc
   WHERE pc.projection LIKE 'serve.%'
     AND (to_regclass(pc.projection) IS NULL
          OR substring(pc.projection FROM 7) = ANY (v_tier1));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[drift-3] 登记项指向不存在的表、或指向 Tier-1(Tier-1 无游标语义):%', v_bad;
  END IF;

  -- ---- 4. 逐字一致:rebuild_from === COMMENT ON TABLE 整条(含 'rebuild_from=' 前缀)----
  --   存储口径见 migrations/0007 §3 的长注释(与 0008_serve_embedding.sql 对齐)。
  SELECT array_agg(format('%s(注释=%L / 登记=%L)', pc.projection,
                          obj_description(c.oid,'pg_class'),
                          pc.rebuild_from)
                   ORDER BY pc.projection)
    INTO v_bad
    FROM meta.projection_cursor pc
    JOIN pg_class c ON c.oid = to_regclass(pc.projection)
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'serve'
   WHERE pc.projection LIKE 'serve.%'
     AND pc.rebuild_from IS DISTINCT FROM obj_description(c.oid,'pg_class');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[drift-4] rebuild_from 与 COMMENT ON TABLE 不逐字一致:%'
                    ' —— 改了注释就要重跑 migrations/0007_meta_gaps.sql', v_bad;
  END IF;

  -- ---- 5. 游标不得超过安全水位(登记表本身的自洽性)---------------------------------
  SELECT array_agg(pc.projection ORDER BY pc.projection) INTO v_bad
    FROM meta.projection_cursor pc
   WHERE pc.last_seq > COALESCE(pg_sequence_last_value('ingest.fact_seq'::regclass), 0);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[drift-5] 投影游标超过 ingest.fact_seq 当前值(不可能状态,疑似手工改过):%', v_bad;
  END IF;

  -- ---- 6. event_domain='none' 的投影游标应恒为 0 -------------------------------------
  SELECT array_agg(pc.projection ORDER BY pc.projection) INTO v_bad
    FROM meta.projection_cursor pc
   WHERE pc.event_domain = 'none' AND pc.last_seq <> 0;
  IF v_bad IS NOT NULL THEN
    RAISE WARNING '[drift-6] event_domain=''none'' 的投影游标却被推进过(不致命,但说明'
                  'projector 把非 seq 驱动的表当成 seq 驱动在跑):%', v_bad;
  END IF;

  SELECT count(*)::int INTO v_n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'serve' AND c.relkind = 'r' AND NOT (c.relname = ANY (v_tier1));
  SELECT count(*)::int INTO v_reg FROM meta.projection_cursor WHERE projection LIKE 'serve.%';

  RAISE NOTICE '[checks/0001] 通过:Tier-2 表 % 张,登记 % 行,rebuild_from 逐字一致,游标自洽。',
    v_n, v_reg;
END $$;
