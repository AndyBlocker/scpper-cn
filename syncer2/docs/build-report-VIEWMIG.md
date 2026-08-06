# VIEWMIG：v1 浏览类应用数据迁移与切流增量

日期：2026-08-06（Asia/Shanghai）  
分支：`scpper-backend-v2`；任务起始基线 `da743c7`；工作树未 commit、未 push  
数据库：v1 `scpper-cn` 只读；仅写 v2 `scpper-v2`  
任务边界：零 Wikidot 请求；未访问 `/home/andyblocker/qqbot`，未发送 QQ 消息

## 技术结论

三张浏览类表已经完成真实全量迁移，并用同一入口执行了两轮增量追平。最终快照逐表严格满足
`v1 快照行数 = v2 成功行 + 未解决拒绝行`，未归账均为 0：

| v1 → v2 | v1 快照 | 成功迁移 | 未解决拒绝 | 未归账 | 最终快照 |
|---|---:|---:|---:|---:|---|
| `PageViewEvent` → `app.page_view_event` | 1,249,229 | 1,248,659 | 570 | 0 | id ≤ 1,249,270 |
| `UserPixelEvent` → `app.user_pixel_event` | 299,837 | 299,795 | 42 | 0 | id ≤ 299,896 |
| `UserPageView` → `app.user_page_view` | 74,613 | 74,613 | 0 | 0 | `(updatedAt,id)` ≤ `2026-06-10 15:56:26.104893Z,74613` |

最终事件快照在 2026-08-06 08:24:49Z 前完成。首次全量固定的分母分别是
1,249,161、299,829、74,613；同入口 incremental 又追入 68 条页面浏览事件和 8 条用户像素事件，
`UserPageView` 高水位没有变化。该差量是“全量期间仍有 v1 写入”这一真实场景的正向验证。

拒绝没有被静默丢弃：570 条页面事件全部归为 `v2_page_not_found`，来自 1 个已知 v1
页面 wikidot 身份；42 条用户事件全部归为 `v2_user_not_found`，来自 14 个已知 v1 用户
wikidot 身份。v1 身份记录不存在、wikidotId 缺失、v2 多候选以及源事件字段与 v1 身份字段不一致
在本次快照均为 0。

## 范围、数据与口径

本次只迁浏览类数据，保持 v1 指纹字段完整，不裁剪
`client_ip`、`user_agent`、`accept_language`、UA 派生字段、`softprint`、`visitor_token`、
`tls_fingerprint` 等列。事件时间范围为：

| 表 | 最早业务时间 | 最晚业务时间 |
|---|---|---|
| `PageViewEvent.createdAt` | 2025-10-24 05:05:46.609Z | 2026-08-06 08:24:43.666Z（最终快照） |
| `UserPixelEvent.createdAt` | 2025-10-28 12:11:02.234Z | 2026-08-06 08:21:16.669Z（最终快照） |
| `UserPageView.first/lastViewedAt` | 2025-10-28 12:19:30.899Z | 2026-06-10 15:54:30.123Z |

不迁的时效性数据保持用户裁决：`UserFollow`、`UserActivityAlert`、
`ForumInteractionAlert`、`PageMetricAlert`、`PageMetricWatch`、`UserMetricPreference`。

## 外键按稳定身份重映射

迁移从不把 v1 `pageId` / `userId` 写进 v2 外键，也不拿 slug 做身份推断：

1. `PageViewEvent` 先以 v1 `pageId` JOIN v1 `Page` 取得 `Page.wikidotId`，再精确查询
   `ingest.page.wikidot_id`；只有唯一候选才写 `page_id`。
2. `UserPixelEvent` 以 v1 `userId` JOIN v1 `User` 取得 `User.wikidotId`，再精确查询
   `ingest."user".wikidot_id`；只有唯一候选才写 `user_id`。
3. `UserPageView` 同时执行上述页面和用户映射，任一边失败则整行进入拒绝审计。
4. 事件行自身的 `wikidotId` 作为原始业务列原样保留，但不替代 v1 身份表 JOIN。报告取数时三表
   的“事件 wikidotId 与 v1 身份 wikidotId 不一致”均为 0。

slug 不参与 SQL 或 TypeScript 的候选键。回归在 v2 真实创建同一 slug 的两代页面，断言来源
wikidotId 精确命中对应代，而不是命中当前 slug 或旧代。v2 的 wikidotId 唯一约束使本次没有
多候选；代码仍保留 `v2_page_ambiguous` / `v2_user_ambiguous` 分类，约束若被破坏也不会猜测。

## 幂等、续跑与增量

幂等键与进度水位刻意分离：

- 两张事件表新增 nullable `v1_id`，只对非 NULL 建唯一索引。迁移行用 v1 来源 id 去重，v2
  原生新事件保持 `v1_id=NULL`；v2 `id` 始终由 v2 identity 生成，没有复制 v1 主键。
- `app.user_page_view` 确认并新建为目标表，同时有唯一 `v1_id` 和应用自然键
  `(user_id,page_id)`。增量遇到 v1 聚合行更新时覆盖为最新源值，不叠加 `view_count`，避免重放放大。
- `meta.view_migration_cursor` 固定每次 pass 的上下界并记录批次断点；目标数据、拒绝行、cursor 和
  `meta.backfill_progress` 在同一 v2 事务提交。进程在任何批次之间退出都从最后已提交边界继续。
- 会话级 advisory lock 阻止两个迁移实例并发推进同一组游标。
- `full` 与 `incremental` 共用 `npm run view:migrate -- --mode <mode> --execute`。事件增量按 id
  追水位；可变的 `UserPageView` 按 `(updatedAt,id)` 追水位，并用数据库字符串保留 6 位微秒，
  避免 node-pg `Date` 毫秒截断。
- incremental 先重试历史未解决拒绝，再连续捕获新 head，直到源高水位稳定；切流冻结后可再执行
  同一命令，通常成为零行 pass。

迁移初次真实运行曾捕获一个微秒边界：74,613 个 `UserPageView` 共享微秒级 `updatedAt`，旧读取
若经 JS `Date` 会把上界截成毫秒并排除整批。修复后 full 会对“completed 但对账不闭合”的表自动
自愈重扫，74,613 行已全部闭合；专项回归钉住 `.104893Z` 六位精度。

## 失败审计与可重复对账

`meta.view_migration_reject` 以 `(source_table,v1_id)` 为主键，保存一个稳定 primary reason、
页面/用户 v1 id 与 wikidotId、全部 v2 候选数组、复合失败原因、首次/末次尝试和重试次数。
后来映射成功时不删除历史行，而是填写 `resolved_at`；当前失败查询固定加
`resolved_at IS NULL`。

当前失败分类：

| 来源表 | 原因 | 行数 | 涉及稳定身份 | 当前处理 |
|---|---|---:|---:|---|
| `PageViewEvent` | `v2_page_not_found` | 570 | 1 个页面 wikidotId | 保留拒绝；待该身份进入 `ingest.page` 后重跑 incremental 自动恢复 |
| `UserPixelEvent` | `v2_user_not_found` | 42 | 14 个用户 wikidotId | 保留拒绝；待身份补齐后自动恢复 |
| `UserPageView` | — | 0 | 0 | 全部成功 |

可重复对账入口是 `checks/0006_view_migration_reconcile.sql`：

```bash
psql "$SYNCER2_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f checks/0006_view_migration_reconcile.sql
```

它输出逐表快照分母、成功、拒绝、未归账和逐原因计数，并在已完成表的未归账非 0 时抛错。
无需跨库 FDW；v1 快照分母与边界已在开始 pass 时固化进 cursor。

## 既有 pending 可观测性没有漏表

本次没有另造一套 oldest-pending：迁移剩余量写入既有
`meta.backfill_progress(domain='view_migration')`，因此自动进入已覆盖的 `backfill_progress`
family，追平期间能报告剩余数、最老更新时间与是否仍推进。

三个新增物理表均在 `meta.pending_collection_audit_registry` 显式登记：

- `app.user_page_view`：当前态结果，`not_pending`；
- `meta.view_migration_cursor`：纯断点，`not_pending`，未完成量由 `backfill_progress` 承载；
- `meta.view_migration_reject`：已明确分类的终态审计，`not_pending`，不是自动消费队列。

`checks/0005_pending_collection_coverage.sql` 已通过，新增未分类表的双向差集为 0。

## v1 只读与数据库边界

迁移入口在发出源查询前同时检查：

- `SYNCER2_V1_DATABASE_URL` 必须原样保留
  `options=-c default_transaction_read_only=on`；缺失即拒绝连接；
- v1 数据库名必须是 `scpper-cn`，目标必须且只能是 `scpper-v2`；
- v1 会话的 `default_transaction_read_only` 和 `transaction_read_only` 必须都为 `on`；
- 源代码的 v1 路径只有固定白名单 SELECT 与会话 `SET TIME ZONE`。

回归另外对 v1 发出 `CREATE TEMP TABLE` 写探针，PostgreSQL 以 SQLSTATE `25006`
（read-only SQL transaction）拒绝，证明只读不是注释或客户端约定。探针没有产生任何 v1 数据。

## 回归与验证

- 同一 `PageViewEvent` 批次重放两次：目标行数保持 1，去掉 v2 `id` 后的内容指纹不变；第二次
  `INSERT ... ON CONFLICT` 写入数为 0。
- `UserPageView`：一次性写最终两行，与“先写半量旧值、再以 incremental 写更新值和剩余行”
  的最终内容指纹完全一致。
- 同 slug 两代页面：按来源 wikidotId 精确命中对应 `page_id`。
- 映射失败：目标零行，拒绝审计为 `v2_page_not_found`；补入身份后重放，目标成功且原拒绝行
  `resolved_at` 非空。
- 微秒水位：`.104893Z` 从 PostgreSQL cursor 读回仍是六位微秒。
- v1 写探针：SQLSTATE `25006`。
- `migrations/0041_view_event_migration.sql` 在 `scpper-v2` 连续重放三次通过；新触发函数对
  `PUBLIC` 的 EXECUTE 为 false。
- `npx tsc --noEmit`：PASS。
- `tests/view-migration.test.ts`：5/5 PASS。
- `npm test`：一轮受活库偶发依赖影响为 402/403；未改断言，原样重跑后
  **403/403 PASS**（既有 398 + 新增 5）。
- `checks/0005_pending_collection_coverage.sql`：PASS。
- `checks/0006_view_migration_reconcile.sql`：PASS，三表未归账均为 0。
- `git diff --check`：PASS。

## Collections 建议单独决策

按用户要求，本次没有迁移 `UserCollection`、`UserCollectionItem`、
`CollectionAccountOwner`。报告取数时 v1 分别有 177、835、782 行。

这三表与关注/告警不同：它们是用户主动保存和编排的持久内容，不具明显时效性；不迁会永久丢失
收藏夹标题、注释、排序、封面和账号所有权。因此建议后续单独做一次产品裁决，默认倾向迁移。
若决定迁移，仍应沿用本次的用户 wikidotId、页面 wikidotId 重映射和逐行拒绝审计；同时需要先
明确外部 `accountId` 与 v2 用户的所有权冲突策略，不能顺带塞进本次浏览增量。

## 运维命令与未决项

执行期间同一共享 worktree 的 HEAD 被外部提交推进到 `1db3ed1`（只改
`0040_pending_collection_observability.sql` 的年龄基准）；本任务没有执行 commit/push/reset，
且该提交与本次文件无重叠。最终类型检查、403 个测试和两条 SQL 检查均在新 HEAD 上通过。

首次或中断续跑：

```bash
npm run view:migrate -- --mode full --execute --batch-size 5000
```

切流前追平与失败重试：

```bash
npm run view:migrate -- --mode incremental --execute --batch-size 5000
```

当前没有实现阻塞。切流操作本身仍应在冻结 v1 浏览写入后再执行最后一轮 incremental 和
`checks/0006_view_migration_reconcile.sql`；570 + 42 条目标身份缺失不会阻塞已映射数据切流，但产品/
运维应明确接受这些可查询拒绝，或先补齐对应的 1 个页面和 14 个用户身份后再跑 incremental。
