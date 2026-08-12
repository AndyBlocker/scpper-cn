# IMGRATE：v2 站外图片自适应退让交付报告

日期：2026-08-12  
工作树：`feat__syncer2-foundation`（分支 `scpper-backend-v2`）  
范围：只修改本工作树与 `scpper-v2`；未接触 `/home/andyblocker/qqbot`，未发送 QQ 消息，未 commit/push。

## 结论

站外图片现在使用一套与 Wikidot 完全隔离的 PostgreSQL 自适应出口：aggregate 只管站外总速率和总量，反馈档位、失败窗口、breaker、小时预算均按 exact hostname 分账。429/503 单次立即降一级；普通 5xx/transport 进入 20-attempt 小窗口。恢复要先过最短保持期，再连续 3 个健康窗口逐级恢复。

失败 job 不再在一次处理里连续请求 5 次：站外瞬时失败只做 1 个传输 attempt，随后按数据库 `attempts` 写入 1h、2h、4h、8h 的 `not_before`；第 5 次失败终态。重定向与重试预算已拆开，最多 3 跳重定向仍逐跳过 gate，但 500/transport 不会借重定向额度重试。

在 host 足够分散、无降档且无重定向时，现有 `120 / 420s / 5min` 调度约能维持 600–650 attempts/h。24,627 个待处理项首遍需约 38–41h；计入正常失败重试和 15h 指数退避尾部，现实规划为约 55–60h（2.3–2.5 天）。发出 429/503 的 host 会被刻意拉长，不能给其尾部承诺固定完成时间。

## 迁移顺序与数据隔离

先执行了 `migrations/0057_external_image_adaptive_egress.sql` 到 `scpper-v2`，确认成功后才让 TypeScript 代码引用新列/表，满足“迁移先于代码生效”。迁移有受保护库 guard，拒绝 `scpper-cn` 等库。

0057 新增：

- `meta.image_ingest_job.http_status smallint`，约束为 100–599；transport/circuit-open 为 NULL。
- `meta.external_image_egress_global`：只保存站外 aggregate pace/rolling budget。
- `meta.external_image_egress_control`：exact hostname 的档位、窗口、恢复时刻和预算。
- `meta.external_image_egress_request_bucket`：分钟×host 的 requests、429、503、其它 5xx、transport。
- `meta.external_image_egress_alert`：降档/恢复审计，只落库与 stderr，不接 QQ。
- claim 表达式索引，及按 host `next_permit_at` 绕过降档队头的排序支持。

新代码和迁移均不 UPDATE/INSERT/SELECT Wikidot 的 `meta.egress_control`、`meta.egress_request_bucket`、`meta.egress_alert`。Wikidot 仍由原 `PostgresAdaptiveEgressGate` 管理；站外全面故障只能影响 external route 的健康结果，不能消费 Wikidot 预算或打开 Wikidot breaker。

只读验收确认 0057 四个对象及 `http_status` 已存在于 v2。

## 自适应策略

| 维度/档位 | 最小相邻 attempt | 最短保持期 | 说明 |
|---|---:|---:|---|
| aggregate 正常 | 3s | — | 所有站外 host 共用，仅总 pace；不接失败反馈 |
| aggregate 滚动护栏 | 30s | 滚动恢复 | 超 650 attempts/60min 后保护 pace |
| host L0 normal | 12s | 0 | 300/h，正常档本身即与单 host 预算一致 |
| host L1 cautious | 30s | 30min | 首个 429/503 立即进入 |
| host L2 protective | 2min | 2h | 第二个明确限流信号进入 |
| host L3 cooldown | 10min | 6h | 第三个信号进入；后续信号延长保持期 |

窗口策略：20 attempts；失败率 `>10%` 连续两窗降档，`>25%` 单窗快速降档；`<=5%` 且过保持期后连续三窗恢复一级。单 host 滚动预算 300/h，aggregate 滚动预算 650/h。650 是工程护栏，不是建议长期顶着跑的目标；当前可持续运行目标取不高于约 600 attempts/h。

`--external-interval-ms` 仍是 aggregate 参数并硬设 3000ms 下限；已保留 `--limit 120 --external-interval-ms 3000`。timer 文件和运维测试均固定 `OnUnitInactiveSec=5min`，未回退临时止血。

## 按主机分账：收益与成本

采用 exact hostname，而不是把全部 `wdfiles.com` 或所有外站绑成一个 gate：

- 每个本轮遇到的 hostname 有一个单连接 `HttpClient`/dispatcher，因此 breaker 也按 host 隔离；一个 host 连续 reset 不会让其余队列收到派生 `CircuitOpen`。
- 所有 host 共用一个站外 gate 和最多 2 条 PostgreSQL 连接，不会为每个 host 建 DB pool。
- 单轮上限 120，因此进程内最坏约 120 个轻量 client/dispatcher；进程结束统一关闭。数据库成本是每个 host 一行控制状态、每分钟每 host 一行 bucket，48h 后裁剪。
- permit 预留通过一个短 PostgreSQL advisory transaction 串行化，代价是每个真实 attempt 两个短事务；在 3s aggregate pace 下远低于数据库瓶颈。
- exact hostname 不能识别多个子域背后共享的 CDN/出口配额；650/h aggregate 是第二道保护。按 eTLD+1 会把一个坏的 wdfiles 子域重新扩散到其它子域，当前收益不及精确 host，故不采用。

结论：队列 host 很分散时，12s/host 可由其它 host 交错填满 3s aggregate，不牺牲总吞吐；host 集中或异常时只牺牲该 host 的新鲜度，收益明显高于上述资源成本。

## `http_transient` 的历史归因与新分账

旧 schema 只保存 `failure_class/error`，没有 HTTP 状态，因此“累计 836 条 `http_transient` 中 429/503 各多少”无法事后精确恢复，这是历史证据缺口，不能用猜测补数。

可恢复的当轮 HTTP 遥测给出更明确的答案：用户所述 75.8% 轮次共 145 个真实 attempts，状态桶为 `200=132、400=3、transport=10、429=0、503=0`。10 个真实 transport attempt（最终形成 2 个逻辑 transport 失败）打开了旧的全局 external breaker；后续大量 job 没有触网，直接得到派生 `http_breaker_open/CircuitOpen`，所以 `http_transient` 的增长主要不是 429/503 证据。当时进一步检查到的 1,292 条遗留 `http_transient` job，error 均为该 circuit-open 文本。

0057 后不再丢失状态。只读验收时新账本已有 216 attempts：`429=2、503=0、其它5xx=1、transport=32`；只有产生 429 的 `www.metmuseum.org` 与 `www.wikudot.icu` 为 L1，其余 host 未被拖慢。这既回答了未来如何分账，也验证了明确限流信号会在第一条就驱动 host 退让。

HTTP 429/503 本身仍零重试；其它 5xx/transport 计压力窗口。403/404/内容类型等确定性错误不会污染 host 容量失败率。

## 重试、`not_before` 与队头绕行

- claim SQL 明确要求 `job.not_before IS NULL OR job.not_before <= now()`，未来任务不可认领。
- claim 时 `attempts += 1`；失败退避按 `base * 2^(attempts-1)`，base=1h、上限=7d。本生产 `maxAttempts=5` 下实际重试时间线为 `+1h / +2h / +4h / +8h`，累计 15h 后第 5 次失败终态。
- 站外 job 内 `maxTransientAttempts=1`，避免一次 claim 在几秒内放大为 5 个请求。
- 301/302 最多三跳，每跳单独申请原目标或新目标 host 的 permit；重定向不增加瞬时失败重试预算。
- claim LEFT JOIN host control，并优先选择 `next_permit_at` 更早的 host；降档 host 不再长期占住队头。
- failure 会把结构化 `http_status` 同时写 job 和 page-image metadata；成功会清空旧状态。

## 吞吐与清空估算

计算口径：120 个任务、站外 aggregate 启动间隔 3s，满 120 次的启动跨度约 357s；一轮受 420s 墙钟限制，结束后 5min 再启动。因此无退让时调度上限约为：

- 快轮：`120 / (357s + 300s) × 3600 ≈ 658 attempts/h`，但被 650/h aggregate 护栏截住；
- 满墙钟：`120 / (420s + 300s) × 3600 = 600 attempts/h`；
- 可持续规划：600 attempts/h；短时工程上限 650 attempts/h；单 exact host 不高于 300/h。

对 24,627 个待处理项：

- 理想首遍：`24,627 / 650 = 37.9h` 到 `24,627 / 600 = 41.0h`；
- 结合此前无 breaker 时约 94–95% 的当轮可判定率，主体约 40–44h；
- 再给失败项最多 15h 的生产重试尾部与调度离散留量，现实 ETA 为 55–60h。

这是多 host、当前低速策略下的容量估算，不是外部站点 SLA。明确 429/503、共享 CDN 的未知配额、长 timeout、重定向都会降低“jobs/h”。建议至少观察新分账 24–48h，再根据各 host 的 L0 停留率与 429/503 桶决定是否调整；在没有这段样本前不建议提高 600/h 运行目标。

## 回归与现场验收

- 持续 429：坏 host 三次降到 L3，健康 host 保持 L0。
- 站外全面失败：external health failed，Wikidot route health/预算/breaker 不变。
- 失败重试：断言 1/2/4/8/16h 纯函数、生产 `not_before` SQL、未到期不认领，以及站外单 job 不做内层瞬时重试。
- Wikidot 阈值：CLI 直接调用 `evaluateRunHealth` 且不传 override，并与分链路结果 fail-closed 对比；主站仍为统一 0.25，站外独立 0.6。
- 重定向回归：图片 302 正常跟随，随后 500 仍只打一次。
- `npx tsc --noEmit`：通过。
- 相关定向回归：55/55 通过。
- `npm test`：最终 485/485、80 suites、0 failed（基线 477 + 新增 8）。第一次全量发现 timer 的旧 1min 契约，按已生效的 5min 止血配置同步后重跑；没有为活库偶发而放宽断言。

## 主要文件

- `migrations/0057_external_image_adaptive_egress.sql`
- `src/image/externalEgress.ts`
- `src/image/externalClient.ts`
- `src/image/worker.ts`
- `src/cli/image-ingest.ts`
- `src/http/client.ts`、`src/http/adaptiveEgress.ts`
- `tests/image-external-egress.test.ts`、`tests/http.test.ts`、`tests/operations.test.ts`

## 阻塞

无代码、迁移或回归阻塞。唯一不可补的事实是旧 836 条 `http_transient` 的逐状态历史明细，因为旧表未保存 HTTP status；已经通过 0057 从本次之后永久消除此盲区。带 429/503 的 host 清空时长仍取决于对方恢复，按设计不承诺固定尾部。
