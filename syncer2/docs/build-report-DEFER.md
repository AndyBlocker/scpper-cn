# v2 图片延迟语义与出口告警修复报告

观测与实施时间：2026-08-13 08:08–08:32 CST  
目标：`scpper-v2`（PostgreSQL 5434）  
代码基线：`scpper-backend-v2` / `56c4d2f`；未 commit、未 push

## 结论先行

`host_deferred` 现在同时满足三个互不冲突的合同：任务生命周期是可重试的 `pending`，按主机实际放行时间写 `not_before`；claim 增加的 `attempts` 会归还；健康度只把它记为未测量的 self-protection intermediate，不进入站点成功率分母。终态判断与健康排除判断已经拆成两个函数，今后不会再由同一个“确定性失败”布尔值同时裁决两个状态机。

用户快照中的 12,030 条在处理期间继续被旧 timer 终态化。修复代码首轮先救回 120 条；迁移 0064 随后又把当时仍为 `failed/host_deferred` 的 12,150 条恢复，因此本次实际纳入恢复队列共 12,270 条。迁移后 `failed/host_deferred=0`，并且生产轮次已从恢复标记 cohort 中实际取出、发 HTTP、成功或按真实结果重新分类，而不是只改状态字段。

`meta.egress_alert` 保留为不可变审计事件流，不人为添加一个与 `meta.egress_control` 重复的 episode 状态机。pending 视图改为只暴露 `pressure_level>0` 的当前 `egress_control` episode；预算节流和历史档位事件都不代表当前站点异常。正常态当前集合为 0 行，六个旧常红 episode 已全部 resolved；事务回归构造 `pressure_level=2` 后，当前集合立即出现一条可随恢复消失的红色 episode。

## 1. 图片语义拆分

### 代码合同

- `isImageFailureExcludedFromHealth()` 只回答“这个观测是否代表链路/站点压力”。它排除确定性坏资源以及 `host_deferred`。
- `isTerminalImageFailure()` 只回答“任务是否终态”。确定性资源错误仍终态；瞬时错误到达最大次数后终态；`host_deferred` 无论当前 attempts 多大都不是终态。
- `failJob()` 对 `host_deferred` 写 `pending`、未来 `not_before`、清锁并把 attempts 减一；对应 `serve.page_image` 回到 `queued`，不增加 `failure_count`，不覆盖真实抓取时间。
- 数据库时钟产生的亚毫秒等待值在落 PostgreSQL `bigint` 前向上取整。首轮生产触发暴露的 `invalid input syntax for type bigint` 因此已消除。

### 同类问题巡检结果

还发现一处完全同类的自我保护/真实动作混淆：外部图片 gate 原先在判断“等待超过 20 秒、本轮放弃”之前，就写 request bucket 并推进 host/global `next_permit_at`。因此没有发生的 HTTP 也消耗 permit，每轮 120 个 defer 继续把下一许可推远，最终形成约 11 天的虚假债务。

修复后先读取当前许可时间；若需 defer，直接返回且不写 bucket、不推进许可、不计 runtime permit。只有本轮能实际等待并发 HTTP 的请求才写 bucket。08:17 轮的证据是 `requests=120, attempts=0, permits=0`；修复前相同轮次则是 `requests=120, attempts=0, permits=120`。

迁移 0064 只清理了 systemd JSON 汇总逐轮证明 `external attempts=0` 的固定事故窗 `2026-08-13 07:20–08:18 CST`：共 1,200 个虚假 permit。四个由此误入 `rolling_* budget breach` 的 host 回到 level 0，global/host 虚假许可债务归零；既有真实 429/503/失败率档位没有重置。时间窗写死，迁移日后重跑也不会误删新请求。

0064 的 gate rebase 还以“本次固定窗确实找到事故行”为前置条件；空集重跑不会再次改当时的真实 gate 状态。活库第二次执行显示 `failed/host_deferred=0` 并无副作用，验证了这个幂等护栏。

## 2. 恢复数据与实际状态变化

### 全队列实测

| 状态 / failure_class | 08:17 修复前 | 08:20 数据恢复后 | 08:28 首轮真实重试后 |
|---|---:|---:|---:|
| completed / null | 57,234 | 57,234 | 57,239 |
| failed / host_deferred | 12,150 | 0 | 0 |
| failed / blocked_host | 159 | 159 | 159 |
| failed / http_permanent | 804 | 804 | 806 |
| failed / invalid_content_type | 787 | 787 | 789 |
| failed / http_transient | 0 | 0 | 2 |
| failed / network | 0 | 0 | 45 |
| failed / timeout | 0 | 0 | 5 |
| failed / too_large | 7 | 7 | 7 |
| failed / unknown | 2 | 2 | 2 |
| pending / host_deferred | 120 | 12,270 | 12,207 |
| pending / null | 7,458 | 7,458 | 7,458 |
| pending / http_transient | 689 | 689 | 689 |
| pending / network | 3 | 3 | 5 |
| pending / timeout | 1 | 1 | 1 |
| processing / network | 2 | 2 | 2 |
| **总计** | **79,416** | **79,416** | **79,416** |

0064 同时恢复 12,150 个 `page_image` 为 `queued`，撤回造成终态的那一次 `failure_count`，并给 metadata 留下 `host_deferred_terminal_recovered_at` 审计标记。任务的最后错误证据没有删除。

### 确实重新处理

- 08:17 轮（批量迁移前、代码修复后）：120 个旧 `failed/host_deferred` 被重新 claim，结果全部是 `retry`，`healthExcluded=120`、健康失败率 0、exit 0；没有 HTTP attempt，也没有新增 permit 债务。
- 08:22–08:27 轮（批量迁移后）：从恢复标记 cohort 中有 63 条离开 `pending/host_deferred`：5 completed；2 http_permanent、2 invalid content type；2 http transient、45 network、5 timeout；另 2 条按 network backoff 继续 pending。该轮 request bucket 为 75 permits / 75 hosts，54 个真实压力失败，不再是 defer 伪造的请求。
- 08:32–08:37 的下一轮继续处理同一 cohort：本轮 claimed 63、completed 12、retry 13、failed 38；两轮完成后，恢复标记 cohort 已有 121 条离开 `host_deferred` 分类，累计 completed 14，`pending/host_deferred` 降到 12,029。本轮 64 个 external requests 产生 78 个含重定向的真实 attempts/permits。连续轮次消费已成立。
- 该轮 external 的真实失败率较高，所以 external 分账正确返回失败；`wikidot_site` 分账仍为 `ok`。这不是旧的 self-protection 误报复现。

### 消化速率与预计耗时

恢复队列当前分布于 94 个 host，最大单 host 2,176 条。生产第一轮对恢复 cohort 的首遍速度为 `63 / 298s = 761/h`；滚动稳定上限由 global 预算固定为 650/h，单 host 上限 300/h。约束下界是 `12,270 / 650 = 18.9h`，而最大 host 下界仅 `2,176 / 300 = 7.3h`，所以 global budget 是主约束。

据此，首遍重新尝试预计约 19–24 小时；需要真实网络重试的尾部还会走 1/2/4/8 小时指数退避，完整收敛按约 34–48 小时估计。这个估算不承诺所有资源成功，只承诺每条恢复任务重新获得真实处理机会并最终按资源结果收敛。

## 3. egress 告警：事件流与 episode 分离

选择“不为 `egress_alert` 补 resolved_at”。理由是它本来就是档位变化审计日志，事后仍需保留 `from_level/to_level/reason`；给每个历史事件制造 resolved 语义会重复实现一套状态机，并与已经权威保存当前状态的 `egress_control` 产生双真相。

0063 做了两件事：

1. 审计登记把 `meta.egress_alert` 标为 `not_pending`，不再从历史事件生成 pending collection。
2. `meta.pending_collection_current` 只在 `egress_control.pressure_level>0` 时生成 `egress_control:<site>` episode。`budget_level` 仍放入 evidence，但预算是我方容量保护，不单独制造站点故障 episode。

活库结果：正常态查询 `family IN ('egress_alert','egress_control')` 返回 0 行；旧 `egress_alert` 开放 episode 从 6 降到 0，并于 08:11 全部 resolved。回归在事务中构造 `wikidot pressure_level=2`，视图出现 `pending_count=1/pressure_level=2`；回滚后恢复 0 行。

## 4. running 孤儿收口

`reapStaleIngestRuns()` 的阈值从 6 小时改为 1 小时：最长生产短任务配置 25 分钟，1 小时仍有超过两倍余量，298 秒的正常 forum 优雅收尾不会被误伤。回收器由两个独立入口调用：每次 `startIngestRun()` 前，以及每 5 分钟的 oldest-pending 巡检前；即使没有新采集 run，也会收口孤儿。

回收写 `status=aborted`、`finished_at`，并在 stats 保存 `aborted_reason=stale_running_reaped`、阈值和回收时间。08:13 实测一次收口 14 条 `wikidot_forum` 和 16 条 `synthetic`；此前 6 小时旧阈值已收口 1 条 forum。未满 1 小时的 synthetic 行会保留到越线，避免把活跃或刚异常退出的进程误杀；08:37 复核已无超过 1 小时的 running 行。

## 5. forum catchup 判据核查

这不是“总量没有推进”：约 12 小时样本从 85,496 下降到 82,652，正常轮次也确实是 processed=30、released=20、约 298 秒。红色来自另一个事实：最老 key 从 02:56 起一直是 `id=1461`，跨过 6 小时 critical 窗仍未换人。

代码执行顺序解释了两者为何能同时成立：标准轮预留 30 个 discussion + 20 个 forum，但先处理 discussion；时间预算耗尽后，20 个尚未执行的 forum 才被释放。释放路径已经归还本轮 claim 的 attempt，因此它们没有被报成“本轮失败”；然而相同 forum 队头可连续多轮得不到执行，是真实的 lane 饥饿。`catchup_head_stalled` 因而没有把“只做 30 个”本身误判为故障，而是在总量继续下降时保留了对饿死队头的检测。该公平性问题不阻塞本次图片/告警修复，但后续应调整两 lane 的执行交错或为 forum quota 保留时间预算，不能靠放宽告警消音。

## 6. irreconcilable files 趋势

开放 `files` 仍为 97 条；97 条全部在 2026-07-27 首次进入，最近 24 小时、7 天和 14 天新增均为 0。按既定决定不修复、不改状态。

## 7. 回归与生产旁路验证

- `npx tsc --noEmit`：通过。
- 定向回归（host defer、egress episode、orphan reaper）：25/25 通过。
- `npm test`：523/523 通过（基线 519，加本次 4 条回归）；并发误跑一次因活库竞争出现 522/523，停止并发后单进程完整重跑全绿，没有改旧断言。
- L1：08:04 至 08:34 连续七轮 `status=ok`；每轮 `resolved+unresolved=36,536`，耗时 86.2–98.9 秒（恢复后的最近三轮 91.6、93.3、91.2 秒）。
- 图片文件：没有执行修改或删除既有文件的操作；worker 只按既有 SHA 内容寻址成功路径新增资产。
- 外部副作用：未触碰 QQ 工程，未发送任何 QQ 消息；所有本次告警写入/测试均仅在 PostgreSQL 事务和本地日志内。

## 8. 变更清单

- 迁移：`0063_deferred_and_egress_episode_semantics.sql`（先应用，再启用依赖代码）；`0064_recover_host_deferred_jobs.sql`（数据恢复与固定事故窗 permit rebase）。
- 图片：`src/image/health.ts`、`worker.ts`、`externalEgress.ts`、`src/cli/image-ingest.ts`。
- 可观测性：`src/observability/oldestPending.ts`、`src/store/meta.ts`。
- 回归：图片与 observability 测试文件。

当前无本次交付阻塞。剩余运营项只有恢复队列按预算自然消化，以及独立的 forum lane 公平性后续工作。
