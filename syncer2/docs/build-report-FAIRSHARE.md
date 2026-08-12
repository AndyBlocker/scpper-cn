# Work Queue Fair-Share 与投票追平报告

## 技术摘要

本次把 `meta.scan_task` 认领改为两层调度：先为每个活跃 kind 的最老到期任务保留
1 个 FIFO 名额，并让已被 `starvation` 检测的 kind 按 FIFO rank 轮转填充最多半轮；
剩余名额继续由置顶语义和老化后的有效优先级决定。生产 `limit=50`、最多 11 kind，
因此任一 eligible kind 的队首都不可能再被其他 kind 无限饿死。

在当前活队列上做的 `BEGIN ... ROLLBACK` 预览实际认领 50 个，其中
`votes_full=13`（原为 0）、`new_page_highfreq=20`；查询耗时约 1.69s，全部已回滚。
work-queue 本地 2,000ms 固定 pace 已禁用（显式为 0），真实 HTTP attempt 只由全站共享
`PostgresAdaptiveEgressGate` 限速与记账。

26,375 个到期 `votes_full` 按当前 13/50 份额估算约 54–78 小时（2.24–3.25 天）排空。
36,532 页在 30 天内完成一轮只需 50.74 页/h，即零重试时 0.0141 QPS；加 15% 余量为
0.0162 QPS，容量上可达。但当前稳态播种 SQL 仅覆盖近 90 天有投票活动的页，
所以“所有 live 页”的字面 30 天覆盖尚未由调度范围强制；这是 cohort 语义，不是 QPS 不足。

## 调度结果：服务下限与高优先同时成立

### 两层认领

1. `eligible` 先按 kind 计算 `fifo_rank`，队首依 `created_at, id` 确定。
2. 保底/纠偏车道先选每个 kind 的 `fifo_rank=1`。对轮前 `starvation` 检测命中的
   kind，继续选第 2/3/... 个候选，按 rank 轮转，总上限是 `floor(limit*0.5)`。
3. 剩余名额按 `confirm_deleted`、`new_page_highfreq` 置顶语义及有效优先级竞争；
   置顶 kind 仍受原 40% 配额封顶。
4. 最终 handler 执行顺序与 `schedule_ord` 一致，FIFO 保底先于额外优先级名额。
5. 周期终态复查最多占一轮 20%，并在常规 fair-share 之后执行，不能绕过 kind 保底。

保底不是平均分配。在两 kind、`limit=10`的回归中，非饥饿时每轮实际为
`content@100=9, discussion@10=1`；低优先 kind 获得硬保底，高优先 kind 仍获得 90% 名额。
检测器报 `discussion` 饥饿后，同一队列变为 `content=6, discussion=4`：纠偏已实际改变认领，
同时高优先仍更快。

### 可推导的等待上界

生产 CLI 新增启动不变量：非 probe 运行时必须 `limit >= selected kind count`，否则拒绝启动。
默认为 `50 >= 11`。在 systemd 调度正常且任务已到期/未被其他 worker 锁定的前提下：

```text
single round upper bound
  = RUN_BUDGET_MS + OnUnitInactiveSec + AccuracySec
  = 360s + 60s + 5s
  = 425s

task claim wait upper bound
  = (eligible tasks ahead in the same kind + 1) * 425s
```

因为保底候选用 FIFO 而非 priority，同 kind 内持续到来的高优先任务也不能插到这个上界前。
纠偏与额外优先级吞吐只会缩短实际等待，不被用来美化上界。外部停机、系统级 gate cooldown
或长期锁定不在调度器本身的墙钟保证内。

## 优先级老化与检测器纠偏

额外优先级车道使用：

```text
effective_priority = priority + floor(wait_ms / 30min)
```

因此 `priority=20` 的任务等待 40.5 小时后有效分为 101，可超过新到的 `priority=100`。
老化保留了新高优先的低延迟，但硬等待上界不依赖老化：对于同时变老的存量 backlog，
各任务的相对分差可能保持不变，所以真正防饿死的是每 kind FIFO 保底。

`detectKindStarvation` 从轮后日志移到轮前认领路径。超过 6h 阈值的 kind 被传给
`claimWorkTasks(starvedKinds)`，并在最多半轮的 FIFO 纠偏车道中获得额外名额。轮后仍重新检测，
作为纠偏前/后的运维证据。大量历史 backlog 存在时 `oldestWaitHours` 会在多轮内继续超阈，
这会使纠偏持续生效；它不再是一个无动作的绿/红日志。

## 当前队列回滚预览

对 v2 库当前队列运行新认领 SQL，认领后立即 `ROLLBACK`，未保留锁、attempt 或其他修改。

| kind | 新算法认领数 | 解释 |
|---|---:|---|
| new_page_highfreq | 20 | 原有置顶配额保留 |
| votes_full | 13 | 从 0 恢复为本轮 26% |
| meta | 7 | 饥饿 FIFO 纠偏 |
| discussion | 6 | 饥饿 FIFO 纠偏 |
| content | 1 | 每 kind FIFO 保底 |
| revisions_full | 1 | 每 kind FIFO 保底 |
| files | 1 | 每 kind FIFO 保底 |
| forum | 1 | 每 kind FIFO 保底 |
| **合计** | **50** | SQL 耗时约 1.69s，已回滚 |

## 吞吐只由共享自适应门决定

work-queue 主客户端与 adult 受限客户端的本地 `minRequestIntervalMs` 都显式为 0，认领后不再调用
`setMinRequestIntervalMs(2000)`。每个真实 attempt 先经共享 PostgreSQL gate，实际 pace 是 pressure 档位
333/667/2,000/8,000ms 与滚动小时总量护栏的较严值，且该值在运行摘要中可见。

`--limit 50` 保留为“单轮认领上限”，不根据剩余 QPS 机械换算：一个 task 可以产生 0/1/多个 attempt，
用 task 数反推出口预算会给出错误精度。实际 attempt 已被 gate 逐个预留，6min 墙钟预算会在慢档/
病态响应下提前收尾并释放未执行锁。正常 333ms 档下，50 个单 attempt 的纯 gate 时间仅 16.65s，
加上 timer 的 1min 休止后仍可使用当前 1,883/h 余量，没有必要再扩大单轮 task 上限。

## `votes_full` 排空与 30 天容量

WhoRated 正常成功路径每页 1 个 AMC request。以回滚预览的 13/50 份额估算：

| 口径 | 总 attempt 能力 | votes_full 份额 | votes_full 速率 | 26,375 排空 |
|---|---:|---:|---:|---:|
| work-queue 容量计划保守值 | 1,300/h | 26% | 338/h | 78.0h / 3.25d |
| 吃到当前全站共享门空余 | 1,883/h | 26% | 489.6/h | 53.9h / 2.24d |

该区间假设失败率为 0、每页不重试，与已给线上事实一致。如其他全站通道开始使用当前余量，
应取 3.25d 口径；实际老化优先级还给了 `votes_full` 额外名额，但本估算不假设其继续扩大。

字面全站 36,532 页的 30 天需求是：

```text
36,532 / (30 * 24) = 50.7389 pages/hour
50.7389 / 3,600     = 0.014094 QPS
with 15% headroom   = 0.016208 QPS
```

因此容量上远低于共享门当前 0.523 QPS 空余，30 天可达。`hourlyVoteSweepQuota`
已断言整个 720h 周期的播种额度之和精确等于 eligible 页数。需要区分容量与 cohort：
现有 `VOTE_SWEEP_ACTIVITY_DAYS=90` 使 eligible 集合只包含近 90 天有投票活动的页，所以
`VOTE_SWEEP_INTERVAL_DAYS=30` 目前是该活跃 cohort 的契约。若产品契约必须是全部 36,532 live 页，
后续需要明确移除/改写 90 天活动过滤；不需要增加出口 QPS。

## 追平车道为何是 832/h 预算、0 播种

只读 v2 查询于 2026-08-13 确认：

| 指标 | 值 |
|---|---:|
| 缺 `vote_sweep_page_state` 的追平页 | 26,374 |
| 已有 `votes_full` 队列行 | 26,374 |
| 已到期 | 26,374 |
| 锁定中 | 0 |
| 有证据但未入队、可新播种 | 0 |

`hourlyBudget=832` 是“每小时最多新建多少条 `votes_full`”，不是队列消费预算。
`catchupRemaining` 计算“还有多少页没有 v2 完整快照”；播种候选还必须没有现存队列行。
因此所有 remaining 都已入队时，`affected=0, used=0` 是幂等的正常结果，不是第二个断点。

为避免继续误判，播种摘要新增：

- `catchupQueued`：没有 v2 完整快照、但已有 `votes_full` 队列行。
- `catchupSeedable`：没有 v2 完整快照且还没入队，本轮可新建。
- 追平车道的 `demand` 改为使用 `catchupSeedable`，不再用含已入队页的 `catchupRemaining`。

## 回归与稳健性

| 要求 | 证据 |
|---|---|
| 高优先持续播种，低优先每轮非零 | 真实 v2 固件连续 3 轮均为 9:1 |
| 最久等待不单调增长 | 每轮 FIFO 删除最老低优先任务，测得 `oldestWaitMs` 逐轮下降 |
| 饥饿检测器有纠偏动作 | 注入 `discussion` 饥饿后从 1 个名额增到 4 个 |
| 优先级老化 | 低优先 20 等待 40.5h 后有效分 101，超过新高优先 100 |
| 无两层独立节流 | 本地 interval=0，CLI 无 `setMinRequestIntervalMs`，共享 gate 档位断言为 333/667/2000/8000ms |
| 置顶语义不回归 | 同优先级/同时间时真实顺序为 confirm_deleted → new_page_highfreq → content |
| catch-up 0 播种可解释 | 活库只读差集为 26,374 queued / 0 seedable |

验证结果：

- `npx tsc --noEmit`：通过。
- 公平性/work-queue/sweep 定向回归：35/35 通过；后续增强的置顶与 catch-up 定向组也通过。
- `npm test`：全量通过，exit 0。
- `git diff --check`：通过。
- 本次无 schema 变更，因此无迁移先后顺序风险。

## 建议与未决问题

1. 部署后持续看每轮 `starvationCorrection.claimedByKind`、`votes_full` 队列深度和共享 gate
   的 rolling-hour 余量；按保守估算 3.25 天内应看到历史到期队列归零。
2. 如果 24h 后 `votes_full` 实际份额长期低于 13/50，先核对 gate 是否降档、任务是否产生重试，
   不要先增大 `--limit`。
3. 产品侧需确认 30 天契约是“近 90 天活跃页”还是“全部 live 页”。容量支持后者，
   但当前播种 cohort 只强制前者。

对本次公平性、节流收敛和存量 `votes_full` 追平没有已知实施阻塞。
