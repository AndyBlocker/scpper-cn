-- =====================================================================================
-- 0012_collector_queues.sql —— 采集层两条「未消化数据」队列
--   meta.pending_page       真·新页（sitemap 见到、ingest.page 里还没有身份行）的解析队列
--   meta.forum_scan_task    thread sitemap 新 id + category 周期枚举队列
-- =====================================================================================
-- 目标库 : scpper-v2（空库，可随时重建）
-- 依据   : docs/data-model-v2-redesign-2026-07-03.md
--            §5.8「fullname 经 slug_history/wikidot_id 双通道解析到 page_id,
--                  **失败进 pending 队列而非静默跳过**」（第 738 行）
--          analysis/wikidot-vs-crom-2026-07-27/field-matrix.md
--            「只有**未知 fullname** 才发 1 次整页 GET(不用 norender),解析 pageId…
--              GET 失败(404/403/超时)时不得写入身份行,投队列 + 指数退避,
--              该 fullname 本轮不参与任何判定」
--          experiments/sitemap-probe.md §5（thread sitemap 86,900 id / category 实为 14 个）
--
-- 【编号说明】本文件刻意从 0012 起号，不是 0007。
--   本轮 6 个任务（A–F）并行改同一个 migrations/ 目录，0007–0011 预留给 A–E，
--   采集层（任务 F）占 0012。apply.sh 按 `ls [0-9]*.sql | sort` 执行，**允许编号空洞**，
--   所以留白不影响执行顺序，但能避免两个任务同时写 0007 造成的文件级冲突。
--
-- 【相对设计文档的偏离，共 2 处，理由都在下面各表的 COMMENT 与本头注里】
--   D-F1. 设计文档只在 §5.8 提了一句「失败进 pending 队列」，没有给这张队列的 DDL，
--         §4.7 的 meta 表清单里也没有它。这里补上。**不复用 meta.scan_task** 的理由是
--         结构性的：scan_task.page_id 是 NOT NULL，而 pending 的定义恰恰是「page_id
--         还不存在」——把它塞进 scan_task 只能靠伪造 page_id（例如 -1 / 0），那等于
--         在队列里放一个假身份，正是 v1「URL 猜测 + 删除重建误判」那条歧路的入口。
--   D-F2. 论坛侧同理：thread / category 的主键是 wikidot 原始 thread_id / category_id，
--         与页面无关（实测大量 thread 不挂任何页面），scan_task(page_id,kind) 的唯一键
--         对它们没有意义。故另起 meta.forum_scan_task，UNIQUE(kind,target_id)。
--         另一个不能直接写 ingest.forum_thread 的硬理由：该表 category_id / title /
--         created_at 全是 NOT NULL，而 thread sitemap **只给 id**（实测无 lastmod、
--         无标题、无分类），凑不出一行合法记录。差集只能进队列，由论坛抓取器消化。
--
-- 【幂等契约（两张表共同遵守，与 meta.scan_task 一致）】
--   发现侧的 UPSERT 只允许触碰「发现侧列」：last_seen_at / seen_count / reasons /
--   priority(取大)。**绝不覆盖执行侧状态** attempts / stable_count / not_before /
--   last_result_hash / locked_by / locked_at / status ——
--   v1 DirtyPage 的整表 deleteMany+createMany 重建冲掉退避与收敛状态，是要在结构上
--   杜绝的同型病根（synthesis §5.4）。
--
-- 可重复执行：CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS +
--   DROP CONSTRAINT IF EXISTS/ADD CONSTRAINT。幂等重跑零副作用。
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 安全闸：本文件永远不允许落到 v1 生产库（与 0001–0006 同一道闸）
-- -------------------------------------------------------------------------------------
DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn') THEN
    RAISE EXCEPTION
      'refusing to apply v2 collector queues to the v1 production database %(read-only by policy)',
      current_database();
  END IF;
END $$;

-- 前置：meta schema 必须已由 0003 建好（本文件只加表，不建 schema）
DO $$
BEGIN
  IF to_regnamespace('meta') IS NULL THEN
    RAISE EXCEPTION '0012_collector_queues.sql 需要先执行 0003_meta.sql';
  END IF;
END $$;


-- =====================================================================================
-- 1. meta.pending_page —— 真·新页的身份解析队列
-- =====================================================================================
-- 生命周期：sitemap（或 ListPages）看到一个 slug，而 ingest.page_slug_history /
--   serve.page_current 都解析不出 page_id ⇒ 这是「真·新页」（或改名后的新 slug）。
--   消化者（syncer2 的 resolve-pages CLI）：普通页整页 GET 解析 pageId；
--   受限分类用 ListPages fullname + v1 强制只读身份源复核。两路最终都回填
--   page_id 和结构化证据，证据未到则定时复查而不静默挂起。
--
-- 为什么必须持久化（而不是像现在这样只留在 meta.ingest_run.stats.sampleUnresolvedSlugs 里）：
--   stats 是**截断的采样**（前 200 条），且 sitemap 快照一旦推进，同一个 slug 下一轮
--   就不再是 "new" 了 —— 于是「本轮没消化完」的部分会永久消失。这正是"发现了但没消化"
--   这类静默丢失的典型形状，必须有一张自己的表来兜。
--
-- 当前状态机：
--   'pending'          新入队，立即可认领
--   'retry'            短退避后重试
--   'waiting_evidence' 受限分类等待只读身份证据
--   'conflict'         直接身份证据冲突，低频复查
--   'irreconcilable'   短重试耗尽，低频复查
--   'resolved'         身份已正当解析，page_id 已回填（终态）
--   'gone'     整页 GET 返回 404（实测非存在页确实是 404 而非 200 空页）——
--              页面在 sitemap 生成（TTL≈60min）与我们抓取之间被删了（终态）。
--   'mismatch'/'failed' 仅用于从旧二进制滚动迁移；0042 会规范化，新代码不再写入。
CREATE TABLE IF NOT EXISTS meta.pending_page (
  slug          text PRIMARY KEY,          -- wikidot fullname 口径（含 category 前缀，小写）
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  seen_count    int         NOT NULL DEFAULT 1,
  discovered_by text        NOT NULL DEFAULT 'wikidot_sitemap',
  reasons       text[]      NOT NULL DEFAULT '{}',
  priority      int         NOT NULL DEFAULT 0,

  -- ── 执行侧状态：发现侧的 UPSERT 一律不得触碰 ──────────────────────────────────
  status        text        NOT NULL DEFAULT 'pending',
  attempts      int         NOT NULL DEFAULT 0,
  not_before    timestamptz,               -- 指数退避载体
  locked_by     text,
  locked_at     timestamptz,

  -- ── 解析产物 ────────────────────────────────────────────────────────────────
  wikidot_id    int,                       -- WIKIREQUEST.info.pageId
  page_id       int,                       -- register_page 返回值
  category_id   int,                       -- WIKIREQUEST.info.categoryId(整页 GET 白送)
  observed_slug text,                      -- WIKIREQUEST.info.pageUnixName（冲突证据）
  http_status   int,
  last_error    text,
  resolved_at   timestamptz,
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  resolution_source text,
  resolution_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT pending_page_status_ck
    CHECK (status IN (
      'pending','retry','waiting_evidence','resolved','gone','conflict','irreconcilable',
      'mismatch','failed'
    ))
);

-- 后续状态机列提前在 0012 补齐：apply.sh 会重跑全序列，0040 的 view 在 0042 前创建，
-- 因而不能等到 0042 才让旧实例看到这些列。
ALTER TABLE meta.pending_page
  ADD COLUMN IF NOT EXISTS state_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_source text,
  ADD COLUMN IF NOT EXISTS resolution_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 认领索引：与 meta.scan_task.st_claim 同形（FOR UPDATE SKIP LOCKED 认领）
CREATE INDEX IF NOT EXISTS pp_claim
  ON meta.pending_page(priority DESC, not_before NULLS FIRST, first_seen_at)
  WHERE status = 'pending' AND locked_by IS NULL;
CREATE INDEX IF NOT EXISTS pp_status ON meta.pending_page(status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS pp_locked ON meta.pending_page(locked_at) WHERE locked_by IS NOT NULL;

COMMENT ON TABLE meta.pending_page IS
  '真·新页的身份解析队列（设计 §5.8「失败进 pending 队列而非静默跳过」的物理载体）。'
  'sitemap/ListPages 见到的 slug 若在 ingest.page_slug_history 与 serve.page_current 都解析不到 '
  'page_id，就落这里；普通页用整页 GET，受限分类用 ListPages + v1 强制只读身份源。'
  '刻意不复用 meta.scan_task：那张表 page_id NOT NULL，而本队列的定义就是「page_id 尚不存在」，'
  '伪造 page_id 入队等于在队列里放假身份。';
COMMENT ON COLUMN meta.pending_page.status IS
  '''pending''立即待处理 / ''retry''短退避 / ''waiting_evidence''等待身份证据 / '
  '''conflict''身份冲突低频复查 / ''irreconcilable''重试耗尽低频复查 / '
  '''resolved''与 ''gone''为终态。''mismatch''/''failed''仅用于滚动部署兼容。';
COMMENT ON COLUMN meta.pending_page.seen_count IS
  '这个 slug 被发现层重复报告过几次。发现侧 UPSERT 只 +1 并刷 last_seen_at，'
  '绝不重置 attempts/not_before/status —— 否则一个持续出现在 sitemap 里的坏 slug 会每轮清零退避，变成死循环重试。';
COMMENT ON COLUMN meta.pending_page.category_id IS
  '整页 GET 的 WIKIREQUEST.info.categoryId（CROM 完全没有的数字 category id，零额外请求白送）。'
  '留在 meta 侧不进 serve：它的用途是给 SiteChangesListModule 做分类级增量过滤。';


-- =====================================================================================
-- 2. meta.forum_scan_task —— thread 新 id / category 周期枚举队列
-- =====================================================================================
-- 实测（experiments/sitemap-probe.md §5）：
--   thread sitemap  9 文件 / **86,900 个唯一 thread id**，无 lastmod、无标题、无分类，
--                   只给存在性；对 `翻译预定区(归档)`(882986) 与 `垃圾桶`(2020429)
--                   两个被站方隐藏的分类**完全失明**（那两类只能靠论坛分页爬）。
--   category sitemap 实为 **14 个**（此前"15 个"把站点根 URL 数进去了），库内 16。
--
-- 因此 thread 差集的语义只有一种：**"站上有、我们库里还没有"⇒ 待抓**。
-- 反向差集（"库里有、sitemap 没有"）**不能**当消失证据 —— 上面那两个隐藏分类就是反例，
-- 已经证明 sitemap 对它们系统性失明。所以本表刻意没有全站 'confirm_deleted' 类的 kind。
-- category 正向集合则周期入队：消费者完整翻完一个分类后，只能在该分类级判 thread 存亡。
CREATE TABLE IF NOT EXISTS meta.forum_scan_task (
  id            bigserial PRIMARY KEY,
  kind          text   NOT NULL,          -- 'thread' | 'category'
  target_id     bigint NOT NULL,          -- wikidot 原始 thread_id / category_id
  reasons       text[] NOT NULL DEFAULT '{}',
  priority      int    NOT NULL DEFAULT 0,

  -- ── 执行侧状态：与 meta.scan_task 逐列同形，发现侧不得覆盖 ────────────────────
  not_before    timestamptz,
  attempts      int    NOT NULL DEFAULT 0,
  stable_count  int    NOT NULL DEFAULT 0,
  last_result_hash bytea,
  locked_by     text,
  locked_at     timestamptz,

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  seen_count    int    NOT NULL DEFAULT 1,

  UNIQUE (kind, target_id),
  CONSTRAINT forum_scan_task_kind_ck CHECK (kind IN ('thread','category'))
);

CREATE INDEX IF NOT EXISTS fst_claim
  ON meta.forum_scan_task(kind, priority DESC, not_before NULLS FIRST, id)
  WHERE locked_by IS NULL;
CREATE INDEX IF NOT EXISTS fst_locked ON meta.forum_scan_task(locked_at) WHERE locked_by IS NOT NULL;

COMMENT ON TABLE meta.forum_scan_task IS
  'thread sitemap 新 id 发现队列 + category sitemap 周期完整枚举队列。'
  '不复用 meta.scan_task：thread 的主键是 wikidot thread_id、大量 thread 不挂任何页面，'
  'UNIQUE(page_id,kind) 对它无意义；也不能直接写 ingest.forum_thread —— 那张表 '
  'category_id/title/created_at 均 NOT NULL，而 thread sitemap 只给 id。'
  '刻意不设全站 confirm_deleted 类 kind：实测 sitemap 对「翻译预定区(归档)」「垃圾桶」'
  '两个隐藏分类系统性失明，反向差集不构成消失证据。thread 存亡只由 sitemap 明确列出的'
  '分类之完整分页枚举裁决；整体缺席分类记 partial 且禁止推断。';
COMMENT ON COLUMN meta.forum_scan_task.kind IS
  '''thread''（sitemap_thread_{1..9}，实测 86,900 个 id）/ ''category''（sitemap_category_1，实测 14 个）。';


-- =====================================================================================
-- 3. 权限（角色不存在时跳过，与 0006 第 8 节同一约定）
-- =====================================================================================
-- 9000_roles_grants.sql.ADMIN 的 ALTER DEFAULT PRIVILEGES 只对**之后**新建的对象生效，
-- 而本文件可能在角色落地之前就已执行 —— 所以这里显式补一次 GRANT，且做存在性判断。
DO $do$
DECLARE
  v_ingestor  oid := to_regrole('ingestor_role');
  v_projector oid := to_regrole('projector_role');
BEGIN
  IF v_ingestor IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON meta.pending_page    TO ingestor_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON meta.forum_scan_task TO ingestor_role;
    GRANT USAGE ON SEQUENCE meta.forum_scan_task_id_seq          TO ingestor_role;
  ELSE
    RAISE NOTICE '[0012] ingestor_role 不存在，已跳过 GRANT。DBA 执行 9000_roles_grants.sql.ADMIN 后重跑本文件第 3 节。';
  END IF;

  IF v_projector IS NOT NULL THEN
    GRANT SELECT ON meta.pending_page    TO projector_role;
    GRANT SELECT ON meta.forum_scan_task TO projector_role;
  END IF;
END
$do$;

COMMIT;

-- =====================================================================================
-- 自检（不在事务内，按需手工执行）：
--   SELECT count(*) FROM information_schema.columns WHERE table_schema='meta' AND table_name='pending_page';
--   -- 期望 19 列（实测核对过）
--   SELECT conname FROM pg_constraint WHERE conrelid='meta.forum_scan_task'::regclass ORDER BY 1;
--   -- 期望 forum_scan_task_kind_ck / forum_scan_task_kind_target_id_key / forum_scan_task_pkey
-- =====================================================================================
