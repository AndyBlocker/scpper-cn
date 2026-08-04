# M10 · 对账层构建报告

> 模块：投影层规格 §3（M10）  
> 工作树：`feat__syncer2-foundation`  
> 实施日期：2026-07-27（Asia/Shanghai）  
> 目标运行时：TypeScript ESM / Node.js 22  
> 最终状态：实现完成；代码、迁移、专项测试、全量回归和受限真实样本均已执行  
> Git：未 commit、未 push

---

## 1. 结论先行

本轮完成了以下四组能力：

1. **§3.2 v1/v2 三轨对账**
   - 状态对齐轨：v1 当前 `LatestVote` 状态与 v2 `serve.vote_current` 对齐；
   - 白名单轨：已删页票、v1 去重折叠差、时间精度降级三类指标只允许稳定或下降；
   - 冻结轨：已删页 `vote_current` 的全量 checksum 与行数每日冻结；
   - 任一侧最近 60 分钟变更的页不参与状态判定；
   - 连续 7 个上海日均满足 `<0.1%` 且无未解释差异后，三轨状态才允许变为 `ok`。

2. **§3.3 CROM 全量金丝雀**
   - 默认不设抽样上限，游标必须走到 `hasNextPage=false`；
   - 全量比较存在性、title、rating、voteCount、revisionCount；
   - 查询只取规格要求的廉价字段；
   - CROM 使用复用的 `HttpClient`，但实例明确 `proxyUrl=null`，本机直连，不占 Wikidot IP 池；
   - 只有显式传 `--crom-max-pages` 才允许诊断小样本，且未走完游标时强制 `partial`。

3. **§3.4 站内三角**
   - 完整 sitemap 快照与完整 ListPages 快照做集合互校；
   - WhoRated 的 `Σsign(direction)` 与 ListPages `%%rating%%` 做精确校验；
   - 修订列表解析行数与 ListPages `%%revisions%%` 做精确校验；
   - 所有页级结果保留在 `Map`，请求失败、解析失败和数值不一致均不会消失或变成空通过。

4. **§3.5 报告与 QQ 摘要**
   - 完整结果写入新表 `meta.reconcile_report`；
   - `--qq-summary` 的 stdout 恰好一行 JSON，stderr 保留日志；
   - 摘要包含总状态、差异数、未解释数、三轨状态、CROM 五项和站内三角结果；
   - CLI 非 `ok` 时以非零码退出，便于调度器告警。

代码无已知编译或测试阻塞。当前无法把生产对账判绿的原因不是实现缺失，而是 v2 仍处于回填前期：
真实运行时 v1 有 36,057 个 live 页，v2 只有 118 个 live 页；完整 ListPages 快照也尚未生成。

---

## 2. 权威规格与边界落实

本轮按用户给定顺序完整阅读并以其为唯一权威：

1. `SPEC-collector.md`
2. `SPEC-projector.md`
3. `syncer2/README.md`
4. `syncer2/src/`
5. `syncer2/migrations/`

落实的硬边界：

| 边界 | 实现 |
|---|---|
| 只能写 `scpper-v2` | CLI 在解析连接串时校验 pathname 必须精确等于 `scpper-v2`，连库后再次检查 `current_database()` |
| v1 主库只读 | URL 库名只允许 `scpper-cn` / `scpper_cn`；预检和每组实际查询都执行 `BEGIN READ ONLY` |
| 不写 `scpper-syncer` / `scpper_user` | CLI 不接受这些库；`0014_reconcile.sql` 也带受保护库黑名单 |
| Wikidot 必须走 `127.0.0.1:7891` | 复用 `loadConfig()` 与 `HttpClient`；真实运行日志确认 proxy 为该地址 |
| UA / Referer 不得为空 | 复用 `HttpClient.assertHeaders()`；真实运行前完成断言 |
| 503 熔断不可绕过 | 没有新增 HTTP 层；全部请求仍走既有重试/503/重置断路器 |
| 时间类型不可猜 | 复用 `assertTimezoneRoundTrip()`、`query()`、`toPgTimestamptz()` |
| 空结果与失败可区分 | CROM、快照、页级三角均有结构断言和负向测试 |
| 真实样本 ≤50 请求 | 本轮合计 16 个 Wikidot 请求 + 1 个 CROM 请求；全部低于预算 |

没有向 v1 三个受保护库发出任何 DDL/DML。对 v1 的真实三轨运行只执行只读事务中的 `SELECT`。

---

## 3. 文件清单

### 3.1 新增

| 文件 | 作用 |
|---|---|
| `migrations/0014_reconcile.sql` | 新建 `meta.reconcile_report`、约束、索引、注释和 ingestor 授权 |
| `src/reconcile/types.ts` | 对账状态、计数、合并、报告样本上限 |
| `src/reconcile/parity.ts` | 三轨对账、7 日放行门、操作员白名单 |
| `src/reconcile/crom.ts` | CROM 全游标抓取、严格解析、全量五项比较 |
| `src/reconcile/triangle.ts` | sitemap/ListPages 集合互校、WhoRated/修订页级三角 |
| `src/reconcile/report.ts` | 报告组装、持久化、QQ 紧凑摘要 |
| `src/cli/reconcile.ts` | M10 单次短进程 CLI |
| `tests/reconcile.test.ts` | M10 纯逻辑、负向解析和计数边界测试 |
| `docs/build-report-10.md` | 本报告 |

### 3.2 更新

| 文件 | 变化 |
|---|---|
| `package.json` | 新增 `reconcile` / `reconcile:qq` |
| `.env.example` | 增加只用于 parity 的 v1 只读连接说明 |
| `README.md` | 增加 M10 用法、完成度和最新测试基线 |
| `prisma/schema.prisma` | 通过仓库唯一允许的 `prisma/pull.sh` 吸收真实新表 |
| `prisma/schema.header.prisma` | 同步真实 86 model / 86 非分区表计数 |

没有另建 HTTP client、DB helper 或通用日志层。

---

## 4. §3.2 三轨对账实现

### 4.1 状态对齐轨

v1 查询口径：

- `Page.isDeleted=false`
- 当前 `PageVersion.validTo IS NULL`
- 当前版本 `PageVersion.isDeleted=false`
- 页面必须有 `wikidotId`
- `LatestVote.direction` 一律先 `sign()`，因此历史污染的 `±2` 不会改变方向口径
- voter 以 Wikidot 用户 id 转成稳定键 `wikidot:<id>`
- rating、票数与按 actor 排序后的 MD5 checksum 同时比较
- v1 的无时区列显式按 `Asia/Shanghai` 解释后再转 epoch

v2 查询口径：

- `serve.page_current.status='live'`
- 投票来自 `serve.vote_current`
- voter 键优先 `wikidot:<id>`，否则保留 kind + anon key，绝不把不同身份压成一个 id=0
- direction 同样使用 `sign()`

逐页比较字段：

- existence
- title
- rating
- tags（集合比较，顺序不构成差异）
- vote_state（voterCount、Σsign、actor+direction checksum 三者）

明确没有比较规格禁止的字段：

- `isHidden`
- `isUserPage`
- 已删页 metadata
- `commentCount`
- attribution type
- 原始 direction 的绝对值

### 4.2 60 分钟滞后窗

只要 v1 或 v2 任一侧的页面 metadata / vote state 在窗口内更新，整页就进入
`lagExcludedPages`，本轮不进入 diff 分母，也不产生存在性或字段告警。

CLI 对 `--lag-minutes` 的下限强制为 60，不能通过参数把规格窗口缩短。

### 4.3 操作员可解释白名单

状态差异默认全部是未解释。若确实有人工确认的已知差异，可在 `meta.v2_baseline` 放入：

```json
{
  "metric": "reconcile.allow.<stable-name>",
  "detail": {
    "wikidotId": 123,
    "field": "title",
    "reason": "明确、可审计的原因",
    "enabled": true,
    "expiresAt": "2026-08-10T00:00:00.000Z"
  }
}
```

允许字段词表只有 `existence/title/rating/tags/vote_state`。缺 wikidotId、空 reason、非法字段、
禁用或已过期的记录均被忽略。报告样本同时保存 `explanations`，不会只写“已解释”而丢掉原因。

日状态合格条件：

```text
comparablePages > 0
AND pagesWithDifferences / comparablePages < 0.001
AND unexplainedPages = 0
```

阈值是严格小于 0.1%，不是小于等于。

### 4.4 白名单轨

每日记录四个稳定性指标：

1. `deleted_page_vote_pairs`
2. `v1_latestvote_fold_delta`
3. `imprecise_vote_events`
4. `bootstrap_vote_events`

首次运行只建立基线，状态为 `partial`。后续值相等或下降为 `ok`；任一值增长即 `failed`。
“这是已知类型”不意味着“增长也可以忽略”。

真实首次基线：

```json
{
  "deleted_page_vote_pairs": 0,
  "v1_latestvote_fold_delta": 4617976,
  "imprecise_vote_events": 0,
  "bootstrap_vote_events": 0
}
```

### 4.5 冻结轨

对全部已删页的 `serve.vote_current` 按 `(page_id,voter_id)` 排序，checksum 材料为：

```text
page_id:voter_id:sign(direction)
```

同时保存行数与 MD5。首次运行为 `partial`，之后行数或 checksum 任一变化都为 `failed`。
计数实现特意覆盖“原来非空、现在变成 0”的边界，保证 `differences <= compared` 仍成立，
不会在最值得告警时反被数据库 CHECK 拒绝。

真实首次冻结基线：

```text
count=0
checksum=d41d8cd98f00b204e9800998ecf8427e
```

### 4.6 连续七日放行门

历史读取最近 40 个 `all/parity` 报告，按 **Asia/Shanghai 日历日** 去重；同一天跑多次不能垫高
streak。只有当前日也合格且向前连续 7 日均合格时，`sevenDayGatePassed=true`。

即使单日三轨全部为 `ok`，但 streak 只有 1–6 天，parity 总状态仍被降为 `partial`，并输出：

```text
状态对齐仅连续 N/7 天达标；未满足七日放行门
```

---

## 5. §3.3 CROM 全量金丝雀

### 5.1 查询字段

CROM GraphQL 只请求：

- url
- wikidotId
- title
- rating
- voteCount
- revisionCount

不请求正文、tags、作者或其它高成本字段。

### 5.2 全量与游标纪律

默认运行：

```bash
npm run reconcile -- --mode crom
```

不会设置页数上限，必须满足：

- 每批 connection 结构合法；
- `hasNextPage=true` 时必须有非空 `endCursor`；
- 当前批不得空；
- cursor 不得重复；
- 单批和跨批 wikidotId 均不得重复；
- 最终必须走到 `hasNextPage=false`；
- 全站最终 0 页视为失败，不是真空通过。

每一批均保留 `Map<batchNo, outcome>`。中间请求、GraphQL errors 或解析失败会返回 `failed`，
已抓到的半截页面只用于诊断，不会变成 `isFull=true`。

显式小样本：

```bash
npm run reconcile -- --mode crom --crom-max-pages 3 --qq-summary
```

页数上限会直接下推到 GraphQL `first`。例如 `batchSize=100,maxPages=3` 实际 `first=3`，
不会为了取 3 页多抓整批 100 页。若服务端仍有下一页，状态固定为 `partial`。

### 5.3 五项比较与数据质量告警

存在性按 wikidotId 全量集合比较；共有页再比较四个字段。另有两类塌缩检测：

- 共有页至少 100 时，某字段 unique values ≤1；
- 某字段 CROM null rate >1%。

塌缩告警也进入 `differences/unexplained`，避免出现 `unexplained > differences` 的非法计数。

CROM 和 v2 最近更新页仍进入全量计数，但字段差异在 60 分钟窗口内标为非 actionable；
原始 mismatch 不会消失，报告同时给出 raw 与 actionable 数。

### 5.4 直连证据

真实报告 id=2 的 HTTP 部分：

```json
{
  "crom": {
    "direct": true,
    "requests": 1,
    "attempts": 1,
    "retries": 0,
    "statusBuckets": {"200": 1},
    "breakerOpen": false,
    "wireBytes": 498,
    "decodedBytes": 1147
  }
}
```

这证明 CROM 没有走 `127.0.0.1:7891`，也没有占 Wikidot IP 池；但仍复用了统一的 UA、Referer、
超时、遥测和断路器实现。

---

## 6. §3.4 站内三角

### 6.1 sitemap vs ListPages

默认读取两个独立采集模块留下的原子完整快照：

- `state/sitemap-page.snapshot.json.gz`
- `state/listpages-tier1.snapshot.json.gz`

快照需要满足：

- 文件存在且可解压/解析；
- `version`、`rows/entries`、remote total 等结构完整；
- 不是空集合；
- 默认不超过 26 小时；
- sitemap 必须是最近一次 full 轮，而非 delta 局部片段。

缺失、损坏、过旧或空快照均为 `failed`，不会被解释为“站点有 0 页”。

规格中允许的集合差异：

- ListPages-only：`deleted`、`forum`、`adult`、`wanderers-adult`
- sitemap-only：隐藏 `_` 前缀页

其它差异全部进入 `unexplained`。

`--live-listpages-batches 1..2` 仅用于本次真实小样本：它现场抓 ListPages 的头 1–2 批供页级三角，
但枚举轨强制 `partial`，明确写“只请求 N/总批数”，绝不拿局部集合与 sitemap 假装完成互校。

### 6.2 WhoRated vs rating

每页复用：

- `amcRequest()`
- `parseWhoRatedPage()`
- `gateParsedVotes()`
- `timeoutForVoteCount()`

同时精确要求：

```text
parsed entries.length == ListPages rating_votes
Σsign(parsed direction) == ListPages rating
```

本任务要求的核心比较是第二式，但保留第一式能发现“和碰巧相等、票数却丢行”的假通过。

### 6.3 修订列表 vs revisions

每页复用：

- `revisionRequestParams()`，因此保留 `perpage=99999999`
- `parseRevisionList()`，因此保留 pager 检测、中文 marker 和结构断言

精确要求：

```text
parsed entries.length == ListPages revisions
```

没有把 collector 层较宽松的 `entries.length >= claimed` 当作对账通过条件；采集完整性与跨模块
一致性是两件不同的事。

### 6.4 请求上限

`--triangle-pages` 范围是 1..15。最坏每页：

1. 未知身份时 1 个整页 GET；
2. 1 个 WhoRated AMC；
3. 1 个 RevisionList AMC。

加启动 AMC probe 后，15 页最坏 46 个 Wikidot 请求，仍小于 50。已存在 v2 身份时更少。

---

## 7. 报告持久化与 QQ 输出

### 7.1 新表

检查真实 `scpper-v2` 后确认原库没有 `meta.reconcile_report`，因此新增
`migrations/0014_reconcile.sql`。该迁移已实际应用到 `scpper-v2`。

主要列：

| 列 | 含义 |
|---|---|
| `run_id` | 对应本次 `meta.ingest_run` |
| `mode` | all / parity / crom / triangle |
| `status` | ok / partial / failed / aborted |
| `observed_at` / `finished_at` | 证据窗口 |
| `lag_window_seconds` | 状态滞后窗 |
| 三个 count | compared / difference / unexplained |
| `report` | 完整有界 JSON 报告 |
| `qq_summary` | qqbot 紧凑 JSON |

约束：

```text
0 <= unexplained_count <= difference_count <= compared_count
```

索引：

- 每个非空 `run_id` 只能有一份报告；
- `(mode, observed_at DESC)`；
- `(status, observed_at DESC)`。

迁移先检查当前库不属于：

- `scpper-cn`
- `scpper_cn`
- `scpper-syncer`
- `scpper_user`

实际权限复核：

```text
has_table_privilege(ingestor_role, meta.reconcile_report, SELECT) = true
has_table_privilege(ingestor_role, meta.reconcile_report, INSERT) = true
```

### 7.2 Prisma 映射

迁移后按仓库规定执行唯一入口：

```bash
./prisma/pull.sh
```

实际结果：

```text
schema.prisma is valid
Generated Prisma Client
model 数 = 非分区表数 = 86
分区子表未混入
无 db pull 默认丑关系名
```

本轮 introspection 同时吸收了并行落库的 `serve.chunk_embedding`；因此总数从历史 84 变为 86：
一张是该并行表，一张是本轮 `meta.reconcile_report`。

### 7.3 qqbot 单行契约

调用：

```bash
npm run reconcile:qq
```

或：

```bash
npm run reconcile -- --mode triangle --qq-summary
```

stdout 只有一行 JSON。实际最终输出：

```json
{"type":"scpper-parity","version":1,"at":"2026-07-27T14:08:20.039Z","mode":"triangle","ok":false,"status":"failed","compared":2,"differences":1,"unexplained":1,"alerts":["本轮仅请求 ListPages 前 1/145 批；只用于页级三角小样本，绝不据此声明 sitemap 枚举互校通过","三角独立模块不一致：votes=0, revisions=1"],"triangle":{"enumUnexplained":0,"votes":"1/1","revisions":"0/1"},"reportId":4}
```

该行可直接 `JSON.parse` 并转发。`type` 固定为 `scpper-parity`，便于 qqbot 路由。

---

## 8. CLI 行为

### 8.1 模式

| 模式 | 内容 |
|---|---|
| `all` | parity + CROM + triangle |
| `parity` | 只跑 v1/v2 三轨 |
| `crom` | 只跑 CROM 五项 |
| `triangle` | 只跑站内三角 |

默认是 `all`。缺 v1 连接时 `all/parity` fail-fast，不会跳过三轨后伪装成完成。

### 8.2 关键参数

| 参数 | 边界 |
|---|---|
| `--lag-minutes` | 60..1440 |
| `--triangle-pages` | 1..15 |
| `--live-listpages-batches` | 1..2，强制样本语义 |
| `--snapshot-max-age-hours` | 1..336 |
| `--crom-batch-size` | 1..1000 |
| `--crom-max-pages` | 只用于显式诊断，命中上限强制 partial |
| `--concurrency` | 1..4 |

### 8.3 失败语义

- `ok` → exit 0
- `partial/failed/aborted` → exit 1
- 断路器打开 → `aborted`
- 即使子模块失败，也尽力把失败报告写入 `meta.reconcile_report`
- `finishIngestRun(..., evaluateParseHealth:false)`，避免把对账结果误混进采集解析健康基线

---

## 9. psql 实际签名核对

按要求没有根据迁移文件猜函数签名，而是从真实 `scpper-v2` 的 `pg_proc` 查询
`pg_get_function_identity_arguments()`。当前实际九个 `ingest.apply_*`：

```text
ingest.apply_attribution_snapshot(
  p_page integer, p_entries jsonb, p_is_complete boolean,
  p_observed timestamptz, p_source text, p_run bigint, p_wikidot_id integer
) -> jsonb

ingest.apply_forum_batch(
  p_categories jsonb, p_threads jsonb, p_posts jsonb,
  p_observed timestamptz, p_source text, p_run bigint
) -> jsonb

ingest.apply_page_life(
  p_page integer, p_kind text, p_occurred timestamptz, p_precision text,
  p_observed timestamptz, p_source text, p_run bigint,
  p_wikidot_id integer, p_min_coverage real
) -> bigint

ingest.apply_page_meta(
  p_page integer, p_attrs jsonb, p_observed timestamptz,
  p_source text, p_run bigint, p_wikidot_id integer
) -> jsonb

ingest.apply_revision_batch(
  p_page integer, p_revisions jsonb, p_claimed_total integer,
  p_observed timestamptz, p_source text, p_run bigint, p_wikidot_id integer
) -> jsonb

ingest.apply_vote_cas_batch(
  p_page integer, p_targets jsonb, p_observed timestamptz,
  p_source text, p_run bigint
) -> jsonb

ingest.apply_vote_history(
  p_page integer, p_records jsonb, p_claimed_vote_count integer,
  p_observed timestamptz, p_source text, p_run bigint, p_wikidot_id integer
) -> jsonb

ingest.apply_vote_observation(
  p_page integer, p_voter integer, p_direction integer,
  p_occurred timestamptz, p_observed timestamptz, p_precision text,
  p_source text, p_run bigint, p_wikidot_id integer
) -> bigint

ingest.apply_vote_snapshot(
  p_page integer, p_entries jsonb, p_is_complete boolean,
  p_claimed_total integer, p_claimed_rating integer, p_visible_kinds text[],
  p_observed timestamptz, p_source text, p_run bigint, p_wikidot_id integer,
  p_absence_policy text, p_max_absence integer, p_max_absence_ratio real
) -> jsonb
```

M10 是只读对账，不调用任何 `apply_*`，也不直写 ingest/serve；这里只核对真实边界，防止以后
把对账修复动作误接成猜出来的函数调用。

---

## 10. 自动化测试

### 10.1 M10 专项

最终专项：

```text
tests 14
pass 14
fail 0
skipped 0
```

覆盖：

1. CROM 合法空 connection 与 WAF/非法 JSON 可区分；
2. `hasNextPage=true` 但空 edges/cursor 明确失败；
3. 六个廉价字段的严格解析；
4. CROM `maxPages` 下推到 GraphQL `first`；
5. sitemap/ListPages 已知差异可解释；
6. 未知集合差异不被吞掉；
7. tags 集合语义与 60 分钟窗口；
8. voter checksum 未解释差异失败；
9. 白名单稳定不增长、冻结 checksum 改变；
10. 上海日历连续 7 日与七日总状态门；
11. CROM 最近变更页 raw/actionable 分离；
12. 页级失败目标不从 `Map` 消失；
13. 证据完整但三角数值不一致也必须失败；
14. QQ JSON 不含换行。

这满足“解析类模块必须有空结果与解析失败可区分的负向用例”。

### 10.2 TypeScript

最终执行：

```bash
npx tsc --noEmit
npx tsc -p tsconfig.tests.json
```

两者均为 exit 0。

### 10.3 全量回归

在最终收紧边界前后分别跑过全量和专项；最终全量基线：

```text
tests 208
suites 45
pass 208
fail 0
cancelled 0
skipped 0
duration_ms 30324.797729
```

最终七日门改动后又执行 `npx tsc --noEmit`、测试类型检查和 M10 14/14 专项，均通过。

---

## 11. 真实生产小样本

### 11.1 总请求预算

本轮真实外部请求总计：

| 运行 | Wikidot | CROM | 结果 |
|---|---:|---:|---|
| 三页站内三角 | 11 | 0 | 11/11 HTTP 200，零重试 |
| 三页 CROM 诊断 | 0 | 1 | 1/1 HTTP 200，直连，零重试 |
| 一页最终站内三角 | 5 | 0 | 5/5 HTTP 200，零重试 |
| **合计** | **16** | **1** | **17 < 50** |

parity 运行只查询数据库，不产生 HTTP 请求。

真实 Wikidot client 日志确认：

```text
proxy=http://127.0.0.1:7891
userAgent=scpper-cn-syncer2/0.1 (...)
referer=https://scp-wiki-cn.wikidot.com/
AMC POST 探针通过，categories=42
```

### 11.2 最终一页三角

命令：

```bash
npm run -s reconcile -- \
  --mode triangle \
  --live-listpages-batches 1 \
  --triangle-pages 1 \
  --qq-summary \
  --proxy-check warn
```

实际 stdout：

```json
{"type":"scpper-parity","version":1,"at":"2026-07-27T14:08:20.039Z","mode":"triangle","ok":false,"status":"failed","compared":2,"differences":1,"unexplained":1,"alerts":["本轮仅请求 ListPages 前 1/145 批；只用于页级三角小样本，绝不据此声明 sitemap 枚举互校通过","三角独立模块不一致：votes=0, revisions=1"],"triangle":{"enumUnexplained":0,"votes":"1/1","revisions":"0/1"},"reportId":4}
```

持久化的页级证据：

```json
{
  "fullname": "scp-cn-3584",
  "wikidotId": 1468996926,
  "identitySource": "page_get",
  "votes": {
    "status": "ok",
    "claimed": 128,
    "fetched": 128,
    "actual": 128,
    "delta": 0
  },
  "revisions": {
    "status": "partial",
    "claimed": 6,
    "fetched": 7,
    "actual": 7,
    "delta": 1,
    "error": "RevisionList 行数 7 ≠ ListPages %%revisions%% 6"
  }
}
```

HTTP 证据：

```json
{
  "requests": 5,
  "attempts": 5,
  "retries": 0,
  "statusBuckets": {"200": 5},
  "breakerOpen": false,
  "wireBytes": 54089,
  "decodedBytes": 308565,
  "direct": false
}
```

### 11.3 三页三角复核

三页真实结果：

| 页面 | rating claimed/actual | votes fetched | revisions claimed/actual |
|---|---:|---:|---:|
| `scp-cn-3584` | 128 / 128 | 128 | 6 / 7 |
| `xiugou-author-page` | 35 / 35 | 37 | 25 / 26 |
| `scp-cn-4710` | 0 / 0 | 0 | 1 / 2 |

注意 `xiugou-author-page` 的 WhoRated 可见行是 37，但两条 direction=0，因此：

```text
Σsign(direction)=35
ListPages %%rating%%=35
```

这是为什么规格要求比较 `Σsign`，而不是拿可见行数代替 rating。

三页修订全部稳定为：

```text
RevisionList rows = ListPages %%revisions%% + 1
```

实现没有硬编码 `-1`，因为权威规格写的是精确行数互校；当前把它保留为真实未解释差异。

### 11.4 CROM 小样本

命令：

```bash
npm run -s reconcile -- \
  --mode crom \
  --crom-batch-size 3 \
  --crom-max-pages 3 \
  --qq-summary
```

实际 stdout：

```json
{"type":"scpper-parity","version":1,"at":"2026-07-27T14:04:30.908Z","mode":"crom","ok":false,"status":"partial","compared":121,"differences":121,"unexplained":121,"alerts":["小样本上限 3 页，未走完 CROM 游标","CROM/v2 存在性差异：CROM-only=3, v2-only=118"],"crom":{"full":false,"cromPages":3,"v2Pages":118,"existenceDiffs":121,"fieldDiffs":0},"reportId":2}
```

该结果只证明直连、查询、解析、比较和落库链路可用。它不能用于判断全站 parity，因为显式样本
只含 CROM 3 页，而 v2 集合含 118 页；代码按设计把它保持为 `partial`。

### 11.5 三轨真实运行

命令使用 backend 的 v1 `DATABASE_URL` 作为 `SYNCER2_V1_DATABASE_URL`，但实际每组查询都在
`BEGIN READ ONLY` 事务中运行。

实际 stdout：

```json
{"type":"scpper-parity","version":1,"at":"2026-07-27T14:05:10.300Z","mode":"parity","ok":false,"status":"failed","compared":35951,"differences":35947,"unexplained":35947,"alerts":["状态对齐 diff 100.0000% 未低于 0.1%","状态对齐有 35947 页未解释差异","白名单轨首次建立基线；需下一日验证“稳定不增长”","冻结轨首次建立已删页 vote_current checksum"],"parity":{"stateDiffRate":1,"unexplainedPages":35947,"streakDays":0,"sevenDayGatePassed":false,"whitelistGrowth":0,"frozenChanged":false},"reportId":3}
```

详细状态：

```text
v1Pages=36057
v2Pages=118
lagExcludedPages=110
comparablePages=35947
pagesWithDifferences=35947
unexplainedPages=35947
```

字段差异：

```json
{
  "existence": 35939,
  "title": 8,
  "rating": 6,
  "tags": 7,
  "vote_state": 6
}
```

报告差异样本上限为 100；总量由 counts 保存，避免一次回填前运行把数万页完整值塞进 meta。

---

## 12. 关键发现

### 12.1 修订数存在稳定 +1

最重要的新实测是：

```text
3/3 页：RevisionList rows = ListPages %%revisions%% + 1
```

三个样本规模不同（1、6、25），但差值均为 1。高度疑似 ListPages 的 `%%revisions%%` 不计
“创建新页面”初始行，而 RevisionList 会显示该行；不过这是推断，不是规格给定事实。

处置：

- 当前不做 `rows-1`；
- 报告保留 claimed、actual、delta 和页面样本；
- 总状态判 `failed`；
- 等扩大样本或规格明确口径后再决定是否把“创建行 +1”升级为有证据的白名单规则。

### 12.2 v2 当前不具备 parity 放行条件

真实运行时：

```text
v1 live=36,057
v2 live=118
```

因此 99% 以上差异是回填尚未完成导致的存在性缺口。对账实现正确判红；这不是应该加入 allowlist
的噪音，也不能通过放宽 0.1% 阈值解决。

### 12.3 完整 ListPages 快照尚缺

当前 state 目录有 sitemap 快照，但没有完整 `listpages-tier1.snapshot.json.gz`。因此默认
`triangle`/`all` 的枚举轨会明确失败。真实交付样本使用显式 live 单批模式，只验证页级三角，
枚举轨保持非通过状态。

---

## 13. 偏离、取舍与理由

### 13.1 没有在交付验收中执行 CROM 36k 全量

实现默认路径确实是全量，不是抽样；但本次交付硬要求真实生产样本总请求不超过 50。
CROM 全量按每批 100 页约需 360 次请求，与验收预算冲突。因此只跑了显式 3 页诊断，
并由代码强制标成 `partial`。

这只是验收运行的偏离，不是实现偏离。调度环境应不传 `--crom-max-pages`。

### 13.2 枚举互校使用独立完整快照

没有在每日 M10 进程中重新发约 145 个 ListPages 请求和全部 sitemap 请求，而是读取两个采集器
各自留下的完整原子快照。这样既保留“两个独立站点子系统”的证据来源，也避免对账任务复制采集层。

快照新鲜度、完整轮标记、结构和非空均有硬断言。若运维要求“同一分钟现抓”，可另行调度完整
ListPages 与 sitemap 轮后立即运行 M10，无需改 M10。

### 13.3 没有直接发送 QQ 消息

本任务明确要求“提供一个可被 qqbot 调用的单行 JSON 摘要输出”，已完成该接口。
当前仓库范围内没有授权的 QQ 发送动作或 bot 调度配置，本轮没有越权发送消息。

仍需运维把：

```bash
npm run reconcile:qq
```

接入现有 qqbot 定时链路。若只生成 SQL 报告而不调用该命令，仍会重演规格 §3.5 指出的无人查看问题。

### 13.4 没有把修订 +1 静默白名单化

这是有意不偏离规格。现有 3 页样本不足以把推断写成全站规则，尤其还需确认特殊页、空修订页、
删除恢复页和早期历史页。当前宁可告警，也不把未知偏差伪装成已解释。

---

## 14. 遇到的坑

1. **实库缺 `meta.reconcile_report`**  
   规格要求落此表，但 0001–0013 的真实库没有。新增 0014，并同时更新 Prisma 映射。

2. **首次 Prisma introspection 同时看到并行新增表**  
   表数不是预期的 85，而是 86；核对后另一张是并行落库的 `serve.chunk_embedding`。
   没有手工删掉该映射，而是遵守 `pull.sh` 的真实库一对一自检。

3. **CROM 小样本若只在返回后截断，会多抓一整批**  
   最终把剩余额度下推到 GraphQL `first`，并增加测试。

4. **CROM 塌缩告警最初未进入 differences**  
   这可能构成 `unexplained > differences`，被数据库 CHECK 拒绝。最终把塌缩/空值率告警作为
   真实 difference 计数，并写中文注释解释原因。

5. **冻结集合从 1 行缩成 0 行的计数边界**  
   若 `compared=current.count=0` 但 `differences=1`，也会违反 CHECK。最终分母取 current、
   previous 与最小 1 的最大值。

6. **单日绿不等于三轨通过**  
   最终复核发现仅计算了 streak 但尚未把它接到总状态。已增加七日门：
   1–6 天强制 `partial`，7 天才允许 `ok`，并补专项断言。

7. **三角“完整但不相等”不能只叫 partial 总状态**  
   页级 subcheck 仍用 partial 表达“解析完整但数值不一致”，但聚合验证状态现已改为 `failed`。

---

## 15. 剩余问题与上线前清单

### 15.1 需要完成，但不阻塞本模块代码交付

1. 完成 v2 主体回填，使存在性差从 35,939 页收敛；
2. 生成一次完整 ListPages snapshot；
3. 默认参数执行一次全量 CROM 金丝雀；
4. 扩大修订三角样本，确认 `+1` 是否对所有页面成立以及是否确实来自创建行；
5. 接入 qqbot 定时推送；
6. 在数据齐全后连续运行 7 个上海日，观察 `<0.1%` 门；
7. 只对逐项确认过的差异写 `reconcile.allow.*`，并带 reason/expiry。

### 15.2 没有阻塞项

- 编译：无阻塞；
- 测试：无阻塞；
- v2 表与权限：已落地；
- CROM 直连：已验证；
- Wikidot proxy/UA/Referer：已验证；
- QQ 机器可读摘要：已验证；
- Git commit/push：按要求未执行。

当前红色报告属于真实数据/暖机状态，不是隐藏的代码异常。

---

## 16. 推荐调度

数据回填和完整快照就绪后：

```bash
# 先保证当日完整 sitemap 与 ListPages 采集已结束
# 然后运行全量 M10；不传任何 max/sample 参数
SYNCER2_V1_DATABASE_URL='postgresql://.../scpper-cn' npm run reconcile:qq
```

调度器应：

- 捕获 stdout 最后一行并交给 qqbot；
- 保留 stderr；
- exit 1 时主动告警；
- 不自动加 `--crom-max-pages`；
- 不自动加 `--live-listpages-batches`；
- 不把首日/暖机期的 `partial` 当成功；
- 不因 report 已写 SQL 就省略 QQ 推送。

v1 退役后可只运行 `crom+triangle` 或新增明确模式组合；站内三角本身不依赖 v1/CROM，
仍是主力。不要删除 parity 历史报告，它们是 7 日门、白名单稳定性和冻结 checksum 的基线。
