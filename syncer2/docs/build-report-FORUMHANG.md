# forum-consume 硬预算与挂起修复报告

## 技术结论

`forum-consume` 的 600 秒挂起不是单个 HTTP 请求超时，也不是出口控制升档。直接触发点是一个超大主题（thread `17592962`，远端 `post_count=6162`）：抓完第 1 页后，`scanOneForumThread` 一次性生成全部剩余页，并在 `mapWithConcurrency` 内等待所有页完成；调用方只能在整个主题返回后检查旧预算。每个并发页又持续等待 PostgreSQL 共享令牌桶的 token/FIFO，因此整轮可以一直停在不可中断等待中，直到 systemd 发 `SIGTERM`。

修复后，单轮预算拥有一个贯穿所有等待层的 `AbortSignal`，在 300 秒配置下于 298 秒发出信号，为提交、解锁和摘要预留 2 秒。连续 4 个生产轮次均在 298.3–298.4 秒优雅结束，退出码 0、`processed=30`、即时释放 20 个未完成 claim，且 systemd 日志中 `Finished=4`、`status=15/TERM=0`。

## 559 秒等待的实测定位

### 观测定义

- “等待时间”是 systemd 墙钟 600 秒减 CPU 时间；已知失败轮 CPU 41.132 秒，对应 `600 - 41.132 = 558.868` 秒，四舍五入即 559 秒。
- 我加过临时阶段日志：token、全局 token-ready FIFO、HTTP headers/body、出口归因分别计时；定位完成后这些日志已从源码删除。
- 另一条带临时日志的失败轮（07:03:23–07:13:23）同样被 TERM，CPU 36.426 秒，即至少 563.574 秒不在 CPU 上执行。

### 现场证据

- 07:03–07:13 的失败轮记录到 35 条持续超过 15 秒的门禁等待：`fifo=19`、`token=16`；日志一直持续到硬杀前。
- 同一窗口没有任何 HTTP headers、body 或出口归因阶段超过临时 45 秒阈值。
- 该轮认领了 thread `17592962`；数据库显示 `post_count=6162`、已存 6223 帖、最后同步于 2026-07-29。它会进入 `scanOneForumThread` 的“第 1 页 → 创建 `totalPages-1` 页号 → `mapWithConcurrency` 全量等待”路径。
- 原 HTTP 上限本身也偏长：每次逻辑调用最多 3 个 attempt，每个 attempt 的 headers/body idle timeout 为 30 秒，另有约 0.5–0.75 秒和 1–1.25 秒退避；不含门禁时约 92 秒。它不足以单独解释连续 559 秒，但多个页面叠加且门禁无截止时会放大总墙钟。

因此，559 秒的具体阻塞位置是：**超大论坛主题的分页聚合尚未返回，4 个并发 worker 反复处于共享令牌桶 token/FIFO 等待；旧预算检查位于这个聚合调用之外。**

## 硬预算实现

### 统一中断信号

- `RuntimeBudget` 现在持有 `AbortController`；deadline 到达后 latch `stoppedByRuntimeBudget` 并以 `RuntimeBudgetExceededError` abort。
- 300 秒任务在 298 秒触发信号，最多预留 2 秒给 `finishIngestRun`、已完成部分提交、claim 解锁和连接关闭。
- `abortableSleep` 用于 pace、retry backoff、token、FIFO、站外图片节流和批级退避；listener 注册后再次检查 aborted，关闭“检查与注册之间”的竞态。

### HTTP 与门禁

- `HttpClient` 将同一 signal 传给本地 pace、共享 gate、Undici request、redirect/retry 循环、重试退避和出口 IP/mihomo 归因。
- PostgreSQL Wikidot gate 和站外图片 gate 的 token/FIFO sleep 可中断；阻塞式 advisory lock 改为 `pg_try_advisory_xact_lock` + 可中断短轮询。
- 预算异常不再被包装成 transport、解析失败或普通自适应门故障，能一直传播到 CLI 收尾边界。

### forum-consume 收尾语义

- 论坛 start/category/thread/discussion 的所有捕获点都会重新抛出预算异常。
- 预算触发后停止新抓取，但继续应用已经完整 staged 的结果。
- 未完成 `forum_scan_task` 与 `scan_task` 走正常 release（`locked_by/locked_at=NULL` 且归还 claim 消耗的 attempt），不走 crash defer，也不等待 stale recovery。
- 摘要落 `stoppedByRuntimeBudget=true`、`unprocessedReleased`，健康状态为 `partial`，退出码 0。

## 其它令牌桶链路

同一隐患原先存在于所有共享 gate 使用者：等待 token/FIFO 时只有任务边界 checkpoint，等待本身没有 deadline。现已一并覆盖：

| 链路 | 中断覆盖与收尾 |
|---|---|
| work-queue | 主/受限客户端共享 signal；处理中断丢弃未完成 outcome 分类，释放普通与 irreconcilable claim，归还 attempt，exit 0 |
| image-ingest | Wikidot 与站外 host gate 均可中断；当前 job 恢复 pending、解锁、attempt - 1，exit 0 |
| revision-source-backfill | HTTP、RequestPacer、gate 可中断；活动 revision claim 立即释放，prefix 证据仍落库，exit 0 |
| L0 / L1 | HTTP、AMC 外层 retry 和 ListPages 批级退避可中断；预算异常进入 partial 收尾，不推进不完整状态 |
| L2 | sitemap 的 transport/gate/retry 可中断；使用既有 runtime-budget partial outcome，禁止不完整删除推断 |
| L3 | ListPages transport/gate/retry 可中断；预算 partial 收尾，不推进 snapshot |

本次不涉及 schema，未创建或应用迁移。

## 回归验证

- token 等待超过剩余预算：fake gate sleep 5 秒，50 ms abort；实测少于 500 ms 返回，且远端命中数为 0。
- HTTP retry 链超过剩余预算：3-attempt 500 链在 650 ms abort；实测少于 1.2 秒返回，未等完整链。
- claim 解锁：活库插入 `attempts=7` 的 forum claim，release 后立即为 `attempts=6, locked_by=NULL, locked_at=NULL`。
- 生产轮解锁：四轮每个 worker 的 `meta.forum_scan_task` 与 `meta.scan_task` 锁计数在结束后均为 0；最后一轮 worker `3199896` 再次实测为 `0/0`。
- `npx tsc --noEmit`：通过。
- `npm test`：519/519 通过，0 failed（基线 516 + 本次 3 个回归），最终源码复跑耗时 151.071 秒。
- `git diff --check`：通过。

## 生产验收

观察窗口为 2026-08-13 07:32:26–07:55:24 CST；四轮均加载 07:31:51 后的最终运行源码。

| run_id | 开始时间 | duration_s | claimed | processed | succeeded | released | budget stop | systemd |
|---:|---|---:|---:|---:|---:|---:|---|---|
| 25970 | 07:32:26 | 298.386 | 50 | 30 | 30 | 20 | true | exit 0 / success |
| 25976 | 07:38:26 | 298.338 | 50 | 30 | 30 | 20 | true | exit 0 / success |
| 25983 | 07:44:25 | 298.266 | 50 | 30 | 30 | 20 | true | exit 0 / success |
| 25991 | 07:50:25 | 298.414 | 50 | 30 | 30 | 20 | true | exit 0 / success |

这四轮都复现了低 CPU/重等待形态；自适应 gate 的并发累计等待分别约 990.152、1009.444、1031.756、1012.599 秒，但进程墙钟仍被稳定限制在 298.5 秒内。窗口内 systemd `Finished=4`，无 `status=15/TERM`。

### L1 未受影响

最新连续 6 轮 `source='wikidot_listpages', mode='l1_votes'` 均为 `status='ok'`、`pages_enumerated=36536`；耗时为 87.871、89.094、97.936、86.910、93.904、95.338 秒，范围 86.910–97.936 秒。

### work-queue 满额完成

最新连续 6 轮均为 `claimed=50, processed=50`；耗时 112.147–158.200 秒。个别 run 的 `partial` 来自已处理任务的业务结果，不是少认领、少处理或预算中断。

## 限制与后续观察

- 超大 thread 仍无法在一轮 300 秒内抓完整；本次目标是让它可中断且不拖死整轮，未改变分页任务粒度。若要提高该主题最终收敛速度，应另行设计跨轮分页 checkpoint，而不是放宽硬预算。
- PostgreSQL 普通查询不接受 AbortSignal；本次把已知可能长期等待的 advisory lock 改为 try-lock 轮询，连接池本身仍保留既有 10 秒连接超时。现场四轮收尾均低于预留窗口。
- 建议继续以 `status=15/TERM`、`stoppedByRuntimeBudget`、`unprocessedReleased` 和结束后 worker lock 数为运行监控点。当前无交付阻塞。
