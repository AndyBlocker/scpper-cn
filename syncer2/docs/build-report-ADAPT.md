# ADAPT：全站自适应出口退让与 L1 五分钟调度交付报告

日期：2026-08-05（Asia/Shanghai）  
工作树：`feat__syncer2-foundation`（未 commit、未 push）

## 结论

- 已先上线全站共享的自适应退让和 3,200 attempts/滚动 60 分钟预算护栏，再把 L1 改成每 5 分钟；顺序符合批准的安全前提。
- 所有访问 Wikidot 的生产 `HttpClient` 入口共用 PostgreSQL 单例控制器；控制库不可用时 fail closed，不允许某条通道绕过护栏。
- L1 已实际连续运行：单轮 146/146、传输失败 0；控制器保持 `normal`，上线实测滚动小时为 1,950/3,200、压力失败 0。
- 自然投票闭环样本从当前 L1 启动到 `serve.vote_current` 反映为 **5 分 04.943 秒**。Wikidot 不提供投票发生时间，因此不能伪造精确的“站上点击时刻”；相邻轮证据给出的保守端到端上界是 **10 分 10.031 秒**，详见下文。
- v1 连接与只读强制未修改；没有触碰 `qqbot`，没有发送任何 QQ 消息。告警只进数据库与 systemd journal。

## 1. 自适应退让

### 1.1 反馈口径与共享范围

每次真实 HTTP attempt（重试也单独计数）依次执行：

1. 在 `meta.egress_control` 的 PostgreSQL transaction advisory lock 下预留全站 permit；
2. 写入 `meta.egress_request_bucket` 的“分钟 × 通道”请求账；
3. 按共享档位排定全局下一次 permit；
4. 响应后回写压力失败，并在每 100 attempts 完成一个反馈窗口。

压力失败只包括：无 HTTP 响应/传输错误、429、5xx。预期 404 和其他 3xx/4xx 说明站点仍能正常响应，不混入容量失败率，避免删除页、身份解析等业务形状误触发全站退让。

覆盖入口包括 L0/L1、sitemap/Tier2、Tier1、work-queue、forum、resolve、revision source、vote replay/converge、image sample、S2/S3 live backfill，以及 reconcile 的 Wikidot 侧。CROM 是另一站点，刻意不计入 Wikidot 预算。出口 IP/代理归因探针也不是 Wikidot 请求，不污染站点反馈。

### 1.2 阈值依据

| 判据 | 动作 | 依据 |
|---|---|---|
| 100 次窗口失败率 `>= 5%` | 单窗口立即降一档 | 已远离 0.6% 安全点，不能再等第二轮；仍显著早于 22.6% 危险小时 |
| 连续两个 100 次窗口失败率 `>= 2%` | 第二窗口降一档 | 2% 是实测安全点 0.6% 的 3.3 倍；连续 200 attempts 区分趋势和单轮噪声 |
| 单个 2%--4% 窗口后回到 `< 2%` | 不降档、清零趋势计数 | 过滤短抖动，不为噪声牺牲新鲜度 |
| 恢复健康 | 每个窗口 `<= 1%` | 100 次窗口只有 1% 粒度；允许一个孤立失败，但低于进入阈值，形成迟滞区 |

实测从 0.6% 直接跳到 22.6%，没有可依赖的中间小时样本，所以不能把触发线放到 10% 一类的高位。2% 趋势线兼顾早退让和噪声过滤；5% 单轮线处理突发恶化。

### 1.3 档位、冷却与防振荡

| level | 名称 | 全站最小 attempt 间隔 | 理论上限 | 最低冷却 |
|---:|---|---:|---:|---:|
| 0 | normal | 333 ms | 约 3 QPS | 无 |
| 1 | cautious | 667 ms | 约 1.5 QPS | 30 分钟 |
| 2 | protective | 2,000 ms | 0.5 QPS | 45 分钟 |
| 3 | cooldown | 8,000 ms | 0.125 QPS，约 450/h | 60 分钟 |

防振荡由五层迟滞共同保证：

- 进入使用 `2% × 连续两窗` 或 `5% × 单窗`，退出要求 `<=1%`；
- 退让后必须先完整等待最低冷却，冷却期间的好窗口不预攒恢复积分；
- 冷却结束后还要连续 **6 个**健康窗口（600 attempts）才能恢复；
- 任一 `>1%` 坏窗口清零健康进度，并从最后坏窗口重新后推冷却；
- 每次只恢复一档，恢复到的新档位重新执行自己的冷却和 6 窗健康验证。

因此从 cooldown 回到 normal，即使一直健康且流量足够，理论最快也约为 `60+80 + 45+20 + 30+6.7 = 241.7` 分钟；流量不足时只会更慢。预算仍越界时，每个新 permit 都继续后推 cooldown，不会周期性试探。

### 1.4 可观测性

迁移 `0037_adaptive_egress.sql` 已只应用到 `scpper-v2`，提供：

- `meta.egress_control`：档位、原因、变档时间、最早恢复时刻、健康/趋势窗口进度、滚动小时计数、预算和完整 policy；
- `meta.egress_request_bucket`：真实 attempt 的分钟/通道请求数与压力失败数；
- `meta.egress_alert`：退让、预算越界、逐档恢复的持久告警审计；同时写 stderr/journal，不发送 QQ。

每个采集摘要的 `http.adaptiveEgress` 可直接看到同一状态。实测 L1 run `13425` 的摘要为 `normal`、`rollingHourRequests=1905`、`budgetLimit=3200`、最近窗口失败率 0。

常用查询：

```sql
SELECT level, reason, changed_at, recover_not_before,
       healthy_windows, last_window_failure_rate,
       rolling_hour_requests, budget_limit, budget_breached, policy
FROM meta.egress_control WHERE site_key='wikidot';

SELECT * FROM meta.egress_alert
WHERE acknowledged_at IS NULL ORDER BY created_at DESC;
```

## 2. 滚动小时预算护栏

护栏为 **超过 3,200 attempts/滚动 60 分钟即无条件进入 cooldown，并首次越界持久告警**。

- 3,200 是已验证约 3,700/h 安全水位的 86.5%，保留约 500/h（13.5%）绝对余量；
- 它比实测最低安全小时 3,663/h 低 463，未贴线运行；
- 按任务给定基线，L1 提频后预计 2,609/h，仍留 591；
- 上线前最近完整小时实际为 1,777--1,895/h，比任务采样时更高；加上额外 8 轮 L1 的约 1,168 attempts/h 后，保守稳态为约 2,945--3,063/h，仍在护栏下，但只留 137--255，故没有再抬高上限。

护栏按 permit 预留而不是等 run 结束才汇总；进程在预留后退出也会保守计数。首次部署还从过去 60 分钟的 `meta.ingest_run` 初始化请求账，避免首小时从零开始失明。

## 3. L1 五分钟调度

仓库部署源和实际用户单元均为：

```ini
OnCalendar=*-*-* *:04/5:00 Asia/Shanghai
AccuracySec=1s
```

即每小时 `:04,:09,...,:59`。它不与 L0 的 `:02/:32`、sitemap 的 `:27` 或 resolve/revision-source 的 `:00/:05` 同秒启动。work-queue 是 `OnUnitInactiveSec=1min` 的滚动任务，无法静态完全错开；共享 permit 会削平重叠突发。`AccuracySec` 从 1 分钟收紧到 1 秒，防止 systemd 把 `:04` 合并到 `:05`。单元已 daemon-reload/restart，状态为 enabled + active。

实测 L1 run `13425`：36,363 页、146/146 请求、0 失败、89.083 秒、13 个投票变化。除一个既有 page identity 冲突按原策略隔离外，12 个实时 `votes_full` 任务全部以 priority 200 入队。这个优先级只用于 L1 新变化；catch-up/sweep 仍为 20/10，避免 21k 历史投票债务把实时变化挤出下一轮。

## 4. 端到端新鲜度实测

样本：`wontoninsurgency`，L1 观测到 `rating 1594→1595`、`rating_votes 1632→1633`，随后抓到 voter `66876443` 的新 `+1`，`serve.vote_current` 在同一事务以相同 `snapshot_observed_at` 和方向反映该票。

| 阶段 | 时间（Asia/Shanghai） | 本段耗时 |
|---|---|---:|
| 当前 L1 run `13425` 启动 | 20:34:05.843 | — |
| L1 完成 diff，scan task 写入 | 20:35:32.531 | 1:26.688 |
| work-queue run `13461` 认领 | 20:38:23.928 | 2:51.397 排队 |
| WhoRated 抓取、事实写入且 `vote_current` 已反映 | 20:39:10.786 | 0:46.858 抓取/应用 |
| 当前 L1 启动 → `vote_current` | — | **5:04.943** |

相邻 L1 run `13420`/`13425` 的启动间隔实测 5:05.088；本样本在两轮之间从 1632 票变成 1633 票。Wikidot WhoRated/ListPages 不返回单票时间戳，`occurred_at` 只能标 observed，故无法诚实给出精确点击时刻。用上一轮启动 20:29:00.755 作为更早的保守边界，到 `vote_current` 为 **10:10.031**；实际值位于该上界内。收紧 `AccuracySec=1s` 后，未来调度抖动约少 4 秒。

同一闭环共 12 个可解析变化页，12/12 page scan 为 `ok`，12/12 的新事实都已在 `serve.vote_current` 即时反映；最早页面在 20:39:04.403 落地。

## 5. 回归与验收

- `npx tsc --noEmit`：通过。
- `npm test`：**382/382 通过**（基线 375，加 6 个自适应状态机用例和 1 个生产入口/调度覆盖用例）。
- 合成回归覆盖：缓慢升高在 3%/第二窗口即降档；单轮 4% 抖动不降档；持续失败重置冷却且六窗后只升一档；3,201/h 强制 cooldown 且首次告警；摘要可读档位/原因/恢复时刻。
- 静态生产覆盖断言枚举全部 Wikidot `HttpClient` 入口，并断言 CROM 不误入该预算；L1 priority 200 与 `AccuracySec=1s` 也已钉住。
- `git diff --check`：通过；未 commit、未 push。

## 6. 文件

- `src/http/adaptiveEgress.ts`：共享状态机、PostgreSQL permit、反馈、预算和摘要。
- `src/http/client.ts`：每个物理 attempt 的 fail-closed 接入。
- `migrations/0037_adaptive_egress.sql`、`migrations/9002_grants.sql`：状态、请求账、告警与角色权限。
- `deploy/systemd/syncer2-l1.timer`：五分钟错峰调度。
- `tests/adaptive-egress.test.ts`、`tests/operations.test.ts`：指定回归与生产覆盖。

无代码或部署阻塞。唯一测量限制是站点不公开单票发生时间；报告同时给出可复核的实际落库耗时和保守相邻轮上界，没有把 observed 时间冒充点击时间。
