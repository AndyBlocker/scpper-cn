# PENDCLEAN 建设报告

日期：2026-08-06  
目标库：`scpper-v2`  
结论：三类 `pending_page` 已进入语义正确的终态/复查态，队列具备自动收敛链路；3 页生产污染已清除，测试客户端、数据库与巡检三道写入门已落地。无本任务阻塞。

## 1. pending 的语义收口

### 受限分类 `mismatch`

存量 138 项不再被当作普通 HTTP 身份冲突。正当证据链为：

1. pending 来自 ListPages 的完整 fullname，且分类仅限 `adult:` / `wanderers-adult:`；
2. v1 中有唯一、未删除、带 `wikidotId` 的历史 URL 身份；
3. `adult:foo → foo`、`wanderers-adult:foo → wanderers:foo` 的历史 URL 映射精确匹配；
4. 如 v2 已有该 `wikidotId`，当前 slug 必须是完整 fullname 或上述历史 slug；如尚无身份，才调用 `ingest.register_page` 铸造。

通过后写 `resolved + finished_at`，`resolution_source=restricted_listpages_v1_reuse`，并在 `resolution_evidence` 记录 fullname、历史 slug、wikidot id、只读事实与是否复用 v2 身份；新消费路径还记录真实 v1 page id，存量 SQL 迁移只记录当时可直接证明的 v2 page id，不把 surrogate id 猜作 v1 id。证据缺失时不发无意义的匿名整页 GET，而是进入 `waiting_evidence`，4 小时后自动复查。

v1 门强制连接目标为 `scpper-cn`，URL 必须保留服务端 `default_transaction_read_only=on`；客户端 startup options 再强制只读，连接后同时校验 default/transaction read-only。未放松 v1 保护。

### `gone`

4 项 404 保留为真正终态 `gone`，写入 `finished_at`、`resolution_source=wikidot_http_404` 与结构化证据。这些 slug 没有可删的 v2 身份行，因此终结 pending 就是正确删除路径；若完整发现层在 `finished_at` 之后再见同 slug，UPSERT 会将其重新打开为 `pending`，不会永久屏蔽同名新页。

### `failed`

1 项旧 `failed` 在迁移时规范化为立即到期的 `retry`。实际运行一次 `resolve-pages --limit 1`，原冻结页 `pissweed` 成功解析并进入 `resolved`/`finished_at`。若仍失败，会按 1h/4h/24h 重试；第 4 次起进入 `irreconcilable`，每 7 天自动复查，不再有静止的 `failed`。

## 2. 自然收敛机制

- `resolve-pages` 现在认领 `pending/retry/waiting_evidence/conflict/irreconcilable`，只认领 `not_before` 已到的行；`failed/mismatch` 仅作滚动部署兼容入口。
- systemd timer 每 5 分钟触发消费者；认领使用 `FOR UPDATE SKIP LOCKED`，15 分钟后回收陈旧锁。
- 每个非终态都必须有下一个 `not_before`；`state_changed_at` 记录当前状态年龄，不再永久继承 `first_seen_at`。
- oldest-pending 仅将已到期的 waiting/conflict/irreconcilable 纳入待执行集；IM 队列也按 due 口径计算 ready 与最老年龄。
- 新增受限页的事务回归证明：ListPages + v1 只读候选可自动铸身份、写证据并 `resolved`；候选未到则定时复查，不会再无声挂起。

活库最终分布：`resolved=393`、`gone=4`，旧 `failed/mismatch=0`；`meta.pending_collection_current` 中 `pending_page:*` 行数为 0。

## 3. 合成数据污染与写入门

迁移 `0042` 只针对三组精确 `slug + wikidot_id`，且必须同时满足 live、零票、零修订、零署名、没有事实行、有图片引用。若键已指向不满足特征的行，迁移整体拒绝清理，不按 `test-` 前缀泛删。

已删除 3 页的 serve 当前态/投影、meta 队列/巡检态、ingest 内容/生命事件/身份行和无引用 blob；13 条 `serve.page_image` 已清零。`meta.v1_version_map` 中 3 条冻结 v1 来源映射保留：它们是不参与 v2 服务/队列/投影的源端审计凭据，v1 又被服务端强制只读。

写入门共三层：

1. `tests/helpers/pg.ts` 在客户端按带 10+ 位生成数的 page/user/actor 特征拒绝写入 `serve/ingest`；事务回滚 fixture 与 `app` schema 不在此限制内。
2. PostgreSQL 触发器在 `ingest.page_slug_history`、`serve.page_current`、`ingest.user` 以 SQLSTATE `P2T01` 拒绝同样的合成身份，直接 SQL 也不能绕过。
3. `checks/0007_synthetic_data_pollution.sql` 对合成页/用户与保留字段进行生产断言；同时断言 `test-log-046-de-03` 与 `smoke-and-snow` 不被分类器误伤。

活库复核：三组目标在 `serve.page_current`、`ingest.page`、`serve.page_image` 均为 0；真实 `test-log-046-de-03` 仍为 2 票、6 修订、1 署名。

## 4. 验证与出站

- `npx tsc --noEmit`：通过。
- 相关回归：13/13 通过（pending 三类、新 adult 页、写入门、真实 `test-*`、五分钟调度）。
- 最终 `npm test`：414/414，71 suites，退出码 0。前一轮曾因活库安全水位短暂不可用使 T7 及父套件记 2 失败；未改断言，隔离复跑 T7 为 5/5（内部 32/32），随后全量复跑全绿。
- 本任务相关只读 checks：`0003_oldest_pending`、`0005_pending_collection_coverage`、`0006_view_migration_reconcile`、`0007_synthetic_data_pollution` 全部通过。全量 checks 唯一失败是本次差异外的既有 `0002_write_freeze_wiring`：`apply_vote_cas_batch` 未接 R10 冻结；未为变绿越界修改。
- Wikidot 出站总计 1 次（200），仅用于证明解除冻结后的存量 `failed` 能实际成功收口；受限分类处理为零 Wikidot 请求。未访问 `/home/andyblocker/qqbot`，未发送 QQ 消息。

## 5. 工作树并发说明

本任务未执行 `git commit` 或 `git push`。工作期间分支被外部进程/他人从 `660cc2c` 快进到 `a87f833` （且 `origin/scpper-backend-v2` 同步指向该提交），当时的 PENDCLEAN 实现文件也已被纳入该 HEAD。本任务未回退或改写该并发更新；仅将本报告作为当前未提交交付补充。
