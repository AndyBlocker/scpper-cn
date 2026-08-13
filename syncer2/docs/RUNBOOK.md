# syncer2 运行手册

本文覆盖 v2 采集层的冷启动、日常增量、定时调度和故障排查。所有采集器都是
**单次短进程**：启动、完成一轮、退出；定时器负责下一轮。不要把 CLI 包进常驻
`while`，也不要用进程退出后的延迟重启。

## 1. 上线前检查

在 `syncer2/` 下准备 `.env`，至少确认：

- `SYNCER2_DATABASE_URL` 只指向 `scpper-v2`；
- `SYNCER2_SITE_BASE_URL`、User-Agent、Referer 与代理配置正确；
- 生产调度不使用 `--skip-tz-check`；
- 写闸全部为 `effective=false`。

```bash
set -a
source .env
psql "$SYNCER2_DATABASE_URL" -Atc \
  "select current_database(); select * from meta.write_freeze_status();"
npm run typecheck
npm run typecheck:tests
```

AMC 通道上线前可单独探测。探测失败时不应继续采集：

```bash
npm run work:queue:probe -- --amc-probe require --proxy-check require
```

## 2. 冷启动

### 2.0 v1 迁移的顺序硬约束

**v1 历史回填必须发生在首次爬取之前。** 对生产迁移库，顺序固定为：

```text
清理无价值的演练数据
→ S1 身份回填（保留 v1 Page.id / User.id）
→ S1 strict gate
→ S2–S6 历史回填与各阶段 gate
→ 首次 sitemap / resolve-pages / Tier1 / work-queue
```

原因：首次爬取会由 `register_page` / `ensure_user` 铸造新 id。若先爬再回填，同一个
`wikidot_id` 已占用另一个 v2 id，而 v1 原 id 又可能被演练身份占用；此时无法同时满足
“`id` 永不重排”和“同一 Wikidot 身份只保留一行”。其中 Page.id 还是
`scpper_user.GachaCardDefinition.pageId` 的跨库软外键，错位会让收藏卡指向错误页面。
先回填后爬取时，采集器按 `wikidot_id` 命中既有行并复用原 id，才是无损路径。

`sitemap` 本身虽只做发现，也会产生 `pending_page`；随后的 `resolve-pages` 会立即铸身份，
所以整个首次爬取链都必须排在回填之后。不要把 WIRE 演练形成的 pages/users 当成可合并
基线；只有在确认演练数据无保留价值并已留快照时才允许清空，正式爬取数据不得照此处理。

S1 的阶段验收使用 strict scope，gacha 身份集是必需输入，缺失会硬失败：

```bash
export V1_DATABASE_URL=...       # scpper-cn；loader 与 S1 都强制源连接只读
export USER_DATABASE_URL=...     # scpper_user；A3.1 必需
npm run backfill:s1
./checks/load_v1_identity.sh
psql "$SYNCER2_DATABASE_URL" -v gate_scope=s1 -f checks/backfill_finalize.sql
```

只有 `scope=s1` 全绿后才继续 S2；S2–S6 全部完成后，仍须不带 `gate_scope`
再跑一次完整 strict `backfill_finalize.sql`。`scope=s1` 不检查尚未回填的
`serve.page_current` / `page_life_event`，不能冒充全量迁移验收。

### 2.0.1 批量回填后的 L1 投影重建

`migration_role` 批量装载事实会绕过 `apply_vote_*`、`apply_revision_batch` 和
`apply_attributions`，因此也绕过这些函数对 `serve.page_current` 的同事务维护。
**批量回填完成不等于 Tier-1 投影已完成**；S2–S6 全部落库后、finalize/smoke 之前，
必须显式执行：

```bash
psql "$SYNCER2_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f checks/backfill_rebuild_l1.sql
```

脚本从 `serve.vote_current` 重建 `rating/vote_up/vote_down/vote_revoked`，从
`ingest.revision` 直接 `COUNT(*)` 重建 `revision_count`，从
`serve.attribution_current` 重建 `attribution_count`，并在提交前检查投票/署名孤儿、
票终态主键冲突、`source_sha` 与最新 `page_source` 一致性。修订编号从 0 开始，但这里
计算的是本地事实行数，**不得加 `REVISION_COUNT_OFFSET`**；offset 只用于比较远端
零基声明值与本地修订列表行数。

`comment_count` 是远端页面元数据声明值，不是本地 `forum_post` 行数；两者差异是论坛
采集完整度信号，禁止用后者反写前者。`search_text` 是页面观测时提取的文本；相同源码
SHA 可以复用 canonical `content_blob`，所以也禁止用 `content_blob.text_content`
无条件覆盖非空的 `page_current.search_text`。脚本对这两列只做语义审计。

### 2.0.2 活库窗口的 identity top-up

`scpper-cn` 在回填窗口内仍由 CROM 持续同步，所以首次 S1 之后身份集合会继续增长。
**v1 不冻结，除非用户另行明确下令。** 因此初次 S1 完成后，每次进入任一后续回填
阶段（S2/S3/S4/S5/S6）、任何回填修复事务，以及最终 finalize 前，都必须先做一次
只补缺行的 identity top-up。这是阶段入口的标准步骤，不是 S3 特例：回填面对的是
移动靶，上一阶段刚通过只证明上一份快照。

top-up 保留 v1 id、拒绝 id/wikidot_id 冲突；v2 自铸 page/user 则由 0204 从具名保留
高位段分配，不再使用“当前 v1 上界 + 1”。命令可重复执行，第二次应报告
`missing.pages=0`、`missing.users=0`：

```bash
export V1_DATABASE_URL=...       # scpper-cn；startup packet 强制只读
npm run backfill:s1:top-up:dry
npm run backfill:s1:top-up       # 这是身份增量，不执行 S3 投票事实回填
```

每个需要跨库 gate 的阶段，在 top-up 后还要立即重载 identity 证据，再跑对应 strict
gate；不得拿旧 `meta.v1_identity_load.loaded_at` 证明新快照：

```bash
./checks/load_v1_identity.sh
psql "$SYNCER2_DATABASE_URL" -v gate_scope=s1 -f checks/backfill_finalize.sql
```

最终 S3/S4/finalize 也原样执行这套入口步骤。只要 v1 仍在线，就不存在“一次性的收尾
top-up”，也不得把“让 v1 停止增长”当成 gate 通过的前置条件。

### 2.1 正式全量

以下命令只允许在 v1 历史回填及其阶段 gate 完成后执行。爬取链内部顺序也不能颠倒：
sitemap 先给出枚举基准；未知 slug 再按 `wikidot_id` 命中已回填身份并复用原 id；
Tier1 再写评分、标签等信号并产生深扫任务；最后由 work-queue 消费。

```bash
# 1. 全量 sitemap；full 默认 page-scan=all。
npm run sitemap:full -- --page-scan all --proxy-check warn

# 2. 分批解析 pending_page。每页一次 GET；只在首次冷启动使用 force-cold-start。
npm run resolve:pages -- \
  --limit 50 --concurrency 2 --force-cold-start \
  --amc-probe skip --proxy-check warn

# 重复上一步，直到 pending 为 0 或只剩处于退避期的失败页。
psql "$SYNCER2_DATABASE_URL" -Atc \
  "select count(*) from meta.pending_page where resolved_at is null;"

# 3. 完整 Tier1。不要用 max-batches 代替正式全量；
# max-batches 永远是 partial，不会应用事实或授权删除推断。
npm run tier1 -- --concurrency 5 --amc-probe require --proxy-check warn

# 4. 消费全部 11 种任务。单轮硬上限 50，重复到 runnable 队列排空。
npm run work:queue -- \
  --concurrency 4 --amc-probe require --proxy-check warn
```

`work-queue` 的完整 handler 表是：

```text
confirm_deleted,new_page_highfreq,votes_full,meta,sitemap_delta,
content,revisions_full,files,forum,discussion,attributions
```

默认消费时会顺带补三类周期任务：7 天内新页的 3 小时高频票扫描、90 天内活跃页的
7 天投票 sweep、以及每 24 小时一次的 M6 约定页刷新。约定页是全站任务，在
`scan_task` 中绑定一个 live 页作为审计锚点；成功的 `page_scan(kind=attributions)`
会阻止 24 小时内重复入队。已有失败任务冲突时只合并 `reasons/priority`，不会重置
`attempts`、`stable_count`、`not_before` 或锁。

### 2.2 150 页以内的受控演练

下面用 110 页验证真实链路。`--range offset:limit` 的 limit 最大 150，offset 必须是
limit 的整数倍。范围扫描可以安全应用该范围内的正向事实，但不构成全站删除证据。

```bash
# 枚举基准。
npm run sitemap:full -- --page-scan all --proxy-check warn

# 首次 Tier1 产生 pending_page。
npm run tier1 -- \
  --range 0:110 --seed-votes 110 --seed-deep 5 \
  --amc-probe require --proxy-check warn

# 解析这 110 页身份。
npm run resolve:pages -- \
  --limit 110 --concurrency 4 --force-cold-start \
  --amc-probe skip --proxy-check warn

# 相同范围再扫一次：110 页投票任务；前 5 页再加 content/revisions/meta。
npm run tier1 -- \
  --range 0:110 --seed-votes 110 --seed-deep 5 \
  --amc-probe require --proxy-check warn

# 50 + 50 + 10 页投票。
node --import tsx/esm src/cli/work-queue.ts \
  --kinds votes_full --limit 50 --concurrency 4 --no-seed
node --import tsx/esm src/cli/work-queue.ts \
  --kinds votes_full --limit 50 --concurrency 4 --no-seed
node --import tsx/esm src/cli/work-queue.ts \
  --kinds votes_full --limit 10 --concurrency 4 --no-seed

# 前 5 页的 content/revisions/meta，共 15 个任务。
node --import tsx/esm src/cli/work-queue.ts \
  --kinds content,revisions_full,meta --limit 15 --concurrency 4 --no-seed
```

幂等复验时，原样重跑第二个 Tier1 range，再执行同样的三轮 votes 和一轮深扫。
对两次 run 分别执行第 5 节的 SQL；第二次 `ingest.vote_event` 新增应为 0，或仅有
演练期间真实发生的少数投票。不要用删除事件或修正事件把 Tier1 聚合数“凑平”。

按每次 CLI 的末行 JSON 统计 `http.requests` 和 `http.attempts`。110 页方案包含完整
首轮与重放时，逻辑请求预算约 389；网络重试也必须计入共享 IP 池预算。

### 2.3 全站 CAS 验收重放

110 页 range 只能证明局部幂等。冷启动签收前，以一轮完整、成功且
`snapshotAdvanced=true` 的 Tier1 为声明基准，直接重放其全部 live 页：

```bash
npm run votes:replay -- \
  --tier1-run <完整 Tier1 run id> --concurrency 4 \
  --amc-probe require --proxy-check warn
```

该命令不创建、认领或修改 `meta.scan_task`，因此不会为了验收重置真实 partial 的
退避。每页仍走原四重门控和 CAS；checksum/完整性不过的页写 `partial` 并单列，
绝不授权 absence/revoke。用该 replay run 的 `ingest.vote_event` 逐条归因；零事件，
或只有执行窗口内由前后 Tier1/远端证据确认的真实新票，才算通过。

## 3. 日常增量

日常新鲜度按以下四层运行。L0 与 L1 必须同频，先以 30 分钟上线；观察一周遥测后可
一起收紧到 15 分钟。

| 层 | 周期 | Wikidot 请求 | 职责 | `population_type` |
|---|---:|---:|---|---|
| L0 `schedule:l0` | 30 min（可配 15） | 1–3 | `ListPages updated_at="last 2 hours"`；编辑即 revision，派生 content/revisions_full，新页再派生 meta | `l0_updated_at_window` |
| L1 `schedule:l1` | 与 L0 同频 | 约 145 | 四字段 `fullname/rating/rating_votes/revisions` 全站扫描；rating 或票数变化入 `votes_full`，禁止早停 | `l1_full_site_minimal` |
| L2 `schedule:l2` | 60 min | 1–5 | full sitemap；只做 absence 基准和第二枚举源 | `l2_sitemap_absence` |
| L3 `schedule:l3` | 每周日/按需 | 约 145 | 全字段 Tier1 兜底对账 | `l3_full_site_tier1` |

L0 的两小时窗口对 30 分钟周期是 4 倍、对 15 分钟周期是 8 倍重叠。源码、标签、标题、
附件、改名和新建都会创建 revision 并推进 `updated_at`，因此这一层承担 **100% 社区内容
编辑发现**。`module_body` 带 `revisions`；重叠行以修订数去重，修订不变但 `updated_at`
前进会写异常信号并告警。

投票不创建 revision，也不推进 `updated_at`，没有服务端增量过滤可用。L1 必须按首批
pager 给出的 `1..N` 全部批次扫描；禁止增加 max-batches、lastmod/revision 阈值或任何
“翻到某处就停”的分支。sitemap 上浮与投票活动的相关性假设已废弃。

每层各写一条 `meta.ingest_run`，`stats.layer/mode/population_type` 必须齐全。PHFIX
解析健康基线只能读取相同 `(source, mode, population_type, metric)` 的前 7 日样本，
不得跨层借用。

### 3.1 L0↔L1 内容覆盖持续证明

L1 同批的 `revisions` 与上一轮全站快照 diff，再检查 L0 状态是否已看到相同或更高修订数。
结果持续写 `meta.revision_coverage_metric`：

- `l1_revision_changes`：本轮 L1 发现的修订变化页；
- `l0_captured_changes` / `l0_missed_changes`：L0 命中与漏捕获；
- `coverage_rate` / `rolling_7d_coverage`：单轮和按变化页加权的 7 日覆盖率；
- `sample_missed_slugs`：最多 100 个漏捕获样本。

`l0_missed_changes > 0` 必须立即告警；L1 同时把漏页补入 content/revisions_full，告警
不能代替修复。这张表是“100% 覆盖”的持续证明，不是一次性断言。

每个成功、非 dry-run 的 L1 run 必须恰好有一条以 `l1_run_id` 为主键的指标行。没有上一轮
L1、相邻 L1 间隔超过 `1.75 × frequencyMinutes`，或比较窗口任一端缺少足够近的成功 L0
时，该行标为 `is_baseline_init=true` 并填写 `baseline_init_reason`。这种行保留当轮
`coverage_rate`、miss 样本和窗口用于审计，但分子/分母不进入 rolling，也不触发覆盖告警；
它表达的是“重新建立可比较基线”，不是“已证明 L0 漏抓”。后续连续窗口恢复后必须重新
得到普通指标行。成功 L1 没有指标行属于持久化故障，不能按“本轮无修订变化”解释。

比较窗口与 `all/page/content/revision` 写冻结有时间重叠时同样标为 baseline init，
`baseline_init_reason` 形如 `write_freeze_overlap:all`。冻结期间留下的 apparent miss
是写入级联证据，不得进入 rolling 或制造 L0 漏抓告警；释放后的首个跨界窗口也按此处理。

### 3.2 请求预算

不含按真实变化量触发的深扫、网络重试和可选出口探针，固定发现/安全网预算为：

| 项 | 计算 | 请求/日 |
|---|---:|---:|
| L0（30m / 15m） | 48/96 轮 × 1–3 | 约 50–150 / 约 200 |
| L1（30m） | 48 × 145 | 6,960 |
| L1（15m） | 96 × 145 | 13,920 |
| L2 + L3（日均） | hourly sitemap + weekly Tier1 | 约 50 |
| 空队列 AMC 健康探针 | 最多 1,440 轮 × 1 | 最多 1,440 |
| **合计（30m / 15m）** |  | **约 8,600 / 15,600** |

空队列时 work-queue 每轮仍会在 claim 前做 1 次必需 AMC 探针；该固定流量必须计入，
不能只按实际深扫页数报预算。平均约 0.10–0.18 QPS，仍远低于峰值 QPS < 2 的既有
预算。先跑 30 分钟一周，再根据
传输失败率、work queue backlog 和覆盖指标决定是否改 15 分钟。

其它任务节奏：

| 周期 | 任务 | 用途 |
|---|---|---|
| 每 1 分钟（上轮退出后） | `schedule:work-queue` | 每轮最多 50；消费分层信号并补周期任务 |
| 每 5 分钟 | `schedule:resolve-pages` | 解析 L0/L1 新发现 slug；不加 `--force-cold-start` |
| 每 5 分钟 | `schedule:oldest-pending` | 纯数据库采样全部待处理集合，持久化极值、趋势与告警 episode |
| 每日 | `schedule:forum-discovery` / `schedule:forum-consume` | 论坛差集与成员刷新 |
| 每日 | `schedule:reconcile` | M10 三角 + CROM 金丝雀；v1 只读 |
| 每小时 | `schedule:page-scan-maintenance` | 固化 run 聚合与保留策略 |

`forum-scan` 保留作定向诊断（`--page-id` / `--thread-id` / `--category-id`）；
常规页级 `forum/discussion` 已由统一 work-queue 消费，不需要再安排第二个页级消费者。

任务状态机的运维约束：

- 成功删除任务；
- `partial/failed` 保留任务并按 `1h → 4h → 24h → 7d` 退避；
- 发现侧 upsert 只能合并 reasons/priority，不能覆盖执行状态；
- 带稳定 `result_hash` 的确定性矛盾连续 3 次不变时，写入 `meta.irreconcilable`，保存
  终态哈希并从 `meta.scan_task` 真正删除；所有发现入口都必须拒绝把未解决终态重新入队；
- `meta.irreconcilable` 是独立终态复查队列：常态 7 天复查一次；同哈希只更新
  `last_checked/checks/next_review_at` 并保持终态，新哈希才关闭旧终态并以
  `stable_count=1` 重建常规任务；复查遇临时失败只在终态表退避；
- 连续 5 页失败或 HTTP 断路器打开时，本轮非零退出，未完成锁会释放；
- `votes_full/new_page_highfreq` 没有成功 L1/L3 的远端 rating/vote claim 时不得认领，
  保持 pending 等下一轮 L1；不得先增加 attempts/退避，更不得用本地聚合补 claimed 值；
- 不要清空或重建 `meta.scan_task`。

## 4. CLI 参数速查

### incremental-scan

- `--layer l0|l1`：必填；L2 使用 `sitemap-scan --mode full`，L3 使用 `tier1-scan`；
- `--window-hours N`：仅 L0；正式默认由 `SYNCER2_L0_WINDOW_HOURS=2` 提供；
- `--concurrency 1..5`：L0 正式 3、L1 正式 5；
- `--dry-run`：不写库、不推进状态或覆盖指标；
- `--amc-probe require|warn|skip`；正式 L0/L1 设 `skip`，业务请求本身就是 AMC 契约检查；
- `--proxy-check require|warn|skip`。

Wikidot 在 L0 窗口只有 0–249 行时不渲染 pager：此时只允许 L0 以单批完整结束；零行
还必须保留结构化 `list-pages-box`，WAF/错误 HTML 不得伪装成空窗口。L1 使用显式
offset；每个非首批 pager 的实测语义是“剩余集合的 `page 1 of N`”，校验必须按
`1/(总批数-当前批号+1)` 递减，同时仍要求全翻、非末批 250 行和跨批无重复。

### sitemap-scan

- `--mode delta|full|threads|category|index`：必填；
- `--page-scan none|changed|all`：delta 默认 changed，full 默认 all；
- `--concurrency N`：sitemap GET 并发；
- `--emit-entries FILE`：输出 NDJSON；
- `--dry-run`：不写库、不推进快照；
- `--amc-probe require|warn|skip`、`--proxy-check require|warn|skip`。

### tier1-scan

- `--concurrency 1..5`；
- `--range OFFSET:LIMIT`：有界真实范围，`LIMIT <= 150`；
- `--seed-votes N`：range 中前 N 个已解析页入队 votes；
- `--seed-deep N`：range 中前 N 页入队 votes/content/revisions/meta；
- `--max-batches 1..49`：仅诊断，结果明确为 partial；
- `--dry-run`：不写库，使用独立快照；
- `--amc-probe`、`--proxy-check`。

### resolve-pages

- `--limit N`、`--concurrency N`；
- `--force-cold-start`：只用于首次大 backlog；
- `--dry-run`；
- `--amc-probe`（本通道默认 skip）、`--proxy-check`。

### work-queue

- `--limit N`：单轮硬上限 50；
- `--concurrency 1..5`；
- `--kinds CSV`：在加锁前过滤，不会认领后跳过；
- `--no-seed`：不补投票 sweep、新页高频和约定页周期任务；
- `--probe-only`；
- `--amc-probe`（默认 require）、`--proxy-check`。

### forum-scan（诊断）

- `--limit N`：硬上限 50；
- `--page-id ID`、`--thread-id ID`、`--category-id ID`；
- `--concurrency 1..5`、`--probe-only`、`--amc-probe`、`--proxy-check`。

所有 CLI 的 `--skip-tz-check` 仅限本地诊断，禁止写入正式调度。

## 5. 验收 SQL

最近运行及失败批次：

```sql
SELECT id, source, status, started_at, finished_at,
       pages_enumerated, remote_total, coverage_ratio,
       batches_total, batches_failed, transport_failure_rate,
       stats->'http' AS http
FROM meta.ingest_run
ORDER BY id DESC
LIMIT 30;
```

四层登记与解析健康分层：

```sql
SELECT id, stats->>'layer' AS layer, stats->>'mode' AS mode,
       stats->>'population_type' AS population_type,
       status, started_at, batches_total, batches_failed
FROM meta.ingest_run
WHERE stats ? 'layer'
ORDER BY id DESC
LIMIT 40;
```

L0/L1 修订覆盖持续证明：

```sql
SELECT l1_run_id, window_started_at, window_ended_at,
       is_baseline_init, baseline_init_reason,
       l1_revision_changes, l0_captured_changes, l0_missed_changes,
       coverage_rate, rolling_7d_changes, rolling_7d_coverage,
       sample_missed_slugs
FROM meta.revision_coverage_metric
ORDER BY measured_at DESC
LIMIT 30;

-- 期望 0 行：每个成功、非 dry-run 的 L1 都必须写指标。
SELECT ir.id, ir.started_at, ir.finished_at
FROM meta.ingest_run ir
LEFT JOIN meta.revision_coverage_metric m ON m.l1_run_id = ir.id
WHERE ir.source = 'wikidot_listpages'
  AND ir.stats->>'layer' = 'L1'
  AND ir.status = 'ok'
  AND COALESCE((ir.stats->>'dryRun')::boolean, false) IS FALSE
  AND m.l1_run_id IS NULL
ORDER BY ir.id DESC;
```

逐页证据和待重试任务：

```sql
SELECT run_id, kind, status, count(*) AS pages,
       count(*) FILTER (WHERE claimed_total IS NOT NULL) AS claimed,
       count(*) FILTER (WHERE fetched_total IS NOT NULL) AS fetched,
       count(*) FILTER (WHERE checksum_ok IS TRUE) AS checksum_ok
FROM meta.page_scan
WHERE scanned_at > now() - interval '24 hours'
GROUP BY run_id, kind, status
ORDER BY run_id DESC, kind, status;

SELECT kind, count(*) AS tasks, max(attempts) AS max_attempts,
       min(not_before) AS next_retry,
       count(*) FILTER (WHERE locked_by IS NOT NULL) AS locked
FROM meta.scan_task
GROUP BY kind
ORDER BY tasks DESC;

-- 终态与常规队列不得重叠；终态量不计入常规 backlog。
SELECT count(*) AS open_irreconcilable,
       count(*) FILTER (WHERE kind = 'votes_full') AS open_votes,
       min(next_review_at) AS next_review
FROM meta.irreconcilable
WHERE resolved_at IS NULL;

SELECT count(*) AS invalid_overlap
FROM meta.scan_task st
JOIN meta.irreconcilable i USING (page_id, kind)
WHERE i.resolved_at IS NULL;
```

落库和主键检查：

```sql
SELECT count(*) FROM serve.page_current;
SELECT count(*) FROM ingest.vote_event;
SELECT count(*) FROM serve.vote_current;
SELECT count(*) FROM ingest.revision
WHERE wikidot_revision_id IS NULL;

SELECT page_id, voter_id, count(*)
FROM serve.vote_current
GROUP BY page_id, voter_id
HAVING count(*) > 1;
```

以某次 Tier1 run 为基准检查评分与票数：

```sql
WITH expected AS (
  SELECT page_id, claimed_total,
         checksum_expected AS claimed_rating
  FROM meta.page_scan
  WHERE run_id = :tier1_run
    AND kind = 'meta' AND status = 'ok'
)
SELECT pc.page_id, pc.slug,
       e.claimed_rating, pc.rating,
       e.claimed_total, pc.vote_up + pc.vote_down AS current_total
FROM expected e
JOIN serve.page_current pc USING (page_id)
WHERE pc.rating IS DISTINCT FROM e.claimed_rating
   OR pc.vote_up + pc.vote_down IS DISTINCT FROM e.claimed_total;
```

幂等复验直接按 work-queue run 统计新事实：

```sql
SELECT run_id, count(*) AS new_vote_events
FROM ingest.vote_event
WHERE run_id IN (:first_work_run, :replay_work_run)
GROUP BY run_id
ORDER BY run_id;
```

## 6. 定时调度（用户级 systemd）

生产使用用户级 systemd oneshot + timer，禁止安装到 `/etc/systemd/system`。模板服务通过
`package.json` 的 `schedule:*` 白名单启动单轮 CLI；旧
`schedule:sitemap-delta/sitemap-full/tier1` 及其 timer 已移除，L2/L3 不再有第二个
timer 重复启动。`work-queue` 使用 `OnUnitInactiveSec=1min`，只在上一轮退出后重排。
所有日历 timer 显式使用 `Asia/Shanghai`。

实际启用节奏如下：

| unit | 触发时间（Asia/Shanghai） | 超时 | 单轮职责 |
|---|---:|---:|---|
| `syncer2-l0.timer` | 每小时 `:02/:32` | 5 min | L0 两小时 updated-at 窗口 |
| `syncer2-l1.timer` | 每小时 `:07/:37` | 45 min | L1 四字段全站扫描；vote/revision 同频 |
| `syncer2-l2.timer` | 每小时 `:27` | 10 min | full sitemap absence 基准 |
| `syncer2-l3.timer` | 每周日 `04:55` | 45 min | 全字段 Tier1 兜底 |
| `syncer2-work-queue.timer` | 上轮退出后 1 min | 10 min | 每轮最多 50 个深扫任务 |
| `syncer2-resolve-pages.timer` | 每 5 min | 5 min | 解析新发现 slug |
| `syncer2-oldest-pending.timer` | 每 5 min（`:01/:06/...`） | 2 min | 零出站采样最老待处理项、趋势与告警证据 |
| `syncer2-forum-discovery.timer` / `syncer2-forum-consume.timer` | 每日 `05:23/05:43` | 10/30 min | 论坛差集与成员刷新 |
| `syncer2-reconcile.timer` | 每日 `06:13` | 20 min | M10 三角与 CROM 金丝雀；v1 只读 |
| `syncer2-page-scan-maintenance.timer` | 每小时 `:55` | 5 min | 聚合、保留与 VACUUM |

L1/L3 的 45 分钟是全站实测 1,045 秒的 2.58 倍。模板的未分类默认超时为 15 分钟；
每个生产实例再由 `syncer2-job@NAME.service.d/timeout.conf` 收紧或放宽。超时后 oneshot
以失败退出，timer 负责下一次触发；禁止 `TimeoutStartSec=infinity`。

安装到当前用户（在 `syncer2/` 下执行）：

```bash
user_unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
install -d "$user_unit_dir"
install -m 0644 deploy/systemd/syncer2-job@.service deploy/systemd/*.timer \
  "$user_unit_dir/"
for source_dropin in deploy/systemd/syncer2-job@*.service.d/*.conf; do
  dropin_dir="$user_unit_dir/$(basename "$(dirname "$source_dropin")")"
  install -D -m 0644 "$source_dropin" "$dropin_dir/$(basename "$source_dropin")"
done
```

若 checkout 或 `.env` 不在模板默认的 `/srv/scpper/syncer2`、`/etc/scpper/syncer2.env`，
先用 `systemctl --user edit syncer2-job@.service` 添加本机 override：

```ini
[Service]
WorkingDirectory=/absolute/path/to/syncer2
EnvironmentFile=
EnvironmentFile=/absolute/path/to/syncer2/.env
Environment=PATH=/absolute/path/to/node/bin:/usr/local/bin:/usr/bin:/bin
```

启用、停用和检查：

```bash
systemctl --user daemon-reload
systemctl --user enable --now \
  syncer2-l0.timer syncer2-l1.timer syncer2-l2.timer syncer2-l3.timer \
  syncer2-work-queue.timer syncer2-resolve-pages.timer \
  syncer2-oldest-pending.timer \
  syncer2-forum-discovery.timer syncer2-forum-consume.timer \
  syncer2-reconcile.timer syncer2-page-scan-maintenance.timer

systemctl --user disable --now \
  syncer2-l0.timer syncer2-l1.timer syncer2-l2.timer syncer2-l3.timer \
  syncer2-work-queue.timer syncer2-resolve-pages.timer \
  syncer2-oldest-pending.timer \
  syncer2-forum-discovery.timer syncer2-forum-consume.timer \
  syncer2-reconcile.timer syncer2-page-scan-maintenance.timer

systemctl --user list-timers 'syncer2-*' --all
systemctl --user show syncer2-job@l0.service syncer2-job@l1.service \
  -p Result -p ExecMainStatus -p TimeoutStartUSec
journalctl --user -u syncer2-job@l0.service -u syncer2-job@l1.service \
  --since '2 hours ago' --no-pager
```

### 存活页修订全文回填

`revision-source-backfill` 只处理存活页的源码修订，按 `revision_id` 调
`history/PageSourceModule`，全文经 sha256 内容寻址写 `ingest.content_blob`，再单向补
`ingest.revision.source_sha`。PageDiff 不参与源码重建；旧
`ingest.revision_source_delta` 仅作为 append-only 遗留证据保留。

历史源码请求复用 adult 源码的 `RestrictedIdentitySession` 与
`loadRestrictedWikidotCredentials()`，账号只从既有受限凭证链加载。整个回填进程（启动
探针、登录、PageSource、出口采样）都由 `createRestrictedStableHttp()` 固定到
`http://127.0.0.1:7890`、TLS 1.2，禁止继承通用 `SYNCER2_HTTP_PROXY=7891`。session
失效时归还当前 claim、保留 attempt 并显式记录 `emptyResult=false` 后结束本轮；不得把
失败解释成空源码或删除证据。

首次必须先跑 `npm run revision-source:pilot`。门禁要求 1,000/1,000 条完成抓取、入库、
`source_sha` 回填和 content_blob 回读逐字节一致，其中 100 个当前版本还要与
`ViewSourceModule` 逐字节一致。门禁通过后才启用
`syncer2-revision-source-backfill.timer`。timer 在 `:25/:55` 启动，单并发、每轮最多
300 条且有 200 秒运行预算。它可与 L1 重叠；看到 L0/L1 running 只记录观测，
不再整轮退出。带宽由 `background` 连续令牌桶（800/h、capacity 400）与全局
FIFO 约束，因此相位对齐不会把低优先级让路退化为永不执行。

监控以 `population_type=revision_source_full` 独立分层，不能借 hybrid/L0/L1 基线。
每小时检查任务状态、`source_bytes`/`response_bytes`、`blob_inserted`、数据库与
`content_blob` 增长及根文件系统余量；余量低于 100 GiB 时 CLI 会停止认领。`processing`
锁超过 15 分钟会回到 retry，单条连续失败三次进入 irreconcilable；页面变为非 live
则转 `skipped_deleted`，不保存其历史源码。已登录 session 强制重建后目标仍返回
`no_permission` 时直接转 `unavailable`：它表示账号已验证但该历史修订不可得，不是可重试
链路故障，也不是本地/远端事实冲突。每轮另记录 `outputHealth`；连续 3 个确实认领任务的
轮次 `stored=0` 时记录 error、加入 `revision_source_zero_output_streak` 健康失败原因并非零退出。

PageDiff 响应中的结构化标签两侧集合不受 `nl2br` 的不可逆问题影响。后续可用少量
PageDiff 请求独立采集“标签: A → B”变更史；这会提供 v1 没有的标签历史能力，且与
全文抓取互不冲突。本次不采集。

数据库侧确认新轮次、请求量和熔断：

```sql
SELECT id, started_at, finished_at, status,
       stats->>'layer' AS layer, stats->>'population_type' AS population_type,
       stats#>>'{http,requests}' AS requests
FROM meta.ingest_run
WHERE started_at > now() - interval '2 hours'
ORDER BY id DESC;

SELECT count(*) FILTER (WHERE effective) AS effective_frozen_domains
FROM meta.write_freeze_status();
```

只有 `list-timers` 的 LAST/NEXT 正常推进、journal 每轮正常退出、L0/L1/L2/L3 出现各自
`population_type`、冻结域为 0，且 L0 约 1–3 / L1 约 145 / L2 约 1–5 个请求，才算
调度在跑。频率或行为异常时先执行上面的 `disable --now`，修复后再启用。
L1 首次看到或尚未解析身份的 slug 只建立远端修订基线，不得计入跨轮 L0 覆盖率；
若 `revision_coverage_metric.l0_missed_changes` 持续包含 `previous_revision=null`，
说明基线推进回归，应先停 L1 排查。

用户 manager 还必须 `loginctl show-user "$USER" -p Linger` 返回 `Linger=yes`，否则登出
后不保证常驻。无 lingering 且不能由管理员开启时，使用
`ecosystem.work-queue.config.cjs` 的同名 syncer2 app：只允许 `cron_restart` +
`autorestart:false`，禁止 `restart_delay`，也不得触碰 PM2 中任何 v1 app。切换前先用
上面的 `disable --now` 停掉 systemd，避免双调度；只选择具名的 syncer2 app：

```bash
pm2 start ecosystem.work-queue.config.cjs --only \
  syncer2-work-queue,syncer2-l0,syncer2-l1,syncer2-l2,syncer2-l3,\
syncer2-resolve-pages,syncer2-forum-discovery,syncer2-forum-consume,\
syncer2-reconcile,syncer2-page-scan-maintenance,syncer2-oldest-pending
pm2 ls
```

## 7. 故障排查

### meta.ingest_run

先看 `status`、`batches_failed`、`transport_failure_rate`、`exit_ip_stats` 和
`stats.httpHealth`（业务/probe 分账；`stats.http` 是逐尝试诊断口径）。
`running` 长时间不结束通常是进程被杀；`partial` 是本轮完成但含正常不完整证据，
不计作 run 失败；`aborted` 多为断路器；`failed` 再结合 `stats.error` 判断请求耗尽、
解析失效、身份冲突、数据库或写闸。Tier1 的
`coverage_ratio < 0.98`、有失败批次或 sample/range 模式都不能授权全站删除推断。
L1 多批抓取期间若页面跨 offset 移动而出现重复，run 记 `partial`，且不推进增量状态
或覆盖率；这与请求耗尽、pager/结构损坏的 `failed` 分开。

### meta.page_scan

`failed` 是请求或解析失败；`partial` 是条数/校验和/身份门控没有闭合。投票页只有
`status=ok`、`claimed_total=fetched_total`、`checksum_ok=true` 才是完整快照。
冻结期间采集证据仍会写，error 中会包含 freeze skip；不要因为有 page_scan 就误判
事实已应用。

保留策略由 `meta.maintain_page_scan()` 实现：

- finished run 先汇总到 `meta.page_scan_run_summary`；
- 真实 `failed/partial` 页级行保留 30 天；
- 成功页级行只留 1 小时排障窗口，但每 `(page_id,kind)` 最新成功永久保留；
- sitemap full / Tier1 各最近两轮完整 run 永不被维护任务删除，保证两轮 absence 门控；
- `tier1_claim_only` 是声明载体，不冒充真实 partial，按成功证据期限处理。

定时任务每小时执行并 `VACUUM (ANALYZE)`；手工验证：

```bash
npm run meta:page-scan-maintain
psql "$SYNCER2_DATABASE_URL" -c \
  "select run_id,kind,status,pages,checksum_bad_pages from meta.page_scan_run_summary order by run_id desc limit 30"
```

### meta.parse_health_baseline

```sql
SELECT source, mode, population_type, metric, min_history_windows,
       sample_count, baseline_value,
       lower_bound, upper_bound, max_rel_deviation,
       action, enabled, last_breach_at, last_breach_value,
       last_breach_run, breach_count
FROM meta.parse_health_baseline
ORDER BY last_breach_at DESC NULLS LAST, source, mode, population_type, metric;
```

新指标先用 `action=warn` 观察；`freeze_write` 越界只冻结该生产者实际影响的域，
单项解析指标不得自动拉 `all` 总闸。基线不得跨
`(source, mode, population_type)` 借用。`avg_votes_per_page`、源码/正文/标签平均长度等
population-sensitive 绝对均值只能留作证据，不能加入通用 gate。先对照触发 run 的
`fetched_claimed_ratio`、`checksum_ok_rate`、HTTP 状态分布和原始页面，确认是否解析漂移。
每轮 `parse_fingerprint.sample_counts` 是各指标的真实分母：默认至少 20 个业务
请求/页面/记录，`exit_ip_dist` 至少 5 个观察，0.5% 的 `parse_drop_rate` 至少 200 个
输入才有判别分辨率。当前样本不足只落证据、不进入七日基线；即使当前样本足够，
同分层历史合格窗口少于 `min_history_windows`（默认 3）时，绝对上下界和相对阈值都
不得判定。固定上限达不到分辨率的组合（L0、论坛单批 drop rate）明确为 evidence-only，
不登记永久 warming 的假 gate。`batches_total=0` 且无业务请求、probe-only，以及
`unspecified` 隐式分层必须显示 `decisionSkipped=true`。

### meta.write_freeze

```sql
SELECT * FROM meta.write_freeze_status();
SELECT * FROM meta.write_freeze_alert_state;
SELECT domain, reason, breach_metric, breach_run,
       frozen_at, frozen_by, freeze_count, released_at, released_by
FROM meta.write_freeze
ORDER BY domain;
```

冻结的是 ingest/serve 写入，不是 meta 证据采集。不要直接 `UPDATE` 表，也不要自动
释放。只有人工核对原始响应、修复解析器并通过小范围演练后，管理员才能执行：

```sql
SELECT meta.release_writes(:domain, :operator);
```

`meta.write_freeze_alert_state.alert_state` 为 `clear/active/overdue`；每域默认
`alert_after=30 minutes`，并已计算 `all` 对具体域的传导。这是唯一的冻结超时告警出口，
纯库内状态，不发送任何消息。

### 队列卡住

先看 `attempts/not_before/locked_by/locked_at`。短进程异常退出后，下一轮会回收超过
30 分钟的陈旧锁；正常失败必须尊重 not_before。不要为了“马上重试”把 attempts、
stable_count 或结果哈希清零。相同结果连续稳定但仍不一致的页会进入
`meta.irreconcilable` 并从常规队列移除；这不是丢任务，而是独立的每周低频复查。
同哈希继续保持终态，新哈希才回到 `scan_task`。人工裁决时看 `local_value/remote_value`、
`result_hash/checks/last_checked/next_review_at`；不得为追求常规 backlog 归零而删除终态，
也不得手工把同一 `(page_id,kind)` 插回常规队列。

### 代理 DIRECT 告警

先比较 `stats.startupProbe.proxy.proxyExitIp` 与 `directExitIp`，再看
`exit_ip_stats.byNode`。mihomo 连接必须同时按目标 host 和 syncer2 当前代理入口端口
过滤；本部署为 `7891`，不能把另一入口（如 `7890`）上其它进程的同 host DIRECT
连接归给本轮。修复监控后用硬门槛复验：

```bash
npm run work:queue:probe -- --amc-probe require --proxy-check require
```

只有 `problems=[]`、`leaked=false`、代理/直连出口不同，且 `byNode` 不含当前入口的
`DIRECT` 才能恢复 timer；不得通过关闭 mihomo 归因来“修复”告警。

账号历史源码/adult 是明确例外：它们固定使用 `7890`，不得为满足通用 `7891` 探针而回落
轮换池。验收应同时看客户端 `proxyUrl=127.0.0.1:7890`、TLS 1.2、账号 session 日志和
`exit_ip_stats`；当前主机直连与稳定入口都可能回显同一 `103.188.235.3`，因此仅凭“两 IP
必须不同”不能裁决这条固定入口是否泄漏，更不能据此切换到 7891。

## 8. 发布前回归

```bash
set -a
source .env
psql "$SYNCER2_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/smoke_test.sql
./checks/run_checks.sh
npm test
npm run typecheck
```

四条命令都必须零退出；报告实际通过数与 skip 数，不沿用历史数字。
