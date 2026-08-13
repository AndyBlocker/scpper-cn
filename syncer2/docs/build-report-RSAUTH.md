# RSAUTH：历史版本源码账号回填接入与生产验收

日期：2026-08-13（Asia/Shanghai）  
目标：`scpper-v2`（由工作树 `backend/.env` 的库名替换得到，端口 5434）  
结论：账号链路、权限终态、零产出告警和生产旁路验收均已落地；无阻塞项。

## 技术摘要

- 历史 `history/PageSourceModule` 复用了 adult 当前源码已有的受限身份路径：
  `loadRestrictedWikidotCredentials()` → `RestrictedIdentitySession` →
  `createRestrictedStableHttp()`。生产凭证身份已核对为 `scpper_mer_run`，没有创建第二套登录。
- 回填进程的探针、登录、历史源码请求及 pilot 当前源码交叉检查都使用同一个专用客户端；
  客户端把代理硬编码为 `http://127.0.0.1:7890`、TLS 上限固定为 1.2，且不读取通用
  `config.proxyUrl`。四轮生产摘要均为 7890，出口采样均为 `103.188.235.3`，未出现 7891。
- 先应用迁移，再保存引用新终态的 TypeScript：0067 新增 `unavailable` 并重排旧匿名
  `no_permission`；0068 以 `not_before` 提前认证复核债务，同时保留原 FIFO SQL 合同。
- 旧匿名权限失败不再无期限 retry。固定账号复核可得时正常存储；强制重登后仍
  `no_permission` 时进入 `unavailable` 终态。该状态表示“采集账号对该修订不可得”，
  不是本地/远端事实冲突，因此不归入 `irreconcilable`，也不是重复请求可恢复故障。
- `selected>0 && stored=0` 的连续轮次被持久化观测；连续 3 轮会写 error 日志、
  `outputHealth.alert=true`，并以 `revision_source_zero_output_streak` 让 run health 失败。

## 四轮认证复核实测

下表四轮都从带 `requeued_for_authenticated_7890_recheck` 标记的旧匿名
`no_permission` 债务中认领。`stored` 是完成 `apply_revision_source_full` 并关闭 job 的数量；
`blobsInserted` 是新建的内容寻址 blob 数；`done` 是轮后队列表快照。

| run | status | selected | stored | blobsInserted | authenticated unavailable | done（轮后） | proxy |
|---:|---|---:|---:|---:|---:|---:|---|
| 26884 | ok | 20 | 20 | 14 | 0 | 348,483 | 127.0.0.1:7890 |
| 26885 | ok | 20 | 20 | 17 | 0 | 348,503 | 127.0.0.1:7890 |
| 26890 | ok | 20 | 20 | 17 | 0 | 348,523 | 127.0.0.1:7890 |
| 26891 | ok | 20 | 20 | 18 | 0 | 348,543 | 127.0.0.1:7890 |

结果：四轮合计 `stored=80`、`blobsInserted=66`，认证复核债务从 2,468 降到 2,388。
恢复 timer 后，systemd run 26976 又取得 `stored=175`、`blobsInserted=154`；最终
`done=348,718`，较用户给定基线 348,120 增加 598，其中本表四轮净增 80。
本次开始观察时 `retry=1,220`（用户给定基线 1,205），最终为 6；新增的 1 条是
systemd 轮在 200 秒预算边界归还的未完成 claim，并未烧掉 attempt。

## 两类 no_permission 的分类

1. **匿名拒绝、账号可得**：四轮验收实测 80/80；连同 timer 恢复后的生产轮共 255/255，
   全部正常落库并进入 `done`。
2. **账号重登后仍拒绝**：本次 255 条实测中为 0，生产当前 `unavailable=0`；构造回归已覆盖
   此分支并断言结果为 `authenticated_no_permission`、job 写入 `unavailable`、
   `emptyResult=false`，不会进入 retry。当前唯一 `irreconcilable=1` 是独立的
   `revision_error`（Wikidot revision 1545662746），不是权限拒绝。

0067 把旧匿名结论重新开放，是因为访问前提已改变；0068 让这批债务优先进入账号复核，
不让它们继续排在普通 pending 后。尚余 2,213 条会由已恢复的定时器继续分类。

## session 失效与空结果防护

- 首次 `no_permission` 或登录重定向先强制重登一次；登录请求失败、凭证拒绝、缺 cookie、
  重登后请求异常均抛 `RestrictedSessionUnavailableError`。
- worker 遇到 session 错误会归还当前 claim、归还本次 attempt、停止本轮，并记录
  `emptyResult=false`、`deletionInference=false`；缺凭证时在认领前就显式降级。
- 这条路径不产生空源码、不把任务计为 processed/failed，也不调用任何删除推断逻辑。
  墙钟预算异常保持原类型上抛，不再误报成 session 失效。

## 零产出可观测性

每轮 `meta.ingest_run.stats.outputHealth` 都记录 `selected`、`stored`、`blobsInserted`、
`consecutiveZeroOutputRuns`、阈值和告警状态。只累计确实认领过任务的零存储轮次；
`selected=0` 不制造告警，任一轮 `stored>0` 会清零连续计数。构造回归验证第三轮触发告警，
本次四轮的 `outputHealth.alert` 均为 false，原因是每轮都有实际写入。

## 生产旁路验收

- L1 连续 run 26886 / 26927 / 26975 均 `status=ok`、`pages_enumerated=36,540`；
  耗时 116.1 / 100.4 / 95.9 秒。首轮与手工认证复核重叠；最新一轮与 systemd 正式回填
  并发仍处于 95.9 秒全站量级。
- forum-consume：run 26883、26899、26964 均为
  `claimed=50 processed=50 succeeded=50 unprocessedReleased=0 failed=0`。
- work-queue：run 26895、26929、26971、26979 均为
  `claimed=50 processed=50 unprocessedReleased=0 failed=0`。

## 回归与方法

- `npx tsc --noEmit`：通过。
- 新增定向回归：6/6 通过，覆盖 session 失效显式降级、7890 fail-closed、账号仍无权限终态、
  预算异常保真，以及连续三轮零产出告警。
- 调度与认证定向合跑：10/10 通过。
- 最终 `npm test`：539/539 通过（原基线 533，加本次 6 个用例），0 failed / 0 skipped。
- 四轮生产证据直接读取 `meta.ingest_run.stats` 与
  `meta.revision_source_backfill_job`，不是以 pending 下降代替产出。

## 限制与运维说明

- 本次 255 条认证复核没有遇到真实的“账号仍无权限”样本，因此 `unavailable` 的生产计数仍为
  0；其终态行为由构造回归和已应用的数据库约束覆盖，不能把它误报成已有生产样本。
- 通用 mihomo 连接归因把 7890 对 Wikidot 的下游规则标为 `DIRECT`，因此启动探针仍会发出
  旧的“代理泄漏”告警；这不表示客户端绕过 7890 listener。四轮客户端物理入口均为 7890、
  出口采样稳定为同一 IP，且没有接触 7891 轮换 listener。该观测差异不阻塞本次账号安全约束。
- revision-source timer 已恢复为 active；恢复后的补跑退出码为 0，下一次触发为 11:55 CST。
