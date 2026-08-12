# EGRESS：连接层压力可见性、平滑退让与两视角对账

日期：2026-08-12  
工作树：`feat__syncer2-foundation` / `scpper-backend-v2`  
基线：`31f33a2`

## 结论

本次盲区已关闭。真正没有取得 HTTP 响应的 DNS、代理 connect、TLS/握手、timeout、
socket reset 等 attempt 现在同时进入：

1. `meta.egress_request_bucket.failures` 压力分子；
2. 新的 `connection_failures` 子账；
3. 当前 100-request 窗口的 connection 子账；
4. 跨短进程持久化的短时连续失败 streak。

实际事故还暴露了比“有没有落桶”更具体的状态机缺口：底层 5 个 reset 已经落入当前窗口，
但本地断路器随即停手，100-request 窗口永远凑不满，所以 5/5 全坏仍不会裁决；其后 141 个
批失败是同一个 `CircuitOpen` 保护动作的派生结果，不是 141 个独立出站 attempt。修复因此
没有把 141 直接灌入压力分子，而是增加未满窗口也可裁决的稀疏连接信号。

## 迁移顺序

新增 `migrations/0056_adaptive_egress_connection_pressure.sql`，并在任何依赖代码生效前先
应用到从 `backend/.env` 派生且经库名守卫确认的 `scpper-v2`。迁移随后再执行一次，幂等
通过；没有改写历史迁移，没有访问 v1 写面。

迁移增加：

- request bucket：`connection_failures`；
- control：当前/上一窗口 connection 率、connection streak、最后失败/最后连接降档时间；
- `meta.egress_accounting_check` 持久对账单例；
- `pending_collection_current` 的 `egress_accounting_divergence` 集合；
- policy version 6 元数据。原 5%/10%/3%、六健康窗、3,500/h 和四档速率均未改变。

## 平滑与分级

完整窗口判据保持原合同：连续两窗 ≥5% 或单窗 ≥10% 逐级降一档；六个连续 ≤3% 健康窗
且满足本档保持期后只恢复一档；滚动 60 分钟 >3,500 仍直接进入 L3。

稀疏连接判据为：

- 2 分钟内连续 5 个无 HTTP 响应 attempt 才有资格触发；任一取得 HTTP 响应的 outcome
  清零 streak；稀疏分支不吃本地 header/结构错误，也不吃 `CircuitOpen` 派生拒绝；
- 一次只降一档；两次由连接信号消费的降档至少间隔 5 分钟；
- 持续不可用时，独立失败 burst 最快约在 0/5/10 分钟把 L0→L1→L2→L3；
- 同一瞬时 burst 即使合成 141 个连接失败信号，也只到 L1，保持期只有 L1 的 30 分钟，
  不会瞬间获得 L3 的 60 分钟冷却；真实执行中第五次 reset 后的派生 `CircuitOpen` 更不会
  重复记账。

阈值 5 复用既有断路器标定：实测传输基线约 2.3%，独立近似下连续五败约 `6e-9`；2 分钟
覆盖单请求 30 秒 timeout 与短退避，避免跨长空闲拼接；5 分钟至少跨一个高频调度周期，
同时让本次持续至少一小时的不可用在 10 分钟内可达最高保护档。健康压力噪声 0.76% 远低
于完整窗 5%，连接稀疏判据也早于 22.6% 危险区形成的批量结果。

## 确定性失败协调

GATE 的唯一业务分类源未改变。`deterministicFailureClass` 仍只把既有分类精确确认的空体
page-bound HTTP 500 改记 deterministic；`identity_absent`、`no_permission`、结构性拒绝
继续留在分母/审计但不进压力分子。只有 `status=null` 且没有被 deterministic 分类的真实
无响应 attempt 才属于 connection pressure，连接失败和确定性业务结论没有合并词表。

## 两视角对账

`schedule:oldest-pending` 每次在同一事务中刷新最近 60 分钟对账：

- ingest 侧：只取明确接入共享 gate 的 run，使用 `batches_total`，压力分子为
  `batches_failed - deterministicFailures`；
- gate 侧：同窗 `egress_request_bucket.requests/failures`；
- 两侧样本均至少 100，绝对差至少 5 个百分点且较高率至少为较低率 3 倍，才进入
  `divergent`；连续 15 分钟 warn，连续 60 分钟 critical；恢复对齐会显式清空 episode。

绝对差 5 个百分点与既有首档压力阈值同量级，3 倍比值避免两个都很高但接近时误报，双边
最小样本避免小样本除法噪声。确定性失败从 ingest 分子排除，保留 GATE 合同。

活库实际执行结果（01:44 UTC 的滚动窗）：ingest `441/2,976 = 14.819%`，gate
`5/3,300 = 0.152%`，绝对差 14.667 个百分点、97.8 倍；已写入
`meta.egress_accounting_check(status='divergent')` 并立即出现在 pending 当前面，未连接
QQ 或其它外部投递。

## 断路器 aborted 的退出语义

结论：连接断路器停手是自我保护动作，不应在共享 gate 已成功降档且仍处预期恢复期时占用
unit failure 信号。`incremental-scan`、`revision-source-backfill`、Wikidot reconcile 和
既有 work-queue 现在保留 `status='aborted'`、原失败率/原因及
`circuit_breaker_self_protection_expected`，但摘要 `ok=true`、exit 0。

以下情况仍 exit 1：共享 gate 没有进入保护档；不是 Wikidot gate 覆盖的故障（例如独立
CROM 断路器）；或按当前档位保持期与六健康窗吞吐计算的 `expectedRecoveryAt` 已超期。超期
摘要增加 `adaptive_downshift_recovery_overdue`，从而把“停手动作”与“持续不可用/恢复失效”
分开。

## 回归与验证

- 大批连接 reset：第五个真实无响应在未满 100-request 时触发 L1；跨 5/10 分钟持续失败
  可达 L2/L3；
- 瞬时抖动：141 个同 burst 信号仍只到 L1，不取得 L3 长冷却；
- 确定性失败为主：70 deterministic + 1 pressure / 100 仍不降档，既有六窗恢复可达；
- 两视角：`441/2968` 对 `5/3348` 的长期背离判为 critical；
- aborted：预期保护期 exit 0，恢复超期 exit 1；
- `npx tsc --noEmit`：通过；
- `npm test`：`472/472` 通过（基线 468，加本次 4 条要求回归），未重跑、未修改旧断言；
- `0056`：先应用、再幂等重放均通过；库名为 `scpper-v2`；
- `schedule:oldest-pending`：实际执行通过且对账结果落库，无外部消息。

## 阻塞与未做事项

无阻塞。没有 git commit、没有 push；没有访问 `/home/andyblocker/qqbot`，没有发送任何 QQ
消息。
