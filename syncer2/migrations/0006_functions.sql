-- =====================================================================================
-- 0006_functions.sql —— SCPper CN 数据模型 V2 · 10 个 apply_* 转移函数 + 不可变触发器
--                        + meta.ingest_gate 游标安全机制
-- =====================================================================================
-- 目标库    : scpper-v2(全新独立库,与 v1 生产库 scpper-cn 物理隔离)
-- 权威依据  : docs/data-model-v2-redesign-2026-07-03.md §5(写路径)全部内容
--             §5.2 单票 CAS 转移函数的 SQL 原文逐字采用(仅修 2 处会导致运行期报错/漏锁的 bug,
--             每处都有「【逐字例外】」注释说明)
-- 实测修订  : analysis/wikidot-vs-crom-2026-07-27/{synthesis,findings,field-matrix}.md
--             以「【2026-07-27 实测】」开头的注释均来自该批实测结论。
--
-- 相对设计文档的三处增补(任务显式要求,均围绕「wikidot 单源下防幻影撤票」):
--   A1. apply_vote_snapshot 增加第四重门控 checksum:
--       Σsign(WhoRatedPageModule 的票) 必须等于 ListPages 的 %%rating%%(两个独立模块的交叉校验)。
--       不等 ⇒ 禁止任何 absence 推断(只允许 upsert 单调操作)+ meta.page_scan.checksum_ok=false。
--   A2. absence 推断的产物降级为候选:source='wikidot' 的 absence 不直接产生 kind='revoke',
--       而是写 meta.revoke_candidate;连续 N 次(默认 2)完整且 checksum 通过的快照都缺席,
--       才由 ingest.promote_revoke_candidates(N) 转正为 revoke 事件。
--   A3. time_precision 词表增加 'bootstrap' 分支(CROM 冷启动快照票 2022-05-14~26,
--       1,668,520 行 / 全表 26.3%,时间戳不代表任何真实投票时刻)。
--
-- 函数清单(设计 §5.1 的 10 个,加 3 个本次新增/内部函数):
--   身份    ingest.register_page / ingest.ensure_user
--   元数据  ingest.apply_page_meta / ingest.apply_page_life
--   投票    ingest.apply_vote_observation(§5.2 单票 CAS)
--           ingest.apply_vote_history(§5.3 CROM 事件历史协议)
--           ingest.apply_vote_snapshot(§5.4 当前态集合协议 + 四重门控)
--   其余域  ingest.apply_revision_batch / ingest.apply_attribution_snapshot / ingest.apply_forum_batch
--   新增    ingest.promote_revoke_candidates(A2 转正)
--   内部    ingest.apply_vote_cas_batch(集合化 CAS,history/snapshot 共用;
--                                       与 apply_vote_observation 的等价性是合入 gate)
--           ingest.resolve_thread_page(论坛 thread → page_id 反解)
--
-- 【2026-07-27 后续增补 · 与 0007_meta_gaps.sql 配套,必读】
--   * 全部写入型函数入口新增一行 `PERFORM meta.assert_writes_allowed('<域>');` ——
--     R10 解析健康熔断的物理开关(README TODO #4)。域划分:
--       identity   register_page / ensure_user
--       content    put_content_blob / put_content_blob_sha
--       page       apply_page_meta / apply_page_life
--       vote       apply_vote_observation / _cas_batch / _history / _snapshot / promote_revoke_candidates
--       revision   apply_revision_batch
--       attribution apply_attribution_snapshot
--       forum      apply_forum_batch
--     被冻结时抛 SQLSTATE **PGF01**。冻结的是**写入**,不是采集:meta.* 的证据链
--     (ingest_run / page_scan / scan_task / quarantine / revoke_candidate)一律不受影响。
--     ⚠ 依赖:meta.write_freeze 与 meta.assert_writes_allowed(text) 由 **0007** 建出。
--       plpgsql 函数体是首次执行时才解析的,所以 0006 在 0007 之前应用不会失败;
--       但 0007 未落地时任何 apply_* 一被调用就 42883。apply.sh 的编号顺序已保证 0006 → 0007。
--   * meta.record_page_scan 修 bug:run_id 为 NULL 时不再静默 RETURN(证据静默丢失),
--     改为自动创建 source='synthetic' 的合成 run。详见该函数处的长注释。
--   * apply_forum_batch 补 kind='forum' 的页级扫描证据(此前词表有、无人写)。
--
-- 执行顺序:0001_ingest → 0002_serve → 0003_meta → 0004_app → 0005_indexes → **0006_functions**
--   → 0007_meta_gaps → 0008_serve_embedding → 0009_serve_modeling_decisions
--   (由 ./apply.sh 保证;0001/0002 尾部的清单注释已同步修正为这一顺序)
--   ⚠ 本文件依赖 meta schema。若 0003_meta.sql 尚未落地,下面第 0 节的「兜底 DDL」会用
--     设计文档 §4.7 的原文建出本文件真正写入的那几张 meta 表,并 RAISE NOTICE 提示。
--     兜底只为「隔离测试可跑通」,正式环境必须 0003 先行——CREATE TABLE IF NOT EXISTS
--     不会给已存在的表补列,顺序颠倒会让 0003 的其余列永久缺失。
--     (整合试跑实测过这个坑的另一半:0003 与本文件对 meta.revoke_candidate 的形状一旦分叉,
--      0003 先跑 ⇒ 本文件的 CREATE 变 no-op ⇒ 运行期 column does not exist。两处已对齐。)
--
-- 可重复执行:CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS + CREATE TRIGGER。
--   ⚠ 改函数签名(参数名/类型/顺序)时 CREATE OR REPLACE 会报错,必须先 DROP FUNCTION;
--     文件末尾附了成套的 DROP 语句(默认注释掉)。
--
-- 安全:所有函数 SECURITY DEFINER + SET search_path = pg_catalog, pg_temp,
--       函数体内所有对象一律 schema 限定 —— 搜索路径劫持在此不可构造。
--       文件末尾 REVOKE ALL ... FROM PUBLIC(无需 CREATEROLE),
--       GRANT EXECUTE TO ingestor_role 在角色存在时才执行(当前连接用户无 CREATEROLE);
--       角色建好后必须**重跑本文件第 8 节**,否则 ingestor 无法调用任何 apply_*。
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 安全闸:本文件永远不允许落到 v1 生产库
-- -------------------------------------------------------------------------------------
DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn') THEN
    RAISE EXCEPTION
      'refusing to apply v2 functions to the v1 production database %(read-only by policy)',
      current_database();
  END IF;
END $$;

-- -------------------------------------------------------------------------------------
-- 前置断言:ingest / serve 结构必须已存在
-- -------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('ingest.page') IS NULL
     OR to_regclass('ingest."user"') IS NULL
     OR to_regclass('ingest.vote_event') IS NULL
     OR to_regclass('serve.vote_current') IS NULL
     OR to_regclass('serve.page_current') IS NULL THEN
    RAISE EXCEPTION '0006_functions.sql 需要先执行 0001_ingest.sql 与 0002_serve.sql';
  END IF;
END $$;


-- =====================================================================================
-- 0. meta 兜底 DDL(0003_meta.sql 未落地时的隔离测试支撑;正式环境应为全 no-op)
-- =====================================================================================
CREATE SCHEMA IF NOT EXISTS meta;

DO $$
BEGIN
  IF to_regclass('meta.ingest_run') IS NULL THEN
    RAISE NOTICE '[0006] meta.ingest_run 不存在 —— 正在用设计 §4.7 原文兜底建表。'
                 '正式环境应先执行 0003_meta.sql。';
  END IF;
END $$;

-- §4.7 原文
CREATE TABLE IF NOT EXISTS meta.ingest_run (
  id bigserial PRIMARY KEY, source text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed','aborted')),
  pages_enumerated int, remote_total int,
  stats jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS meta.page_scan (
  run_id bigint NOT NULL REFERENCES meta.ingest_run(id),
  page_id int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('meta','votes','revisions','content','attributions','forum')),
  status text NOT NULL CHECK (status IN ('ok','partial','failed')),
  claimed_total int, fetched_total int,
  result_hash bytea,
  error text,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, page_id, kind)
);

CREATE TABLE IF NOT EXISTS meta.projection_cursor (
  projection text PRIMARY KEY,
  event_domain text NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  rebuild_from text NOT NULL
);

CREATE TABLE IF NOT EXISTS meta.ingest_gate (
  txid bigint PRIMARY KEY,
  seq_floor bigint NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meta.vote_quarantine (
  id bigserial PRIMARY KEY,
  page_id int, voter_key text,
  raw jsonb NOT NULL, reason text NOT NULL, source text NOT NULL,
  occurred_at timestamptz, quarantined_at timestamptz NOT NULL DEFAULT now()
);

-- ---- 本文件需要、而设计 §4.7 没有的三处结构增补 --------------------------------------

-- 【A1】page_scan 的 checksum 三列:Σsign(WhoRated) vs ListPages %%rating%% 的交叉校验结果。
-- checksum_ok=false 是「本页本轮禁止 absence 推断」的持久化证据,供对账/告警/人工复核读取。
ALTER TABLE meta.page_scan ADD COLUMN IF NOT EXISTS checksum_ok boolean;
ALTER TABLE meta.page_scan ADD COLUMN IF NOT EXISTS checksum_expected int;  -- ListPages %%rating%%
ALTER TABLE meta.page_scan ADD COLUMN IF NOT EXISTS checksum_actual int;    -- Σ sign(direction)
COMMENT ON COLUMN meta.page_scan.checksum_ok IS
  '【A1 第四重门控】Σsign(WhoRatedPageModule 的票) = ListPages %%rating%% 是否成立。'
  'NULL=未校验(未提供 claimed_rating);false=两个独立模块互相不背书 ⇒ 本页本轮禁止任何 absence 推断。';

-- 【A2】absence 推断的产物:候选,不是事实。
-- ⚠ 列集必须与 0003_meta.sql 的权威定义逐列一致 —— 那里已按本
--   文件的可执行代码定稿(PK=(page_id,voter_id) 供 ON CONFLICT 推断、confirmations /
--   last_run_id / held_reason / promoted_seq 命名、observed_at 有默认值)。
--   两份不一致时以 0003 为准:CREATE TABLE IF NOT EXISTS 不会给已存在的表补列,
--   形状分叉只会在运行期以「column does not exist」爆出来(整合试跑已实测到过一次)。
CREATE TABLE IF NOT EXISTS meta.revoke_candidate (
  page_id        int      NOT NULL,
  voter_id       int      NOT NULL,
  last_direction smallint,
  confirmations  int      NOT NULL DEFAULT 1,   -- 连续「完整且 checksum 通过」的快照中缺席的次数
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  observed_at    timestamptz NOT NULL DEFAULT now(),
  last_run_id    bigint,                        -- 同一 run 内重复观测不累加 confirmations
  source         text     NOT NULL DEFAULT 'wikidot',
  gate_result    jsonb    NOT NULL DEFAULT '{}'::jsonb,
  gate_passed    boolean  NOT NULL DEFAULT false,
  status         text     NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','promoted','dismissed','held')),
  held_reason    text,
  promoted_seq   bigint,
  resolved_at    timestamptz,
  resolved_by    text,
  note           text,
  PRIMARY KEY (page_id, voter_id),
  CONSTRAINT revoke_candidate_dir_ck
    CHECK (last_direction IS NULL OR last_direction IN (-1,1))
);
CREATE INDEX IF NOT EXISTS rc_ready ON meta.revoke_candidate(confirmations DESC, page_id)
  WHERE status = 'pending';
COMMENT ON TABLE meta.revoke_candidate IS
  '【修订 R2 / A2】wikidot 直连的 absence(不在 WhoRated 名单里)只能落在这里,不得直接产生 '
  'kind=''revoke'' 事件。理由:直连的 absence 与「扫描静默变形/模块改版/解析失配」不可区分,'
  'syncer v1 的 54 万条幻影 removed 就是这么来的。'
  '转正条件:同一 (page,voter) 在连续 ≥N(默认 2)个「is_complete=true 且 checksum_ok=true」的'
  '不同 run 快照中都缺席 ⇒ ingest.promote_revoke_candidates(N)。'
  '一旦该 voter 在任何快照中重新出现(含显式 direction=0),本行立即删除 —— 出现是正证据,无条件采信。';
COMMENT ON COLUMN meta.revoke_candidate.status IS
  'pending=累积中;promoted=已转正为 revoke 事件(promoted_seq);dismissed=人工否决;'
  'held=触发单页熔断(一次要撤掉的票占比过高)被扣住,须人工裁决。';

-- 【本文件新增】非投票域的隔离表(revision wid 跨页冲突 / attribution 无法归属 / 论坛脏行)。
-- meta.vote_quarantine 是投票域专用(列名 voter_key),不复用它去装修订冲突。
CREATE TABLE IF NOT EXISTS meta.fact_quarantine (
  id bigserial PRIMARY KEY,
  domain text NOT NULL,            -- 'revision' | 'attribution' | 'forum' | 'page_meta'
  page_id int,
  natural_key text,                -- 该域的自然键文本形式(wid / role:actor / post id …)
  raw jsonb NOT NULL,
  reason text NOT NULL,
  source text NOT NULL,
  run_id bigint,
  observed_at timestamptz,
  quarantined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fq_domain ON meta.fact_quarantine(domain, quarantined_at DESC);
COMMENT ON TABLE meta.fact_quarantine IS
  '隔离不篡改:无法归属的上游脏行原样留痕,绝不 DO UPDATE 静默合并、绝不丢弃。'
  '【2026-07-27 实测·P2-5】同一 revision 在 CROM/直连被打成不同 type 且时间差恰好 8 小时,'
  '是 FLAG_TYPE_MAP 中文失配已污染生产的数据实锤 —— type 跨源冲突必须落这里。';


-- =====================================================================================
-- 1. 通用工具函数
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- 1.1 迁移逃生舱(与 0002_serve.sql 的 serve.write_bypass_enabled() 同语义、同 GUC)
-- -------------------------------------------------------------------------------------
-- ⚠ 用 session_user 而不是 current_user:本函数被 SECURITY DEFINER 的触发器函数调用,
--   current_user 在那里已经变成函数属主,拿它判角色等于把逃生舱对所有人敞开。
CREATE OR REPLACE FUNCTION meta.is_migration_context()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_flag text;
  v_role oid;
BEGIN
  v_flag := current_setting('scpper.bypass_guard', true);
  IF v_flag IS NOT NULL AND lower(v_flag) IN ('on','true','1','yes') THEN
    RETURN true;
  END IF;

  v_role := to_regrole('migration_role');
  IF v_role IS NOT NULL AND pg_has_role(session_user, v_role, 'MEMBER') THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;
COMMENT ON FUNCTION meta.is_migration_context() IS
  '不可变触发器的唯一放行口:SET LOCAL scpper.bypass_guard=''on'' 或 migration_role 成员。'
  '判角色用 session_user(SECURITY DEFINER 下 current_user 已是函数属主,不能用)。';

-- -------------------------------------------------------------------------------------
-- 1.2 advisory lock 键(同页写入串行化 / 游标安全屏障)
-- -------------------------------------------------------------------------------------
-- 说明:本节与 1.3/1.6 的纯函数(lock_key_* / lock_class_page / precision_rank /
-- derive_vote_precision / has_selector_residue)刻意**不加 SECURITY DEFINER**:
-- 它们不访问任何表、不写任何东西,SECURITY DEFINER 只会白白扩大攻击面(让调用方
-- 以属主身份执行代码)而不缩小任何风险。search_path 仍然显式钉死,堵住算子解析劫持。
CREATE OR REPLACE FUNCTION meta.lock_key_ingest_gate()
RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT 815412001::bigint $$;
COMMENT ON FUNCTION meta.lock_key_ingest_gate() IS
  '游标安全屏障锁的固定 key(单 int8 形式)。摄入事务持 SHARE,projector 取 EXCLUSIVE 做屏障。';

CREATE OR REPLACE FUNCTION meta.lock_class_page()
RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT 815412002::int $$;
COMMENT ON FUNCTION meta.lock_class_page() IS
  '页粒度 advisory lock 的 classid(双 int4 形式,objid = page_id)。同页写入串行化用。';

-- -------------------------------------------------------------------------------------
-- 1.2a Wikidot 零基修订声明值 → 真实修订行数
-- -------------------------------------------------------------------------------------
-- %%revisions%% 与 CROM revisionCount 表示当前最大修订号；Wikidot 从 revision 0 开始，
-- 因此 RevisionList / ingest.revision 的真实行数恒为声明值加一个固定 offset。
-- offset 只在这个具名工具里定义，所有完整性护栏必须调用它，禁止散落 `+ 1`。
CREATE OR REPLACE FUNCTION meta.revision_list_count(p_claimed_total int)
RETURNS int LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT p_claimed_total + 1 $$;
COMMENT ON FUNCTION meta.revision_list_count(int) IS
  '把 Wikidot %%revisions%% / CROM revisionCount 的零基最大修订号换算为真实修订行数。'
  'revision 0 也占一行，所以 expected_list_rows = claimed_total + offset(1)。';

-- -------------------------------------------------------------------------------------
-- 1.3 时间精度词表与偏序(【A3】含 'bootstrap')
-- -------------------------------------------------------------------------------------
-- 数值越大越可信。exact > observed > day > clamped > bootstrap。
--   exact     秒级可信(legacy_votes_cn.votes 的 timestamptz)
--   observed  「我这一刻看到它是这样」(直连快照协议,occurred_at = observed_at)
--   day       只精确到日(CROM fuzzy 的检测日)
--   clamped   day 且落在 2022-05-01 clamp 边界之前,连「哪一天」都是夹逼出来的
--   bootstrap 【2026-07-27 实测·P0-3】CROM 冷启动快照票:2022-05-14~26 之间、
--             1,668,520 行(全表 26.3%)全被写成同一天。它比 clamped 还不可信 ——
--             clamped 至少是「不晚于那天」,bootstrap 连这个都不保证,它只说明
--             「CROM 第一次看见这个站」。排最末的直接后果:bootstrap 永远抢不走
--             任何已有精度的 last_precision,heatmap 上不会长出 166 万高的假柱子。
CREATE OR REPLACE FUNCTION ingest.precision_rank(p_precision text)
RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE p_precision
           WHEN 'exact'     THEN 40
           WHEN 'observed'  THEN 30
           WHEN 'day'       THEN 20
           WHEN 'clamped'   THEN 10
           WHEN 'bootstrap' THEN 0
           ELSE -1                        -- 未知词表值:排在所有已知值之下,但仍可写入
         END;
$$;
COMMENT ON FUNCTION ingest.precision_rank(text) IS
  'time_precision 偏序:exact(40) > observed(30) > day(20) > clamped(10) > bootstrap(0)。'
  '用途:CAS 无转移时的「精度改善」副作用判定 —— day-floored 的 crom 永远不会覆盖'
  '直连的分钟级 observed,votes 列表 keyset 不抖动。';

-- 从时间戳与来源推导 precision(调用方也可显式传 precision 覆盖本推导)。
CREATE OR REPLACE FUNCTION ingest.derive_vote_precision(p_ts timestamptz, p_source text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- 无业务时间 ⇒ 只有观测时间可用
  IF p_ts IS NULL THEN
    RETURN 'observed';
  END IF;

  -- 直连是当前态快照协议:它给不出「什么时候投的」,只给「现在是这样」
  IF p_source IN ('wikidot','sentinel') THEN
    RETURN 'observed';
  END IF;

  -- legacy_votes_cn.votes 是秒级 timestamptz(修订 D3 ①)
  IF p_source IN ('legacy','legacy_import_2025_11') THEN
    RETURN 'exact';
  END IF;

  -- 【A3】CROM 冷启动快照窗口。findings.md:occurred_at between 2022-05-14 and 2022-05-26
  -- 且 source 属 crom 系 ⇒ bootstrap。这个分支防的是:166 万条同日票被当成
  -- 「那天真的发生了 166 万次投票」,在 heatmap / most_votes_single_day /
  -- vote_milestone_* 上产出一根假柱子并让里程碑归属每次重算都漂移。
  IF p_ts >= timestamptz '2022-05-14 00:00:00+08'
     AND p_ts < timestamptz '2022-05-27 00:00:00+08' THEN
    RETURN 'bootstrap';
  END IF;

  -- CROM fuzzy 在 2022-05 之前是 clamp 的:连「哪一天」都是夹逼出来的
  IF p_ts < timestamptz '2022-05-01 00:00:00+08' THEN
    RETURN 'clamped';
  END IF;

  RETURN 'day';
END;
$$;
COMMENT ON FUNCTION ingest.derive_vote_precision(timestamptz, text) IS
  '按 (时间戳, 来源) 推导 time_precision,含 bootstrap 窗口 [2022-05-14, 2022-05-27) 判定。'
  '调用方在记录自带 precision 时应优先用自带值,本函数只做兜底推导。';

-- -------------------------------------------------------------------------------------
-- 1.4 direction 归一化(±2 入口 sign() + quarantine 留痕)
-- -------------------------------------------------------------------------------------
-- 设计 §4.8-5:上游脏值在门口归一化留痕,管道不因脏值停摆;CHECK 值域是最后防线而非拦截面。
-- 【2026-07-27 实测】v1 存量 direction=±2 共 1,352~1,658 行(wikidot 双注册,CROM 文档化的正常输出)。
CREATE OR REPLACE FUNCTION ingest.norm_direction(
  p_raw       int,
  p_page      int,
  p_voter_key text,
  p_raw_json  jsonb,
  p_source    text,
  p_occurred  timestamptz DEFAULT NULL
)
RETURNS smallint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_raw IS NULL THEN
    RETURN NULL;
  END IF;

  IF abs(p_raw) > 1 THEN
    -- 隔离不篡改:原始值原样留痕后继续用 sign() 值走状态机,绝不中断整页事务
    INSERT INTO meta.vote_quarantine(page_id, voter_key, raw, reason, source, occurred_at)
    VALUES (p_page, p_voter_key,
            COALESCE(p_raw_json, jsonb_build_object('direction', p_raw)),
            'direction_out_of_range', p_source, p_occurred);
  END IF;

  RETURN sign(p_raw)::smallint;
END;
$$;

-- -------------------------------------------------------------------------------------
-- 1.5 身份校验(设计 §5.1 协议硬性条款)
-- -------------------------------------------------------------------------------------
-- URL 被复用重建的页面在 append-only 模型里绝不能把新页数据灌进旧身份。
-- 【2026-07-27 实测·P0-7】3,334 个 slug 被 10,062 个 Page 行接力占用(最深 21 层)。
CREATE OR REPLACE FUNCTION ingest.assert_page_identity(p_page int, p_wikidot_id int)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_wid int;
BEGIN
  SELECT wikidot_id INTO v_wid FROM ingest.page WHERE id = p_page;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'page_id % 未注册(先调 ingest.register_page)', p_page
      USING ERRCODE = '23503';
  END IF;

  -- p_wikidot_id 为 NULL = 调用方没带回显 id。协议要求所有定向抓取都必须带,
  -- 但内部调用(promote_revoke_candidates 等)已经从库里读出身份,无需二次校验。
  IF p_wikidot_id IS NULL THEN
    RETURN;
  END IF;

  IF v_wid <> p_wikidot_id THEN
    RAISE EXCEPTION
      '身份不一致:page_id=% 的 wikidot_id=%,观测回显=%。拒绝应用,请走身份注册流程'
      '(旧页 deleted 事件 + register_page 新行 + lineage 候选 + 任务改挂新 page_id)',
      p_page, v_wid, p_wikidot_id
      USING ERRCODE = '22000';
  END IF;
END;
$$;

-- -------------------------------------------------------------------------------------
-- 1.6 ListPages selector 字面量残留检测(【2026-07-27 实测·P1-6】)
-- -------------------------------------------------------------------------------------
-- 无效 selector 会被 wikidot 静默保留为字面量 ^%%.+%%$,字段数与分隔符数不变,
-- parts.length 校验发现不了 —— 一个拼写错就得到一列恒定垃圾且全链路静默。
CREATE OR REPLACE FUNCTION ingest.has_selector_residue(p_value jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE jsonb_typeof(p_value)
    WHEN 'string' THEN (p_value #>> '{}') ~ '^%%.+%%$'
    WHEN 'array'  THEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_value) t
                               WHERE t ~ '^%%.+%%$')
    ELSE false
  END;
$$;
COMMENT ON FUNCTION ingest.has_selector_residue(jsonb) IS
  '检测 ListPages 无效 selector 的字面量残留(^%%.+%%$)。命中即说明抓取层拼错了 selector,'
  '此时的值是恒定垃圾,写进 page_attr_history 会污染 SCD2 区间且不可回滚。';

-- -------------------------------------------------------------------------------------
-- 1.7 meta.page_scan 记录器
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION meta.record_page_scan(
  p_run      bigint,
  p_page     int,
  p_kind     text,
  p_status   text,
  p_claimed  int         DEFAULT NULL,
  p_fetched  int         DEFAULT NULL,
  p_checksum_ok       boolean DEFAULT NULL,
  p_checksum_expected int     DEFAULT NULL,
  p_checksum_actual   int     DEFAULT NULL,
  p_result_hash bytea   DEFAULT NULL,
  p_error    text        DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_run bigint := p_run;
BEGIN
  -- ===================================================================================
  -- 【2026-07-27 修 bug】run_id 为 NULL 时原实现只 RAISE WARNING 就 RETURN ——
  -- 扫描证据**静默丢失**。这正是本项目一直在防的那类「失败伪装成正常」:
  -- 调用方拿到的是"成功",库里却没有任何痕迹说这一页被扫过;
  -- 而 page_scan 恰恰是撤票/删除推断的前提证据,也是 stable_count 收敛与
  -- meta.irreconcilable 的唯一输入。WARNING 只进 stderr 日志,一轮日志轮转就没了。
  --
  -- 处置选择:**自动创建 source='synthetic' 的合成 run 并留痕**(而非强制报错)。
  --   理由:调用方忘传 run_id 是配置/编排疏漏,不是数据错误。强制报错会把一次
  --   本来能成功落库的观测变成失败,而失败的那一刻同样什么证据都没留下 ——
  --   两害相权,「证据一定落地 + 合成 run 显式可查」严格优于「什么都没有」。
  --   合成 run 的三条安全性质:
  --     (1) source='synthetic' 与任何真实通道词表都不重合,一条 SQL 就能筛出来;
  --     (2) status='running' + pages_enumerated/remote_total 全 NULL ⇒ coverage_ratio 为 NULL
  --         ⇒ apply_page_life 的删除推断门控(status='ok' 且 coverage ≥ 0.98)必然拒绝,
  --         **合成 run 永远无法授权任何 absence/删除/改名推断**;
  --     (3) 每个会话只建一个(GUC 记忆 + 存在性校验),不会把 ingest_run 撑爆。
  --   需要严格模式的场景(CI / 回填脚本)可 SET scpper.require_run_id = 'on',
  --   此时缺 run_id 直接抛 22004 —— 把疏漏在测试期就变成失败。
  -- ===================================================================================
  IF v_run IS NULL THEN
    IF lower(COALESCE(current_setting('scpper.require_run_id', true), 'off'))
       IN ('on','true','1','yes') THEN
      RAISE EXCEPTION '[record_page_scan] run_id 为空且 scpper.require_run_id=on:page=% kind=%',
        p_page, p_kind USING ERRCODE = '22004';
    END IF;

    -- 复用本会话已建的合成 run(GUC 与 run 行同事务,一起回滚,不会指向不存在的 id;
    -- 仍然做一次存在性校验,防跨会话连接池串用)
    v_run := NULLIF(current_setting('scpper.synthetic_run_id', true), '')::bigint;
    IF v_run IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM meta.ingest_run r
                        WHERE r.id = v_run AND r.source = 'synthetic') THEN
      v_run := NULL;
    END IF;

    IF v_run IS NULL THEN
      INSERT INTO meta.ingest_run(source, status, started_at, stats)
      VALUES ('synthetic', 'running', now(),
              jsonb_build_object(
                'synthetic', true,
                'reason', 'record_page_scan 被调用时未传 run_id —— 证据不能丢,故合成',
                'created_by', session_user,
                'first_page_id', p_page,
                'first_kind', p_kind))
      RETURNING id INTO v_run;
      PERFORM set_config('scpper.synthetic_run_id', v_run::text, false);
      RAISE WARNING '[record_page_scan] run_id 为空 ⇒ 已创建合成 run id=%(source=synthetic,'
                    'status=running ⇒ 永不授权 absence/删除推断)。调用方应补传 run_id', v_run;
    END IF;
  END IF;

  INSERT INTO meta.page_scan AS ps
                            (run_id, page_id, kind, status, claimed_total, fetched_total,
                             checksum_ok, checksum_expected, checksum_actual,
                             result_hash, error, scanned_at)
  VALUES (v_run, p_page, p_kind, p_status, p_claimed, p_fetched,
          p_checksum_ok, p_checksum_expected, p_checksum_actual,
          p_result_hash, p_error, now())
  ON CONFLICT (run_id, page_id, kind) DO UPDATE
    SET status = EXCLUDED.status,
        claimed_total = EXCLUDED.claimed_total,
        fetched_total = EXCLUDED.fetched_total,
        checksum_ok = EXCLUDED.checksum_ok,
        checksum_expected = EXCLUDED.checksum_expected,
        checksum_actual = EXCLUDED.checksum_actual,
        result_hash = COALESCE(EXCLUDED.result_hash, ps.result_hash),
        error = EXCLUDED.error,
        scanned_at = EXCLUDED.scanned_at;
END;
$$;

COMMENT ON FUNCTION meta.record_page_scan(bigint, int, text, text, int, int,
                                          boolean, int, int, bytea, text) IS
  '页级扫描证据记录器。**证据永不静默丢弃**:run_id 为 NULL 时自动创建 source=''synthetic'' / '
  'status=''running'' 的合成 run(每会话一个)并 RAISE WARNING,而不是像初版那样 RETURN 走掉。'
  '合成 run 的 coverage_ratio 恒为 NULL ⇒ apply_page_life 的删除推断门控必然拒绝,'
  '所以「补上证据」不会顺带把「授权推断」也补上。'
  'CI/回填可 SET scpper.require_run_id=''on'' 转为硬失败(22004)。'
  '本函数写 meta.*,**不受 meta.write_freeze 冻结影响** —— 冻结的是写入,不是采集。';


-- =====================================================================================
-- 2. 游标安全机制(设计 §5.5)
-- =====================================================================================
-- 问题:现实是多写者(sync CLI concurrency=4、Phase C concurrency=2、直连 sweep),
--       「seq 分配即提交顺序」不成立 —— 先取 seq 后提交的事务会被游标跳过,静默漏投影。
--
-- 设计 §5.5 的机制是:摄入事务在分配任何 seq 之前 INSERT meta.ingest_gate(txid, seq_floor),
-- 提交前 DELETE;projector 的安全水位 = min(seq_floor)-1。
--
-- 【本文件对 §5.5 的实现修正 —— 必读】
--   MVCC 下,一个未提交事务 INSERT 的 ingest_gate 行对 projector **不可见**。
--   也就是说 min(seq_floor) 永远看不到「正在飞行中」的摄入事务,而那恰恰是要防的对象。
--   §5.5 的表机制在同一事务内 INSERT+DELETE 时,其可观测效果恒等于「什么都没做」。
--
--   本文件因此把权威机制换成 **advisory lock 屏障**(非 MVCC,跨会话立即可见):
--     * 摄入事务在分配任何 seq 之前取 pg_advisory_xact_lock_shared(gate_key),持到提交。
--     * projector 取同 key 的 EXCLUSIVE:能拿到 ⇒ 此刻没有任何摄入事务持有「已分配未提交」
--       的 seq ⇒ 此刻的 fact_seq.last_value 是一个**绝对安全**的水位。读完立即释放。
--   代价:projector 计算水位的那一瞬间会挡住新摄入事务开始(微秒级);长事务(冷回填)
--   会推迟水位前进 —— 与 min(seq_floor) 语义完全一致,不是新增代价。
--
--   meta.ingest_gate 表仍然维护,并在 safe_seq_watermark() 里以 LEAST() 参与计算:
--   它服务的是「用独立控制连接登记 gate」这种用法(此时行已提交、跨会话可见),
--   并给崩溃后的取证留痕。两种机制取交集,永远不会比单用一种更宽松。
-- -------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION meta.ingest_gate_open()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_floor bigint;
BEGIN
  -- 屏障锁:必须在本事务分配任何 nextval('ingest.fact_seq') 之前拿到。
  -- 事务级 + 共享:同事务重复调用无害(锁计数),提交/回滚自动释放,永不泄漏。
  PERFORM pg_advisory_xact_lock_shared(meta.lock_key_ingest_gate());

  v_floor := COALESCE(pg_sequence_last_value('ingest.fact_seq'::regclass), 0);

  -- 表登记:同事务内不可见于他人,仅为崩溃取证与「独立控制连接」用法留接口。
  INSERT INTO meta.ingest_gate(txid, seq_floor, started_at)
  VALUES (txid_current(), v_floor, now())
  ON CONFLICT (txid) DO NOTHING;

  RETURN v_floor;
END;
$$;
COMMENT ON FUNCTION meta.ingest_gate_open() IS
  '摄入事务入口:取 gate 屏障共享锁(事务级)并登记 seq_floor。'
  '必须在分配任何 fact_seq 之前调用 —— 所有 apply_* 函数第一行都调它,幂等。';

CREATE OR REPLACE FUNCTION meta.ingest_gate_close()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM meta.ingest_gate WHERE txid = txid_current();
  -- 屏障锁是事务级的,提交/回滚时由 PG 自动释放,这里不能也不需要手工放。
END;
$$;
COMMENT ON FUNCTION meta.ingest_gate_close() IS
  '摄入事务出口(可选):清掉本事务的 gate 登记行。'
  '同事务内 INSERT+DELETE 对外恒等于无操作;真正起作用的是事务级屏障锁。';

CREATE OR REPLACE FUNCTION meta.ingest_gate_sweep()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_n int;
BEGIN
  -- 只清理「已结束的事务」留下的行(独立控制连接用法下才可能出现)。
  -- txid_status 对过老的 xid 返回 NULL —— 那也是已结束,一并清理。
  DELETE FROM meta.ingest_gate g
  WHERE COALESCE(txid_status(g.txid), 'committed') <> 'in progress';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION meta.safe_seq_watermark(p_retry int DEFAULT 3, p_wait_ms int DEFAULT 100)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_got   boolean := false;
  v_seq   bigint;
  v_table bigint;
  i       int;
BEGIN
  -- 屏障:拿到 EXCLUSIVE ⇒ 此刻无人持有「已分配未提交」的 seq。
  FOR i IN 1..GREATEST(p_retry, 1) LOOP
    v_got := pg_try_advisory_lock(meta.lock_key_ingest_gate());
    EXIT WHEN v_got;
    PERFORM pg_sleep(GREATEST(p_wait_ms, 0) / 1000.0);
  END LOOP;

  -- 拿不到锁 ⇒ 摄入侧一直忙。返回 NULL 表示「本轮不推进游标」,而不是猜一个水位。
  IF NOT v_got THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_seq := COALESCE(pg_sequence_last_value('ingest.fact_seq'::regclass), 0);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_advisory_unlock(meta.lock_key_ingest_gate());
    RAISE;
  END;
  PERFORM pg_advisory_unlock(meta.lock_key_ingest_gate());

  -- 与表机制取交集(独立控制连接登记的 gate 行在此可见)
  SELECT min(g.seq_floor) INTO v_table
  FROM meta.ingest_gate g
  WHERE COALESCE(txid_status(g.txid), 'committed') = 'in progress';

  -- 下钳到 0:全新库上 fact_seq 还没被用过 ⇒ ingest_gate_open 登记的 seq_floor = 0
  -- ⇒ LEAST(...) 会算出 **-1**。负水位本身无害(下游都是 seq <= watermark 的比较,
  -- 而 seq 从 1 起),但它会让「水位」这个量在日志/监控里出现物理上不存在的取值,
  -- 也让任何按无符号/非负假设写的下游代码埋一颗雷。0 的语义恰好正确:「还没有任何
  -- seq 是安全的」。(整合试跑在全新库上实测到 -1,老库因序列已被用过而看不到。)
  RETURN GREATEST(LEAST(v_seq, COALESCE(v_table - 1, v_seq)), 0);
END;
$$;
COMMENT ON FUNCTION meta.safe_seq_watermark(int, int) IS
  '游标安全水位:小于等于该 seq 的事实全部已提交且永久可见。'
  '返回 NULL = 摄入侧持续繁忙、本轮不推进游标(绝不猜水位)。'
  'projector 的统一模式:advisory lock → 读 seq 窗口(≤ 本水位)→ 折叠 → 同事务推进游标。';

CREATE OR REPLACE FUNCTION meta.projection_window(p_projection text)
RETURNS TABLE (from_seq bigint, to_seq bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_last bigint;
  v_mark bigint;
BEGIN
  SELECT c.last_seq INTO v_last FROM meta.projection_cursor c WHERE c.projection = p_projection;
  IF NOT FOUND THEN
    RAISE EXCEPTION '未声明的投影 %(必须先在 meta.projection_cursor 登记 rebuild_from)', p_projection
      USING ERRCODE = '23503';
  END IF;

  v_mark := meta.safe_seq_watermark();
  IF v_mark IS NULL OR v_mark <= v_last THEN
    RETURN;                     -- 空窗口:无新事实或水位拿不到
  END IF;

  from_seq := v_last + 1;
  to_seq   := v_mark;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION meta.advance_projection_cursor(p_projection text, p_to_seq bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_mark bigint;
  v_new  bigint;
BEGIN
  v_mark := meta.safe_seq_watermark();
  IF v_mark IS NULL THEN
    RAISE EXCEPTION '无法取得安全水位,拒绝推进游标 %', p_projection USING ERRCODE = '55006';
  END IF;

  -- 双重钳制:既不越过调用方声称已消费的位置,也绝不越过安全水位。
  -- 这一条是「静默漏投影在机制上不可能」的落点。
  UPDATE meta.projection_cursor
     SET last_seq = GREATEST(last_seq, LEAST(p_to_seq, v_mark)),
         updated_at = now()
   WHERE projection = p_projection
  RETURNING last_seq INTO v_new;

  IF NOT FOUND THEN
    RAISE EXCEPTION '未声明的投影 %', p_projection USING ERRCODE = '23503';
  END IF;
  RETURN v_new;
END;
$$;

COMMIT;


-- =====================================================================================
-- 3. 不可变触发器(设计 §4.3 / §4.8-5)
-- =====================================================================================
-- 事实一经写入不可篡改;修正只能以补偿事件表达。
-- 三种守卫:
--   3.1 fn_fact_immutable  纯 append-only 事实表:UPDATE / DELETE 一律拒绝
--   3.2 fn_revision_immutable  revision 专用:wid / type / source_sha 三列白名单单向后补
--   3.3 fn_scd2_guard  SCD2 表(page_attr_history / page_slug_history):只允许关区间
-- 另加 BEFORE TRUNCATE 语句级守卫 —— 行级触发器对 TRUNCATE 完全不生效,
-- 而 TRUNCATE 恰恰是最容易「一条命令抹掉全部事实」的操作。
-- 唯一放行口:meta.is_migration_context()(migration_role 或 scpper.bypass_guard)。
--
-- ⚠ 版本要求:ingest.vote_event 是分区表,在父表上建 BEFORE ... FOR EACH ROW 触发器
--   需要 PostgreSQL ≥ 13(PG12 及以下会报 "BEFORE row triggers are not supported on
--   partitioned tables")。若目标实例低于 13,把 trg_immutable 逐分区挂载
--   (用下面第二个 DO 块的同样写法遍历 pg_inherits),并把「新建分区时补挂触发器」
--   写进分区滚动脚本 —— 漏挂一个分区 = 那段 seq 区间的事实可被任意改写。
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 3.1 纯 append-only 事实表守卫
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ingest.fn_fact_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF meta.is_migration_context() THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION
    '% 是 append-only 事实表,禁止 %(修正请追加 source=''reconcile'' 的补偿事件)',
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP
    USING ERRCODE = '25006';   -- read_only_sql_transaction:语义最接近「此处只读」
END;
$$;

CREATE OR REPLACE FUNCTION ingest.fn_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF meta.is_migration_context() THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION
    '禁止 TRUNCATE %(事实表是 serve 投影的唯一重建来源;行级触发器对 TRUNCATE 不生效,'
    '所以必须有这条语句级守卫)', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
    USING ERRCODE = '25006';
END;
$$;

-- -------------------------------------------------------------------------------------
-- 3.2 revision 列白名单(设计 §4.3 / §5.5)
-- -------------------------------------------------------------------------------------
-- 直连(source='wikidot')先落无 wid 的待补行,CROM 行后到时按 (page_id, rev_no) 认领并
-- 回填 wikidot_revision_id / type / source_sha 三列。放行条件全部满足才允许:
--   ① 处在 apply_revision_batch 的受控上下文里(GUC scpper.revision_backfill='on';
--      该 GUC 由 apply_revision_batch 用 set_config(...,is_local:=true) 只在回填那一条
--      UPDATE 前后开合,见 7.1 的「放行窗口」注释 —— 不是函数级 SET 子句,那在 PG15+
--      需要 superuser 才建得出来)
--   ② 白名单外的任何一列都没变(用 to_jsonb 全列对比,新增列自动纳入保护,不会漏)
--   ③ 三列都是 NULL→值 的单向后补,不允许改写已有值
-- 防的 bug:上游 index 竞态导致的同 (page,rev_no) 不同 wid 被 DO UPDATE 静默合并成一条,
--          以及 P2-5 的 type 跨源冲突(中文 flag 失配)覆盖掉先到的正确值。
CREATE OR REPLACE FUNCTION ingest.fn_revision_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_whitelist text[] := ARRAY['wikidot_revision_id','type','source_sha'];
BEGIN
  IF meta.is_migration_context() THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ingest.revision 是 append-only,禁止 DELETE' USING ERRCODE = '25006';
  END IF;

  IF COALESCE(current_setting('scpper.revision_backfill', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'ingest.revision 禁止直接 UPDATE;wid/type/source_sha 的后补只能经 '
      'ingest.apply_revision_batch(它会 SET LOCAL scpper.revision_backfill=''on'')'
      USING ERRCODE = '25006';
  END IF;

  IF (to_jsonb(NEW) - v_whitelist) IS DISTINCT FROM (to_jsonb(OLD) - v_whitelist) THEN
    RAISE EXCEPTION
      'ingest.revision 后补只允许改 %,本次 UPDATE 触碰了白名单外的列(seq=%)',
      array_to_string(v_whitelist, '/'), OLD.seq
      USING ERRCODE = '25006';
  END IF;

  IF OLD.wikidot_revision_id IS NOT NULL
     AND NEW.wikidot_revision_id IS DISTINCT FROM OLD.wikidot_revision_id THEN
    RAISE EXCEPTION 'wikidot_revision_id 只允许 NULL→值 的单向后补(seq=%)', OLD.seq
      USING ERRCODE = '25006';
  END IF;
  IF OLD.type IS NOT NULL AND NEW.type IS DISTINCT FROM OLD.type THEN
    IF OLD.type <> 'unknown'
       OR NEW.type IS NULL
       OR NEW.type = 'unknown' THEN
      RAISE EXCEPTION
        'revision.type 只允许 NULL/unknown→具体值的单向后补;跨源冲突必须进 '
        'meta.fact_quarantine 而不是覆盖(seq=%)', OLD.seq
        USING ERRCODE = '25006';
    END IF;
  END IF;
  IF OLD.source_sha IS NOT NULL AND NEW.source_sha IS DISTINCT FROM OLD.source_sha THEN
    RAISE EXCEPTION 'revision.source_sha 只允许 NULL→值 的单向后补(seq=%)', OLD.seq
      USING ERRCODE = '25006';
  END IF;

  RETURN NEW;
END;
$$;

-- -------------------------------------------------------------------------------------
-- 3.3 SCD2 守卫(page_attr_history / page_slug_history)
-- -------------------------------------------------------------------------------------
-- SCD2 的合法写入只有两种:开新行(INSERT)、关旧行(UPDATE valid_to: NULL→值)。
-- 任何「就地改历史区间的值」都是在伪造历史。
CREATE OR REPLACE FUNCTION ingest.fn_scd2_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF meta.is_migration_context() THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% 是 SCD2 历史表,禁止 DELETE', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
      USING ERRCODE = '25006';
  END IF;

  IF (to_jsonb(NEW) - ARRAY['valid_to']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['valid_to']) THEN
    RAISE EXCEPTION '% 只允许 UPDATE valid_to(关区间),不得就地改写历史值',
      TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME USING ERRCODE = '25006';
  END IF;

  IF OLD.valid_to IS NOT NULL THEN
    RAISE EXCEPTION '% 的区间已关闭,不得重开或改写 valid_to',
      TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME USING ERRCODE = '25006';
  END IF;

  RETURN NEW;
END;
$$;

-- -------------------------------------------------------------------------------------
-- 3.4 挂载(可重复执行:DROP IF EXISTS + CREATE)
-- -------------------------------------------------------------------------------------
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ingest.vote_event',        'ingest.fn_fact_immutable'),
      ('ingest.attribution_event', 'ingest.fn_fact_immutable'),
      ('ingest.page_life_event',   'ingest.fn_fact_immutable'),
      ('ingest.page_source',       'ingest.fn_fact_immutable'),
      ('ingest.content_blob',      'ingest.fn_fact_immutable'),
      ('ingest.revision',          'ingest.fn_revision_immutable'),
      ('ingest.page_attr_history', 'ingest.fn_scd2_guard'),
      ('ingest.page_slug_history', 'ingest.fn_scd2_guard')
    ) AS t(tbl, fn)
  LOOP
    IF to_regclass(r.tbl) IS NULL THEN
      RAISE EXCEPTION '缺表 %(0001_ingest.sql 未执行或不完整)', r.tbl;
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS trg_immutable ON %s', r.tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_immutable BEFORE UPDATE OR DELETE ON %s '
      'FOR EACH ROW EXECUTE FUNCTION %s()', r.tbl, r.fn);

    EXECUTE format('DROP TRIGGER IF EXISTS trg_no_truncate ON %s', r.tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_no_truncate BEFORE TRUNCATE ON %s '
      'FOR EACH STATEMENT EXECUTE FUNCTION ingest.fn_no_truncate()', r.tbl);
  END LOOP;
END
$do$;

-- ⚠ vote_event 是分区表:BEFORE ROW 触发器建在父表上会自动传播到所有分区(PG13+),
--   但 TRUNCATE 语句级触发器不会传播 —— 直接 TRUNCATE 某个分区仍可绕过。
--   补挂到每个现存分区,并在滚动新建分区时一并挂(写进分区滚动脚本)。
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass::text AS tbl
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'ingest.vote_event'::regclass
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_no_truncate ON %s', r.tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_no_truncate BEFORE TRUNCATE ON %s '
      'FOR EACH STATEMENT EXECUTE FUNCTION ingest.fn_no_truncate()', r.tbl);
  END LOOP;
END
$do$;

COMMIT;


-- =====================================================================================
-- 4. 身份层函数(设计 §4.2 / §5.1)
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 4.0 新身份的 id 分配序 + R12 的 wikidot_unix_name 列
-- -------------------------------------------------------------------------------------
-- ingest.page.id / ingest."user".id 原样保留 V1 值域(gacha 跨库软外键的硬承诺),
-- 所以没有 DEFAULT。v2 新铸的身份从这两条序列继续分配。
-- ⚠ Phase 2 回填结束后必须把这两条序列的水位抬到 v1 上界之上,否则新页会撞已占用 id。
--   **动作已落地为可执行文件: checks/backfill_finalize.sql(TODO #7)。**
--   下面这两行是它的前身,保留只为记录错在哪 —— 不要照抄:
--     SELECT setval('ingest.page_id_seq',      (SELECT max(id) FROM ingest.page));
--     SELECT setval('ingest.user_id_seq',      (SELECT max(id) FROM ingest."user"));
--   两个 bug(2026-07-27 实测):
--     ① 空表上 max(id) 为 NULL ⇒ setval(seq, NULL) ⇒ 22004。
--     ② 水位已高于 max(id) 时这是**下调**(冒烟测试会把 page_id_seq 推到 14 而表里一行不留,
--        实测就是这个状态)。下调后 nextval 会重发那些曾被分配、只因事务回滚才没落库的 id。
--        唯一性上不冲突,但「id 永不重排/复用」这条对外承诺就多了一条例外。
--   backfill_finalize.sql 用 target = GREATEST(max(id), 已交付的最高值) 单调上调,
--   并在重置后断言「水位 >= max(id)」与「水位之上无已占用 id」。
--   另: 0100_backfill_gate.sql §3 把这两条序列由默认 bigint 收窄为 `AS integer`
--   (两张表的 id 都是 int,而这里是 nextval(...)::int) —— 让越界的 setval 当场被拒,
--   而不是推迟到某次真实 register_page 上炸 22003。
CREATE SEQUENCE IF NOT EXISTS ingest.page_id_seq;
CREATE SEQUENCE IF NOT EXISTS ingest.user_id_seq;

-- 【修订 R12】0001_ingest.sql 显式把这一列留给 0006。
-- 【2026-07-27 实测·P1-2】v1 的 user.username 35,722 个非空值里 32,808(91.8%)是
-- UserDataCompletenessJob 用 lower(replace(display_name,' ','_')) 捏造的伪 slug,
-- 而下游账号绑定正依赖那个格式。直连拿到的真实 unixName 写进本列,不许覆盖 username ——
-- 「补齐 username 是净增益」这个三份调研的共同结论是错的,覆盖等于打断绑定匹配。
ALTER TABLE ingest."user" ADD COLUMN IF NOT EXISTS wikidot_unix_name text;
COMMENT ON COLUMN ingest."user".wikidot_unix_name IS
  '【修订 R12】直连解析到的真实 wikidot unixName(%%created_by_unix%% / printuser)。'
  '与 username(v1 伪造 slug,下游绑定依赖其格式)并存,BFF 绑定匹配扩为四路后再考虑切主。';

-- -------------------------------------------------------------------------------------
-- 4.1 register_page —— 身份注册(10 函数之一)
-- -------------------------------------------------------------------------------------
-- 幂等:同 wikidot_id 重复调用返回既有 page_id,零写入。
-- 一个 page.id = 一段 wikidotId 生命周期;删除后以新 wikidotId 重建 = 新 page 行。
CREATE OR REPLACE FUNCTION ingest.register_page(
  p_wikidot_id int,
  p_slug       text,
  p_observed   timestamptz DEFAULT now(),
  p_source     text        DEFAULT 'wikidot',
  p_page_id    int         DEFAULT NULL,      -- 迁移期指定 v1 Page.id;日常留空自动分配
  p_created_at timestamptz DEFAULT NULL,      -- 站上创建时刻(有则落 exact 的 created 事件)
  p_run        bigint      DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_page int;
BEGIN
  IF p_wikidot_id IS NULL THEN
    RAISE EXCEPTION 'register_page 必须带 wikidot_id(设计 §5.1 协议硬性条款)'
      USING ERRCODE = '22004';
  END IF;
  IF p_slug IS NULL OR p_slug = '' THEN
    RAISE EXCEPTION 'register_page 必须带 slug(fullname,含 category 前缀)'
      USING ERRCODE = '22004';
  END IF;

  -- 【0007 增补】R10 熔断的物理开关:被冻结的域一律 PGF01,先于任何写入与锁。
  --   冻结的是写入,不是采集 —— meta.* 的证据链(ingest_run/page_scan/scan_task/quarantine)不受影响。
  PERFORM meta.assert_writes_allowed('identity');
  PERFORM meta.ingest_gate_open();

  -- 已注册 ⇒ 直接返回。slug 变更走 apply_page_meta(那里才有 SCD2 + renamed 事件),
  -- 这里绝不「顺手」改 slug:register_page 是幂等的身份查询/铸造,不是元数据入口。
  SELECT id INTO v_page FROM ingest.page WHERE wikidot_id = p_wikidot_id;
  IF FOUND THEN
    IF p_page_id IS NOT NULL AND p_page_id <> v_page THEN
      RAISE EXCEPTION
        'wikidot_id=% 已绑定 page_id=%,与传入的 page_id=% 冲突(id 永不重排/复用)',
        p_wikidot_id, v_page, p_page_id USING ERRCODE = '23505';
    END IF;
    RETURN v_page;
  END IF;

  -- 同 wikidot_id 的并发注册:advisory lock 收口,避免两个 run 同时铸身份
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_wikidot_id);
  SELECT id INTO v_page FROM ingest.page WHERE wikidot_id = p_wikidot_id;
  IF FOUND THEN
    RETURN v_page;
  END IF;

  -- 0204 把 page_id_seq 单调抬到 v2 保留段；迁移 top-up 传 p_page_id 保留 v1 原 id，
  -- 普通自铸绝不能再从仍增长的 v1 当前上界旁边继续。
  v_page := COALESCE(p_page_id, nextval('ingest.page_id_seq')::int);

  INSERT INTO ingest.page(id, wikidot_id, created_at) VALUES (v_page, p_wikidot_id, now());

  INSERT INTO ingest.page_slug_history(page_id, slug, valid_from, valid_to)
  VALUES (v_page, p_slug, COALESCE(p_created_at, p_observed), NULL);

  -- page_current 必须在同事务内出现:所有 apply_* 的聚合列更新都指向它,
  -- 缺行会让 rating/vote_up 的增量静默丢失(v1 PageStats 6,706 孤儿 + 11,593 缺行的同型病根)。
  INSERT INTO serve.page_current(page_id, wikidot_id, slug, status, first_published_at,
                                 cursor_seq, updated_at)
  VALUES (v_page, p_wikidot_id, p_slug, 'live', p_created_at, 0, now())
  ON CONFLICT (page_id) DO NOTHING;

  INSERT INTO ingest.page_life_event(page_id, kind, occurred_at, occurred_precision,
                                     observed_at, source)
  VALUES (v_page, 'created', COALESCE(p_created_at, p_observed),
          CASE WHEN p_created_at IS NOT NULL THEN 'exact' ELSE 'inferred' END,
          p_observed, p_source);

  RETURN v_page;
END;
$$;
COMMENT ON FUNCTION ingest.register_page(int, text, timestamptz, text, int, timestamptz, bigint) IS
  '身份注册(幂等)。返回 page_id。同时铸 page / page_slug_history 开区间 / serve.page_current 行 '
  '/ page_life_event(created)。slug 后续变更走 apply_page_meta,不在这里改。';

-- -------------------------------------------------------------------------------------
-- 4.2 ensure_user —— 身份铸造/更新(10 函数之一;bff_role 也有 EXECUTE 权限)
-- -------------------------------------------------------------------------------------
-- 收编身份形态:wikidot / deleted / guest(论坛)/ synthetic(BFF 收藏夹合成)/ anon(匿名署名)。
-- 事实表 actor 一律 NOT NULL —— 匿名是真实 user 行而非 NULL,
-- 「NULLS DISTINCT 放行重复」这一整类漏洞在此根除。
CREATE OR REPLACE FUNCTION ingest.ensure_user(
  p_kind         text,
  p_wikidot_id   int  DEFAULT NULL,
  p_anon_key     text DEFAULT NULL,
  p_display_name text DEFAULT NULL,
  p_username     text DEFAULT NULL,
  p_unix_name    text DEFAULT NULL,   -- 【R12】真实 unixName,写 wikidot_unix_name 不碰 username
  p_user_id      int  DEFAULT NULL    -- 迁移期指定 v1 User.id
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id  int;
  v_key text;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('wikidot','deleted','guest','anon','synthetic') THEN
    RAISE EXCEPTION 'ensure_user: 非法 kind %(wikidot|deleted|guest|anon|synthetic)', p_kind
      USING ERRCODE = '22023';
  END IF;
  IF p_kind IN ('wikidot','deleted') AND COALESCE(p_wikidot_id, 0) <= 0 THEN
    RAISE EXCEPTION 'ensure_user: kind=% 必须带正的 wikidot_id(拿到的是 %)', p_kind, p_wikidot_id
      USING ERRCODE = '22004';
  END IF;
  -- 设计取舍 #14:投票域禁止无原始 anonKey 的匿名票铸行 —— 由名字派生的 key 会把两个
  -- 同名者合并成一个身份,署名域可接受,投票域绝不可接受。没有 key 就该进 quarantine。
  IF p_kind = 'anon' AND (p_anon_key IS NULL OR p_anon_key = '') THEN
    RAISE EXCEPTION 'ensure_user: kind=anon 必须带上游原始 anon_key(不得由 display_name 派生)'
      USING ERRCODE = '22004';
  END IF;
  IF p_kind = 'guest' AND (p_anon_key IS NULL OR p_anon_key = '') THEN
    -- guest 的 key 允许由名字派生('guest:'||name),同名合并是文档化的已知限制
    IF p_display_name IS NULL OR p_display_name = '' THEN
      RAISE EXCEPTION 'ensure_user: kind=guest 需要 anon_key 或 display_name'
        USING ERRCODE = '22004';
    END IF;
    p_anon_key := 'guest:' || p_display_name;
  END IF;

  -- 【0007 增补】R10 熔断:身份铸造也算写入(解析变形时会铸出一堆垃圾 user 行)。
  PERFORM meta.assert_writes_allowed('identity');

  -- 查:wikidot_id 优先,其次 anon_key
  IF p_wikidot_id IS NOT NULL AND p_wikidot_id > 0 THEN
    SELECT id INTO v_id FROM ingest."user" WHERE wikidot_id = p_wikidot_id;
  END IF;
  IF v_id IS NULL AND p_anon_key IS NOT NULL THEN
    SELECT id INTO v_id FROM ingest."user" WHERE anon_key = p_anon_key;
  END IF;

  IF v_id IS NULL THEN
    -- 并发铸造收口(同 key 串行化)
    v_key := COALESCE('w:' || p_wikidot_id::text, 'k:' || p_anon_key, 'n:' || p_display_name);
    PERFORM pg_advisory_xact_lock(meta.lock_class_page() + 1, hashtext(v_key));

    IF p_wikidot_id IS NOT NULL AND p_wikidot_id > 0 THEN
      SELECT id INTO v_id FROM ingest."user" WHERE wikidot_id = p_wikidot_id;
    END IF;
    IF v_id IS NULL AND p_anon_key IS NOT NULL THEN
      SELECT id INTO v_id FROM ingest."user" WHERE anon_key = p_anon_key;
    END IF;
  END IF;

  IF v_id IS NULL THEN
    -- 0204 把 user_id_seq 单调抬到匿名/guest/synthetic/v2 新用户保留段。
    -- v1 top-up 传 p_user_id；未显式指定的身份永远不再消费 v1 移动值域。
    v_id := COALESCE(p_user_id, nextval('ingest.user_id_seq')::int);
    INSERT INTO ingest."user"(id, kind, wikidot_id, anon_key, username, display_name,
                              wikidot_unix_name, created_at)
    VALUES (v_id, p_kind,
            NULLIF(GREATEST(COALESCE(p_wikidot_id, 0), 0), 0),   -- wid<=0 一律当「无 id」
            p_anon_key, p_username, p_display_name, p_unix_name, now());
    RETURN v_id;
  END IF;

  -- 已存在:显示字段只补不覆盖。wikidot/deleted 是同一稳定 wid 的当前可见类型，
  -- WhoRated 再次观察到账号注销/恢复时允许二者互转；否则 visible_kinds=['wikidot']
  -- 无法把已删账号排除在 absence diff 之外。
  -- username 的只补不覆盖是 R12 的核心:BFF 账号绑定正依赖 v1 那套伪造格式,
  -- 直连的真实 unixName 走 wikidot_unix_name 另存。
  UPDATE ingest."user" u
     SET kind              = CASE
                               WHEN u.kind IN ('wikidot','deleted')
                                AND p_kind IN ('wikidot','deleted')
                               THEN p_kind
                               ELSE u.kind
                             END,
         display_name      = COALESCE(p_display_name, u.display_name),
         username          = COALESCE(u.username, p_username),
         wikidot_unix_name = COALESCE(p_unix_name, u.wikidot_unix_name)
   WHERE u.id = v_id
     AND (CASE
            WHEN u.kind IN ('wikidot','deleted') AND p_kind IN ('wikidot','deleted')
            THEN p_kind ELSE u.kind
          END IS DISTINCT FROM u.kind
       OR COALESCE(p_display_name, u.display_name) IS DISTINCT FROM u.display_name
       OR COALESCE(u.username, p_username)         IS DISTINCT FROM u.username
       OR COALESCE(p_unix_name, u.wikidot_unix_name) IS DISTINCT FROM u.wikidot_unix_name);

  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION ingest.ensure_user(text, int, text, text, text, text, int) IS
  '身份铸造/更新(幂等),返回 user_id。BFF / 论坛 / 署名铸用户统一走它,不再裸 INSERT。'
  'kind=deleted 必须带 WhoRated 原始 data-id,与同 wid 的 wikidot 行原地互转;'
  'kind=anon 必须带上游原始 anon_key(投票域禁止名字派生 key,设计取舍 #14);'
  'username 只补不覆盖(修订 R12);真实 unixName 写 wikidot_unix_name。';

COMMIT;


-- =====================================================================================
-- 5. 元数据与生死(设计 §5.5)
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 5.0 内容寻址写入(内部helper;调用方不得裸 INSERT content_blob)
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ingest.put_content_blob(
  p_source_text text,
  p_text_content text DEFAULT NULL
)
RETURNS bytea
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_sha bytea;
BEGIN
  IF p_source_text IS NULL AND p_text_content IS NULL THEN
    RETURN NULL;
  END IF;

  -- 【0007 增补】R10 熔断:内容入库也是写入。解析变形最典型的产物就是「整站源码变成空串
  -- 或变成一段导航栏 HTML」,那时候最不该做的事情就是把它内容寻址存进来当新版本。
  PERFORM meta.assert_writes_allowed('content');

  -- sha256 只对 wikitext 原文取:同一份源码在不同时刻渲染出的文本可能因模板变化而不同,
  -- 若把渲染文本也纳入摘要,会把「模板改了」误报成「页面源码改了」并触发无谓的区间切换。
  --
  -- ⚠【2026-07-27 整合修正】原实现是 pgcrypto 的 digest(text,'sha256'),有两个问题:
  --   ① 本函数 SET search_path = pg_catalog, pg_temp,而 pgcrypto 装在 public ⇒
  --      unqualified digest() 在函数体内**永远解析不到**,每次调用都 42883。
  --      (这类 bug 不会在 CREATE FUNCTION 时暴露:plpgsql 体内的 SQL 是首次执行才解析的。)
  --   ② digest(text,...) 摘要的是「服务器编码下的字节」,与 TS 侧
  --      crypto.createHash('sha256').update(s,'utf8') 只在库编码恰好是 UTF8 时一致 ——
  --      而 put_content_blob_sha() 变体正是让 TS 侧算 sha 传进来的,两条路必须同源。
  -- 改用内建 sha256(bytea)(PG11+,在 pg_catalog 里,零扩展依赖)+ 显式 convert_to UTF8,
  -- 于是 ①② 同时消失:两个变体对同一字符串必然给出同一个 sha。
  v_sha := sha256(convert_to(COALESCE(p_source_text, ''), 'UTF8'));

  INSERT INTO ingest.content_blob(sha256, source, text_content, byte_len, text_len, created_at)
  VALUES (v_sha, p_source_text, p_text_content,
          octet_length(COALESCE(p_source_text, '')),
          COALESCE(length(p_text_content), 0), now())
  ON CONFLICT (sha256) DO NOTHING;

  RETURN v_sha;
END;
$$;
COMMENT ON FUNCTION ingest.put_content_blob(text, text) IS
  '内容寻址入库(幂等)。返回 sha256 = sha256(convert_to(source_wikitext, ''UTF8''))。'
  '用内建 sha256(bytea)(PG11+),**无 pgcrypto 依赖**;与 put_content_blob_sha() 变体同源,'
  '即 TS 侧 crypto.createHash(''sha256'').update(s,''utf8'') 得到同一个 sha。';

-- 变体:sha 由调用方(TS 侧 crypto)算好传入,省掉一次服务端全文哈希。
-- 摘要口径必须与上面一致:sha256(utf8_bytes(source_wikitext))。
CREATE OR REPLACE FUNCTION ingest.put_content_blob_sha(
  p_sha bytea,
  p_source_text text,
  p_text_content text DEFAULT NULL
)
RETURNS bytea
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_sha IS NULL OR octet_length(p_sha) <> 32 THEN
    RAISE EXCEPTION 'put_content_blob_sha: sha 必须是 32 字节 sha256' USING ERRCODE = '22023';
  END IF;
  PERFORM meta.assert_writes_allowed('content');   -- 【0007 增补】与 put_content_blob 同域
  INSERT INTO ingest.content_blob(sha256, source, text_content, byte_len, text_len, created_at)
  VALUES (p_sha, p_source_text, p_text_content,
          octet_length(COALESCE(p_source_text, '')),
          COALESCE(length(p_text_content), 0), now())
  ON CONFLICT (sha256) DO NOTHING;
  RETURN p_sha;
END;
$$;

-- -------------------------------------------------------------------------------------
-- 5.1 apply_page_meta —— 元数据观测(10 函数之一)
-- -------------------------------------------------------------------------------------
-- p_attrs 形状(**只处理出现的 key**;缺 key = 本次未观测 = 不比较不覆盖):
--   {
--     "slug": "scp-cn-1000",                -- fullname,变了会开 slug 区间 + renamed 事件
--     "title": "...", "alternate_title": "...",
--     "tags": ["scp","cn"], "hidden_tags": ["_image"],   -- 两者合并去重排序后才是 tags 的值
--     "category": "_default",
--     "parent": {"page_id": 123, "slug": "..."},
--     "first_published_at": "2020-01-01T00:00:00Z",
--     "discussion_thread_id": 987654,
--     "comment_count": 12,
--     "source_wikitext": "...", "text_content": "...",   -- 有则内容寻址入库
--     "source_sha": "<hex>",                             -- 或直接给已入库的 sha
--     "rev_no": 34,                                      -- 有则同时落 page_source
--     "claimed_rating": 42, "claimed_vote_count": 50     -- 只落 page_scan 证据,绝不写 rating
--   }
-- 硬红线:rating / vote_up / vote_down / vote_revoked 不由本函数写。
--   聚合值只能由 vote_event 折叠产生(设计 §10-#7:v1 有 6 处 rating 真相源,fast-vote
--   直写聚合列还致盲了脏页检测)。claimed_* 只作为对账证据进 meta.page_scan。
-- revision_count 同理只能由 ingest.revision 折叠，保存包含 revision 0 的真实行数；
-- Tier1 零基远端声明值由采集器另写 page_scan(kind='revisions',status='partial')，
-- 两者恒差 offset(1)，不得经 p_attrs 覆盖本地事实。
CREATE OR REPLACE FUNCTION ingest.apply_page_meta(
  p_page       int,
  p_attrs      jsonb,
  p_observed   timestamptz,
  p_source     text,
  p_run        bigint DEFAULT NULL,
  p_wikidot_id int    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_attr      text;
  v_val       jsonb;
  v_cur       jsonb;
  v_changes   int := 0;
  v_changed   text[] := '{}';
  v_renamed   boolean := false;
  v_old_slug  text;
  v_new_slug  text;
  v_tags      text[];
  v_sha       bytea;
  v_hit       int;
  v_seq       bigint;  -- M8:page_current 元数据变化给 L2 投影的全局 seq 信号
BEGIN
  IF p_attrs IS NULL OR jsonb_typeof(p_attrs) <> 'object' THEN
    RAISE EXCEPTION 'apply_page_meta: p_attrs 必须是 jsonb object' USING ERRCODE = '22023';
  END IF;

  -- 【0007 增补】R10 熔断的物理开关:被冻结的域一律 PGF01,先于任何写入与锁。
  --   冻结的是写入,不是采集 —— meta.* 的证据链(ingest_run/page_scan/scan_task/quarantine)不受影响。
  PERFORM meta.assert_writes_allowed('page');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  -- 【2026-07-27 实测·P1-6】selector 字面量残留检测。
  -- 无效 selector 被 wikidot 静默保留为 ^%%.+%%$,字段数不变、parts.length 校验发现不了。
  -- 一旦写进 SCD2,得到的是一列恒定垃圾且不可回滚 —— 所以在门口整批拒绝,不做部分应用。
  FOREACH v_attr IN ARRAY ARRAY['slug','title','alternate_title','category','tags','hidden_tags'] LOOP
    IF p_attrs ? v_attr AND ingest.has_selector_residue(p_attrs -> v_attr) THEN
      INSERT INTO meta.fact_quarantine(domain, page_id, natural_key, raw, reason, source,
                                       run_id, observed_at)
      VALUES ('page_meta', p_page, v_attr, p_attrs, 'selector_literal_residue',
              p_source, p_run, p_observed);
      PERFORM meta.record_page_scan(p_run, p_page, 'meta', 'failed', NULL, NULL,
                                    NULL, NULL, NULL, NULL,
                                    'selector 字面量残留于 ' || v_attr);
      RAISE EXCEPTION
        'apply_page_meta: 字段 % 是 selector 字面量残留(^%%%%.+%%%%$),抓取层拼错了 selector;'
        '整批拒绝,不做部分应用', v_attr
        USING ERRCODE = '22000';
    END IF;
  END LOOP;

  -- ---- 5.1.a slug 变更 = SCD2 关旧开新 + renamed 事件 -------------------------------
  IF p_attrs ? 'slug' THEN
    v_new_slug := NULLIF(p_attrs ->> 'slug', '');
    SELECT slug INTO v_old_slug
      FROM ingest.page_slug_history
     WHERE page_id = p_page AND valid_to IS NULL;

    IF v_new_slug IS NOT NULL AND v_new_slug IS DISTINCT FROM v_old_slug THEN
      UPDATE ingest.page_slug_history
         SET valid_to = p_observed
       WHERE page_id = p_page AND valid_to IS NULL;

      INSERT INTO ingest.page_slug_history(page_id, slug, valid_from, valid_to)
      VALUES (p_page, v_new_slug, p_observed, NULL);

      INSERT INTO ingest.page_life_event(page_id, kind, occurred_at, occurred_precision,
                                         observed_at, source)
      VALUES (p_page, 'renamed', p_observed, 'inferred', p_observed, p_source)
      RETURNING seq INTO v_seq;

      v_renamed := true;
    END IF;
  END IF;

  -- ---- 5.1.b 五个 SCD2 属性 ---------------------------------------------------------
  FOREACH v_attr IN ARRAY ARRAY['title','alternate_title','tags','category','parent'] LOOP
    -- tags 特例:'tags' 与 'hidden_tags' 任一出现就要重算合并值
    IF v_attr = 'tags' THEN
      CONTINUE WHEN NOT (p_attrs ? 'tags' OR p_attrs ? 'hidden_tags');
      -- 【2026-07-27 实测·P0-4】必须同时取 %%tags%% 与 %%_tags%%:ListPages 的 %%tags%%
      -- 不含 '_' 前缀隐藏标签,而 CROM/主库确实含(2,167 个当前版本)。只取 %%tags%%
      -- 会抹掉标签并触发 2,167 次无谓区间切换 —— v1 时代那正是跨版本重复票的放大器。
      -- 排序 + 去重:顺序敏感的伪变更在此绝迹(设计 §4.3 原话)。
      SELECT COALESCE(jsonb_agg(t ORDER BY t), '[]'::jsonb)
        INTO v_val
        FROM (SELECT DISTINCT jsonb_array_elements_text(
                       COALESCE(p_attrs -> 'tags', '[]'::jsonb)
                    || COALESCE(p_attrs -> 'hidden_tags', '[]'::jsonb)) AS t) s;
    ELSE
      CONTINUE WHEN NOT (p_attrs ? v_attr);
      v_val := COALESCE(p_attrs -> v_attr, 'null'::jsonb);
    END IF;

    SELECT value INTO v_cur
      FROM ingest.page_attr_history
     WHERE page_id = p_page AND attr = v_attr AND valid_to IS NULL;

    -- 未变 ⇒ 零写入(设计 §3 原则 2:状态未转移零事件零写入)。
    -- 这条分支就是「2025-08 式全站重同步造 2.4 万伪版本」在 V2 不可能重演的原因。
    CONTINUE WHEN FOUND AND v_cur IS NOT DISTINCT FROM v_val;

    IF FOUND THEN
      UPDATE ingest.page_attr_history
         SET valid_to = p_observed
       WHERE page_id = p_page AND attr = v_attr AND valid_to IS NULL;
    END IF;

    INSERT INTO ingest.page_attr_history(page_id, attr, value, valid_from, valid_to, source)
    VALUES (p_page, v_attr, v_val, p_observed, NULL,
            CASE WHEN p_source = 'v1_version' THEN 'v1_version' ELSE 'observed' END);

    v_changes := v_changes + 1;
    v_changed := v_changed || v_attr;
  END LOOP;

  -- ---- 5.1.c 内容:sha 寻址 + page_source ------------------------------------------
  IF p_attrs ? 'source_sha' THEN
    v_sha := decode(p_attrs ->> 'source_sha', 'hex');
    IF NOT EXISTS (SELECT 1 FROM ingest.content_blob WHERE sha256 = v_sha) THEN
      RAISE EXCEPTION 'apply_page_meta: source_sha % 尚未入 content_blob(先调 put_content_blob*)',
        p_attrs ->> 'source_sha' USING ERRCODE = '23503';
    END IF;
  ELSIF p_attrs ? 'source_wikitext' THEN
    v_sha := ingest.put_content_blob(p_attrs ->> 'source_wikitext', p_attrs ->> 'text_content');
  END IF;

  IF v_sha IS NOT NULL THEN
    -- page_source 幂等:(page_id, rev_no) 部分唯一;rev_no 为空时按 observed_at 留时间序快照
    IF p_attrs ? 'rev_no' THEN
      INSERT INTO ingest.page_source(page_id, rev_no, blob_sha, observed_at)
      VALUES (p_page, (p_attrs ->> 'rev_no')::int, v_sha, p_observed)
      ON CONFLICT (page_id, rev_no) WHERE rev_no IS NOT NULL DO NOTHING;
    ELSIF NOT EXISTS (
      SELECT 1 FROM ingest.page_source
       WHERE page_id = p_page AND rev_no IS NULL AND blob_sha = v_sha
    ) THEN
      INSERT INTO ingest.page_source(page_id, rev_no, blob_sha, observed_at)
      VALUES (p_page, NULL, v_sha, p_observed);
    END IF;
  END IF;

  -- ---- 5.1.d 同事务刷 page_current(不含投票/修订聚合列)-----------------------------
  IF p_attrs ? 'tags' OR p_attrs ? 'hidden_tags' THEN
    SELECT COALESCE(array_agg(t ORDER BY t), '{}'::text[])
      INTO v_tags
      FROM (SELECT DISTINCT jsonb_array_elements_text(
                     COALESCE(p_attrs -> 'tags', '[]'::jsonb)
                  || COALESCE(p_attrs -> 'hidden_tags', '[]'::jsonb)) AS t) s;
  END IF;

  -- M8 增量投影信号：
  -- page_attr_history 自身没有 fact_seq；若纯 tags/category/first_published_at 更新不分配
  -- 全局 seq，user_page/user_tag_preference 在安全水位窗口里永远看不见这次变化。
  -- 本函数入口已经先调 meta.ingest_gate_open()，所以在这里 nextval 仍受同一套
  -- safe_seq_watermark 屏障保护。rename 已由上面的 page_life_event 取得真实事件 seq，
  -- 不再额外烧一个空洞。
  IF v_seq IS NULL
     AND (
       v_changes > 0
       OR (
         p_attrs ? 'first_published_at'
         AND NULLIF(p_attrs ->> 'first_published_at', '') IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM serve.page_current pc0
            WHERE pc0.page_id = p_page
              AND pc0.first_published_at IS NULL
         )
       )
     ) THEN
    v_seq := nextval('ingest.fact_seq');
  END IF;

  UPDATE serve.page_current pc SET
    slug = COALESCE(v_new_slug, pc.slug),
    title = CASE WHEN p_attrs ? 'title' THEN NULLIF(p_attrs ->> 'title','') ELSE pc.title END,
    alternate_title = CASE WHEN p_attrs ? 'alternate_title'
                           THEN NULLIF(p_attrs ->> 'alternate_title','') ELSE pc.alternate_title END,
    tags = COALESCE(v_tags, pc.tags),
    category = CASE WHEN p_attrs ? 'category' THEN NULLIF(p_attrs ->> 'category','') ELSE pc.category END,
    parent_page_id = CASE WHEN p_attrs ? 'parent'
                          THEN NULLIF(p_attrs #>> '{parent,page_id}','')::int
                          ELSE pc.parent_page_id END,
    -- first_published_at 只补不覆盖:直连/CROM 对老页给的创建时刻不如首次观测可信,
    -- 而它是 users/:id/pages 的 effective_created_at 四层 COALESCE 链的源头,抖动代价高
    first_published_at = COALESCE(pc.first_published_at,
                                  NULLIF(p_attrs ->> 'first_published_at','')::timestamptz),
    discussion_thread_id = CASE WHEN p_attrs ? 'discussion_thread_id'
                                THEN NULLIF(p_attrs ->> 'discussion_thread_id','')::bigint
                                ELSE pc.discussion_thread_id END,
    comment_count = CASE WHEN p_attrs ? 'comment_count'
                         THEN COALESCE(NULLIF(p_attrs ->> 'comment_count','')::int, pc.comment_count)
                         ELSE pc.comment_count END,
    source_sha = COALESCE(v_sha, pc.source_sha),
    search_text = CASE WHEN p_attrs ? 'text_content'
                       THEN NULLIF(p_attrs ->> 'text_content','') ELSE pc.search_text END,
    cursor_seq = GREATEST(pc.cursor_seq, COALESCE(v_seq, pc.cursor_seq)),
    updated_at = now()
  WHERE pc.page_id = p_page;

  GET DIAGNOSTICS v_hit = ROW_COUNT;
  IF v_hit = 0 THEN
    RAISE EXCEPTION 'apply_page_meta: serve.page_current 缺 page_id=% 的行(register_page 未跑完?)',
      p_page USING ERRCODE = '23503';
  END IF;

  -- ---- 5.1.e 远端自报值只作为对账证据 -----------------------------------------------
  -- claimed_rating / claimed_vote_count 绝不写 page_current;它们是 §5.7 收敛流程与
  -- apply_vote_snapshot 第四重门控(A1)的输入,存在 page_scan 上等待比对。
  IF p_attrs ? 'claimed_rating' OR p_attrs ? 'claimed_vote_count' THEN
    PERFORM meta.record_page_scan(
      p_run, p_page, 'meta', 'ok',
      NULLIF(p_attrs ->> 'claimed_vote_count','')::int, NULL,
      NULL, NULLIF(p_attrs ->> 'claimed_rating','')::int, NULL, NULL, NULL);
  END IF;

  RETURN jsonb_build_object(
    'attr_changes', v_changes,
    'changed', to_jsonb(v_changed),
    'renamed', v_renamed,
    'source_sha', CASE WHEN v_sha IS NULL THEN NULL ELSE encode(v_sha, 'hex') END
  );
END;
$$;
COMMENT ON FUNCTION ingest.apply_page_meta(int, jsonb, timestamptz, text, bigint, int) IS
  '元数据观测 → 逐属性 SCD2 归一化比较(tags 先合并隐藏标签再排序去重),变了才关旧开新;'
  '同事务刷 serve.page_current 的非投票列。缺 key = 未观测,不覆盖。'
  'rating/vote_* 绝不由本函数写:聚合值只能由 vote_event 折叠产生。';

-- -------------------------------------------------------------------------------------
-- 5.2 apply_page_life —— 页面生死(10 函数之一)
-- -------------------------------------------------------------------------------------
-- 单一真相源:v1 的 Page.isDeleted 与 PageVersion.isDeleted 双头发散(45 页)在此不可构造。
-- 删除推断的授权由调用方证明(见下 p_run 的 run 级门控),本函数只做最后一道拦截。
CREATE OR REPLACE FUNCTION ingest.apply_page_life(
  p_page       int,
  p_kind       text,
  p_occurred   timestamptz,
  p_precision  text,                       -- 'exact' | 'inferred'
  p_observed   timestamptz,
  p_source     text,
  p_run        bigint DEFAULT NULL,
  p_wikidot_id int    DEFAULT NULL,
  p_min_coverage real DEFAULT 0.98         -- 修订 R9:pages_enumerated/remote_total 下限
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_status text;
  v_seq    bigint;
  v_run    record;
  v_cov    real;
BEGIN
  IF p_kind NOT IN ('created','deleted','restored','renamed') THEN
    RAISE EXCEPTION 'apply_page_life: 非法 kind %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_precision NOT IN ('exact','inferred') THEN
    RAISE EXCEPTION 'apply_page_life: 非法 precision %(exact|inferred)', p_precision
      USING ERRCODE = '22023';
  END IF;

  -- 【0007 增补】R10 熔断的物理开关:被冻结的域一律 PGF01,先于任何写入与锁。
  --   冻结的是写入,不是采集 —— meta.* 的证据链(ingest_run/page_scan/scan_task/quarantine)不受影响。
  PERFORM meta.assert_writes_allowed('page');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  SELECT status INTO v_status FROM serve.page_current WHERE page_id = p_page FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_page_life: serve.page_current 缺 page_id=% 的行', p_page
      USING ERRCODE = '23503';
  END IF;

  -- ---- 删除推断的 run 级门控(设计 §5.5 + 修订 R9)---------------------------------
  -- 防的 bug:syncer v1 的 54 万条幻影 removed —— 扫描失败返回空数组被当成「数据为空」。
  -- 授权条件:run 完整(status='ok')且枚举覆盖率达标。'crom' / 'legacy' / 'operator'
  -- 三类来源是显式删除证据(远端明确说没了 / 人工签发),不需要 run 级覆盖率背书。
  IF p_kind = 'deleted' AND p_source NOT IN ('crom','legacy','legacy_import_2025_11',
                                             'v1_backfill','operator','reconcile') THEN
    IF p_run IS NULL THEN
      RAISE EXCEPTION
        'apply_page_life: source=% 的 deleted 推断必须带 run_id(删除推断需要 run 级完整性证据)',
        p_source USING ERRCODE = '22004';
    END IF;
    SELECT * INTO v_run FROM meta.ingest_run WHERE id = p_run;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'apply_page_life: run_id=% 不存在', p_run USING ERRCODE = '23503';
    END IF;
    IF v_run.status <> 'ok' THEN
      RAISE EXCEPTION
        'apply_page_life: run % 的 status=%(≠ok),禁止任何删除推断(§5.4 红线:'
        'status≠ok ⇒ 只允许 upsert 单调操作)', p_run, v_run.status
        USING ERRCODE = '55000';
    END IF;
    v_cov := CASE WHEN COALESCE(v_run.remote_total, 0) > 0
                  THEN v_run.pages_enumerated::real / v_run.remote_total::real
                  ELSE NULL END;
    IF v_cov IS NULL OR v_cov < p_min_coverage THEN
      RAISE EXCEPTION
        'apply_page_life: run % 枚举覆盖率 %(需 ≥ %),禁止删除推断',
        p_run, COALESCE(v_cov::text, 'unknown'), p_min_coverage
        USING ERRCODE = '55000';
    END IF;
  END IF;

  -- ---- 幂等短路:状态未转移零事件零写入 --------------------------------------------
  IF (p_kind = 'deleted'  AND v_status = 'deleted')
  OR (p_kind = 'restored' AND v_status = 'live')
  OR (p_kind = 'created'  AND v_status = 'live'
      AND EXISTS (SELECT 1 FROM ingest.page_life_event
                   WHERE page_id = p_page AND kind = 'created')) THEN
    RETURN NULL;
  END IF;

  INSERT INTO ingest.page_life_event(page_id, kind, occurred_at, occurred_precision,
                                     observed_at, source)
  VALUES (p_page, p_kind, p_occurred, p_precision, p_observed, p_source)
  RETURNING seq INTO v_seq;

  IF p_kind = 'deleted' THEN
    -- 元数据原地保留最后已知值(删除只翻 status)—— 12+ 处 prev-LATERAL 回退因此消失
    UPDATE serve.page_current
       SET status = 'deleted',
           deleted_at = COALESCE(p_occurred, p_observed),
           deleted_at_precision = p_precision,
           cursor_seq = GREATEST(cursor_seq, v_seq),
           updated_at = now()
     WHERE page_id = p_page;
  ELSIF p_kind IN ('restored','created') THEN
    -- 复活必然回写 status:v1 那 45 个「Page.isDeleted=true 而当前版本 isDeleted=false」
    -- 的发散页在单真相源下无法存在
    UPDATE serve.page_current
       SET status = 'live',
           deleted_at = NULL,
           deleted_at_precision = NULL,
           first_published_at = CASE WHEN p_kind = 'created'
                                     THEN COALESCE(first_published_at, p_occurred)
                                     ELSE first_published_at END,
           cursor_seq = GREATEST(cursor_seq, v_seq),
           updated_at = now()
     WHERE page_id = p_page;
  ELSE   -- renamed:slug 已由 apply_page_meta 落区间,这里只推 cursor
    UPDATE serve.page_current
       SET cursor_seq = GREATEST(cursor_seq, v_seq), updated_at = now()
     WHERE page_id = p_page;
  END IF;

  RETURN v_seq;
END;
$$;
COMMENT ON FUNCTION ingest.apply_page_life(int, text, timestamptz, text, timestamptz, text, bigint, int, real) IS
  '页面生死单一真相源。状态未转移返回 NULL(零事件零写入)。'
  '非显式来源的 deleted 推断必须带 run_id 且 run.status=''ok'' + 覆盖率 ≥ p_min_coverage,'
  '否则抛错 —— syncer v1 的 54 万幻影 removed 在协议层不可构造。';

COMMIT;


-- =====================================================================================
-- 6. 投票域(设计 §5.2 / §5.3 / §5.4 + 本次增补 A1/A2/A3)
-- =====================================================================================
-- 三个协议、一个状态机:
--   apply_vote_observation  单票 CAS(§5.2 原文)—— 一切转移语义的规范定义
--   apply_vote_history      CROM 事件历史(§5.3)—— 显式 direction=0 撤票,禁止 absence 推断
--   apply_vote_snapshot     当前态集合(§5.4)—— absence 推断的唯一入口,四重门控
-- 集合化实现 apply_vote_cas_batch 与单票函数必须逐位等价(属性测试为合入 gate)。
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 6.1 apply_vote_observation —— 单票 CAS(设计 §5.2 原文)
-- -------------------------------------------------------------------------------------
-- 【逐字例外 1】开头补 pg_advisory_xact_lock(page):
--     原文只有 SELECT ... FOR UPDATE。但 FOR UPDATE 对**不存在的行**不加任何锁,
--     两个并发事务同时观测同一张新票时都会读到 cur=NULL,双双落 kind='vote' 事件,
--     ON CONFLICT 把 vote_current 收敛成一行、page_current 却被加了两次 —— 聚合列漂移且
--     不可能从 vote_event 重放复现(重放会得到 vote 后接一个非法的 vote)。加页锁收口。
-- 【逐字例外 2】vote_revoked 的 (cur = 0)::int 加 COALESCE:
--     原文 `vote_revoked + (tgt IS NULL)::int - (cur = 0)::int`,当 cur IS NULL(全新票)时
--     `(cur = 0)` 求值为 NULL,整个表达式变 NULL,撞 serve.page_current.vote_revoked 的
--     NOT NULL —— 即「每一张新票都会让整页事务 23502 报错」。这是原文里唯一的运行期硬 bug。
-- 【逐字例外 3】p_direction 类型放宽为 int 并在入口 sign() 归一化 + quarantine 留痕:
--     原文注释写「±2 调用前已 sign() 归一」。把归一化放进函数是纵深防御:
--     上游脏值(实测 1,352~1,658 行 direction=±2,是 wikidot 双注册、CROM 文档化的正常输出)
--     不应该依赖每个调用方都记得先归一。CHECK 是最后防线而非拦截面(§4.8-5)。
-- 【增补】原文注释里描述但未实现的「精度改善副作用」在此实现(见 IS NOT DISTINCT 分支)。
CREATE OR REPLACE FUNCTION ingest.apply_vote_observation(
  p_page int, p_voter int, p_direction int,   -- 0 = 观测到无票/撤票;±2 入口 sign() 归一化
  p_occurred timestamptz, p_observed timestamptz,
  p_precision text, p_source text, p_run bigint,
  p_wikidot_id int DEFAULT NULL
) RETURNS bigint                              -- 返回新事件 seq;无转移返回 NULL
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  cur smallint; curN smallint; tgt smallint; ev bigint;
  v_dir smallint; v_curprec text; v_hit int;
BEGIN
  -- 【0007 增补】R10 熔断的物理开关:被冻结的域一律 PGF01,先于任何写入与锁。
  --   冻结的是写入,不是采集 —— meta.* 的证据链(ingest_run/page_scan/scan_task/quarantine)不受影响。
  PERFORM meta.assert_writes_allowed('vote');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);   -- 【逐字例外 1】

  -- 【逐字例外 3】±2 归一化,原始值进 meta.vote_quarantine 留痕,不中断事务
  v_dir := ingest.norm_direction(p_direction, p_page, p_voter::text,
                                 jsonb_build_object('voter_id', p_voter,
                                                    'direction', p_direction),
                                 p_source, p_occurred);

  SELECT direction, last_precision INTO cur, v_curprec FROM serve.vote_current
   WHERE page_id=p_page AND voter_id=p_voter FOR UPDATE;
  curN := NULLIF(cur, 0);                           -- 0 行 = 撤票态,状态机上等价"无票"
  tgt  := NULLIF(v_dir, 0);
  IF curN IS NOT DISTINCT FROM tgt THEN
    -- 无转移:幂等短路(cur=NULL 且 p_direction=0 ⇒ 真,不产生幻影 revoke;3×3 矩阵进单元测试)
    -- 例外副作用:方向一致但本次精度更优(exact>observed>day>clamped>bootstrap)时,
    -- 仅 UPDATE vote_current.last_voted_at/last_precision,不落事件(day-floored 的 crom
    -- 永远不会覆盖 sentinel 的分钟级 observed,votes 列表 keyset 不抖动)
    IF cur IS NOT NULL
       AND ingest.precision_rank(p_precision) > ingest.precision_rank(v_curprec) THEN
      UPDATE serve.vote_current
         SET last_voted_at  = COALESCE(p_occurred, p_observed),
             last_precision = p_precision
       WHERE page_id = p_page AND voter_id = p_voter;
    END IF;
    RETURN NULL;
  END IF;
  INSERT INTO ingest.vote_event(page_id,voter_id,kind,old_direction,new_direction,
    occurred_at,observed_at,time_precision,source,run_id)
  VALUES (p_page,p_voter,
          CASE WHEN tgt IS NULL THEN 'revoke'
               WHEN curN IS NULL THEN 'vote' ELSE 'revote' END,
          curN,tgt,p_occurred,p_observed,p_precision,p_source,p_run)
  RETURNING seq INTO ev;
  INSERT INTO serve.vote_current AS vc
    (page_id,voter_id,direction,first_voted_at,last_voted_at,last_precision,last_seq)
  VALUES (p_page,p_voter,COALESCE(tgt,0),COALESCE(p_occurred,p_observed),
          COALESCE(p_occurred,p_observed),p_precision,ev)
  ON CONFLICT (page_id,voter_id) DO UPDATE
    SET direction=EXCLUDED.direction, last_voted_at=EXCLUDED.last_voted_at,
        last_precision=EXCLUDED.last_precision, last_seq=EXCLUDED.last_seq,
        first_voted_at=COALESCE(vc.first_voted_at, EXCLUDED.first_voted_at);
        -- first_voted_at 仅插入时设置,保留最早值(既有行为 NULL 时补上,不覆盖已有值)
  UPDATE serve.page_current
     SET rating    = rating    + COALESCE(tgt,0)  - COALESCE(curN,0),
         vote_up   = vote_up   + COALESCE((tgt=1)::int,0)  - COALESCE((curN=1)::int,0),
         vote_down = vote_down + COALESCE((tgt=-1)::int,0) - COALESCE((curN=-1)::int,0),
         vote_revoked = vote_revoked + (tgt IS NULL)::int - COALESCE((cur = 0)::int, 0),
         cursor_seq = ev, updated_at = now()
   WHERE page_id = p_page;
  GET DIAGNOSTICS v_hit = ROW_COUNT;
  IF v_hit = 0 THEN
    -- page_current 缺行 ⇒ 聚合增量静默丢失(v1 PageStats 6,706 孤儿的同型病根)。宁可整页回滚。
    RAISE EXCEPTION 'apply_vote_observation: serve.page_current 缺 page_id=% 的行', p_page
      USING ERRCODE = '23503';
  END IF;
  RETURN ev;
END $$;
COMMENT ON FUNCTION ingest.apply_vote_observation(int,int,int,timestamptz,timestamptz,text,text,bigint,int) IS
  '单票 CAS 转移(设计 §5.2 原文 + 3 处标注例外)。守卫是单一 IS NOT DISTINCT FROM:'
  'cur=NULL ∧ direction=0 ⇒ 无转移,幻影 revoke 在此不可构造。撤票是 direction=0 行不是删行。'
  '返回新事件 seq;无转移返回 NULL(可能有精度改善的纯 UPDATE 副作用)。';

-- -------------------------------------------------------------------------------------
-- 6.2 apply_vote_cas_batch —— 集合化 CAS(内部;history / snapshot 共用)
-- -------------------------------------------------------------------------------------
-- 与 6.1 逐位等价:同一批目标态,批量跑一次 == 逐行跑 N 次(事件集合、vote_current、
-- page_current 三者全等)。这条等价性是合入 gate(见文件末自测清单 T5)。
-- p_targets: [{"voter_id":1,"direction":1|0|-1,"occurred_at":"...","precision":"day"}]
--            direction 必须已归一化到 -1/0/1;每个 voter_id 至多一条(重复即报错,
--            折叠是调用方的语义责任 —— 静默取一条会把「投了又撤」的歧义藏起来)。
CREATE OR REPLACE FUNCTION ingest.apply_vote_cas_batch(
  p_page     int,
  p_targets  jsonb,
  p_observed timestamptz,
  p_source   text,
  p_run      bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_res      jsonb;
  v_raw      int;
  v_uniq     int;
  v_improved int := 0;
BEGIN
  IF p_targets IS NULL OR jsonb_typeof(p_targets) <> 'array' THEN
    RAISE EXCEPTION 'apply_vote_cas_batch: p_targets 必须是 jsonb array' USING ERRCODE = '22023';
  END IF;

  -- 【0007 增补】R10 熔断的物理开关:被冻结的域一律 PGF01,先于任何写入与锁。
  --   冻结的是写入,不是采集 —— meta.* 的证据链(ingest_run/page_scan/scan_task/quarantine)不受影响。
  PERFORM meta.assert_writes_allowed('vote');
  PERFORM meta.ingest_gate_open();
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  SELECT count(*), count(DISTINCT (r ->> 'voter_id'))
    INTO v_raw, v_uniq
    FROM jsonb_array_elements(p_targets) AS e(r);

  IF v_raw <> v_uniq THEN
    RAISE EXCEPTION
      'apply_vote_cas_batch: 同一 voter 出现多次(% 条记录 / % 个 voter)。'
      '折叠必须在调用方完成并留痕,这里不静默择一', v_raw, v_uniq
      USING ERRCODE = '22000';
  END IF;

  IF v_raw = 0 THEN
    RETURN jsonb_build_object('events', 0, 'targets', 0, 'rating_delta', 0,
                              'up_delta', 0, 'down_delta', 0, 'revoked_delta', 0,
                              'page_updated', 0, 'precision_improved', 0);
  END IF;

  WITH tgt AS MATERIALIZED (
    -- sign() 是纵深防御的第二道:契约要求调用方已归一化,但真让 ±2 漏到这里,
    -- vote_event 的 CHECK 会把整页事务打死(±2 应该被归一化 + quarantine,而不是卡住管道)。
    -- 注意本函数**不**写 quarantine —— 留痕是调用方(history/snapshot)的责任,
    -- 因为只有它们持有原始记录的完整上下文。
    SELECT (r ->> 'voter_id')::int                            AS voter_id,
           NULLIF(sign(COALESCE((r ->> 'direction')::int, 0)), 0)::smallint AS tgt_dir,
           NULLIF(r ->> 'occurred_at', '')::timestamptz       AS occurred_at,
           COALESCE(NULLIF(r ->> 'precision', ''), 'observed') AS prec
      FROM jsonb_array_elements(p_targets) AS e(r)
  ),
  -- CAS 判定:守卫与 6.1 完全同形(单一 IS DISTINCT FROM,两侧都先 NULLIF(...,0))。
  -- LEFT JOIN 缺行 ⇒ cur_raw IS NULL ⇒ cur_n IS NULL;此时 tgt_dir 也 NULL(direction=0)
  -- 就落不进结果集 —— 幻影 revoke 在集合形态下同样不可构造。
  cas AS MATERIALIZED (
    SELECT t.voter_id, t.tgt_dir, t.occurred_at, t.prec,
           vc.direction                        AS cur_raw,
           NULLIF(vc.direction, 0)::smallint   AS cur_n
      FROM tgt t
      LEFT JOIN serve.vote_current vc
             ON vc.page_id = p_page AND vc.voter_id = t.voter_id
     WHERE NULLIF(vc.direction, 0) IS DISTINCT FROM t.tgt_dir
  ),
  -- 聚合增量从 cas(语句快照)算,不从写后状态算:同一语句内 vcu 的写入对本 CTE 不可见,
  -- 所以「批量一次」与「逐行 N 次累加」的结果必然相同。
  -- sum() 忽略 NULL,等价于 6.1 里的 COALESCE(...,0)。
  agg AS MATERIALIZED (
    SELECT count(*)::int AS n,
           COALESCE(sum(COALESCE(tgt_dir,0) - COALESCE(cur_n,0)), 0)::int AS d_rating,
           (COALESCE(sum((tgt_dir =  1)::int), 0) - COALESCE(sum((cur_n =  1)::int), 0))::int AS d_up,
           (COALESCE(sum((tgt_dir = -1)::int), 0) - COALESCE(sum((cur_n = -1)::int), 0))::int AS d_down,
           (COALESCE(sum((tgt_dir IS NULL)::int), 0) - COALESCE(sum((cur_raw = 0)::int), 0))::int AS d_revoked
      FROM cas
  ),
  ev AS (
    INSERT INTO ingest.vote_event(page_id, voter_id, kind, old_direction, new_direction,
                                  occurred_at, observed_at, time_precision, source, run_id)
    SELECT p_page, c.voter_id,
           CASE WHEN c.tgt_dir IS NULL THEN 'revoke'
                WHEN c.cur_n   IS NULL THEN 'vote'
                ELSE 'revote' END,
           c.cur_n, c.tgt_dir, c.occurred_at, p_observed, c.prec, p_source, p_run
      FROM cas c
     ORDER BY c.voter_id                     -- seq 分配顺序确定化,便于测试比对
    RETURNING seq, voter_id, new_direction, occurred_at, time_precision
  ),
  vcu AS (
    INSERT INTO serve.vote_current AS vc
      (page_id, voter_id, direction, first_voted_at, last_voted_at, last_precision, last_seq)
    SELECT p_page, e.voter_id, COALESCE(e.new_direction, 0)::smallint,
           COALESCE(e.occurred_at, p_observed), COALESCE(e.occurred_at, p_observed),
           e.time_precision, e.seq
      FROM ev e
    ON CONFLICT (page_id, voter_id) DO UPDATE
      SET direction       = EXCLUDED.direction,
          last_voted_at   = EXCLUDED.last_voted_at,
          last_precision  = EXCLUDED.last_precision,
          last_seq        = EXCLUDED.last_seq,
          first_voted_at  = COALESCE(vc.first_voted_at, EXCLUDED.first_voted_at)
    RETURNING 1
  ),
  pcu AS (
    UPDATE serve.page_current pc
       SET rating       = pc.rating       + a.d_rating,
           vote_up      = pc.vote_up      + a.d_up,
           vote_down    = pc.vote_down    + a.d_down,
           vote_revoked = pc.vote_revoked + a.d_revoked,
           cursor_seq   = GREATEST(pc.cursor_seq, (SELECT max(seq) FROM ev)),
           updated_at   = now()
      FROM agg a
     WHERE pc.page_id = p_page AND a.n > 0
    RETURNING 1
  )
  SELECT jsonb_build_object(
           'events',        (SELECT count(*) FROM ev),
           'targets',       v_raw,
           'rating_delta',  (SELECT d_rating  FROM agg),
           'up_delta',      (SELECT d_up      FROM agg),
           'down_delta',    (SELECT d_down    FROM agg),
           'revoked_delta', (SELECT d_revoked FROM agg),
           'page_updated',  (SELECT count(*) FROM pcu)
         )
    INTO v_res;

  IF (v_res ->> 'events')::int > 0 AND (v_res ->> 'page_updated')::int = 0 THEN
    RAISE EXCEPTION 'apply_vote_cas_batch: serve.page_current 缺 page_id=% 的行,聚合增量会丢失',
      p_page USING ERRCODE = '23503';
  END IF;

  -- ---- 精度改善副作用(与 6.1 的 IS NOT DISTINCT 分支对齐)---------------------------
  -- 没有这一段,批量路径与逐行路径在「方向一致但精度更优」的输入上会产生不同的
  -- vote_current.last_precision / last_voted_at,T5.1 的等价性 gate 会红。
  -- 为什么单独一条语句而不是并进上面的 CTE:上面的 vcu 已经在同一语句里写 serve.vote_current,
  -- 同一语句内对同一张表跑第二个 data-modifying CTE,PG 只保证「不碰同一行时可用」,
  -- 官方文档明确说这类效果 unspecified —— 不值得为省一次扫描去踩。
  -- 顺序安全性:刚转移过的行此刻 last_precision 已等于本次 prec,rank 不再「更优」,
  -- 所以后跑一遍不会重复应用。
  WITH imp AS (
    SELECT (r ->> 'voter_id')::int                              AS voter_id,
           NULLIF(r ->> 'occurred_at', '')::timestamptz         AS occurred_at,
           COALESCE(NULLIF(r ->> 'precision', ''), 'observed')  AS prec
      FROM jsonb_array_elements(p_targets) AS e(r)
  ), upd AS (
    UPDATE serve.vote_current vc
       SET last_voted_at  = COALESCE(i.occurred_at, p_observed),
           last_precision = i.prec
      FROM imp i
     WHERE vc.page_id = p_page
       AND vc.voter_id = i.voter_id
       AND ingest.precision_rank(i.prec) > ingest.precision_rank(vc.last_precision)
    RETURNING 1
  )
  SELECT count(*)::int INTO v_improved FROM upd;

  RETURN v_res || jsonb_build_object('precision_improved', v_improved);
END;
$$;
COMMENT ON FUNCTION ingest.apply_vote_cas_batch(int, jsonb, timestamptz, text, bigint) IS
  '集合化 CAS(内部)。一条语句完成:事件 INSERT ... SELECT + vote_current 批量 upsert + '
  'page_current 单次增量。与 apply_vote_observation 的逐行结果必须全等(合入 gate)。'
  '同一 voter 重复出现即报错 —— 折叠是调用方的语义责任。';

COMMIT;


-- =====================================================================================
-- 6.3 apply_vote_history —— CROM 事件历史协议(设计 §5.3)
-- =====================================================================================
-- p_records: [{"voter_id":1,"direction":1|0|-1|±2,"day_ts":"2024-01-02T00:00:00+08","precision":"day"?}]
--   schema 保证「每 voter 每天最多一条」⇒ 取每 voter 的最大 day_ts 记录为其终态,折叠无歧义。
--   direction=0 是 CROM 的**显式撤票记录**,不是 absence —— 这是 CROM 路径不需要 absence
--   推断、因而「风险面减半」(设计 §9.6)的全部原因。
-- 硬红线:本函数**永不做 absence 推断**。fuzzy API 有实证漏返(baby-bat 远端 77 票只返 69),
--   「不在列表 = 撤了」只会复刻 syncer v1 的 54 万幻影 removed。
-- 代价(设计取舍 #2):单次快照内同 voter 的多天记录只取终态,快照内的中间转移不落事件。

BEGIN;

CREATE OR REPLACE FUNCTION ingest.apply_vote_history(
  p_page              int,
  p_records           jsonb,
  p_claimed_vote_count int,
  p_observed          timestamptz,
  p_source            text,
  p_run               bigint DEFAULT NULL,
  p_wikidot_id        int    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_targets  jsonb;
  v_raw      int;
  v_folded   int;
  v_nonzero  int;
  v_res      jsonb;
  v_status   text;
BEGIN
  IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'apply_vote_history: p_records 必须是 jsonb array' USING ERRCODE = '22023';
  END IF;

  -- 【0007 增补】R10 熔断的物理开关:被冻结的域一律 PGF01,先于任何写入与锁。
  --   冻结的是写入,不是采集 —— meta.* 的证据链(ingest_run/page_scan/scan_task/quarantine)不受影响。
  PERFORM meta.assert_writes_allowed('vote');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  -- 事务内串行化同页写入(设计 §5.3 原文)
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  SELECT count(*) INTO v_raw FROM jsonb_array_elements(p_records) AS e(r);

  -- ---- 入口归一化:|direction|>1 的原始记录连同上下文写 quarantine 后继续(不中断整页)----
  -- 【2026-07-27 实测】v1 存量 1,352~1,658 行 direction=±2(wikidot 双注册,CROM 文档化输出)。
  INSERT INTO meta.vote_quarantine(page_id, voter_key, raw, reason, source, occurred_at)
  SELECT p_page, r ->> 'voter_id', r, 'direction_out_of_range', p_source,
         NULLIF(r ->> 'day_ts', '')::timestamptz
    FROM jsonb_array_elements(p_records) AS e(r)
   WHERE abs(COALESCE((r ->> 'direction')::int, 0)) > 1;

  -- ---- 逐 voter 折叠为终态 + precision 赋值(含 A3 的 bootstrap 分支)----------------
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'voter_id',    voter_id,
             'direction',   dir,
             'occurred_at', day_ts,
             'precision',   prec) ORDER BY voter_id), '[]'::jsonb),
         count(*)::int,
         COALESCE(sum((dir <> 0)::int), 0)::int
    INTO v_targets, v_folded, v_nonzero
    FROM (
      SELECT DISTINCT ON (voter_id)
             voter_id, dir, day_ts,
             -- 记录自带 precision 优先;否则按 (时间戳, 来源) 推导:
             --   day_ts ∈ [2022-05-14, 2022-05-27) ⇒ 'bootstrap'(166 万条冷启动快照票)
             --   day_ts <  2022-05-01              ⇒ 'clamped'
             --   其余                              ⇒ 'day'
             COALESCE(prec, ingest.derive_vote_precision(day_ts, p_source)) AS prec
        FROM (
          SELECT (r ->> 'voter_id')::int                      AS voter_id,
                 sign(COALESCE((r ->> 'direction')::int, 0))::smallint AS dir,
                 NULLIF(r ->> 'day_ts', '')::timestamptz      AS day_ts,
                 NULLIF(r ->> 'precision', '')                AS prec
            FROM jsonb_array_elements(p_records) AS e(r)
           WHERE (r ? 'voter_id') AND NULLIF(r ->> 'voter_id', '') IS NOT NULL
        ) x
       ORDER BY voter_id, day_ts DESC NULLS LAST
    ) f;

  v_res := ingest.apply_vote_cas_batch(p_page, v_targets, p_observed, p_source, p_run);

  -- ---- 完整性护栏(同口径比较):折叠后非零 voter 数 vs Phase A 的 voteCount ---------
  -- 不一致 ⇒ page_scan status='partial' 并进 §5.7 收敛流程,**绝不因此推断撤票**。
  -- 这是 baby-bat 类 fuzzy 漏返(远端 77 票只返 69)的处置点:记录差异,不掩盖、不造事件。
  v_status := CASE
                WHEN p_claimed_vote_count IS NULL THEN 'ok'
                WHEN v_nonzero = p_claimed_vote_count THEN 'ok'
                ELSE 'partial'
              END;
  PERFORM meta.record_page_scan(p_run, p_page, 'votes', v_status,
                                p_claimed_vote_count, v_nonzero,
                                NULL, NULL, NULL, NULL,
                                CASE WHEN v_status = 'partial'
                                     THEN format('折叠后非零 voter=%s vs claimed voteCount=%s',
                                                 v_nonzero, p_claimed_vote_count)
                                END);

  RETURN v_res
      || jsonb_build_object('raw_records', v_raw,
                            'folded', v_folded,
                            'nonzero', v_nonzero,
                            'scan_status', v_status,
                            'absence_inference', 'forbidden');
END;
$$;
COMMENT ON FUNCTION ingest.apply_vote_history(int, jsonb, int, timestamptz, text, bigint, int) IS
  'CROM fuzzyVoteRecords 协议:逐 voter 折叠为终态(direction=0 是显式撤票记录)后集合化 CAS。'
  '永不做 absence 推断。完整性不符只记 page_scan partial 进收敛流程,绝不推断撤票。';


-- =====================================================================================
-- 6.4 apply_vote_snapshot —— 当前态集合协议 + 四重门控(设计 §5.4 + 增补 A1/A2)
-- =====================================================================================
-- p_entries: [{"voter_id":1,"direction":1|-1|0}]  ← WhoRatedPageModule 解析结果(无时间戳)
--   direction=0 允许出现,语义是「显式看到此人当前无票」= 显式撤票证据(非 absence)。
--
-- 撤票推断的**四重门控**(全部通过才允许 absence diff):
--   ① is_complete = true                    —— 扫描成败显式建模,失败绝不推断
--   ② claimed_total 提供时必须 = 去重后条数  —— §5.4 原文的同口径护栏
--   ③ absence diff 只作用于 vote_current.direction<>0 且 voter.kind = ANY(visible_kinds)
--      —— 直连看不到匿名/已删账号票(传 {'wikidot'}),CROM 铸的 anon 票不会被周期性幻影 revoke
--   ④ 【A1 新增·核心】checksum:Σ sign(direction) 必须 = p_claimed_rating(ListPages %%rating%%)
--      两个**独立模块**(WhoRatedPageModule vs ListPagesModule)互相背书;不等即判 partial。
--      这是 wikidot 单源下防幻影撤票的核心防线:模块改版/主题变更/本地化改动会让解析
--      静默变形,而 status 照返 ok —— 逐页 is_complete 抓不住,交叉校验和抓得住。
--   ⑤ 红线(synthesis §5.4-4):status=ok ∧ entries=0 ∧ claimed_total>0 ⇒ 强制 failed。
--      【2026-07-27 实测·P2-2】WhoRated 对错误 page_id 返回 ok + 空列表,是唯一的
--      「全员撤票」入口 —— 其它模块(ViewSource/RevisionList/PageFiles/ForumComments)
--      对错误 id 都干净失败,只有它不。
--
-- 【A2】通过全部门控后,absence 的产物仍**不是** revoke 事件,而是 meta.revoke_candidate:
--   需在连续 ≥N 个「完整且 checksum 通过」的不同 run 快照中都缺席,才由
--   ingest.promote_revoke_candidates(N) 转正。理由见修订 R2 与 D4:四重门控保护不了
--   P0-6 的短命页(83% 活不过 7 天),也保护不了「两个模块一起漂移、校验和互相背书通过」
--   这种相关性失效。撤票延迟换「永不产生幻影撤票」。
CREATE OR REPLACE FUNCTION ingest.apply_vote_snapshot(
  p_page           int,
  p_entries        jsonb,
  p_is_complete    boolean,
  p_claimed_total  int,
  p_claimed_rating int,                                  -- 【A1】ListPages %%rating%%
  p_visible_kinds  text[]      DEFAULT ARRAY['wikidot'],
  p_observed       timestamptz DEFAULT now(),
  p_source         text        DEFAULT 'wikidot',
  p_run            bigint      DEFAULT NULL,
  p_wikidot_id     int         DEFAULT NULL,
  p_absence_policy text        DEFAULT 'candidate',      -- 'candidate' | 'event' | 'forbidden'
  p_max_absence    int         DEFAULT 500,              -- 单页熔断:绝对条数
  p_max_absence_ratio real     DEFAULT 0.20              -- 单页熔断:占当前有效票比例
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_targets   jsonb;
  v_raw       int;
  v_uniq      int;
  v_checksum  int;
  v_res       jsonb;
  v_present   int[];
  v_absent    jsonb  := '[]'::jsonb;
  v_absent_n  int    := 0;
  v_active    int;
  v_gate1 boolean; v_gate2 boolean; v_gate3 boolean; v_gate4 boolean; v_gate5 boolean;
  v_checksum_ok boolean;
  v_allow     boolean;
  v_status    text;
  v_reason    text := NULL;
  v_promoted  int := 0;
  v_cand      int := 0;
BEGIN
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'apply_vote_snapshot: p_entries 必须是 jsonb array' USING ERRCODE = '22023';
  END IF;
  IF p_absence_policy NOT IN ('candidate','event','forbidden') THEN
    RAISE EXCEPTION 'apply_vote_snapshot: 非法 p_absence_policy %', p_absence_policy
      USING ERRCODE = '22023';
  END IF;
  IF p_visible_kinds IS NULL OR array_length(p_visible_kinds, 1) IS NULL THEN
    RAISE EXCEPTION 'apply_vote_snapshot: visible_kinds 不能为空 —— 空集会让 absence diff'
      '作用于全部 voter(含 CROM 铸的 anon 票),那正是门控③要防的' USING ERRCODE = '22004';
  END IF;

  -- 【0007 增补】R10 熔断的物理开关:被冻结的域一律 PGF01,先于任何写入与锁。
  --   冻结的是写入,不是采集 —— meta.* 的证据链(ingest_run/page_scan/scan_task/quarantine)不受影响。
  PERFORM meta.assert_writes_allowed('vote');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  -- ---- 归一化 + 去重统计 ------------------------------------------------------------
  INSERT INTO meta.vote_quarantine(page_id, voter_key, raw, reason, source, occurred_at)
  SELECT p_page, r ->> 'voter_id', r, 'direction_out_of_range', p_source, p_observed
    FROM jsonb_array_elements(p_entries) AS e(r)
   WHERE abs(COALESCE((r ->> 'direction')::int, 0)) > 1;

  SELECT count(*)::int, count(DISTINCT (r ->> 'voter_id'))::int
    INTO v_raw, v_uniq
    FROM jsonb_array_elements(p_entries) AS e(r)
   WHERE (r ? 'voter_id') AND NULLIF(r ->> 'voter_id', '') IS NOT NULL;

  -- 【A1】checksum:Σ sign(direction)。与 ListPages %%rating%% 比。
  SELECT COALESCE(sum(sign(COALESCE((r ->> 'direction')::int, 0))), 0)::int,
         COALESCE(array_agg(DISTINCT (r ->> 'voter_id')::int), '{}'::int[])
    INTO v_checksum, v_present
    FROM (SELECT DISTINCT ON ((r ->> 'voter_id')) r
            FROM jsonb_array_elements(p_entries) AS e(r)
           WHERE (r ? 'voter_id') AND NULLIF(r ->> 'voter_id', '') IS NOT NULL
           ORDER BY (r ->> 'voter_id'), abs(COALESCE((r ->> 'direction')::int, 0)) DESC) d(r);

  -- ---- 门控判定 ---------------------------------------------------------------------
  v_gate1 := COALESCE(p_is_complete, false);
  v_gate2 := (p_claimed_total IS NULL) OR (v_uniq = p_claimed_total);
  v_gate3 := true;   -- 门控③是 diff 的作用域限定,在下面的 absence 查询里落实
  v_gate4 := (p_claimed_rating IS NULL) OR (v_checksum = p_claimed_rating);
  -- 门控⑤:WhoRated 对错误 page_id 返 ok+空列表(实测 P2-2),是唯一的「全员撤票」入口。
  -- claimed_total 缺失时 COALESCE 成 1(而不是 0):「空快照 + 没有任何远端计数背书」
  -- 是最危险的一种输入,必须判 failed —— 否则一次解析变形就能把整页票全撤掉。
  v_gate5 := NOT (v_uniq = 0 AND COALESCE(p_claimed_total, 1) > 0);

  -- checksum_ok 三态:NULL=未校验(没给 claimed_rating);true/false=校验结论
  v_checksum_ok := CASE WHEN p_claimed_rating IS NULL THEN NULL ELSE v_gate4 END;

  -- 【A1】absence 要求 checksum **确实通过**,而不是「没校验就算过」:
  -- 没传 claimed_rating ⇒ v_checksum_ok IS NULL ⇒ COALESCE(...,false) ⇒ 不允许 absence。
  -- 这是把「交叉校验」变成硬前置的唯一写法;写成 (claimed IS NULL) OR (...) 等于给
  -- 「忘了传 %%rating%%」开了一个静默的后门,而那正是 wikidot 单源下最可能发生的疏漏。
  v_allow := v_gate1 AND v_gate2 AND v_gate5
             AND COALESCE(v_checksum_ok, false)
             AND p_absence_policy <> 'forbidden';

  IF NOT v_gate1 THEN v_reason := 'is_complete=false';
  ELSIF NOT v_gate5 THEN v_reason := format('entries=0 而 claimed_total=%s(WhoRated 对错误 pageId 返 ok+空)',
                                            COALESCE(p_claimed_total::text, 'NULL'));
  ELSIF NOT v_gate2 THEN v_reason := format('去重后条数 %s ≠ claimed_total %s', v_uniq, p_claimed_total);
  ELSIF NOT v_gate4 THEN v_reason := format('checksum 不符:Σsign=%s ≠ %%rating%%=%s',
                                            v_checksum, p_claimed_rating);
  ELSIF v_checksum_ok IS NULL THEN v_reason := '未提供 claimed_rating ⇒ checksum 未校验 ⇒ 禁止 absence 推断';
  END IF;

  -- ---- 单调 upsert:无论门控结果如何都执行(只增不撤,永远安全)---------------------
  -- 含显式 direction=0 的条目 —— 那是「看见此人现在没票」的正证据,走正常 CAS 产 revoke。
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'voter_id',    (r ->> 'voter_id')::int,
             'direction',   sign(COALESCE((r ->> 'direction')::int, 0)),
             'occurred_at', p_observed,
             'precision',   'observed') ORDER BY (r ->> 'voter_id')::int), '[]'::jsonb)
    INTO v_targets
    FROM (SELECT DISTINCT ON ((r ->> 'voter_id')) r
            FROM jsonb_array_elements(p_entries) AS e(r)
           WHERE (r ? 'voter_id') AND NULLIF(r ->> 'voter_id', '') IS NOT NULL
           ORDER BY (r ->> 'voter_id'), abs(COALESCE((r ->> 'direction')::int, 0)) DESC) d(r);

  v_res := ingest.apply_vote_cas_batch(p_page, v_targets, p_observed, p_source, p_run);

  -- ---- 出现即正证据:无条件清掉这些 voter 的撤票候选 -------------------------------
  -- 不看门控:「我看见他有票」比任何 absence 推断都强。漏清才会导致假转正。
  DELETE FROM meta.revoke_candidate
   WHERE page_id = p_page AND voter_id = ANY(v_present);

  -- ---- absence 计算(门控③在此落实:限定 direction<>0 且 kind ∈ visible_kinds)-----
  SELECT count(*)::int INTO v_active
    FROM serve.vote_current vc
    JOIN ingest."user" u ON u.id = vc.voter_id
   WHERE vc.page_id = p_page AND vc.direction <> 0 AND u.kind = ANY(p_visible_kinds);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('voter_id', voter_id,
                                               'direction', direction)), '[]'::jsonb),
         count(*)::int
    INTO v_absent, v_absent_n
    FROM (
      SELECT vc.voter_id, vc.direction
        FROM serve.vote_current vc
        JOIN ingest."user" u ON u.id = vc.voter_id
       WHERE vc.page_id = p_page
         AND vc.direction <> 0
         AND u.kind = ANY(p_visible_kinds)
         AND NOT (vc.voter_id = ANY(v_present))
    ) a;

  -- 单页熔断:一次要撤掉几百张票、或撤掉当前有效票的 20% 以上,几乎一定是解析变形而不是
  -- 真的有几百人同时撤票。宁可扣住等人工看(设计 §5.4 的 500 页批量熔断在页级的同构物)。
  IF v_allow AND v_absent_n > 0
     AND (v_absent_n > p_max_absence
          OR (v_active > 0 AND v_absent_n::real / v_active::real > p_max_absence_ratio)) THEN
    v_allow := false;
    v_reason := format('单页 absence 熔断:%s 条缺席 / %s 条有效票(阈值 %s 条或 %s%%)',
                       v_absent_n, v_active, p_max_absence, (p_max_absence_ratio * 100)::int);
    UPDATE meta.revoke_candidate
       SET status = 'held', held_reason = v_reason, last_seen_at = now()
     WHERE page_id = p_page AND status = 'pending';
  END IF;

  -- ---- absence 产物 -----------------------------------------------------------------
  IF v_allow AND v_absent_n > 0 THEN
    IF p_absence_policy = 'candidate' THEN
      -- 【A2】写候选,不写事实。confirmations 只在「不同 run」时累加:
      -- 同一 run 内重复应用同一份快照不应该被当成两次独立确认。
      -- gate_result 把「哪一重门控怎么过的」原样留痕:没有它,事后无法回答
      -- 「这条候选凭什么被算作一次确认」,而那正是撤票唯一需要审计的问题。
      INSERT INTO meta.revoke_candidate AS rc
        (page_id, voter_id, last_direction, confirmations,
         first_seen_at, last_seen_at, observed_at, last_run_id, source,
         gate_result, gate_passed, status)
      SELECT p_page, (r ->> 'voter_id')::int, (r ->> 'direction')::smallint, 1,
             now(), now(), p_observed, p_run, p_source,
             jsonb_build_object('is_complete', v_gate1,
                                'claimed_total', p_claimed_total,
                                'fetched_total', v_uniq,
                                'visible_kinds', to_jsonb(p_visible_kinds),
                                'checksum_ok', v_checksum_ok,
                                'sum_sign', v_checksum,
                                'remote_rating', p_claimed_rating,
                                'gate_nonempty', v_gate5,
                                'active_votes', v_active,
                                'absence_count', v_absent_n),
             true, 'pending'
        FROM jsonb_array_elements(v_absent) AS e(r)
      ON CONFLICT (page_id, voter_id) DO UPDATE
        SET confirmations = rc.confirmations
                          + CASE WHEN p_run IS NULL
                                   OR rc.last_run_id IS NULL
                                   OR rc.last_run_id <> p_run
                                 THEN 1 ELSE 0 END,
            last_seen_at   = now(),
            observed_at    = EXCLUDED.observed_at,
            last_run_id    = COALESCE(p_run, rc.last_run_id),
            last_direction = EXCLUDED.last_direction,
            gate_result    = EXCLUDED.gate_result,
            gate_passed    = EXCLUDED.gate_passed,
            status         = CASE WHEN rc.status = 'dismissed' THEN 'dismissed' ELSE 'pending' END;
      GET DIAGNOSTICS v_cand = ROW_COUNT;

    ELSIF p_absence_policy = 'event' THEN
      -- 仅当运维显式声明「本源的 absence 可直接采信」时才走这里(默认不走)。
      -- 保留这条路是为了让 CROM 全量重放期的显式撤票能复用同一套集合化 CAS。
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'voter_id',    (r ->> 'voter_id')::int,
                 'direction',   0,
                 'occurred_at', p_observed,
                 'precision',   'observed')), '[]'::jsonb)
        INTO v_targets
        FROM jsonb_array_elements(v_absent) AS e(r);
      v_promoted := (ingest.apply_vote_cas_batch(p_page, v_targets, p_observed,
                                                 p_source, p_run) ->> 'events')::int;
    END IF;
  END IF;

  -- ---- 扫描证据 ---------------------------------------------------------------------
  v_status := CASE WHEN NOT v_gate5 THEN 'failed'
                   WHEN v_gate1 AND v_gate2 AND COALESCE(v_gate4, true) THEN 'ok'
                   ELSE 'partial' END;
  PERFORM meta.record_page_scan(p_run, p_page, 'votes', v_status,
                               p_claimed_total, v_uniq,
                               v_checksum_ok, p_claimed_rating, v_checksum,
                               NULL, v_reason);

  -- §4.6:只有四门全过的快照才推进“最后完整票快照”。删除后 status='deleted'，
  -- WHERE 会让该值自然冻结，供下游区分“真没票”与“页面消失前根本没来得及看”。
  IF v_gate1 AND v_gate2 AND v_gate5 AND v_checksum_ok IS TRUE THEN
    UPDATE serve.page_current
       SET last_complete_vote_snapshot_at =
             GREATEST(COALESCE(last_complete_vote_snapshot_at, p_observed), p_observed)
     WHERE page_id = p_page AND status = 'live';
  END IF;

  RETURN v_res || jsonb_build_object(
    'raw_entries',        v_raw,
    'unique_voters',      v_uniq,
    'checksum_actual',    v_checksum,
    'checksum_expected',  p_claimed_rating,
    'checksum_ok',        v_checksum_ok,
    'gate_is_complete',   v_gate1,
    'gate_claimed_total', v_gate2,
    'gate_visible_kinds', to_jsonb(p_visible_kinds),
    'gate_checksum',      v_gate4,
    'gate_nonempty',      v_gate5,
    'absence_allowed',    v_allow,
    'absence_count',      v_absent_n,
    'absence_policy',     p_absence_policy,
    'candidates_written', v_cand,
    'revoke_events',      v_promoted,
    'scan_status',        v_status,
    'reason',             v_reason);
END;
$$;
COMMENT ON FUNCTION ingest.apply_vote_snapshot(int, jsonb, boolean, int, int, text[], timestamptz, text, bigint, int, text, int, real) IS
  '当前态集合协议(WhoRatedPageModule)。四重门控 + 非空红线:'
  'is_complete / claimed_total 同口径 / visible_kinds 作用域 / 【A1】Σsign=%%rating%% 交叉校验和 / '
  'entries=0∧claimed_total>0 强制 failed。upsert 永远执行(单调安全);'
  'absence 默认只产生 meta.revoke_candidate(【A2】),不产生 revoke 事件。';


-- =====================================================================================
-- 6.5 promote_revoke_candidates —— absence 候选转正(【A2】新增函数)
-- =====================================================================================
-- 转正条件(全部满足):
--   ① status='pending' 且 confirmations ≥ p_min_confirmations
--      —— confirmations 只在「完整 + checksum 通过」的快照里累加(见 6.4),
--         所以「连续 N 次完整且 checksum 通过的快照中都缺席」这句语义由累加口径保证。
--   ② 候选未过期(last_seen_at ≥ now() - p_max_age):很久没再确认的候选是陈旧信息,
--      多半是页面早已停止被扫描(已删页),不该在此时忽然产生撤票。
--   ③ vote_current 里该票仍是有效票(direction<>0):否则已被别的路径处理过。
--   ④ 单页比例熔断:一次要撤掉的票占该页有效票超过 p_max_page_ratio ⇒ 全页扣住(held)。
-- 转正动作走 apply_vote_observation(单票 CAS),因此 3×3 转移矩阵、page_current 增量、
-- 不可变触发器等约束与常规写路径完全一致 —— 转正不是特权通道。
CREATE OR REPLACE FUNCTION ingest.promote_revoke_candidates(
  p_min_confirmations int      DEFAULT 2,
  p_max_promote       int      DEFAULT NULL,          -- NULL = 不限
  p_max_age           interval DEFAULT interval '30 days',
  p_max_page_ratio    real     DEFAULT 0.20,
  p_run               bigint   DEFAULT NULL,
  p_source            text     DEFAULT 'wikidot_absence'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r          record;
  v_seq      bigint;
  v_promoted int := 0;
  v_held     int := 0;
  v_dismiss  int := 0;
  v_skipped  int := 0;
  v_active   int;
  v_pending  int;
  v_reason   text;
BEGIN
  IF p_min_confirmations < 1 THEN
    RAISE EXCEPTION 'promote_revoke_candidates: p_min_confirmations 必须 ≥ 1(0 等于关掉门控)'
      USING ERRCODE = '22023';
  END IF;

  -- 【0007 增补】R10 熔断的物理开关:被冻结的域一律 PGF01,先于任何写入与锁。
  --   冻结的是写入,不是采集 —— meta.* 的证据链(ingest_run/page_scan/scan_task/quarantine)不受影响。
  PERFORM meta.assert_writes_allowed('vote');
  PERFORM meta.ingest_gate_open();

  -- ---- ② 过期候选先出清:不产生撤票,只作废 ----------------------------------------
  UPDATE meta.revoke_candidate
     SET status = 'dismissed',
         held_reason = format('候选过期(last_seen_at 早于 %s 前),不予转正', p_max_age),
         resolved_at = now()
   WHERE status = 'pending' AND last_seen_at < now() - p_max_age;
  GET DIAGNOSTICS v_dismiss = ROW_COUNT;

  -- ---- ④ 单页比例熔断:先整页判定,再逐条转正 --------------------------------------
  FOR r IN
    SELECT rc.page_id, count(*)::int AS pending_n
      FROM meta.revoke_candidate rc
     WHERE rc.status = 'pending' AND rc.confirmations >= p_min_confirmations
     GROUP BY rc.page_id
     ORDER BY rc.page_id
  LOOP
    PERFORM pg_advisory_xact_lock(meta.lock_class_page(), r.page_id);

    SELECT count(*)::int INTO v_active
      FROM serve.vote_current
     WHERE page_id = r.page_id AND direction <> 0;

    IF v_active > 0 AND r.pending_n::real / v_active::real > p_max_page_ratio THEN
      v_reason := format('转正熔断:%s 条待撤 / %s 条有效票 > %s%%',
                         r.pending_n, v_active, (p_max_page_ratio * 100)::int);
      UPDATE meta.revoke_candidate
         SET status = 'held', held_reason = v_reason, resolved_at = NULL
       WHERE page_id = r.page_id AND status = 'pending';
      v_held := v_held + r.pending_n;
      CONTINUE;
    END IF;

    FOR v_pending IN
      SELECT rc.voter_id
        FROM meta.revoke_candidate rc
        JOIN serve.vote_current vc
          ON vc.page_id = rc.page_id AND vc.voter_id = rc.voter_id
       WHERE rc.page_id = r.page_id
         AND rc.status = 'pending'
         AND rc.confirmations >= p_min_confirmations
         AND vc.direction <> 0                      -- ③ 仍是有效票才需要撤
       ORDER BY rc.voter_id
    LOOP
      EXIT WHEN p_max_promote IS NOT NULL AND v_promoted >= p_max_promote;

      -- occurred_at 取候选首次缺席时刻:真实撤票发生在「最后一次见到票」与
      -- 「第一次没见到票」之间,first_seen_at 是这个区间可得的最保守上界。
      -- precision='observed' —— 明确宣告这不是秒级真值。
      SELECT ingest.apply_vote_observation(
               r.page_id, v_pending, 0,
               rc.first_seen_at, now(), 'observed', p_source, p_run)
        INTO v_seq
        FROM meta.revoke_candidate rc
       WHERE rc.page_id = r.page_id AND rc.voter_id = v_pending;

      IF v_seq IS NULL THEN
        v_skipped := v_skipped + 1;                 -- 状态已不需要转移(并发已处理)
        DELETE FROM meta.revoke_candidate
         WHERE page_id = r.page_id AND voter_id = v_pending;
        CONTINUE;
      END IF;

      UPDATE meta.revoke_candidate
         SET status = 'promoted', promoted_seq = v_seq, resolved_at = now()
       WHERE page_id = r.page_id AND voter_id = v_pending;
      v_promoted := v_promoted + 1;
    END LOOP;

    EXIT WHEN p_max_promote IS NOT NULL AND v_promoted >= p_max_promote;
  END LOOP;

  RETURN jsonb_build_object(
    'min_confirmations', p_min_confirmations,
    'promoted', v_promoted,
    'held', v_held,
    'dismissed', v_dismiss,
    'skipped', v_skipped);
END;
$$;
COMMENT ON FUNCTION ingest.promote_revoke_candidates(int, int, interval, real, bigint, text) IS
  '【A2】把连续 N 次(默认 2)完整且 checksum 通过的快照中都缺席的 (page,voter) 候选'
  '转正为 kind=''revoke'' 事件。走 apply_vote_observation,不是特权通道。'
  '过期候选作废、单页比例超阈整页扣住(held)等人工裁决。';

COMMIT;


-- =====================================================================================
-- 7. 修订 / 归属 / 论坛(设计 §5.5)
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 7.1 apply_revision_batch —— 修订批量(10 函数之一)
-- -------------------------------------------------------------------------------------
-- p_revisions: [{"wikidot_revision_id":123,"rev_no":7,"type":"page_edit","author_id":42,
--                "occurred_at":"...","comment":"...","source_sha":"<hex>"}]
--   wikidot_revision_id 与 rev_no 至少一个非空(表级 CHECK)。
-- 三条写路径:
--   ① 有 wid、且存在同 (page_id, rev_no) 的「待补行」(wid IS NULL) ⇒ 受控 UPDATE 回填
--      wid/type/source_sha 三列(触发器列白名单放行,GUC 由本函数的 SET 子句提供,
--      函数返回时自动还原 —— 不会把放行状态泄漏到事务的其余部分)
--   ② 有 wid、无待补行 ⇒ INSERT ... ON CONFLICT (wikidot_revision_id) DO NOTHING
--   ③ 无 wid(直连直抓)⇒ INSERT 待补行,ON CONFLICT (page_id, rev_no) WHERE wid IS NULL DO NOTHING
-- 绝不 DO UPDATE 静默合并:上游 index 竞态导致的 (page_id, rev_no) 重复(两个不同 wid)
-- 合法共存(唯一键在 wid 上);无法归属的冲突行进 meta.fact_quarantine。
CREATE OR REPLACE FUNCTION ingest.apply_revision_batch(
  p_page          int,
  p_revisions     jsonb,
  p_claimed_total int         DEFAULT NULL,      -- ListPages %%revisions%%
  p_observed      timestamptz DEFAULT now(),
  p_source        text        DEFAULT 'wikidot',
  p_run           bigint      DEFAULT NULL,
  p_wikidot_id    int         DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_raw      int;
  v_typefill int := 0;
  v_backfill int := 0;
  v_ins_wid  int := 0;
  v_ins_pend int := 0;
  v_quar     int := 0;
  v_total    int;
  v_expected int;
  v_status   text;
  v_reason   text := NULL;
  v_guc_prev text;   -- 见下「放行窗口」注释
BEGIN
  IF p_revisions IS NULL OR jsonb_typeof(p_revisions) <> 'array' THEN
    RAISE EXCEPTION 'apply_revision_batch: p_revisions 必须是 jsonb array' USING ERRCODE = '22023';
  END IF;

  -- 【0007 增补】R10 熔断的物理开关:被冻结的域一律 PGF01,先于任何写入与锁。
  --   冻结的是写入,不是采集 —— meta.* 的证据链(ingest_run/page_scan/scan_task/quarantine)不受影响。
  PERFORM meta.assert_writes_allowed('revision');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  SELECT count(*)::int INTO v_raw FROM jsonb_array_elements(p_revisions) AS e(r);
  v_expected := meta.revision_list_count(p_claimed_total);

  -- ---- 0. 冲突隔离:wid 已存在于**别的页面**(实测 v1 存量 29 个跨页重复 wid)-------
  INSERT INTO meta.fact_quarantine(domain, page_id, natural_key, raw, reason, source,
                                   run_id, observed_at)
  SELECT 'revision', p_page, r ->> 'wikidot_revision_id', r,
         'wid_bound_to_other_page', p_source, p_run, p_observed
    FROM jsonb_array_elements(p_revisions) AS e(r)
   WHERE NULLIF(r ->> 'wikidot_revision_id','') IS NOT NULL
     AND EXISTS (SELECT 1 FROM ingest.revision rv
                  WHERE rv.wikidot_revision_id = (r ->> 'wikidot_revision_id')::bigint
                    AND rv.page_id <> p_page);
  GET DIAGNOSTICS v_quar = ROW_COUNT;

  -- ---- 0b. type 跨源冲突隔离(实测 P2-5:FLAG_TYPE_MAP 中文失配已污染生产)---------
  -- 已有非空 type 且与本次不同 ⇒ 留痕,**不覆盖**(触发器也会拦,这里是为了留下证据)。
  INSERT INTO meta.fact_quarantine(domain, page_id, natural_key, raw, reason, source,
                                   run_id, observed_at)
  SELECT 'revision', p_page, r ->> 'wikidot_revision_id',
         r || jsonb_build_object('existing_type', rv.type),
         'type_conflict_across_sources', p_source, p_run, p_observed
    FROM jsonb_array_elements(p_revisions) AS e(r)
    JOIN ingest.revision rv
      ON rv.wikidot_revision_id = NULLIF(r ->> 'wikidot_revision_id','')::bigint
   WHERE rv.type IS NOT NULL
     AND rv.type <> 'unknown'
     AND NULLIF(r ->> 'type','') IS NOT NULL
     AND (r ->> 'type') <> 'unknown'
     AND rv.type <> (r ->> 'type');

  -- ---- 1. 已有 wid 的 unknown→具体 type + 待补行回填 -------------------------------
  --
  -- 【2026-07-27 整合修正:放行窗口从「函数级 SET」改为「语句级 set_config 显式开关」】
  --   原实现用 CREATE FUNCTION ... SET scpper.revision_backfill='on' 子句。它在 PG15+
  --   **建不出来**:把未注册前缀的自定义 GUC 写进 proconfig 需要该参数的 SET 权限,
  --   而 GRANT SET ON PARAMETER 本身要 superuser(实测 42501:permission denied to set
  --   parameter "scpper.revision_backfill";user_dxzbdi 非 superuser)。
  --   改法与原意图等价甚至更严:
  --     * set_config(..., is_local := true) 是事务级,函数返回后仍然有效 —— 所以必须显式
  --       还原,这正是原注释担心的「SET LOCAL 泄漏」。这里在紧邻的下一条语句就还原,
  --       放行窗口收窄到**仅这一条 UPDATE**(比原来「整个函数体都放行」更小)。
  --     * 异常路径安全:GUC 变更受事务/子事务保护,本函数抛错 ⇒ 连同 GUC 一起回滚,
  --       不可能留下一个敞开的放行位。
  --   ⚠ 不要把还原语句挪到函数末尾:第 2/3 步的 INSERT 不需要放行,而放行位每多敞开
  --     一条语句,就多一条「白名单外的列被就地改写」的可能路径。
  v_guc_prev := current_setting('scpper.revision_backfill', true);
  PERFORM set_config('scpper.revision_backfill', 'on', true);

  WITH inc AS (
    SELECT (r ->> 'wikidot_revision_id')::bigint AS wid,
           (r ->> 'rev_no')::int                 AS rev_no,
           NULLIF(r ->> 'type','')               AS type,
           decode(NULLIF(r ->> 'source_sha',''), 'hex') AS sha
      FROM jsonb_array_elements(p_revisions) AS e(r)
     WHERE NULLIF(r ->> 'wikidot_revision_id','') IS NOT NULL
  ), type_upd AS (
    -- S2 必须原样保留 CROM 的 unknown；直连日后拿到更具体 flag 时允许单向补实。
    -- concrete→其它值仍由 0b 隔离，unknown 也绝不倒退覆盖已有 concrete。
    UPDATE ingest.revision rv
       SET type = i.type
      FROM inc i
     WHERE rv.page_id = p_page
       AND rv.wikidot_revision_id = i.wid
       AND rv.type = 'unknown'
       AND i.type IS NOT NULL
       AND i.type <> 'unknown'
    RETURNING 1
  ), upd AS (
    UPDATE ingest.revision rv
       SET wikidot_revision_id = i.wid,
           type       = CASE
                          WHEN rv.type IS NULL OR rv.type = 'unknown'
                            THEN COALESCE(i.type, rv.type)
                          ELSE rv.type
                        END,
           source_sha = COALESCE(rv.source_sha, i.sha)
      FROM inc i
     WHERE rv.page_id = p_page
       AND rv.rev_no  = i.rev_no
       AND rv.wikidot_revision_id IS NULL
       AND i.rev_no IS NOT NULL
       -- 目标 wid 不能已被占用,否则 UNIQUE 会炸整批(已在第 0 步留痕)
       AND NOT EXISTS (SELECT 1 FROM ingest.revision x WHERE x.wikidot_revision_id = i.wid)
       -- 引用完整性:blob 未入库就别写 source_sha
       AND (i.sha IS NULL OR EXISTS (SELECT 1 FROM ingest.content_blob b WHERE b.sha256 = i.sha))
    RETURNING 1
  )
  SELECT (SELECT count(*)::int FROM type_upd),
         (SELECT count(*)::int FROM upd)
    INTO v_typefill, v_backfill;

  -- 立刻关掉放行位:此后本事务里任何对 ingest.revision 的 UPDATE 都会被触发器拒绝。
  PERFORM set_config('scpper.revision_backfill', COALESCE(v_guc_prev, 'off'), true);

  -- ---- 2. 有 wid 的新行 -------------------------------------------------------------
  WITH ins AS (
    INSERT INTO ingest.revision(page_id, wikidot_revision_id, rev_no, type, author_id,
                                occurred_at, comment, source_sha, observed_at, source)
    SELECT p_page,
           (r ->> 'wikidot_revision_id')::bigint,
           NULLIF(r ->> 'rev_no','')::int,
           NULLIF(r ->> 'type',''),
           NULLIF(r ->> 'author_id','')::int,
           COALESCE(NULLIF(r ->> 'occurred_at','')::timestamptz, p_observed),
           NULLIF(r ->> 'comment',''),
           CASE WHEN NULLIF(r ->> 'source_sha','') IS NOT NULL
                 AND EXISTS (SELECT 1 FROM ingest.content_blob b
                              WHERE b.sha256 = decode(r ->> 'source_sha','hex'))
                THEN decode(r ->> 'source_sha','hex') END,
           p_observed, p_source
      FROM jsonb_array_elements(p_revisions) AS e(r)
     WHERE NULLIF(r ->> 'wikidot_revision_id','') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ingest.revision x
                        WHERE x.wikidot_revision_id = (r ->> 'wikidot_revision_id')::bigint)
     ORDER BY (r ->> 'wikidot_revision_id')::bigint
    ON CONFLICT (wikidot_revision_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO v_ins_wid FROM ins;

  -- ---- 3. 无 wid 的待补行(直连直抓)------------------------------------------------
  WITH ins AS (
    INSERT INTO ingest.revision(page_id, wikidot_revision_id, rev_no, type, author_id,
                                occurred_at, comment, source_sha, observed_at, source)
    SELECT p_page, NULL,
           (r ->> 'rev_no')::int,
           NULLIF(r ->> 'type',''),
           NULLIF(r ->> 'author_id','')::int,
           COALESCE(NULLIF(r ->> 'occurred_at','')::timestamptz, p_observed),
           NULLIF(r ->> 'comment',''),
           CASE WHEN NULLIF(r ->> 'source_sha','') IS NOT NULL
                 AND EXISTS (SELECT 1 FROM ingest.content_blob b
                              WHERE b.sha256 = decode(r ->> 'source_sha','hex'))
                THEN decode(r ->> 'source_sha','hex') END,
           p_observed, p_source
      FROM jsonb_array_elements(p_revisions) AS e(r)
     WHERE NULLIF(r ->> 'wikidot_revision_id','') IS NULL
       AND NULLIF(r ->> 'rev_no','') IS NOT NULL
     ORDER BY (r ->> 'rev_no')::int
    ON CONFLICT (page_id, rev_no) WHERE wikidot_revision_id IS NULL DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO v_ins_pend FROM ins;

  -- ---- 4. revision_count 由本地事实折叠(不用远端自报值)---------------------------
  SELECT count(*)::int INTO v_total FROM ingest.revision WHERE page_id = p_page;
  UPDATE serve.page_current
     SET revision_count = v_total, updated_at = now()
   WHERE page_id = p_page AND revision_count <> v_total;

  -- ---- 5. 扫描证据 + P0-8 静默截断检测 ---------------------------------------------
  -- 【2026-07-27 实测·P0-8】PageRevisionListModule 不传 perpage 只返回 1 行(不是全部、
  -- 也不是 20)。「期望真实行数 >1、却只收到 1 条」= 抓取层漏传 perpage 的确定指纹,
  -- 判 failed 而不是 partial:这不是数据缺一点,是整条时间轴被截断成 1 条。
  -- 其余场景必须严格满足 v_raw = %%revisions%% + offset；多或少都只构成 partial，
  -- 绝不能再用 >= 吞掉非预期偏移。
  IF v_expected > 1 AND v_raw = 1 THEN
    v_status := 'failed';
    v_reason := format(
      '疑似漏传 perpage:仅解析到 1 条；远端零基声明 %s，期望真实 %s 条(P0-8)',
      p_claimed_total, v_expected);
  ELSIF p_claimed_total IS NULL THEN
    v_status := 'ok';
  ELSIF v_raw = v_expected THEN
    v_status := 'ok';
  ELSE
    v_status := 'partial';
    v_reason := format(
      'RevisionList 解析 %s 条 ≠ 远端零基声明 %s + offset（期望 %s 条）',
      v_raw, p_claimed_total, v_expected);
  END IF;
  PERFORM meta.record_page_scan(p_run, p_page, 'revisions', v_status,
                                p_claimed_total, v_raw, NULL, NULL, NULL, NULL, v_reason);

  RETURN jsonb_build_object(
    'raw', v_raw, 'type_backfilled', v_typefill, 'backfilled', v_backfill,
    'inserted_with_wid', v_ins_wid,
    'inserted_pending', v_ins_pend, 'quarantined', v_quar,
    'revision_count', v_total, 'scan_status', v_status, 'reason', v_reason);
END;
$$;
COMMENT ON FUNCTION ingest.apply_revision_batch(int, jsonb, int, timestamptz, text, bigint, int) IS
  '修订批量:待补行回填(wid/type/source_sha 白名单单向)+ 按 wid 幂等插入 + 无 wid 待补行插入。'
  '绝不 DO UPDATE 合并;跨页重复 wid 与 type 跨源冲突进 meta.fact_quarantine。'
  '完整性口径:RevisionList 行数 = 零基 claimed_total + offset(1)，偏离即 partial；'
  '期望多行却只解析到 1 条判 failed(P0-8 漏传 perpage 的确定指纹)。';

-- -------------------------------------------------------------------------------------
-- 7.2 apply_attribution_snapshot —— 归属集合 diff(10 函数之一)
-- -------------------------------------------------------------------------------------
-- p_entries: [{"actor_id":42,"role":"AUTHOR","ord":0,"at_date":"2020-01-01"}]
-- 集合 diff → added / removed / updated 事件 + 重算 is_display(SUBMITTER 抑制写时物化)。
-- removed 只在 p_is_complete=true 时产生 —— absence 推断的同一条红线。
CREATE OR REPLACE FUNCTION ingest.apply_attribution_snapshot(
  p_page        int,
  p_entries     jsonb,
  p_is_complete boolean,
  p_observed    timestamptz,
  p_source      text,
  p_run         bigint DEFAULT NULL,
  p_wikidot_id  int    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_added int := 0; v_updated int := 0; v_removed int := 0;
  v_total int; v_raw int;
BEGIN
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'apply_attribution_snapshot: p_entries 必须是 jsonb array' USING ERRCODE = '22023';
  END IF;

  -- 【0007 增补】R10 熔断的物理开关:被冻结的域一律 PGF01,先于任何写入与锁。
  --   冻结的是写入,不是采集 —— meta.* 的证据链(ingest_run/page_scan/scan_task/quarantine)不受影响。
  PERFORM meta.assert_writes_allowed('attribution');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  SELECT count(*)::int INTO v_raw FROM jsonb_array_elements(p_entries) AS e(r);

  -- ---- added ------------------------------------------------------------------------
  WITH inc AS MATERIALIZED (
    SELECT DISTINCT ON (role, actor_id) role, actor_id, ord, at_date
      FROM (
        SELECT (r ->> 'role')                       AS role,
               (r ->> 'actor_id')::int              AS actor_id,
               COALESCE(NULLIF(r ->> 'ord','')::int, 0) AS ord,
               NULLIF(r ->> 'at_date','')::date     AS at_date
          FROM jsonb_array_elements(p_entries) AS e(r)
         WHERE NULLIF(r ->> 'actor_id','') IS NOT NULL AND NULLIF(r ->> 'role','') IS NOT NULL
      ) x
     ORDER BY role, actor_id, ord
  ), add AS MATERIALIZED (
    SELECT i.* FROM inc i
     WHERE NOT EXISTS (SELECT 1 FROM serve.attribution_current ac
                        WHERE ac.page_id = p_page AND ac.role = i.role AND ac.actor_id = i.actor_id)
  ), ev AS (
    INSERT INTO ingest.attribution_event(page_id, actor_id, role, action, at_date,
                                         observed_at, source)
    SELECT p_page, a.actor_id, a.role, 'added', a.at_date, p_observed, p_source
      FROM add a ORDER BY a.role, a.actor_id
    RETURNING seq, role, actor_id
  ), ins AS (
    INSERT INTO serve.attribution_current(page_id, role, actor_id, ord, at_date, is_display, last_seq)
    SELECT p_page, a.role, a.actor_id, a.ord, a.at_date, true, e.seq
      FROM add a JOIN ev e ON e.role = a.role AND e.actor_id = a.actor_id
    ON CONFLICT (page_id, role, actor_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO v_added FROM ins;

  -- ---- updated(能捕捉原地更新,不再寄生版本轮转)----------------------------------
  WITH inc AS MATERIALIZED (
    SELECT DISTINCT ON (role, actor_id) role, actor_id, ord, at_date
      FROM (
        SELECT (r ->> 'role') AS role, (r ->> 'actor_id')::int AS actor_id,
               COALESCE(NULLIF(r ->> 'ord','')::int, 0) AS ord,
               NULLIF(r ->> 'at_date','')::date AS at_date
          FROM jsonb_array_elements(p_entries) AS e(r)
         WHERE NULLIF(r ->> 'actor_id','') IS NOT NULL AND NULLIF(r ->> 'role','') IS NOT NULL
      ) x
     ORDER BY role, actor_id, ord
  ), chg AS MATERIALIZED (
    SELECT i.role, i.actor_id, i.ord, i.at_date
      FROM inc i
      JOIN serve.attribution_current ac
        ON ac.page_id = p_page AND ac.role = i.role AND ac.actor_id = i.actor_id
     WHERE (ac.ord, ac.at_date) IS DISTINCT FROM (i.ord, i.at_date)
  ), ev AS (
    INSERT INTO ingest.attribution_event(page_id, actor_id, role, action, at_date,
                                         observed_at, source)
    SELECT p_page, c.actor_id, c.role, 'updated', c.at_date, p_observed, p_source
      FROM chg c ORDER BY c.role, c.actor_id
    RETURNING seq, role, actor_id
  ), upd AS (
    UPDATE serve.attribution_current ac
       SET ord = c.ord, at_date = c.at_date, last_seq = e.seq
      FROM chg c JOIN ev e ON e.role = c.role AND e.actor_id = c.actor_id
     WHERE ac.page_id = p_page AND ac.role = c.role AND ac.actor_id = c.actor_id
    RETURNING 1
  )
  SELECT count(*)::int INTO v_updated FROM upd;

  -- ---- removed(仅 is_complete=true)------------------------------------------------
  -- 与投票域同一条红线:不完整的观测只允许「增」。归属的 absence 同样可能来自
  -- 约定页解析失败(实测:attribution-metadata 两页是全站归属的唯一来源,
  -- 一次解析变形就会让全站归属集体「消失」)。
  IF COALESCE(p_is_complete, false) THEN
    WITH inc AS MATERIALIZED (
      SELECT (r ->> 'role') AS role, (r ->> 'actor_id')::int AS actor_id
        FROM jsonb_array_elements(p_entries) AS e(r)
       WHERE NULLIF(r ->> 'actor_id','') IS NOT NULL AND NULLIF(r ->> 'role','') IS NOT NULL
    ), gone AS MATERIALIZED (
      SELECT ac.role, ac.actor_id, ac.at_date
        FROM serve.attribution_current ac
       WHERE ac.page_id = p_page
         AND NOT EXISTS (SELECT 1 FROM inc i WHERE i.role = ac.role AND i.actor_id = ac.actor_id)
    ), ev AS (
      INSERT INTO ingest.attribution_event(page_id, actor_id, role, action, at_date,
                                           observed_at, source)
      SELECT p_page, g.actor_id, g.role, 'removed', g.at_date, p_observed, p_source
        FROM gone g ORDER BY g.role, g.actor_id
      RETURNING seq, role, actor_id
    ), del AS (
      DELETE FROM serve.attribution_current ac
       USING gone g
       WHERE ac.page_id = p_page AND ac.role = g.role AND ac.actor_id = g.actor_id
      RETURNING 1
    )
    SELECT count(*)::int INTO v_removed FROM del;
  END IF;

  -- ---- is_display 写时物化(SUBMITTER 抑制)-----------------------------------------
  -- v1 有 7+ 处 BOOL_OR / 窗口函数样板在读时重复这个判断。规则:该页存在任何
  -- 非 SUBMITTER 归属时,SUBMITTER 不参与展示/计分。
  -- 【2026-07-27 实测·P1-4】70% 的 attribution 是 SUBMITTER、41,800 个 pageVersion 只有
  -- SUBMITTER —— 所以「只有 SUBMITTER」必须保持 is_display=true,否则这些页的作者会集体消失。
  UPDATE serve.attribution_current ac
     SET is_display = NOT (upper(ac.role) = 'SUBMITTER' AND EXISTS (
           SELECT 1 FROM serve.attribution_current o
            WHERE o.page_id = p_page AND upper(o.role) <> 'SUBMITTER'))
   WHERE ac.page_id = p_page
     AND ac.is_display <> NOT (upper(ac.role) = 'SUBMITTER' AND EXISTS (
           SELECT 1 FROM serve.attribution_current o
            WHERE o.page_id = p_page AND upper(o.role) <> 'SUBMITTER'));

  SELECT count(*)::int INTO v_total FROM serve.attribution_current WHERE page_id = p_page;
  UPDATE serve.page_current
     SET attribution_count = v_total, updated_at = now()
   WHERE page_id = p_page AND attribution_count <> v_total;

  PERFORM meta.record_page_scan(p_run, p_page, 'attributions',
                                CASE WHEN COALESCE(p_is_complete, false) THEN 'ok' ELSE 'partial' END,
                                NULL, v_raw, NULL, NULL, NULL, NULL,
                                CASE WHEN NOT COALESCE(p_is_complete, false)
                                     THEN 'is_complete=false ⇒ 本轮不产生 removed' END);

  RETURN jsonb_build_object('raw', v_raw, 'added', v_added, 'updated', v_updated,
                            'removed', v_removed, 'attribution_count', v_total);
END;
$$;
COMMENT ON FUNCTION ingest.apply_attribution_snapshot(int, jsonb, boolean, timestamptz, text, bigint, int) IS
  '归属集合 diff → added/removed/updated 事件 + attribution_current 维护 + is_display 写时物化。'
  'removed 仅在 is_complete=true 时产生(与投票域同一条 absence 红线)。';

COMMIT;


-- =====================================================================================
-- 7.3 论坛域(设计 §5.5)
-- =====================================================================================

BEGIN;

-- thread → page_id 反解:经 serve.page_current.discussion_thread_id,
-- 彻底取代 v1 的 title-as-slug 猜测(57% NULL + repair-forum-page-links 那条歧路)。
CREATE OR REPLACE FUNCTION ingest.resolve_thread_page(p_thread_id bigint)
RETURNS int
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pc.page_id FROM serve.page_current pc
   WHERE pc.discussion_thread_id = p_thread_id
   ORDER BY (pc.status = 'live') DESC, pc.page_id
   LIMIT 1;
$$;

-- -------------------------------------------------------------------------------------
-- apply_forum_batch —— 论坛批量 upsert(10 函数之一)
-- -------------------------------------------------------------------------------------
-- p_categories: [{"id":1,"title":"…","description":"…","thread_count":1,"post_count":2}]
-- p_threads:    [{"id":1,"category_id":1,"title":"…","created_by_user_id":42,
--                 "created_by_name":"…","created_at":"…","post_count":3,"is_deleted":false}]
-- p_posts:      [{"id":1,"thread_id":1,"parent_post_id":null,"author_user_id":42,
--                 "author_name":"…","title":"…","text_html":"…","text_plain":"…",
--                 "created_at":"…","edited_at":null,"is_deleted":false}]
-- 上游原生 id 为主键 ⇒ 幂等。作者 wid>0 由调用方经 ensure_user 归一后传 *_user_id;
-- wid≤0 保留 name 快照(存量不清洗,设计出界项)。
-- 红线:absence 永不推断删除。is_deleted 只在 payload 显式给出时才写。
CREATE OR REPLACE FUNCTION ingest.apply_forum_batch(
  p_categories jsonb,
  p_threads    jsonb,
  p_posts      jsonb,
  p_observed   timestamptz DEFAULT now(),
  p_source     text        DEFAULT 'wikidot',
  p_run        bigint      DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_cat int := 0; v_thr int := 0; v_post int := 0; v_quar int := 0; v_linked int := 0;
  v_pid int;
BEGIN
  IF jsonb_typeof(COALESCE(p_categories,'[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_threads,'[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_posts,'[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'apply_forum_batch: 三个入参都必须是 jsonb array 或 NULL' USING ERRCODE = '22023';
  END IF;

  -- 【0007 增补】R10 熔断的物理开关:被冻结的域一律 PGF01,先于任何写入与锁。
  --   冻结的是写入,不是采集 —— meta.* 的证据链(ingest_run/page_scan/scan_task/quarantine)不受影响。
  PERFORM meta.assert_writes_allowed('forum');
  PERFORM meta.ingest_gate_open();

  -- ---- 1. category ------------------------------------------------------------------
  WITH up AS (
    INSERT INTO ingest.forum_category AS fc
                                     (id, title, description, thread_count, post_count,
                                      last_synced_at)
    SELECT DISTINCT ON ((r ->> 'id')::bigint)
           (r ->> 'id')::bigint, NULLIF(r ->> 'title',''), NULLIF(r ->> 'description',''),
           COALESCE(NULLIF(r ->> 'thread_count','')::int, 0),
           COALESCE(NULLIF(r ->> 'post_count','')::int, 0),
           p_observed
      FROM jsonb_array_elements(COALESCE(p_categories,'[]'::jsonb)) AS e(r)
     WHERE NULLIF(r ->> 'id','') IS NOT NULL
     ORDER BY (r ->> 'id')::bigint
    ON CONFLICT (id) DO UPDATE
      SET title = COALESCE(EXCLUDED.title, fc.title),
          description = COALESCE(EXCLUDED.description, fc.description),
          -- 上游自报计数原样保留:它是采集完整度信号,不是本地折叠值,不参与本地统计
          thread_count = EXCLUDED.thread_count,
          post_count = EXCLUDED.post_count,
          last_synced_at = EXCLUDED.last_synced_at
    RETURNING 1
  )
  SELECT count(*)::int INTO v_cat FROM up;

  -- ---- 2. thread(未知 category 进隔离,不静默建桩)---------------------------------
  INSERT INTO meta.fact_quarantine(domain, page_id, natural_key, raw, reason, source,
                                   run_id, observed_at)
  SELECT 'forum', NULL, r ->> 'id', r, 'unknown_category_id', p_source, p_run, p_observed
    FROM jsonb_array_elements(COALESCE(p_threads,'[]'::jsonb)) AS e(r)
   WHERE NULLIF(r ->> 'id','') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ingest.forum_category c
                      WHERE c.id = NULLIF(r ->> 'category_id','')::bigint);
  GET DIAGNOSTICS v_quar = ROW_COUNT;

  WITH up AS (
    INSERT INTO ingest.forum_thread AS ft
                                   (id, category_id, page_id, page_id_source,
                                    title, created_by_user_id,
                                    created_by_name, created_at, post_count, is_deleted,
                                    last_synced_at)
    SELECT DISTINCT ON ((r ->> 'id')::bigint)
           (r ->> 'id')::bigint,
           (r ->> 'category_id')::bigint,
           ingest.resolve_thread_page((r ->> 'id')::bigint),
           CASE WHEN ingest.resolve_thread_page((r ->> 'id')::bigint) IS NULL
                THEN NULL ELSE 'verified' END,
           COALESCE(NULLIF(r ->> 'title',''), '(untitled)'),
           -- 身份必须已存在(调用方走 ensure_user);不存在则退化为 name 快照而不是炸 FK
           CASE WHEN EXISTS (SELECT 1 FROM ingest."user" u
                              WHERE u.id = NULLIF(r ->> 'created_by_user_id','')::int)
                THEN NULLIF(r ->> 'created_by_user_id','')::int END,
           NULLIF(r ->> 'created_by_name',''),
           COALESCE(NULLIF(r ->> 'created_at','')::timestamptz, p_observed),
           COALESCE(NULLIF(r ->> 'post_count','')::int, 0),
           COALESCE(NULLIF(r ->> 'is_deleted','')::boolean, false),
           p_observed
      FROM jsonb_array_elements(COALESCE(p_threads,'[]'::jsonb)) AS e(r)
     WHERE NULLIF(r ->> 'id','') IS NOT NULL
       AND EXISTS (SELECT 1 FROM ingest.forum_category c
                    WHERE c.id = NULLIF(r ->> 'category_id','')::bigint)
     ORDER BY (r ->> 'id')::bigint
    ON CONFLICT (id) DO UPDATE
      SET category_id = EXCLUDED.category_id,
          -- 反解到的值来自 ForumCommentsListModule，是真值：允许覆盖 v1 inferred。
          -- 反解不到时仍只补不清；inferred 结转走专门入口，绝不反向覆盖 verified。
          page_id = CASE WHEN EXCLUDED.page_id IS NOT NULL
                         THEN EXCLUDED.page_id ELSE ft.page_id END,
          page_id_source = CASE WHEN EXCLUDED.page_id IS NOT NULL
                                THEN 'verified' ELSE ft.page_id_source END,
          title = EXCLUDED.title,
          created_by_user_id = COALESCE(EXCLUDED.created_by_user_id, ft.created_by_user_id),
          created_by_name = COALESCE(EXCLUDED.created_by_name, ft.created_by_name),
          post_count = EXCLUDED.post_count,
          is_deleted = EXCLUDED.is_deleted,
          last_synced_at = EXCLUDED.last_synced_at
    RETURNING page_id
  )
  SELECT count(*)::int, count(page_id)::int INTO v_thr, v_linked FROM up;

  -- ---- 3. post(未知 thread 进隔离)-------------------------------------------------
  INSERT INTO meta.fact_quarantine(domain, page_id, natural_key, raw, reason, source,
                                   run_id, observed_at)
  SELECT 'forum', NULL, r ->> 'id', r, 'unknown_thread_id', p_source, p_run, p_observed
    FROM jsonb_array_elements(COALESCE(p_posts,'[]'::jsonb)) AS e(r)
   WHERE NULLIF(r ->> 'id','') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ingest.forum_thread t
                      WHERE t.id = NULLIF(r ->> 'thread_id','')::bigint);

  WITH up AS (
    INSERT INTO ingest.forum_post AS fp
                                 (id, thread_id, parent_post_id, author_user_id, author_name,
                                  title, text_html, text_plain, created_at, edited_at,
                                  is_deleted, observed_at)
    SELECT DISTINCT ON ((r ->> 'id')::bigint)
           (r ->> 'id')::bigint,
           (r ->> 'thread_id')::bigint,
           NULLIF(r ->> 'parent_post_id','')::bigint,
           CASE WHEN EXISTS (SELECT 1 FROM ingest."user" u
                              WHERE u.id = NULLIF(r ->> 'author_user_id','')::int)
                THEN NULLIF(r ->> 'author_user_id','')::int END,
           NULLIF(r ->> 'author_name',''),
           NULLIF(r ->> 'title',''),
           NULLIF(r ->> 'text_html',''),
           -- text_plain 优先用调用方预提取值;缺失时用粗剥标签兜底(pgroonga 索引建在此列,
           -- 宁可有一个粗糙值也不要 NULL —— NULL 会让论坛搜索退回 ILIKE 全表扫)
           COALESCE(NULLIF(r ->> 'text_plain',''),
                    NULLIF(btrim(regexp_replace(COALESCE(r ->> 'text_html',''),
                                                '<[^>]*>', ' ', 'g')), '')),
           COALESCE(NULLIF(r ->> 'created_at','')::timestamptz, p_observed),
           NULLIF(r ->> 'edited_at','')::timestamptz,
           COALESCE(NULLIF(r ->> 'is_deleted','')::boolean, false),
           p_observed
      FROM jsonb_array_elements(COALESCE(p_posts,'[]'::jsonb)) AS e(r)
     WHERE NULLIF(r ->> 'id','') IS NOT NULL
       AND EXISTS (SELECT 1 FROM ingest.forum_thread t
                    WHERE t.id = NULLIF(r ->> 'thread_id','')::bigint)
     ORDER BY (r ->> 'id')::bigint
    ON CONFLICT (id) DO UPDATE
      SET thread_id = EXCLUDED.thread_id,
          parent_post_id = COALESCE(EXCLUDED.parent_post_id, fp.parent_post_id),
          author_user_id = COALESCE(EXCLUDED.author_user_id, fp.author_user_id),
          author_name = COALESCE(EXCLUDED.author_name, fp.author_name),
          title = COALESCE(EXCLUDED.title, fp.title),
          text_html = COALESCE(EXCLUDED.text_html, fp.text_html),
          text_plain = COALESCE(EXCLUDED.text_plain, fp.text_plain),
          edited_at = COALESCE(EXCLUDED.edited_at, fp.edited_at),
          is_deleted = EXCLUDED.is_deleted,
          observed_at = EXCLUDED.observed_at
    RETURNING 1
  )
  SELECT count(*)::int INTO v_post FROM up;

  -- ---- 4. 扫描证据(【0007 增补】补上一个静默缺口)-----------------------------------
  -- meta.page_scan.kind 的词表里一直有 'forum',但**没有任何代码写它** ——
  -- 于是「这一页的论坛数据在这一轮被扫过吗」这个问题在库里无法回答,
  -- 而 scan_task 的 stable_count 收敛与 meta.irreconcilable 都以 page_scan 为唯一输入。
  --
  -- status 刻意写 'partial' 而不是 'ok':本函数的入参里**没有任何完整性声明**
  -- (没有 is_complete、没有 claimed_total),它只是一次 upsert 批。
  -- 记 'ok' 会造出一条「这一页论坛数据完整」的假证据,而 page_scan.status='ok'
  -- 恰恰是 absence 推断的授权凭证 —— 那就等于给论坛域伪造了一张通行证。
  -- 想要 'ok',必须先给本函数加显式完整性入参(留给论坛采集器落地时一起做)。
  FOR v_pid IN
    SELECT DISTINCT t.page_id
      FROM ingest.forum_thread t
     WHERE t.page_id IS NOT NULL
       AND t.id IN (SELECT NULLIF(r ->> 'id','')::bigint
                      FROM jsonb_array_elements(COALESCE(p_threads,'[]'::jsonb)) AS e(r))
  LOOP
    PERFORM meta.record_page_scan(
      p_run, v_pid, 'forum', 'partial', NULL, NULL, NULL, NULL, NULL, NULL,
      'apply_forum_batch 无完整性声明:批量 upsert 不构成 kind=forum 的完整证据,'
      '不得作为 absence 推断的授权');
  END LOOP;

  RETURN jsonb_build_object('categories', v_cat, 'threads', v_thr, 'threads_linked', v_linked,
                            'posts', v_post, 'quarantined', v_quar);
END;
$$;
COMMENT ON FUNCTION ingest.apply_forum_batch(jsonb, jsonb, jsonb, timestamptz, text, bigint) IS
  '论坛三表批量 upsert(上游原生 id 幂等)。thread.page_id 经 page_current.discussion_thread_id '
  '反解并标 verified，可覆盖 v1 inferred；未知 category/thread 进 meta.fact_quarantine 不静默建桩;'
  'is_deleted 只在 payload 显式给出时写 —— absence 永不推断论坛删除。'
  '【0007】为每个被本批触及的 page 补一条 meta.page_scan(kind=''forum'', status=''partial''):'
  '词表里有 forum 却没人写它,等于论坛域完全没有页级证据链;status 只能是 partial —— '
  '本函数没有任何完整性入参,记 ok 就是伪造 absence 推断的授权凭证。';

COMMIT;


-- =====================================================================================
-- 8. 权限:SECURITY DEFINER 函数必须先对 PUBLIC 关门(设计 §4.1 / §4.8-2)
-- =====================================================================================
-- SECURITY DEFINER + 默认的 PUBLIC EXECUTE = 任何能连库的角色都能以属主身份写事实表。
-- REVOKE 不需要 CREATEROLE,所以这一段可以由当前连接用户执行;
-- GRANT 部分只在目标角色已存在时才执行(角色创建见需 DBA 执行的 0900_roles_admin.sql)。
BEGIN;

DO $do$
DECLARE
  r record;
  v_ingestor  oid := to_regrole('ingestor_role');
  v_bff       oid := to_regrole('bff_role');
  v_projector oid := to_regrole('projector_role');
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('ingest','meta')
       AND p.prosecdef                       -- 只处理 SECURITY DEFINER 的
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);

    -- ingestor_role:仅 EXECUTE apply_* / register_page / ensure_user / gate,对表无 DML
    IF v_ingestor IS NOT NULL
       AND (r.proname LIKE 'apply\_%' OR r.proname IN
            ('register_page','ensure_user','put_content_blob','put_content_blob_sha',
             'promote_revoke_candidates','norm_direction','assert_page_identity',
             'resolve_thread_page','ingest_gate_open','ingest_gate_close','record_page_scan')) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ingestor_role', r.sig);
    END IF;

    -- bff_role:只给 ensure_user(BFF 收藏夹要铸 synthetic 用户),别的一个都不给
    IF v_bff IS NOT NULL AND r.proname = 'ensure_user' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO bff_role', r.sig);
    END IF;

    -- projector_role:游标安全那一套 + 精度偏序(投影里要用)
    IF v_projector IS NOT NULL
       AND r.proname IN ('safe_seq_watermark','projection_window','advance_projection_cursor',
                         'ingest_gate_sweep','precision_rank') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO projector_role', r.sig);
    END IF;
  END LOOP;

  IF v_ingestor IS NULL THEN
    RAISE NOTICE '[0006] ingestor_role 不存在,已跳过 GRANT。请由 DBA 执行 9000_roles_grants.sql.ADMIN '
                 '后重跑本文件第 8 节(REVOKE 已生效,函数当前只有属主可执行)。';
  END IF;
END
$do$;

COMMIT;

-- =====================================================================================
-- 9. 变更签名时的成套 DROP(默认注释;CREATE OR REPLACE 改不了参数名/类型/顺序)
-- =====================================================================================
-- DROP FUNCTION IF EXISTS ingest.register_page(int,text,timestamptz,text,int,timestamptz,bigint);
-- DROP FUNCTION IF EXISTS ingest.ensure_user(text,int,text,text,text,text,int);
-- DROP FUNCTION IF EXISTS ingest.apply_page_meta(int,jsonb,timestamptz,text,bigint,int);
-- DROP FUNCTION IF EXISTS ingest.apply_page_life(int,text,timestamptz,text,timestamptz,text,bigint,int,real);
-- DROP FUNCTION IF EXISTS ingest.apply_vote_observation(int,int,int,timestamptz,timestamptz,text,text,bigint,int);
-- DROP FUNCTION IF EXISTS ingest.apply_vote_cas_batch(int,jsonb,timestamptz,text,bigint);
-- DROP FUNCTION IF EXISTS ingest.apply_vote_history(int,jsonb,int,timestamptz,text,bigint,int);
-- DROP FUNCTION IF EXISTS ingest.apply_vote_snapshot(int,jsonb,boolean,int,int,text[],timestamptz,text,bigint,int,text,int,real);
-- DROP FUNCTION IF EXISTS ingest.promote_revoke_candidates(int,int,interval,real,bigint,text);
-- DROP FUNCTION IF EXISTS ingest.apply_revision_batch(int,jsonb,int,timestamptz,text,bigint,int);
-- DROP FUNCTION IF EXISTS ingest.apply_attribution_snapshot(int,jsonb,boolean,timestamptz,text,bigint,int);
-- DROP FUNCTION IF EXISTS ingest.apply_forum_batch(jsonb,jsonb,jsonb,timestamptz,text,bigint);


-- =====================================================================================
-- 10. 自测清单(Phase 1 合入 gate;每条都要有可执行测试,不是 checklist 摆设)
-- =====================================================================================
-- 约定:测试库用独立 database + 每个用例包在事务里 ROLLBACK;固定 now() 用
--       SET LOCAL 或显式传 p_observed,不依赖真实时钟。
--
-- 【落地状态 2026-07-27】本清单的可执行子集分布在两处,合起来 394 条断言全绿:
--   · migrations/smoke_test.sql          296 条 —— 单文件单事务,末尾 ROLLBACK(见 README「冒烟验证结果」)
--   · tests/t7-cursor-safety.test.ts      32 条 —— T7.1 / T7.2 / T7.3 / T7.4 / T7.5【多会话,需两个连接】
--   · tests/t5-vote-batch.test.ts         49 条 —— T5.1 / T5.2(5,575 条大批 + 属性生成器)/ T5.3
--   · tests/t6-role-permission.test.ts 17+6 条 —— T6.6【角色未落地 ⇒ 目录级/行为级条件跳过,
--                                                  另加一层用现存无权角色做的机制排演】
--   为什么后三组不能放冒烟:psql 单文件单事务开不出第二个连接(T7 要的正是"A 未提交时 B 读水位")、
--   没法在测试侧生成随机数据并报告 seed(T5.2 的生成器)、也没法 SET ROLE 切身份(T6.6)。
--   跑法:cd syncer2 && npm run test:gates
--
-- ── T0 前置断言 ──────────────────────────────────────────────────────────────────────
-- T0.1 id 序列高于 v1 上界:setval('ingest.page_id_seq') / ('ingest.user_id_seq') 之后
--      register_page(新 wid) 分配到的 id 不与任何既有 ingest.page.id 冲突。
-- T0.2 所有 SECURITY DEFINER 函数对 PUBLIC 无 EXECUTE:
--      SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--       WHERE n.nspname IN ('ingest','meta') AND p.prosecdef
--         AND has_function_privilege('public', p.oid, 'EXECUTE');   -- 期望 0
-- T0.3 每个函数的 proconfig 都含 search_path:
--      SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--       WHERE n.nspname IN ('ingest','meta') AND p.prosecdef
--         AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig,'{}'))
--                          AS c WHERE c LIKE 'search_path=%');      -- 期望空
--
-- ── T1 CAS 3×3 转移矩阵(apply_vote_observation,§5.2 的规范定义)─────────────────────
--      cur ∈ {无行, 0(撤票态), +1, -1} × 观测 ∈ {0, +1, -1},共 12 组。逐组断言
--      (返回值, vote_event 行数/kind/old/new, vote_current.direction, page_current 四列增量):
--   cur=无行 & obs=0  → NULL,0 事件,无 vote_current 行  ★★★【幻影 revoke 回归用例】
--                        这是 syncer v1 那 54 万条 removed 的原型:守卫写成
--                        `cur IS DISTINCT FROM tgt` 或分别判 NULL 都会在这里造出 revoke。
--                        断言必须同时覆盖「不产生事件」与「不产生 vote_current 行」。
--   cur=无行 & obs=+1 → seq,kind='vote',old=NULL,new=1,   dir=1, Δrating=+1, Δup=+1
--   cur=无行 & obs=-1 → seq,kind='vote',old=NULL,new=-1,  dir=-1,Δrating=-1, Δdown=+1
--   cur=0    & obs=0  → NULL,0 事件(撤票态重复观测幂等)
--   cur=0    & obs=+1 → seq,kind='vote'(curN 为 NULL,不是 revote),Δrating=+1,Δup=+1,Δrevoked=-1
--   cur=0    & obs=-1 → seq,kind='vote',Δrating=-1,Δdown=+1,Δrevoked=-1
--   cur=+1   & obs=0  → seq,kind='revoke',old=1,new=NULL, dir=0, Δrating=-1,Δup=-1,Δrevoked=+1
--   cur=+1   & obs=+1 → NULL,0 事件
--   cur=+1   & obs=-1 → seq,kind='revote',old=1,new=-1,   Δrating=-2,Δup=-1,Δdown=+1
--   cur=-1   & obs=0  → seq,kind='revoke',Δrating=+1,Δdown=-1,Δrevoked=+1
--   cur=-1   & obs=+1 → seq,kind='revote',Δrating=+2,Δdown=-1,Δup=+1
--   cur=-1   & obs=-1 → NULL,0 事件
-- T1.b 【逐字例外 2 回归】cur=无行 & obs=+1 时 page_current.vote_revoked 必须仍是 NOT NULL 且不变。
--      原文 `- (cur = 0)::int` 在这里会算出 NULL 并抛 23502 —— 用例名建议直接叫
--      "new vote must not null out vote_revoked"。
-- T1.c first_voted_at:cur=+1 → obs=-1 → obs=+1 三步后 first_voted_at 仍是第一次的时刻。
-- T1.d 精度改善副作用:cur=+1(last_precision='day') 再来一次 obs=+1 且 precision='observed'
--      ⇒ 返回 NULL、0 事件,但 last_precision 变 'observed'、last_voted_at 前移。
--      反向(observed→day)必须**不变**;'bootstrap' 永远抢不走任何精度(rank=0)。
--
-- ── T2 ±2 归一化 ─────────────────────────────────────────────────────────────────────
-- T2.1 apply_vote_observation(p_direction=2)  → 落 kind='vote' new_direction=1,
--      且 meta.vote_quarantine 多一行 reason='direction_out_of_range' 且 raw 里保留原始 2。
-- T2.2 p_direction=-2 同理 → new_direction=-1。
-- T2.3 cur=+1 时 obs=+2 ⇒ 无转移(归一化后同向),但**仍然**留 quarantine 行
--      (脏值的证据不因为「刚好没转移」而丢失)。
-- T2.4 apply_vote_history / apply_vote_snapshot 的批量入口同样归一化 + 留痕,
--      且不因为 ±2 中断整页事务(§4.8-5:CHECK 是最后防线而非拦截面)。
--
-- ── T3 apply_vote_history(§5.3)──────────────────────────────────────────────────────
-- T3.1 折叠:同一 voter 三条记录 (d1,+1)(d2,-1)(d3,0) ⇒ 只按 d3 折叠出终态 0;
--      若 cur 无行 ⇒ 0 事件(不是 revoke)。若 cur=+1 ⇒ 1 个 revoke 事件。
-- T3.2 属性测试生成器:随机 voter 数 × 每 voter 1~5 条记录 × direction ∈ {-2,-1,0,1,2}
--      × day_ts 随机(含 2022-05 前后与 bootstrap 窗口),断言
--      (a) 事件数 = 发生转移的 voter 数;(b) 重放同一批第二次 ⇒ 0 事件(幂等);
--      (c) Σvote_current.direction = page_current.rating。
-- T3.3 precision 赋值:day_ts=2022-05-25 ⇒ 'bootstrap';2022-04-30 ⇒ 'clamped';
--      2024-01-01 ⇒ 'day';记录自带 precision 时以自带为准。
-- T3.4 完整性护栏:claimed_vote_count 与折叠后非零数不等 ⇒ page_scan.status='partial',
--      且**没有任何 revoke 事件**(绝不因完整性不符推断撤票)。
-- T3.5 absence 不推断:vote_current 有 5 票、p_records 只给 2 票 ⇒ 另外 3 票纹丝不动。
--
-- ── T4 apply_vote_snapshot 四重门控 + A2 候选 ────────────────────────────────────────
-- T4.1 ① is_complete=false ⇒ absence_allowed=false;upsert 仍生效(只增不撤)。
-- T4.2 ② claimed_total=10 而去重后 8 条 ⇒ absence_allowed=false,scan_status='partial'。
-- T4.3 ③ visible_kinds={'wikidot'}:一个 kind='anon' 的 voter 不在 entries 里 ⇒
--      absence_count 不含他(CROM 铸的 anon 票不会被周期性幻影 revoke)。
--      visible_kinds 传空数组 ⇒ 直接抛错(22004)。
-- T4.4 ④【checksum 门控·核心】entries={+1,+1,-1}(Σsign=1)、claimed_rating=1
--      ⇒ checksum_ok=true;claimed_rating=3 ⇒ checksum_ok=false、absence_allowed=false、
--      meta.page_scan.checksum_ok=false、且 meta.revoke_candidate **零新增**。
-- T4.5 ④b claimed_rating 不传 ⇒ checksum_ok IS NULL ⇒ absence_allowed=false
--      (「忘了传 %%rating%%」不能成为静默后门)。
-- T4.6 ⑤ entries=[] 且 claimed_total=42 ⇒ scan_status='failed'、absence_allowed=false、
--      vote_current 完全不变。★★★ 这是 WhoRated 对错误 pageId 返 ok+空的唯一入口。
--      entries=[] 且 claimed_total 不传 ⇒ 同样 failed(gate5 的 COALESCE(...,1))。
-- T4.7 显式 direction=0 条目 ⇒ 走正常 CAS 产 revoke 事件(那是正证据,不是 absence),
--      且该 voter 的 revoke_candidate 行被删除。
-- T4.8 【A2】四门全过 + policy='candidate' ⇒ 缺席者进 meta.revoke_candidate(confirmations=1),
--      vote_event 零新增,vote_current.direction 不变。
-- T4.9 同一 run_id 重复应用同一份快照 ⇒ confirmations 仍是 1(同 run 不累加);
--      换 run_id ⇒ 2。
-- T4.10 候选存在后该 voter 在下一份快照中重新出现 ⇒ 候选行被删除(出现是正证据,
--       无条件采信,不看门控)。
-- T4.11 单页熔断:一次缺席 > max(500, 20% 有效票) ⇒ absence_allowed=false、
--       该页 pending 候选全部转 'held'。
--
-- ── T5 批量 = 逐行等价性(合入 gate)────────────────────────────────────────────────
-- T5.1 同一批目标态,分别用 (a) 循环调 apply_vote_observation、(b) 一次 apply_vote_cas_batch,
--      断言两条路径产生的 {vote_event 集合(忽略 seq 的绝对值,比较 (voter,kind,old,new,
--      precision) 多重集)、vote_current 全表、page_current 四列} 完全相同。
-- T5.2 生成器必须覆盖:direction=±2、同 voter 多记录(cas_batch 应报错而非静默择一)、
--      混合 kind 的 voter(wikidot/anon/guest/synthetic)、空批、单条批、5,575 条大批
--      (实测最大页 scp-cn-2000 的票数)。
-- T5.3 顺序无关性:打乱 p_targets 顺序 ⇒ 结果集合相同(seq 分配顺序按 voter_id 确定化)。
--
-- ── T6 不可变触发器 ──────────────────────────────────────────────────────────────────
-- T6.1 UPDATE / DELETE ingest.vote_event / attribution_event / page_life_event /
--      page_source / content_blob ⇒ 全部抛 25006。
-- T6.2 TRUNCATE 上述表 ⇒ 抛 25006;**TRUNCATE ingest.vote_event_p0000 单个分区** ⇒ 也抛
--      (分区 TRUNCATE 不继承父表语句级触发器,靠第 3.4 节的补挂)。
-- T6.3 revision 白名单:
--      (a) 直接 UPDATE revision SET type=... ⇒ 抛错(GUC 未开);
--      (b) apply_revision_batch 回填 wid ⇒ 成功,且函数返回后
--          current_setting('scpper.revision_backfill', true) 不为 'on'(放行窗口已显式关闭:
--          set_config(is_local:=true) 是事务级,不显式还原就会泄漏给事务的其余语句);
--      (c) 在 GUC 开着的上下文里改 comment / occurred_at ⇒ 抛错(白名单外);
--      (d) 已有非空 type 被改成别的值 ⇒ 抛错,并且 apply_revision_batch 在 fact_quarantine
--          留下 reason='type_conflict_across_sources'。
-- T6.4 SCD2:UPDATE page_attr_history SET value=... ⇒ 抛错;SET valid_to=now() 且原为 NULL
--      ⇒ 成功;对已关闭区间再 SET valid_to ⇒ 抛错;DELETE ⇒ 抛错。
-- T6.5 逃生舱:SET LOCAL scpper.bypass_guard='on' 后上述操作全部放行;
--      同一测试要断言 session_user 不是 migration_role 成员时,**不设 GUC** 一律拒绝。
-- T6.6 权限矩阵:以 bff_role 身份 INSERT ingest.vote_event ⇒ 权限被拒(42501),
--      而不是被触发器拦(触发器只管 UPDATE/DELETE)。
--
-- ── T7 游标安全(乱序提交注入,Phase 1 合入 gate)────────────────────────────────────
-- T7.1 会话 A 开事务 → apply_vote_observation(取到 seq=N)→ **不提交**;
--      会话 B 调 meta.safe_seq_watermark() ⇒ 必须 < N(拿不到屏障锁时返回 NULL,
--      也算通过 —— 关键是**绝不返回 ≥ N**)。A 提交后再取 ⇒ ≥ N。
-- T7.2 三个并发写者交错取 seq / 交错提交,projector 每轮按 projection_window() 消费:
--      断言最终每条 vote_event 都被恰好消费一次(0 漏投影 / 0 重复)。
-- T7.3 advance_projection_cursor 越界钳制:传一个远大于水位的 p_to_seq ⇒ 游标只推到水位。
-- T7.4 拿不到水位时 advance_projection_cursor 抛 55006 而不是静默推进。
-- T7.5 ⚠ 已知边界(必须写成断言,防止有人"优化"掉屏障):
--      直接 SELECT min(seq_floor) FROM meta.ingest_gate 在 A 未提交时看不到 A 的行
--      (MVCC),所以**表机制单独用是无效的**。测试:A 未提交时
--      SELECT count(*) FROM meta.ingest_gate ⇒ 0,而 safe_seq_watermark() 仍然安全。
--
-- ── T8 身份与元数据 ─────────────────────────────────────────────────────────────────
-- T8.1 wikidotId 不一致拒绝应用:register_page(wid=100)→ page_id=P;
--      apply_page_meta(P, ..., p_wikidot_id=101) ⇒ 抛错,且**零写入**(事务回滚后
--      page_attr_history 无新行)。同样覆盖 apply_vote_*/revision/attribution。
-- T8.2 register_page 幂等:同 wid 调两次 ⇒ 同一 page_id、page_life_event 只有一条 created。
-- T8.3 ensure_user:kind='anon' 无 anon_key ⇒ 抛错(投票域禁止名字派生 key,取舍 #14);
--      kind='wikidot' 且 wid<=0 ⇒ 抛错;同 wid 重复调 ⇒ 同 id;
--      username 已有值时传新值 ⇒ **不变**(R12);p_unix_name ⇒ 写 wikidot_unix_name。
-- T8.4 apply_page_meta:tags=['b','a'] 与 tags=['a','b'] ⇒ 第二次零写入(排序去重);
--      hidden_tags=['_x'] 加入 ⇒ 区间切换一次且 page_current.tags 含 '_x'(P0-4)。
-- T8.5 selector 残留:title='%%title%%' ⇒ 抛错 + fact_quarantine 留痕 + 零属性写入(P1-6)。
-- T8.6 slug 变更 ⇒ page_slug_history 关旧开新(psh_current 部分唯一索引不冲突)
--      + page_life_event(kind='renamed') + page_current.slug 更新。
-- T8.7 apply_page_life:重复 deleted ⇒ 第二次返回 NULL 零事件;restored ⇒ status 回 'live'
--      且 deleted_at 清空(v1 那 45 页发散在此不可构造)。
-- T8.8 删除推断门控:source='wikidot' 且 run.status='failed' ⇒ 抛 55000;
--      remote_total 为 NULL ⇒ 抛 55000;覆盖率 0.97 < 0.98 ⇒ 抛 55000;
--      source='crom' ⇒ 无需 run 证据即可落 deleted。
--
-- ── T9 修订 / 归属 / 论坛 ────────────────────────────────────────────────────────────
-- T9.1 待补行回填:先 apply_revision_batch(无 wid, rev_no=7) → 再带 wid 的同 rev_no
--      ⇒ 仍是 1 行、wid 被填上、seq 不变(没有产生第二行)。
-- T9.2 wid 跨页重复:wid 已属别的 page ⇒ 不回填、不插入,fact_quarantine 留
--      reason='wid_bound_to_other_page'(实测 29 例)。
-- T9.3 P0-8:claimed_total=153 而只传 1 条 ⇒ page_scan.status='failed' 且 reason 含 perpage。
-- T9.4 归属:is_complete=false 时缺席者**不产生** removed;=true 才产生。
-- T9.5 is_display:页面只有 SUBMITTER ⇒ is_display 保持 true(实测 41,800 个 pageVersion
--      只有 SUBMITTER,若抑制会让这些页作者集体消失);加入一个 AUTHOR ⇒ SUBMITTER 转 false。
-- T9.6 论坛:未知 category_id 的 thread ⇒ 不入库、进 fact_quarantine;
--      thread.page_id 由 page_current.discussion_thread_id 反解成功;
--      重复 upsert 同 post ⇒ 1 行且 text_plain 不被 NULL 覆盖。
--
-- ── T10 全局一致性不变式(每个用例结束前都跑一遍)───────────────────────────────────
-- I1  page_current.rating       = SUM(vote_current.direction)               per page
-- I2  page_current.vote_up      = COUNT(direction=1)                        per page
-- I3  page_current.vote_down    = COUNT(direction=-1)                       per page
-- I4  page_current.vote_revoked = COUNT(direction=0)                        per page
-- I5  vote_current 从 vote_event 按 seq 全量重放可完全重建(TRUNCATE + replay 后逐列相等)
-- I6  不存在 (page,voter) 在 vote_current 中出现两次(PK 保证,但重放脚本要断言)
-- I7  meta.revoke_candidate 中不存在 vote_current.direction=0 的行(候选与终态不矛盾)
-- I8  page_current.revision_count = COUNT(ingest.revision) per page
-- I9  page_current.attribution_count = COUNT(attribution_current) per page
-- I10 每条 vote_event 的 (kind, old_direction, new_direction) 组合合法(表级 CHECK 之外
--     再断言 revote 的 old<>new、vote 的 old IS NULL、revoke 的 new IS NULL)
-- =====================================================================================
