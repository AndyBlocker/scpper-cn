# M1 · ListPages Tier1 全站扫描器构建报告

日期：2026-07-27  
工作树：`/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation`  
模块：`src/collect/listpages.ts` + `src/cli/tier1-scan.ts`  
结论：实现完成；TypeScript 类型检查通过；M1 隔离测试 16/16 通过；生产站小样本在 3 次请求内解析 500 页，四道校验全部通过。

---

## 1. 实现范围

本次只实现规格 §3 的 M1：

- ListPages AMC 请求构造；
- 规格 §3.2 逐项列出的 selector；
- 单批 HTML 解析；
- 字面量残留、字段数/丢行率、跨批 index、五星评分四道校验；
- pager、首末 total 与翻页竞态校验；
- 完整快照、集合语义 diff 与稳定 result hash；
- 单次短进程 CLI；
- `meta.ingest_run` / `meta.page_scan` 证据；
- 未知 fullname 的身份补偿队列；
- `meta.scan_task` 触发矩阵；
- `ingest.ensure_user` 与 `ingest.apply_page_meta` 调用；
- 已注销创建者禁止合成 SUBMITTER；
- 固定 fixture、正向与负向测试；
- 生产站真实小样本。

没有实现 M2/M3/M4/M5，也没有修改生产 checkout。没有 git commit 或 push。

---

## 2. 交付文件

### 2.1 新增

- `src/collect/listpages.ts`
  - 请求构造、解析、批级结果类型、全轮扫描、四道校验、快照、diff、触发信号。
- `src/cli/tier1-scan.ts`
  - 单次短进程 CLI、启动探针、证据落库、身份补偿、元数据写入和任务入队。
- `tests/listpages.test.ts`
  - 16 个 M1 测试。
- `tests/fixtures/listpages_page_1.reconstructed.html`
  - 固定重建 fixture，含正常作者与已注销创建者。
- `docs/build-report-M1.md`
  - 本报告。

### 2.2 修改

- `package.json`
  - 新增 `tier1` 与 `tier1:sample` 两个脚本。

工作树中同时存在其他模块的并行改动（M2/M3/M4 等）；本次没有回滚或覆盖它们。

---

## 3. 请求构造

### 3.1 固定参数

`buildListPagesRequest()` 固定产生：

```text
moduleName = list/ListPagesModule
category   = *
order      = created_at desc
perPage    = 250
offset     = (batchNo - 1) * 250
```

翻页使用 `offset`，没有切换到 `/p/N`。原因见 §10.3 的真实站点实测：本次环境里 `/p/2` POST 连续返回 403，而 `offset=250` 可稳定得到第二批。

### 3.2 module_body

每行用专用 div marker：

```text
[[div class="syncer2-listpages-row"]]
%%%%fullname%%%%|||...|||%%%%index%%%%
[[/div]]
```

双百分号写法会让已替换值继续带有 `%%...%%` 外层定界；字段间严格使用 `|||`。

### 3.3 selector 清单

实际逐字使用规格代码块中的：

```text
fullname category name title tags _tags parent_fullname
created_at created_by created_by_id created_by_unix
updated_at commented_at rating rating_votes comments size revisions total index
```

清单实际为 **20 个唯一 selector**，不是正文标题所称的 21 个。没有擅自补入任何字段：

- 禁止项 `page_id`：未使用；
- 禁止项 `rating_percent`：未使用；
- 带 HTML 攻击面的 `created_by_linked`：未使用。

这个规格内部计数矛盾是本次最明确的偏离之一；实现选择逐项代码块作为权威内容。

---

## 4. 解析器

### 4.1 显式结果类型

批结果不是裸数组，而是：

```text
ok      + data
partial + data/error
failed  + error/diagnostics
```

全轮 `batches` 是 `Map<batchNo, outcome>`：

- 成功批不会与失败批混淆；
- 失败批不会从 Map 消失；
- `--max-batches` 主动省略的批也以 `partial + intentionalOmission` 明确存在；
- 解析失败绝不退化为 `[]`。

### 4.2 合法空结果与解析失败

合法空结果要求：

- body 非空；
- pager 结构完整；
- row marker 数为 0；
- 没有截断或 selector 残留。

以下情况明确返回 `failed`：

- 空 body；
- WAF HTML；
- pager 缺失或不可解析；
- row marker 与提取出的 div 数不一致；
- selector 外层定界损坏；
- selector 字面量残留；
- 丢行率超阈值。

这满足“空结果与解析失败可区分”的硬要求。

### 4.3 日期

实现支持两种形态：

1. 规格描述的 `<span class="odate time_<epoch>">`；
2. 直调 AMC 实测的 `%%%%date|<epoch>%%%%`。

第二种经外层定界剥离后是 `%%date|<epoch>%%`。它不是 selector 残留，因此在字面量检测前作了仅限日期字段的严格例外。

所有日期最终变为 UTC ISO 字符串；CLI 调数据库时继续使用既有 `toPgTimestamptz()`。

### 4.4 tags

- `tags` 与 `_tags` 分别解析；
- 两者各自去重排序；
- `mergedTags` 为 visible + hidden 的去重排序集合；
- diff 用双向集合比较，不按数组下标比较；
- `apply_page_meta` 同时传 `tags` 与 `hidden_tags`，由现有函数合并、排序、去重；
- 仅顺序变化不产生伪变更。

### 4.5 数字

- `created_by_id`：空值为 `null`，非空必须是正安全整数；
- `rating_votes/comments/size/revisions`：必须为非负安全整数；
- `total/index`：必须为正安全整数；
- 不接受宽松的 `Number()` 垃圾尾缀。

---

## 5. 四道校验

### 5.1 selector 字面量残留

任一字段剥除外层边界后的值匹配 `^%%.+%%$`：

- 该批立即 `failed`；
- 不进入 diff；
- `selectorLiteralFields` 与 `selector_literal_rate` 进入指纹。

日期的 `%%date|epoch%%` 仅在日期字段中作为实测形态例外；其它字段没有例外。

### 5.2 字段数与丢行率

每个候选 row：

- `parts.length !== 20` 时必须增加 `droppedFieldCountRows`；
- 其它字段解析失败增加 `droppedParseRows`；
- 五星拒绝增加 `rejectedFiveStarRows`；
- 三者都进入丢行率。

判定：

- `1 / 250 = 0.4%`：批为 `partial`；
- `2 / 250 = 0.8%`：超过 0.5%，批为 `failed`；
- 绝不静默 `continue` 后假装完整。

### 5.3 index 连续性

全轮检查：

- 第一条必须为 1；
- 相邻 index 必须严格 `+1`；
- 不允许空洞；
- 不允许重叠；
- 不允许重复 index；
- 不允许重复 fullname；
- 完整扫描的最后 index 必须等于 remote total。

违反时整轮 `partial`；失败批仍按更严重的 `failed` 处理。

主动小样本只校验已请求前缀的连续性，并因为其余批显式省略而整体标 `partial`。

### 5.4 五星评分

`rating` 满足任一条件即整页拒绝：

- 包含 `.`；
- `parseInt` 非有限数；
- `parseFloat` 非有限数；
- `parseInt !== parseFloat`。

拒绝数进入日志、diagnostics 和解析指纹；整轮至少 `partial`，不会把该页当正常观测。

---

## 6. pager、total 与翻页竞态

### 6.1 pager

优先解析：

```html
<span class="pager-no">page X of Y</span>
```

无法取得时才尝试 `span.target` 的最后 `/p/N` 链接。两条路径都失败则整批/整轮失败，绝不默认成 1。

`offset` 翻页的真实响应里第二批 pager 仍显示 `page 1`。因此：

- pager 只用于取得总批数；
- 真实跨批位置以 `%%index%%` 为权威；
- 不用展示性的 `currentPage` 否决合法 offset 批。

### 6.2 total 归一化

规格称 `%%total%%` 返回过滤条件下精确总数，但本次生产站实测：

```text
第 1 批 offset=0   raw total=36173
第 2 批 offset=250 raw total=35923
差值               =250
```

也就是说，offset 模式下它返回的是“从当前 offset 起剩余条数”。实现先严格解析原始正整数，再加回：

```text
(batchNo - 1) * perPage
```

归一化后两批均为 36173，才能进行规格 §3.4 要求的首末 total 漂移比较。

这不是按常规推测做的兼容，而是本次真实样本直接验证后加入的最小修正。

### 6.3 全轮状态

- 请求/解析批耗尽失败：`failed`；
- pager 与 `ceil(total/perPage)` 不符：`failed`；
- 字面量残留或全轮丢行率超阈值：`failed`；
- index 不连续、五星拒绝、total 漂移、普通 partial 批：`partial`；
- 所有批完整且所有校验通过：`ok`。

---

## 7. HTTP、重试与进程模型

### 7.1 复用

只复用现有：

- `src/http/client.ts`
- `src/http/amc.ts`

没有另起 HTTP 层。

### 7.2 请求头与代理

启动即调用既有 `http.assertHeaders()`。真实小样本使用：

- 代理：`http://127.0.0.1:7891`
- 非空 User-Agent；
- Referer：`https://scp-wiki-cn.wikidot.com/`
- gzip；
- AMC 启动探针。

### 7.3 重试与熔断

- HTTP 层传输错误/500 至少 3 次尝试；
- AMC `try_again` 做最多 3 次批级指数退避；
- 其它可恢复的批请求异常最多 3 次外层尝试；
- 503/429 零重试；
- 503/429 连续熔断阈值不低于 5；
- 连续传输重置熔断阈值不低于 5；
- 断路器开启后进程非零退出。

### 7.4 短进程

CLI 没有常驻 loop：

1. 新建 HTTP client；
2. 新建 DB pool（非 dry-run）；
3. 启动自检与探针；
4. 扫描一次；
5. 落证据、diff、应用；
6. 输出一行 JSON；
7. 关闭连接并退出。

---

## 8. 落库与触发

### 8.1 实际函数签名

按要求在 `scpper-v2` 上用只读 psql 查询，而不是凭迁移文件猜测：

```text
ingest.apply_page_meta(integer,jsonb,timestamp with time zone,text,bigint,integer) -> jsonb
ingest.ensure_user(text,integer,text,text,text,text,integer)                       -> integer
```

CLI 的命名参数与这两个实际签名一致。

### 8.2 ingest_run

每次非 dry-run 先写 run，完成后填：

- `source='wikidot'`
- `status`
- `pages_enumerated`
- `remote_total`
- `remote_total_source='listpages_total'`
- `batches_total`
- `batches_failed`
- `transport_failure_rate`
- `exit_ip_stats`
- `parse_fingerprint`
- `stats`

`stats.mode='tier1'`。

### 8.3 schema 差异

实际 `meta.ingest_run`：

- 没有 `mode` 列；
- `status` 只允许 `running/ok/failed/aborted`；
- `remote_total_source` 只允许 `listpages_total/sitemap/both/unknown`。

因此规格文字不能逐列直写：

| 规格写法 | 实际落法 |
|---|---|
| `mode='tier1'` | `stats.mode='tier1'` |
| run `partial` | DB `status='failed'`，`stats.logicalStatus='partial'` |
| `remote_total_source='listpages'` | `remote_total_source='listpages_total'` |

这些属于“服从实际 schema，语义不丢失”的必要偏离。

### 8.4 page_scan

对能解析到内部 page_id 的页面写 `kind='meta'`：

- 完整 run：`status='ok'`
- partial/failed run：`status='partial'`
- `result_hash`：稳定字段顺序的 SHA-256
- partial 时把全轮原因写入 `error`

### 8.5 未知 fullname

`meta.scan_task.page_id` 非空，未知 fullname 没有内部身份，禁止伪造 `page_id=0/-1`。

因此：

- 未知 fullname 写 `meta.pending_page`；
- reason 包含 `listpages_fullname_without_identity`；
- 真正的增量新页再加 `listpages_new_fullname`；
- 单轮最多 5000 个，截断数进入摘要；
- 后续由已有身份解析器取整页 wikidotId，再进入页面队列。

这与现有 `0012_collector_queues.sql` 的物理设计一致。

### 8.6 apply_page_meta

仅当整轮 `scan.status='ok'` 时调用。传入：

- `slug`
- `title`
- `tags`
- `hidden_tags`
- `category`
- `parent`（内部 page_id 可空，并保留 slug）
- `first_published_at`
- `comment_count`
- `revision_count`
- `claimed_rating`
- `claimed_vote_count`

同时传：

- 内部 `page_id`
- 实际 `wikidot_id`
- `p_source='wikidot'`
- run id
- UTC timestamptz

partial/failed 轮只允许写 meta 管道证据和 pending 单调 upsert，不调用事实/SCD2 apply。

### 8.7 §3.5 触发矩阵

触发矩阵已抽成纯函数，并由测试直接钉住：

| 信号 | 行为 |
|---|---|
| `rating` 或 `rating_votes` 变化 | `votes_full` |
| `revisions` 或 `size` 变化 | `revisions_full` |
| 增量新 fullname，且已知 page_id | `meta` |
| 未知 fullname | `pending_page`，取得身份后等价进入 meta |
| `comments` 或 `commented_at` 变化 | `forum` |
| `tags` / `_tags` 集合变化 | 本轮直接 `apply_page_meta`，不额外入队 |

入队复用既有 `enqueueScanTasks()`：

- `ON CONFLICT(page_id,kind)` 幂等；
- 合并 reasons；
- 提升 priority；
- 不覆盖 attempts；
- 不覆盖 stable_count；
- 不覆盖 result_hash；
- 不覆盖其它执行侧退避/锁状态。

### 8.8 创建者

- `created_by_id > 0`：按 wikidot id 去重后调用 `ensure_user('wikidot', id, ...)`；
- `created_by_unix` 写函数的真实 unixName 参数；
- `created_by_id=null && created_by_unix=null`：视为已注销创建者；
- 已注销创建者不调用 `ensure_user`；
- 作者保持空；
- 对已知 page_id 入 `meta` 定向补偿；
- 对未知身份页面仍由 `pending_page` 先取得 page_id；
- 代码没有任何 `SUBMITTER` 合成路径。

---

## 9. 快照语义

- 文件为 gzip JSON；
- 同目录临时文件后原子 rename；
- dry-run 与正式快照使用不同文件；
- 损坏或版本不符返回 `null`，按 bootstrap 处理，不当成空站；
- 只有 `scan.status='ok' && persistence.ok` 才推进快照；
- partial/failed 绝不推进，所以下轮会重复报告而不会吞掉信号；
- bootstrap 首轮只建基线，不把全站已有页面误报为“新页”；
- 已注销创建者补偿不依赖 diff，即便字段稳定也会继续入 meta，直到下游解决。

---

## 10. 生产站真实小样本

### 10.1 最终验收命令

```bash
cd /home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation/syncer2
npm run -s tier1:sample
```

等价于：

```bash
node --import tsx/esm src/cli/tier1-scan.ts --dry-run --max-batches 2
```

`--dry-run` 不连接数据库、不写任何表；但真实请求生产站 AMC，走指定代理并运行实际解析器。

### 10.2 最终实际输出

日志：

```text
2026-07-27T11:55:04.958Z [info] [tier1-scan:http] client 就绪 {"proxy":"http://127.0.0.1:7891","userAgent":"scpper-cn-syncer2/0.1 (+https://scpper.cn; contact: me@mer.dev)","referer":"https://scp-wiki-cn.wikidot.com/","timeoutMs":30000,"maxAttempts":3,"breaker503":5,"breakerReset":5}
2026-07-27T11:55:04.959Z [info] [tier1-scan:http] assertHeaders 通过 {"userAgent":"scpper-cn-syncer2/0.1 (+https://scpper.cn; contact: me@mer.dev)","referer":"https://scp-wiki-cn.wikidot.com/"}
2026-07-27T11:55:04.959Z [warn] [tier1-scan] --dry-run：不连库、不写 meta/ingest/serve，只跑生产网络与解析校验
2026-07-27T11:55:07.314Z [info] [tier1-scan:probe] AMC POST 探针通过 {"attempts":1,"categories":42,"ms":1847}
```

stdout 最后一行 JSON：

```json
{"ok":false,"status":"partial","runId":null,"durationMs":8618,"pagesEnumerated":500,"remoteTotal":36173,"expectedBatches":145,"requestedBatches":2,"batchesFailed":0,"validation":{"selectorLiteralFree":true,"parseDropWithinLimit":true,"indexContinuous":true,"fiveStarAbsent":true,"totalStable":true,"pagerMatchesRemoteTotal":true,"duplicateFullnames":0,"duplicateIndexes":0,"expectedLastIndex":36173,"observedLastIndex":500,"firstTotal":36173,"lastTotal":36173,"reasons":["小样本主动省略 143 批"]},"diff":{"bootstrap":true,"newFullnames":500,"changed":0,"votesChanged":0,"revisionsChanged":0,"forumChanged":0,"tagsChanged":0,"unchanged":0,"sampleNew":["scp-cn-4813","scp-743-jp","scp-l749","37-site-rules","ayers-array","scp-114-ko","scp-l037","a-dove-in-a-chicken-pen","scp-l079","wikidot-data-form-tech","scp-l426","log-of-anomalous-items-cn:01874","scp-8273","fragment:scp-8273-2","we-all-fall-down","scp-cn-4835","anna-speech","experiment-log-914-cn:00066","wanderers:flamesa-lost","scp-cn-4475"]},"persistence":{"ok":true,"bootstrap":true,"resolvedPages":0,"unresolvedPages":500,"pendingEnqueued":0,"pendingTruncated":0,"pageScansWritten":0,"creatorsEnsured":0,"creatorsFailed":0,"deletedCreatorPages":0,"metadataApplied":0,"metadataFailed":0,"tagChangesApplied":0,"tasksEnqueued":0,"taskSignals":{},"slugResolution":"dry-run","errors":[]},"snapshotAdvanced":false,"http":{"requests":3,"attempts":3,"retries":0,"wireBytes":59088,"decodedBytes":266287,"statusBuckets":{"200":3},"breakerOpen":false},"egress":{"exitIps":["103.188.235.3"],"nodes":["🇭🇰 香港 9929 20260727"],"probes":1,"probeFailed":0,"failureByNode":{}}}
```

命令退出码为 1，这是预期行为：小样本主动省略 143 批，必须是 `partial`，不能伪装完整 run。

关键结果：

- 真实 Wikidot 请求：3
  - 1 次 AMC 契约探针；
  - 2 次 ListPages 批请求；
- HTTP 200：3/3；
- 重试：0；
- 解析页数：500；
- 批失败：0；
- selector 字面量：0；
- 丢行：0；
- index：1..500 连续；
- 五星页：0；
- 首末归一化 total：36173 / 36173；
- pager 总批数：145；
- `ceil(36173/250)=145`；
- 断路器未开启；
- wire bytes：59088；
- decoded bytes：266287；
- 快照未推进；
- 数据库零写入。

### 10.3 调试期间的生产实测发现

本次所有生产站探索与最终验收合计约 **26 次请求**，低于要求的 50 次上限。

发现：

1. 直调 AMC 的日期不是规格所写的 span，而是 `%%%%date|epoch%%%%`；
2. ListPages row 位于外层 `list-pages-box` div 中，不能用从第一个 div 到第一个闭标签的简单正则，否则会吞掉第一行并跳过后续行；
3. `offset=250` 时 pager 展示 current 仍是 page 1，不能用展示页码验证 offset；
4. `offset=250` 时 raw total 从 36173 变为 35923，必须加回 offset；
5. `/p/2` POST 在当前代理/站点规则下连续 3/3 返回 HTTP 403；
6. GET `/p/2` 不带正确 AMC 上下文会得到 token/status 错误；
7. 因此最终保留规格允许的 offset 方案，并以 index 作为跨批权威。

---

## 11. 测试

### 11.1 M1 隔离测试

命令：

```bash
node --import tsx/esm --test tests/listpages.test.ts
```

最终结果：

```text
tests 16
suites 5
pass 16
fail 0
duration_ms 505.839645
```

覆盖：

- 20 个实际 selector 逐项断言；
- 两个禁止 selector 与 `created_by_linked` 不出现；
- 双百分号和 19 个分隔符；
- 固定请求参数和 offset；
- fixture 正常解析；
- visible/hidden tags；
- 已注销创建者双空；
- AMC raw date；
- span.odate date；
- 合法空结果；
- 空 body；
- WAF HTML；
- pager 截断；
- selector 字面量；
- 字段数丢行计数；
- 0.4% partial；
- 0.8% failed；
- 五星评分拒绝；
- index 连续；
- index 空洞；
- index 重叠；
- total 漂移；
- tags 集合比较；
- rating/revision/forum diff；
- §3.5 四类 task kind；
- tags 变化不入队；
- 已注销创建者 meta 补偿。

### 11.2 TypeScript

命令：

```bash
npx tsc --noEmit
```

结果：退出码 0，无错误。

### 11.3 全项目测试

运行过：

```bash
npm test
```

结果：

```text
tests 150
pass 148
fail 2
```

失败只在既有 `tests/t7-cursor-safety.test.ts`。当时的只读数据库现场证据：

```text
application_name = syncer2-test:t5
state            = active
query            = SELECT pg_temp.apply_rows(...)
advisory locks   = 5580
```

T7 的 `safe_seq_watermark()` 因另一并行 T5 事务持锁而返回 null；M1 解析套件在同一次完整运行中全部通过。等待活动会话短暂归零后再重跑 T7，期间其它并行测试又进入同一库，结果仍受到相同全局水位锁影响。

没有修改 T7、T5、投影函数或其它模块来掩盖该环境问题。M1 不依赖 T7 代码路径。

---

## 12. 安全性核对

- 只修改指定工作树；
- `/home/andyblocker/scpper-cn` 未修改；
- v1 `scpper-cn` 未写；
- v1 `scpper-syncer` 未写；
- v1 `scpper_user` 未写；
- psql 只读核对只连接由 `DATABASE_URL` 替换成的 `scpper-v2`；
- 生产站最终验收是 dry-run；
- 所有 Wikidot 请求均走 `127.0.0.1:7891`；
- User-Agent 非空；
- Referer 非空；
- 未加入第二套 HTTP 层；
- 未加入第二套 DB 层；
- 未合成 SUBMITTER；
- 未提交 git；
- 未 push。

---

## 13. 偏离规格及理由

### 13.1 selector 数量

偏离：正文称 21 个，实际清单只有 20 个。  
选择：严格使用逐项代码块的 20 个。  
理由：额外候选不是无害字段；`page_id` / `rating_percent` 明确禁止，`created_by_linked` 明确说明有 HTML 风险。

### 13.2 日期响应形态

偏离：规格只描述 span.odate，生产直调返回 raw date selector。  
选择：两种都支持。  
理由：只支持规格形态会把生产 500/500 行日期全部拒绝。

### 13.3 total 语义

偏离：规格称每批给全量精确 total，offset 第二批实测给剩余数。  
选择：严格解析后加回 offset。  
理由：差值精确等于 250；归一化后与 pager 和首批总量共同一致。

### 13.4 ingest_run 物理列

偏离：实际 schema 没有 mode，也没有 partial status。  
选择：mode 和 logical partial 写入 stats；物理 status 用 failed。  
理由：不能凭规格向不存在的列写值，也不能违反实际 CHECK。

### 13.5 remote_total_source 词表

偏离：规格文字写 `listpages`，schema 只允许 `listpages_total`。  
选择：写 `listpages_total`。  
理由：这是迁移和实际数据库共同规定的词表。

### 13.6 小样本没有落库

偏离：最终真实生产样本使用 dry-run，没有创建真实 ingest_run。  
理由：

- 用户要求生产站小样本不超过 50 请求；
- 2 批必然不完整；
- 不完整 run 按铁律不能 apply/SCD2；
- dry-run 能验证真实 HTTP、探针、解析和所有四道校验；
- 避免为了“留下 run”向 pending_page 塞入 500 个由主动截断样本产生的 bootstrap 待办。

非 dry-run 完整扫描路径已按实际签名实现，但本次没有在 145 批全站生产请求上执行。

---

## 14. 已知剩余问题

1. **未做完整 145 批生产运行**  
   原因是本次真实样本被明确限制为 ≤50 请求。最终样本验证了前两批和跨批校验，但没有验证最后一批短页及全站完成时间。

2. **未做生产站 + v2 的完整写入 E2E**  
   小样本故意 dry-run；实际 SQL 签名、列与 CHECK 已用 psql 只读核对，写路径由类型检查覆盖，但尚未用完整 run 调用 `apply_page_meta`。

3. **共享 v2 测试库存在并行套件干扰**  
   全项目 T7 会被其它并行 T5 的全局 advisory lock 干扰。M1 隔离测试不受影响；若要取得全项目全绿证据，应在没有其它测试进程使用 `scpper-v2` 的窗口重跑。

4. **规格计数与生产行为需回写权威文档**  
   建议后续把“21 个”修为“20 个”，并补充 offset 模式下 `total=remaining` 与 pager current 固定为 1 的实测结论，避免下一实现者删除兼容代码。

这些都不是 M1 代码交付的阻塞项；正式上线前仍应安排一次完整 145 批的非 dry-run 验收。

---

## 15. 运行方式

完整正式扫描：

```bash
cd /home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation/syncer2
npm run tier1
```

生产网络小样本、数据库零写：

```bash
npm run tier1:sample
```

更小的单批诊断：

```bash
npm run tier1 -- --dry-run --max-batches 1
```

正式调度不要使用：

- `--dry-run`
- `--max-batches`
- `--skip-tz-check`

正式进程应由外部 timer/cron 周期拉起；CLI 自身只跑一轮并退出。
