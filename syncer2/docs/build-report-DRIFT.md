# DRIFT：L1 声明值与事实投影的持续对账

## 结论

本次把 L1 从“只看相邻两轮声明是否变化”扩展成了两条互补路径：

1. 原有增量路径继续处理 `diff.voteChanges` / `diff.revisionChanges`。
2. 新增对账路径每个完整 L1 都比较当前 L1 声明与 `serve.page_current` 的事实投影；
   静态差额即使 L1 本轮完全没变，也会被持续观测并在第二个连续成功 L1 后进入深扫。

对账覆盖全部三个可由 L1 观察的计数口径：

| L1 声明 | 本地事实投影 | 任务 |
|---|---|---|
| `rating` | `page_current.rating` | `votes_full` |
| `rating_votes` | `page_current.vote_up + vote_down` | `votes_full` |
| `revisions`（零基最大修订号） | `page_current.revision_count`（真实行数） | `revisions_full`，比较 `revisions + 1` |

没有使用 ±1 容差。单票时差由“连续两轮”滞回吸收；深扫后仍差 1 的页面沿用执行侧
`stable_count`，相同结果先指数退避，第三次进入 `meta.irreconcilable`，常态七日复查，
不会被每轮 L1 重新塞回常规队列。

## 执行边界与安全检查

- 只修改
  `/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation/syncer2`。
- 实际写库为 `scpper-v2`；迁移自身也拒绝
  `scpper-cn/scpper_cn/scpper-syncer/scpper_user`。
- 未修改或使用 `SYNCER2_V1_DATABASE_URL`，未连接 v1 写事务。
- 未访问 `/home/andyblocker/qqbot`，未运行 `qq-report`，未发送 QQ 消息。
- `.env` 的有效配置经脱敏核验：
  `database=/scpper-v2`、`proxy=127.0.0.1:7891`、UA/Referer 均非空。
- 源码回填没有被停止、重启或修改；本任务期间 `source_sha IS NOT NULL` 从
  83,057 持续增长，见后文观测。

## 开始时的数据库快照

执行开始的只读快照（2026-07-30 18:25 CST）仍精确复现任务给出的核心规模：

| 指标 | 数值 |
|---|---:|
| live pages | 36,122 |
| 有唯一 `page_id` 的新鲜 L1 对齐页 | 36,096 |
| rating 不一致 | 567 |
| v2 低于 L1 | 496 |
| v2 高于 L1 | 71 |
| rating delta | -614 .. +12 |
| voteCount 不一致 | 579 |
| revisionCount 不一致（已应用 `+1` 口径） | 30 |
| 最大 rating 缺口 `scp-cn-2801` | 2534 vs 3148，delta=-614 |

需要说明一个执行时点差异：任务诊断完成后，既有 work-queue 仍在运行。到本任务开始时，
567 页中已经有 555 页存在 `meta.page_scan.kind='votes'` 证据、412 页已有未解决
`meta.irreconcilable(kind='votes_full')`，另有 51 页有任务。这里不是修改诊断结论：
`page_scan` 的词表是 `votes`，任务词表才是 `votes_full`；而且这些既有扫描绝大多数是
partial/failed，并没有让 567 个 rating 差额消失。

开始时 567 页的最新投票扫描状态为：

| 最新 `page_scan(kind='votes')` | 页数 |
|---|---:|
| partial | 443 |
| failed | 33 |
| ok | 79 |
| 尚无任何 votes scan | 12 |

既有未收敛证据主要不是网络失败：最新证据中 440 页为
`is_complete=false`，22 页为同一身份同时出现正负方向，12 页触发单页 absence 熔断，
12 页缺成功 L1/Tier1 claim；只有 1 页是 HTTP 状态错误。

## 实现

### 1. 跨轮对账状态

迁移 `0032_incremental_drift_reconciliation.sql` 新增
`meta.incremental_drift_state`，主键 `(page_id, kind)`，保存：

- 首次/最近发现时间；
- 最近形成差额的完整 L1 run；
- 连续观测次数；
- 本地与 L1 的结构化计数证据；
- 最近通过总量闸门的时间；
- resolved 时间。

迁移用已有的成功 `incremental_page_state` 重建第一轮证据，零网络请求。重建时只接受：

- `serve.page_current.status='live'`；
- L1 state 的 `page_id` 与 live page 精确一致；
- 该 slug 在 live 投影中唯一。

因此 `scp-9311` 的两个 live WID（`1469066352`、`1469066350`）没有被猜成同一身份，
也没有生成对账任务。

### 2. 连续观测滞回

`advanceDriftObservation` 的 streak 只在以下条件递增：

- 当前 L1 run 与上次记录不同；
- 上次记录未 resolved；
- 上次记录的 run 恰好是该 slug 的上一轮成功 L1 run。

同一 run 的幂等重放不会加次数；中间缺轮、失败轮或已解决后复发都从 1 重新开始。
`consecutive_observations >= 2` 才有资格入队。

### 3. 执行侧收敛终态

发现侧仍通过统一 `enqueueScanTasks` 入队，所以不会覆盖执行侧的：

- `attempts`
- `stable_count`
- `last_result_hash`
- `not_before`
- 锁状态

扫描成功即删除任务；partial/failed 使用现有指数退避。相同结果哈希第三次仍无法满足
L1 claim 时，原子写入 `meta.irreconcilable` 并删除常规任务。之后每轮对账都会跳过该终态。

补充的重开判据：如果 `irreconcilable.remote_value` 中的实际声明值后来发生变化
（不是仅 `run_id` 变化），旧终态证据已过期，对账层会原子标记其 resolved，并以
`l1_projection_drift_terminal_evidence_changed` 原因重新入队。这个更新还会比较读取时的
旧 `remote_value`；若 worker 在读取与更新之间刷新了终态，CAS 不命中，不会误重开。
字段不足时不猜，保持终态。

### 4. 总量闸门

闸门按“不一致页面”而不是任务数计数，阈值为：

```text
min(ceil(live_population * 2%), 2000)
```

同一页若同时需要 votes/revisions，会作为一个页面一起保留，避免半页修复。超过阈值时：

- L1 明确写 error 日志；
- run stats 记录 discovered/eligible/selected/truncated；
- 只允许阈值内页面的任务通过；
- L1 run 判 failed 且不推进成功基线；
- 日志消息必须包含“明确截断 N 页”，没有静默 `slice()`。

当前 36,122 live 页的阈值为 723。

### 5. 请求速率

`HttpClient` 增加并发安全的最小请求启动间隔，间隔作用于每个真实 HTTP 尝试，
包括 retry 和 revisions 分页。work-queue 只有在认领批次包含
`l1_projection_drift_persistent` 时才启用 10,000ms，避免无关维护任务被永久降速。

首个真实补账批次中，6 个页面扫描的时间范围为
18:39:18.868–18:40:15.526，约 57 秒；完整 run 的 10 个业务请求耗时约 95 秒，
实测没有 50 页瞬时突发。

## 真实观测

### L1 第 1 轮（2026-07-30 18:37）

timer 自然启动，未手工触发。`ingest_run.id=4794`：

| 指标 | 数值 |
|---|---:|
| status | ok |
| ListPages 请求 | 145 |
| pages enumerated | 36,231 |
| live projection population | 36,122 |
| 唯一身份对齐 | 36,089 |
| 任一计数不一致页 | 631 |
| votes_full 不一致 | 606 |
| revisions_full 不一致 | 28 |
| 达到两轮持续页 | 607 |
| 既有终态抑制 task | 426 |
| 通过闸门页 / task | 181 / 182 |
| 身份冲突隔离 | 1（`scp-9311`） |
| 闸门阈值 / 是否触发 / 截断 | 723 / 否 / 0 |

631 大于最初的 567，是因为这里按任务要求同时计入 voteCount、revisionCount，并且
18:07→18:37 之间又出现了新的真实 L1 变化；它仍低于 2% 闸门。

### work-queue 首两批

两批都确认 HTTP 100% 为 200，且按 10 秒间隔运行；退出 1 的原因是既有页级失败熔断，
不是代理/429/503：

| run | processed | ok | failed | 结果 |
|---|---:|---:|---:|---|
| 4796 | 9 | 3 | 6 | 2 个 revisions + 1 个 content 成功；6 个 votes 身份方向冲突退避 |
| 4799 | 6 | 1 | 5 | 1 个 new-page votes 成功；5 个 votes 身份方向冲突退避 |

失败任务全部保留稳定冲突哈希和具体 actor，例如
`scp-cn-2801` 是 `wikidot:6422109` 同时出现 `+/-`。未处理锁分别释放 41、44 个，
失败页进入 `not_before`，下一轮会跳过它们继续后续任务，不会在一分钟 timer 上紧循环。

### L1 第 2 轮与最终存量

见文末“最终复验”；该节在第二个 timer 自然轮完成后冻结数字。

## 回归与静态验证

新增/加强的回归：

1. 静态差额、L1 本轮值完全不变：第二次连续观测仍产生 `votes_full`。
2. 抓完仍差 1：不使用容差；相同 hash 先两次退避，第三次进入
   `irreconcilable`，发现侧再次看到也不能重建任务。
3. 超总量闸门：100 页人口、5 页差额时阈值 2，入队 2、明确截断 3，日志字符串含截断量。
4. 三项计数完全一致：不产生任务。
5. 终态远端声明不变：不重开；声明真实变化：重开；只有 run id 变化：不重开。
6. HTTP 请求启动间隔：两个连续请求不能突破配置的最小间隔。

已通过：

- `npx tsc --noEmit`
- `npx tsc -p tsconfig.tests.json --noEmit`
- `npm test` 全量：145 suites / 322 tests / 322 pass / 0 fail
- 定向 `incremental-drift`、`work-queue`、`incremental-listpages`、`http` 测试
- `prisma/pull.sh --check`：102 models = 102 非分区表
- 迁移后 PUBLIC 可执行 SECURITY DEFINER 负向断言：0

## 最终复验

第二轮 L1 与后续 work-queue 仍在按自然 timer 观察。本节最终会给出：

- 原始 567 页的收敛前后数字；
- 当前全量 rating/voteCount/revisionCount 差额；
- 71 个 v2 多票页中由本轮 `revoke` 事件解释的数量；
- 每个未收敛页面的 slug、WID、delta、任务/退避/终态和精确失败原因；
- 两轮请求数、补账业务请求间隔和源码回填前后水位。
