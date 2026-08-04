# v2 全站冷启动实测（2026-07-28）

## 结论

PHFIX 修复后已完成冷启动收尾，**通过验收**。主库 `scpper-cn` 全程只读；本节所有
迁移、修复、采集和测试写入均只落在 `scpper-v2`。

- 只为 error 含 `write_frozen` / `PGF01` 的 5 个任务（page id
  `16088, 104702, 31521, 30238, 33876`）重置 `not_before`；没有改 attempts，也没有
  放开任何真实解析/校验错误的退避。
- run 236/320 两轮完整 Tier1 均成功；收尾队列把最初 513 个活页差异降到 492。
  剩余项均继续走正常退避和四重门控，没有用本地聚合强行“凑平”。
- run 304 完成 35,372 个 live 页的全站验收重放；44 个新增事件全部有真实远端变化
  证据，异常 0。489 个不完整页被隔离为 partial/failed，没有授权 revoke 或强制采用。
- 当前 active write freeze=0，I1 rating、I2/I3 分向计数、vote current 重复键、身份映射
  违例均为 0。

## PHFIX、退避与队列收尾

run 201 的误报来自把定向高票 cohort 与全量基线混比。修复后 parse health 基线按
`source + mode + population_type` 分层；`targeted_queue` 与 `acceptance_replay` 的 cohort
聚合 checksum/fetched 比率只告警，逐页 checksum/完整性门仍然拒写。run 219 验证了旧
策略会再次误冻，0016 迁移落地后只释放该次误报，最终无 active freeze。

从 run 236 的清洁 Tier1 开始，meta 队列 1,838 条全部成功；两轮 votes 队列共认领
484 次，完整页采用，partial/failed 保留。另处理 revisions/forum，并补解析 30 个
pending slug（1 个新解析、29 个已有身份）。收尾时队列如下：

| kind | total | live | runnable | 下一 live `not_before` |
|---|---:|---:|---:|---|
| votes_full | 474 | 466 | 0 | 2026-07-28 22:08:34 +08 |
| revisions_full | 1 | 1 | 0 | 2026-07-29 00:10:01 +08 |
| meta / content / forum | 20 | 0 | 0 | — |

期间还修了两个会让常驻调度放大问题的队列 bug：未实际执行的已认领任务现在释放锁、
归还 attempts 且不产生 1h 假退避；全量 Tier1 不再每轮重复生成 1,838 条相同 creator
补偿任务。诊断时产生的 recurring seed 已按精确 reason 回滚，不留人工触发副作用。

## 第三次全站幂等验证

run 304 以 run 236 的全部 35,372 个 live 页为范围，page id 边界
`301..1500000000`，耗时 3,840.331 秒。35,373 个逻辑请求、35,385 attempts：
35,372 个 HTTP 200、1 个 HTTP 503、12 个 transport retry，breaker 始终 closed。

结果为 34,883 ok、462 partial、27 failed；其中 checksum bad 449。因为完整性失败页按
契约隔离，run 状态记 failed，但全站范围已逐页实际重放，所有可采用页仍完整经过 CAS。
新增事件 44，全部为 `vote`，无 revoke/revote：

- 33 个事件（30 页）由前后完整 Tier1 的 rating/total delta 直接确认；
- 11 个事件（10 页）是 aggregate 不变的 voter-set 等量换入换出；同轮存在旧 voter
  缺席候选，因而也是真实新票；
- 无法归因或异常事件：0。

逐事件归因见
[`coldstart-2026-07-28-vote-events.csv`](./coldstart-2026-07-28-vote-events.csv)；
489 个隔离页见
[`coldstart-2026-07-28-vote-partials.csv`](./coldstart-2026-07-28-vote-partials.csv)。

## 运维债与最终验证

- `v1_backfill` run 112 已以 failed 收尾，finished_at
  `2026-07-28 18:08:08 +08`，原因明确为被成功 run 113 取代；未触碰未在任务范围内的
  run 111。
- 0017 新增 `meta.page_scan_run_summary` 与 `meta.maintain_page_scan()`：finished run
  先聚合；成功页保留 1h、每个 page/kind 最新 ok 及最近两次全量枚举，partial/failed
  保留 30d。606,073 行聚合为 231 行/146 runs，删除 293,645 页级行；最终
  `page_scan` 312,428 行、64 MB。定时维护只做普通 VACUUM；本次在无采集进程时一次性
  `VACUUM FULL` 回收历史/测试空洞。
- systemd oneshot + timer 与 PM2 `cron_restart` 备选均已写好；禁止 `restart_delay`
  的 2,388 次 v1 静默失败理由已写进配置。配置没有安装、reload 或 enable。
- `smoke_test.sql` 300/300、checks 2/2、Prisma 98/98、TypeScript 两套 typecheck、
  `npm test` 249/249 全部通过；systemd 静态验证无 syncer2 错误。

## 冻结前口径与时间线（历史）

所有时间均为 Asia/Shanghai。

| 阶段 | run | 时间 | 结果 |
|---|---:|---|---|
| sitemap full | 114 | 16:34:57–16:35:10 | ok |
| Tier1 首次测压 | 115 | 16:35:22–16:52:47 | ok |
| pending identity resolve | 116 | 16:57:16–16:57:45 | ok |
| Tier1 身份核查中间轮 | 117 | 16:58:46–17:02:16 | 人工标记 failed / invalidated |
| Tier1 清洁终轮 | 118 | 17:04:48–17:07:13 | ok |
| Tier2 probe / work queue | 119–202 | 17:07:49–17:50:56 | 解析熔断后停止 |

## 阶段 1：sitemap + Tier1

### sitemap run 114

- 命令口径：`sitemap-scan --mode full --page-scan all --concurrency 4 --proxy-check warn`。
- 4 个 sitemap 分片；连同 index 共 5 个请求，5/5 HTTP 200，0 retry，0 transport failure。
- 35,997 条原始 entry、35,993 个唯一 slug；4 条根节点无 slug，因此解析丢行率为 `4/35,997 = 0.011112%`。
- 相对先前快照：14 个新增、40 个 `lastmod` 前移、35,939 个不变。
- 35,991 条 page scan，生成 52 个任务（40 content、12 meta）；2 个 slug 当时未解析。
- 耗时 12.089 秒；wire 664,697 B，decoded 4,103,673 B。

### Tier1 首次测压 run 115

- 145/145 批，36,183 行；146 个请求（含启动探针），146/146 HTTP 200。
- 耗时 1,045.006 秒；0 retry、0 transport failure、0 503/reset，传输失败率 0%。
- resolved 36,042，unresolved 141；解析丢行率 0，重复 fullname 率 0，selector literal 率 0，五星误判 0。
- `avg_tags_len=5.1287068513`，`avg_votes_per_page=32.8523892436`。
- selector empty rate：title 0.1879%、tags 4.6486%、`_tags` 94.4394%、parent 75.1679%、commented 20.6727%、creator id/unix 5.1488%；均未越过绝对阈值。
- 36,042 页 metadata 成功，生成 1,847 个 meta 任务。

### 阶段 1 承压结论

- 约定的正式测压口径（run 114 + 115）：151 requests / 151 attempts / 151 HTTP 200；失败率 0%，两进程纯执行耗时合计 1,057.095 秒（17 分 37.095 秒）。
- 端到端核查实际流量（run 114–118，含 resolver 和两次 Tier1 核查）：584 requests，583 个 HTTP 200、1 个预期 404、0 transport status；另有 2 次人工新 slug 探测未计入 ingest_run。
- run 118 清洁终轮：36,182 行，146/146 HTTP 200，耗时 144.224 秒；resolved 36,044、unresolved 138，parse drop 0。
- run 118 相对 run 115：`avg_tags_len` 偏离约 `+0.00115%`，`avg_votes_per_page` 偏离约 `+0.00344%`；其余主要 selector 指纹同量级，无解析漂移。
- 正式测压出口 IP 探针分布：`188.253.120.136` 1、`155.254.126.141` 1、`64.178.112.40` 1、`193.160.23.211` 2、`103.188.235.3` 1。4 个实际节点均无传输失败。
- run 117 有 1 次独立 IP 回显探针 timeout，但 146 个业务请求仍全部 200；清洁 run 118 的 6 次 IP 探针全部成功。

因此阶段 1 明显优于 2.3% 传输失败基线，满足放开阶段 2 的网络前提。

## 身份安全核查

- 冷启动前 47,880 个 v1 对应身份全部保留；阶段 1 后 `ingest.page` 与 `serve.page_current.wikidot_id` 不一致为 0。
- 唯一新增身份为 `wikidot_id=1469064595`、slug `wanderers:the-nordic-draugr`、v2 id `1500000000`。在只读 v1 中按 slug 和 wikidot id 都无行，远端 PageId 返回相同 wikidot id，因此属于确认的新页。
- `scp-cn-4918` 返回 404，没有铸造身份。
- 138 个受限 category fullname 返回 `_public` 页身份，resolver 因 wikidot id 不一致全部拒绝注册，最终保留为 `pending_page.status=mismatch`。
- 核查中曾错误地把这 138 个受限 fullname 按 v1 URL 去前缀映射到旧页 metadata；没有新铸 id，也没有改动 `ingest.page.id ↔ wikidot_id`。发现远端 category fullname 实际返回 `_public` 后，已从只读 v1 PageVersion 恢复 metadata、将 run 117 标为 invalidated，并在放开 Tier2 前完成清洁 run 118。
- 停止时共有 47,881 个身份、47,881 个 page_current，reserve id 仅上述 1 个确认新页；身份 mismatch 为 0。

## 阶段 2：Tier2 定向队列

### S3FIX 遗留任务决策

启动前有 1,681 条 `s3_dryrun_live_gate_mismatch` votes_full 任务。处理策略如下：

- 与成功 run 118 Tier1 claimed_total / claimed_rating 有交集的任务复用。
- 81 条纯 S3FIX 任务没有任何成功 Tier1 ListPages 证据；它们会确定性报“缺少 claimed_total/claimed_rating”，并曾在 run 156/157 触发连续 5 页失败。已精确退役这 81 条，未抓取或强写本地聚合。
- 有 Tier1 证据但 WhoRated 少一票或同一 voter 同时出现正反方向的任务，按既有完整性门保留四级退避，不强行决定当前态。

### 逐档放开

- probe run 119 成功。
- 10 页 / 并发 1：7 ok、3 partial、0 failed。
- 25 页 / 并发 2：16 ok、9 partial、0 failed。
- 50 页 / 并发 4：38 ok、12 partial、0 failed；门检 I1–I4/I8/freeze 全 0。
- 此后保持并发 4，没有提高到 5；每个进程最多 50 任务，连续 5 页失败时均按契约非零退出。

### 阶段 2 汇总（run 119–202）

- 84 个短进程，墙钟 2,586.932 秒（43 分 6.932 秒）。
- 3,947 次 claimed、3,830 次实际处理；117 次因失败阈值停止而释放锁。
- 3,946 requests、3,947 attempts；3,946 个 HTTP 200，1 个 transport attempt 失败后重试成功。
- attempt 级传输失败率 `1/3,947 = 0.0253%`；0 个 404/503，0 consecutive reset，breaker 未因网络打开。
- wire 30,913,812 B，decoded 237,556,052 B。
- 按任务结果（重复重试按 attempt 计）：3,343 ok、442 partial、45 failed、0 irreconcilable。

| kind | claimed | ok | partial | failed |
|---|---:|---:|---:|---:|
| meta | 1,851 | 1,851 | 0 | 0 |
| votes_full | 2,015 | 1,412 | 441 | 45 |
| revisions_full | 41 | 40 | 1 | 0 |
| content | 34 | 34 | 0 | 0 |
| files | 1 | 1 | 0 | 0 |
| forum | 4 | 4 | 0 | 0 |
| new_page_highfreq | 1 | 1 | 0 | 0 |

出口 IP 探针共 235 次，均没有 failure-after attribution：

| IP | probes |
|---|---:|
| 103.129.180.21 | 43 |
| 185.220.239.171 | 43 |
| 188.253.120.136 | 41 |
| 193.160.23.211 | 34 |
| 103.188.235.3 | 32 |
| 155.254.126.141 | 29 |
| 64.178.112.40 | 13 |

节点观察覆盖 DIRECT 及 24 个代理节点；所有 `observationsAfterFailure=0`。唯一 transport retry 没有形成 IP/节点连续异常。

## 冻结时快照（历史）

| 检查 | 结果 |
|---|---:|
| page_current 总行数 / identity 总数 | 47,881 / 47,881 |
| page_current live / deleted | 36,067 / 11,814 |
| run 118 Tier1 可对账活页 | 35,372 |
| 活页 rating 不一致 | 498 |
| 活页 vote_up+vote_down 不一致 | 512 |
| 活页任一 Tier1 vote claim 不一致 | 513 |
| I1 rating=Σdirection | 0 |
| I2/I3 分向计数 | 0 / 0 |
| vote_current 主键重复 | 0 |
| I8 revision projection | 0 |
| identity wikidot_id mismatch | 0 |
| 有效 write freeze | **1 (`all`)** |

`meta.ingest_run` / `meta.page_scan` 证据链：

- run 114–202 全部有 source、started_at 和 finished_at；unfinished 0。
- page_scan 指向不存在 ingest_run 的 orphan 为 0。
- run status 为 49 ok、40 failed；failed 包含按契约因 partial、连续任务失败或冻结退出的可审计结果，不是缺失结束记录。

停止时队列：

- votes_full 501 条，其中 27 条 live runnable（run 202 释放），其余主要处于 1h/4h/24h/7d 退避；另有 2 条 deleted 页任务不会被 live-only claim。
- revisions_full 1 条 partial，下一次退避时间为 18:31:27。
- content 7、forum 1、meta 10 均对应非 live 页，不会被当前 work-queue claim。
- pending_page：mismatch 138、pending 29、gone 1、resolved 2。

## 冻结时幂等回放（历史）

- 首轮成功票快照采用“两次完整观察才撤销缺席票”的安全策略，因此 182 个仍有差异但已完整抓取的活页被重新入队。
- runs 199–201 完成其中 150 页，全部 HTTP 200、0 partial/failed；产生 148 个 `revoke` 事件、0 个其他 vote event，属于第二次观察提升候选撤销。
- run 202 原计划继续剩余 32 页，但 `all` 已被 run 201 的解析熔断冻结；5 页因 PGF01 failed 后退出，27 页未处理。
- 截止冻结时尚未执行第三次全站幂等验证；该历史缺口已由上文 run 304 补齐。

## 已解决的停机事件（历史）

run 201 的 50 个定向回放任务本身全部解析并写入成功，HTTP 51/51 为 200，page scan 无 partial/failed；但该 cohort 是“仍有缺席票待二次确认”的高票页，`avg_votes_per_page=131.3333`。通用 Tier2 基线当时为 64.3667，偏离 +104.04%，解析健康策略据此冻结 `all`。这更像定向 cohort shift，而不是 HTML 解析坍塌，但按约定不擅自解除。

该事件现已由 population 分层、逐页完整性门和全站 replay 解决；当前 freeze=0，未强行
采用任何 checksum/完整性失败页。剩余 492 个差异是有证据的 partial/failed 与正常
退避，不再把“远端无法给出完整 voter 集合”等同于 CAS 不成立。
