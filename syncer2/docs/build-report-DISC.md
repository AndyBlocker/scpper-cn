# DISC：讨论区重试风暴、空转探针与长期 pending 收敛报告

日期：2026-08-25（Asia/Shanghai）

## 结论

本轮把三个“已经有确定证据、但队列仍把它当作普通待办”的问题改成了显式终态：

1. 六个讨论页当前都不是身份丢失，而是 Wikidot 的 ListPages 评论数与两个讨论模块同时
   返回 0 帖相矛盾。它们现在以 `partial + wikidot_discussion_count_inconsistent`
   留证，进入 `meta.irreconcilable`，不写假的 `discussion/ok`，也不再被每分钟 seed 回普通队列。
2. `ForumCommentsListModule status=no_page` 是另一条身份信号：先按 slug 做页面身份复核；
   wikidot id 已变就登记 successor、终止 predecessor 并迁移任务，404 就终止旧身份，身份暂时
   未变则以稳定失败签名退避，第三次相同证据进入可复查终态，不会继续每天约 70 次自旋。
3. revision-source-backfill 在 active job 为 0 且不存在未登记的 eligible revision 时，在构造
   HTTP client/session/pacer 之前退出；生产两轮摘要均为 `status=ok`、`startupProbe=null`、
   `http.requests=0`。

`incremental_page_state:l1_stale` 的 39 行被逐项解释为 23 行本来就不可由标准 ListPages
枚举的 `listpages_hidden`、15 行错误连接到同 page_id 的旧 slug 状态、1 行确实需要重绑的
`scp-9602` successor。`incremental_drift_state:revisions_full` 的旧 8 行中，2 行已由完整抓取
自然对齐，6 行已有开放 irreconcilable；运行时不再把这些终态每五分钟重新打开成 pending。

迁移 `0208_discussion_and_stalled_terminal_convergence.sql` 已先应用到 `scpper-v2`，随后才修改
依赖它的 TypeScript。未修改 v1，未访问 qqbot，未发送 QQ 消息，未 commit/push。当前无阻塞。

## 一、(a) 与 (b) 是两类不同事实

### (a) `ok + threadId`，但 CommentsList 与 ViewThread 都是 0 帖

固定观测时间 `2026-08-25T00:35:42.392Z`。六页的精确页面 GET 全部回显数据库中的
wikidot id；随后 `ForumCommentsListModule` 全部 `status=ok`，但响应仅 923/924 字节，
`#thread-container-posts` 是折叠的空容器。模块仍给出了 thread id。以相同 thread id 调
`ForumViewThreadModule`，六次也全部 `status=ok`，正文 2,962–2,992 字节、自报文章数 0、
解析结果 0 帖。与此同时，L1 ListPages 的 `%%comments%%` 分别是 1、2、21、7、17、4。

| page_id | slug | wikidot_id | L1 claim | thread_id | CommentsList 帖 | ViewThread 自报/解析 |
|---:|---|---:|---:|---:|---:|---:|
| 11688 | `only-game-in-town-hub` | 656515985 | 1 | 12468676 | 0 | 0 / 0 |
| 15377 | `scp-2245` | 52681268 | 2 | 5974036 | 0 | 0 / 0 |
| 22026 | `scp-cn-1453` | 1260657984 | 21 | 13622934 | 0 | 0 / 0 |
| 23030 | `scp-cn-2337` | 1308495132 | 7 | 14045830 | 0 | 0 / 0 |
| 24904 | `scp-cn-550` | 60365278 | 17 | 4748616 | 0 | 0 / 0 |
| 29528 | `wanderers:for-adsurdus` | 1071427632 | 4 | 13366749 | 0 | 0 / 0 |

这也重新验证了题面提醒的行为变化：ADULT2 曾看到 37,538 字节实内容；本轮同模块的当前
响应只有约 923/924 字节的折叠容器。因此没有沿用旧模块行为假设。

这是上游两个公开口径互相矛盾，不是本地“少抓了帖子”。语义正确的结果只能是：保存
thread id 与双模块计数证据，记录 `page_scan/discussion=partial`，建立
`discussion:wikidot_discussion_count_inconsistent` 终态；不能记成功，也不能在没有新证据时
重复抓。开放终态每 7 天复查一次，若上游恢复为可解析帖子，成功路径会关闭终态并正常关联。

### (b) `no_page` 是 page-bound AMC 的身份失效信号

题面所述 page_id=22026 在先前时点的 `no_page` 是有效历史观测，但 2026-08-25 本轮已不能
复现：在 `01:01:04Z` 再测时它已变成上述 (a)，thread 13622934、ListPages claim 21、两个
讨论模块均为 0。不能为了迁就旧结论继续把 22026 宣称为当前陈旧身份。

同一 slug 的两代已删除身份提供了当前可重复的 (b) 实证：page_id 93188 / wikidot id
383975759 与 page_id 96419 / wikidot id 1173996284 调 CommentsList 都返回
`status=no_page, message=无法找到相关页面`；紧接着在 `01:01:22Z` 按 slug
`scp-cn-1453` 精确 GET 返回 `status=ok`，wikidot id=1260657984。即 `no_page` 本身不等于
“页面永久不存在”，它要求离开旧 page id，回到 slug 身份解析。

实现上，forum-consume 现在与通用 work-queue 共用 `reviewFailedTaskIdentity`：

- 新 id：铸 successor lineage，旧身份置 deleted，把当前及同页其它任务迁到 successor；
- slug 404：按删除证据终止 predecessor；
- id 暂未变：同一 `page_bound_amc_no_page` 签名按 1h/4h 量级退避，第三次稳定证据进入
  irreconcilable；瞬时传输错误仍只是可重试，不触发额外身份 GET。

## 二、重试风暴为何发生，以及怎样收敛

过去五天六页各失败 354–395 次。它们其实早已有开放 `meta.irreconcilable`，累计复查次数
1,251–1,295；但 `seedForumDiscussionLinkTasks` 只检查普通 `meta.scan_task`，没有排除开放
终态。worker 把普通任务删除后，下一分钟 seed 又按 `comment_count>0 AND thread_id IS NULL`
原样建回，因而终态没有关闭入队驱动。

修复有三层，不依赖某一个 worker 永远完美：

1. seed SQL 对 `forum/discussion` 的开放 irreconcilable 做 `NOT EXISTS` 硬闸；
2. (a) 的 CommentsList 折叠结果保留 thread id 为 partial，追加 ViewThread 独立确认；双零
   立即以稳定语义 hash 进入终态并删除普通任务；
3. (b) 首次 `no_page` 就做身份复核；未能立即终止身份时仍有签名退避和“三次同证据终态”。

迁移为六个现存页补入相同证据并删除普通任务。生产复核时六页开放终态均为
`wikidot_discussion_count_inconsistent`，`has_scan_task=false`，下次复查在 2026-09-01。
这六页的最终归宿均是“上游计数矛盾、可周期复查的 partial 终态”，没有一页被谎报成功。

## 三、revision-source-backfill 的空转处理

新 preflight 只查询两件事：

- `pending/retry/processing` active job 数；
- live revision 中是否仍存在满足来源条件、但未登记 job 的行。

只有两者都为空才跳过。这个检查发生在 HttpClient、受限 session、pacer 和 AMC 启动探针
构造之前；有任一工作时仍走原来的 `policy=require` 探针与完整处理路径。

部署观察时发现采集期间又新增了少量未登记 revision，因此先由“有活”路径正常处理 12 条；
最终队列为 `done=354438, skipped_deleted=143`，无其它状态。之后：

| run_id | 时间 | status | active / unseeded | startupProbe | HTTP requests | 退出码 |
|---:|---|---|---|---|---:|---:|
| 55264 | 08:53:04 | ok / skipped | 0 / false | null | 0 | 0 |
| 55302 | 08:55:00 | ok / skipped | 0 / false | null | 0 | 0 |

两轮 `stats.skipped` 都是 `no_pending_or_unseeded_revision_source_work`。这证明不是“碰巧探针
成功”，而是探针回调根本没有执行。

顺带审计结果：resolve-pages、work-queue、forum-consume 仍是启动探针后再认领；它们服务的是
持续出现的实时身份、页面和论坛工作，不是已经永久排空的有限 backfill。image-ingest 没有
AMC 启动探针，先认领本地图片 job 再做业务请求；L0/L1、sitemap 本身就是定时远端观测，
不存在“空队列”。本轮没有扩大范围重排这些实时消费者，生产健康证据见第六节。

## 四、`l1_stale` 39 行逐项归因

旧视图只用 `ips.page_id = pc.page_id` 连接，没有匹配 slug，也没有排除
`enumeration_scope=listpages_hidden`。因此一个物理身份改名后，当前 live slug 会被旧 slug 的
增量状态拖成 stale；同一 page_id 有多个旧 slug 状态时还会重复计数。

### 23 行：明确 `listpages_hidden`，不属于标准 L1 可枚举集合

以下前 20 行从未有标准 L1；另外 3 行有旧状态，但当前身份同样是 hidden。它们现在由
`enumeration_scope` 显式归类，不再进入 `l1_stale`：

1. `system:_sekai-s-workbench`
2. `component:_template`
3. `credit:_template`
4. `experiment-log-914-cn:_template`
5. `experiment-log-914-cn:_theme`
6. `experiment-log-914-cn:_404`
7. `_fuban-s-workbench`
8. `log-of-anomalous-items-cn:_404`
9. `log-of-anomalous-items-cn:_template`
10. `log-of-anomalous-items-cn:_theme`
11. `short-stories:_template`
12. `short-stories:_404`
13. `_template`
14. `theme:_template`
15. `_utich`
16. `user-component:_template`
17. `wanderers:_template`
18. `alt:_template`
19. `_404`
20. `archived:_template`
21. `fragment:4226-19-1` ← 旧状态 `fragment:scp-cn-4226-1`
22. `fragment:4226-19-1` ← 旧状态 `4226-19-1`（同一当前页被旧连接重复计数）
23. `fragment:scp-3148-2` ← 旧状态 `fragment:scp-3184-2`

### 15 行：page_id 相同但 slug 已变，旧视图串错身份

格式为“当前 slug ← 被错误连接的旧状态 slug”。新视图以 `(slug,page_id)` 精确连接；这些
当前身份每五分钟正常收到新 L1，不再继承旧 slug 的陈旧时间。

1. `old:scp-761-fr` ← `scp-761-fr`
2. `art:scp-67774777-7777777` ← `6747-c`
3. `scp-cn-7243-j` ← `drtoylat`
4. `wanderers:eremite` ← `wanderers:yinshi`
5. `the-slap-from-death-to-life` ← `the-slap-from-death-to-llife`
6. `old:scp-l119` ← `scp-l119`
7. `scp-cn-807` ← `scp-cn-4155`
8. `project-shin-seikatsu-1986` ← `https:scp-wiki-wikidot-com-project-shin-seikatsu-1986`
9. `scpdeclassified:scp-5998` ← `5998`
10. `makuwa-yurika-wikipedia` ← `zhensang-wikipedia`
11. `scp-cn-4226` ← `collab:scp-cn-4226`
12. `old:scp-7121` ← `scp-7121`
13. `wanderers:flowerocean` ← `flowerocean`
14. `yamizushi-file-no049` ← `niuroubanmian`
15. `old:scp-9602` ← `scp-9602`

### 1 行：`scp-9602` 的 live successor 确实缺状态

旧 `scp-9602` 状态绑在 page_id=105246 / wikidot id=1468713715，但该 slug 已复用为
page_id=1500008893 / wikidot id=1469186992；两者精确页面 GET 与定向 ListPages 都可见。
既有 `revision_regression_identity_state.status=slug_reused` 已经是充分身份判据。迁移与运行时
reconcile 都会把旧 slug 水位重绑 successor；随后 L1 为 predecessor 的新 slug
`old:scp-9602` 与 successor `scp-9602` 分别建立新状态。08:54 两行的 `last_l1_seen_at` 均已
刷新，`l1_stale` 当前为 0。

## 五、`revisions_full` 旧 8 行逐项归因与终态

| page_id / slug | 原差值（本地 / L1 期望） | 归因 | 终态 |
|---|---:|---|---|
| 25851 `search:site` | 0 / 13 | 完整 RevisionList raw=13，但 13 行全因无可用身份被 quarantine | 开放 irreconcilable；state resolved |
| 104142 `in-the-land-of-dread-alagadda` | 1 / 4 | raw=4，其中 3 行 quarantine | 开放 irreconcilable；state resolved |
| 104074 `ankv` | 319 / 326 | raw=326，其中 7 行 quarantine | 开放 irreconcilable；state resolved |
| 104093 `free-bird` | 2 / 5 | raw=5，其中 3 行 quarantine | 开放 irreconcilable；state resolved |
| 33249 `alt:scp9000contesthub` | 6 / 9 | raw=9，其中 3 行 quarantine | 开放 irreconcilable；state resolved |
| 25849 `search:crom` | 14 / 1 | L1 claim=0，而本地已有 14 个版本；不是“少抓”可修 | 开放 irreconcilable；state resolved |
| 1500001696 `the-slap-from-death-to-life` | 0 / 11 | 早期 claim=0 与逐步出现的版本冲突；08-13 完整抓取 11/11 | 08-13 13:24 自然 resolved；当前 11/11 |
| 105552 `no-love-hub` | 6 / 7 | 观测时本地少 1；后续完整抓取写入第 7 个版本 | 08-13 13:09 自然 resolved；当前 7/7 |

旧 bug 在 `upsertCurrentDriftStates`：即使相同 page/kind 已有开放 irreconcilable，每轮 L1
仍无条件把 `resolved_at` 写回 NULL，所以前六行永久回到 pending/critical，任务播种却又因
终态被抑制，形成“不能处理也不能结账”的状态。现在相同证据的开放终态把 drift state 设为
`consecutive_observations=0, resolved_at=本轮时间`；若远端证据变化，原有逻辑先关闭旧终态、
重新建任务，因此没有用终态掩盖新事实。

08:54 的生产状态：上述六行全部 `resolved_at=08:54` 且开放 terminal=true；旧两行仍保持
其自然 resolved。successor 重绑一度产生一条新的 `scp-9602` drift（年龄 0.2h、连续 2 次
观测），work-queue 随后在 08:56 完整抓取 3/3 个版本，08:59 将它 resolved。09:01 的两项
oldest-pending 样本均为 `pending_count=0, severity=ok, decision=empty`；两条持续 3,648 个
样本的旧 critical episode 已在 08:46:16 明确写入 `resolved_at`。

## 六、生产验收

### 讨论区

- 六页开放终态均带当前 thread id、L1 claim 和 ViewThread 0/0 证据；普通 scan task 为 0；
- 迁移与新代码生效前最后一笔旧失败是 08:45:21；之后未再新增；
- 09:14 的滚动一小时失败为 10，较题面基线约 17/h 下降 41.2%；这 10 条全部是收敛前的
  旧样本，08:46 以后失败为 0。随着旧样本继续滚出，数值只会继续下降。

### L1 与旁路链路

- 08:44 有一轮偶发 partial/36,394；此后 08:49、08:54、08:59、09:04、09:09 连续五个
  完整轮均为 `status=ok`、36,894 页，耗时 87.4–99.9 秒；
- `incremental_page_state:l1_stale` 与 `incremental_drift_state:revisions_full` 均无当前行；
  09:01 最新样本均为 `ok/empty`，两个旧 critical alert 均已关闭；
- work-queue 在部署后持续运行，08:45–08:58 多轮 `tier2` 为 ok，最近两轮处理 2/2、2/2，
  failed=0；
- forum-consume 继续处理正常 forum/thread 工作；09:00 与 08:53 两轮各成功 1、失败 0，
  六页 discussion 未重建；
- image-ingest 最终一小时窗口更新 7 个任务，其中 3 completed、4 按既有失败/退避语义落库；
  无 pending/processing 卡死，也未改动图片代码。

## 七、回归与静态检查

新增三条验收回归：

1. 构造 CommentsList `ok + threadId + 0`，再构造 ViewThread `ok + 0`：断言结果为带稳定
   marker 的 partial，`finishDiscussionTask` 插入 irreconcilable 并删除普通任务；
2. 构造 CommentsList `no_page`，slug GET 回显新 wikidot id：断言首次即复核，predecessor
   deleted、successor 获得 discussion task、旧任务为 0；
3. 构造 active=0/unseeded=false：断言 startup gate 返回 skip、probe 回调调用次数为 0；
   同测 active=1 时 probe 仍执行。

结果：

- 定向相关回归：42/42；
- `npx tsc --noEmit`：通过；
- `npm test`：594/594，91 suites，0 fail、0 skip（题面基线 591，新增 3 条）；
- `git diff --check`：通过。
