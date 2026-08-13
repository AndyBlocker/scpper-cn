# HOTPAGE：活动投票页收敛、原因分型退避与 L1 漂移上界

## 1. 结论

本次不改 schema，也没有放宽 `fetched < claimed`。修复后的 votes 协议是：先用既有
L1/ListPages claim 抓 WhoRated；仅当 `WhoRated.rawEntries > old claimed_total` 时，
在 WhoRated **之后**立刻按 fullname 重读一次目标 ListPages。只有后读的
`rating_votes == rawEntries` 且 `rating == Σsign`，才把后读值作为本次 claim，重新走原有
数据库完整快照门并整体替换。后读仍不相等、身份不完整或 checksum 不符时仍是 partial，
数据库函数保持 `snapshot_replaced=false`、零 current 写入。

这不会把错误数据写入的原因是：它没有使用容差、没有跨轮拼接明细，也没有假定
“多出来的行一定正确”；后读 ListPages 是位于 WhoRated 之后的独立确认，精确背书同一份
明细的行数与方向和。结构锚点、用户/方向逐行对应、身份 quarantine、pageId 身份和数据库
事务门仍全部保留。`fetched < claimed` 可能是漏抓，明确不触发后读放行。

## 2. 活动目标与退避分型

- `target_changing`：只来自 `fetched > old claimed` 且后读仍未闭合。固定 5 分钟重试，
  清空 `stable_count/last_result_hash`，不会把持续变化误收敛成 irreconcilable。
- `suspected_data`：`fetched < claimed`、checksum/结构/身份等其它未闭合形态仍按失败次数
  退避；votes 专用上限为 12 小时。相同稳定矛盾第三次仍进入 irreconcilable 周复查，
  不靠无限重试掩盖数据问题。

因此活动目标的下一次尝试不再走 1h→4h→24h；同时任意 `votes_full` 普通任务都不会再
得到超过 12 小时的 `not_before`。上线时只把一条已有的、最新证据明确为
`partial AND fetched>claimed` 的 24h 任务恢复为到期；没有重置 attempts/stable_count。

## 3. `critter-profile-neil` 一直为 streak=1 的根因

它不是在“检测到/未检测到”之间反复。修复前证据为：

- drift 的 `resolved_at` 一直为空，`last_detected_at` 每五分钟推进到最新 L1；
- `meta.incremental_page_state` 的 `page_id` 仍为空，L1 水位停在 2026-08-05 run 12986；
- 远端修订声明已从旧水位 6 倒退到 1，因此该 slug 被 revision-regression 隔离，
  `upsertL1States` 有意不推进它的 L1 水位；
- drift streak 却拿这个被冻结的 `last_l1_run_id` 当“上一轮”编号。它永远不等于上一条
  drift observation run，所以每轮都重新算成 1，`last_enqueued_at` 永远为空。

连续两轮阈值本身仍保留，用来让第二次连续观测立即执行；但第一次观测现在也会生成
priority=200 的延迟确认任务，`not_before = first_detected_at + 1h`。第二次连续观测会把它
提前到当前时刻。总量闸门按“到期时间、从未派发优先、最久未派发”轮转，不再永远只选
同一批大差额。

无总量闸门时，单次观测的执行上界为：

```text
first_detected_at + 1h + (同 kind 到期队前数 + 1) × 425s
```

425 秒来自现有 work-queue 的 360s 单轮预算 + 60s 重启间隔 + 5s AccuracySec，且 p200
不会被 p20 catch-up 带压过。总量闸门触发时，再加最多
`ceil(候选页数 / 每轮闸门页数) × 5min` 的派发轮转；若下一轮已对齐则 drift 直接 resolved，
若已有终态则走既有 7 天复查。因而每条检测都有可推导的消解入口。

## 4. 生产实测

数据库为 `scpper-v2`（5434）。部署后自然命中了同类竞态：`scp-cn-4812`
（page 1500006334）的 21:29 L1 claim 为 `10/-6`，21:33 work-queue 的 WhoRated 已为
`11/-7`；后读 ListPages 精确确认 `11/-7`，同 run 28344 的 votes page_scan 为
`status=ok, claimed=fetched=11, checksum=-7/-7`。从旧 claim 到完整提交 4 分 40 秒，
后读 meta 证据与 votes ok 写入相差约 5ms，远短于 24 小时。

原样本 `scp-cn-4729` 的 24h 任务恢复到期后，run 28344 的 WhoRated 返回 HTTP 500；
既有首次身份复核随后确认远端页面已不存在，并在 21:33:20 把本地生命周期改为 deleted。
因此它不应再伪造一个 votes `ok`。上面的 live 页自然竞态和回归 fixture 共同验收新路径。

`critter-profile-neil` 在首个新 L1 run 28311（21:29）即写入 `last_enqueued_at` 并把
votes_full 从 p20 提到 p200；21:31:11 被认领，21:33:12 以 `3/3、checksum=3/3` 成为
ok，drift 于 21:33:12 resolved。修复生效到认领约 2 分 11 秒，到消解约 4 分 12 秒。

最终 SQL 验收：

| 项目 | 结果 |
| --- | ---: |
| `votes_full AND not_before > now()+12h` | 0 |
| votes 未解决 drift，`last_enqueued_at IS NULL AND first_detected_at < now()-1h` | 0 |
| work-queue run 28344 | claimed=50, processed=50, unprocessedReleased=0 |
| forum-consume run 28342 | claimed=50, processed=50, succeeded=50, unprocessedReleased=0 |

部署后 L1 连续实测（均 `status=ok`、全站约 36.6k 页、`persistenceSkipped=0`）：

| run | pages | seconds | persistenceSkipped |
| ---: | ---: | ---: | ---: |
| 28311 | 36,559 | 90.664 | 0 |
| 28354 | 36,559 | 100.040 | 0 |
| 28358 | 36,559 | 98.541 | 0 |

## 5. 回归与静态检查

- 构造 `fetched > claimed`：后读精确闭合才变 ok；后读继续增长仍 partial。
- 构造 `fetched < claimed`：`needsPostWhoRatedClaim=false`，保持 partial。
- 目标变化：5 分钟；疑似数据问题高阶退避：12 小时，且数据库状态机断言变化类清空 streak。
- 单次 drift：生成 p200、最迟一小时到期；第二次连续 drift 立即到期。
- 针对性测试 44/44；完整 `npm test` 558/558；`npx tsc --noEmit` 通过。

没有 schema 变更、没有 git commit/push，也没有 QQ 侧操作。
