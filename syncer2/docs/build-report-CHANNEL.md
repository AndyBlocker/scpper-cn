# Syncer2 投票时钟闭环与出口通道配额改造报告

日期：2026-08-13（Asia/Shanghai）  
代码基线：`f874e36`  
作用域：仅 `/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation` 与 v2 数据库 `scpper-v2`；v1 只读连接约束未改，未访问 qqbot、未发送 QQ 消息，未 commit、未 push。

## 结论先行

本次把两个依赖“调用方恰好做对”的约定改成了数据库/门禁可验证的不变式：

1. 任一 live 页只要存在 `votes/ok` 成功证据，`last_complete_vote_snapshot_at` 就不得早于最新证据。`page_scan` 的任意 INSERT/UPDATE 与 `page_current` 的 INSERT/重建/显式回退两端都设保护，历史差值已回填，现场落后数为 **0**。
2. Wikidot 的 5,400 attempts/h 在共享门内显式拆成五组：L1 2,100、forum 900、work-queue 1,300、image 300、background 800。各 CLI 不再拥有第二套静默 pace；慢通道等待时不预占未来全站 permit，因此不会头阻塞 L1。
3. forum 的 300 秒软预算已进入每个真实 HTTP attempt 边界，包含 retry 与 redirect。任务跨过截止点时，下一次出站会被拒绝，未完成任务正常释放，不再等到 600 秒 systemd 硬超时。
4. 当前 83,280 条 thread catch-up 积压的中心估算约 **135 小时 / 5.6 天**，保守估算约 **235 小时 / 9.8 天**。L1 独享 2,100/h，较 145/5min 的 1,740/h 需求多 20.7%；正常档门等待只占 246.96 秒，五分钟窗尚余 53.04 秒。

## 范围、证据与口径

本报告使用以下证据：

- `scpper-v2` 中 `meta.page_scan`、`serve.page_current`、`meta.ingest_run`、forum 两类任务表、出口控制表的只读快照；现场复核时间为 2026-08-13 05:42 +08:00。队列和滚动小时数会随后台运行变化。
- 数据库中的 `pg_get_functiondef(meta.record_page_scan(...))`，以及仓库内 `ingest.apply_page_meta`、`src/project/*`、各 CLI 和共享 HTTP/gate 写路径。
- 用户给出的 430 页残留切片；修复后用最新 `votes/ok` 对所有 live `page_current` 做反连接式全量断言。
- 05:17 至 03:23 的八个旧 forum consumer 完整轮次，共 376 attempts、324 个已处理任务。05:35 的异常零处理轮不纳入吞吐样本。

这里的 request/attempt 指一次真实出站尝试，不等于一个业务任务；一个 thread 可能需要多个分页请求。由于关键关系可由小表和显式算式完整表达，本报告不用图，避免把精确配额和假设藏在图形刻度里。

## 一、32 个历史残留的分别归因

### A. 16 个 `updated_at > last_ok`：不是 `schedule:project` 覆盖

静态穷举 `src/project/*.ts` 后，`schedule:project` 对 `serve.page_current` **只有 SELECT，没有 INSERT、UPDATE 或 DELETE**。新增回归也会逐文件禁止该写路径。因此“L2 投影重建行但漏带时钟”不成立。

这组行在投票扫描之后发生的是 Tier1 元数据写入。`ingest.apply_page_meta` 会更新 slug/title/tags/category/source 等非投票字段，并无条件写 `updated_at = now()`；它不在 SET 列表中改 `last_complete_vote_snapshot_at`。所以实际过程是：

1. 04:23 左右的旧 `votes/ok` 没有推进时钟；
2. 随后的 meta 观测写了同一行，使 `updated_at` 变新；
3. 元数据路径既没有覆盖时钟，也没有能力从 `page_scan` 修复一个已经落后的时钟，于是呈现为“行后来写过但时钟仍旧”。

这与投影覆盖的修法不同：不能要求每个非投票调用方都记得携带派生字段。本次在 `serve.page_current` 上加 BEFORE 保护，只要 INSERT、状态恢复为 live，或显式写/清空/回退投票时钟，就从最新 `votes/ok` 把值夹到正确下界。构造 `INSERT ... ON CONFLICT DO UPDATE ... clock=NULL` 的重建回归已证明时钟不会倒退。

### B. 16 个 `updated_at` 停在 01:19：扫描时触发器尚未生效

当前 `meta.record_page_scan` 的 ON CONFLICT 分支实际 SET：

`status, claimed_total, fetched_total, checksum_ok, checksum_expected, checksum_actual, result_hash, error, scanned_at`。

所以“冲突分支只改其它列，未改触发器列”也不成立：它明确更新 `status` 和 `scanned_at`，在 0059 的 `UPDATE OF kind,status,scanned_at` 声明下本应触发。问题是这些 04:23 扫描早于含 0059 的基线提交 `f874e36`（05:01:19 +08:00），当时数据库里还没有可执行的 scan trigger；页面也没有后续写入，故 `updated_at` 原样停在 01:19。

这是“扫描事件发生时无触发器”的直接根因，和 A 组的“之后由元数据路径只刷新 `updated_at`、不修派生时钟”是两个不同的行级过程。0059 生效后的新样本曾达到 119/119 精确闭合，本次 0060 进一步消除对 UPDATE 列清单的依赖。

## 二、投票快照时钟不变式

迁移 `0060_vote_snapshot_clock_invariant.sql` 已先应用到 `scpper-v2`，随后才允许依赖它的代码作为交付结果生效。它建立三层保护：

- `meta.page_scan`：触发器改为 `AFTER INSERT OR UPDATE`，WHEN 条件只接受 `NEW.kind='votes' AND NEW.status='ok'`。以后即使 `record_page_scan` 调整 ON CONFLICT SET 列表，也不会因为 `UPDATE OF` 漏掉成功证据。
- `serve.page_current`：`BEFORE INSERT OR UPDATE OF last_complete_vote_snapshot_at,status` 读取该页最新成功证据；live 行的时钟只能前进，不能被重建 UPSERT、NULL 或旧值覆盖。
- 存量：建立 `votes/ok` 部分索引，分 500 行事务回填，再安装行侧保护并补扫竞态窗口，最后在迁移内执行全量断言。回填同时清理了 JavaScript 毫秒时间与 PostgreSQL 微秒 `scanned_at` 之间的亚毫秒落后。

独立检查 `checks/0013_vote_snapshot_clock.sql` 对全部 live 页取最新成功证据，任何一行落后即异常退出。2026-08-13 05:42 的现场结果为：

| 指标 | 结果 |
|---|---:|
| 存在 `votes/ok` 但时钟落后的 live 页 | **0** |
| `record_page_scan` 同 key 冲突后记录数 | 1 |
| 冲突后 clock 是否等于新 `scanned_at` | 是 |
| 模拟 page_current 重建后 clock 是否仍等于最新成功证据 | 是 |

## 三、共享门内通道配额

迁移 `0061_adaptive_egress_channel_quota.sql` 已应用到 `scpper-v2`，建立 `meta.egress_channel_control`；代码侧镜像与数据库逐组比对，缺迁移或数值漂移时 fail closed。该配置表也已登记到 pending-audit registry。

| 通道组 | 配额 attempts/h | 门内最小间隔 | 优先级 | 主要 channel |
|---|---:|---:|---:|---|
| L1 | 2,100 | 1,715 ms | 100 | `l1` |
| forum | 900 | 4,000 ms | 60 | `forum` |
| work-queue | 1,300 | 2,770 ms | 50 | `work-queue*` |
| image | 300 | 12,000 ms | 30 | `image`, `image-sample` |
| background | 800 | 4,500 ms | 10 | L0、sitemap、resolve、revision-source 等 |
| **合计** | **5,400** | — | — | 等于全站滚动小时预算 |

permit 使用两阶段决策：先在短事务里读取全站与本组的 `next_permit_at`；若尚未到期，释放数据库锁后等待，再检查请求截止边界并重新竞争。只有两个时钟都到期时才登记 attempt，并原子推进两个时钟。这一点很关键：forum 的 4 秒配额不会先拿走一个未来全站 slot，也就不能把 L1 挡在 forum 的 sleep 后面。

全站 pressure 档位和滚动小时预算仍在外层共同生效；通道配额不是绕过站点保护。当真实失败使共享门进入保护档时，所有通道仍会按原策略退让。

## 四、第二层硬编码节流审计

已移除：

- `forum-scan.ts` 的 7,200 ms；
- `forum-incremental.ts` 的 7,200 ms；
- `image-ingest.ts` 的 7,200 ms——这是发现的第三处同型静默上限；
- `revision-source-backfill.ts` 的 `RequestPacer` 与 `--delay-ms 250`，同时清理 package script 参数；
- work-queue 遗留的显式本地 interval 入口。

`resolve-pages` 未发现本地固定请求 pace。`image-asset-import --wikidot-interval-ms` 只用于离线导入报告的下载工时估算，不发起请求；CROM delay 属于另一个站点的公开 API；mihomo 250 ms 只节流本机控制面探针；retry backoff 是错误恢复，不是 Wikidot 稳态配额。这些都不与共享 Wikidot gate 构成双重常态节流。

静态回归会扫描 forum、image、revision-source、work-queue、resolve-pages 六个入口，禁止 `minRequestIntervalMs:`、`RequestPacer` 和 `--delay-ms` 重新出现。运行摘要改为公开 `channelPolicy`，通道 pace 不再静默。

## 五、请求边界软截止

`RuntimeBudget` 新增专用 `RuntimeBudgetExceededError` 与 `assertRequestBoundary()`。forum 两个 CLI 将它注入 `HttpClient`；客户端在每个真实 attempt 的本地等待前后、共享 gate 等待后、permit 入账前检查，因此 retry 和 redirect 也不能越界。

命中软截止的行为是：

1. 若第一个 attempt 尚未预留，不把它计入请求遥测或失败率；
2. 不运行失败出口补探，也不把“正常预算结束”误判为 transport failure；
3. collector 不吞掉该专用异常；
4. forum CLI 释放未完成 claim，写 partial/health 摘要并正常退出。

回归构造一个逻辑任务：第一次请求得到 302 后测试时钟越过剩余预算。结果 `/302` 命中 1 次、目标 `/ok` 命中 0 次、attempts=1；证明长任务的下一请求在边界中断，而不是继续撞 600 秒硬超时。

## 六、forum 排空估算

05:42 的队列快照：

| pending 集合 | 数量 |
|---|---:|
| thread catch-up | **83,280** |
| thread steady | 2,959 |
| discussion scan_task | 11,042 |
| forum scan_task | 200 |
| forum 相关合计 | 97,481 |

中心估算使用最近八个完整旧轮的真实比例 `376 attempts / 324 tasks = 1.1605 attempts/task`。满批 50 个任务约需 58 attempts；在 forum 4 秒门间隔下约 232 秒，加 `OnUnitInactiveSec` 约 60 秒，得到：

`50 / (232 + 60) * 3600 = 616 tasks/h`

这相当于 consumer 使用约 715 attempts/h，尚给同组 discovery 留约 185 attempts/h。于是 thread catch-up：

`83,280 / 616 = 135.2 h = 5.6 days`

保守场景沿用历史注释中的 2.26 attempts/thread，并只给 consumer 800/900 attempts/h：

`83,280 / (800 / 2.26) = 235.3 h = 9.8 days`

因此交付口径是 **约 6 天，保守约 10 天**。这是按配额和历史任务形态做的模型，不是改造后生产实测；部署后应以 6–12 个完整新轮次重估。若 97,481 个 forum 相关任务都具有相同成本，中心模型约 6.6 天，但 discussion/steady 的请求形态不同，不把它冒充 thread catch-up 的精确 ETA。

## 七、L1 五分钟 SLO 不退化的论证

L1 的需求基线是 `145 * 12 = 1,740 attempts/h`；独享 2,100/h，多 360 attempts/h，即 **20.7%** retry 余量。正常通道间隔为 `ceil(3,600,000/2,100)=1,715 ms`，一轮 145 attempts 的 permit 跨度为：

`(145 - 1) * 1,715 = 246,960 ms`

它比五分钟少 53,040 ms。forum 即使持续跑满 900/h，也只能推进自己的 channel 行，无法借用 L1 的 2,100/h；两阶段等待又保证 forum 不持有未来全站 permit。因此，仅由 forum 提速不会降低 L1 配额或制造慢通道头阻塞。

现场交叉证据为：全站 pressure level=0、budget level=0、滚动小时 3,768/5,400，`l1_slo_last_gap_seconds=300`、`l1_slo_degraded=false`、`l1_slo_overdue=false`。共享站点真实失败仍可能按设计触发全站保护并暂时影响 SLO，此时既有 `l1SloDegraded` / `l1SloExpectedRecoveryAt` 会显式记录；这与 forum 抢占 L1 容量是不同机制。

## 八、验证结果

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit` | PASS |
| `npm test` | **515/515 PASS，85 suites，0 failed**（基线 510，新增 5） |
| `checks/0013_vote_snapshot_clock.sql` | PASS |
| `checks/0014_egress_channel_quota.sql` | PASS |
| ON CONFLICT + page_current 重建活库回归 | PASS |
| 请求边界 redirect 回归 | PASS |
| CLI 单一 throttle authority 静态回归 | PASS |
| `git diff --check` | PASS |

全量 `checks/run_checks.sh` 仍会因本轮之前的基线债务退出非零：`serve.image_asset_url_alias` 未登记 projection registry、`apply_vote_cas_batch` 未登记 write-freeze，以及 0057 的四张 `meta.external_image_egress_*` 表未登记 pending-audit。0061 新表起初也被该检查发现，现已在迁移中补登记；复跑后 pending 缺口只剩上述四张既有外站图片表。没有为了变绿放宽任何断言。

## 限制、后续动作与待观察问题

- 排空 ETA 是基于配额、最近旧轮任务成本和定时器间隔的预测；部署后的帖子分页分布、discovery 占比与失败重试会改变结果。建议部署后记录 6–12 轮 `tasks/h` 与 `attempts/task`，若中心值偏离 20% 再调 forum 配额；调配仍须保持总和 5,400 且 L1 不低于 2,100。
- 观察 `l1_slo_overdue`、`l1_slo_degraded_since`、forum channel 实际小时用量和 `stoppedByRuntimeBudget`。期望预算停止后不再出现 `status=15/TERM`；若仍出现，应区分已在飞的单次 HTTP timeout 与请求边界失效。
- 后续独立清理三项基线检查债务，尤其把 0057 四张表登记为 covered/not_pending 的语义需要按其真实用途决定，不能在本任务中为绿灯随意分类。
- 代码与迁移已完成，无实现阻塞；尚未做 commit/push，等待评审与部署窗口。
