# M4 · work-queue 调度器交付报告

日期：2026-07-27

工作树：`/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation`

目标：`syncer2/src/cli/work-queue.ts`（TypeScript ESM / Node 22）

> 2026-07-28 ALERTFIX2 修订：本文记录的是 M4 当时的实现。当前确定性矛盾在同哈希第 3 次
> 后会从 `meta.scan_task` 真正移出，进入带 `result_hash/next_review_at` 的独立
> `meta.irreconcilable` 队列；常态每 7 天复查，同哈希保持终态，新哈希才恢复常规任务。
> 下文“irreconcilable 继续按 1h→4h→24h→7d 复查”的旧描述只具历史意义，现行运维口径
> 以 `docs/RUNBOOK.md` 为准。

## 1. 完成度

M4 调度器已完成并接通当前已落地的 M2 投票 handler：

- 单次短进程，无常驻调度 loop；
- 每轮最多认领/消费 50 个任务，然后退出；
- 连续 5 页 `failed` 后停止处理并非零退出；
- `FOR UPDATE ... SKIP LOCKED` 原子认领；
- 成功即删，失败保留；
- 失败 `not_before` 指数退避 1h → 4h → 24h → 7d；
- 发现侧重复入队不覆盖 `attempts` / `stable_count` / `last_result_hash`；
- 连续 3 次相同 `result_hash` 仍不一致时 UPSERT `meta.irreconcilable`；
- irreconcilable 后续复查同样按 1h → 4h → 24h → 7d 降频；
- 进程启动时每次新建 `HttpClient` / dispatcher / 会话；
- 复用 `src/http/client.ts`、`src/http/amc.ts` 与 `src/store/db.ts`；
- PM2 片段使用 `cron_restart`，并关闭 `autorestart`，未配置进程内延迟重启。

当前消费者只认领 `votes_full` / `new_page_highfreq`。`content`、`revisions_full`、
`files` 等任务留给对应 M3 消费入口，绝不“先认领再跳过”。这是本次唯一的范围缺口，
详见 §10。

## 2. 权威材料与实际数据库核验

实现前严格按任务指定顺序读取：

1. `SPEC-collector.md`（特别是 §1、§4、§7、§11）；
2. `SPEC-projector.md`；
3. `syncer2/README.md`；
4. `syncer2/src/` 现有 HTTP/DB/CLI/队列范式；
5. `syncer2/migrations/`。

数据库连接由 `backend/.env` 的 `DATABASE_URL` 把尾部 `/scpper-cn` 替换为
`/scpper-v2` 得到。只读确认：

```text
scpper-v2|user_dxzbdi|Asia/Shanghai
```

用 psql 查询 `pg_proc` 得到的实际 `apply_*` 签名（没有凭迁移文件猜）：

```text
ingest.apply_attribution_snapshot
  (p_page integer, p_entries jsonb, p_is_complete boolean, p_observed timestamptz,
   p_source text, p_run bigint, p_wikidot_id integer) -> jsonb

ingest.apply_forum_batch
  (p_categories jsonb, p_threads jsonb, p_posts jsonb, p_observed timestamptz,
   p_source text, p_run bigint) -> jsonb

ingest.apply_page_life
  (p_page integer, p_kind text, p_occurred timestamptz, p_precision text,
   p_observed timestamptz, p_source text, p_run bigint, p_wikidot_id integer,
   p_min_coverage real) -> bigint

ingest.apply_page_meta
  (p_page integer, p_attrs jsonb, p_observed timestamptz, p_source text,
   p_run bigint, p_wikidot_id integer) -> jsonb

ingest.apply_revision_batch
  (p_page integer, p_revisions jsonb, p_claimed_total integer, p_observed timestamptz,
   p_source text, p_run bigint, p_wikidot_id integer) -> jsonb

ingest.apply_vote_snapshot
  (p_page integer, p_entries jsonb, p_is_complete boolean, p_claimed_total integer,
   p_claimed_rating integer, p_visible_kinds text[], p_observed timestamptz,
   p_source text, p_run bigint, p_wikidot_id integer, p_absence_policy text,
   p_max_absence integer, p_max_absence_ratio real) -> jsonb
```

实际 `meta.scan_task` 为 12 列：

```text
id, page_id, kind, reasons, priority, not_before, attempts, stable_count,
last_result_hash, locked_by, locked_at, created_at
```

实际 `meta.irreconcilable` 为：

```text
page_id, kind, local_value, remote_value, first_seen, last_checked,
checks, resolved_at
```

实现前 v2 队列有 16 条任务（8 个 `meta` + 8 个 `new_page_highfreq`），全部为
`attempts=0, stable_count=0, locked_by=NULL`。真实 probe 后仍保持相同状态。

## 3. 交付文件

### `src/cli/work-queue.ts`

单次短进程入口：

- 新建并校验 `HttpClient`；
- 时区回环自检；
- AMC POST + 代理契约自检；
- 可选补齐 90 日活跃页 sweep 与 7 日内新页高频任务；
- 认领最多 50 个投票任务；
- 高频页同时幂等入队 `content`，但本进程不认领 M3 任务；
- 批内抓取失败按页显式保留；
- 连续 5 页失败或 HTTP 断路器开启时停止；
- 释放已认领但未处理的锁；
- 写 `meta.ingest_run` 与单行 JSON 摘要；
- 正常轮 exit 0，连续失败/断路器轮非零。

### `src/store/workQueue.ts`

执行侧状态门面：

- `seedVoteTasks()`：只更新发现侧列；
- `claimVoteTasks()`：`FOR UPDATE OF st SKIP LOCKED`；
- `finishVoteTask()`：成功删除，失败/partial 保留与退避；
- `releaseVoteTaskLocks()`：进程级异常时释放未处理锁；
- `isShortLivedTaskActive()`：7 日短命页窗口。

### `tests/work-queue.test.ts`

M4 专项数据库/静态契约测试，覆盖：

- 50/5 两个硬阈值；
- `FOR UPDATE ... SKIP LOCKED`；
- PM2 `cron_restart`；
- 普通任务与新页高频任务成功都删除；
- stable hash 第 3 次进入 irreconcilable；
- irreconcilable 第 1、2 次复查分别 1h、4h；
- 发现侧重复入队不覆盖执行侧状态；
- 投票合法空集合与解析失败可区分。

### `ecosystem.work-queue.config.cjs`

PM2 定时片段，见 §7。

### 其它小改动

- `package.json` 增加 `work:queue` / `work:queue:probe`；
- `src/store/meta.ts` 的 page_scan 批量写入补齐实际 schema 已有的 `checksum_ok`；
- 修正并行合入的 `votes.ts` 一个 TypeScript 写法：
  `readonly Array<T>` → `ReadonlyArray<T>`；
- 修正 CLI 对 `VoteScanOutcome` 的联合类型收窄和 JSON 摘要中重复 `ok` 字段。

## 4. 认领语义

核心 SQL：

```sql
WITH picked AS (
  SELECT st.id
  FROM meta.scan_task st
  JOIN serve.page_current pc ON pc.page_id = st.page_id
  WHERE st.kind IN ('votes_full', 'new_page_highfreq')
    AND pc.status = 'live'
    AND (st.not_before IS NULL OR st.not_before <= now())
    AND (
      st.locked_by IS NULL
      OR st.locked_at < now() - ($3::bigint || ' milliseconds')::interval
    )
  ORDER BY st.priority DESC,
           (st.kind = 'new_page_highfreq') DESC,
           st.not_before NULLS FIRST,
           st.id
  LIMIT $2
  FOR UPDATE OF st SKIP LOCKED
),
claimed AS (
  UPDATE meta.scan_task st
  SET locked_by = $1,
      locked_at = now(),
      attempts = st.attempts + 1
  FROM picked
  WHERE st.id = picked.id
  RETURNING st.*
)
...
```

实现细节：

- `requestedLimit` 在 SQL 前收窄到 `[0, 50]`；
- 认领时才 `attempts + 1`；
- 默认 30 分钟后才允许回收崩溃遗留锁；
- 只认领 live page；
- 最新 Tier1 的 `claimed_total` / `claimed_rating` 从成功的 ListPages
  `meta.page_scan` 证据读取，禁止拿本地 `serve.page_current.rating` 冒充远端值；
- Tier1 证据缺失时不发 WhoRated 请求，明确写 failed page_scan 并退避。

## 5. 执行、失败与连续失败出口

### 成功

`status='ok'`：

1. 关闭既有、与原任务同 kind 的 `meta.irreconcilable`；
2. `DELETE meta.scan_task WHERE id=? AND locked_by=?`。

`new_page_highfreq` 也遵守“成功即删”。下一次高频任务由每轮开头的
`seedVoteTasks()` 根据 `last_complete_vote_snapshot_at <= now()-3h` 重新入队，
不把成功任务伪装成失败保留，也不重置 attempts/stable_count。

### partial / failed

- 任务行保留；
- `stable_count` 只由相同 `result_hash` 连续累加；
- `not_before` 由执行侧 attempts 驱动 1h → 4h → 24h → 7d；
- 释放 `locked_by/locked_at`；
- 发现侧 UPSERT 只合并 reasons、提高 priority，不覆盖 attempts/stable/hash。

### 连续 5 页失败

- `failed` 才增加连续失败计数；
- `ok` / `partial` 都会清零连续失败计数（partial 是有效观测，不是传输/解析失败）；
- 第 5 页失败完成证据和退避回写后停止；
- 已认领但尚未处理的任务统一释放锁；
- run 标为 `failed`，进程 exit 1；
- HTTP 断路器打开时 run 标为 `aborted`，同样非零退出。

## 6. 收敛出口与指数退避

对 `partial/failed` 结果：

```text
result_hash 不同       -> stable_count = 1
result_hash 相同       -> stable_count += 1
无 result_hash         -> stable_count = 0
stable_count >= 3      -> UPSERT meta.irreconcilable
```

进入 irreconcilable 后用 `stable_count - 2` 作为退避阶梯序号：

```text
stable_count=3 -> 1h
stable_count=4 -> 4h
stable_count=5 -> 24h
stable_count>=6 -> 7d
```

`meta.irreconcilable` 保存：

- `kind`：保留原始任务 kind，不把 `votes_full` / `new_page_highfreq` 合并；
- `local_value`：apply 结果；
- `remote_value`：Tier1 claimed_total / claimed_rating / tier1_run_id；
- `checks`；
- `first_seen` / `last_checked` / `resolved_at`。

成功后旧 irreconcilable 标 resolved；不会制造 correction 事实。

## 7. ecosystem 配置

文件内容要点：

```js
{
  name: 'syncer2-work-queue',
  cwd: __dirname,
  script: 'src/cli/work-queue.ts',
  interpreter: 'node',
  node_args: '--import tsx/esm',
  args: '--limit 50',
  cron_restart: '*/5 * * * *',
  autorestart: false,
  watch: false,
  kill_timeout: 120000
}
```

`autorestart:false` 的作用是：短进程正常退出后保持 stopped，下一次只由 cron 拉起；
快速失败不会在 PM2 内部形成立即重启循环。

静态加载结果：

```json
{"name":"syncer2-work-queue","cron_restart":"*/5 * * * *","autorestart":false,"args":"--limit 50","hasRestartDelay":false}
```

## 8. 自动化验证

### TypeScript

```text
$ npx tsc --noEmit
exit 0，无输出

$ npx tsc -p tsconfig.tests.json --noEmit
exit 0，无输出
```

### M4 + M2 专项

```bash
node --import tsx/esm --test tests/work-queue.test.ts tests/votes.test.ts
```

结果：

```text
tests 18
suites 6
pass 18
fail 0
cancelled 0
skipped 0
```

M4 自身 5 条：

```text
✔ 投票合法空结果与解析失败显式可区分
✔ 源码与 ecosystem 钉住 50/5/SKIP LOCKED/cron_restart 契约
✔ 普通成功即删（含 new_page_highfreq）
✔ 相同 hash 第 3 次写 irreconcilable，分流退避从 1h→4h
✔ 发现侧重复入队不覆盖 attempts/stable_count/result_hash
```

测试使用 `981400000..981400999` 专属 page_id 段，只写 `scpper-v2` 的 meta 表，
结束时清理。测试 helper 在连接前拒绝 `scpper-cn` / `scpper-syncer` /
`scpper_user` 等受保护库。

### 全量回归

等价于 `npm test` 的完整串行命令最终使用 dot reporter 复跑：

```bash
node --import tsx/esm --test --test-concurrency=1 \
  --test-reporter=dot 'tests/**/*.test.ts'
```

最终 `exit 0`，全部测试点均为 `.`，无失败。

收口期间有一次全量运行得到 `148/152 pass`：4 个失败全部来自共享 v2
测试库上的 T7 投影游标注入，直接错误是 `page_id 287 未注册`；本次 M4 suite
当轮仍为 5/5 通过。未修改代码立即完整串行复跑即 `exit 0`，因此判断为同工作树
并行测试/共享测试 id 状态竞争，而非 M4 回归。这个测试隔离问题列入 §10。

## 9. 生产站真实小样本（1 个 wikidot 请求）

命令：

```bash
npm run -s work:queue:probe
```

该模式使用正常 work-queue 完全相同的新 `HttpClient`/dispatcher/session，
经 `http://127.0.0.1:7891`，带非空 UA 与 Referer，执行一次真实 AMC POST，
不认领队列任务。

实际输出：

```text
2026-07-27T11:54:12.074Z [info] [work-queue:http] client 就绪
{"proxy":"http://127.0.0.1:7891","userAgent":"scpper-cn-syncer2/0.1 (+https://scpper.cn; contact: me@mer.dev)","referer":"https://scp-wiki-cn.wikidot.com/","timeoutMs":30000,"maxAttempts":3,"breaker503":5,"breakerReset":5}
2026-07-27T11:54:12.075Z [info] [work-queue:http] assertHeaders 通过
{"userAgent":"scpper-cn-syncer2/0.1 (+https://scpper.cn; contact: me@mer.dev)","referer":"https://scp-wiki-cn.wikidot.com/"}
2026-07-27T11:54:12.146Z [info] [db] assertTimezoneRoundTrip 通过
{"probeIso":"2026-07-27T12:34:56.789Z","probeEpochMs":1785155696789,"serverTimeZone":"Asia/Shanghai","sessionZonesTested":["UTC","Asia/Shanghai"],"processTz":"Asia/Shanghai","processClockSkewMs":13.468017578125}
2026-07-27T11:54:13.589Z [info] [work-queue:probe] AMC POST 探针通过
{"attempts":1,"categories":42,"ms":713}
{"ok":true,"status":"ok","probeOnly":true,"runId":76,"http":{"requests":1,"attempts":1,"wireBytes":1516,"decodedBytes":15996,"statusBuckets":{"200":1},"retries":0,"breakerOpen":false}}
```

请求账：

```text
wikidot 请求      1
HTTP attempts     1
HTTP 200          1
重试              0
传输失败          0
解析分类          42
```

远低于 50 请求上限。

`meta.ingest_run(id=76)` 实际只读核验：

```text
id                       76
source                   wikidot_tier2:probe
status                   ok
pages_enumerated         0
batches_total            0
batches_failed           0
transport_failure_rate   0
parse_fingerprint        {"http_status_dist":{"200":1},"transport_failure_rate":0}
```

probe 前后队列均为：

```text
count=16 | sum(attempts)=0 | sum(stable_count)=0 | locked=0
```

probe 没有页面任务，所以不伪造 page_scan；真实消费路径由
`applyCollectedVoteSnapshot()` / `recordVoteScanFailure()` 对每页显式写
`ok|partial|failed` 证据。

## 10. 偏离、坑与剩余问题

### 10.1 当前只消费投票 kind

当前 `work-queue.ts` 只认领：

```text
votes_full
new_page_highfreq
```

其它 kind 不会被误认领或增加 attempts。M3 的解析/apply 模块已经出现在源码树，
但还没有接到本 CLI；`meta` / `attributions` / `forum` / `discussion` /
`confirm_deleted` 则依赖 M5–M7。

这意味着“M4 队列状态机与投票执行链”已完成，但“一个进程覆盖全部 scan_task kind”
尚未完成。建议后续采用 kind 专属消费者或 handler registry；无论哪种，都必须共用本报告
的 50/5/锁/退避/收敛协议，不能认领后跳过。

### 10.2 probe 不代表真实投票页

真实小样本验证了新会话、代理、UA/Referer、AMC 双提交、响应结构、HTTP 遥测与 ingest_run，
但没有消费现有页面任务。原因是现有 8 个高频任务没有可用的成功 Tier1
`claimed_total/claimed_rating` 证据；强行抓取会违反四重门控。选择 probe 而不是拿本地
rating 冒充远端声称值。

### 10.3 并行改动冲突

实现过程中 M1–M3 文件并行落入同一工作树，曾覆盖同名 `workQueue.ts` / `work-queue.ts`
并带来三个编译错误。最终保留并整合了并行实现，没有回滚对方文件：

- 修正 `VoteScanOutcome` 联合类型收窄；
- 修正摘要重复 `ok`；
- 修正 `ReadonlyArray` 语法；
- 将高频成功路径改成严格“成功即删”，周期性由 seed 负责。

### 10.4 `remote_total`

M4 是定向任务消费者，不做全站枚举，所以 run 的 `remote_total=NULL`。
全站 remote_total 仍由 sitemap/ListPages run 提供，不能在 M4 猜值。

### 10.5 全量测试共享数据库存在瞬态竞争

全量测试第一次收口运行中，T7 使用的固定 page id 在其 own setup 后被并行工作树/
进程清理，出现 `page_id 287 未注册`；同一轮 M4 5/5 通过。没有修改实现就立即复跑
完整串行测试并 `exit 0`。M4 自身使用专属 `981400000..981400999` id 段且 before/after
清理，未与 T7 id 段重叠。后续应让每个测试进程使用独立 schema/数据库或随机保留 id 段，
否则跨进程的 `--test-concurrency=1` 也无法隔离。

## 11. 安全说明

- 没有 git commit，没有 push；
- 没有修改受保护生产 checkout；
- 没有向 `scpper-cn` / `scpper-syncer` / `scpper_user` 写入；
- schema、函数签名、队列状态查询均为只读；
- 自动化测试只写 `scpper-v2` 专属测试 id 段并清理；
- 真实小样本只在 `scpper-v2` 留下 `meta.ingest_run(id=76)`；
- 没有删除/重建现有 `meta.scan_task`；
- 现有 16 条任务未增加 attempts、未改变 stable_count、未留下锁。
