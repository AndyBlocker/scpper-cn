# forum-consume 公平执行与背压认领报告

## 技术摘要

`forum-consume` 的 thread 停滞已解除。旧实现虽然按 `discussion=30 / forum=20`
认领，却固定执行全部 discussion 后才执行 forum；300 秒预算因此在第 30 个 discussion
后耗尽。新实现把认领和执行合并为公平微批：两类均有积压时每波只认领
`2 discussion + 2 forum`，两组 Promise 在等待任何一组前全部启动，上一波 settle 后才
认领下一波。任一类耗尽预算不会再阻止另一类保留已完成结果。

最终连续四个已完成生产轮中，forum thread 完成数为 `1 / 3 / 25 / 25`，每轮均大于 0；
`unprocessedReleased` 从旧实现恒定 20 降为 `1 / 1 / 0 / 0`。窗口内先后遇到
6,162/4,122 帖超大 thread；最终代码会把这种预算目标推迟一小时并移到当时既有
队列之后。最终正常轮达到 `claimed=50, processed=50`，同一目标不会每轮反复占头。

## 公平份额与等待上界

标准轮的第一波必为 `discussion≤2` 与 `forum≤2` 同时启动。forum 与 discussion
各自的 claim SQL 又为 `catchup` / `steady` lane 各保留一个 FIFO 名额；预留 CTE 先
完整保留，只有剩余容量才由 `fill` CTE 回填，避免旧 SQL 的全局 `ORDER BY id LIMIT`
再次截掉 steady 预留。当一张队列表排空后，后续波次把全部四个在途名额回填给另一张表。
与 work-queue 的 `limit >= selected kind count` 启动不变量相同，非 probe、非定向标准轮若
`limit<4` 会直接拒绝启动，不能用手工低 limit 绕过 `2+2` 保底。

FIFO 服务键是：

```text
forum_scan_task: COALESCE(not_before, first_seen_at), id
scan_task:       COALESCE(not_before, created_at), id
```

预算中断的在途任务归还本次 claim 的 attempt，并设置 `not_before=now()+1h`；它重新
eligible 时，其服务键位于当时既有队列之后，而更晚到达的任务不能插到它前面。
在 worker 正常按协作式 300 秒预算结束、systemd timer 按时运行的同一前提下，等待
上界与 work-queue 的口径一致：

```text
round upper bound = max-runtime 300s + OnUnitInactiveSec 60s + AccuracySec 10s = 370s
eligible claim wait upper bound = (same-lane eligible tasks ahead A + 1) × 370s
```

上界只使用每 lane 每轮第一个保底名额，不使用后续波次的额外吞吐。外部停机、硬超时
后的 30 分钟 stale-lock 恢复及全站 gate cooldown 与 work-queue 报告一样不属于正常调度
上界；非法 `A`/预算输入会由纯函数直接抛 `RangeError`。

## 认领量与实际吞吐匹配

旧实现先锁 50 条，预算只完成 30 条。新实现最多只持有当前公平波的四个未结算目标：

1. claim `2+2`；
2. 同时执行并用 `allSettled` 保留两类结果；
3. 只有上一波 settle 才 claim 下一波；
4. 达到 50 的条数上限、预算、熔断或失败上限即停止。

这是一种直接由近期实际完成速度形成的背压：快轮可继续多波，慢/超大目标轮只锁当前波。
并行 claim 也使用 `allSettled`；一侧 SQL 失败时会先精确释放另一侧已成功 claim，再抛原错，
避免局部成功锁在数组赋值前泄漏。

## 连续生产实测

数据源为 `scpper-v2:5434` 的 `meta.ingest_run`，时间均为 2026-08-13 CST。
`forum thread` 是新增的 `stats.forumThreadProcessed`，不再用
`processed-discussionClaimed` 间接猜测。

| run | 开始 | discussion claimed/processed | forum claimed/thread processed | 总 processed | released | 耗时 |
|---:|---:|---:|---:|---:|---:|---:|
| 26344 | 09:03:30 | 4 / 4 | 4 / 3 | 7 | 1 | 298.4s |
| 26353 | 09:09:29 | 18 / 17 | 18 / 17 | 34 | 2 | 300.4s |
| 26397 | 09:15:31 | 24 / 24 | 24 / 23 | 47 | 1 | 300.0s |
| **26408** | **09:21:31** | **2 / 2** | **2 / 1** | **3** | **1** | **298.3s** |
| **26450** | **09:27:33** | **4 / 4** | **4 / 3** | **7** | **1** | **298.5s** |
| **26457** | **09:33:32** | **25 / 25** | **25 / 25** | **50** | **0** | **271.8s** |
| **26501** | **09:39:05** | **25 / 25** | **25 / 25** | **50** | **0** | **249.9s** |

run 26344/26408 均碰到 `17592962`，但仍分别完成 3/1 个 thread。该目标在 run 26408
后推迟至 10:27；run 26450 随后遇到另一条 4,122 帖 `13965347`，最终代码自动将其
推迟至 10:32，并仍完成 3 个 thread。run 26457 随即完成 `25/25` forum，其中
catchup/steady=`12/13`，轮后两张队列表的 forum worker 锁均为 0。
run 26501 再次得到相同的 `25/25` 与 catchup/steady=`12/13`，释放仍为 0。

thread pending 检查点为：

| CST | pending total | catchup | steady | 说明 |
|---:|---:|---:|---:|---|
| 08:49（改造前） | 86,118 | 82,503 | 3,615 | 基线 |
| 09:08（run 26344 后） | 86,115 | 82,439 | 3,676 | 总量 -3 |
| 09:14（run 26353 后） | 86,098 | 82,414 | 3,684 | 总量 -20 |
| 09:20（run 26397 后） | 86,076 | 82,379 | 3,697 | 总量 -42 |
| 09:27（run 26408 后） | 86,077 | 82,376 | 3,701 | 总量 -41；同期 discovery 新增/晋升 |
| 09:33（最终轮转 run 26450 后） | 86,074 | 82,371 | 3,703 | 总量 -44 |
| 09:38（run 26457 后） | 86,050 | 82,334 | 3,716 | 总量 -68；锁 0 |
| 09:44（run 26501 后） | 86,026 | 82,297 | 3,729 | 总量 -92；锁 0 |

总 pending 从改造前到最终已完成轮净降 92，catchup 净降 206。
09:27 检查点比前一点多 1，是该六分钟内
`forum-discovery` 的新增量大于病态轮只完成的一个 thread；不改变滚动下降趋势。成功删除
任务、discussion 发现的新 thread 入队和 catchup→steady 晋升同时发生，因此不能拿单 lane
变化代替总量。

## 82,741 条积压排空估算

请求中的 82,741 作为待排空基数。最初四轮（含两次撞同一超大目标）的保守均值为
`44 / 4 = 11 thread/round`；实测相邻轮约六分钟，即约 `110 thread/h`，若该病态窗口
永久不改善，排空为：

```text
82,741 / 110 = 752.2h = 31.3d
```

未撞病态目标的三个轮次完成 `17 / 23 / 25`，代表值为
`21.7 thread/round = 217/h`。最终查询有 9,798 条 discussion；同三轮 discussion
完成 `17 / 24 / 25`，按 `22/round = 220/h` 约 44.5 小时排空。discussion 存续时，任务槽为 50% discussion、
50% forum；forum 内 catchup/steady 各有首波保底。discussion 排空后，四个波次槽全部回填
forum。三轮 HTTP 数据折算 thread 平均约 2.9 个 AMC request，在当前每轮约 81–92 request
容量下 forum-only 约 29 thread/round。由此两阶段规划估算为：

```text
前 44.5h: 约 217 thread/h，处理约 9,657，剩 73,084
forum-only: 73,084 / 290 thread/h = 252.0h
合计: 296.5h = 12.4d（规划值取约 12–14 天）
```

活库规模分布为：86,074 个 pending 中 82,167 个已知 thread 不超过 20 帖，p50/p90/p95/p99
为 `3/11/17/43` 帖；仅 27 个超过 500 帖、10 个超过 3,000 帖，另有 828 个尚无本地
post_count。因而两次超大碰撞不代表主体分布，但未知组和多页长尾仍是估算的不确定性。

因此采用 **约 12–14 天规划值，31 天病态敏感性上界**。这是描述性容量估算，不是假定
未来帖子分页、steady 新增量或共享 gate 永远不变的承诺；应按后续 24 小时稳定窗口重算。

## L1 与 work-queue 未回归

L1 在改造窗口内四个连续标准轮均为 `status=ok`、`pages_enumerated=36536`：

| 开始 | pages | 耗时 |
|---:|---:|---:|
| 08:49 | 36,536 | 94.1s |
| 08:54 | 36,536 | 91.7s |
| 08:59 | 36,536 | 93.2s |
| 09:04 | 36,536 | 99.0s |

09:14 后源站 live 枚举自然增长为 36,537，后续轮仍为 `ok`；这是远端集合变化，不是
本改造少枚举或重复枚举。work-queue 在 09:03–09:23 的连续八轮全部
`claimed=50, processed=50`；其中 status 的个别 `partial` 来自既有自我保护口径，完成数未回归。

## forum-discovery / forum-incremental 核查

两者不是两条消费者：生产 `schedule:forum-discovery` 直接运行
`forum-incremental.ts`。原实现确有同族风险：变化分类按固定数组顺序串行，共享 40 页和
330 秒预算，前方大分类可以让尾分类本轮零请求。

现改为先按变化分类公平切 40 页预算，并让所有变化分类第一页同时进入共享 FIFO gate；
只有各自第一页完成后才能申请下一页。生产 ForumStart 当前只有 16 个分类，所以
`40 >= 16`，任一变化分类每轮至少启动第一页；额外页按轮转顺序分配。近八轮实测每轮
观察 16 分类，变化 0–2、抓 0–2 页，均 `status=ok`、未命中 runtime budget（2.9–39.0s）。

## 回归与限制

- `npx tsc --noEmit`：通过。
- `npm test`：`528/528` 通过（基线 523 + 新增 5 条测试）。
- 回归覆盖：一类预算失败时另一类非零；在途/释放上限 4 `<20`；等待上界与非法输入；
  两 lane 预留不被最终 LIMIT 截断；预算目标 attempt 归还、延迟和轮转；变化分类并发首波。
- 未新增 schema，无迁移需要应用。
- 部署中 run 26343 曾在任务入队前因 `$2` PostgreSQL 类型推断失败；显式 `::int` 后修复。
  同时发现并修复并行 claim 局部成功竞态，精确释放该 worker 的两条 forum 锁并归还 attempt。
- 已完成的 run 26457/26501 轮后 forum/discussion worker 锁均为 0；查询时下一 timer 轮
  已正常启动，其微批锁不属于遗留锁。无迁移或外部协调阻塞；不含 commit/push。

## 建议监控

继续以 `forumThreadProcessed > 0`、`unprocessedReleased <= 4`、thread pending 的 24 小时
净变化以及 `forum_runtime_budget_rotated` 数量为验收指标。首个完整 24 小时窗口后，用
实际 catchup/steady 完成数和平均 AMC/thread 重算 12–14 天规划值；若轮转目标持续累积，需为
超大 thread 增加可续传页级 checkpoint，而不是放宽 300 秒硬预算。
