# v2 meta 标题/标签零产出修复报告

> 工作树：`feat__syncer2-foundation`（仅本工作树）  
> 运行时：TypeScript ESM / Node.js 22  
> 实施日期：2026-08-18（Asia/Shanghai）  
> 数据库：`scpper-v2` / PostgreSQL 5434  
> Git：未 commit、未 push；未写 v1；未触碰 qqbot；未发送 QQ 消息

## 1. 结论先行

缺陷已定位并修复。普通 `meta` work handler 过去只用页面 GET 取得 `wikidotId`，随后调用
`ingest.apply_page_meta()` 时只传 `{"slug": ...}`；`content` handler 只写 source、渲染文本和图片。
两条路径都没有把已经存在于完整 ListPages 契约中的 `title/tags` 传入属性函数，却仍先记录
`meta.page_scan(status='ok')`。新建或 slug 复用后的身份只有 L1 四字段时，因而会稳定停在
“扫描成功、属性零产出”。

修复后，standard 页的 meta 路径按 fullname 再取一次完整 20 字段 ListPages，先写属性并
正面核验当前 `source='observed'` 的 title/tags 两行，最后才允许记录 meta=ok。系统/模板页
由 `serve.page_current.enumeration_scope='listpages_hidden'` 显式归类，不需要伪造标题。slug 复用
会额外入队 meta，避免 successor 只拥有 L1 四字段。远端明确返回空标题的 standard 页保留
`title=''`，不再与从未观测的 `NULL` 折叠。

活库存量的“最新 meta=ok 但 title/tags 无 observed 行”从 64 降至 0；指定两页已取得正确值。
reconcile 的 title/tags 未解释数分别从 59/57 降至 7/7。没有交付阻塞。

## 2. 实测根因证据

### 2.1 修复前手动跟踪

对 `scp-cn-4294`（page_id `1500008254`，wikidot_id `1469181513`）直接调用当时的生产
`WORK_HANDLER_REGISTRY.meta` 与 `.content`，run `39184`：

| 项目 | 实测结果 |
|---|---|
| HTTP | 3 请求，全部 200，0 retry |
| meta | `ok`；`apply_page_meta` 返回 `changed=[]`, `attr_changes=0` |
| content | `ok`；source/rendered content 正常写入 |
| `meta.page_scan` | meta=ok、content=ok 均已落库 |
| `ingest.page_attr_history` | title=0 行、tags=0 行 |

这排除了“任务未调度”“HTTP 抓取失败”和“仍在排队”。代码路径与实测一致：

- `applyObservedPageMeta()` 的 `p_attrs` 只有 slug；
- `applyCurrentContent()` 不负责 title/tags；
- 每 5 分钟 L1 只取 fullname/rating/rating_votes/revisions；
- 完整 20 字段原先只在每周 L3/Tier1 落库。

### 2.2 修复后同路径复测

run `39208` 定向消费 `invincible` 与 `scp-cn-4294`：2/2 task=ok，业务 HTTP 4/4=200，
两页的 apply 结果均为 `changed=[title,tags,category]`、`attr_changes=3`、
`output_fields=[tags,title]`、`output_verified=true`。

| page_id / slug | 最终 title | 最终 tags | 当前 observed 行 |
|---|---|---|---|
| 1500008254 / scp-cn-4294 | `SCP-CN-4294` | euclid, scp, site-cn-03, 人造物品, 原创, 武器 | title=1, tags=1 |
| 1500008226 / invincible | `火云邪神是无敌的。` | 2026夏季征文, pamwac, site-cn-10086, 原创, 故事 | title=1, tags=1 |

## 3. 实现

### 3.1 完整 meta 产出契约

- `collect/listpages.ts` 新增精确 fullname 的 ListPages 请求、严格空集合/错误 HTML 区分和
  standard/listpages_hidden 纯分类函数；votes 的定向 claim 复用同一请求和解析器。
- standard meta：页面 GET 先守 wikidotId；精确 ListPages 再取得完整行；
  `applyObservedListPageMeta()` 写 slug/title/tags/hidden_tags/category/created/comment/rating claims。
- 写后立即查询当前 observed title/tags；缺任一字段即抛
  `meta_success_without_output:...`。meta=ok 的持久化严格位于该核验之后。
- slug reuse successor 现在同时入队 meta/new_page_highfreq/content/revisions_full。

### 3.2 模板/系统页显式归类

迁移 `0073_page_meta_output_contract.sql` 已在改动依赖代码前应用，并在最终视图调整后重跑成功。
下列 slug 归入 `listpages_hidden`：

- 名称以 `_` 开头，或冒号后名称以 `_` 开头：`_template`、`component:_theme`、`_404`；
- namespace 为 `fragment:`、`component:`、`theme:`、`system:`。

交付前活库快照的 live 分类为 standard 33,315 页、listpages_hidden 3,398 页；后者有 55 个 NULL title，
但不会进入元数据产出缺口或删除推断。删除纯函数也同步同一口径，避免系统页被当成 absence。

### 3.3 正确空值与真正缺失的区别

title 的值可以是远端权威空字符串；“有 observed 行且值为 `""`”不是零产出。旧
`apply_page_meta` 投影中的 `NULLIF(title, '')` 会把这个状态重新折叠成 NULL。迁移 0074 已先
建立投影守卫并按 observed 证据回填 21 个 standard 页：远端空串保留为 `title=''`，无观测才是
NULL。主分类且身份超过 24 小时的 `title IS NULL` 从 49 降至 **0**；其中 20 页现为明确的
observed 空串。定向 ListPages 与 DOM 均证实这些值确实为空，例如 `3942` 的 ListPages title、
`#page-title` 都为空。standard 空串、listpages_hidden NULL 和真正缺行由值、属性行与枚举域
三者稳定区分；交付快照所有 standard live 页的 NULL title 也为 0。

### 3.4 “成功却无产出”检测与告警

`meta.page_meta_output_gap` 检测：live + standard + **最新一次 meta 仍为 ok**，但当前
observed title/tags 任一缺行。它接入既有 `meta.pending_collection_current`：

- collection：`page_meta_output:missing_observed_attrs`
- family：`page_scan_no_output`
- warn：30 分钟；critical：2 小时
- evidence：missing_title、missing_tags、oldest_slug、latest_meta_ok_at

活库实测该集合以 64 页触发 critical，最大最老年龄 9,240 秒；消化后为 0，并于
2026-08-18 13:02:57+08 自动 resolved。最新 meta 已 failed 的页不再冒充“成功无产出”，
转由原有失败/irreconcilable 告警负责。

## 4. 存量消化与边界页

迁移生效时，production churn 使用户给出的 138 变为 139；按“缺当前 observed title/tags”
得到 64 个可修 standard 页。先复测指定两页，再以 `page_meta_output_remediation` 入队全量：

- run `39210`：50 claimed / 50 processed，49 ok；
- 并发生产 work-queue 消化余量；
- 最终 `meta.page_meta_output_gap=0`。

`wanderers:fanlunzhan` 在补齐时页面 GET=404，独立定向 ListPages 也返回结构完整空集合；它是
刚消失的远端身份，不可伪造 title。最新 meta 已 failed，并有 open irreconcilable/meta，等待
既有“两轮完整双源 absence + 再次 404”删除协议，且不计入成功无产出集合。

## 5. Reconcile、L1 与消费者回归

### 5.1 Reconcile

| report | title 未解释 | tags 未解释 | 总未解释 |
|---:|---:|---:|---:|
| 40（前） | 59 | 57 | 60 |
| 41（后） | 7 | 7 | 10 |

report 41 的 CROM 第 160 批遇到 HTTP 429，故 CROM 轨为 inconclusive、总 report status=failed；
这没有伪造存在性/字段比较，也没有造成未解释占比回归。title/tags 验收指标已明显下降。

### 5.2 L1

代码上线后的正常负载连续轮次 `39199/39213/39223` 均为 ok，枚举
36,692/36,695/36,696 页，耗时 87.5/88.5/94.8 秒，147/147 HTTP 200、0 retry。
全量测试与 reconcile/forum 并发期间共享出口进入 cautious/FIFO，轮次虽仍完整 ok，墙钟一度
上升到 177.3/165.0 秒；这是共享出口自保护的可解释暂态。控制器于 13:35:00 以
`recovered_after_6_nonempty_5m_windows_lte_3.0pct` 自动恢复 level 0。恢复后独占复测 run `39389`
为 ok、36,696 页、147/147 HTTP 200、0 retry、84.6 秒（较 86--110 秒基线更快）。随后生产
run `39394` 与 forum/image 并发，仍为 ok、36,696 页、147/147 HTTP 200、0 retry；其 167.1 秒
可由 358.4 秒聚合 token-delay 解释，不是请求失败、枚举缩水或本次 meta 代码侵入 L1。

### 5.3 work-queue / forum-consume

- work-queue run `39259`：50 claimed / 50 processed / 50 ok / 0 failed，failure_rate=0；
- forum-consume run `39265`：50 claimed / 50 processed / 50 succeeded / 0 failed，
  failure_rate=0，未触发 runtime budget；
- 本次 stock run 中唯一 meta 404 被确定性隔离，没有把整轮计成传输失败。

## 6. Revisions partial 结论

`scp-cn-4294` 的 28 条 revisions partial 不是同类零产出自旋：

- 16 条是 `l1_claim_only:修订覆盖交叉核对`，7 条是 `l0_claim_only:等待 revisions_full`；
  它们是声明层中间证据，不是 work-queue 执行，并被 0054 健康视图从可判定成功率分母排除；
- 其余几条发生于页面快速编辑时，例：claim=27、远端列表=31，按契约拒绝不一致投影；
- 20:37 的完整 revisions 已以 claim=30、fetched=31 收敛为 ok，当前 revisions_full 队列=0。

因此无需修改 revisions；它有明确终态、没有反复消费同一任务，也没有“ok 但零产出”。

## 7. 回归与质量门

新增/加强的回归覆盖：

1. 仅注册身份、没有属性（等价新建页只有 L1 四字段）→ 完整 meta 写出正确 title/tags；
2. 人工记录 meta=ok 但无属性 → `page_meta_output_gap` 命中且 oldest-pending 判 critical；
3. standard meta 写后强制正面核验 title/tags observed 行，核验位于 meta=ok 持久化之前；
4. observed 空 title 投影为 `''` 而非未观测 NULL；
5. `_template/_theme/_404/fragment/component/theme/system` 不进入缺口或删除候选；
6. votes 定向 claim 与 meta 共用严格 ListPages 解析，合法空集合不冒充数据行。

最终质量门：

- `npx tsc --noEmit`：通过；
- `npm test`：**580/580** 通过（基线 578，新增 2 个防回归用例）；
- `git diff --check`：通过；
- 迁移 0073/0074：`scpper-v2` 应用成功；0074 按证据更新 21 行；
  SECURITY DEFINER 对 PUBLIC 可执行数=0。

## 8. 最终复核

全部验收均已完成。L1 已自动恢复 normal，连续正常负载轮次满足全量、ok 与 86--110 秒基线，
恢复后的独占轮进一步为 84.6 秒；共享出口并发慢轮有明确 token-delay 证据且仍全量 ok。
无代码、数据或外部依赖阻塞。
