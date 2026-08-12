# Syncer2 自旋与 30 天投票盲扫修复报告

## 结论

`new_page_highfreq` 的空转已经闭环修复：`votes/ok` 现在是推进
`last_complete_vote_snapshot_at` 的数据库不变式，同时播种侧和三个认领入口都以最近
`votes/ok` 证据做独立的 3 小时硬闸。即使以后快照应用逻辑再次漏推进字段，同一页也不能
在合同间隔内重新执行。

30 天盲扫已移除 90 天投票活动过滤，覆盖集合改为全部 live 页；发布未满 7 天的 live 页
由更严格的 3 小时车道覆盖。对全站 L1 默认看不见的少量隐藏/特殊页，每次盲扫先做一次
精确、包含 hidden 页的目标 ListPages claim，再抓 WhoRated，仍不使用本地聚合冒充远端
声明。

迁移 `0059_vote_snapshot_success_clock.sql` 已先应用到 `scpper-v2`，随后才修改依赖该不变式
的 TypeScript。未修改 v1，未触碰 qqbot，未发送消息，也未 commit/push。当前无阻塞。

## 一、两类页面为何都成功但不推进

共同缺口在 `ingest.apply_vote_snapshot` 的幂等分支：规范化后的新快照与
`serve.vote_current` 行数、哈希相同，就先写 `meta.record_page_scan(..., 'votes', 'ok', ...)`
再提前返回。只有后面的整体替换分支原来会更新
`serve.page_current.last_complete_vote_snapshot_at`。

两类页面进入这个分支的触发条件不同，不能混为一个数据原因：

- **零票页首次观测**：初始 `serve.vote_current` 本来就是 0 行；合法完整的 0 票快照也是
  0 行且空集合哈希相同。因此“第一次完整观测”就被误判成内容幂等重放，时间从 NULL
  开始便永远不推进。这解释了 `fragment:`、`component:`、`experiment-log-*` 等页。
- **已有票页的无变化重扫**：这些页以前至少有一次整体替换，所以有旧快照时间；之后
  WhoRated 内容不变时正常命中幂等分支。内容幂等是对的，但把“事实没变化”错误等同于
  “本轮没有完成观测”，使完整快照时间永久停在旧值。这解释了另外 38 个有票页。

## 二、修复与独立防重复闸

### 成功时钟成为数据库不变式

迁移 `0059_vote_snapshot_success_clock.sql` 在 `meta.page_scan` 上建立事务内触发器。任何
`kind='votes' AND status='ok'` 的 INSERT/UPDATE 都以 `scanned_at` 单调推进 live 页的
`last_complete_vote_snapshot_at`。它同时覆盖：

- 内容变化后的整体替换；
- 已有票页内容不变的幂等重放；
- 首次完整观测就是空集合的零票页。

触发函数使用限定 schema、固定 `search_path`，并撤销 PUBLIC EXECUTE；迁移有受保护库
拒写门。这样快照时钟由“成功证书”驱动，不再依赖某一个 apply 分支是否走到尾部。

### 3 小时硬闸不依赖快照字段

以下路径都增加了相同判据：若同页最近 3 小时存在 `meta.page_scan(kind='votes',
status='ok')`，`new_page_highfreq` 不得通过。

1. `seed_vote_highfreq`：拒绝重新播种；
2. `claimWorkTasks`：通用 worker 拒绝认领已误入队任务；
3. `claimVoteTasks`：投票专用认领同样拒绝；
4. `claimIrreconcilableReviews`：终态复查入口也不能绕过。

因此保护不是“希望快照字段继续正确”，而是由另一张证据表直接断言间隔。恰好到 3 小时
后可以重新扫描，合同上界仍清晰可推导。

## 三、其它 kind 的同类收敛审计

对 `ALL_WORK_TASK_KINDS` 的 11 个 kind 做了穷举断言；测试要求集合完全相等，新增 kind
若未分类会直接失败。

| 类型 | kind | 成功后关闭入队驱动的方式 |
|---|---|---|
| 状态驱动 | `new_page_highfreq` | `votes/ok` 推进时钟，另有独立最近成功硬闸 |
| 状态驱动 | `votes_full` | 完整成功写 `meta.vote_sweep_page_state` |
| 状态驱动 | `attributions` | 成功写 `page_scan(attributions, ok)`，播种查询读取该证据 |
| 状态驱动 | `discussion` | 成功的 page-meta 应用填充 `page_current.thread_id` |
| 新观测驱动 | `confirm_deleted`, `meta`, `sitemap_delta`, `content`, `revisions_full`, `files`, `forum` | 成功删除当前任务；只能由新的外部观测/父任务再次触发，不由永久未完成字段原地重建 |

未发现另一个现存的“扫描成功但驱动其入队字段不变”的 kind。

审计过程中拦住了一个本次 cohort 扩展原本可能引入的新尾部：定向 ListPages claim 不能
跨 30 天复用，否则页面票态变化后会用旧 claim 永久校验失败。最终实现只复用周期更新的
全站/分段 L1 claim；全站 L1 缺席页每次盲扫都刷新定向 claim。

## 四、30 天 cohort 与出口估算

`VOTE_SWEEP_ACTIVITY_DAYS`、`recent_activity` CTE 及 `serve.vote_current.last_voted_at` 过滤
已全部删除。population、首轮追平和稳定相位三段 SQL 均从
`serve.page_current WHERE status='live'` 开始；未满 7 天页由 3 小时车道覆盖，其余页按
`page_id` 稳定相位铺满 30 天。

`VOTE_SWEEP_INTERVAL_DAYS.reason` 现在明确为：

> 全部 live 页（新页由更快的 3h 车道覆盖）发现 L1 不可见抵消型投票变化的最长兜底周期

2026-08-13 04:47:23 +08 对 v2 的只读实测为 36,531 个 live 页；同一时点旧 90 天活动
条件只覆盖 32,064 页。全站 L1 claim 尾部审计另找到 23 个 live 页，主要是
`_template` / `_404`；目标请求显式使用 `pagetype='*'`，并要求恰好返回相同 fullname。

稳态名义请求量（不含网络重试）如下：

| 口径 | 请求速率 | 5,400/h 预算占比 |
|---|---:|---:|
| 全部 live 页的 WhoRated | 36,531 / 720 = **50.74/h**（小时额度为 50 或 51） | **0.940%** |
| 23 个 L1 尾部页的定向 claim | 23 / 720 = **0.032/h** | **0.0006%** |
| 合计 | **50.77/h，约 1,218.5/天** | **0.940%** |
| 按用户取样新增 2,021 页的边际量（含尾部 claim） | **约 2.84/h** | **0.0526%** |

同一实测时点共享出口为 3,909/5,400 请求，瞬时余量 1,491/h；全部 30 天稳态约占该余量
3.40%，按用户取样的边际量约占 0.19%。以题面给出的闲置 1,883/h 计算，两者分别约占
2.70% 和 0.15%。这些是稳态播种对应的名义请求估算；瞬时重试仍由现有共享自适应出口
预算约束。

## 五、回归证据

- 零票页进入高频车道：首次空快照命中幂等分支，但 `votes/ok` 仍把 NULL 时钟推进；
- 人为把快照字段重新置 NULL 后在 1 小时内再播种：无任务产生；强行插入任务后认领为空；
- 30 天 cohort 源码断言不得出现 `serve.vote_current`、`recent_activity` 或活动字段；
- 11 kind 完整集合逐项断言成功出口会关闭状态驱动，或只能由新观测再次触发；
- 定向 claim 请求断言包含 hidden 页，严格拒绝 fullname 不一致；
- `npm run check:sql-tuning`：通过；
- `npx tsc --noEmit`：通过；
- 相关回归：40/40 通过；
- `npm test`：510/510 通过（基线 507，新增 3 条），0 fail、0 skip。
