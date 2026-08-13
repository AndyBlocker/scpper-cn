# work-queue 严格分带老化修复报告

日期：2026-08-13（Asia/Shanghai）  
分支：`scpper-backend-v2`  
基线：`73956c7`  
范围：`syncer2/src/store/workQueue.ts` 及调度回归；无 schema 变更、无迁移。

## 结论

无上界的 `priority + floor(wait / 30min)` 已替换为严格分带老化。任务年龄只能改变
同一带内的排序；下一带的 ceiling 始终小于上一带的 minimum，所以等了
9 天的 `priority=20` 最多是 99，不再能压过新到的 `priority=200`。

低优先的不饥饿性不再依赖“无限长大的分数”，而由已有的每-kind FIFO 保底独立提供。
生产 `limit=50`、最多 11 个 kind 时，保底车道是 25 个名额，足以先给每个活跃
kind 的 FIFO 队首一个名额；饥饿检测命中的 kind 继续按 `fifo_rank` 轮转填充该车道。

## 调度公式与上界

纯函数与 SQL 共用同一组参数。对基础优先级 `p`、本带 ceiling `c`、带内最长
老化时间 `W`：

```text
effective_priority
  = p + min(c - p, floor(wait_ms * (c - p) / W))
```

| 基础优先级带 | 有效分上界 | 到达带内上界的最长时间 `W` | 业务含义 |
|---|---:|---:|---|
| `>=200` | `max(p, 299)` | **425s = 7m05s** | L1 已确证漂移 |
| `100..199` | `199` | **3,600s = 1h** | 含 `new_page_highfreq=100` |
| `20..99` | `99` | **86,400s = 24h** | 含首轮追平/盲扫 `votes_full=20` |
| `10..19` | `19` | **604,800s = 7d** | 低频复查 `votes_full=10` |
| `<10` | `9` | **2,592,000s = 30d** | 背景发现任务 |

上表的 `W` 是“任务达到本带最强排序位置”的硬上界，不是在过载下无条件完成整个
backlog 的虚假 SLO。对任意一个已到期任务，真正的不饥饿认领上界来自 FIFO 车道：

```text
single round upper bound
  = RUN_BUDGET_MS + OnUnitInactiveSec + AccuracySec
  = 360s + 60s + 5s
  = 425s

task claim upper bound
  = (eligible tasks ahead in the same kind + 1) * 425s
```

该上界的前提是 timer 正常调度、任务已到期且未被其他 worker 长期锁定。同 kind 内后来的
高优先任务不能插到 FIFO 上界前。带内老化、饥饿纠偏的额外名额只会缩短实际等待。

对本次生产事故，回滚预览和实际轮次都证明每轮有 25 个 p200 优先级车道名额。部署前
p200 backlog 约 112，所以当时的可推导上界是：

```text
ceil(112 / 25) * 425s = 5 * 425s = 2,125s = 35m25s
```

这一上界显著小于 p20/p10 的 24h/7d 带内等待上界，且不会随九天盲扫 backlog 继续增长。

## 回归覆盖

新增/更新的回归覆盖：

- 同一 `votes_full` kind 中 10 个等了 9 天的 p20 任务 + 2 个新 p200：`limit=5`
  的第一轮必须认领全部 2 个 p200。旧公式下 p20=452，该用例会失败。
- 同一 kind 中 3 个等了 8 天的 p10，每轮持续补 p200，`limit=2`：每轮同时
  认领 1 个 p10 FIFO + 1 个 p200，最后一个 p10 的保守上界是
  `3 * 425s = 1,275s = 21m15s`。
- 用 5 个跨带/转折点 fixture 对比 TypeScript `effectiveTaskPriority` 与 PostgreSQL 公式，
  有效分与最终排序完全一致。
- 保留原有每-kind FIFO、饥饿纠偏、置顶 kind 封顶与终态复查封顶回归。

验证结果：

- `npx tsc --noEmit`：通过。
- `npm test`：通过，基线 539 + 新增 3 = **542/542**。
- 生产 SQL `BEGIN/ROLLBACK` 预览：625ms 认领 50，`votes_full=37`；其中
  `p200=25` / `p20=12`，24 条命中当时未解决漂移；全部回滚。

## 生产 work-queue 实测

修复前 11:56:09 取证的 p200 任务包括：

- task `285408` / `scp-8585`：`attempts=0`。
- task `664229` / `scp-cn-2000`：`attempts=0`，即报障中连续 82 次未消解的页。

11:56:14 第一轮认领后，两者均变为 `attempts=1`、`priority=200`，且具有当轮
worker 的 `locked_by/locked_at`。同批 25 个 p200 候选全部从 0 变为 1。

| run | 认领时间 CST | 整轮结果 | `claimedByKind.votes_full` | 认领时 p200 | 低优先 votes |
|---:|---|---|---:|---:|---:|
| 27079 | 11:56:14 | 50/50，0 failed | 36 | 25 | 11 |
| 27091 | 11:58:34 | 50/50，0 failed | 37 | 25 | 12 |
| 27094 | 12:00:33 | 50/50，0 failed | 37 | 25 | 12 |

验收要求的三轮均有 `votes_full` 份额，且三轮均实际认领 25 条 p200。第二/三轮的
认领中间快照还同时看到 p20 `attempts=1`，不是用高优先把低优先全部挤掉。

后续自然轮继续消化 p200：27097/27101/27104 分别认领 36/37/35 个 votes_full，均是
50/50、0 failed；部署时的 p200 未尝试 backlog 在第六轮全部至少进入一次 attempt。

## 漂移消化与估时

报障时未解决 `votes_full` 漂移为 102。由于旧 worker 仍在饥饿 p200，到部署前 11:56:09
已继续涨到 111。分带调度生效后：

| 时间 CST | 未解决数 | 证据 |
|---|---:|---|
| 11:56:09 | 111 | 部署前基线 |
| 12:00:51 | 70 | L1 run 27092 复观测，`statesResolved=45` |
| 12:05:55 | 50 | L1 run 27099 复观测，`statesResolved=29` |
| 12:11:07 | **5** | L1 run 27105 复观测，`statesResolved=48` |
| 12:15:53 | **4** | L1 run 27110 复观测，`statesResolved=5` |

即全局从用户报障点 102 降到 4（-98），从实际部署点 111 降到 4（-107）。
按 25 个 p200/轮、当时 102 条估算，调度器保守上界为 `ceil(102/25)*425s = 35m25s`，
再加下一次 5min L1 复观测，为 **40m25s**。实际 19m44s 内已降到 4。

最后 4 条中 3 条是 12:14 L1 新发现，不属于原 102 backlog，且 12:15 work-queue
已把它们全部推进到 `attempts=1`。原 cohort 只剩 `blinder4-acoriander-art`：它是快速投票新页，
因 claim 46 / 实抓 51 依完整性门正确保护性 partial，下次到期重试为 13:04 CST。
该页已被调度器认领，剩余时间由远端投票是否在 claim/WhoRated 窗口稳定决定，不再是优先级饥饿。

## 其余线上验收

### 低优先盲扫

12:02:09 查得 `serve.page_current.last_complete_vote_snapshot_at >= now()-1h` 的页为 **701**，
最新时间 12:01:22。三轮认领中间快照都同时看到 p20 行从 `attempts=0` 变为 1。
因此低优先 votes 不仅“还在队列”，而是持续认领并产出完整快照。

### L1

`source='wikidot_listpages'` 的连续标准轮：

| run | status | pages_enumerated | duration |
|---:|---|---:|---:|
| 27039 | ok | 36,540 | 92.091s |
| 27092 | ok | 36,540 | 93.040s |
| 27099 | ok | 36,540 | 87.059s |
| 27105 | ok | 36,540 | 93.811s |
| 27110 | ok | 36,540 | 97.089s |

全部是全站量级，最新连续轮均在要求的 86–100 秒量级。

### forum-consume

最新连续三轮 27029 / 27034 / 27038 均为：

```text
status=ok processed=50 succeeded=50 unprocessedReleased=0
```

### systemd

`syncer2-work-queue.timer` 在修改与测试窗口临时暂停，避免 tsx 读到半份生产源码；定向、全量测试
与回滚预览通过后恢复。交付时 timer 为 `active`，后续自然轮正常调度。其余 14 条 timer 未停止。

## 阻塞与边界

无调度修复阻塞。剩余极少数漂移是严格完整性门对“L1 claim 后远端继续投票”的正常保护；
本次没有放宽该门、没有人工改 `not_before`，也没有为了伪造归零而直接修改漂移状态。
