-- =====================================================================================
-- 0007_meta_gaps.sql —— meta 层三处空缺:词表 / R10 熔断物理开关 / 投影登记清单
-- =====================================================================================
-- 目标库  : scpper-v2(全新独立库;v1 生产库 scpper-cn 只读,文件头有安全闸)
-- 收口对象: syncer2/README.md「后续 TODO」的 #6 / #4 / #3
--
--   §1  TODO #6  meta.scan_task.kind 词表补齐 forum / files / discussion,
--                并把 page_scan.kind 同步补齐(否则「入队 files 任务 → 记 files 证据」
--                会在 record_page_scan 上撞 CHECK,是一条只有跑到才会发现的死路)。
--   §2  TODO #4  R10 解析健康熔断的**物理开关** meta.write_freeze +
--                freeze_writes / release_writes / write_freeze_status / assert_writes_allowed。
--                在此之前 meta.parse_health_baseline 只能「记基线 + 留越界痕」,
--                action='freeze_write' 是一句没有执行体的话。
--   §3  TODO #3  meta.projection_cursor 的初始登记清单(每个 Tier-2 投影一行)。
--                meta.projection_window() 对未登记投影抛 23503(刻意如此),
--                所以这份清单是 projector 能跑起来的前置条件。
--
-- 依赖:0002_serve.sql(读 serve.* 的 COMMENT ON TABLE)、0003_meta.sql(scan_task /
--       page_scan / projection_cursor / ingest_run)。**必须在 0003 之后**。
--       0006_functions.sql 里各 apply_* 入口调用本文件建出的
--       meta.assert_writes_allowed(text) —— plpgsql 函数体是首次执行时才解析的,
--       所以 0006 先跑不会失败;但 0007 不落地时任何 apply_* 一调用就 42883。
--       apply.sh 的编号顺序已保证 0006 → 0007。
--
-- 可重复执行:CREATE ... IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD /
--   CREATE OR REPLACE FUNCTION / ON CONFLICT DO UPDATE。整体 BEGIN/COMMIT。
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 安全闸:本文件永远不允许落到 v1 生产库
-- -------------------------------------------------------------------------------------
DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn') THEN
    RAISE EXCEPTION
      'refusing to apply 0007 to the v1 production database %(read-only by policy)',
      current_database();
  END IF;
END $$;

-- -------------------------------------------------------------------------------------
-- 前置断言:0003 与 0002 必须已落地
-- -------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('meta.scan_task') IS NULL
     OR to_regclass('meta.page_scan') IS NULL
     OR to_regclass('meta.projection_cursor') IS NULL
     OR to_regclass('meta.ingest_run') IS NULL THEN
    RAISE EXCEPTION '0007_meta_gaps.sql 需要先执行 0003_meta.sql';
  END IF;
  IF to_regclass('serve.page_current') IS NULL THEN
    RAISE EXCEPTION '0007_meta_gaps.sql 需要先执行 0002_serve.sql(§3 从 serve.* 的注释生成登记清单)';
  END IF;
END $$;


-- =====================================================================================
-- §1  TODO #6 —— scan_task.kind / page_scan.kind 词表补齐
-- =====================================================================================
-- 0003 的 scan_task.kind 词表 = 文档 §4.7 的 6 项 + 2026-07-27 的 2 项 = 8 项。
-- 缺三类**已经在建模里出现、但队列侧无处表达**的深扫:
--
--   * 'forum'      —— ingest.forum_category/forum_thread/forum_post 三表 + apply_forum_batch
--                     都已落地,page_scan.kind 里也已有 'forum',唯独 scan_task 不能入队
--                     「这一页的论坛数据要重扫」。缺它 ⇒ 论坛域只能整站批量扫,
--                     没有页级定向重试,而论坛恰恰是 v1 #113 丢帖事故的发生地。
--   * 'discussion' —— **与 forum 是两件事**,不能合并:wikidot 的「单页讨论区」是挂在
--                     page 上的一条 thread(scpper 现网实测 categoryId=675245 即单页讨论),
--                     而 'forum' 指论坛分类/主题的批量枚举。两者的抓取入口、完整性判据、
--                     重试节奏都不同;合成一个 kind 会让 UNIQUE(page_id,kind) 把两类任务
--                     互相顶掉(成功即删 ⇒ 删掉的可能是另一类的待办)。
--   * 'files'      —— serve.page_image / meta.image_ingest_job / serve.image_asset 三件套
--                     已建,页面附件(files)列表却没有任何入队方式。
--
-- 与采集层的对齐(读 src/ 实测):src/cli/sitemap-scan.ts 目前只入队三种 kind ——
--   'meta'(sitemap_new_slug)/ 'content'(sitemap_lastmod_advanced)/
--   'confirm_deleted'(sitemap_absent),都已在词表内。
--   src/store/meta.ts 的 TS 联合类型 ScanTaskKind 反而**比 DDL 窄**(缺 0003 增补的
--   sitemap_delta / new_page_highfreq),已在本轮同步放宽到与本文件逐项一致 ——
--   两边任一侧收窄都会变成「运行期才发现的入队失败」。
--
-- 与 meta.forum_scan_task(0012_collector_queues.sql)的分工 —— 不是重复:
--   forum_scan_task 的键是 (kind∈{thread,category}, target_id),是**论坛自身对象**的枚举队列;
--   本表新增的 'forum' / 'discussion' 键是 (page_id, kind),是**某一页**的论坛/讨论数据要重扫。
--   前者回答「哪些 thread 还没抓」,后者回答「这一页的评论数对不上,重扫它」。
--   两个队列的认领者、退避节奏、收敛出口都不同,合并会让页级重试无处表达。
-- =====================================================================================

ALTER TABLE meta.scan_task DROP CONSTRAINT IF EXISTS scan_task_kind_ck;
ALTER TABLE meta.scan_task ADD  CONSTRAINT scan_task_kind_ck
  CHECK (kind IN (
    'meta',
    'votes_full',
    'revisions_full',
    'content',
    'attributions',
    'confirm_deleted',
    'sitemap_delta',        -- 0003(2026-07-27):sitemap 成为一等发现通道后的独立信号
    'new_page_highfreq',    -- 0003(2026-07-27):新页 2-4h 高频队列
    'forum',                -- 0007:页级论坛数据重扫(与 page_scan.kind='forum' 对齐)
    'discussion',           -- 0007:单页讨论区 thread(与 forum 分开,见上)
    'files'                 -- 0007:页面附件列表
  ));

-- page_scan.kind 同步补齐 'discussion' / 'files'('forum' 本来就有)。
-- 理由:scan_task 与 page_scan 是同一条链的两端(入队 → 扫描 → 留证据)。
-- 只放宽入队端会造出「任务能建、证据写不进去」的断头路,而 record_page_scan 里
-- 那条 CHECK 违规会在**扫描完成、准备留痕**的那一刻才炸,把一次成功采集变成失败。
ALTER TABLE meta.page_scan DROP CONSTRAINT IF EXISTS page_scan_kind_ck;
ALTER TABLE meta.page_scan ADD  CONSTRAINT page_scan_kind_ck
  CHECK (kind IN ('meta','votes','revisions','content','attributions','forum',
                  'discussion','files'));

COMMENT ON COLUMN meta.scan_task.kind IS
  '任务种类(11 项)。文档 §4.7 六项 + 0003 增补 sitemap_delta / new_page_highfreq'
  ' + 0007 增补 forum / discussion / files。discussion 与 forum 刻意分开:单页讨论区是挂在 page 上的'
  '单条 thread(实测 categoryId=675245),forum 指论坛分类/主题批量枚举,两者抓取入口与完整性判据不同,'
  '合并会让 UNIQUE(page_id,kind) 把两类待办互相顶掉。';
COMMENT ON COLUMN meta.page_scan.kind IS
  '扫描维度(8 项),与 meta.scan_task.kind 的可留证据子集一一对应。0007 补 discussion / files:'
  '只放宽入队端会造出「任务能建、证据写不进」的断头路,且违规在扫描完成那一刻才炸。';


-- =====================================================================================
-- §2  TODO #4 —— R10 熔断的物理开关:meta.write_freeze
-- =====================================================================================
-- 现状(0003 §14):meta.parse_health_baseline 有基线、阈值、direction、
--   action='freeze_write' 与越界留痕四件套,但**没有任何东西能真的冻结写入** ——
--   action 列存的是一句意图,不是一个执行体。R10 的上线 gate 是
--   「在一次人为注入的解析故障演练中成功阻断写入」,没有本表就无法通过。
--
-- 语义边界(本设计最关键的一条,与设计文档 §4.7 / R10 原文一致):
--   **冻结写入,不冻结采集。**
--   - 被冻结:ingest.* 的事实与身份、serve.* 的投影(经 apply_* 与 projector 的写入)。
--   - 不被冻结:meta.* 的全部证据链 —— ingest_run / page_scan / scan_task /
--     vote_quarantine / fact_quarantine / revoke_candidate。
--     理由:熔断是因为「怀疑解析变形」,而判断到底变形没变形的唯一依据就是这批证据。
--     把证据一起冻掉 = 熔断期变成观测盲区 = 熔断本身不可复盘。
--
-- 与调用方的契约(必读,否则冻结期会丢证据):
--   apply_* 在入口抛 PGF01 ⇒ **整个调用事务回滚**,包括该函数本来会写的
--   meta.page_scan 证据行。所以采集层必须:
--     (1) 抓完先在自己的事务里写 meta.ingest_run / meta.page_scan(TS 侧
--         store/meta.ts 的 recordPageScans 已是独立事务),再调 apply_*;或
--     (2) 捕获 SQLSTATE='PGF01' 后,在**新事务**里调 meta.note_freeze_skip(...)
--         补一条 status='failed' / error='write_frozen:<domain>' 的证据行。
--   这条契约写在这里,是因为「异常回滚顺带把证据吞掉」正是本项目一直在防的
--   那类「失败伪装成正常」的近亲:任务没做、也没人知道任务没做。
--
-- 逃生舱刻意与 serve.write_bypass_enabled() 分开(独立 GUC scpper.freeze_bypass):
--   bypass_guard 的语义是「我在做迁移/DBA 修复,放我过不可变触发器」,
--   而熔断的语义是「上游数据可能是垃圾,先别往库里写」。两者共用一个开关,
--   等于任何一次迁移窗口都顺手把 R10 熔断关掉 —— 那是最不该在此刻关掉它的时候。
-- =====================================================================================

CREATE TABLE IF NOT EXISTS meta.write_freeze (
  domain        text PRIMARY KEY,
  frozen        boolean NOT NULL DEFAULT false,
  reason        text,                     -- 冻结原因;释放后保留(取证用)
  frozen_at     timestamptz,
  frozen_by     text,
  released_at   timestamptz,
  released_by   text,
  breach_metric text,                     -- 触发者:meta.parse_health_baseline.metric
  breach_run    bigint REFERENCES meta.ingest_run(id) ON DELETE SET NULL,
  freeze_count  int NOT NULL DEFAULT 0,   -- 历史冻结次数(误跳闸复盘)
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- frozen=true 必须有原因与时刻:一个没有理由的冻结无法被裁决是否该释放。
  CONSTRAINT write_freeze_state_ck
    CHECK (NOT frozen OR (frozen_at IS NOT NULL AND reason IS NOT NULL))
);

-- 域词表(可重复执行时也能更新)
ALTER TABLE meta.write_freeze DROP CONSTRAINT IF EXISTS write_freeze_domain_ck;
ALTER TABLE meta.write_freeze ADD  CONSTRAINT write_freeze_domain_ck
  CHECK (domain IN (
    'all',          -- 总闸。任一 apply_* 都读它 ⇒ freeze_writes('all') 停掉全部写入
    'identity',     -- register_page / ensure_user
    'page',         -- apply_page_meta / apply_page_life
    'vote',         -- apply_vote_observation / _cas_batch / _history / _snapshot / promote_revoke_candidates
    'revision',     -- apply_revision_batch
    'attribution',  -- apply_attribution_snapshot
    'content',      -- put_content_blob / put_content_blob_sha
    'forum',        -- apply_forum_batch
    'projection'    -- Tier-2 projector(预留:projector 落地后在其入口调同一个断言)
  ));

CREATE INDEX IF NOT EXISTS wf_frozen ON meta.write_freeze(domain) WHERE frozen;

COMMENT ON TABLE meta.write_freeze IS
  'R10 解析健康熔断的物理开关(0007 新增)。按域冻结**写入**,不冻结采集:meta.* 的证据链'
  '(ingest_run/page_scan/scan_task/quarantine/revoke_candidate)在冻结期照常写入 —— '
  '否则熔断期成为观测盲区,连「到底该不该熔断」都无法复盘。'
  '入口断言 meta.assert_writes_allowed(domain) 已挂在全部 apply_* / register_page / ensure_user /'
  ' put_content_blob 上,违规抛 SQLSTATE PGF01。';
COMMENT ON COLUMN meta.write_freeze.domain IS
  '写入域。''all'' 是总闸(与任何具体域取或);其余与 0006_functions.sql 各入口一一对应。'
  'R10 自动熔断应冻结 ''all''(解析变形是全局相关性失效,只冻一个域会让别的域继续写脏数据)。';
COMMENT ON COLUMN meta.write_freeze.reason IS
  '冻结原因。释放后**不清空**:它是「这次熔断是否误跳闸」的唯一现场记录。';
COMMENT ON COLUMN meta.write_freeze.freeze_count IS
  '历史冻结次数。频繁跳闸 ⇒ 该 metric 的阈值定得太紧,应先退回 action=''warn'' 观察。';

-- 词表内全部域预置一行(frozen=false)。
-- 为什么预置而不是「按需插入」:assert_writes_allowed 用「域是否有登记行」当拼写守卫,
-- 未登记的域名一律抛 23503。若允许缺行,一个把 'vote' 写成 'votes' 的 apply_* 就会
-- 永远查不到冻结状态、永远放行 —— 熔断静默失效,且没有任何迹象。
INSERT INTO meta.write_freeze(domain, frozen)
SELECT d, false
  FROM unnest(ARRAY['all','identity','page','vote','revision','attribution',
                    'content','forum','projection']) AS t(d)
ON CONFLICT (domain) DO NOTHING;


-- ---- 2.1 逃生舱判定 ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION meta.freeze_bypass_enabled()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_flag text;
BEGIN
  v_flag := current_setting('scpper.freeze_bypass', true);
  RETURN v_flag IS NOT NULL AND lower(v_flag) IN ('on','true','1','yes');
END;
$$;

COMMENT ON FUNCTION meta.freeze_bypass_enabled() IS
  '熔断逃生舱:SET LOCAL scpper.freeze_bypass=''on''。刻意不复用 scpper.bypass_guard —— '
  '「我在做迁移」不应该顺手把「上游数据可能是垃圾」的熔断一起关掉。绕过时会 RAISE WARNING 留痕。';


-- ---- 2.2 入口断言(0006 各 apply_* 调用它)-------------------------------------------
CREATE OR REPLACE FUNCTION meta.assert_writes_allowed(p_domain text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_known  boolean;
  v_frozen record;
BEGIN
  IF p_domain IS NULL OR p_domain = 'all' THEN
    -- 'all' 是总闸的存储域,不是调用域:允许它当参数会让「冻结 all」变成「检查 all」,
    -- 于是 freeze_writes('vote') 对一个自称 all 的调用点完全无效。
    RAISE EXCEPTION 'assert_writes_allowed: p_domain 必须是具体写入域(不能为 NULL 或 ''all'')'
      USING ERRCODE = '22023';
  END IF;

  SELECT true INTO v_known FROM meta.write_freeze w WHERE w.domain = p_domain;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assert_writes_allowed: 未登记的写入域 %(拼写守卫:见 meta.write_freeze 词表)',
      p_domain USING ERRCODE = '23503';
  END IF;

  SELECT w.domain, w.reason, w.frozen_at, w.frozen_by, w.breach_metric
    INTO v_frozen
    FROM meta.write_freeze w
   WHERE w.frozen AND w.domain IN ('all', p_domain)
   ORDER BY (w.domain = 'all') DESC          -- 总闸优先报告
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN;                                   -- 未冻结:正常路径,零额外代价
  END IF;

  IF meta.freeze_bypass_enabled() THEN
    RAISE WARNING '[write_freeze] 域 % 处于冻结态(触发域=% 原因=%),但 scpper.freeze_bypass=on ⇒ 放行',
      p_domain, v_frozen.domain, v_frozen.reason;
    RETURN;
  END IF;

  RAISE EXCEPTION
    '写入已冻结:域 %(触发域=%,原因=%,冻结于 % by %)。'
    '采集与 meta.* 证据不受影响;人工确认后执行 meta.release_writes(''%'')',
    p_domain, v_frozen.domain, v_frozen.reason, v_frozen.frozen_at,
    COALESCE(v_frozen.frozen_by, '?'), v_frozen.domain
    USING ERRCODE = 'PGF01',
          HINT = '若确需在冻结期写入(定向修复/补偿观测),SET LOCAL scpper.freeze_bypass = ''on''';
END;
$$;

COMMENT ON FUNCTION meta.assert_writes_allowed(text) IS
  '写入冻结断言。挂在 0006_functions.sql 的全部 apply_* / register_page / ensure_user /'
  ' put_content_blob* 入口。被冻结 ⇒ SQLSTATE PGF01(独立错误码,便于调用方与真实数据错误区分)。'
  '未登记的域名抛 23503 —— 拼错域名不会变成「永远放行」。';


-- ---- 2.3 冻结 / 释放 -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION meta.freeze_writes(
  p_domain text,
  p_reason text,
  p_by     text   DEFAULT NULL,
  p_metric text   DEFAULT NULL,
  p_run    bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_row meta.write_freeze;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    -- 没有理由的冻结无法被裁决是否可释放,等于把值班人锁在门外。
    RAISE EXCEPTION 'freeze_writes: p_reason 不能为空' USING ERRCODE = '22004';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM meta.write_freeze w WHERE w.domain = p_domain) THEN
    RAISE EXCEPTION 'freeze_writes: 未登记的写入域 %', p_domain USING ERRCODE = '23503';
  END IF;

  UPDATE meta.write_freeze w
     SET frozen        = true,
         reason        = p_reason,
         frozen_at     = now(),
         frozen_by     = COALESCE(p_by, session_user),
         released_at   = NULL,
         released_by   = NULL,
         -- 已冻结时重复调用不覆盖首次触发的取证信息:同一次事故里后续调用往往不带 metric,
         -- 无条件赋值会把「是哪个指标先跳闸的」这个唯一线索抹掉(冒烟实测到这一条)。
         breach_metric = CASE WHEN w.frozen THEN COALESCE(p_metric, w.breach_metric) ELSE p_metric END,
         breach_run    = CASE WHEN w.frozen THEN COALESCE(p_run,    w.breach_run)    ELSE p_run    END,
         -- 已冻结时重复调用不累加:同一次事故里多个页各触发一次不算多次跳闸。
         freeze_count  = w.freeze_count + CASE WHEN w.frozen THEN 0 ELSE 1 END,
         updated_at    = now()
   WHERE w.domain = p_domain
  RETURNING w.* INTO v_row;

  RAISE WARNING '[write_freeze] 已冻结域 %:%(by %)', p_domain, p_reason,
    COALESCE(p_by, session_user);
  RETURN to_jsonb(v_row);
END;
$$;

COMMENT ON FUNCTION meta.freeze_writes(text, text, text, text, bigint) IS
  '冻结某写入域(R10 熔断的执行体)。p_reason 必填。已冻结时重复调用只刷新原因、不累加 freeze_count。'
  '自动熔断应传 p_domain=''all'' + p_metric/p_run 指向 parse_health_baseline 的越界项。';

CREATE OR REPLACE FUNCTION meta.release_writes(
  p_domain text,
  p_by     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_row meta.write_freeze;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM meta.write_freeze w WHERE w.domain = p_domain) THEN
    RAISE EXCEPTION 'release_writes: 未登记的写入域 %', p_domain USING ERRCODE = '23503';
  END IF;

  UPDATE meta.write_freeze w
     SET frozen      = false,
         released_at = now(),
         released_by = COALESCE(p_by, session_user),
         updated_at  = now()
         -- reason / breach_* 刻意保留:释放不等于事故没发生过。
   WHERE w.domain = p_domain
  RETURNING w.* INTO v_row;

  RAISE NOTICE '[write_freeze] 已释放域 %(by %),原因留档:%', p_domain,
    COALESCE(p_by, session_user), COALESCE(v_row.reason, '(无)');
  RETURN to_jsonb(v_row);
END;
$$;

COMMENT ON FUNCTION meta.release_writes(text, text) IS
  '释放某写入域的冻结。reason / breach_metric / breach_run 刻意不清空 —— 释放不等于事故没发生过,'
  '「上次为什么跳闸」必须可查。';


-- ---- 2.4 状态查询 + 冻结期证据补写 ---------------------------------------------------
CREATE OR REPLACE FUNCTION meta.write_freeze_status(p_domain text DEFAULT NULL)
RETURNS TABLE (domain text, frozen boolean, reason text,
               frozen_at timestamptz, frozen_by text, effective boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT w.domain, w.frozen, w.reason, w.frozen_at, w.frozen_by,
         -- effective:把总闸的传导算进去,调用方不必自己 OR 一遍
         (w.frozen OR EXISTS (SELECT 1 FROM meta.write_freeze a
                               WHERE a.domain = 'all' AND a.frozen)) AS effective
    FROM meta.write_freeze w
   WHERE p_domain IS NULL OR w.domain = p_domain
   ORDER BY (w.domain = 'all') DESC, w.domain;
$$;

COMMENT ON FUNCTION meta.write_freeze_status(text) IS
  '冻结状态查询。effective 列已把 ''all'' 总闸的传导算进去 —— 采集层用它做「先查再干」的分流,'
  '避免白抓一轮再被 PGF01 打回。';

CREATE OR REPLACE FUNCTION meta.note_freeze_skip(
  p_run    bigint,
  p_page   int,
  p_kind   text,
  p_domain text,
  p_note   text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- 冻结期的证据补写:必须在**捕获 PGF01 之后的新事务**里调用,
  -- 因为 PGF01 会把原事务连同它写的 page_scan 一起回滚。
  PERFORM meta.record_page_scan(
    p_run, p_page, p_kind, 'failed', NULL, NULL, NULL, NULL, NULL, NULL,
    format('write_frozen:%s%s', p_domain,
           CASE WHEN p_note IS NULL THEN '' ELSE ' — ' || p_note END));
END;
$$;

COMMENT ON FUNCTION meta.note_freeze_skip(bigint, int, text, text, text) IS
  '冻结期扫描证据补写:status=''failed'' + error=''write_frozen:<domain>''。'
  '必须在捕获 PGF01 之后的**新事务**里调用(PGF01 会把原事务的 page_scan 一起回滚)。'
  '有它才能回答「熔断那两小时到底扫了哪些页」——否则冻结期是观测盲区。';


-- =====================================================================================
-- §3  TODO #3 —— meta.projection_cursor 初始登记清单
-- =====================================================================================
-- 做法:**不手抄 rebuild_from**,直接从 pg_description 读 serve.* 的 COMMENT ON TABLE
--   解析出来再 INSERT。这样「逐字一致」不是靠人眼校对维持的,而是天然成立 ——
--   注释改了、重跑本文件即同步,不存在漂移窗口。
--
-- 判据:
--   * Tier-1 三表(vote_current / attribution_current / page_current)**不登记**:
--     它们由 apply_* 同事务维护,没有游标语义;登记反而会让 projector 以为该由它推进。
--   * 其余 serve.* 普通表(27 张)= Tier-2 投影,逐张一行。
--   * Tier-2 的注释必须以 'rebuild_from=' 开头(0002 全部如此)。
--     不符合 ⇒ 直接 RAISE EXCEPTION:一张说不出重建来源的投影表就是设计 §3 原则 1 的违反,
--     宁可让迁移失败,也不要静默登记一个空契约。
--   * 【存储口径 —— 与 0008_serve_embedding.sql 对齐】rebuild_from 存**整条注释逐字**
--     (含 'rebuild_from=' 前缀),不做截断。
--     初版存的是去掉前缀后的表达式(那更贴合 0003 里该列注释给的示例 'vote_current'),
--     但并行任务的 0008_serve_embedding.sql 用 obj_description() 原样入库、且刻意用
--     ON CONFLICT **DO NOTHING**(理由:"rebuild_from 被两个迁移互相覆盖,逐字一致这条纪律
--     就失去意义")。两种口径并存的后果是:0007 在 0008 之前跑 ⇒ 我方 DO UPDATE 覆盖成
--     去前缀版;之后 0008 又不改回来 ⇒ **同一列的形状取决于执行顺序**。
--     统一为"整条注释逐字"同时满足三件事:与并行任务一致、与任务原文"与 COMMENT ON TABLE
--     逐字一致"字面一致、漂移断言退化成一个普通的等号(最难写错的那种断言)。
--   * event_domain 的映射表在下面**显式**列出,并与实际表集合做双向覆盖断言:
--     新增 Tier-2 表却忘了声明 event_domain ⇒ 迁移失败(而不是默默给个 'mixed')。
--
-- ON CONFLICT 刻意**不动 last_seq**:重跑迁移不能把已经跑到一半的投影游标倒回 0。
-- =====================================================================================

-- event_domain 词表(0003 没给,设计文档也没给;此处定义并可重复刷新)
ALTER TABLE meta.projection_cursor DROP CONSTRAINT IF EXISTS projection_cursor_domain_ck;
ALTER TABLE meta.projection_cursor ADD  CONSTRAINT projection_cursor_domain_ck
  CHECK (event_domain IN (
    'vote', 'attribution', 'revision', 'page', 'content', 'forum',
    'mixed',   -- 跨多个事实域:任一域前进都要重投
    'none'     -- 非 seq 驱动:append-only 时点表 / 内容寻址资产(重建来源为 NONE)
  ));

COMMENT ON COLUMN meta.projection_cursor.event_domain IS
  '驱动该投影前进的事实域:vote/attribution/revision/page/content/forum,跨域为 ''mixed'','
  '非 seq 驱动(append-only 时点表、内容寻址资产元数据)为 ''none''。'
  '''none'' 的投影登记在册但游标恒 0 —— 登记的意义是「重建来源已声明」,不是「有游标要推」。';

DO $$
DECLARE
  -- 显式 event_domain 映射(27 张 Tier-2)。放在一处、并与真实表集合双向核对。
  v_map jsonb := jsonb_build_object(
    -- 投票域
    'page_stats',                    'vote',
    'vote_daily',                    'vote',
    -- 页面/元数据域
    'page_version_display',          'page',
    'series_stats',                  'page',
    'tag_validation_cache',          'page',
    'time_milestones',               'page',
    -- 内容域(content_blob 解析产物)
    'content_records',               'content',
    'page_image',                    'content',
    'page_reference',                'content',
    'page_reference_graph_snapshot', 'content',
    -- 非 seq 驱动
    'category_index_tick',           'none',
    'category_index_forecast_tick',  'none',
    'image_asset',                   'none',
    -- 跨域
    'interesting_facts',             'mixed',
    'leaderboard_cache',             'mixed',
    'page_daily_stats',              'mixed',
    'rating_records',                'mixed',
    'site_overview_daily',           'mixed',
    'site_stats',                    'mixed',
    'tag_records',                   'mixed',
    'trending_stats',                'mixed',
    'user_activity_records',         'mixed',
    'user_attr_daily',               'mixed',
    'user_page',                     'mixed',
    'user_stats',                    'mixed',
    'user_tag_preference',           'mixed',
    'user_vote_interaction',         'mixed',
    -- 语义检索族(0008_serve_embedding.sql,并行任务加入;本文件的断言 B 当场把它拦下来了,
    -- 这正是「新增 Tier-2 表却忘了声明 event_domain ⇒ 迁移硬失败」这条门在真实场景生效的实例)
    'text_chunk',                    'content',   -- 来自 ingest.content_blob.text_content
    'page_semantic',                 'content',   -- 来自 page_current.search_text + chunker + model
    -- 下面两张的注释自称「配置表,不是投影」。仍然登记,理由:'none' 的语义已定义为
    -- 「登记在册 = 重建来源已声明,不是有游标要推」(游标恒 0)。这样规则只有一条
    -- ——「serve 里除 Tier-1 之外每张表都要声明重建来源与事件域」—— 不需要维护一份
    -- 「哪些表豁免」的名单(那份名单会立刻成为第二个漂移源,而且要在两个文件里各存一份)。
    'text_chunker',                  'none',
    'embedding_model',               'none',
    -- 前向声明:chunk_embedding 只在 pgvector 装好后才存在(0008_serve_embedding.sql),
    -- 本文件在它不存在时只 NOTICE 不登记;先声明是为了「装上 pgvector 那天」不因断言 B 卡住。
    'chunk_embedding',               'content'
  );
  v_tier1  text[] := ARRAY['vote_current','attribution_current','page_current'];
  v_bad    text[];
  v_n      int;
  v_expect int;
BEGIN
  -- ---- 断言 A:每张 Tier-2 表的注释都必须是 'rebuild_from=…' -------------------------
  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'serve' AND c.relkind = 'r'
     AND NOT (c.relname = ANY (v_tier1))
     AND COALESCE(obj_description(c.oid, 'pg_class'), '') NOT LIKE 'rebuild_from=%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '这些 serve.* 表的 COMMENT 不以 rebuild_from= 开头,无法登记投影:%'
                    ' —— 设计 §3 原则 1:可从事实重建的数据必须显式声明重建来源', v_bad;
  END IF;

  -- ---- 断言 B:映射表 ⊇ 实际 Tier-2 表(新增表忘了声明 event_domain ⇒ 迁移失败)-------
  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'serve' AND c.relkind = 'r'
     AND NOT (c.relname = ANY (v_tier1))
     AND NOT (v_map ? c.relname);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '新增的 Tier-2 投影未在 0007 §3 声明 event_domain:%'
                    ' —— 默认给个 mixed 就等于「悄悄少了一个决策」,故此处硬失败', v_bad;
  END IF;

  -- ---- 断言 C:映射表里不得出现 Tier-1 表(Tier-1 无游标语义,登记等于误导 projector)-----
  SELECT array_agg(k ORDER BY k) INTO v_bad
    FROM jsonb_object_keys(v_map) AS t(k)
   WHERE k = ANY (v_tier1);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '0007 §3 的 event_domain 映射里出现了 Tier-1 表:%'
                    ' —— Tier-1 与事实同事务维护,登记会让 projector 以为该由它推进', v_bad;
  END IF;

  -- 映射里指向「本文件执行时还不存在」的表:**只提示不失败**。
  -- 理由:serve 的表由多个迁移文件创建,编号比 0007 大的文件(实测 0008_serve_embedding.sql
  -- 的语义检索四表)在本文件跑的时候确实还不存在 —— 那是**前向声明**,不是残留。
  -- 真正的「残留」(表被删/改名后登记行还在)由 checks/0001 的 drift-3 硬失败兜住,
  -- 它在全部迁移之后才跑,那时才有资格下这个判断。
  SELECT array_agg(k ORDER BY k) INTO v_bad
    FROM jsonb_object_keys(v_map) AS t(k)
   WHERE to_regclass('serve.' || quote_ident(k)) IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE NOTICE '[0007] event_domain 映射中的前向声明(表尚未创建,本轮不登记):%'
                 ' —— 由创建它们的迁移文件自己登记,或本文件在其之后重跑', v_bad;
  END IF;

  -- ---- 登记 ---------------------------------------------------------------------------
  WITH src AS (
    SELECT 'serve.' || c.relname                AS projection,
           (v_map ->> c.relname)                AS event_domain,
           obj_description(c.oid, 'pg_class')    AS rebuild_from   -- 整条注释逐字,见上
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'serve' AND c.relkind = 'r'
       AND NOT (c.relname = ANY (v_tier1))
  )
  INSERT INTO meta.projection_cursor (projection, event_domain, last_seq, rebuild_from)
  SELECT s.projection, s.event_domain, 0, s.rebuild_from FROM src s
  ON CONFLICT (projection) DO UPDATE
     SET event_domain = EXCLUDED.event_domain,
         rebuild_from = EXCLUDED.rebuild_from,
         updated_at   = now()
     -- last_seq 绝不回改:重跑迁移不能把跑到一半的投影游标倒回 0。
   WHERE meta.projection_cursor.event_domain IS DISTINCT FROM EXCLUDED.event_domain
      OR meta.projection_cursor.rebuild_from IS DISTINCT FROM EXCLUDED.rebuild_from;

  -- 收尾断言用**算出来的**期望值,不写字面量 27:serve 会继续长表(实测并行任务当天就加了
  -- 4 张语义检索表),写死数字会让本文件在每次扩表时都以一个和真正问题无关的理由失败。
  -- 覆盖性由断言 B/C 保证,这里只需确认「登记数 = Tier-2 表数」。
  SELECT count(*)::int INTO v_expect
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'serve' AND c.relkind = 'r' AND NOT (c.relname = ANY (v_tier1));
  SELECT count(*)::int INTO v_n FROM meta.projection_cursor WHERE projection LIKE 'serve.%';
  IF v_n <> v_expect THEN
    RAISE EXCEPTION 'projection_cursor 登记数 = %,而 serve 的 Tier-2 表有 % 张', v_n, v_expect;
  END IF;
  RAISE NOTICE '[0007] meta.projection_cursor 已登记 % 个 Tier-2 投影(rebuild_from 由注释生成,不手抄)', v_n;
END $$;

-- =====================================================================================
-- §4  权限:本文件新增的 SECURITY DEFINER 函数必须先对 PUBLIC 关门
-- =====================================================================================
-- 与 0006 第 8 节同一条纪律(设计 §4.1 / §4.8-2):SECURITY DEFINER + 默认的 PUBLIC EXECUTE
-- = 任何能连库的角色都能以属主身份执行。0006 第 8 节只扫它自己那一刻存在的函数,
-- 本文件的 5 个新函数不在其中 —— apply.sh 尾部的负向断言
-- 「SECURITY DEFINER 函数不得对 PUBLIC 可执行(期望 0)」实测因此报 5,本节把它按回 0。
--
-- 授权面(角色不存在时只 NOTICE 跳过,与 0006 同一套写法):
--   ingestor_role   assert_writes_allowed / write_freeze_status / note_freeze_skip
--                   —— 采集层要能「先查冻结再干活」,并在被 PGF01 打回后补写证据。
--                   **不给** freeze_writes / release_writes:自动熔断的执行体属于
--                   健康检查作业与值班人,采集进程不该有能力给自己解冻。
--   projector_role  assert_writes_allowed / write_freeze_status(projector 落地后自查 'projection' 域)
-- =====================================================================================
DO $do$
DECLARE
  r record;
  v_ingestor  oid := to_regrole('ingestor_role');
  v_projector oid := to_regrole('projector_role');
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'meta'
       AND p.prosecdef
       AND p.proname IN ('assert_writes_allowed','freeze_writes','release_writes',
                         'write_freeze_status','note_freeze_skip')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);

    IF v_ingestor IS NOT NULL
       AND r.proname IN ('assert_writes_allowed','write_freeze_status','note_freeze_skip') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ingestor_role', r.sig);
    END IF;

    IF v_projector IS NOT NULL
       AND r.proname IN ('assert_writes_allowed','write_freeze_status') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO projector_role', r.sig);
    END IF;
  END LOOP;

  IF v_ingestor IS NULL THEN
    RAISE NOTICE '[0007] ingestor_role 不存在,已跳过 GRANT。DBA 执行 9000_roles_grants.sql.ADMIN 后'
                 '需重跑本文件 §4(REVOKE 已生效)。';
  END IF;
END
$do$;


COMMENT ON COLUMN meta.projection_cursor.rebuild_from IS
  '该投影的重建来源契约,存 serve.* 的 COMMENT ON TABLE **整条逐字**(含 ''rebuild_from='' 前缀)。'
  '**由 0007 §3 用 obj_description() 生成,不手抄** —— 手抄的清单会随注释修改而静默漂移。'
  '(0003 初稿的示例写的是去前缀的表达式;改为整条逐字是为了与 0008_serve_embedding.sql 的'
  '入库口径统一,否则同一列的形状取决于迁移执行顺序。)'
  '漂移检测见 checks/0001_projection_cursor_drift.sql:双向覆盖 + 与注释逐字相等,任一不符非零退出。';


COMMIT;

-- =====================================================================================
-- 应用后自检(手工):
--   SELECT domain, frozen, reason FROM meta.write_freeze ORDER BY 1;         -- 9 行全 false
--   SELECT count(*) FROM meta.projection_cursor;                            -- 27
--   SELECT * FROM meta.write_freeze_status();                               -- effective 全 false
--   \i checks/0001_projection_cursor_drift.sql                              -- 漂移断言
-- 熔断演练(R10 上线 gate):
--   SELECT meta.freeze_writes('all','演练:注入解析故障','drill','avg_votes_per_page');
--   SELECT ingest.apply_vote_snapshot(...);   -- 期望 SQLSTATE PGF01
--   SELECT meta.release_writes('all','drill');
-- =====================================================================================
