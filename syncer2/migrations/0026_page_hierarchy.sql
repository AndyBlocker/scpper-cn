-- =====================================================================================
-- 0026_page_hierarchy.sql —— 页面父子关系：反向索引、安全递归读取与写时防环
-- =====================================================================================
--
-- 选择邻接表而不是 closure/materialized path：
--   2026-07-29 修复后只有 8,975 条边、最大无环深度 7；`parent_page_id` 的反向索引已经
--   足够让直接子页与递归 CTE 都走小范围 index scan。物化闭包会让一次 reparent 重写
--   整棵子树，收益不足以抵消写放大与失效维护。
--
-- 已知存量：
--   component:classified-decoration ↔ component:classified-decoration-base 是 Wikidot
--   `%%parent_fullname%%` 直给的双节点环。迁移不擅自裁决哪条上游关系该删；读函数会显式
--   返回 is_cycle=true 并停止递归，触发器只阻止今后新建/扩大环，改成 NULL/安全父页仍可破环。
--
-- 删除语义：
--   v2 删除页面只把 serve.page_current.status 翻为 deleted，不删除该行。因此子页继续指向
--   已删父页，既保留最后已知结构，也满足本表的自引用外键。
-- =====================================================================================

BEGIN;

DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn') THEN
    RAISE EXCEPTION
      'refusing to apply page hierarchy migration to v1 production database % (read-only by policy)',
      current_database();
  END IF;
  IF to_regclass('serve.page_current') IS NULL
     OR to_regclass('ingest.page_attr_history') IS NULL
     OR to_regclass('ingest.page_slug_history') IS NULL THEN
    RAISE EXCEPTION
      '0026_page_hierarchy.sql requires serve.page_current and ingest page history tables';
  END IF;
END $$;

-- 直接子页：WHERE parent_page_id=$1；递归每一层也是同一个访问形状。
CREATE INDEX IF NOT EXISTS pc_parent_page
  ON serve.page_current(parent_page_id, page_id)
  WHERE parent_page_id IS NOT NULL;

-- parent 必须是已经注册、且有 page_current tombstone/current row 的页面。
-- ON DELETE RESTRICT 是刻意的：父页删除必须走 status='deleted'，不能物理删除后留下悬空边。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'serve.page_current'::regclass
       AND conname = 'page_current_parent_page_fk'
  ) THEN
    ALTER TABLE serve.page_current
      ADD CONSTRAINT page_current_parent_page_fk
      FOREIGN KEY (parent_page_id)
      REFERENCES serve.page_current(page_id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;

ALTER TABLE serve.page_current
  VALIDATE CONSTRAINT page_current_parent_page_fk;

COMMENT ON CONSTRAINT page_current_parent_page_fk ON serve.page_current IS
  '父页必须保留在 page_current；页面删除只翻 status=tombstone，不清空子页 parent_page_id。';

-- -------------------------------------------------------------------------------------
-- 写时防环
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION serve.guard_page_parent_acyclic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_cycle_path int[];
  v_current_parent int;
BEGIN
  -- 同一页在一个事务里多次 reparent 时，deferred 队列中的旧事件不应拿中间态误报；
  -- 只复核该事件仍代表的最终 parent 值。并发互指的最终事件仍会正常复核。
  IF TG_WHEN = 'AFTER' THEN
    SELECT parent_page_id
      INTO v_current_parent
      FROM serve.page_current
     WHERE page_id = NEW.page_id;
    IF NOT FOUND OR v_current_parent IS DISTINCT FROM NEW.parent_page_id THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.parent_page_id IS NULL
     OR NEW.parent_page_id IS NOT DISTINCT FROM OLD.parent_page_id THEN
    RETURN NEW;
  END IF;

  -- 迁移/测试逃生舱与其它不可变触发器一致。正常 apply_page_meta 永远走下面的校验。
  IF serve.write_bypass_enabled() THEN
    RETURN NEW;
  END IF;

  -- 两个并发事务若分别做 A→B / B→A，各自只拿 page 粒度锁时可能都看不到对方。
  -- 全局 hierarchy advisory lock 把 parent 边变化串行化；普通 title/tags 更新不取此锁。
  PERFORM pg_advisory_xact_lock(815412004::bigint);

  IF NEW.parent_page_id = NEW.page_id THEN
    RAISE EXCEPTION 'page % cannot be its own parent', NEW.page_id
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM serve.page_current WHERE page_id = NEW.parent_page_id
  ) THEN
    RAISE EXCEPTION 'parent page % does not exist in serve.page_current', NEW.parent_page_id
      USING ERRCODE = '23503';
  END IF;

  -- 从拟议父页一路向上找祖先；path 内重复即命中存量环，命中 NEW.page_id 即新建环。
  WITH RECURSIVE ancestors AS (
    SELECT p.page_id,
           p.parent_page_id,
           ARRAY[NEW.page_id, p.page_id]::int[] AS path,
           p.page_id = NEW.page_id AS is_cycle
      FROM serve.page_current p
     WHERE p.page_id = NEW.parent_page_id
    UNION ALL
    SELECT p.page_id,
           p.parent_page_id,
           a.path || p.page_id,
           p.page_id = ANY(a.path)
      FROM ancestors a
      JOIN serve.page_current p ON p.page_id = a.parent_page_id
     WHERE NOT a.is_cycle
  )
  SELECT path
    INTO v_cycle_path
    FROM ancestors
   WHERE is_cycle
   LIMIT 1;

  IF v_cycle_path IS NOT NULL THEN
    RAISE EXCEPTION 'parent change would create or enter a cycle: %', v_cycle_path
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION serve.guard_page_parent_acyclic() IS
  'parent_page_id 变化的写时守卫：串行化边变化，拒绝自引用、悬空父页和任意长度环。';

DROP TRIGGER IF EXISTS trg_page_current_parent_acyclic ON serve.page_current;
CREATE TRIGGER trg_page_current_parent_acyclic
  BEFORE INSERT OR UPDATE OF parent_page_id ON serve.page_current
  FOR EACH ROW
  EXECUTE FUNCTION serve.guard_page_parent_acyclic();

-- BEFORE 给单事务即时反馈；deferred 复核堵住 READ COMMITTED 下的并发写偏差：
-- 后开始等待 hierarchy lock 的事务即使外层 UPDATE 已拿旧 statement snapshot，提交前也会
-- 在新命令快照下再次看到先提交者的边。
DROP TRIGGER IF EXISTS trg_page_current_parent_acyclic_deferred ON serve.page_current;
CREATE CONSTRAINT TRIGGER trg_page_current_parent_acyclic_deferred
  AFTER INSERT OR UPDATE ON serve.page_current
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION serve.guard_page_parent_acyclic();

-- -------------------------------------------------------------------------------------
-- serve 读能力
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION serve.page_children(
  p_parent_page_id int,
  p_include_deleted boolean DEFAULT true
)
RETURNS SETOF serve.page_current
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT child.*
    FROM serve.page_current child
   WHERE child.parent_page_id = p_parent_page_id
     AND (p_include_deleted OR child.status = 'live')
   ORDER BY child.page_id
$$;

COMMENT ON FUNCTION serve.page_children(int, boolean) IS
  '列出直接子页；默认包含 deleted tombstone。由 pc_parent_page(parent_page_id,page_id) 支撑。';

CREATE OR REPLACE FUNCTION serve.page_subtree(
  p_root_page_id int,
  p_max_depth int DEFAULT 64,
  p_include_deleted boolean DEFAULT true
)
RETURNS TABLE (
  page_id int,
  parent_page_id int,
  depth int,
  path int[],
  is_cycle boolean,
  depth_limited boolean
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_max_depth < 0 OR p_max_depth > 1000 THEN
    RAISE EXCEPTION 'p_max_depth must be between 0 and 1000, got %', p_max_depth
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH RECURSIVE subtree AS (
    SELECT root.page_id,
           root.parent_page_id,
           0 AS depth,
           ARRAY[root.page_id]::int[] AS path,
           false AS is_cycle
      FROM serve.page_current root
     WHERE root.page_id = p_root_page_id
    UNION ALL
    SELECT child.page_id,
           child.parent_page_id,
           tree.depth + 1,
           tree.path || child.page_id,
           child.page_id = ANY(tree.path)
      FROM subtree tree
      JOIN serve.page_current child ON child.parent_page_id = tree.page_id
     WHERE NOT tree.is_cycle
       AND tree.depth < p_max_depth
  )
  SELECT tree.page_id,
         tree.parent_page_id,
         tree.depth,
         tree.path,
         tree.is_cycle,
         (
           NOT tree.is_cycle
           AND tree.depth = p_max_depth
           AND EXISTS (
             SELECT 1
               FROM serve.page_current child
              WHERE child.parent_page_id = tree.page_id
           )
         ) AS depth_limited
    FROM subtree tree
    JOIN serve.page_current current_page ON current_page.page_id = tree.page_id
   WHERE p_include_deleted OR current_page.status = 'live' OR tree.is_cycle
   ORDER BY tree.path;
END;
$$;

COMMENT ON FUNCTION serve.page_subtree(int, int, boolean) IS
  '返回 root(depth=0)+整棵子树。path 防环；重复节点只返回一次 is_cycle=true 后停止。'
  'p_max_depth 是额外保险，depth_limited=true 表示该节点仍有未展开子页。'
  'include_deleted=false 只过滤输出，不截断穿过 deleted 父页抵达 live 后代的遍历。';

-- -------------------------------------------------------------------------------------
-- 修复历史解析器的两个可证明缺口
-- -------------------------------------------------------------------------------------
-- 初始 backfill 的通用 slug resolver 遇到 live + deleted 同名页时没有唯一排序，曾把
-- 61 条边随机挂到 21 个 deleted tombstone（同一个 scp-835 甚至同时分到新旧 ID）。
-- 对切换日前 source='observed' 的初始证据，只要 fullname 当前恰有一个 live 候选，就用
-- 正常 apply_page_meta 路径改正；后续重复执行不会再次命中。日常 Tier1 对已建立且
-- fullname 未变的关系会保留旧 ID，因此真正发生“父页删除”时仍保留 tombstone 指针。
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    WITH one_live AS (
      SELECT slug,
             min(page_id) FILTER (WHERE status = 'live') AS parent_page_id
        FROM serve.page_current
       GROUP BY slug
      HAVING count(*) FILTER (WHERE status = 'live') = 1
    )
    SELECT child.page_id,
           child.wikidot_id,
           attr.value ->> 'slug' AS parent_slug,
           live.parent_page_id
      FROM ingest.page_attr_history attr
      JOIN serve.page_current child ON child.page_id = attr.page_id
      JOIN serve.page_current old_parent
        ON old_parent.page_id = NULLIF(attr.value ->> 'page_id', '')::int
      JOIN one_live live ON live.slug = attr.value ->> 'slug'
     WHERE attr.attr = 'parent'
       AND attr.valid_to IS NULL
       AND attr.source = 'observed'
       AND attr.valid_from < TIMESTAMPTZ '2026-07-29 00:00:00+08'
       AND jsonb_typeof(attr.value) = 'object'
       AND old_parent.status = 'deleted'
       AND live.parent_page_id <> old_parent.page_id
  LOOP
    PERFORM ingest.apply_page_meta(
      p_page       => r.page_id,
      p_attrs      => jsonb_build_object(
                        'parent',
                        jsonb_build_object('page_id', r.parent_page_id, 'slug', r.parent_slug)
                      ),
      p_observed   => clock_timestamp(),
      p_source     => 'wikidot_parent_live_slug_repair',
      p_run        => NULL,
      p_wikidot_id => r.wikidot_id
    );
  END LOOP;
END $$;

-- 只接受 page_slug_history 中始终属于同一个 page_id 的 slug；被删除重建复用过的歧义 slug
-- 不猜。apply_page_meta 会正常关闭 unresolved 的 parent SCD2 区间、开启 resolved 区间并同步
-- page_current，因此不是偷偷 UPDATE 历史证据。
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    WITH unique_historical_slug AS (
      SELECT h.slug, min(h.page_id) AS parent_page_id
        FROM ingest.page_slug_history h
        JOIN serve.page_current parent ON parent.page_id = h.page_id
       GROUP BY h.slug
      HAVING count(DISTINCT h.page_id) = 1
    )
    SELECT child.page_id,
           child.wikidot_id,
           attr.value ->> 'slug' AS parent_slug,
           historical.parent_page_id
      FROM ingest.page_attr_history attr
      JOIN serve.page_current child ON child.page_id = attr.page_id
      JOIN unique_historical_slug historical ON historical.slug = attr.value ->> 'slug'
     WHERE attr.attr = 'parent'
       AND attr.valid_to IS NULL
       AND jsonb_typeof(attr.value) = 'object'
       AND NULLIF(attr.value ->> 'page_id', '') IS NULL
  LOOP
    PERFORM ingest.apply_page_meta(
      p_page       => r.page_id,
      p_attrs      => jsonb_build_object(
                        'parent',
                        jsonb_build_object('page_id', r.parent_page_id, 'slug', r.parent_slug)
                      ),
      p_observed   => clock_timestamp(),
      p_source     => 'wikidot_parent_history_repair',
      p_run        => NULL,
      p_wikidot_id => r.wikidot_id
    );
  END LOOP;
END $$;

-- 函数默认权限按“PUBLIC 无权、serve 读角色显式授权”收口；迁移单独执行也不能漏权限。
REVOKE ALL ON FUNCTION serve.guard_page_parent_acyclic() FROM PUBLIC;
REVOKE ALL ON FUNCTION serve.page_children(int, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION serve.page_subtree(int, int, boolean) FROM PUBLIC;

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['bff_role', 'ingestor_role', 'projector_role', 'migration_role']
  LOOP
    CONTINUE WHEN to_regrole(role_name) IS NULL;
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION serve.page_children(int, boolean) TO %I',
      role_name
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION serve.page_subtree(int, int, boolean) TO %I',
      role_name
    );
  END LOOP;
END $$;

COMMIT;
