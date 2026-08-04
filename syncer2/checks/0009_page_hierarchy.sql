-- =====================================================================================
-- 0009_page_hierarchy.sql —— 页面层级结构只读断言
-- =====================================================================================
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_count int;
  v_cycles int;
BEGIN
  IF to_regclass('serve.page_current') IS NULL THEN
    RAISE EXCEPTION 'serve.page_current 不存在';
  END IF;

  IF to_regclass('serve.pc_parent_page') IS NULL THEN
    RAISE EXCEPTION '缺 pc_parent_page(parent_page_id,page_id) 反向索引';
  END IF;

  IF to_regprocedure('serve.page_children(integer,boolean)') IS NULL
     OR to_regprocedure('serve.page_subtree(integer,integer,boolean)') IS NULL THEN
    RAISE EXCEPTION 'page_children/page_subtree 读函数未完整落地';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'serve.page_current'::regclass
       AND conname = 'page_current_parent_page_fk'
       AND convalidated
  ) THEN
    RAISE EXCEPTION 'parent_page_id 自引用外键不存在或尚未 VALIDATE';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'serve.page_current'::regclass
       AND tgname = 'trg_page_current_parent_acyclic'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'parent 写时防环触发器不存在或被禁用';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'serve.page_current'::regclass
       AND tgname = 'trg_page_current_parent_acyclic_deferred'
       AND tgconstraint <> 0
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'parent 提交前 deferred 防环复核不存在或被禁用';
  END IF;

  SELECT count(*) INTO v_count
    FROM serve.page_current child
    LEFT JOIN serve.page_current parent ON parent.page_id = child.parent_page_id
   WHERE child.parent_page_id IS NOT NULL
     AND parent.page_id IS NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '发现 % 条物理孤儿 parent_page_id', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM serve.page_current
   WHERE parent_page_id = page_id;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '发现 % 条自引用 parent_page_id', v_count;
  END IF;

  -- 存量上游环不硬失败：迁移文档明确保留其事实；这里只证明递归读会标环并有限终止。
  WITH RECURSIVE walk AS (
    SELECT page_id AS start_id,
           page_id,
           parent_page_id,
           ARRAY[page_id]::int[] AS path,
           false AS is_cycle
      FROM serve.page_current
    UNION ALL
    SELECT walk.start_id,
           parent.page_id,
           parent.parent_page_id,
           walk.path || parent.page_id,
           parent.page_id = ANY(walk.path)
      FROM walk
      JOIN serve.page_current parent ON parent.page_id = walk.parent_page_id
     WHERE NOT walk.is_cycle
  )
  SELECT count(DISTINCT start_id) FILTER (WHERE is_cycle)
    INTO v_cycles
    FROM walk;

  IF v_cycles > 0 AND NOT EXISTS (
    SELECT 1
      FROM serve.page_current root
      CROSS JOIN LATERAL serve.page_subtree(root.page_id, 64, true) tree
     WHERE tree.is_cycle
  ) THEN
    RAISE EXCEPTION '存量关系有环，但 page_subtree 未显式返回 is_cycle';
  END IF;

  IF has_function_privilege('public', 'serve.page_children(integer,boolean)', 'EXECUTE')
     OR has_function_privilege('public', 'serve.page_subtree(integer,integer,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '层级读函数不应对 PUBLIC 开放 EXECUTE';
  END IF;

  IF to_regrole('bff_role') IS NOT NULL
     AND (
       NOT has_function_privilege('bff_role', 'serve.page_children(integer,boolean)', 'EXECUTE')
       OR NOT has_function_privilege(
         'bff_role',
         'serve.page_subtree(integer,integer,boolean)',
         'EXECUTE'
       )
     ) THEN
    RAISE EXCEPTION 'bff_role 缺层级读函数 EXECUTE';
  END IF;

  RAISE NOTICE
    'page hierarchy wiring ok: edges=%, cycle_reachable_pages=%, unresolved_parent_fullnames=%',
    (SELECT count(*) FROM serve.page_current WHERE parent_page_id IS NOT NULL),
    v_cycles,
    (
      SELECT count(*)
        FROM ingest.page_attr_history
       WHERE attr = 'parent'
         AND valid_to IS NULL
         AND jsonb_typeof(value) = 'object'
         AND NULLIF(value ->> 'page_id', '') IS NULL
    );
END $$;
