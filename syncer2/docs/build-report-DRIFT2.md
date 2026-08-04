# DRIFT2：持续单票差异取证与 DRIFT 验证

## 结论

持续恰好差 1 票的主因已经定位：**Wikidot 的 WhoRatedPage 会为同一个自然账号返回
重复投票行，而 v2 的 `vote_current` 按 `(page, voter)` 保存唯一当前票。**
L1 的 `%%rating%%` / `%%rating_votes%%` 在这些页面上跟随或至少等同于前者的原始重复行
口径，并不等于唯一投票人集合。重复行通常同向，少量页面同一账号同时出现正负两行。

因此：

- `serve.page_current` 没有算错；本轮 442 个 `|rating delta|=1` 页面中，
  442/442 的 rating/up/down 都与 `serve.vote_current` 直接聚合完全相同。
- 这不是“没抓”：442 页最新投票扫描为 partial 407、failed 18、ok 17；
  其中 403 页已经至少重复得到 3 次 `is_complete=false`，单页扫描总次数为 3–11。
- 这也不是普遍的缓存瞬时差：2026-07-28 留存的现场清单已经把 455 个 partial
  分成同向重复 436、正负冲突 19；当前 442 页中有 412 页仍在该清单内。
- 不能用 `±1` 容差。只有拿到并持久化“原始重复行证据”且满足本文的严格判据时，
  才可编码成已知合法来源差异。

本轮没有访问 Wikidot：**新增站点请求为 0**。根因由 v2 只读查询、既有
`page_scan` / `ingest_run` 证据，以及 2026-07-28 已留存的现场清单闭环，不需要给
限流边缘的站点增加请求。

## 执行边界

- 只在工作目录
  `/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation` 内读取和写本报告。
- 数据库连接由 `backend/.env` 派生并明确改为 `scpper-v2`；取证会话同时设置
  `default_transaction_read_only=on`。
- 未连接或修改 v1，未移除 `SYNCER2_V1_DATABASE_URL` 的只读参数。
- 未访问 `/home/andyblocker/qqbot`，未运行 QQ 报告程序，未发送 QQ 消息。
- 未停止、重启或修改正在运行的源码回填。
- 除本报告外没有为 DRIFT2 修改实现。

## 1. `|delta|=1` 的库内取证

### 1.1 同一时点的全量交叉聚合

以下为 2026-07-30 23:58 CST 的一个只读快照。后台 L1/work-queue 仍在运行，数字会
缓慢变化；因此本节固定时点，不把后续变化混入同一张表。

| 指标 | 数值 |
|---|---:|
| 可按唯一 WID 对齐的 live 页 | 36,100 |
| rating 不一致 | 484 |
| 其中 `abs(local_rating-l1_rating)=1` | 442 |
| v2 少 1 分 / 多 1 分 | 392 / 50 |
| 这 442 页同时少 1 个计数 / 多 1 个计数 / 计数相同 / 其他 | 419 / 21 / 0 / 2 |
| `page_current` 与直接聚合 `vote_current` 不同 | 0 |

直接聚合使用：

```text
rating = Σ vote_current.direction
up     = count(direction = +1)
down   = count(direction = -1)
```

全库 `vote_current.direction` 当时为 `-1:184,993`、`0:4,642`、`+1:1,144,843`。
在 442 页样本中有 132 页含 310 条 `direction=0`，另外 310 页完全没有中立行；
两组都出现同样的单票差。因此 v2 对 0 分票的处理不是共同根因。

### 1.2 抓取证据

442 页的最新 `meta.page_scan(kind='votes')`：

| status | 页数 |
|---|---:|
| partial | 407 |
| failed | 18 |
| ok | 17 |

407 个 partial 中，405 个扫描结果的唯一行数和唯一行 checksum 与当前 v2 投影一致，
但不等于 L1 claim。403 页的结构化原因是 `is_complete=false`；这些页全部至少被扫描
3 次，也全部至少 3 次重复得到 incomplete。failed 中的主要确定性原因是同一身份出现
相反方向，而不是 HTTP 未抓到。

2026-07-28 的现场文件提供了不依赖当前解析日志文字的第二条证据：

- `docs/s3-live-remediation-2026-07-28.json` 将当时 455 个 partial 精确分为
  `wikidotDuplicateSameDirection=436`、`wikidotDuplicateOppositeDirection=19`、
  `unresolvedIdentity=0`、`other=0`。
- 当前 442 页有 412 页与该清单重合：396 页是同向重复，16 页是正负冲突。
- 396 个同向重复页中，394 页当时同时满足
  `claimedTotal - fetchedUnique = 1` 和
  `abs(claimedRating - uniqueChecksum) = 1`；另外 2 页的重复缺口为 2。
- 从该旧清单的全部同向重复页看，400 页都是精确多一条原始投票行。

这解释了为什么差异会长期稳定为 1：解析器看到重复自然身份后拒绝把快照宣告为完整；
v2 的唯一约束又不会把同一人的重复行物化成两张当前票。

### 1.3 排除其他候选原因

| 候选 | 证据 | 结论 |
|---|---|---|
| 已删/注销账号 | 442 页中 355 页有已删身份，但至少 55 个有确定重复行证据的页完全没有已删身份 | 可能共现，不是必要条件，也不是共同根因 |
| 匿名/保留段 actor | 442 页仅 9 页、13 个 active actor 落在 `2,000,000,000+`；严格样本中没有匿名/guest | 不是共同根因 |
| 0 分/中立票 | 310 页完全没有 `direction=0` 仍同样差 1 | 排除 |
| v2 聚合错误 | 442/442 与 `vote_current` 直接聚合一致 | 排除 |
| 未抓或一次性缓存延迟 | 全部已有抓取；403 页连续至少 3 次相同 incomplete；两日前清单仍可复现 | 排除 |
| WhoRated 与计数器口径不自洽 | 原始重复行能精确解释 claim 与唯一集合的 count/checksum 差 | 确认 |

“计数器不可信”的准确含义不是它随机错 1，而是它不能被当作**唯一投票人当前状态**
的真值；在这些页面上它保留了 WhoRated 原始重复行语义。v2 当前选择唯一自然 actor
语义是正确且更可审计的。

## 2. 是否编码为已知合法差异

建议编码，但必须命名为类似 `wikidot_duplicate_vote_row` 的**证据型来源差异**，
不得编码成数值容差。一个页面只有同时满足以下六条才可 suppress/resolve：

1. 新鲜 WhoRated 请求结构解析成功，不是 HTTP、截断、selector 或 absence 失败。
2. 重复行能归一到同一个明确的自然 actor。
3. 同一 actor 的重复行全部同向；任何 `+1/-1` 冲突仍进
   `irreconcilable`/人工复核。
4. 没有 unresolved identity、quarantine 或归一后的额外身份碰撞。
5. **原始**行数与原始 signed checksum 分别严格等于本轮 L1 的
   `rating_votes` 与 `rating`。
6. 去重后的唯一行数与 checksum 分别严格等于 `serve.vote_current` 的
   `up+down` 与 `Σsign`。

当前解析过程已有 `rawEntries`、`duplicateEntries`，但最终证据还应持久化
`rawSignedChecksum` 和重复项的 actor/direction 摘要。只有证据未变时才保留合法状态；
L1 claim、原始重复集合或本地唯一集合任一变化都应重开正常对账。这样不会掩盖真正的
单票漏抓，也不会把正负冲突误判为合法。

## 3. DRIFT 验证

### 3.1 三类要求的回归

三类回归均存在且在本轮全量测试中通过：

| 要求 | 回归证据 | 结果 |
|---|---|---|
| 静态差额被入队 | `incremental-drift.test.ts`：相邻成功 L1 值不变，第二次观测产生 `votes_full` | 通过 |
| 振荡/稳定差额不无限入队 | `work-queue.test.ts`：相同 result hash 两次退避，第三次写终态；发现侧不能重建 | 通过 |
| 超总量闸门告警并截断 | `incremental-drift.test.ts`：人口 100、差额 5、阈值 2，选 2、明确截断 3，检查日志 | 通过 |

`tests/incremental-drift.test.ts` 的 5/5 全部通过；其中还明确验证“差 1 不使用容差”、
终态只在远端实际证据变化时重开、完全对齐不入队。实现侧的原因
`l1_projection_drift_persistent` 已由 `work-queue` 接受。

### 3.2 567 → 485 收敛账

任务交接时点的可审计收支如下：

| 项目 | 页数 |
|---|---:|
| 起点 rating 差额 | 567 |
| 起点 cohort 仍在差额集合 | 478 |
| 起点旧差额退出 | 89 |
| 起点之后进入的差额 | 7 |
| 交接残余 | `567 - 89 + 7 = 485` |
| 写过 `votes_full` 不可调和终态 | 470 |
| 其中当前未解决 / 后来证据变化而 resolved | 455 / 15 |

这里的 470 是对当前/历史残余的**终态分类**，不是另一批可以与 89、7 相加的页面；
“转不可调和”表示停止高频重抓，不表示数值已经收敛。交接后 23:58 的同口径复核为
484：478 个起点 cohort 残余不变，后进入者从 7 减为 6，说明后台仍在自然收敛。

审计限制：迁移开始时只持久化了 rating/count 差额的 579 页并集，未单独冻结报告中
567 个 rating 页的 page-id 清单；状态行之后还会更新 local/remote evidence。
因此 89/7 是按 DRIFT seed cohort 复原的收支，不能事后生成逐页的“原 567”签名清单。
这不影响 485 的残余取证、470 的终态数或本报告的重复行结论，但下一次类似报告应在
起点额外保存 cohort manifest。

### 3.3 `revisions_full` 46 页

固定时点的 46 个 drift state：

| 项目 | 页数 |
|---|---:|
| drift state 总数 | 46 |
| resolved / open | 17 / 29 |
| 当前投影已对齐 / 仍不同 | 18 / 28 |
| 至少执行过一次 revisions scan | 46 |
| 最新扫描 ok / partial / failed | 21 / 24 / 1 |
| 历史写过 irreconcilable | 22 |
| 当前仍 open 的 irreconcilable | 0 |
| 当前仍在任务队列 | 24 |

24 个 partial 的主要形状是 RevisionList 返回的真实行数多于
`L1 %%revisions%% + 1`（常见为 parsed 2、L1 expected 1），另有少量更大差额和一个
`no_page`；并非 46 页未被处理。22 个历史终态全部因 L1 revision claim 后来变化而按
设计 resolved，24 页保留/重开任务，证明“终态证据变化才重开”路径也在真实数据上
生效。state open 29 与当前 mismatch 28 相差 1，是一个本地已对齐但尚待下一次成功 L1
观测关闭的状态，不是丢任务。

## 4. 全量测试结果

执行了用户指定的 `npm test`（串行 Node test runner）：

```text
tests 328
pass  327
fail  1
```

新增的 `tests/project-busy-gate.test.ts` 和全部 DRIFT/work-queue 回归均通过。唯一失败是
`tests/projector.test.ts` 的 B1 site overview：长达约 75 秒的 live-DB 投影事务使用
默认 `READ COMMITTED`，期间后台 work-queue 改变了 `serve.vote_current`，最终断言只剩
`votes_match=false`；定向复跑为 9/10，仍复现同一票表快照竞态。第一次全量运行还在
投影写阶段看到过并发 `serve.user_page` 唯一键竞争。

所以不能把本轮写成 328/328 全绿。该失败不是 DRIFT 功能回归，其他 327 项及三个指定
回归都通过；但要稳定满足“全量全绿”，projector 集成测试需要隔离测试库，或让 B1
在一致性快照/项目互斥锁下完成。为避免暂停正在运行的生产采集与源码回填，本轮没有
抢全局锁或停 worker 来制造绿色结果。

## 5. `transport_failure_rate=0.0000` 与单批 503

这不是计算漏项，而是当前字段的刻意定义较窄：

- `transportFailures` 只在最终失败且 `status === null` 时递增，即连接重置、超时等
  没有 HTTP 响应的传输错误。
- HTTP 503 有明确 status，因此进入 `business.statusBuckets['503']` 和
  `http_status_dist`，不会进入 `transport_failure_rate`。

两个实际失败 L1 run 的证据均为 `requests/batches=145`、failed=1、
transportFailures=0，且 fingerprint 明确保存
`http_status_dist={"200":144,"503":1}`。所以 503 对健康观测**可见**，只是不会触发
当前 parse-health 闸门：`1/145=0.69%` 低于该 population 的 10% 绝对上限，同时
rare-event 相对漂移要求本轮至少 5 个坏事件。run 自身仍正确标为 failed。

若运维语义要求“一批 503 就告警”，应新增 `http_failure_rate` 或独立的
`http_503_present` 运行告警；不建议把有 HTTP 响应的 503 混入
`transport_failure_rate`，否则会破坏该指标现有的网络传输语义。是否将单个 503
升级为 parse-health freeze 是策略调整，不是本次计算修复。

## 阻塞与后续

- **无 DRIFT/±1 根因阻塞**；零新增网络请求即可给出确定结论。
- **验证阻塞一项**：共享活库上的 projector 一致性竞态使本轮 `npm test` 为
  327/328，而不是全绿。需要隔离测试库或一致快照后才能关闭该验证项。
- 本任务按要求只报告，没有实现“重复行合法差异”编码，也没有修改/提交/推送源码。
