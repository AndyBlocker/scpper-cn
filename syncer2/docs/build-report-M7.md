# M7 构建报告：删除推断 + 全局解析健康熔断

日期：2026-07-27  
工作树：`/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation`  
目标数据库：`scpper-v2`  
结论：**完成**。删除推断四道门、`confirm_deleted` 单页 404 确认、十项解析指纹、
七日基线比对、全局事实写冻结，以及“冻结写入但不冻结采集”的真实数据库演练均已落地。

本报告是本次 M7 的完整交付说明。根目录回复只保留摘要。

---

## 1. 约束遵守情况

- 依次完整阅读：
  1. `SPEC-collector.md`
  2. `SPEC-projector.md`
  3. `syncer2/README.md`
  4. 既有 `syncer2/src/`
  5. 既有 `syncer2/migrations/`
- 只修改当前 worktree；未修改受保护的 `/home/andyblocker/scpper-cn`。
- DB 只连接 `syncer2/.env` 指向的 `scpper-v2`。
- 未连接、更未写入 `scpper-cn` / `scpper-syncer` / `scpper_user`。
- Wikidot 真实请求复用 `src/http/client.ts`，实际走
  `http://127.0.0.1:7891`，且日志确认非空 User-Agent 与 Referer。
- DB 操作复用 `src/store/db.ts` 的 `createPool/query/withTransaction`。
- 没有另建 HTTP/DB 抽象层。
- 没有执行 `git commit` 或 `git push`。

---

## 2. 变更清单

### 2.1 新增

- `src/collect/deletion.ts`
  - 双源删除证据门控。
  - 连续缺席推断。
  - absence 500 页 / 1.5% 双红线。
  - `confirm_deleted` 认领、整页 GET、404 确认、重试退避。
  - 404 后再次验证证据，最后调用实际 `ingest.apply_page_life`。
- `src/health/parseHealth.ts`
  - 十项规范化指纹。
  - 七日同 source/mode 动态基线。
  - 阈值策略、分布降维、breach 留痕。
  - `meta.freeze_writes('all', …)` 自动冻结。
- `tests/m7-deletion-health.test.ts`
  - 10 个 M7 自动化用例，包含本地真实 HTTP 和 `scpper-v2` 集成测试。
- `docs/build-report-M7.md`
  - 本报告。

### 2.2 接线

- `src/store/meta.ts`
  - `finishIngestRun()` 每轮都把指纹规范化为完整十项并写入。
  - 默认在 run 收尾后执行解析健康评估。
  - 支持测试/演练显式关闭重复评估。
- `src/cli/tier1-scan.ts`
  - ListPages 收集完成、事实 apply 之前执行健康评估。
- `src/cli/sitemap-scan.ts`
  - 移除旧的“单 sitemap + 首次 absence”推断。
  - full run 成功收尾后调用新双源删除推断。
  - run stats 显式记录 `pageScanPolicy`。
  - JSON 摘要加入 `parseHealth` 与 `deletionInference`。
- `src/cli/work-queue.ts`
  - `confirm_deleted` 与投票任务共享单进程总预算 50。
  - 优先处理删除确认，避免短命页长时间悬挂。
  - 404/存在/失败计数和样本进入 run 摘要。
- `README.md`
  - 登记 M7 两个模块，并把 R10 “自动触发链缺位”改为已完成。

---

## 3. 删除推断实现

### 3.1 第一道门：完整 run + 两个独立枚举源

每个删除证据组由一轮 sitemap full 和它之前最近的一轮 ListPages Tier1 组成。
当前组和上一组必须分别满足：

- `meta.ingest_run.status = 'ok'`；
- `coverage_ratio = pages_enumerated / remote_total >= 0.98`；
- `batches_failed = 0`；
- sitemap：
  - `source = 'wikidot_sitemap'`；
  - `stats.mode = 'full'`；
  - `remote_total_source = 'sitemap'`；
  - `usedFallback = false`；
  - `stats.pageScanPolicy = 'all'`；
- ListPages：
  - `source = 'wikidot'` 或名字明确包含 `listpages`；
  - `stats.mode = 'tier1'`；
  - `remote_total_source IN ('listpages_total', 'both')`；
- 配对的 ListPages 必须早于 sitemap，且相差不超过 6 小时。

`pageScanPolicy='all'` 是规格之外的额外安全门。原因是“网络枚举完整”与“每个已知
page_id 的正面证据完整”不是一回事；人为用 `full --page-scan changed/none` 时，即使
`coverage_ratio=1`，也不能拿残缺 `meta.page_scan` 推断 absence。

### 3.2 第二道门：连续至少两组缺席

- 取当前完整 full 之前最近的上一轮完整 full，不能任意向前挑一轮拼证据。
- 两轮 full 至少相隔 2 小时，跨过已实测约 60 分钟的 sitemap TTL。
- 页面在当前组的 sitemap 和 ListPages 中均无 `status='ok', kind='meta'` 证据。
- 页面在上一组的 sitemap 和 ListPages 中也均无上述证据。
- 当前组与上一组各自的全局 absence 都必须未触发 500/1.5% 红线；不能把上一组的
  全站级坏基线与当前少量 absence 取交集后伪装成连续缺席。
- 两个 full 时间点之间，只要任何其它完整、局部或失败 run 曾经正面看见该页，
  就驳回候选。失败 run 不能提供负证据，但其中的正证据仍然可靠，不能被跳过。
- 进入候选前只检查 `serve.page_current.status='live'`。
- 系统性排除 sitemap 枚举域外的归档/隐藏 slug：
  `deleted:`、`forum:`、`adult:`、`wanderers-adult:`、`_foo`、`category:_foo`。

这比“连续两个 sitemap diff 都消失”更严格：每次 absence 都需要两个独立枚举源背书。

### 3.3 第三道门：只下 `confirm_deleted`

两组缺席成立时只幂等入队：

```text
meta.scan_task.kind = confirm_deleted
priority = 50
reasons = [
  dual_source_absence,
  sitemap_run:<id>,
  listpages_run:<id>,
  previous_sitemap_run:<id>,
  previous_listpages_run:<id>
]
```

不会在枚举阶段调用 `apply_page_life`。

消费者：

1. 用既有 `HttpClient` 对单页做整页 GET；
2. 只有真实 HTTP 404 返回 `{deleted:true,evidence:'http_404'}`；
3. HTTP 200 且身份一致是可靠“仍存在”正证据，删除任务；
4. 重定向到其它 slug 是“目标 URL 仍有响应”的正证据，按没有删除处理，不写 deleted；
5. 同 slug 回显了不同 wikidotId（疑似删后重建），或 HTTP 200 但页面结构损坏、WAF HTML、
   取不到 pageId，均是 `failed`，保留任务并退避；404-only 协议不允许猜旧身份已删除；
6. 404 后再次从 DB 验证两组双源 evidence，防止队列等待期间证据过期；
7. 最终才调用 `ingest.apply_page_life(kind='deleted')`。

最终事件的 `p_run` 使用实际执行 404 确认的 work-queue run；四个枚举 run ID 保留在任务
reasons 和返回 evidence 中，避免把“观察发生在哪一轮”错误记成 sitemap run。

### 3.4 第四道门：批量 absence 熔断

实现严格使用 `>`，边界本身放行：

- `absence > 500`：整轮不下任何删除确认任务；
- `absence / eligible_live_pages > 0.015`：整轮不下任何任务；
- 任一成立即熔断，不是两个条件同时成立才熔断。

两组证据分别执行这套红线。404 前的 TOCTOU 复核也重新计算两组全局 absence，因此旧任务
不能绕过最新一轮或上一轮已经触发的批量熔断。

报告写回当前 sitemap run 的：

```text
stats.deletionInference
```

包含四个 run ID、eligible 数、absence 数/比例、是否熔断、连续缺席数、入队数和最多
50 个样本，便于事后定位。

### 3.5 正证据对旧任务的处理

只要当前 sitemap/ListPages 任一来源重新看见页面，就删除未锁定的旧
`confirm_deleted`。正证据不需要等待完整 absence 门控。

### 3.6 冻结期行为

如果 404 与 evidence 都成立，但 `apply_page_life` 被 R10 物理闸以 `PGF01` 拒绝：

- 不删除任务；
- 解除任务锁并按已有 1h → 4h → 24h → 7d 阶梯退避；
- 在新事务调用 `meta.note_freeze_skip(..., domain='page')` 留证；
- 不把“写被冻结”误记成“页面不存在”或任务成功。

---

## 4. 全局解析健康实现

### 4.1 规范化指纹

规格 §6.2 的文字写“九项”，但代码块逐项实际列出十项。本实现按逐项清单，不删任何一项：

1. `revision_type_dist`
2. `avg_votes_per_page`
3. `avg_tags_len`
4. `avg_source_len`
5. `avg_body_len`
6. `http_status_dist`
7. `exit_ip_dist`
8. `transport_failure_rate`
9. `parse_drop_rate`
10. `selector_empty_rate`

每轮 `finishIngestRun()` 都会显式写出全部十个键。该轮没有采某个域时写 `null`，绝不写
0：未采集与合法零值不能混淆。

`exit_ip_dist` 可从采集器直接传入，也可从已有 `exit_ip_stats.byIp` 归一得到。

### 4.2 七日基线

- 策略从 `meta.parse_health_baseline` 读取；
- 动态样本来自当前 run 开始时间之前、前 7 日内、`status='ok'` 的 run；
- 排除当前 run；
- 只比较相同 `source`；
- 同一 source 复用多种采集形态时，再按 `stats.mode` 隔离。

mode 隔离是必要修正：`wikidot_sitemap` 同时承载 full/category/delta，而 category 的合法
站点根丢弃率是 `1/15 = 6.67%`；若直接拿 full 的约 `1/35984` 比，会把正常 category
误判成全站解析坍缩。

相对阈值至少有 3 个同模式历史样本才启用，避免用单点噪声建“基线”。绝对上下界不等待
暖机，像 ListPages `parse_drop_rate > 0.5%` 这种生产红线第一轮就必须生效。

### 4.3 指标降维

`meta.parse_health_baseline` 的阈值字段是 numeric，而有些指纹是分布对象，因此实现了明确的
可解释降维：

- 普通标量：前 7 日均值、标准差、相对偏移；
- `revision_type_dist`：当前分布与历史聚合分布的总变差距离（TVD）；
- `http_status_dist`：非 2xx 尝试占比。没有使用熵，因为“全 200”和“全 503”的熵都为 0；
- `exit_ip_dist`：最大出口桶占比。没有直接比较 IP 名字的 TVD，因为 49 节点池的出口
  IP 身份会正常轮换；需要抓的是“池塌成一个出口”；
- `selector_empty_rate`：逐 selector 与历史平均比较，取最大绝对漂移，避免平均值稀释
  单个关键 selector 的整体塌缩。

### 4.4 默认策略

新 source 首次出现时尝试登记十条默认策略，`ON CONFLICT DO NOTHING`，绝不覆盖人工值。
主要原则：

- scalar 分布相对偏移 35%–50%；
- 非 2xx / 传输失败绝对上限 10%；
- ListPages `parse_drop_rate` 绝对上限 0.5%；
- selector 最大空值率漂移上限 15%；
- sitemap `parse_drop_rate` 首轮绝对上限单独设为 10%，容纳 category 的合法 `1/15`；
  暖机后仍由同 mode 相对阈值抓异常。

数值不是规格给定值，属于本次实现选择；上线积累七日样本后应由运维按真实分布收紧。

权限设计上，迁移只给 `ingestor_role` SELECT 和 breach 列 UPDATE，基线本体由
projector/运维维护。代码在最小权限账号遇到 `42501` 时继续使用已有基线，不会让采集失败。
本次 `scpper-v2` 连接账号实测对该表有 INSERT/UPDATE，因此首次非 dry-run 可登记默认策略。

### 4.5 冻结动作

评估顺序：

1. 规范化并先写 `meta.ingest_run.parse_fingerprint`；
2. 读取策略和七日样本；
3. 计算每项 breach；
4. 同一事务内幂等更新 `last_breach_* / breach_count`；
5. 调：

```sql
SELECT meta.freeze_writes(
  'all',
  <含 run/source/所有越界指标的 reason>,
  'syncer2.parseHealth',
  <首个 breach metric>,
  <run id>
);
```

使用 `all` 是刻意的：这是“全局解析健康”熔断，相关性改版可能同时影响多个解析器；仅冻结一个
domain 会让另一条事实入口继续写脏数据。`meta.*` 不受 `all` 影响，所以采集、run、page_scan
证据继续落库。

同一 run 重复评估不会重复增加同一 baseline 的 `breach_count`。

### 4.6 接线时点

- ListPages Tier1：先完成网络抓取和解析，**事实 apply 前**评估；
- 论坛：先暂存解析结果，**事实 apply 前**评估；
- sitemap：只写 meta 队列/证据，run 收尾时评估；
- 其它 `finishIngestRun()` 调用方：收尾时统一规范化和评估。

已知边界：当前投票 work-queue 是逐页抓取后立即 apply，整轮分布只能在收尾时得到，因此本轮
早先已通过四重单页门控的事实无法被“整轮结束时才发现的全局偏移”追溯阻断；冻结会立即阻断
后续事实写。若要求投票域连触发 breach 的同一轮也零事实，后续需要把 work-queue 改成
“先抓全批并暂存 → 全局评估 → 再 apply”的两阶段结构。这不是本次 M7 物理冻结是否有效的
阻塞项，但属于值得继续收紧的非阻塞风险。

---

## 5. 实际数据库函数签名

没有凭 migration 文字猜签名。对 `scpper-v2` 使用 `pg_proc` 实查：

```text
function|args|result
ingest.apply_page_life|p_page integer, p_kind text, p_occurred timestamp with time zone, p_precision text, p_observed timestamp with time zone, p_source text, p_run bigint, p_wikidot_id integer, p_min_coverage real|bigint
ingest.apply_page_meta|p_page integer, p_attrs jsonb, p_observed timestamp with time zone, p_source text, p_run bigint, p_wikidot_id integer|jsonb
meta.freeze_writes|p_domain text, p_reason text, p_by text, p_metric text, p_run bigint|jsonb
meta.note_freeze_skip|p_run bigint, p_page integer, p_kind text, p_domain text, p_note text|void
meta.record_page_scan|p_run bigint, p_page integer, p_kind text, p_status text, p_claimed integer, p_fetched integer, p_checksum_ok boolean, p_checksum_expected integer, p_checksum_actual integer, p_result_hash bytea, p_error text|void
meta.release_writes|p_domain text, p_by text|jsonb
meta.write_freeze_status|p_domain text|TABLE(domain text, frozen boolean, reason text, frozen_at timestamp with time zone, frozen_by text, effective boolean)
```

这次演练还实际碰到一个列名陷阱：`ingest.page` 主键是 `id`，不是 `page_id`。第一次演练的
校验页 JOIN 因此报 `42703`；异常清理分支立即解除冻结，确认 `page.effective=false` 后才用
实际列名重跑。详见 §8。

---

## 6. 自动化测试

### 6.1 类型检查

执行：

```bash
cd syncer2
npx tsc --noEmit
npx tsc -p tsconfig.tests.json
```

结果：两条命令均退出码 0，无诊断输出。

### 6.2 M7 定向测试

执行：

```bash
node --import tsx --test tests/m7-deletion-health.test.ts
```

实际摘要：

```text
1..2
# tests 10
# suites 2
# pass 10
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

覆盖：

- 双源完整门：fallback、0.97 coverage、failed、`page-scan changed` 均拒绝；
- absence 的 500 / 1.5% 精确边界；
- sitemap 系统性排除域；
- 本地真实 HTTP：200 存在、404 删除、200 坏结构解析失败三者显式区分；
- `confirmDeletedPages()` 的失败项仍留在 Map，不会消失；
- 真实 `scpper-v2` page_scan 证据链下，当前组或上一组出现 12.5% absence 都确实熔断且零任务；
- 完整十项指纹及未观测值为 null；
- 七日相对偏移、少于 3 样本暖机、绝对红线；
- full/category 同 source 不同 mode 的基线隔离；
- 指纹真实写入 `meta.ingest_run`。

测试 teardown 后实查：

```text
test_runs     = 0
test_baselines= 0
test_tasks    = 0
```

### 6.3 全量测试

执行：

```bash
npm test
```

最终实际摘要：

```text
1..66
# tests 185
# suites 41
# pass 185
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 30065.01943
```

另执行：

```bash
git diff --check
```

结果：退出码 0，无空白错误。

---

## 7. 生产站真实小样本（3 个 Wikidot 请求）

执行：

```bash
npm run -s tier1:sample
```

该脚本等价于：

```bash
node --import tsx/esm src/cli/tier1-scan.ts --dry-run --max-batches 2
```

实际 HTTP 启动日志：

```text
2026-07-27T12:19:43.019Z [info] [tier1-scan:http] client 就绪 {"proxy":"http://127.0.0.1:7891","userAgent":"scpper-cn-syncer2/0.1 (+https://scpper.cn; contact: me@mer.dev)","referer":"https://scp-wiki-cn.wikidot.com/","timeoutMs":30000,"maxAttempts":3,"breaker503":5,"breakerReset":5}
2026-07-27T12:19:43.020Z [info] [tier1-scan:http] assertHeaders 通过 {"userAgent":"scpper-cn-syncer2/0.1 (+https://scpper.cn; contact: me@mer.dev)","referer":"https://scp-wiki-cn.wikidot.com/"}
2026-07-27T12:19:45.032Z [info] [tier1-scan:probe] AMC POST 探针通过 {"attempts":1,"categories":42,"ms":820}
```

实际单行 JSON 输出：

```json
{"ok":false,"status":"partial","runId":null,"durationMs":7316,"pagesEnumerated":500,"remoteTotal":36173,"expectedBatches":145,"requestedBatches":2,"batchesFailed":0,"validation":{"selectorLiteralFree":true,"parseDropWithinLimit":true,"indexContinuous":true,"fiveStarAbsent":true,"totalStable":true,"pagerMatchesRemoteTotal":true,"duplicateFullnames":0,"duplicateIndexes":0,"expectedLastIndex":36173,"observedLastIndex":500,"firstTotal":36173,"lastTotal":36173,"reasons":["小样本主动省略 143 批"]},"diff":{"bootstrap":true,"newFullnames":500,"changed":0,"votesChanged":0,"revisionsChanged":0,"forumChanged":0,"tagsChanged":0,"unchanged":0,"sampleNew":["scp-cn-4813","scp-743-jp","scp-l749","37-site-rules","ayers-array","scp-114-ko","scp-l037","a-dove-in-a-chicken-pen","scp-l079","wikidot-data-form-tech","scp-l426","log-of-anomalous-items-cn:01874","scp-8273","fragment:scp-8273-2","we-all-fall-down","scp-cn-4835","anna-speech","experiment-log-914-cn:00066","wanderers:flamesa-lost","scp-cn-4475"]},"persistence":{"ok":true,"bootstrap":true,"resolvedPages":0,"unresolvedPages":500,"pendingEnqueued":0,"pendingTruncated":0,"pageScansWritten":0,"creatorsEnsured":0,"creatorsFailed":0,"deletedCreatorPages":0,"metadataApplied":0,"metadataFailed":0,"tagChangesApplied":0,"tasksEnqueued":0,"taskSignals":{},"slugResolution":"dry-run","errors":[]},"parseHealth":null,"snapshotAdvanced":false,"http":{"requests":3,"attempts":3,"retries":0,"wireBytes":59093,"decodedBytes":266288,"statusBuckets":{"200":3},"breakerOpen":false},"egress":{"exitIps":["185.220.239.171"],"nodes":["🇺🇸 美國 CN2 20260727"],"probes":1,"probeFailed":0,"failureByNode":{}}}
```

解释：

- Wikidot 请求总数 3：AMC 启动探针 1 + ListPages 批次 2；
- 全部 HTTP 200，0 重试，断路器未开；
- 解析 500 行，远端 `%%total%%=36173`，两批 total 稳定；
- selector、丢行率、index、五星检测全部通过；
- 出口经配置代理和 mihomo 节点；
- 退出码为 1 是 sample 刻意省略 143/145 批后按设计标 `partial`，不是网络或解析故障；
- dry-run 不连接 DB、不写事实/证据、不推进正式快照。

总请求数远小于任务要求的 50。

---

## 8. 人为解析故障演练

### 8.1 注入方法

在 `scpper-v2`：

1. 创建独立 source 的 ingest run；
2. 创建 `parse_drop_rate` baseline：
   - `sample_count=7`
   - `baseline_value=0`
   - `upper_bound=0.005`
   - `action='freeze_write'`
3. 注入指纹：

```json
{
  "parse_drop_rate": 1,
  "selector_empty_rate": {"title": 1}
}
```

4. 调 `evaluateParseHealth()`；
5. 在显式 `BEGIN … ROLLBACK` 内尝试真实 `ingest.apply_page_meta`；
6. 冻结期间另开 run 并写一条 `meta.page_scan`；
7. 释放 `all`；
8. 验证目标 title 未改变，所有域不再 effective。

### 8.2 第一次演练的坑与安全恢复

第一次在选择目标页时写成：

```sql
JOIN ingest.page p USING(page_id)
```

实际 `ingest.page` 主键是 `id`，数据库报：

```text
SQLSTATE 42703
column "page_id" specified in USING clause does not exist in right table
```

脚本 `finally` 中的 emergency release 生效。随即实查：

```text
domain|frozen|effective
page|f|f
```

将该 run 151 收尾为 `failed`，`stats.mode='fault_drill_setup'`，保留为失败演练审计。
没有发生任何事实写。

### 8.3 成功演练原始输出

第二次使用实际 JOIN：

```sql
JOIN ingest.page p ON p.id = pc.page_id
```

原始 JSON：

```json
{"source":"m7_fault_drill_1785154859154","runId":165,"evidenceRunId":166,"healthFrozen":true,"breachMetrics":["parse_drop_rate"],"freezeDuring":[{"domain":"page","frozen":false,"effective":true,"reason":null,"frozen_by":null}],"applySqlstate":"PGF01","applyUnexpectedlySucceeded":false,"pageScansWritten":1,"targetPageId":23,"titleUnchanged":true,"freezeAfter":[{"domain":"page","frozen":false,"effective":false}]}
```

注意 `page.frozen=false` 但 `page.effective=true` 是正确行为：直接冻结的是 `all`，
`write_freeze_status('page')` 展示全局闸的传导效果。

关键结论：

- `healthFrozen=true`；
- breach 指标为 `parse_drop_rate`；
- `apply_page_meta` 真实返回 SQLSTATE `PGF01`；
- `applyUnexpectedlySucceeded=false`；
- 目标 `page_id=23` 的 title 前后相同；
- 冻结期间 `meta.page_scan` 成功写入 1 行；
- 释放后 `page.effective=false`。

### 8.4 演练后 DB 证据

```text
id|source|status|parse_drop|mode
151|m7_fault_drill_1785154830108|failed|1|fault_drill_setup
165|m7_fault_drill_1785154859154|failed|1|fault_drill
166|m7_fault_drill_1785154859154_evidence|failed|1|fault_drill
```

冻结期间的证据：

```text
run_id|page_id|kind|status|error
166|23|meta|failed|m7 injected parse failure
```

全局冻结审计（已释放但原因保留）：

```text
domain|frozen|reason|frozen_by|released_by|breach_metric|breach_run|freeze_count
all|false|parse_health 越界 run=165 source=m7_fault_drill_1785154859154: parse_drop_rate=1 baseline=0 (above:0.005)|m7_fault_drill|m7_fault_drill|parse_drop_rate|165|2
```

`freeze_count=2` 包含第一次失败演练在触发后、挑选校验页前遇到 JOIN 错误的那次冻结。
两个 baseline/run 和 write_freeze 审计刻意保留在 v2；它们 source 均以
`m7_fault_drill_` 开头，不会进入生产 source 的七日基线。

最终再次实查：

```text
domain|frozen|effective
all|f|f
page|f|f
vote|f|f
```

因此演练结束没有遗留有效冻结。

---

## 9. 偏离规格与额外保守措施

### 9.1 “九项”按实际十项实现

规格文字写九项，但 §6.2 代码块列出十项。本实现以逐项清单为准，完整保留十项。这是对原文
计数笔误的修正，不是删减。

### 9.2 删除 evidence 比规格更严格

额外要求：

- sitemap full 必须 `page-scan all`；
- sitemap full 间隔至少 2 小时；
- 每个 sitemap 只配其之前 6 小时内最近的 ListPages；
- 两次缺席间任何正面 page_scan 都会驳回。

这些条件都只会减少删除候选，不会制造删除事实。理由是规格四条铁律要求 absence 必须有可审计
证据；在无法证明时宁可不删。

### 9.3 baseline 按 mode 隔离

DB 主键只有 `(source,metric)`，规格没有 mode 列。但 sitemap 多种模式共用一个 source，
直接混合七日样本会稳定误报。因此动态历史按 `stats.mode` 隔离；表内 cache 仍是 source 级
运维摘要，在有 mode 时不会拿其它模式最后刷新的 cache 代替缺失的本模式样本。

### 9.4 默认阈值是实现选择

规格只要求“超阈值”，没有给所有指标的数字。本次提供可运行默认值，并明确不覆盖人工配置。
它们需要生产七日样本校准；尤其不同采集源应有各自策略。

### 9.5 全局冻结使用 `domain='all'`

规格写 `freeze_writes(domain, reason)`，未指定 domain。本次选择 `all`，因为这是跨解析器相关性
故障的全局防线；演练证明它会传导到 page 且不影响 meta 证据。

---

## 10. 剩余问题与运维注意事项

1. **非阻塞：投票 work-queue 尚不是两阶段 apply。** 整轮全局指纹在收尾才完整，故只能冻结
   后续写；当前轮早先通过单页四门的事实不能回滚。要进一步做到“触发轮零事实”，需单独重构为
   全批暂存后评估再 apply。
2. **需七日后调参：** 默认阈值有意保守，但没有生产七日分布就不应声称已最终标定。
3. **最小权限部署：** `ingestor_role` 按 migration 不能 INSERT/维护 baseline 主体；上线需由
   projector/运维预置策略。当前 v2 连接账号实测有 INSERT/UPDATE，首次生产非 dry-run 可自动
   登记默认策略。
4. **删除确认需要两组新证据：** 旧 run 没有 `stats.pageScanPolicy`，会被安全拒绝。部署后至少
   跑完两轮新的 `full + page-scan all` 和配对 Tier1 才可能产生确认任务，这是预期暖机。
5. 本次没有跑完整生产 full sitemap/ListPages（会超过 50 请求）；真实站验收按要求使用 3 请求
   小样本，删除链路的完整证据和 404 分支由本地 HTTP + 真实 v2 DB 自动化测试覆盖。

无阻塞项。
