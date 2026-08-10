# FIX2：论坛完整性、修订倒退收敛与分链路成功率

日期：2026-08-11（Asia/Shanghai）  
分支：`scpper-backend-v2`  
目标库：`scpper-v2`

## 结论

三个故障面均已修复并在实际 v2 调度中验证：论坛定向增量可以写入正面事实，但不会取得
absence 推断授权；完整 thread 枚举仍可显式取得授权。`wanderers:xiaoxiaji` 的身份未改变，
实际形态是同一 Wikidot 页面删除过历史修订，ListPages 修订水位从 3 合法回落到 1；新状态机
已接受新水位，完整修订扫描成功，不再 pending。oldest-pending 现在会把最近一小时内某个
`page_scan.kind` 扫描至少 10 次且成功为 0 的情况立即判为 critical，同时把 0 次扫描明确
标为 `no_tasks`。

涉及数据库对象的 `0053_fix2_pipeline_convergence.sql` 已在依赖代码启用前先应用到
`scpper-v2`，之后又重跑一次验证幂等。没有修改 v1 只读连接约束，没有触碰 qqbot，
没有发送 QQ 消息，没有 commit 或 push。

## 1. 论坛：把写入成功与 absence 授权拆成两个维度

### 根因

原 6 参数 `ingest.apply_forum_batch` 无法证明 thread 是否完整翻页，因此保守写
`meta.page_scan.status='partial'` 的断言是正确的。新论坛增量链路调用同一入口时没有携带
范围语义，导致定向正面事实虽然适合 upsert，却永远无法形成成功扫描证据。反过来，若只
把该断言放宽为 `ok`，又会让下游误把定向批当成完整集合，重新打开幻影删除路径。

### 解法

迁移新增 7 参数重载：

```sql
ingest.apply_forum_batch(..., p_complete_thread_ids jsonb)
```

调用方逐 thread 声明哪些数据经过完整枚举。数据库在 `meta.page_scan` 上分别记录：

| 批次 | `status` | `forum_completeness` | `absence_authorized` |
| --- | --- | --- | --- |
| 定向增量 | `ok` | `targeted` | `false` |
| 完整枚举 | `ok` | `complete` | `true` |
| 有隔离事实 | `partial` | 按声明 | `false` |

CHECK 约束保证只有 `kind='forum' AND status='ok' AND
forum_completeness='complete'` 才能设置 `absence_authorized=true`；非 forum kind 不能设置
论坛完整性字段。旧 6 参数入口继续保守，不获得授权。

TypeScript 写入口现在总是传完整性数组。ForumStart/分类发现等定向批传 `[]`；完整 thread
深扫及完整页面讨论扫描传对应 thread id。缺失帖 tombstone 仍只为
`completeThreadIds` 计算，因此定向批既能写入又不能推断删除。

实际恢复证据：修复前观测到论坛最近一小时 158 次扫描、成功 0；代码生效后最终复核为
152 次扫描、成功 34，链路已持续产生 `ok` 证据。

## 2. 修订：同一身份下删除历史修订是合法状态

### 实际页面结论

`wanderers:xiaoxiaji` 当前为 live：

- v2 `page_id=1500002780`；本地与远端 `wikidot_id=1469114077` 一致；
- 页面 GET 正常返回 200，slug 未变化，norender pageId 也未变化；
- 远端 RevisionList 在 ListPages `revisions=1` 的口径下完整返回 2 行；
- 因此不是 slug 复用或页面删除，而是同一页面的历史修订被管理员删除，水位 3→1 合法。

### 既有复核为何没有覆盖

这是系统性盲区，不是该页特例，共有三层：

1. 既有 IDCHECK 由 AMC 空响应/空体 500 等失败签名触发；本次 L1 ListPages 请求成功，只是
   `revision_count` 变小，触发入口不同。
2. 旧 meta handler 对“slug 与 Wikidot ID 均未变”只会再次写 partial，没有接受合法低水位
   的终态，因此每轮都重新产生同一 pending。
3. 页面还残留一条未关闭的 `kind='meta'` irreconcilable。入队和认领两道门都会排除同 kind
   任务，导致即使 L1 生成身份复核原因，worker 也永远看不到它。

任何同身份页面发生合法修订删除都可能触发前两层；若同时存在旧 meta 终态还会触发第三层，
所以与 scp-cn-4885 / scp-cn-4860 / scp-cn-2801 同型，属于机制性缺口。

### 收敛机制

新增 `meta.revision_regression_identity_state`，把过去只存在于 `page_scan.error` 的信息改成
显式、可锁定、可终结的 L0/L1 状态。L0/L1 在入队前先保存 previous/observed revision、
slug、预期 Wikidot ID 与对应观测字段。

带 `revision_regression_identity_check` 的 meta 任务可精确穿过旧 meta irreconcilable 的入队
和认领门；其他任务仍受原终态门禁保护。只有实际身份 GET 成功后，既有 worker 完成逻辑才
关闭旧终态，不会用 ListPages 证据提前清除任意 meta 矛盾。

复核结果分三路：

- Wikidot ID 与 slug 未变：在 page/current/incremental state 行锁内 CAS 接受较低水位，
  状态终结为 `accepted_same_identity`，并以优先级 100 补一个 `revisions_full`；
- Wikidot ID 改变：继续走既有 successor/lineage 路径，并终结倒退状态；
- slug 消失：继续走既有删除生命事件，并终结倒退状态。

实际收敛证据：05:43 身份任务确认同一 ID，L1 水位从 3 更新到 1；05:44 下一轮 L1 已为
`ok`，没有再生成 pending；随后 `revisions_full` 为 `ok`（claimed 1、fetched 2），任务删除。
当前 `regression_status='accepted_same_identity'`，该页 pending 数为 0。

## 3. 监控：逐 kind 的滚动零成功判据

迁移新增 `meta.page_scan_kind_health`，对 9 个既有 page_scan kind 计算最近 1 小时：

```text
scan_count >= 10 AND success_count = 0  => critical / rolling_zero_success
scan_count = 0                          => ok / no_tasks
其余                                      => ok
```

critical kind 以 `page_scan_success:<kind>`、family=`page_scan_zero_success` 进入
`meta.pending_collection_current`，随后由既有 oldest-pending 快照、趋势与告警表处理。
`checks/0003_oldest_pending.sql` 同时展示逐 kind 统计，并断言 0 次扫描不得告警、达到阈值的
零成功 kind 必须进入 pending 当前态。修订身份 pending 也纳入同一观测框架。

回归用事务构造 `files=100 次扫描/0 成功`，视图和 TypeScript 判据均为 critical；同时构造
`attributions=0 次扫描`，结果为 `ok/no_tasks` 且不进入 pending。实际运行
`npm run meta:oldest-pending` 成功采集 53 个集合；当前论坛和修订均已有成功，因此不会保留
零成功告警。

## 4. 变更范围

- schema/SQL：`migrations/0053_fix2_pipeline_convergence.sql`、
  `checks/0003_oldest_pending.sql`；
- 论坛入口：`src/collect/forum.ts`；
- 修订发现与状态：`src/cli/incremental-scan.ts`、`src/store/incremental.ts`；
- 复核队列：`src/store/meta.ts`、`src/store/workQueue.ts`、`src/work/handlers.ts`、
  `src/work/identityCheck.ts`；
- 观测判据：`src/observability/oldestPending.ts`；
- 回归：新增论坛数据库契约测试，并扩展 forum、identity、work-queue、observability 覆盖。

## 5. 验证与遗留

- `0053_fix2_pipeline_convergence.sql`：在代码生效前应用；二次应用成功；SECURITY DEFINER
  对 PUBLIC 可执行数为 0。
- `checks/0003_oldest_pending.sql`：通过。
- 专项论坛/监控测试：28/28；身份与 work-queue：18/18。
- `npx tsc --noEmit`：通过。
- `npm test`：459/459 通过（原 455 加本次 4 个回归），exit 0；没有放宽既有断言。
- `git diff --check`：通过。
- 全量 `checks/run_checks.sh` 中，本次未触及的既有项仍有两处失败：
  `apply_vote_cas_batch` 未接 write-freeze，以及
  `meta.forum_incremental_category_state` 未登记 pending audit；0003 和其余检查通过。
  两项不阻塞本次三条链路，但应另案修复。

本任务范围内无阻塞。
