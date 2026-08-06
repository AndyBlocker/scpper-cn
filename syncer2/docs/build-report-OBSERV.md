# OBSERV：最老待处理项、终态类型与 SQL 调参防回归

日期：2026-08-06（Asia/Shanghai）  
分支：`scpper-backend-v2`；工作树未 commit、未 push  
目标库：仅 `scpper-v2`；v1 连接与服务端只读强制未修改；未访问 `qqbot`、未发送 QQ，
本任务没有发起 Wikidot 请求。

## 结论

“还做了多少”之外，现在每个待处理集合都能统一回答：有多少项、最老项何时进入、是哪一项、
是否属于一次性追平、从哪个样本起持续恶化。当前态由
`meta.pending_collection_current` 给出；每五分钟采样写
`meta.pending_collection_sample`；连续告警 episode 写
`meta.pending_collection_alert`，含 `started_at`、峰值年龄/数量、最新最老实例和原始证据。

活库已完成两次真实采样，共 74 行、2 个采样时刻、43 个出现过的集合。最能说明判据的两组是：

| 集合 | 15:31 | 15:42 | 结论 |
|---|---:|---:|---|
| `scan_task:votes_full` | 27,598；最老 key 15375；208h | 27,593；同一 key | 总量有进展，`ok/catchup_progressing`，不因一次性追平的历史年龄误报 |
| `scan_task:attributions` | 1；最老 key 62886；约 192.7h | 仍为 1 | `critical`；episode 恶化起点保持首个样本 15:31，不被大队列吞吐淹没 |

冷启动前没有伪造历史：首个 episode 的 `started_at` 是“监控首次确认恶化”的下界；每条样本同时
保留真实 `oldest_item_at` 与年龄，后续序列会把持续时间完整钉住。集合清空时仍写一条 count=0
样本并关闭 episode，不会用“后来查不到”代替恢复证据。

## 1. 常驻能力

### 数据面

- `migrations/0040_pending_collection_observability.sql`：样本表、告警 episode、穷尽审计登记表和
  当前极值视图；已在 `scpper-v2` 连续应用两次。
- `src/observability/oldestPending.ts`：单事务采样、阈值/趋势判定、样本追加、告警开闭；有
  目标库黑名单和 advisory transaction lock，避免误写 v1 或两个调度器同时采样。
- `src/cli/oldest-pending.ts`：纯 PostgreSQL 短任务，不构造 HttpClient，也不连消息通道。
- `checks/0003_oldest_pending.sql`：显示当前极值、最近判定和恶化起点，并断言每个 open alert
  至少有一条非 `ok` 样本证据。

### 调度面

- systemd：`syncer2-oldest-pending.timer` 在 `:01/:06/...` 每五分钟运行，专用超时 2 分钟；
  `Persistent=false`，停机期间不补跑一串过期巡检。
- PM2 退路：同名 app 使用 `cron_restart` + `autorestart:false`，不制造常驻重启循环。
- `package.json` 提供 `meta:oldest-pending` / `schedule:oldest-pending`；`RUNBOOK.md` 已加入周期、
  安装、启停和 PM2 白名单。
- 告警载体是 `meta.pending_collection_alert` + 单行 JSON/journal；按任务边界没有增加 QQ 或其它
  外部通知。通知器以后只需读取 open episode，不需要重建历史。

### 一次性追平判据

追平标志不靠“数量大”猜：`votes_full` 要求至少 80% 任务带
`votes_v2_initial_catchup` reason；其它明确回填集合由其状态直接标记。越过年龄阈值后：

1. 第一个样本先留证，等待 30 分钟趋势窗；
2. 总量下降或最老 key/时间前移，判为正在推进，不报警；
3. 总量与头部都连续 30 分钟不推进，按当前年龄分 warn/critical；
4. 即使总量一直下降，同一最老 key 若跨过该集合的 critical 窗仍报警，避免旁边完成的多数
   永久掩盖一个饿死项。

这使“已知 2.7 万项追平”和“单个 attribution 卡 190 小时”走两条不同判据，同时没有重新引入
平均值或失败率分母。

## 2. 待处理集合穷尽审计

审计范围是 `meta`、`serve`、`app` 的全部物理表，不按表名抽样。当前共 95 张：23 张确有
pending/最久未刷新语义并覆盖，72 张明确登记为事实、历史、当前态、配置或终结结果。
`checks/0005_pending_collection_coverage.sql` 对实际表与登记表做双向差集：以后新增一张表却没有
回答“它是否 pending”，CI 直接失败。

| 物理来源 | 暴露的集合（按需再按 kind/status/source 拆分） | 最老时刻口径 | 覆盖 |
|---|---|---|---|
| `meta.scan_task` | `scan_task:<kind>`，覆盖 11 个受约束 kind | `created_at` | 是 |
| `meta.revision_source_backfill_job` | `ready(pending/retry)`、`processing` | `created_at` / `locked_at` | 是 |
| `meta.irreconcilable` | `irreconcilable:<fixed kind>`，仅 unresolved | `first_seen` | 是 |
| `meta.projection_cursor` | `projection_cursor:<projection>`，仅低于事实高水位 | `updated_at` | 是 |
| `meta.ingest_run` | `ingest_run:running:<source>` | `started_at` | 是 |
| `meta.incremental_drift_state` | unresolved `:<kind>` | `first_detected_at` | 是 |
| `meta.pending_page` | `pending/failed/mismatch` | `first_seen_at` | 是 |
| `meta.forum_scan_task` | `forum_scan_task:<kind>` | `first_seen_at` | 是 |
| `meta.observation_queue` | `pending/failed` | `enqueued_at` | 是 |
| `meta.image_ingest_job` | `pending/processing/failed` | 创建或锁定时间 | 是 |
| `meta.vote_sweep_page_state` + `serve.page_current` | live 页首轮完整票快照尚未覆盖 | 发布/建页时间 | 是 |
| `serve.page_current` | 已覆盖但完整票快照超过 30 天 | `last_complete_vote_snapshot_at` | 是 |
| `meta.incremental_page_state` + `serve.page_current` | live 页 L1 超过 30 分钟未见/从未见 | `last_l1_seen_at`，无则发布/建页时间 | 是 |
| `meta.ingest_gate` | 事务已结束却仍残留的 gate 行 | `started_at` | 是 |
| `meta.revoke_candidate` | `pending/held` | `first_seen_at` | 是 |
| `meta.backfill_progress` | `done_count < total_count`，按 domain/shard | `updated_at` | 是 |
| `meta.write_freeze` | 每个仍 frozen 的 domain | `frozen_at` | 是 |
| `meta.egress_alert` | 未 acknowledged，按 kind | `created_at` | 是 |
| `meta.egress_control` | level>0 或 budget breach，按 site | `changed_at` | 是 |
| `serve.page_image` | `pending/queued/fetching/failed` | `last_queued_at/extracted_at` | 是 |
| `serve.image_asset` | `pending/fetching/failed` | `first_seen_at` | 是 |
| `serve.page_reference` | `ambiguous`；正常 `missing` 红链明确排除 | `computed_at` | 是 |
| `app.tag_guide_sync` | `pending/failed` | `created_at` | 是 |

审计额外撞见 `meta.ingest_gate` 有已结束事务残留。第一次检查约 1,941 行、最老约 2.4 小时；
完整回归中的既有 `ingest_gate_sweep()` 已把它们收掉，第二次采样该 episode 自动关闭并留下 count=0
证据。这些行不钳制当前 safe watermark（函数另查 `txid_status='in progress'`），但原先会静默增长，
现在 15 分钟即告警。

## 3. 阈值与依据

阈值单位见表；追平集合还叠加上一节的趋势/头部公平性门控。没有统一阈值，也不使用平均年龄。

| family / 特例 | warn / critical | 依据 |
|---|---:|---|
| `scan_task:attributions` | 30h / 72h | 24h 播种契约 + 6h 抖动；三天严重 |
| `scan_task:new_page_highfreq` | 6h / 12h | 新页完整票 3h 契约的 2×/4× |
| 其它 `scan_task` | 6h / 24h | 每分钟消费、失败首退避 1h；6h 已跨多轮 |
| revision source `ready` / `processing` | 2h/6h；30m/1h | 半小时最多 300；processing 锁 15m 回收 |
| `irreconcilable` | 8d / 14d | 七天复查 + 一天调度余量；两周严重 |
| `projection_cursor` | 30m / 2h | 投影 10m 一轮；30m 已连续错过多轮 |
| `ingest_run` / drift | 1h / 6h | 短进程分钟级；L1/work queue 也已形成多轮证据 |
| `pending_page:mismatch` | 1d / 7d | 需上游变化或人工；其它 pending_page 为 30m/2h |
| forum task | 2d / 7d | 日级发现/消费；允许跨一轮 |
| observation queue | 30m / 2h | 双写观测应由短进程持续消费 |
| image job / page image | 1d / 3d | 低优先异步管线；asset 已入抓取态则收紧为 1h/1d |
| vote 首轮追平 | 6h / 24h | 832/h，下降时抑制；同一头部 24h 不动仍报 |
| vote 周期刷新 | 36d / 45d | 30d 盲扫契约 + 20% 调度余量 |
| L1 最久未见 | 30m / 1h | 五分钟全站枚举；30m 是连续漏页 |
| stale ingest gate | 15m / 1h | 事务生命周期应分钟级收口 |
| revoke candidate | 2h / 1d | 完整快照确认后应转正或 held 待人处理 |
| backfill progress | 6h / 1d | 大批下降不报；停滞才报 |
| write freeze | 1h / 6h | 待人工释放的运行态，不能常驻 |
| egress alert/control | 15m / 1h | 分钟窗口恢复；15m 未清需值守关注 |
| ambiguous reference | 1d / 7d | 需身份变化或人工；missing 不是异常 |
| app tag guide sync | 1d / 3d | 不应跨多个日级维护周期 |

新 family 若漏专属策略，会先落保守默认 6h/24h；但覆盖检查与代码评审应同时补充业务依据。

## 4. `irreconcilable.kind` 类型/实例拆分

`migrations/0039_irreconcilable_kind_instance.sql` 已把 1,101 个
`revision_source:<revision_seq>` 原地改为固定 `kind='revision_source'` 和独立 bigint
`instance_id`。表新增 surrogate `id` 主键；业务幂等键为
`UNIQUE NULLS NOT DISTINCT(page_id, kind, instance_id)`。

两个 CHECK 共同封死回归：`kind` 只能取 scan-task 固定词表外加 `revision_source`；只有
`revision_source` 必须且只能带正 instance_id。所有写入口已改为三列 conflict target。
迁移在活库、自动回归中都连续执行两次，行数与内容指纹不变；当前冒号 kind 为 0，1,101 行
全部保留。现在 `GROUP BY kind` 只产生真正类型，不再产生上千个实例伪类型。

## 5. 1,101 份 revision source 为何放弃、能否恢复

原状态机把任何相同错误连续三次都终结，所以一次 HTTP/出口故障也被记成“不可调和”。保留的
`remote_value.error` 足以在零 Wikidot 请求下完成根因重算：

| 原因 | 原 1,101 中 | 迁移后 | 可恢复性 |
|---|---:|---|---|
| `status=no_permission` | 1,011 | 1,011 irreconcilable | 当前匿名抓取不可恢复；995 条来自 66 个仍标 live、slug 为 `deleted:` 的归档页，另 16 条来自 6 个普通 live 页。需授权会话、权限变化或替代数据源 |
| `status=revision_error` | 85 | 80 skipped_deleted；5 irreconcilable | 80 条所属页已非 live；余 5 条集中在 1 个 live 页，当前上游明确拒绝，等上游修复或人工替代源 |
| HTTP 5xx | 3 | 1 retry；2 skipped_deleted | live 的可恢复，已立即重排；另两页已非 live |
| transport reset | 1 | retry | 可恢复，已立即重排 |
| circuit open | 1 | retry | 可恢复，已立即重排 |

因此 82 条因页面现已删除而退出 live 回填范围；3 条纯瞬时故障回到 retry 且连续失败计数清零；
剩余 1,016 条仍是有证据的目标级缺口。运行时代码也已改成只有稳定目标错误才累计三次并终结，
5xx/transport/circuit 始终 retry，不会再用退避把链路故障伪装为完成。

正确的完成度表述是：

- 原口径“队列无 pending、所有任务都有终态”曾是 **100% 归账/排空**，不是 100% 获得源码；
- 总范围成功获得源码为 **347,991 / 349,102 = 99.681755%**；
- 排除当前 92 条 `skipped_deleted` 后，live-scope 成功率为
  **347,991 / 349,010 = 99.708031%**，另有 1,016 个确定性缺口和 3 个可重试项；
- 当前状态总账：347,991 done、1,016 irreconcilable、3 retry、92 skipped_deleted。

## 6. SQL 装饰品常量防回归

`src/health/sqlTuning.ts` 成为 SQL 调参常量的唯一登记处：四个 sweep/new-page 常量的导出值都
来自该 registry，真实 node-postgres 参数位用 `bindSqlTuning(name, value)` 标记。检查器用
TypeScript AST，只承认 `query(db,label,sql,[...])` 第四参数数组中的绑定；注释、普通 JS 引用、
同名字符串都不能充数。

`npm run check:sql-tuning` 当前通过。负向回归会把
`VOTE_SWEEP_INTERVAL_DAYS` 的所有真实绑定替换掉，再断言检查器精确报缺；这证明“导出但 SQL
仍硬编码/不引用”的下一次回归会失败，而不是只验证现在四个值恰好相等。

## 7. 回归与部署状态

- `npx tsc --noEmit`：PASS。
- `npm run check:sql-tuning`：PASS；负向变异测试 PASS。
- `tests/observability.test.ts`：10/10 PASS；覆盖持续变老、稳定下降追平、单项长期不动、
  追平头部长期饿死、0039 连跑与约束、瞬时源码失败恢复。
- `npm test`：**398/398 PASS**（基线 387 + 新增 11）。
- `checks/0003_oldest_pending.sql`、`checks/0005_pending_collection_coverage.sql`：PASS。
- `git diff --check`：PASS。
- `0039`、`0040` 各在 `scpper-v2` 连续应用两次；`9002_grants.sql` 重跑 PASS，PUBLIC 可执行的
  SECURITY DEFINER 函数仍为 0。

完整既有 `checks/run_checks.sh` 另有一项与本任务无关的活库接线红灯：
`0002_write_freeze_wiring.sql` 报既有 `apply_vote_cas_batch` 未调用 R10 freeze guard；本次新增的
0003/0005 与其它检查均通过。没有为变绿改该断言，也没有扩大到旧写入函数修复。

本任务无实现阻塞。生产实际启用 timer 仍按 RUNBOOK 由运维执行；仓库部署源、数据库对象和
PM2 退路均已就绪。
