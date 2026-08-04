# syncer2 NUL 二阶故障修复报告

日期：2026-07-30  
工作树：`/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation`  
目标库：`scpper-v2`

## 1. 结论

事故根因已经定位并以线上响应复现。`result.error` 中的 U+0000 **不是** PH7
四元组分层键泄漏，也不是页面渲染正文；它来自 `HttpClient` 的非 2xx 错误构造：

1. Wikidot 对这三页返回 HTTP 404，响应体带 `Content-Encoding: gzip`。
2. 旧代码在解压前执行
   `raw.subarray(0, 200).toString('utf8')`。
3. gzip 头和压缩数据天然含 `0x00`；这些字节被原样变成 JS 字符串中的 U+0000。
4. `HttpStatusError.message` 带上这段“错误摘要”。
5. `scanCurrentContents()` 捕获异常后用 `String(err)` 形成 `result.error`。
6. `applyCurrentContent()` 把它作为 `meta.record_page_scan(... p_error text)` 的参数。
7. PostgreSQL `text` 无法表示 U+0000，于是记录原始 404 失败时又触发 SQLSTATE
   `22021`，任务既没有 page_scan 证据，也无法推进稳定失败状态。

因此用户观察到“渲染 HTML 不含 NUL”与本结论完全一致：问题发生在**压缩的 404
wire body 被解压以前**，不是解压后的 HTML。

本次同时完成：

- 修正非 2xx 压缩响应的解码顺序；
- 增加 PostgreSQL 文本/JSON 共享清洗边界；
- 把 `record_page_scan` 收口为不可失败、限长并留痕的证据入口；
- 审计并覆盖当前源码、正文、论坛、修订、用户名等站点自由文本写入；
- 修正 work-queue 整轮健康裁决；
- 让三条卡住任务经正常队列执行三次相同 404 后收敛到每周复查；
- 观察两轮标准 systemd work-queue 为 exit 0；
- 全量 312 个测试通过。

## 2. 根因复现与证据

### 2.1 原代码的数据流

事故点的实际链路如下：

```text
Wikidot gzip 404 wire bytes
  -> HttpClient 非 2xx 分支把 raw bytes 直接 toString('utf8')
  -> HttpStatusError.bodySnippet / message
  -> scanCurrentContents catch: String(err)
  -> CollectResult.failed.error
  -> applyCurrentContent
  -> meta.record_page_scan(... p_error text)
  -> PostgreSQL 22021: invalid byte sequence for encoding "UTF8": 0x00
```

旧实现的关键语句是：

```ts
raw.subarray(0, 200).toString('utf8').replace(/\s+/g, ' ').trim()
```

`\s+` 不会删除 U+0000，因此 gzip 头里的零字节继续留在错误消息中。

### 2.2 线上 wire-body 复现

使用与采集器相同的代理、UA、Referer 和
`Accept-Encoding: gzip, deflate, br`，直接读取 wire body，再分别统计压缩体和解压体：

| slug | HTTP | encoding | wire bytes | wire NUL | 前 12 个 NUL 位置 | decoded bytes | decoded NUL |
|---|---:|---|---:|---:|---|---:|---:|
| `jiuhu2` | 404 | gzip | 9,601 | 44 | 3,4,5,6,7,51,972,1152,1250,1708,1761,1975 | 38,004 | 0 |
| `scp-cn-4905` | 404 | gzip | 9,605 | 41 | 3,4,5,6,7,51,87,973,1055,1251,1709,1762 | 38,019 | 0 |
| `scp-cn-4866` | 404 | gzip | 9,608 | 34 | 3,4,5,6,7,51,87,896,948,1055,1070,1237 | 38,019 | 0 |

三条解压后的前缀都是正常 XHTML：

```text
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1...
```

在修复前直接调用 `scanCurrentContents()` 时，三页的 `result.error` 都能观察到
U+0000；例如 `jiuhu2` 的错误字符串中位置 84–88 已是连续 NUL。该偏移等于错误消息
固定前缀加 gzip wire body 的 3–7 字节，和上表完全吻合。

修复后真实 run 4465–4467 共落下 9 条失败 page_scan：

- error 长度为 295/300 bytes；
- `encode(convert_to(error,'UTF8'),'hex') LIKE '%00%'` 九条均为 `false`；
- 错误内容是可读的 `HTTP 404 ... <!DOCTYPE html ...`。

### 2.3 PH7 分层键排除

审计了 `src/health/parseHealth.ts` 中全部 `\u0000`：

- 四元组键只用于 `DEFAULT_THRESHOLD_OVERRIDES` 的 Map/Object 查找；
- 三元组键只用于 `switch` 分层选择；
- 文件中的异常消息只包含独立的 `source`/run 信息，没有插入复合键；
- 没有把这些 key 拼入 page_scan error、HTTP error 或 DB 自由文本参数的路径。

`src/backfill/s1.ts` 的 `\u0000` 同样只作为内存集合键；输入来自 PostgreSQL
`text`，没有把该键写回数据库或拼入本事故错误消息。

内部 Map 键的 `\u0000` 均保持不变，没有改动其有意设计。

## 3. 修复内容

### 3.1 HTTP 根因修复

`src/http/client.ts` 的非 2xx 分支现在：

1. 按 `Content-Encoding` 调用与成功响应相同的 `decodeBody()`；
2. 只对解压后的 UTF-8 文本截取 200 个字符；
3. 将不可打印 C0 控制字符替换成 U+FFFD；
4. 压缩体损坏时保留 HTTP status，并生成可打印的“响应体解压失败”消息；
5. 永不回退到把原始压缩字节放进 Error message。

回归测试用本地 gzip 404 证明：

- `HttpStatusError.status === 404`；
- message 包含解压后的中文正文；
- message 不含 U+0000 或其它非空白 C0 控制字符；
- 4xx 仍然零重试，不改变原有 HTTP 语义。

### 3.2 PostgreSQL 共享文本边界

新增 `src/store/pgText.ts`：

- `sanitizePgText()`：
  - U+0000 → U+FFFD；
  - 未配对 high/low surrogate → U+FFFD；
  - 合法代理对（例如 emoji）原样保留；
  - 可按 UTF-8 字节数截断，不切开 code point；
  - 返回 NUL、孤立代理项、截断、原/存储字节数；
  - 更新进程级计数并带 context 写 warn 日志。
- `sanitizePgValue()`：
  - 深度处理数组、plain object 的字符串值和 JSON object key；
  - Buffer、Date 和自定义对象保持原类型；
  - 清洗后 key 碰撞时加确定性后缀，避免静默覆盖；
  - 返回聚合计数。
- `toPgJson()`：
  - 在 `JSON.stringify()` **之前**清洗。
  - 这是必要的：stringify 后 U+0000 已变成字面量 `\\u0000`，普通字符串替换无法
    区分“转义序列”与原文本，而 PostgreSQL jsonb 仍会拒绝该转义。
- `sanitizePageScanError()`：
  - 同时清洗 NUL/孤立代理项；
  - 以 16 KiB 为 UTF-8 安全上限；
  - 发生修改时在行尾追加：

```text
[syncer2:text_sanitized nul=N lone_surrogate=N truncated=0|1]
```

`src/store/db.ts` 的统一 `query()` 在送入 node-postgres 前，对所有直接 text/数组/plain
object 参数执行最终清洗。各 JSONB 写入点则改用 `toPgJson()`，避免 stringify 太早。

### 3.3 page_scan 证据通道

`src/store/meta.ts` 新增唯一单页入口 `recordPageScan()`：

- 所有参数显式带 PG 类型；
- `error` 必经 `sanitizePageScanError()`；
- 可存任意 JS 字符串内容；
- 清洗与截断在 error 行内留永久标记；
- `insertPageScans()` 批量入口使用相同清洗规则；
- 原来散落在 content/files/revisions/votes/forum/discussion/attributions/deletion/
  revision-source/handler fallback 的直接 `meta.record_page_scan` 调用全部收口。

真实 PostgreSQL 回归传入：

- U+0000；
- high lone surrogate；
- 超过 60 KiB 的中文错误内容。

断言 `record_page_scan` 成功、存储不超过 16 KiB、无 NUL、UTF-8 截断完整，且行尾标记为
`nul=1 lone_surrogate=1 truncated=1`。测试 run 在断言后删除，未残留测试证据。

### 3.4 正文与内容寻址

`src/collect/source.ts` 在调用 `ingest.apply_page_meta()` 前清洗：

- `source_wikitext`；
- `text_content`；
- 图片字段中的站点文本。

重要细节：

- `source_sha` 对**清洗后源码**重算，保证 content-addressed key 与实际落库 bytes 一致；
- 成功 page_scan 在发生清洗时写 `content_text_sanitized ...` 标记；
- apply 返回值和 ingest-run sample 含字段级 sanitation 计数；
- work handler 使用 apply 返回的清洗后 SHA 作为稳定哈希。

回归测试把 NUL、high lone surrogate、low lone surrogate 同时放进 source/text，
断言 page_scan 有标记，传给 `apply_page_meta` 的 JSON 已替换，apply 返回清洗摘要。
另一个真实 TEMP 表测试证明 text 与 jsonb 两条 PostgreSQL 写入都成功。

历史 revision source 路径也同步处理：

- 写入前清洗源码；
- 对清洗后的内容重新计算 SHA；
- 回读校验、当前版本交叉验证和 page evidence 使用同一清洗后口径；
- run stats 增加 `textSanitized`、`nulCodeUnitsSanitized`、
  `loneSurrogatesSanitized` 计数；
- 不会出现 query 边界改了文本但仍带原 SHA 的不一致。

### 3.5 论坛、修订、用户名和其它自由文本

详见下一节审计表。核心做法是先清洗整批结构，再进行 `ensure_user`、内容哈希和 JSONB
写入；因此用户名、作者快照、修订备注和帖子正文使用的是同一份清洗后数据，而不是只在
最后一层掩盖 SQL 错误。

## 4. 自由文本写入审计

| 写入域/字段 | 入口 | 结论与措施 |
|---|---|---|
| `meta.page_scan.error` | `recordPageScan` / `insertPageScans` | 共享清洗、16 KiB 截断、行内标记；所有 live caller 已收口 |
| `ingest.content_blob.source` / `ingest.page_source` / `serve.page_current.search_text` | `applyCurrentContent` → `apply_page_meta` | source/text 显式清洗，SHA 对清洗后 bytes 重算，page_scan + sample 留痕 |
| 历史修订全文 `content_blob.source` / `revision.source_sha` | `applyStoredRevisionSource` | 清洗后重算 SHA，回读/交叉验证同口径，run stats 计数 |
| 论坛分类标题/描述 | `applyForumBatchInTransaction` | 整个 ForumBatch 在 ensure/apply 前深度清洗，JSON 用 `toPgJson` |
| 论坛 thread 标题/描述/作者快照 | 同上 | 已清洗；正 wikidot 作者进入 `ensure_user`，无 ID 名称快照也已清洗 |
| 论坛 post `title/text_html/text_plain/author_name` | 同上 | 已清洗；discussion page_scan 和 apply sample 留清洗摘要 |
| 修订 `comment`、raw markers/type text | `applyRevisionResult` | 整个 RevisionBatch 先清洗，哈希与 payload 都使用清洗后值，page_scan 留标记 |
| 修订作者 `display_name/username` | `ensureAuthor` | 使用清洗后 RevisionBatch；最终 `query()` 还有统一边界 |
| 投票用户 `display_name/unix_name` | `prepareVoteSnapshot` | users/entries/quarantine 在 stringify 前用 `toPgJson`；最终 query 再兜底 |
| 匿名/guest/deleted 身份原始文本 | votes quarantine | `toPgJson` 深度清洗并留日志计数 |
| Tier1 title/slug/category/tags/parent | `tier1-scan` → `apply_page_meta` | attrs 改用 `toPgJson`；直接参数再经 query 边界 |
| M6 备用标题 | conventions apply | direct text 由 query 边界清洗 |
| M6 署名/隔离原始行 | conventions apply/quarantine | JSON payload 改用 `toPgJson` |
| 图片 alt/title/url 等文本 | content/image apply | 提取器原有控制字符拒绝仍保留；结构再次深度清洗 |
| work queue local/remote/review JSON | `store/workQueue.ts` | 全部改用 `toPgJson` |
| incremental L0/L1/signals JSON | `store/incremental.ts` | 全部改用 `toPgJson` |
| ingest-run stats/fingerprint/exit IP | `finishIngestRun` / parse health | 全部在 stringify 前清洗 |
| reconcile report/summary | `persistReconcileReport` | 改用 `toPgJson`；未触发或发送任何 QQ 消息 |
| 删除报告、forum links、图片回填 payload | 各自 store/CLI 入口 | JSON 改用 `toPgJson`，直接 text 经 query 边界 |
| v1 一次性 backfill 的原始自由文本 | `src/backfill/*` | 来源已经是 PostgreSQL UTF-8 text，v1 本身无法保存 U+0000/非法 Unicode；这些受控 PG→PG 拷贝不是野生 HTTP 输入，因此不批量改写正在运行的 backfill |
| PH7/S1 内存复合键 | parseHealth / s1 | 有意的内部 Map/Set key，不写库、不进人类错误消息，保持 `\u0000` 不变 |

此外检查了 live `src` 下全部 `JSON.stringify` 使用点。剩余项是：

- 稳定哈希输入；
- HTTP 请求 body；
- 文件快照/日志/stdout；
- 解析错误的可打印引号表示；
- 受控 backfill PG→PG 数据。

会作为 jsonb/text 参数写入 live v2 采集表的点已改为 `toPgJson` 或统一 `query()` 边界。

## 5. work-queue 整轮健康判定

新增 `src/work/runHealth.ts`，页级状态和整轮状态分开裁决。

整轮非零退出条件：

- HTTP breaker 打开：`aborted`；
- 连续页失败达到现有 5 页熔断：`failed`；
- `claimed > 0 && processed === 0`：零进展，`failed`；
- 至少 2 个 failed 且 `failed / processed >= 25%`：大比例失败，`failed`；
- 本轮 failed 任务的累计 attempts ≥3：跨轮连续失败，`failed`。

其它情况：

- 孤立 failed、普通 partial、write-freeze skip：整轮 `partial`，exit 0；
- 无上述信号且无页级异常：`ok`，exit 0。

这保留了真实故障信号：

- 3 个目标全部 404 的恢复 run 4465/4466 是 100% 失败，exit 1；
- 第三轮虽已全部转 irreconcilable，仍因跨轮连续失败 exit 1；
- 零进展无豁免，仍 exit 1；
- breaker 与连续 5 页失败逻辑未移除。

回归断言覆盖：

- `claimed=9, processed=9, partial=2, failed=1` → `partial`, exit 0；
- `processed=8, failed=2` → 25%，`failed`, exit 1；
- claimed>0 且 processed=0 → `failed`, exit 1；
- repeatedFailures>0 → `failed`, exit 1。

## 6. 失败任务的正常收敛

此前 content failed 没有 `resultHash`，所以即使 page_scan 能写入，`stable_count` 也会
被重置为 0。现在 content failure 生成稳定证据哈希：

- 完整错误原文仍逐轮写进 `page_scan.error`；
- 稳定哈希对 HTTP 错误只使用 `content:failed:v1 + http_status:<code>`；
- 404 页正文中的边缘节点/时间戳变化不会永久重置稳定计数；
- 不同 HTTP status 或非 HTTP 错误仍会改变证据类别。

恢复操作没有直接 UPDATE/DELETE 任务状态。使用正常 `enqueueScanTasks()` 发现入口，
加入 reason `collector_nul_error_fix_recheck` 并给更早 `not_before`；该入口明确不重置
attempts、stable_count 或 last_result_hash。随后由标准 work-queue claim/handler/
finish 状态机执行。

| run | 结果 | 健康原因 | exit | 队列动作 |
|---:|---|---|---:|---|
| 4465 | 3 claimed / 3 failed | high failure rate + repeated | 1 | 三页 stable=1，正常退避 |
| 4466 | 3 claimed / 3 failed | high failure rate + repeated | 1 | 三页 stable=2，正常退避 |
| 4467 | 3 claimed / 3 irreconcilable | repeated cross-run failure | 1 | 三页 stable=3，移出 scan_task |

最终数据库状态：

- `meta.scan_task` 中三页 content 任务：0；
- `meta.irreconcilable` 中三页 content：3；
- 三条 result hash 均为
  `f24d1bdb3fd6053405452328dc00fd90438f6def5e0272e09a103dde3d29e144`；
- `next_review_at` 为 2026-08-06，对应既有每周低频复查；
- attempts 不再每轮堆积。

这三页的真实业务结论是“当前 URL 稳定 404”，不是采集成功；系统保留失败证据并正常
收敛，没有把真实故障改写为 ok。

## 7. 真实调度观察

三页收敛后的标准 systemd `syncer2-job@work-queue`：

| run | claimed/processed | 页级结果 | 整轮 status | health exitCode |
|---:|---|---|---|---:|
| 4468 | 17/17 | 16 ok, 1 partial | partial | 0 |
| 4471 | 1/1 | 1 failed（首次、孤立） | partial | 0 |

两轮 journal 均有 `Finished syncer2-job@work-queue.service`，无 NUL/22021。run 4471
尤其证明了本次要求的核心语义：单任务失败保留为 task failed 和
`batches_failed=1`，但不再自动把整轮判为 failed 或 exit 1。

## 8. 测试结果

执行结果：

```text
npx tsc --noEmit
  PASS

npx tsc -p tsconfig.tests.json --noEmit
  PASS

定向回归（db/http/m3/work-queue/operations）
  82 tests, 82 pass, 0 fail

npm test
  312 tests, 312 pass, 0 fail, 0 skipped
  duration 117,822 ms
```

新增/修改的关键回归：

- gzip 404 必须解压后构造错误摘要，message 无 NUL；
- `sanitizePgText` 对 NUL、两类 lone surrogate、合法代理对的精确行为；
- JSON value 和 key 的 stringify 前清洗；
- TEMP text/jsonb 真实 PostgreSQL 写入；
- `record_page_scan` 清洗、截断、行内标记和真实持久化；
- current source/text 应用路径清洗与 page_scan 标记；
- 单任务失败/高比例失败/零进展/跨轮连续失败的整轮裁决。

## 9. 运行边界确认

- 所有代码修改只发生在指定 worktree；
- v2 写入只连接 `scpper-v2`，测试和恢复前均有数据库名硬断言；
- 对主库 `scpper-cn`、`scpper-syncer`、`scpper_user` 没有写操作；
- 没有访问 `/home/andyblocker/qqbot`；
- 没有发送任何 QQ 消息；
- 没有停止、重启或发信号给 revision-source backfill；
- 观察期间 revision-source job 的 done 数从约 67,800 继续增长到 74,357，
  pending 272,978、retry 640，说明任务未被本次操作打断；
- 没有 git commit，没有 push。

## 10. 主要文件

- 新增：`src/store/pgText.ts`、`src/work/runHealth.ts`
- 根因：`src/http/client.ts`
- 证据入口：`src/store/meta.ts`、`src/store/db.ts`
- 内容/用户审计：
  `src/collect/source.ts`、`revisions.ts`、`forum.ts`、`votes.ts`、`files.ts`、
  `conventions.ts`、`deletion.ts`、`forumLinks.ts`
- 队列/状态：
  `src/work/handlers.ts`、`src/cli/work-queue.ts`、`src/store/workQueue.ts`、
  `queues.ts`、`incremental.ts`
- 历史源码：
  `src/store/revisionSource.ts`、`src/cli/revision-source-backfill.ts`
- 其它 JSONB 边界：
  `src/health/parseHealth.ts`、`src/reconcile/report.ts`、相关 image/tier1 CLI
- 回归：
  `tests/http.test.ts`、`db.test.ts`、`m3-collect.test.ts`、
  `work-queue.test.ts`、`operations.test.ts`

## 11. 阻塞与后续

本次范围内无阻塞。三页已转入设计中的每周复查，不应手工删除该复查证据。后续若页面
恢复为 200，既有 irreconcilable review 状态机会重新打开常规任务；若仍是 404，则继续
低频保留，不再每 30 分钟堆 attempts。
