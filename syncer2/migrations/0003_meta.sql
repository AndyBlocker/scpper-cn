-- =====================================================================================
-- 0003_meta.sql —— v2 独立库(scpper-v2)meta schema:管道状态
-- =====================================================================================
-- 权威来源:docs/data-model-v2-redesign-2026-07-03.md §4.7(全部 13 张表原文 DDL)
-- 增补来源:analysis/wikidot-vs-crom-2026-07-27/{synthesis,findings,field-matrix}.md
--           (2026-07-27 实测,覆盖文档中的相应假设;每处增补都在列注释里标注来由)
--
-- 依赖:无。本文件不引用 ingest.* / serve.* 的任何对象(meta 的 page_id/voter_id 一律
--       不设 FK,见"设计约定 3"),因此可以在 0001/0002 之前单独执行——sitemap 采集层
--       原型只需要 meta,不需要事实层。
--
-- 设计约定:
--   1. 可重复执行:CREATE ... IF NOT EXISTS + ADD COLUMN IF NOT EXISTS +
--      "词表刷新"段落用 DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT 覆盖旧词表。
--      整个文件包在 BEGIN/COMMIT 里,任何一步失败全部回滚。
--   2. 时间列一律 timestamptz(文档§9.16:新表一步到位,不再重蹈 v1 naive-UTC 的坑)。
--   3. meta 里的 page_id / voter_id / v1_vote_id 不设外键:
--      (a) meta 是"管道对自己的观测",记录的可能是**尚未注册进 ingest.page 的**
--          wikidot 页面(sitemap 发现的新 slug、confirm_deleted 候选);
--      (b) 事实层将来做分区滚动/归档时,meta 不应成为阻塞项;
--      (c) meta 可独立部署给采集层原型使用。
--      唯一的例外是 run_id → meta.ingest_run(id),那是 meta 内部的引用。
--   4. 命名:表/列 snake_case;索引前缀取表名首字母缩写(与文档 §4.2~§4.7 一致)。
-- =====================================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS meta;
COMMENT ON SCHEMA meta IS
  '管道状态层:采集轮次/扫描证据/任务队列/游标/隔离与审计。不存业务事实,不对 BFF 暴露(只读授权见 9000_roles_grants.sql.ADMIN)。';


-- =====================================================================================
-- 1. meta.ingest_run —— 采集轮次(run 级完整性证据)
-- =====================================================================================
-- 文档 §4.7 原表 + §5.5"删除推断协议":仅当 status='ok' 且 pages_enumerated 与
-- remote_total 偏差 < 阈值时,才允许做删除/撤票/改名推断。
--
-- 【2026-07-27 实测增补,共 5 组列】
--   * remote_total          —— 实测发现 ListPages 有一个从未被使用的有效 selector
--                              %%total%%,直接返回精确总数(实测 36,173)。此前
--                              "remote_total 拿不到真值"是矩阵里的未决项,现在关闭。
--   * remote_total_source   —— sitemap(35,983)/%%total%%(36,173)/库(36,054)三个
--                              独立计数并存,门控用了哪一个必须可追溯。
--   * pages_enumerated      —— 文档已有;这里补齐 coverage_ratio 生成列把 R9 的
--                              "≥0.98" 判据固化进 schema,而不是散落在代码里。
--   * batches_total /
--     batches_failed        —— 实测基线传输失败率 ≈2.3%/请求。文档/矩阵原来的
--                              "任一批失败即整轮 failed"代入 145 批 ⇒ 96.6% 的轮次
--                              自判死亡,删除推断永远拿不到授权(synthesis P1-1 / R9)。
--                              判据改为"批级重试 ≥3 次耗尽才计入 run 级失败",于是
--                              批次成败必须在 run 级可查,不能只埋在 stats jsonb 里。
--   * transport_failure_rate—— R9 把它标定为 IP 池健康度的最佳单一指标(断路器 N 按
--                              2.3% 基线标定 N=5)。
--   * exit_ip_stats         —— 全部 wikidot 流量走 mihomo 49 节点轮换池,无 fallback、
--                              无健康检查;不记录出口 IP 分布则"某几个节点坏了"不可归因
--                              (synthesis P0-5 / findings#20)。
--   * parse_fingerprint     —— R10 全局解析健康熔断的输入:每轮的分布指纹与
--                              meta.parse_health_baseline 的前 7 日基线比对,任一偏移
--                              超阈即冻结写入(不冻结采集)。理由:逐页校验和在
--                              "ListPages 与 WhoRated 同一次改版一起漂移"时会互相背书
--                              通过,只有全局分布能抓住这类相关性漂移。
-- =====================================================================================
CREATE TABLE IF NOT EXISTS meta.ingest_run (
  id           bigserial PRIMARY KEY,
  source       text        NOT NULL,   -- 'crom' | 'wikidot_sitemap' | 'wikidot_listpages'
                                       -- | 'wikidot_tier2' | 'legacy' | 'v1_backfill' | 'reconcile'
                                       -- 不设 CHECK:采集通道会继续增加,词表卡死会挡住新通道上线。
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text        NOT NULL DEFAULT 'running',

  -- ── 删除推断的 run 级完整性证据(文档 §4.7 + §5.5) ──────────────────────────────
  pages_enumerated int,
  remote_total     int,

  -- ── 2026-07-27 实测增补 ────────────────────────────────────────────────────────
  remote_total_source    text,
  batches_total          int,
  batches_failed         int,
  transport_failure_rate real,
  exit_ip_stats          jsonb NOT NULL DEFAULT '{}'::jsonb,
  parse_fingerprint      jsonb NOT NULL DEFAULT '{}'::jsonb,

  stats jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- 升级路径:若本文件的旧版本已建过 ingest_run,补齐增补列。
ALTER TABLE meta.ingest_run ADD COLUMN IF NOT EXISTS pages_enumerated       int;
ALTER TABLE meta.ingest_run ADD COLUMN IF NOT EXISTS remote_total           int;
ALTER TABLE meta.ingest_run ADD COLUMN IF NOT EXISTS remote_total_source    text;
ALTER TABLE meta.ingest_run ADD COLUMN IF NOT EXISTS batches_total          int;
ALTER TABLE meta.ingest_run ADD COLUMN IF NOT EXISTS batches_failed         int;
ALTER TABLE meta.ingest_run ADD COLUMN IF NOT EXISTS transport_failure_rate real;
ALTER TABLE meta.ingest_run ADD COLUMN IF NOT EXISTS exit_ip_stats          jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE meta.ingest_run ADD COLUMN IF NOT EXISTS parse_fingerprint      jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 覆盖率生成列:R9 的门控判据 coverage_ratio >= 0.98 直接写进 schema,
-- 避免每个调用点各写一遍除法(v1 "5 种当前版本写法"的同型病根)。
ALTER TABLE meta.ingest_run
  ADD COLUMN IF NOT EXISTS coverage_ratio real
  GENERATED ALWAYS AS (pages_enumerated::real / NULLIF(remote_total, 0)) STORED;

CREATE INDEX IF NOT EXISTS ir_source_started ON meta.ingest_run(source, started_at DESC);
CREATE INDEX IF NOT EXISTS ir_status         ON meta.ingest_run(status, started_at DESC);

COMMENT ON TABLE  meta.ingest_run IS
  '采集轮次。删除/撤票/改名推断的 run 级授权凭证:仅 status=''ok'' 且 coverage_ratio >= 0.98 且 batches_failed = 0(重试后)才放行。';
COMMENT ON COLUMN meta.ingest_run.remote_total IS
  '远端声称的页面总数。2026-07-27 实测:ListPages 的 %%total%% 是有效 selector 且返回精确值(36,173),此前"拿不到真值"的未决项就此关闭。';
COMMENT ON COLUMN meta.ingest_run.remote_total_source IS
  '本轮 remote_total 取自哪个计数源:''listpages_total''(%%total%%,精确) / ''sitemap''(35,983) / ''both''(双源一致) / ''unknown''。三个独立计数并存,门控用了哪个必须可追溯。';
COMMENT ON COLUMN meta.ingest_run.pages_enumerated IS
  '本轮实际枚举到的页面数(去重后)。与 remote_total 的比值即 coverage_ratio。';
COMMENT ON COLUMN meta.ingest_run.coverage_ratio IS
  '生成列 = pages_enumerated / remote_total。R9 门控:< 0.98 则本轮禁止任何 absence/删除/改名推断,只允许单调 upsert。';
COMMENT ON COLUMN meta.ingest_run.batches_total IS
  '本轮分批请求总数(ListPages 全站约 145 批 × 250)。';
COMMENT ON COLUMN meta.ingest_run.batches_failed IS
  '重试 ≥3 次仍失败的批数。R9:run 级失败判据是"批级重试耗尽",不是"任一请求失败"——实测传输失败率 ≈2.3%/请求,后者会让 96.6% 的轮次自判死亡。';
COMMENT ON COLUMN meta.ingest_run.transport_failure_rate IS
  '本轮传输层失败率(失败请求/总请求)。实测基线 ≈0.023;既是 IP 池健康度的最佳单一指标,也是断路器 N 的标定依据(N=5 时误跳闸概率 ≈6e-9)。';
COMMENT ON COLUMN meta.ingest_run.exit_ip_stats IS
  '出口 IP 分布 {ip: 请求数, ...} 及池健康快照。来由:全部 wikidot 流量走 mihomo 49 节点轮换池,无 fallback 无健康检查;不落盘则"某几个节点坏了"不可归因(2026-07-27 P0-5)。';
COMMENT ON COLUMN meta.ingest_run.parse_fingerprint IS
  '本轮解析分布指纹,R10 全局解析健康熔断的输入。约定键名(与 meta.parse_health_baseline.metric 同名):revision_type_dist / avg_votes_per_page / avg_tags_len / avg_source_len / avg_attribution_rows / http_status_dist / parse_drop_rate / selector_literal_rate。来由:逐页校验和在"ListPages 与 WhoRated 同一次改版一起漂移"时会互相背书通过,只有全局分布指纹抓得住相关性漂移。';


-- =====================================================================================
-- 2. meta.page_scan —— 扫描成败显式建模(撤票/删除推断的前提证据)
-- =====================================================================================
-- 文档 §4.7 原表。这是把 syncer 54 万条幻影 removed 从"代码 bug"升级为
-- "协议层不可构造"的关键表:只有 status='ok' 的快照才被允许触发 absence 推断。
--
-- 【2026-07-27 实测增补】checksum_ok:
--   实测 6 页样本逐页成立 —— Σsign(WhoRatedPageModule 返回的票) 精确等于
--   ListPages 的 %%rating%%,且 WhoRated 名单条数精确等于 %%rating_votes%%
--   (12/41/163/277/3490/2722 票,rating 10/27/161/12/271/2654)。
--   这是两个**独立模块**之间的站内交叉校验,是 CROM 时代不存在的净升级,
--   也是撤票门控的第四重(synthesis D4 / field-matrix 撤票检测行)。
--   claimed_total/fetched_total 只能校验"条数",checksum_ok 校验"方向和",
--   两者都过才允许 status='ok'。不等即 partial、绝不产生 revoke。
-- =====================================================================================
CREATE TABLE IF NOT EXISTS meta.page_scan (
  run_id        bigint NOT NULL REFERENCES meta.ingest_run(id) ON DELETE CASCADE,
  page_id       int    NOT NULL,       -- 无 FK,见文件头"设计约定 3"
  kind          text   NOT NULL,
  status        text   NOT NULL,
  claimed_total int,                   -- votes: ListPages %%rating_votes%% / revisions: %%revisions%%
  fetched_total int,                   -- 实际解析出的行数
  checksum_ok   boolean,               -- 2026-07-27 增补,见上
  result_hash   bytea,                 -- 收敛检测:连续 K 次同哈希判稳定
  error         text,
  scanned_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, page_id, kind),
  CONSTRAINT page_scan_kind_ck   CHECK (kind   IN ('meta','votes','revisions','content','attributions','forum')),
  CONSTRAINT page_scan_status_ck CHECK (status IN ('ok','partial','failed'))
);

ALTER TABLE meta.page_scan ADD COLUMN IF NOT EXISTS checksum_ok boolean;

CREATE INDEX IF NOT EXISTS ps_page_kind ON meta.page_scan(page_id, kind, scanned_at DESC);
CREATE INDEX IF NOT EXISTS ps_bad       ON meta.page_scan(kind, scanned_at DESC) WHERE status <> 'ok';

COMMENT ON TABLE  meta.page_scan IS
  '页级扫描证据。absence(撤票/删除)推断的硬前提:该页该 kind 在本轮必须 status=''ok''。扫描失败与"数据为空"在此表上永远可区分。';
COMMENT ON COLUMN meta.page_scan.claimed_total IS
  '远端声明值。votes 取同轮 ListPages 的 %%rating_votes%%；revisions 取零基最大修订号'
  '%%revisions%%，其完整 RevisionList 行数应为 claimed_total + offset(1)。'
  '注意直抓 WhoRatedPageModule 天然不含匿名/已删账号票,fetched_total < claimed_total'
  '在有匿名票的站点是常态,本站实测匿名票为 0。';
COMMENT ON COLUMN meta.page_scan.checksum_ok IS
  '站内交叉校验结果:Σsign(WhoRatedPageModule 各票) = ListPages 的 %%rating%%。2026-07-27 实测 6/6 页精确成立。两个独立模块互证,是撤票门控的第四重;为 false 或 NULL 时 status 不得为 ''ok'',绝不产生 revoke。';
COMMENT ON COLUMN meta.page_scan.result_hash IS
  'sha256(排序后的 (voter_id,direction) 序列) 之类的稳定指纹。驱动收敛出口:连续 stable_count>=3 次同哈希但仍与远端 diff ⇒ 转 meta.irreconcilable。';


-- =====================================================================================
-- 3. meta.scan_task —— 取代 v1 DirtyPage 的真队列
-- =====================================================================================
-- 文档 §4.7 原表:失败保留、成功即删、UNIQUE(page_id,kind) 防堆积。
-- 红线(synthesis §5.4):绝不照抄 v1 DirtyPage 的整表 deleteMany+createMany 重建——
-- 那会冲掉 attempts / not_before 退避 / stable_count 收敛三个状态。
--
-- 【2026-07-27 实测增补】kind 词表 +2:
--   * 'sitemap_delta'    —— sitemap.xml 全族被确认为一等采集通道(实测
--                           sitemap_page_1.xml gzip 180KB / 1.26s / 10,000 条,
--                           带精确到秒的 UTC lastmod,实测 5/5 等于 %%updated_at%%)。
--                           lastmod 前进 / 出现未知 slug / 连续 ≥2 轮 absence 这三类
--                           信号需要一个自己的任务种类,不能混进 'meta'。
--   * 'new_page_highfreq'—— 实测 37.9% 的最终被删页活不过 24 小时、83.2% 活不过 7 天,
--                           7–14 天 sweep 对 83% 的删除页 100% 失效(P0-6)。R7:
--                           first_published_at > now()-7d 的页改 2–4h 强制
--                           votes_full + content,最高优先级,不进 sweep 轮转。
-- =====================================================================================
CREATE TABLE IF NOT EXISTS meta.scan_task (
  id               bigserial PRIMARY KEY,
  page_id          int    NOT NULL,    -- 无 FK:sitemap 发现的新 slug 可能尚未 register_page
  kind             text   NOT NULL,
  reasons          text[] NOT NULL DEFAULT '{}',
  priority         int    NOT NULL DEFAULT 0,
  not_before       timestamptz,        -- 指数退避载体(1h → 4h → 24h → 7d)
  attempts         int    NOT NULL DEFAULT 0,
  stable_count     int    NOT NULL DEFAULT 0,   -- 连续结果稳定次数(收敛出口)
  last_result_hash bytea,
  locked_by        text,
  locked_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, kind)
);

CREATE INDEX IF NOT EXISTS st_claim ON meta.scan_task(kind, priority DESC, not_before NULLS FIRST, id)
  WHERE locked_by IS NULL;
CREATE INDEX IF NOT EXISTS st_locked ON meta.scan_task(locked_at) WHERE locked_by IS NOT NULL;

COMMENT ON TABLE meta.scan_task IS
  '定向深扫队列(FOR UPDATE SKIP LOCKED 认领)。失败保留、成功即删。禁止整表重建——那会冲掉 attempts/not_before/stable_count 三个状态(v1 DirtyPage 与论坛 #113 丢帖事故的同型病根)。';
COMMENT ON COLUMN meta.scan_task.kind IS
  '任务种类。2026-07-27 增补 ''sitemap_delta''(sitemap 为一等发现通道后的独立信号:lastmod 前进 / 未知 slug / 连续 absence)与 ''new_page_highfreq''(新页 2-4h 高频队列,实测 83.2% 的被删页活不过 7 天,sweep 轮转对其完全失效)。';
COMMENT ON COLUMN meta.scan_task.stable_count IS
  '连续 result_hash 一致的次数。>=3 且仍与远端 diff ⇒ 写 meta.irreconcilable 并转指数退避,从常规告警分流。';


-- =====================================================================================
-- 4. meta.observation_queue —— 双写期观测捕获(文档 §5.6,取代 SAVEPOINT 方案)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS meta.observation_queue (
  id           bigserial PRIMARY KEY,
  page_id      int,                    -- 可空:新页在 register_page 之前只有 wikidot_id
  wikidot_id   int    NOT NULL,
  kind         text   NOT NULL,        -- 'page_full'|'votes'|'revisions'|'attributions'|'meta'|'life'|'forum'
  payload      jsonb  NOT NULL,        -- 归一化整页观测(不是 v1 行,是上游原始观测)
  enqueued_at  timestamptz NOT NULL DEFAULT now(),
  status       text   NOT NULL DEFAULT 'pending',
  attempts     int    NOT NULL DEFAULT 0,
  error        text,
  processed_at timestamptz,
  CONSTRAINT observation_queue_status_ck CHECK (status IN ('pending','done','failed'))
);
CREATE INDEX IF NOT EXISTS oq_pending ON meta.observation_queue(status, enqueued_at) WHERE status <> 'done';

COMMENT ON TABLE meta.observation_queue IS
  '双写期观测捕获队列。v1 写路径成功后以独立短事务投递归一化观测,v2-consumer 独立进程消费。爆炸半径 = 一条队列行,v1 完全无感。';


-- =====================================================================================
-- 5. meta.ingest_gate —— 活跃摄入事务 seq 下界(文档 §5.5 游标安全)
-- =====================================================================================
-- 现实是多写者(sync CLI concurrency=4、Phase C concurrency=2、未来 sentinel),
-- "seq 分配即提交顺序"不成立。每个摄入事务在分配任何 seq **之前**插入本表,
-- 提交前删除(同事务,回滚自动清除);projector 的安全水位 =
--   COALESCE(min(seq_floor)-1, ingest.fact_seq.last_value)。
CREATE TABLE IF NOT EXISTS meta.ingest_gate (
  txid       bigint PRIMARY KEY,
  seq_floor  bigint NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ig_floor ON meta.ingest_gate(seq_floor);

COMMENT ON TABLE meta.ingest_gate IS
  '活跃摄入事务的 seq 下界。游标只推进到 min(seq_floor)-1,先取 seq 后提交的事务不再被跳过——静默漏投影在机制上不可能。行是事务生命周期的,残留行 = 崩溃的写者(需清理告警)。';


-- =====================================================================================
-- 6. meta.projection_cursor —— 投影游标与重建契约(文档 §4.7)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS meta.projection_cursor (
  projection   text PRIMARY KEY,
  event_domain text NOT NULL,
  last_seq     bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  rebuild_from text NOT NULL            -- 重建来源显式契约(文档 §4.5 每张投影都要声明)
);
COMMENT ON COLUMN meta.projection_cursor.rebuild_from IS
  '该投影的重建来源表达式,例如 ''vote_current'' / ''vote_event ⋈ attribution_current''。"新统计必须先声明投影与 rebuild_from"这条纪律的物理载体。';


-- =====================================================================================
-- 7. meta.irreconcilable —— 不可调和页的收敛终态(文档 §4.7 / §5.7)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS meta.irreconcilable (
  page_id      int  NOT NULL,
  kind         text NOT NULL,
  local_value  jsonb NOT NULL,
  remote_value jsonb NOT NULL,
  result_hash  bytea,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_checked timestamptz NOT NULL DEFAULT now(),
  checks       int  NOT NULL DEFAULT 1,
  next_review_at timestamptz,
  locked_by    text,
  locked_at    timestamptz,
  resolved_at  timestamptz,
  PRIMARY KEY (page_id, kind)
);
CREATE INDEX IF NOT EXISTS irr_open ON meta.irreconcilable(kind, last_checked) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS irr_review_due
  ON meta.irreconcilable(next_review_at, kind)
  WHERE resolved_at IS NULL AND result_hash IS NOT NULL;

COMMENT ON TABLE meta.irreconcilable IS
  '连续 stable_count>=3 次结果稳定但仍与远端有界不一致的页(v1 时代 942 页 rating 不等)。**不用远端 rating 制造 correction 事件**——聚合值只能由事实折叠产生,远端差值仅作展示/审计,人工裁决需以 source=''reconcile'' 的显式补偿观测处理。';
COMMENT ON COLUMN meta.irreconcilable.next_review_at IS
  '独立终态队列的下次复查时间。常态每 7 天一次；临时传输/解析故障只在本表退避，不重建 scan_task。';


-- =====================================================================================
-- 8. meta.vote_quarantine —— 隔离不篡改(文档 §4.7 / §5.2)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS meta.vote_quarantine (
  id             bigserial PRIMARY KEY,
  page_id        int,
  voter_key      text,                  -- COALESCE(user_id::text, 'a:'||anon_key);归一化失败时保留原始串
  raw            jsonb NOT NULL,
  reason         text  NOT NULL,        -- 'direction_out_of_range' | 'unresolvable_voter'
                                        -- | 'anon_without_key' | 'parse_conflict' | 'checksum_mismatch'
  source         text  NOT NULL,
  occurred_at    timestamptz,
  quarantined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vq_reason ON meta.vote_quarantine(reason, quarantined_at DESC);
CREATE INDEX IF NOT EXISTS vq_page   ON meta.vote_quarantine(page_id, quarantined_at DESC);

COMMENT ON TABLE meta.vote_quarantine IS
  '上游脏值与协议拒绝的留痕。direction=±2 是 CROM 文档化的正常输出(v1 存量 1,352~1,658 行),在 apply 入口 sign() 归一化后原始值写这里 —— 归一化+留痕,而不是 CHECK 在门口把整页事务卡死。';


-- =====================================================================================
-- 9. meta.dedup_audit —— v1 存量清洗的逐行审计(文档 §4.7 / §8 Phase 2)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS meta.dedup_audit (
  id         bigserial PRIMARY KEY,
  v1_vote_id bigint NOT NULL,
  rule       text   NOT NULL,           -- 'R1'..'R5'
  kept_ref   text,                      -- 保留行指针(v1 id 或 v2 seq)
  confidence text,                      -- 'high'|'medium'|'low';low 一律不删
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS da_rule ON meta.dedup_audit(rule, created_at);
CREATE INDEX IF NOT EXISTS da_v1   ON meta.dedup_audit(v1_vote_id);

COMMENT ON TABLE meta.dedup_audit IS
  '每条被折叠/降级的 v1 Vote 行:规则号 + 保留行指针 + 置信度。"只删可证明的副本"原则的可追溯载体。';


-- =====================================================================================
-- 10. meta.backfill_progress —— 回填断点续跑(文档 §4.7 / §8)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS meta.backfill_progress (
  domain       text   NOT NULL,
  shard        text   NOT NULL DEFAULT '',
  last_page_id int    NOT NULL DEFAULT 0,
  done_count   bigint NOT NULL DEFAULT 0,
  total_count  bigint,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, shard)
);


-- =====================================================================================
-- 11. meta.v2_baseline —— 固化基线与逐字段权威表(文档 §4.7 + 修订 R1)
-- =====================================================================================
-- 文档原用途:固化 v1 基线指标(Vote 5,673,450 / distinct 1,625,162 / Revision distinct
-- 511,465 / 抽样对账)。2026-07-27 修订 R1 追加用途:逐字段权威表
-- authority ∈ {crom, wikidot, both, derived},对账只在 authority='both' 的字段上做。
-- 两者形状相同(键 + 值 + detail),共用一张表,用 metric 前缀区分:
--   'baseline.*'  固化基线      'authority.<表>.<列>'  字段权威
CREATE TABLE IF NOT EXISTS meta.v2_baseline (
  metric      text PRIMARY KEY,
  value       numeric,
  detail      jsonb,
  captured_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE meta.v2_baseline IS
  '固化基线("value"是数字)与逐字段权威表("detail"是 {authority: crom|wikidot|both|derived, reason})。metric 前缀:baseline.* / authority.<表>.<列>。';


-- =====================================================================================
-- 12. meta.v1_version_map —— 冻结的 v1 版本映射(老 /versions/:id 链接不 404)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS meta.v1_version_map (
  v1_page_version_id int PRIMARY KEY,
  page_id            int NOT NULL,
  valid_from         timestamptz NOT NULL,
  valid_to           timestamptz,
  is_deleted         boolean NOT NULL DEFAULT false,
  version_no         int                    -- 对应 serve.page_version_display.version_no
);
CREATE INDEX IF NOT EXISTS vvm_page ON meta.v1_version_map(page_id, valid_from);
COMMENT ON TABLE meta.v1_version_map IS
  '一次性冻结(Phase 2)后只读。PageVersion 退役后,存量 /versions/:versionId 链接经此表解析到 (page_id, version_no)。';


-- =====================================================================================
-- 13. meta.image_ingest_job —— avatar-agent worker 认领队列(SKIP LOCKED 模式不变)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS meta.image_ingest_job (
  id             bigserial PRIMARY KEY,
  page_id        int  NOT NULL,
  normalized_url text NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  attempts       int  NOT NULL DEFAULT 0,
  locked_by      text,
  locked_at      timestamptz,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, normalized_url),
  CONSTRAINT image_ingest_job_status_ck CHECK (status IN ('pending','processing','completed','failed'))
);
CREATE INDEX IF NOT EXISTS iij_claim ON meta.image_ingest_job(status, id) WHERE locked_by IS NULL;


-- =====================================================================================
-- 14. meta.parse_health_baseline —— 【2026-07-27 新增】全局解析健康熔断的基线与阈值
-- =====================================================================================
-- 来由(synthesis R10 / findings 第 303 行):
--   直连解析面在活跃变动(实测 AMC POST 新增强制 Referer;此前已知空 UA→503),
--   而危险的失败模式不是宕机(良性:请求失败、门控生效、不写),而是**改版后模块照返
--   status=ok、解析静默变形**,v2 带着 is_complete=true 把脏数据写进 append-only 事实表。
--   已有三个实证(ContentScanner td 正则 153/153 全失配、FLAG_TYPE_MAP 英文键对中文
--   全不命中、库 SiteChangeCollection 选择器命中 0),并实测拿到同一 revision 在两条
--   链路被打成不同 type 的数据实锤。
--   逐页校验和(page_scan.checksum_ok)抓不住这类相关性漂移——ListPages 与 WhoRated
--   同一次改版一起漂移时,两个数会一起变、校验和仍然成立。只有"分布指纹 vs 前 7 日
--   基线"能抓住。触发时**冻结写入、不冻结采集**,要求人工确认。
-- 上线 gate:必须在一次人为注入的解析故障演练中成功阻断写入。
-- =====================================================================================
CREATE TABLE IF NOT EXISTS meta.parse_health_baseline (
  source            text NOT NULL,       -- 与 meta.ingest_run.source 同词表
  metric            text NOT NULL,       -- 与 meta.ingest_run.parse_fingerprint 的键同名
  window_days       int  NOT NULL DEFAULT 7,
  sample_count      int  NOT NULL DEFAULT 0,
  baseline_value    numeric,
  baseline_stddev   numeric,
  lower_bound       numeric,             -- 绝对下界(NULL = 不设)
  upper_bound       numeric,             -- 绝对上界(NULL = 不设)
  max_rel_deviation numeric,             -- 相对偏移阈值,如 0.15 = 允许 ±15%
  direction         text NOT NULL DEFAULT 'both',
  action            text NOT NULL DEFAULT 'freeze_write',
  enabled           boolean NOT NULL DEFAULT true,
  computed_from_run bigint REFERENCES meta.ingest_run(id) ON DELETE SET NULL,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  -- 越界留痕:哪一轮、哪个值触发过,便于事后复盘"熔断是否误跳闸"
  last_breach_at    timestamptz,
  last_breach_value numeric,
  last_breach_run   bigint REFERENCES meta.ingest_run(id) ON DELETE SET NULL,
  breach_count      int NOT NULL DEFAULT 0,
  PRIMARY KEY (source, metric),
  CONSTRAINT phb_direction_ck CHECK (direction IN ('both','up','down')),
  CONSTRAINT phb_action_ck    CHECK (action    IN ('freeze_write','warn'))
);

COMMENT ON TABLE meta.parse_health_baseline IS
  '全局解析健康熔断的前 7 日基线与阈值(R10)。每轮把 meta.ingest_run.parse_fingerprint 的同名键与本表比对,任一 enabled 指标越界且 action=''freeze_write'' ⇒ 冻结写入(不冻结采集),人工确认后放行。';
COMMENT ON COLUMN meta.parse_health_baseline.metric IS
  '指标名,必须与 ingest_run.parse_fingerprint 的 jsonb 键完全同名。建议集:revision_type_dist / avg_votes_per_page / avg_tags_len / avg_source_len / avg_attribution_rows / http_status_dist / parse_drop_rate / selector_literal_rate。';
COMMENT ON COLUMN meta.parse_health_baseline.direction IS
  '哪个方向算异常。示例:avg_votes_per_page 骤降是解析失效('' down''),selector_literal_rate 上升才是异常(''up''),tags 平均长度双向都可疑(''both'')。';
COMMENT ON COLUMN meta.parse_health_baseline.action IS
  '''freeze_write'' = 冻结写入并告警(默认);''warn'' = 仅告警。观察期新指标先用 warn 跑够样本再转 freeze_write,避免刚上线就天天跳闸。';


-- =====================================================================================
-- 15. meta.revoke_candidate —— 【2026-07-27 新增】wikidot absence 推断出的疑似撤票
-- =====================================================================================
-- 来由(synthesis D4 / 修订 R2):
--   CROM 以**显式 direction=0 记录**送达撤票;wikidot 直连**只能靠 absence 推断**
--   (撤票者从 WhoRated 名单里消失,没有任何显式信号)。四重门控
--   (is_complete / cardinality=claimed_total / visible_kinds / Σsign=%%rating%%)
--   设计精巧且实测成立,但它保护不了两类情形:
--     (a) P0-6 短命页:83.2% 的被删页活不过 7 天,一个 sweep 周期内就消失;
--     (b) ListPages 与 WhoRated 同时改版一起漂移、校验和互相背书通过的相关性失效。
--   因此:**wikidot 的 absence 不直接生成 ingest.vote_event(kind='revoke')**,
--   先落本表成为"候选",待 CROM 显式 direction=0 确认、或人工裁决签发后才转正。
--   代价是撤票延迟 = CROM 抓取周期(天级),换来"永不产生幻影撤票"——
--   syncer 54 万条幻影 removed 的教训值这个价。
-- =====================================================================================
-- ⚠【2026-07-27 整合定稿】本表的形状由 0006_functions.sql 的可执行代码决定,不是反过来。
--   apply_vote_snapshot 用 `ON CONFLICT (page_id, voter_id) DO UPDATE SET confirmations = ...`
--   累加确认次数,promote_revoke_candidates 读 confirmations / last_run_id / held_reason /
--   promoted_seq。因此:
--     * 主键必须是 (page_id, voter_id) 本身 —— 部分唯一索引 `WHERE status='pending'` 无法
--       服务 ON CONFLICT 推断(PG 只接受与推断谓词一致的部分索引,而 upsert 时并不知道
--       目标行的 status),初稿的 `id bigserial PK + rc_pending 部分唯一` 会在运行期报
--       "there is no unique or exclusion constraint matching the ON CONFLICT specification"。
--     * 计数列名为 confirmations(初稿叫 seen_count)、run 指针为 last_run_id(初稿叫 run_id)、
--       转正指针为 promoted_seq(初稿叫 resolved_event_seq)。
--     * observed_at 必须允许为空或有默认 —— 初稿的 `NOT NULL 无默认` 会让每一次候选写入
--       直接 23502。这里保留该列(它是"快照统一时刻",比逐票 now() 有意义)并给默认值。
--   status 词表统一为代码实际写入的四值;初稿词表的对应关系:
--     confirmed → promoted;rejected → dismissed;expired → dismissed(held_reason 记明过期)。
CREATE TABLE IF NOT EXISTS meta.revoke_candidate (
  page_id        int    NOT NULL,       -- 无 FK,见文件头"设计约定 3"
  voter_id       int    NOT NULL,
  last_direction smallint,              -- 被推断撤销前 serve.vote_current.direction 的值
  confirmations  int    NOT NULL DEFAULT 1,  -- 连续多少轮「完整且 checksum 通过」的快照里缺席
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  observed_at    timestamptz NOT NULL DEFAULT now(),  -- 产生该候选的那次快照的统一时刻
  last_run_id    bigint REFERENCES meta.ingest_run(id) ON DELETE SET NULL,
  source         text   NOT NULL DEFAULT 'wikidot',
  gate_result    jsonb  NOT NULL DEFAULT '{}'::jsonb,
  gate_passed    boolean NOT NULL DEFAULT false,
  status         text   NOT NULL DEFAULT 'pending',
  held_reason    text,                        -- held / dismissed 的原因(熔断阈值、过期…)
  promoted_seq   bigint,                      -- 转正后对应的 ingest.vote_event.seq(无 FK,跨 schema 解耦)
  resolved_at    timestamptz,
  resolved_by    text,                        -- 'crom:run=<id>' | 'operator:<name>' | 'rule:<name>'
  note           text,
  PRIMARY KEY (page_id, voter_id),
  CONSTRAINT revoke_candidate_status_ck
    CHECK (status IN ('pending','promoted','dismissed','held')),
  CONSTRAINT revoke_candidate_dir_ck
    CHECK (last_direction IS NULL OR last_direction IN (-1,1))
);

CREATE INDEX IF NOT EXISTS rc_ready ON meta.revoke_candidate(confirmations DESC, page_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS rc_open  ON meta.revoke_candidate(status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS rc_voter ON meta.revoke_candidate(voter_id, status);

COMMENT ON TABLE meta.revoke_candidate IS
  'wikidot absence 推断出的疑似撤票。**absence 绝不直接生成 revoke 事件**,先进本表;由 CROM 显式 direction=0 确认或人工裁决签发后才转正为 ingest.vote_event(kind=''revoke'')。撤票延迟换"永不产生幻影撤票"(syncer 54 万幻影 removed 的教训)。写入者:ingest.apply_vote_snapshot(累积)与 ingest.promote_revoke_candidates(转正/作废/扣住)。';
COMMENT ON COLUMN meta.revoke_candidate.gate_result IS
  '四重门控逐项结果,例如 {"is_complete":true,"claimed_total":163,"fetched_total":163,"visible_kinds":["wikidot"],"checksum_ok":true,"sum_sign":161,"remote_rating":161}。哪一重没过必须可查——否则"为什么没转正"无法审计。';
COMMENT ON COLUMN meta.revoke_candidate.confirmations IS
  '连续几轮 status=''ok'' 且 checksum 通过的完整快照里都缺席。单轮缺席可能是解析漂移;要求 >=2 轮才允许转正(与删除推断的"连续 >=2 个完整 run"同构)。同一 run 内重复应用同一份快照不累加(apply_vote_snapshot 按 last_run_id 判定)。';
COMMENT ON COLUMN meta.revoke_candidate.status IS
  '''pending'' 累积中 / ''promoted'' 已转正为 vote_event(promoted_seq)/ ''dismissed'' 人工否决或过期作废 / ''held'' 触发单页熔断被扣住待人工裁决。voter 在任何快照中重新出现 ⇒ 本行**直接删除**(出现是正证据,无条件采信)。';


-- =====================================================================================
-- 词表刷新段:让本文件可重复执行时也能**更新**已存在表的 CHECK 词表
-- (直接 CREATE TABLE IF NOT EXISTS 不会修改已存在表的约束,必须显式 DROP+ADD)
-- =====================================================================================
ALTER TABLE meta.ingest_run       DROP CONSTRAINT IF EXISTS ingest_run_status_ck;
ALTER TABLE meta.ingest_run       ADD  CONSTRAINT ingest_run_status_ck
  CHECK (status IN ('running','ok','failed','aborted'));

ALTER TABLE meta.ingest_run       DROP CONSTRAINT IF EXISTS ingest_run_remote_total_source_ck;
ALTER TABLE meta.ingest_run       ADD  CONSTRAINT ingest_run_remote_total_source_ck
  CHECK (remote_total_source IS NULL
         OR remote_total_source IN ('listpages_total','sitemap','both','unknown'));

ALTER TABLE meta.page_scan        DROP CONSTRAINT IF EXISTS page_scan_kind_ck;
ALTER TABLE meta.page_scan        ADD  CONSTRAINT page_scan_kind_ck
  CHECK (kind IN ('meta','votes','revisions','content','attributions','forum'));

ALTER TABLE meta.page_scan        DROP CONSTRAINT IF EXISTS page_scan_status_ck;
ALTER TABLE meta.page_scan        ADD  CONSTRAINT page_scan_status_ck
  CHECK (status IN ('ok','partial','failed'));

-- scan_task.kind:文档 §4.7 的 6 项 + 2026-07-27 增补的 2 项
ALTER TABLE meta.scan_task        DROP CONSTRAINT IF EXISTS scan_task_kind_ck;
ALTER TABLE meta.scan_task        ADD  CONSTRAINT scan_task_kind_ck
  CHECK (kind IN (
    'meta',
    'votes_full',
    'revisions_full',
    'content',
    'attributions',
    'confirm_deleted',
    'sitemap_delta',      -- 2026-07-27:sitemap 成为一等发现通道后的独立信号
    'new_page_highfreq'   -- 2026-07-27:新页 2-4h 高频队列(83.2% 被删页活不过 7 天)
  ));

ALTER TABLE meta.observation_queue DROP CONSTRAINT IF EXISTS observation_queue_status_ck;
ALTER TABLE meta.observation_queue ADD  CONSTRAINT observation_queue_status_ck
  CHECK (status IN ('pending','done','failed'));

ALTER TABLE meta.image_ingest_job  DROP CONSTRAINT IF EXISTS image_ingest_job_status_ck;
ALTER TABLE meta.image_ingest_job  ADD  CONSTRAINT image_ingest_job_status_ck
  CHECK (status IN ('pending','processing','completed','failed'));

COMMIT;

-- =====================================================================================
-- 自检(不在事务内,按需手工执行):
--   SELECT table_name FROM information_schema.tables WHERE table_schema='meta' ORDER BY 1;
--   -- 期望 15 张:backfill_progress dedup_audit image_ingest_job ingest_gate ingest_run
--   --            irreconcilable observation_queue page_scan parse_health_baseline
--   --            projection_cursor revoke_candidate scan_task v1_version_map
--   --            v2_baseline vote_quarantine
-- =====================================================================================
