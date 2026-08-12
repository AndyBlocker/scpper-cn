# Syncer2 v2 出口令牌桶与有界 FIFO 报告

日期：2026-08-13（Asia/Shanghai）  
范围：仅 `/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation` 与 `scpper-v2`。未触碰 `/home/andyblocker/qqbot`，未发送任何 QQ 消息，未 commit/push。

## 结论

0061 的五组配额数值保持不变，但执行机制从“小时配额 ÷ 3600 的逐请求等间隔”改成连续补充令牌桶。L1 不再被 1,715ms 的错误固定间隔拖慢：容量 175 可一次承接 145 个基础请求并保留 30 个 retry token；全站 333ms pressure/politeness 门仍逐 attempt 生效。

全站门改成两阶段有租约 FIFO：请求先在自己的 channel group 内按 ticket 等 token，拿到 token 后再按 `(token_granted_at, ticket_id)` 等全站门。priority 不参与插队；后到请求无法改变已入全局 FIFO 等待者的前序集合。崩溃 waiter 的 lease 为 10 秒，轮询抖动上限 200ms，因而等待可显式推导，不再是反复醒来抢锁。

## 生产时序

1. 先新增并应用 `migrations/0062_egress_token_bucket_fifo.sql` 到 `scpper-v2`；此时只扩列/建 FIFO 表，075410a 运行时仍不读取新对象。
2. 核对五行初始满桶、配额总和 5,400/h、容量总和 784、`ingestor_role` 表/sequence 权限与空 waiter 表。
3. 再切换 `PostgresAdaptiveEgressGate` 到 token + FIFO，并移除 forum/forum-incremental/image 的 7,200ms 本地固定间隔。
4. 恢复 `checks/0013_vote_snapshot_clock.sql`；活库落后页为 0。新增 0014 检查 quota/capacity/token/policy 漂移。

0062 迁移 guard 明确拒绝 `scpper-cn` 等受保护库。迁移完成后 policy 为：

```text
channel_quota_version = 2
channel_quota_mechanism = continuous_token_bucket
global_permit_order = leased_two_stage_fifo
waiter_lease_seconds = 10
```

## 参数与推导

| group | refill | capacity | 推导 | 空桶后行为 |
|---|---:|---:|---|---|
| l1 | 2,100/h | 175 | `2100 / 12 = 175`，每五分钟 145 基础 + 30 retry | 1 token / 1,714.286ms |
| forum | 900/h | 75 | `900 / 12 = 75`，一个五分钟 catch-up 窗 | 1 token / 4,000ms |
| work-queue | 1,300/h | 109 | `ceil(1300 / 12) = 109` | 1 token / 2,769.231ms |
| image | 300/h | 25 | `300 / 12 = 25` | 1 token / 12,000ms |
| background | 800/h | 400 | `800 / 2 = 400`，容纳半小时一次的 300-request backfill | 1 token / 4,500ms |

每组在任意时长 `t` 内满足经典 token-bucket envelope：

```text
attempts(t) <= bucket_capacity + quota_requests_per_hour * t / 3600
```

所以 capacity 只允许积攒突发，不改变长期补充斜率；五组斜率总和严格为 5,400/h。全部桶在长时间空闲后同时满载时，合法总突发上界为 784；因此旧 `rolling_hour_requests > 5400 => 667ms` 逻辑不再有控制权，否则它会再次把合法 burst 错译成固定间隔。滚动小时总账继续观测和落库，pressure 失败档位仍能把全站门从 333ms 降到 667/2,000/8,000ms。

## 有界公平性

两阶段顺序如下：

```text
入队(ticket)
  -> 同 channel_group 最小 ticket 惰性补桶并取 1 token
  -> token-ready FIFO: ORDER BY token_granted_at, ticket_id
  -> 全站 next_permit_at 到点后发出；删除 waiter
```

同组有 `a` 个更早 waiter、当前可用 `b` 个 token 时，token 阶段的保守等待为：

```text
T_token <= 10s stale lease
           + max(0, a + 1 - floor(b)) * 3600s / quota
           + polling jitter
```

拿到 token 后，设全局 FIFO 已有 `A` 个更早的 token-ready waiter、当前 pressure 间隔为 `I`，则：

```text
T_fifo <= (A + 1) * (10s lease + I + 200ms)
```

关键是后到高优先请求不增加 `a` 或 `A`；它们不能反复抢先，把既有低优先 waiter 的上界推向无穷。上式甚至把每个前序都按“恰在轮到时崩溃”各计一个 10 秒 lease；已消费 token 保守丢弃，随后按本组 refill 自动恢复，不会形成永久队首。

## L1 在其它通道满速时的 SLO

normal 全站门容量为 `3,600,000 / 333 = 10,810.81 attempts/h`。除 L1 外四组即使同时吃满，也只占 `900 + 1300 + 300 + 800 = 3,300/h`，给 L1 留 `7,510.81/h = 2.0863/s`。145-request 轮次从首到尾 144 个间隔的竞争门跨度为：

```text
144 / 2.0863 = 69.0s
```

回滚后 94s 基线中，独占 333ms 门跨度为 `144 * 333ms = 47.952s`，其余网络/解析/落库约 `46.048s`。把竞争门跨度替换为 69.0s，预测满配额竞争轮次约 `115.1s`，低于验收量级 140s、180s 软预算和五分钟调度 SLO。L1 自身每五分钟补 175 个 token，也高于现场 147 attempts/轮，不会在 channel 层等待。

另外，即使 forum 在 L1 入队前瞬间用完满桶 75 个 burst，FIFO 下后到 forum 不能继续插到 L1 前面；最坏只给基线增加 `75 * 333ms = 25.0s`，约 `119.0s < 140s`。

## 回归与检查

- `npx tsc --noEmit`：通过。
- `npm test`：516/516 通过（基线 510，新增 6 条指定回归，154.265s）。
- 145-request 合成 burst：145 次全部 `waitMs=0`，余 30 token。
- forum 空桶：不拒绝，返回 4,000ms；到点后下一次消费成功。
- 低/高竞争：低优先 token-ready 票据后注入 1,000 个高优先票据，低优先仍排第一；含崩溃 lease 的单票保守上界 10,533ms。
- 满配额 L1 算术：预测约 115.1s，小于 140s。
- `checks/0013_vote_snapshot_clock.sql`：通过，live 页 votes/ok 时钟落后实测 0。
- `checks/0014_egress_token_bucket_fifo.sql`：通过。

## 真实调度验收

以下均来自 `scpper-v2.meta.ingest_run`，没有手工触发任务：

### L1（`source=wikidot_listpages`, `mode=l1_votes`）

| started | status | pages_enumerated | duration | requests | token delay sum | FIFO delay sum | max queue / max request wait |
|---|---|---:|---:|---:|---:|---:|---:|
| 06:14:00 | ok | 36,536 | 90s | 147 | 0ms | 49,113ms | 5 / 1,711ms |
| 06:19:00 | ok | 36,536 | 90s | 147 | 0ms | 26,953ms | 5 / 1,725ms |
| 06:24:00 | ok | 36,536 | 86s | 147 | 0ms | 22,675ms | 8 / 1,388ms |
| 06:29:00 | ok | 36,536 | 89s | 147 | 0ms | 38,573ms | 12 / 1,725ms |

06:09 的首个部署碰撞样本 `id=25724` 不计入验收：它恰好在 `beforeAttempt` 保存后、helper 保存前加载了中间源码，journal 明确为 `ReferenceError: loadChannelControl is not defined`；permit/真实 attempts 均为 0。完整文件落盘后 06:10 work-queue 起已正常运行，随后 06:14–06:29 连续四轮验收均完整；86–90s 略快于 94s 回滚基线，无通道层退化。

### work-queue（`source=wikidot_tier2`, `mode=tier2`）

| started | status | claimed | processed | duration | requests | token delay sum |
|---|---|---:|---:|---:|---:|---:|
| 06:10:03 | ok | 50 | 50 | 48s | 64 | 0ms |
| 06:11:54 | ok | 50 | 50 | 66s | 88 | 5,771ms |
| 06:14:02 | partial | 50 | 50 | 137s | 69 | 81,293ms |
| 06:17:23 | ok | 50 | 50 | 156s | 75 | 107,212ms |
| 06:21:03 | ok | 50 | 50 | 203s | 96 | 142,835ms |

桶从满载进入耗尽后，worker 仍每轮认领 limit=50；第三轮显示它按 1,300/h refill 等待而非拒绝。`partial` 来自任务级业务健康判据，不是 claim 缩水，processed 仍为 50。

### forum-consume（`source=wikidot_forum`, `mode=forum`）

| started | status | claimed | processed | duration | requests |
|---|---|---:|---:|---:|---:|
| 06:21:16 | ok | 50 | 50 | 31s | 65 |
| 06:22:48 | ok | 50 | 50 | 140s | 66 |

该进程 journal 明确 `minRequestIntervalMs=0`；连续两轮均 50/50，显著高于旧 38/50 基线。第二轮 token delay 累计 350,708ms，证明空桶后按 900/h 补充等待仍能完成；它们与 work-queue/L1 同时运行，未借用 L1 token。

## 文件

- `migrations/0062_egress_token_bucket_fifo.sql`
- `src/http/egressCapacity.ts`
- `src/http/adaptiveEgress.ts`
- `src/cli/forum-scan.ts`
- `src/cli/forum-incremental.ts`
- `src/cli/image-ingest.ts`
- `tests/adaptive-egress.test.ts`
- `tests/operations.test.ts`
- `checks/0013_vote_snapshot_clock.sql`
- `checks/0014_egress_token_bucket_fifo.sql`

## 阻塞

无阻塞。
