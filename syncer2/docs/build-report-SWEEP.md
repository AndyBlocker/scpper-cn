# SWEEP：投票追平、稳态轮转与新鲜度复核

日期：2026-08-04（Asia/Shanghai）  
分支：`scpper-backend-v2`

## 结论

本任务的调度改造已完成：周期配置已真正进入 SQL 参数；历史同秒快照按 `page_id`
稳定 MD5 相位摊到整个周期；首轮 v2 真抓与稳态盲扫分成独立 reason 和独立墙钟预算；
播种额度持久化到 `meta.vote_seed_budget`，不再随 work-queue 轮次频率增长。

`0035_vote_sweep_scheduler.sql` 已单独应用到明确的 `scpper-v2`。迁移没有改写任何
`last_complete_vote_snapshot_at`，只新增调度状态；没有访问 v1 写路径，也没有触碰
`src/collect/revisions.ts`、`ingest.revision.type`、`/home/andyblocker/qqbot` 或 QQ。

严格的 15 分钟端到端目标目前仍未达成。L1 本身已是 15 分钟级，但活库有约 536 个
优先级高于新 L1 投票任务的到期普通任务；共享队列没有 realtime 专属配额，估算排队约
60–65 分钟。当前普通投票变化的端到端约 70–80 分钟，瓶颈是队列 head-of-line，
不是 L1 抓取或本次 sweep 播种。

## 1. 装饰品常量审计

已确诊的 `VOTE_SWEEP_INTERVAL_DAYS` 之外，还发现 3 个同类参数；合计 4 个常量、
7 处 SQL 判据此前没有真正服从常量：

| 常量 | 原硬编码位置数 | 修复 |
|---|---:|---|
| `VOTE_SWEEP_INTERVAL_DAYS` | 1 | 稳态相位周期由 SQL `$4` 传入 |
| `VOTE_SWEEP_ACTIVITY_DAYS` | 1 | recent activity 窗口由参数传入 |
| `NEW_PAGE_WINDOW_DAYS` | 4 | 退役、高频播种、全队列认领、vote-only 认领全部参数化 |
| `NEW_PAGE_INTERVAL_HOURS` | 1 | 高频快照间隔由参数传入 |

文件内仍有两个 `interval '7 days'`，它们属于 `meta.irreconcilable` 的独立周复查协议，
没有对应的导出配置常量，不是本缺陷的漏修；`interval '2 hours'` 是死锁回收边界，同理。

回归不只检查源码字面量：用同一批 10,000 个 page_id 分别代入 30 天与 15 天，断言
实际合格集合变化；同时锁定 SQL 的周期参数和 JS/PG 两侧 MD5 相位逐值一致。

## 2. 稳定相位：消除 08-27 惊群

对每页取 `md5(page_id)` 前 60 bit，并映射到 `[0, interval)`；下一次到期点是
“上次完整快照之后的第一个该页稳定相位”。所以即使 33,191 页的历史时间戳同一秒，
它们的下一到期点仍覆盖完整 30 天。成功抓取继续正常推进原有
`last_complete_vote_snapshot_at`，无需伪造或回写历史时间。

按需求给出的 34,254 页构造同秒快照，30 个日桶结果为：

- 理论均值：1,141.8 页/日；
- 实测最小：1,060 页/日；
- 实测最大：1,232 页/日；
- 最大桶仅为全量的 3.60%，不再是某天 100% 集体到期。

首轮追平期间稳态车道关闭；因此旧时间戳在 08-27 到达原固定边界时也不会制造第二次
全站入队。追平完成后，新 v2 快照时间加稳定相位继续保持均匀。

## 3. 墙钟预算：与轮次频率解耦

新增 `meta.vote_seed_budget(budget_key, window_started_at, used, updated_at)`。播种先在事务内
锁住车道小时账本，再取 `quota - used`，候选插入与额度扣减同事务提交；进程重启、并发
轮次或 systemd 加快都不会清掉本小时用量。已存在的 `scan_task` 幂等冲突不消耗额度。

稳态小时额度不是写死 48，而是按当前合格页数和周期计算。用累计取整把小数速率分成
相邻整数小时额度，完整 30 天的 720 个小时额度之和严格等于合格总量：

```text
hourly quota = floor(N*(hour+1)/720) - floor(N*hour/720)
```

对 N=34,254，额度在 47/48 之间轮转；活库审计当时的 90d 合格口径约 31.2k，额度为
43/44。回归分别模拟一小时 12 轮和 24 轮，追平车道都只得到 832，稳态车道都只得到
该小时的 47/48，而不是 `轮数 × 50`。

`new_page_highfreq` 是 3 小时实时保护，仍按页面快照到期条件幂等补齐，不占低优先盲扫
预算；L1 检测出的真实变化也直接入队，不被 sweep 小时额度延迟。

## 4. 首轮追平与稳态

新增 `meta.vote_sweep_page_state`，只有真实 work-queue 完整 WhoRated 成功才写入。升级审计
发现 `source='wikidot_tier2'` 中有 33,175 页其实是 `mode='tier2_replay'` 的 v1 观测重放；
迁移明确只承认 `mode='tier2' AND domain='work_queue'`，避免把 v1 重放伪装成 v2 真抓。

两条车道可直接从队列 reason、预算键和进度表区分：

| 阶段 | reason | 预算键 | 小时额度 | 优先级 |
|---|---|---|---:|---:|
| 首轮追平 | `votes_v2_initial_catchup` | `vote:catchup` | 832 | 20 |
| 稳态盲扫 | `votes_sweep_stable_phase` | `vote:sweep` | N/(30×24) | 10 |
| L1 真实变化 | `l1_rating_or_rating_votes_changed` | 不受 sweep 预算 | 即时 | 35+ |

追平剩余数大于 0 时使用 catchup 车道；归零后自动切到 sweep 车道，小时需求从 832 降到
约 48（活库当前约 43/44）。按需求给出的 34,254 页和 832/h，纯容量耗时 41.2 小时；
活库迁移时固化了 2,283 个真实 work-queue 完整页，按 90d、终态隔离等实际合格条件
剩余约 29.1k，纯容量约 35 小时。实际完成时间会因实时任务和其它 kind 共享队列而更长。

可观测 SQL：

```sql
SELECT count(*) AS v2_completed FROM meta.vote_sweep_page_state;

SELECT reasons, count(*)
FROM meta.scan_task
WHERE kind = 'votes_full'
GROUP BY reasons
ORDER BY count(*) DESC;

SELECT * FROM meta.vote_seed_budget ORDER BY budget_key;
```

## 5. 端到端新鲜度

口径是普通单票变化（会改变 `rating` 或 `rating_votes`），从站上发生到
`serve.vote_current` 在 `ingest.apply_vote_snapshot` 同事务更新完成。完全抵消且两个 L1
计数器都不变的多事件组合无法由 L1 看见，只能等稳态盲扫，最坏仍接近 30 天；这是盲扫
专门兜底的罕见情形，不应混入普通单票延迟。

### L1 检测延迟

活库最新轮次已出现 `:07/:22/:37/:52` 的 15 分钟节拍；最近样本完整扫描平均约 79.2 秒，
最大约 81.1 秒。保守按整轮结束才算信号落库：

- 平均：等待下一轮 7.5 分钟 + 扫描 1.32 分钟 = **约 8.8 分钟**；
- 最坏：等待 15 分钟 + 扫描 1.35 分钟 = **约 16.4 分钟**。

所以即使空队列，15 分钟也只是典型目标，不是严格 worst-case SLO。

### 排队延迟

审计时有约 536 个已到期、非置顶且优先级 `>35` 的任务排在新 L1 投票任务之前；
置顶配额最多拿 20/50，普通车道约 30 条/轮。提速后的近期 work-queue 一轮约 2.4 分钟，
再加 `OnUnitInactiveSec=1min`，普通车道约 500–520 条/小时。因此当前 head-of-line 等待约
**60–65 分钟**。追平优先级 20、稳态优先级 10，不会排到 L1 变化任务前面。

### 抓取耗时与总延迟

Tier2 请求下限为 2 秒；近期 50 条整轮约 141–146 秒，等效每条约 2.8–2.9 秒。任务一旦
认领，单页远端抓取、解析和事务应用通常为数秒；考虑它在该轮中的位置，认领后完成为
**0–2.5 分钟**。

当前估算：

```text
普通情况：8.8m L1 + 60~65m 排队 + 数秒抓取 ≈ 69~74m
保守情况：16.4m L1 + 60~65m 排队 + 最多约 2.5m 轮内等待 ≈ 79~84m
```

因此当前没有达到 15 分钟级。主瓶颈是共享队列中 536 个更高优先级任务，没有给
`l1_rating_or_rating_votes_changed` 保留 realtime 配额；次要边界是 15 分钟 L1 周期本身
加 80 秒扫描已让 worst-case 超过 15 分钟。要把目标变成硬 SLO，后续至少需要为 L1
投票变化设置独立认领配额/车道，并把严格最坏目标放宽到约 20 分钟，或进一步缩短 L1
周期。该问题按本任务要求只做复核和定位，没有擅自扩大范围改变全队列优先级策略。

## 6. 验证

- `npx tsc --noEmit`：通过。
- 定向调度回归：41/41 通过。
- `npm test`：首轮 367/368；唯一失败为活库 `projector.test.ts` 的并发
  `user_stats_pkey` 重复键，与本改动无关。未改断言，按要求单独重跑同文件后 11/11 通过。
- 新增 5 项回归覆盖：周期改变合格集合、同秒快照日桶、轮次翻倍预算不变、完整周期
  额度守恒、追平/稳态切换和 reason 区分。
- `git diff --check`：通过。
- PostgreSQL/TypeScript MD5 相位样本逐值一致；0035 迁移成功应用于 `scpper-v2`。

没有 git commit，没有 push。
