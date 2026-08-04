-- =====================================================================================
-- 0001_ingest.sql —— SCPper CN 数据模型 V2 · ingest schema(身份层 + 事实层 + 论坛域)
-- =====================================================================================
-- 目标库    : scpper-v2(全新独立库,与 v1 生产库 scpper-cn 物理隔离)
-- 权威依据  : docs/data-model-v2-redesign-2026-07-03.md §4.2(身份层)/ §4.3(事实层)
--             DDL 原文逐字采用,字段名一律不改——下游 apply_* 函数与 serve 投影按此命名。
-- 实测修订  : analysis/wikidot-vs-crom-2026-07-27/{synthesis,findings,field-matrix}.md
--             本文件内所有以「【2026-07-27 实测】」开头的注释来自该批实测结论,
--             其中只有两处改变了 DDL 本身(见下「与文档的差异」),其余仅为写侧语义提示。
--
-- 与文档的差异(仅此两处,均为任务显式要求):
--   D1. vote_event.time_precision 的 CHECK 词表增加 'bootstrap'
--       (CROM 冷启动快照票 2022-05-14~26,166 万行 / 全表 26.3%,不参与逐日投影)
--   D2. vote_event.source 的取值注释更新为 v2 现实词表(列类型仍是自由文本 text,不加 CHECK,
--       与文档一致——源枚举随并行期演化,用 CHECK 会把每次新源变成一次 migration)
--
-- 本文件不包含(按交付切分,避免单文件既建表又建逻辑):
--   * 不可变触发器(BEFORE UPDATE OR DELETE ... RAISE EXCEPTION)与 revision 列白名单 → 见 0006_functions.sql
--   * 10 个 apply_* 转移函数                                                        → 见 0006_functions.sql
--   * serve / meta / app 三个 schema                                               → 见 0002 / 0003 / 0004
--   * pgroonga 索引(扩展可能不可用,不能让整个迁移失败)                             → 见 0005_indexes_pgroonga.sql
--   * CREATE ROLE / GRANT(当前连接用户 user_dxzbdi 有 CREATEDB 但无 CREATEROLE、非
--     superuser,角色与授权必须由 DBA 单独执行)                                     → 见 9000_roles_grants.sql.ADMIN
--
-- ⚠ ingest 事实表在 0006 落地前是可 UPDATE/DELETE 的(不可变触发器在那里挂)。
--   试跑期间不要只跑 0001 就往里灌真实数据 —— 用 apply.sh 一次跑完全部迁移。
--
-- 可重复执行:全部 CREATE ... IF NOT EXISTS。
--   ⚠ 语义边界:IF NOT EXISTS 只保证「重跑不报错」,不保证「重跑后结构等于本文件」。
--     表已存在时列/CHECK 的变更不会被追加。改结构一律新开 migration(0006+ 的 ALTER),
--     不要就地编辑本文件后重跑——试跑阶段若要重置,请 DROP SCHEMA ingest CASCADE 后整跑。
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 安全闸:本文件永远不允许落到 v1 生产库
-- -------------------------------------------------------------------------------------
DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn') THEN
    RAISE EXCEPTION
      'refusing to apply v2 ingest DDL to the v1 production database %(read-only by policy)',
      current_database();
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS ingest;
COMMENT ON SCHEMA ingest IS
  'V2 摄入域:身份注册表 + append-only 不可变事实流 + 论坛当前态。'
  '写入面仅 apply_* 函数族(SECURITY DEFINER),任何角色对本 schema 的表无直接 DML;'
  'migration_role 是唯一可绕过不可变触发器的角色,仅在迁移窗口启用。';


-- =====================================================================================
-- 0. 全局摄入序
-- =====================================================================================
-- 所有事实表共享同一条时间轴 → 投影游标只需消费单一单调序,跨域事件天然可全序归并。
-- 注意:seq 是「分配序」不是「提交序」。多写者(sync CLI concurrency=4、直连 sweep)下
-- 必须配合 meta.ingest_gate 的安全水位,详见设计 §5.5;本文件不建 meta,不在此重复。
CREATE SEQUENCE IF NOT EXISTS ingest.fact_seq;
COMMENT ON SEQUENCE ingest.fact_seq IS
  '全局摄入序:vote_event / revision / attribution_event / page_life_event 共享。'
  '既是 vote_event 的 RANGE 分区键,也是 serve Tier-2 投影游标的推进单位。'
  '不可重置、不可回绕——回绕会让 append-only 的因果序失效。';


-- =====================================================================================
-- 1. 身份层(设计 §4.2)
-- =====================================================================================
-- 决策:一个 page.id = 一段 wikidotId 生命周期。删除后以新 wikidotId 重建 = 新 page 行;
-- 「同一部作品」显式记入 page_lineage,规则只产生候选、人工裁决、留痕可撤销,
-- 事实永不跨身份合并。slug / fullname 是可变属性,不是身份。
-- -------------------------------------------------------------------------------------

-- 生命周期:身份注册表,行一经创建永不删除、id 永不重排/复用
CREATE TABLE IF NOT EXISTS ingest.page (
  id         int PRIMARY KEY,      -- 原样保留 V1 Page.id(gacha 等跨库软引用的硬承诺,迁移脚本内置断言)
  wikidot_id int NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE ingest.page IS
  '生命周期:身份注册表。行一经创建永不删除、id 永不重排/复用(user-backend 的 '
  'GachaCardDefinition.pageId 等跨库软外键依赖此不变量,迁移脚本内置断言)。'
  '页面「消失」由 page_life_event(kind=deleted)表达,不是删行;'
  '删除后同 URL 重建 = 新 wikidot_id = 新 page 行 + page_lineage 候选。';
COMMENT ON COLUMN ingest.page.id IS '原样保留 V1 Page.id 值域;v2 新页由 v1 序列上界之后继续分配。';
COMMENT ON COLUMN ingest.page.wikidot_id IS
  '外部观测身份,UNIQUE。所有定向抓取查询必须携带并返回 wikidotId,apply_* 入口校验一致性,'
  '不一致即拒绝应用并触发身份注册流程(设计 §5.1 协议硬性条款)。';
COMMENT ON COLUMN ingest.page.created_at IS '本地身份注册时刻(≠ 页面在站上的创建时刻,后者见 page_life_event)。';

-- 生命周期:人工裁决留痕,可撤销(删行),append 为主
CREATE TABLE IF NOT EXISTS ingest.page_lineage (
  successor_id   int PRIMARY KEY REFERENCES ingest.page(id),
  predecessor_id int NOT NULL REFERENCES ingest.page(id),
  kind text NOT NULL DEFAULT 'recreate',
  confidence real,
  decided_by text NOT NULL,        -- 'operator:xxx' | 'rule:same-slug-30d'(规则仅产生候选)
  decided_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE ingest.page_lineage IS
  '生命周期:人工裁决留痕,是全 ingest schema 唯一允许 DELETE 的表(撤销误判)。'
  '它只影响展示层的「同一部作品」串联,绝不参与任何事实合并或统计折叠。'
  '【2026-07-27 实测】3,334 个 slug 被 10,062 个 Page 行接力占用(最深 21 层),'
  '所以 rule:same-slug-* 只能产候选,不能自动落库(P0-7 归属串号)。';
COMMENT ON COLUMN ingest.page_lineage.decided_by IS
  '''operator:<name>'' = 人工裁决(唯一可信来源);''rule:<id>'' = 规则候选,须经人工确认后改写为 operator。';

-- 生命周期:SCD2(关旧行开新行),不 UPDATE 历史行
CREATE TABLE IF NOT EXISTS ingest.page_slug_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  page_id int NOT NULL REFERENCES ingest.page(id),
  slug text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS psh_current ON ingest.page_slug_history(page_id) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS psh_slug ON ingest.page_slug_history(slug text_pattern_ops);
COMMENT ON TABLE ingest.page_slug_history IS
  '生命周期:SCD2。改名 = 关旧行(写 valid_to)+ 开新行,历史行不 UPDATE 其它列。'
  'psh_current 部分唯一索引是「每页至多一个当前 slug」的物理保证。'
  '用途:by-slug 解析(含历史 slug 回溯)与直连 fullname → page_id 的双通道解析之一。';
COMMENT ON COLUMN ingest.page_slug_history.slug IS
  'wikidot fullname(含 category 前缀,如 ''deleted:scp-cn-xxx'')。text_pattern_ops 索引供前缀匹配。';

-- 生命周期:身份注册表,永不删除;可变列仅 display_name/username(观测更新)
CREATE TABLE IF NOT EXISTS ingest."user" (
  id int PRIMARY KEY,              -- 原样保留 V1 User.id
  kind text NOT NULL CHECK (kind IN ('wikidot','guest','anon','synthetic')),
  wikidot_id int UNIQUE,
  anon_key text UNIQUE,            -- anon: 上游原始 anonKey 原样保留;guest: 'guest:'||name(同名合并,见取舍#14)
  username text,                   -- wikidot unix name(dr_bright),用户搜索三路匹配依赖
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'wikidot' OR wikidot_id IS NOT NULL),
  CHECK (kind IN ('wikidot','synthetic') OR wikidot_id IS NULL OR kind='guest'),
  CHECK (kind NOT IN ('anon','guest') OR anon_key IS NOT NULL OR kind='guest')
);
-- pgroonga 索引 u_display_pgroonga / u_username_pgroonga 见 0005_indexes_pgroonga.sql
COMMENT ON TABLE ingest."user" IS
  '生命周期:身份注册表,永不删除。收编 V1 四形态:同步用户(wikidot)/ 论坛 guest / '
  'BFF 收藏夹合成行(synthetic)/ 匿名署名(anon)。'
  '事实表 actor 一律 NOT NULL——匿名是真实 user 行而非 NULL,NULLS DISTINCT 放行重复这一整类漏洞消失。'
  '铸造统一走 ingest.ensure_user(),不再裸 INSERT。'
  'first/last activity 等分析回写列不在本表,迁入 serve.user_stats。';
COMMENT ON COLUMN ingest."user".username IS
  'wikidot unix name。用户搜索三路匹配(display_name / username / 下划线变体)依赖此列。'
  '【2026-07-27 实测·P1-2】v1 存量的 35,722 非空值中 32,808(91.8%)是 UserDataCompletenessJob '
  '用 lower(replace(display_name,'' '',''_'')) 捏造的伪 slug,下游账号绑定正依赖该格式;'
  '直连拿到的真实 unixName 不得覆盖本列(修订 R12:后续 ALTER 新增 wikidot_unix_name 列另存,'
  'BFF 绑定匹配扩为四路后再切主)。本次不建该列,留待 0006。';
COMMENT ON COLUMN ingest."user".anon_key IS
  'anon:上游原始 anonKey 原样保留;guest:''guest:''||name(同名合并,设计取舍 #14)。UNIQUE。';


-- =====================================================================================
-- 2. 内容寻址(设计 §4.3;提前建表以满足 revision.source_sha 的外键依赖)
-- =====================================================================================
-- 说明:文档中 content_blob 排在 revision 之后,但 revision.source_sha REFERENCES 它,
-- 单次顺序执行必须先建 content_blob。仅调整语句顺序,DDL 文本未改。

-- 生命周期:内容寻址 append-only(终结 PageVersion×SourceVersion 5.3GB 双头 TOAST)
CREATE TABLE IF NOT EXISTS ingest.content_blob (
  sha256 bytea PRIMARY KEY,
  source text,
  text_content text,                     -- 渲染文本(= V1 textContent 语义)
  byte_len int NOT NULL,
  text_len int NOT NULL DEFAULT 0,       -- 渲染文本长度(quotes 长度过滤用)
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE ingest.content_blob IS
  '生命周期:内容寻址 append-only。同字节只存一份(v1 版本间 15.9% 字节级重复直接消失)。'
  '永不 UPDATE:内容变了就是另一个 sha256。'
  '【2026-07-27 实测·P1-5】逐版本源码全量回填 = 347,686 revision × 均值 88.6KB ≈ 30.8GB'
  '(冷启动总量的 7 倍,且 18.5% 属已删页远端永不可得)。修订 R14:PageDiff HTML 已证明'
  '不可逆，改为仅对存活页的源码修订逐 revision_id 抓 PageSource 全文；sha256 去重后'
  '实际占用低于原始估算。不要假设已删页或非源码修订一定有 blob。';
COMMENT ON COLUMN ingest.content_blob.source IS 'wikidot 源码(wikitext)原文。';
COMMENT ON COLUMN ingest.content_blob.text_content IS '渲染后纯文本,= V1 PageVersion.textContent 语义;embedding 与 quotes 的输入。';


-- =====================================================================================
-- 3. 事实层(设计 §4.3)—— append-only
-- =====================================================================================
-- 所有事实表挂 BEFORE UPDATE OR DELETE ... RAISE EXCEPTION 不可变触发器
-- (migration_role 除外;revision 的 wid/type/source_sha 回填走受控 UPDATE 列白名单)。
-- 触发器本体见 0003_functions_triggers.sql —— 本文件只建结构。
-- 修正只能以补偿事件表达,不得就地改写历史。
-- -------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 3.1 vote_event —— append-only 事件流,PARTITION BY RANGE(seq)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest.vote_event (
  seq bigint PRIMARY KEY DEFAULT nextval('ingest.fact_seq'),
  page_id  int NOT NULL REFERENCES ingest.page(id),
  voter_id int NOT NULL REFERENCES ingest."user"(id),
  kind text NOT NULL CHECK (kind IN ('vote','revote','revoke')),
  old_direction smallint CHECK (old_direction IN (-1,1)),
  new_direction smallint CHECK (new_direction IN (-1,1)),
  occurred_at timestamptz,               -- 业务时间(可空;crom 为 day-floored 检测日)
  observed_at timestamptz NOT NULL,      -- 观测时间,必填
  -- 【D1 · 2026-07-27 实测新增 'bootstrap'】词表在文档 §4.3 基础上扩展:
  --   exact     秒级可信(legacy_votes_cn.votes 的 timestamptz;直连 WhoRated 未来若给秒级同此)
  --   observed  只知道「我这一刻看到它是这样」(直连快照协议,occurred_at = observed_at)
  --   day       只精确到日(CROM fuzzy 的检测日,按 CST 日零点)
  --   clamped   day 且落在 2022-05-01 clamp 边界之前,连「哪一天」都是被夹逼出来的
  --   bootstrap CROM 冷启动快照票:2022-05-14~26 之间、全部被写成 2022-05-25 的 1,668,520 行
  --             (全表 26.3%)。它们的时间戳不代表任何真实投票时刻,只代表「CROM 第一次
  --             看见这个站」。必须排除出所有逐日投影(vote_daily / page_daily_stats /
  --             site_overview_daily / heatmap / most_votes_single_day / vote_milestone_*),
  --             否则 heatmap 上会长出一根 166 万高的假柱子。总量统计仍应计入。
  time_precision text NOT NULL CHECK (time_precision IN ('exact','observed','day','clamped','bootstrap')),
  -- 【D2】source 取值(v2 现实,自由文本不加 CHECK):
  --   'wikidot'                常驻直连源(= 文档旧称 'sentinel';syncer2 抓取层)
  --   'legacy'                 legacy_votes_cn.votes 重放(秒级 timestamptz,precision='exact')
  --   'v1_backfill'            v1 Vote 表状态机折叠重放(precision='day'/'clamped'/'bootstrap')
  --   'legacy_import_2025_11'  2025-11 那一次一次性导入批次的留痕(与 'legacy' 分开,便于按批回滚追责)
  --   'crom'                   CROM(并行期免费金丝雀 / 回填;仍是显式 direction=0 撤票的唯一来源)
  --   'reconcile'              人工签发的补偿观测(设计 §5.7,须操作者签名,绝不由自动流程写入)
  source text NOT NULL,
  run_id bigint,
  CHECK ((kind='revoke') = (new_direction IS NULL)),
  CHECK ((kind='vote')   = (old_direction IS NULL))
) PARTITION BY RANGE (seq);
CREATE INDEX IF NOT EXISTS ve_page  ON ingest.vote_event(page_id, seq);
CREATE INDEX IF NOT EXISTS ve_voter ON ingest.vote_event(voter_id, seq);
-- direction=±2 在 apply 函数入口 sign() 归一化,原始值进 meta.vote_quarantine 留痕;
-- CHECK 是最后防线而非拦截面,不会卡死整页事务(见 5.2)

COMMENT ON TABLE ingest.vote_event IS
  '生命周期:append-only 事件流,PARTITION BY RANGE(seq)。永不 UPDATE / DELETE / TRUNCATE;'
  '错了只能追加 source=''reconcile'' 的补偿事件。serve.vote_current 可从本表全量重放重建。'
  '每 (page,voter) 的当前态由 serve.vote_current 的主键物理保证唯一,本表只记转移。'
  '⚠ seq 一旦分配即固化——任何清洗(如 8 小时重复票 R0 清洗)必须在分配 seq 之前完成。';
COMMENT ON COLUMN ingest.vote_event.kind IS
  'vote = 无票→有票;revote = 改票(±1 互转);revoke = 有票→撤票(new_direction IS NULL)。'
  '【修订 R2】revoke 只允许由 source=''crom'' 的显式 direction=0 记录产生;'
  '直连 absence(不在 WhoRated 名单里)只能写 meta.revoke_candidate 待确认,不得直接落 revoke。';
COMMENT ON COLUMN ingest.vote_event.occurred_at IS
  '业务时间,可空。precision 决定它可信到什么粒度,读侧必须成对读 (occurred_at, time_precision)。';
COMMENT ON COLUMN ingest.vote_event.observed_at IS '观测时间,必填。任何「我们什么时候知道的」类分析用此列。';
COMMENT ON COLUMN ingest.vote_event.time_precision IS
  'exact | observed | day | clamped | bootstrap。'
  'bootstrap = CROM 冷启动快照票(2022-05-14~26,166 万行 / 全表 26.3%),不参与任何逐日投影。';
COMMENT ON COLUMN ingest.vote_event.source IS
  'wikidot(常驻源)| legacy | v1_backfill | legacy_import_2025_11 | crom(并行期金丝雀/回填)| reconcile。'
  '刻意不加 CHECK:并行期会增源,枚举收紧应发生在 meta.v2_baseline 的逐字段权威表(修订 R1)而非列约束。';
COMMENT ON COLUMN ingest.vote_event.run_id IS '产生该事件的 meta.ingest_run.id;整批回滚/追责的锚点。';

-- ---- vote_event 分区:命名与滚动策略 -------------------------------------------------
--
-- 分区键 = seq(不是时间)。理由:seq 是全局摄入序,写入永远落在最高分区,天然避免
-- 时间分区在冷回填时的「历史分区随机写」问题;同一分区内 occurred_at 可以跨十年。
--
-- 命名约定: ingest.vote_event_p<四位分区号>,分区号 = 下界 / STEP
--   STEP = 20,000,000(两千万 seq / 分区)
--   p0000 = [MINVALUE, 20000000)   p0001 = [20000000, 40000000)   p0002 = [40000000, 60000000)
--   兜底   ingest.vote_event_pdefault(DEFAULT 分区)
--
-- 容量估算(设计 §9.12 + 实测):冷回填后 vote_event ≈ 170 万行;但 fact_seq 由
-- vote_event / revision / attribution_event / page_life_event 共享,冷回填整体预计消耗
-- < 1,000 万 seq。故 p0000 一个分区即可容纳「全部历史 + 相当长一段上线后运行期」。
-- 当前站点票速约 30 万票/年,叠加其它事实域,STEP=20,000,000 大致对应 5~10 年/分区,
-- 分区数量长期个位数——这是刻意的:分区在这里是为了「可 DETACH 归档」和「避免单表无限膨胀」,
-- 不是为了查询剪枝(查询剪枝靠 ve_page / ve_voter,谓词是 page_id / voter_id 不是 seq)。
--
-- 滚动策略(上线即定,写进运维 checklist / meta 定时任务):
--   1) 监控 SELECT last_value FROM ingest.fact_seq;
--      当 last_value > 当前最高分区上界 - 5,000,000 时,创建下一分区(提前量约数月)。
--   2) 创建语句即本文件下方模板,分区号与边界按 STEP 递推;创建是 O(1),不锁写。
--   3) pdefault 必须恒为空。它只是「滚动脚本失职」的安全网:一旦有行落入,
--      监控须立即告警(SELECT count(*) FROM ONLY ingest.vote_event_pdefault),
--      因为此后创建新分区会被 DEFAULT 分区的重叠校验扫描阻塞(需 ACCESS EXCLUSIVE 全扫)。
--      清空方式:migration_role 下把行搬进正确分区(这是唯一被允许的「移动事实」操作,须留痕)。
--   4) 归档:整分区 DETACH CONCURRENTLY + pg_dump 到冷存 + DROP。
--      ⚠ 因为分区键是 seq 不是时间,归档切点必须先用 meta.ingest_run 的
--        (run 起止时刻, seq 水位) 对照表把「时间切点」翻译成「seq 切点」,不能拍脑袋。
--      ⚠ 归档前必须确认 serve.vote_current 与全部 Tier-2 投影已越过该分区
--        (min(meta.projection_cursor.cursor_seq) > 分区上界),否则重建能力丢失。
--   5) vote_event 只增不减:归档 = 移出热库,不等于可以丢。冷存副本是 vote_current 的
--      唯一重建来源,备份链路(pgBackRest/wal-g)必须覆盖冷存。
--
CREATE TABLE IF NOT EXISTS ingest.vote_event_p0000
  PARTITION OF ingest.vote_event FOR VALUES FROM (MINVALUE) TO (20000000);
CREATE TABLE IF NOT EXISTS ingest.vote_event_p0001
  PARTITION OF ingest.vote_event FOR VALUES FROM (20000000) TO (40000000);
CREATE TABLE IF NOT EXISTS ingest.vote_event_p0002
  PARTITION OF ingest.vote_event FOR VALUES FROM (40000000) TO (60000000);
CREATE TABLE IF NOT EXISTS ingest.vote_event_pdefault
  PARTITION OF ingest.vote_event DEFAULT;

COMMENT ON TABLE ingest.vote_event_p0000 IS
  '分区 [MINVALUE, 20000000):冷回填分区。Phase 2 的 legacy / v1_backfill / '
  'legacy_import_2025_11 全量重放落在此处,上线后的常规写入初期也在此处。';
COMMENT ON TABLE ingest.vote_event_p0001 IS '分区 [20000000, 40000000):预建滚动分区。';
COMMENT ON TABLE ingest.vote_event_p0002 IS '分区 [40000000, 60000000):预建滚动分区。';
COMMENT ON TABLE ingest.vote_event_pdefault IS
  'DEFAULT 兜底分区,必须恒为空。非空 = 滚动分区脚本失职,立即告警;'
  '且此后新建分区会触发对本分区的全扫重叠校验(ACCESS EXCLUSIVE),影响写入可用性。';

-- ---------------------------------------------------------------------------
-- 3.2 revision
-- ---------------------------------------------------------------------------
-- 生命周期:append-only;例外:wikidot_revision_id/type/source_sha 三列允许由 apply_revision_batch
-- 后补(NULL→值,单向),触发器按列白名单放行
CREATE TABLE IF NOT EXISTS ingest.revision (
  seq bigint PRIMARY KEY DEFAULT nextval('ingest.fact_seq'),
  page_id int NOT NULL REFERENCES ingest.page(id),
  wikidot_revision_id bigint UNIQUE,     -- 主自然键(crom/回填必有);sentinel 直抓可空待补
  rev_no int,                            -- wikidot index;上游文档明示可重复,仅作展示/对齐,不是主键
  type text,
  author_id int REFERENCES ingest."user"(id),
  occurred_at timestamptz NOT NULL,
  comment text,
  source_sha bytea REFERENCES ingest.content_blob(sha256),
  observed_at timestamptz NOT NULL,
  source text NOT NULL,
  CHECK (wikidot_revision_id IS NOT NULL OR rev_no IS NOT NULL)
);
-- sentinel 行(无 wid)在同页同 rev_no 上只允许一条待补行;
-- crom 行按 wid 全局唯一;上游 index 竞态重复不构成合并,冲突行进 quarantine
CREATE UNIQUE INDEX IF NOT EXISTS rev_pending ON ingest.revision(page_id, rev_no) WHERE wikidot_revision_id IS NULL;
CREATE INDEX IF NOT EXISTS rev_page   ON ingest.revision(page_id, occurred_at DESC, seq DESC);
CREATE INDEX IF NOT EXISTS rev_author ON ingest.revision(author_id, occurred_at);

COMMENT ON TABLE ingest.revision IS
  '生命周期:append-only,唯一例外是 wikidot_revision_id / type / source_sha 三列的单向后补'
  '(NULL→值),由 apply_revision_batch 执行、不可变触发器按列白名单放行。'
  '直连(source=''wikidot'')先落无 wid 的待补行,CROM 行后到时按 (page_id, rev_no) 认领并回填 wid。'
  '【2026-07-27 实测·P0-8】PageRevisionListModule 确实分页:不传 perpage 只返回 1 行。'
  '抓取层必须显式传 perpage 并做总数校验,否则时间轴静默截断成 1 条。'
  '【2026-07-27 实测·P2-5】同一 revision 在 CROM / 直连两条链路被打成不同 type 且时间差恰好 8 小时,'
  '是 FLAG_TYPE_MAP 中文失配已污染生产的数据实锤 —— type 列的跨源冲突必须进 quarantine,不得静默择一。';
COMMENT ON COLUMN ingest.revision.wikidot_revision_id IS
  '主自然键,全局 UNIQUE。可空 = 直连待补行。'
  '【2026-07-27 实测】v1 存量中 29 个 wid 跨页重复,回填时按 (wid) 唯一会冲突,冲突行进 meta 的 quarantine。';
COMMENT ON COLUMN ingest.revision.rev_no IS
  'wikidot revision index。上游明示可重复(竞态),仅作展示/对齐,不是主键;'
  '(page_id, rev_no) 的唯一性只在「待补行」这一子集上成立(见 rev_pending 部分唯一索引)。';
COMMENT ON COLUMN ingest.revision.source_sha IS 'content_blob 外键;按需抓取策略下长期大面积为 NULL(见 content_blob 注释)。';

-- ---------------------------------------------------------------------------
-- 3.3 attribution_event
-- ---------------------------------------------------------------------------
-- 生命周期:append-only 事件流(归属变更一等公民,UserFollowActivityJob 的新驱动源)
CREATE TABLE IF NOT EXISTS ingest.attribution_event (
  seq bigint PRIMARY KEY DEFAULT nextval('ingest.fact_seq'),
  page_id int NOT NULL REFERENCES ingest.page(id),
  actor_id int NOT NULL REFERENCES ingest."user"(id),
  role text NOT NULL,
  action text NOT NULL CHECK (action IN ('added','removed','updated')),
  at_date date,
  observed_at timestamptz NOT NULL,
  source text NOT NULL
);
CREATE INDEX IF NOT EXISTS ae_page ON ingest.attribution_event(page_id, seq);

COMMENT ON TABLE ingest.attribution_event IS
  '生命周期:append-only 事件流。归属变更升为一等公民,不再寄生于版本轮转;'
  'serve.attribution_current 由本表折叠而来,UserFollowActivityJob 改由本表驱动。'
  '【2026-07-27 实测·P0-7 / 修订 R11】存量 attribution 不重解析:直接用 v1 的 '
  'pageVerId → PageVersion.pageId 映射结转,绕开 by-slug 裁决'
  '(3,334 个 slug 被 10,062 个 Page 行接力占用,by-slug 会把已删旧作的署名挂到同名新作上)。'
  '仅新解析行走 by-slug,且目标 slug 有 ≥2 个 Page 行时要求 at_date 落在候选页生命周期内,多候选即拒绝。';
COMMENT ON COLUMN ingest.attribution_event.role IS
  'AUTHOR / SUBMITTER / TRANSLATOR / ... 原样保留上游取值。'
  '【2026-07-27 实测·P1-4】70% 的 attribution 是 SUBMITTER,41,800 个 pageVersion 只有 SUBMITTER;'
  '已注销创建者在 ListPages 上退化为裸文本 ''(user deleted)''(created_by_id / created_by_unix 双空),'
  '若不特判会全部塌缩到同一个合成 actor。';
COMMENT ON COLUMN ingest.attribution_event.at_date IS '上游给的归属日期(date 粒度,可空);不是观测时间。';

-- ---------------------------------------------------------------------------
-- 3.4 page_life_event
-- ---------------------------------------------------------------------------
-- 生命周期:append-only 事件流(页面生死单一真相源,终结双 isDeleted 发散)
CREATE TABLE IF NOT EXISTS ingest.page_life_event (
  seq bigint PRIMARY KEY DEFAULT nextval('ingest.fact_seq'),
  page_id int NOT NULL REFERENCES ingest.page(id),
  kind text NOT NULL CHECK (kind IN ('created','deleted','restored','renamed')),
  occurred_at timestamptz,
  occurred_precision text NOT NULL CHECK (occurred_precision IN ('exact','inferred')),
  observed_at timestamptz NOT NULL,
  source text NOT NULL
);
CREATE INDEX IF NOT EXISTS ple_page ON ingest.page_life_event(page_id, seq);
-- 4,762 个遗留删除页的删除时刻回填 GREATEST(末票,末修订) 并标 'inferred',不再假装精确

COMMENT ON TABLE ingest.page_life_event IS
  '生命周期:append-only 事件流,页面生死的单一真相源(终结 v1 Page.isDeleted 与 '
  'PageVersion.isDeleted 双头发散的 45 页 bug)。serve.page_current.status 由本表翻转。'
  '删除推断协议(设计 §5.5 + 修订 R9):仅当 ingest_run.status=''ok'' 且 '
  'pages_enumerated/remote_total ≥ 0.98 时允许推断;单页需连续 ≥2 个完整 run 未见才落 deleted。'
  '【2026-07-27 实测·P0-6】37.9% 的最终被删页活不过 24 小时、83.2% 活不过 7 天 —— '
  '7~14 天 sweep 对 83% 的删除页 100% 失效,新页必须走高频队列(修订 R7)。';
COMMENT ON COLUMN ingest.page_life_event.occurred_precision IS
  'exact | inferred。4,762 个遗留删除页的删除时刻取 GREATEST(末票, 末修订) 并标 inferred —— '
  '这是永远无法修复的推断值,读侧不得当精确时刻使用。';
COMMENT ON COLUMN ingest.page_life_event.kind IS
  'created / deleted / restored / renamed。renamed 与 page_slug_history 的区间切换成对出现。';

-- ---------------------------------------------------------------------------
-- 3.5 page_attr_history
-- ---------------------------------------------------------------------------
-- 生命周期:SCD2(变了才关旧开新);rating 不是属性,它是 vote_event 的派生
CREATE TABLE IF NOT EXISTS ingest.page_attr_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  page_id int NOT NULL REFERENCES ingest.page(id),
  attr text NOT NULL CHECK (attr IN ('title','alternate_title','tags','category','parent')),
  value jsonb NOT NULL,                  -- tags 存排序后数组:顺序敏感伪变更绝迹
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  source text NOT NULL                   -- 'v1_version'(残影历史) | 'observed'
);
CREATE UNIQUE INDEX IF NOT EXISTS pah_current  ON ingest.page_attr_history(page_id, attr) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS pah_timeline ON ingest.page_attr_history(page_id, attr, valid_from);

COMMENT ON TABLE ingest.page_attr_history IS
  '生命周期:SCD2 —— 值真的变了才关旧区间开新区间,同值重复观测零写入。'
  '这是 v1 PageVersion 的降级形态:「版本」概念消亡,只剩逐属性的属性历史。'
  'rating / vote_count 不是属性,它们是 vote_event 的派生,永远不写进本表。'
  '2025-08 式的全站重同步在 V2 只产生属性区间切换或零写入,不产生任何「新版本」。';
COMMENT ON COLUMN ingest.page_attr_history.value IS
  'jsonb。tags 存排序后数组 → 顺序敏感的伪变更绝迹。'
  '【2026-07-27 实测·P0-4】tags 必须同时取 %%tags%% 与 %%_tags%%(隐藏标签):'
  'ListPages 的 %%tags%% 不含 ''_'' 前缀隐藏标签,而 CROM/主库确实含(2,167 个当前版本),'
  '只取 %%tags%% 会抹掉标签并触发 2,167 次无谓区间切换。';
COMMENT ON COLUMN ingest.page_attr_history.source IS '''v1_version''(v1 版本残影历史回填)| ''observed''(直连/CROM 实时观测)。';

-- ---------------------------------------------------------------------------
-- 3.6 page_source
-- ---------------------------------------------------------------------------
-- 生命周期:append-only(同页同 rev_no 幂等)
CREATE TABLE IF NOT EXISTS ingest.page_source (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  page_id int NOT NULL REFERENCES ingest.page(id),
  rev_no int,                            -- 可空:回填/直抓拿不到修订号时
  blob_sha bytea NOT NULL REFERENCES ingest.content_blob(sha256),
  observed_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ps_rev ON ingest.page_source(page_id, rev_no) WHERE rev_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS ps_page ON ingest.page_source(page_id, observed_at DESC);

COMMENT ON TABLE ingest.page_source IS
  '生命周期:append-only,(page_id, rev_no) 幂等(rev_no 非空时部分唯一)。'
  '页面源码在某个修订上的指认:内容本体在 content_blob,本表只是「谁在哪一版用了哪个 blob」。'
  'rev_no 可空 —— 回填/直抓拿不到修订号时仍可留一条按 observed_at 排序的时间序快照。';


-- =====================================================================================
-- 4. 论坛域(设计 §4.3)—— 当前态 + 软删,apply_forum_batch 独占写
-- =====================================================================================
-- 与事实层不同:论坛三表是「上游原生 id 为主键的当前态表」,不挂不可变触发器,
-- 允许 UPDATE(幂等 upsert)、不允许物理 DELETE(用 is_deleted 软删)。
-- 论坛全域是直连独占权威(CROM 零覆盖),且论坛读取全部免登录(修订 D6)。
-- -------------------------------------------------------------------------------------

-- 生命周期:上游原生 id 为主键的当前态表(软删,不轮转版本),apply_forum_batch 独占写
CREATE TABLE IF NOT EXISTS ingest.forum_category (
  id bigint PRIMARY KEY,                 -- wikidot 原始 category id
  title text, description text,
  thread_count int NOT NULL DEFAULT 0,
  post_count int NOT NULL DEFAULT 0,
  last_synced_at timestamptz NOT NULL
);
COMMENT ON TABLE ingest.forum_category IS
  '生命周期:当前态表(非事实流)。主键 = wikidot 原始 category id,apply_forum_batch 幂等 upsert;'
  '不物理删除。thread_count / post_count 是上游自报值,不是本地折叠值 —— 与本地 count(*) 的差异'
  '是采集完整度信号,不要用它反写本地统计。';

CREATE TABLE IF NOT EXISTS ingest.forum_thread (
  id bigint PRIMARY KEY,                 -- wikidot 原始 thread id
  category_id bigint NOT NULL REFERENCES ingest.forum_category(id),
  page_id int REFERENCES ingest.page(id),
  page_id_source text,
  title text NOT NULL,
  created_by_user_id int REFERENCES ingest."user"(id),
  created_by_name text,                  -- wid<=0 无法归一时保留快照(出界项:存量不清洗)
  created_at timestamptz NOT NULL,
  post_count int NOT NULL DEFAULT 0,
  is_deleted boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz NOT NULL
);
-- Foundation migrations are intentionally rerunnable on an already-created rehearsal DB.
-- CREATE TABLE IF NOT EXISTS does not add newly introduced columns, so upgrade explicitly.
ALTER TABLE ingest.forum_thread
  ADD COLUMN IF NOT EXISTS page_id_source text;
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'ingest.forum_thread'::regclass
       AND conname = 'forum_thread_page_id_source_ck'
  ) THEN
    ALTER TABLE ingest.forum_thread
      ADD CONSTRAINT forum_thread_page_id_source_ck
      CHECK (page_id_source IN ('inferred','verified'));
  END IF;
END
$do$;
CREATE INDEX IF NOT EXISTS ft_page ON ingest.forum_thread(page_id);
COMMENT ON TABLE ingest.forum_thread IS
  '生命周期:当前态表 + 软删(is_deleted)。主键 = wikidot 原始 thread id。'
  'page_id_source=''inferred'' 只用于结转 v1 的 title-as-slug 历史猜测；'
  'ForumCommentsListModule 反解的真值标为 verified，并覆盖 inferred。';
COMMENT ON COLUMN ingest.forum_thread.created_by_name IS
  'wikidot_id ≤ 0(已注销/匿名)无法经 ensure_user 归一时保留的姓名快照。存量不清洗(设计出界项)。';
COMMENT ON COLUMN ingest.forum_thread.page_id IS
  '可空:讨论区里大量 thread 不挂任何页面(闲聊/站务)。'
  '非空时来自 v1 结转的 inferred 关联，或 ForumCommentsListModule 反解的 verified 真值。';
COMMENT ON COLUMN ingest.forum_thread.page_id_source IS
  'inferred=v1 title-as-slug 猜测结转；verified=ForumCommentsListModule 直连真值。'
  'verified 不得被 inferred 覆盖。';

CREATE TABLE IF NOT EXISTS ingest.forum_post (
  id bigint PRIMARY KEY,                 -- wikidot 原始 post id
  thread_id bigint NOT NULL REFERENCES ingest.forum_thread(id),
  parent_post_id bigint,
  author_user_id int REFERENCES ingest."user"(id),
  author_name text,
  title text,
  text_html text,
  text_plain text,                       -- 预提取纯文本,pgroonga 建在此(终结 ILIKE 全表扫)
  created_at timestamptz NOT NULL,
  edited_at timestamptz,
  is_deleted boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS fp_thread ON ingest.forum_post(thread_id, created_at);
CREATE INDEX IF NOT EXISTS fp_author ON ingest.forum_post(author_user_id, created_at DESC) WHERE NOT is_deleted;
-- pgroonga 索引 fp_search(text_plain)/ fp_title_search(title)见 0005_indexes_pgroonga.sql
COMMENT ON TABLE ingest.forum_post IS
  '生命周期:当前态表 + 软删(is_deleted)。主键 = wikidot 原始 post id,编辑就地 UPDATE'
  '(论坛帖不做版本历史,edited_at 是唯一的「变过」痕迹)。'
  'text_plain 是入库时预提取的纯文本,论坛搜索走它上面的 pgroonga(终结 v1 的 ILIKE ''%kw%'' 全表扫 53 万帖)。';
COMMENT ON COLUMN ingest.forum_post.parent_post_id IS
  '刻意不加自引用外键:上游批次内父帖可能后于子帖到达,加 FK 会让 apply_forum_batch 依赖插入顺序。'
  '孤儿引用由投影层容忍(渲染成顶层帖)。';
COMMENT ON COLUMN ingest.forum_post.author_name IS 'wikidot_id ≤ 0 无法归一时的姓名快照;与 author_user_id 至多一个有意义。';

COMMIT;

-- =====================================================================================
-- 后续文件(实际执行顺序,由 ./apply.sh 保证)
--   0002_serve.sql               serve schema:Tier-1(vote_current/attribution_current/page_current)+ Tier-2
--   0003_meta.sql                meta schema:ingest_run / page_scan / scan_task / observation_queue /
--                                ingest_gate / projection_cursor / irreconcilable / vote_quarantine /
--                                revoke_candidate(修订 R2)/ parse_health_baseline(修订 R10)/
--                                v2_baseline(含逐字段权威表,修订 R1)…
--   0004_app.sql                 app schema:BFF 与分析 job 的可写域(收藏/关注/告警/追踪/标签)
--   0005_indexes_pgroonga.sql    pgroonga 索引(扩展缺失时自动降级为 pg_trgm,不阻断迁移)
--   0006_functions.sql           不可变触发器(含 revision 列白名单)+ 10 个 apply_* 转移函数
--                                + meta.ingest_gate 游标安全机制
--   smoke_test.sql               冒烟验证(./apply.sh --smoke;末尾 ROLLBACK,不留数据)
--   9000_roles_grants.sql.ADMIN  CREATE ROLE / GRANT —— 需 superuser 或 CREATEROLE,由 DBA 单独执行,
--                                apply.sh 刻意不碰(.ADMIN 后缀即该约定的物理载体)
-- =====================================================================================
