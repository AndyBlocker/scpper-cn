# v2 对账复核报告（2026-08-13）

除 `user` 与 `analyze` 外，**目前只有“归属”和“标签”已达到可长期对账的终态**；“页面身份”的错误恢复链已经修通、CROM-only 已从 29 清零，但仍有 7 个必须走安全删除协议的站点缺席身份和 1 个重复 live slug，因此尚不能签字；“评分与投票”“修订”“源码”仍有真实 v2 追平队列；“讨论与论坛”“图片”仍有大批历史积压；“内链”投影机制可用，但受 76 个 live 页当前源码缺口和 `scp-cn-4156` 身份歧义影响，尚不能作全站终态。结论不是“v2 普遍漏数”：已能由站点独立证据裁决的差异绝大多数确为 v1/CROM 历史偏差；当前不能通过的部分被保留为真实 v2 积压或删除安全门，而没有提高 0.1% 阈值。

## 逐域结论

| 域 | 结论 | 2026-08-13 实测证据 | 尚缺什么 |
|---|---|---|---|
| 页面身份 | **未终态，机制已修复** | live 36,568；CROM-only `29 → 0`；解析器恢复了被旧 deleted 同名身份挡住的新 WID；仍有唯一重复 live slug `scp-cn-4156`（WID `1469066854/1469081442`）和 7 个站点缺席候选 | 7 项通过两组间隔至少 2 小时的完整 sitemap+ListPages 与末次 Page GET 404 后安全删除；消除重复 live slug |
| 评分与投票 | **未终态** | `serve.vote_current` 1,360,107 行/43,143 页；完整报告 28 尚有 1,806 个 vote-state 字段差异，最新 parity 为 1,805 个未解释页；`votes_full` ready 28,524 | 正常 work-queue 逐页取得完整 WhoRated 多重集，并由 L1 `rating_votes/rating` 双门核验；不能白名单化 |
| 修订 | **未终态** | 522,842 修订/48,341 页；完整 CROM 仍有 11 个可行动 `revisionCount` 字段差；`revisions_full` ready 118 | 清空当前修订差异；继续历史源码任务 |
| 源码 | **未终态** | live 页当前 `source_sha` 36,492/36,568，缺 76；`page_source` 79,749 行/48,256 页；历史修订源码 done 350,038、pending 1,811、retry 8、irreconcilable 1 | 补齐 76 个 live 当前源码及 1,819 个可重试历史任务；保留 1 个不可调和终态证据 |
| 归属 | **可长期对账** | `attribution_current` 54,568 行/47,891 页；`scan_task` 无 attribution 积压；写入有来源事件与当前投影 | 继续由现有增量/重建不变量监控，不需白名单 |
| 标签 | **可长期对账** | 36,568 个 live 页均有当前标签集合（非空 34,846、合法空 1,722）；v1/v2 原始标签差 7,287 项全部由 v1 `crom:*` 派生标签精确解释，未解释 tags=0 | 保持“仅移除 v1 `crom:*` 后完全相等”的严格规则 |
| 讨论与论坛 | **未终态，消费者健康** | 16 分类、90,330 主题、553,572 帖，33,632 主题已关联页面；`forum_scan_task` 84,741；报告要求的消费者轮次 50/50/50/0 已通过 | 清空历史 forum/discussion 队列，再做覆盖率与页关联终态核验 |
| 图片 | **未终态** | 79,443 引用：resolved 58,331、queued 10,549、pending 7,130、failed 3,433；job completed 58,331、pending 18,655、failed 2,454、processing 3；资产 ready 50,622、unavailable 2 | 清空 pending/queued，逐类收敛失败终态，再做引用—资产闭合核验 |
| 内链 | **未终态，投影机制可用** | 343,078 引用/34,965 源页；resolved 176,631、external 118,294、missing 48,150、ambiguous 3 | 先补源码与身份；再区分真实断链和采集缺口，消除 3 个歧义并重投影 |

## 12.1507% 反而高于 9.5103%：已证实是错误分母，不是差异恶化

报告 23 的状态轨是 `3,453 / 36,308 = 9.5103%`。报告 24 虽只剩 100 个未解释页，但比较分母骤降到 823，因此是 `100 / 823 = 12.1507%`；同时有 **35,739 页被 lag-window 排除**。旧实现错误使用 `serve.page_current.updated_at` 作为“远端页面最近变化”时钟，而完整 ListPages 每轮调用 `ingest.apply_page_meta` 时会刷新投影 `updated_at`，于是例行投影把几乎全站伪装成“最近 60 分钟变化”。这不是猜测：改用真正的 Wikidot L0 时钟 `meta.incremental_page_state.last_l0_updated_at` 后，完整报告 28 的分母恢复为 36,475、lag 排除仅 95，未解释率为 `1,813 / 36,475 = 4.9705%`；最新报告 33 又降到 4.9449%/1,805 页。

因此，“100 页变成 1,813 页”也不是新回归，而是原先被错误 lag-window 隐藏的 WhoRated 追平缺口重新进入分母。修复后指标才具备长期监控意义。

## 六类原告警逐条归因、样本与处理

### 1. 状态对齐未解释率

- **原值**：12.1507%；**完整修复轮**：4.9705%；**最新 parity**：4.9449%。阈值仍是 0.1%，没有放宽。
- 已解释的 v1 历史偏差包括：7,287 个 v1 `crom:*` 合成标签页、1,200 个由完整 WhoRated 多重集证明 v1 旧的页面、334 个来源标题 Unicode/空白归一、135 个由当前 L1 证明 v1 缺页、74 个由 Wikidot 直接标题证明 v1 旧的页面。
- 可复核样本：`scp-6847` 仅 v1 多 `crom:series-7`；`advanced-memetic-mka-n-crv` 的 v2 122 票/评分 120 已由完整 WhoRated+L1 双门背书，而 v1 123 票；`scp-4004` 的 v2 24 票/评分 22 已背书、v1 为 23/21。
- **归因**：错误分母是 v2 reconcile 缺陷，已修；其余 1,805 页主要是 v2 尚未取得可采用的完整 WhoRated 快照，是真实追平积压，不得推定为 v1 旧。

### 2. 状态对齐有 100 页未解释差异

- 修正分母后，完整报告 28 是 1,813 页，最新报告 33 是 1,805 页；字段口径为 existence 7、vote-state 为主，tags/title 均已归零。
- 可复核未解释票态样本：`scp-cn-626`（v1 74/28，v2 75/28）、`scp-cn-891`（96/90 vs 97/90）、`compromised-12`（24/22 vs 25/22）、`compromised-3`（30/26 vs 32/26）、`scp-cn-4416`（39/1 vs 40/2）。
- **终态**：这些样本没有新鲜完整 WhoRated 背书前继续告警；当前 `votes_full` ready 28,524，由健康的 50/50 work-queue 持续收敛。把它们白名单化会掩盖真实 v2 漏抓，故拒绝。

### 3. CROM/v2 存在性差异 32（CROM-only=29，v2-only=142）

- 根因是 resolver 把“同 slug 的 deleted 旧身份”当成已解析，跳过站点当前新 WID。修复后可以恢复同 WID、也可通过 `apply_slug_reuse_identity` 结转新 WID；live rename 立即落观察元数据。完整报告 28：**CROM-only=0、v2-only=146、可行动=7**。
- 已修样本（新 WID ← 错误旧 WID）：`scp-cn-4303` `1469069345←1468999304`、`scp-cn-0001-j` `1469075467←1329472348`、`scp-cn-4767` `1469078955←1469021022`、`scp-cn-4167` `1469085721←1469040210`、`fragment:scp-9718-12` `1469122832←1469122659`、`scp-cn-4667` `1469143003←1468944217`。
- 146 个 v2-only 中，134 个由新鲜 L1 直接证明 live、4 个在 lag window、1 个是 CROM 固定排除的 deleted 分类，剩余 7 个是：`log-of-anomalous-items-cn:01227`/1437204978、`xinglai`/1468677748、`scp-cn-4074`/1468923138、`scp-cn-4156`/1469066854、`scp-cn-4156`/1469081442、`scp-sb`/1469090604、`scp-cn-4698`/1469108408。
- **归因/终态**：29 个 CROM-only 是 v2 身份缺陷，已修；139 个 v2-only 是 CROM/时窗偏差；7 个是 v2 删除滞后候选。站点才是权威，但删除协议要求两组间隔至少 2 小时的完整双源证据及末次 Page GET 404，当前安全门尚未满足，不能直接删也不能白名单。

### 4. CROM 五项字段差异 83

- 完整报告 28 降到 **27**：title 409 个差异全部解释（334 来源归一、75 Wikidot 直接标题证明 CROM 旧）；rating 8、voteCount 8、revisionCount 11 仍可行动。
- rating/voteCount 各含 2 个 `v2_stale_vs_current_l1` 与 6 个尚无第三源裁决；revisionCount 含 10 个 `v2_stale_vs_current_l1` 与 1 个未裁决。
- 可复核样本：`_404` CROM rating/votes `119/133`、v2 `116/130`；`component:_template` `3/5` vs `2/4`；`critter-profile-neil` `2/2/rev-claim 1` vs `0/0/revision rows 0`；`alt:scp9000contesthub` 修订 claim 8（期望 9 行）vs v2 6；`ankv` 319（期望 320）vs 313；`art:scp-67774777-7777777` claim 3（期望 4）vs v2 3。
- **处理**：加入新鲜 WhoRated/RevisionList 直接快照裁决，但证据必须与 v2 当前数值完全一致且在 lag cutoff 后；旧快照仍失败。剩余 27 是真实 v2/未裁决积压，不能靠 CROM 这一本身非一手的爬虫覆盖站点事实。

### 5. sitemap/ListPages 未解释枚举差异 5

- 原 5 项：sitemap-only `component:content-hider`、`experiment-log-914-cn:00075`、`scp-cn-4667`、`scp-cn-4793`；ListPages-only `log-of-anomalous-items-cn:01488`。刷新完整快照后均消失，属于站点在顺序抓取间真实变化。
- 完整报告 28 又看到 4 个 ListPages-only：`scp-cn-4182`、`scp-8345`、`scp-8432`、`avertissement-scp-001-fr`。连续两次 sitemap 全量均为 36,351 页但成员会抖动；随后候选变为 `scp-8345`、`scp-8432`、`scp-8489`、`avertissement-scp-001-fr`。
- 新实现只对未解释差集做第三边 Page GET。报告 30 四页均 HTTP 200 且得到 WID `1459939817/1459921042/1459921023/1449994217`，分类为 `sitemap_omission_confirmed_by_page_get`，枚举未解释 **4→0**。Page GET 失败、重定向或方向不闭合仍告警。
- **归因/终态**：站点 sitemap 自身的真实遗漏/抖动，不是 v2 漏页；用动态一手证据裁决，不使用静态页面白名单。

### 6. 三角独立模块 votes=1、revisions=0

- 原样本 `scp-cn-2000`：旧日快照 5,671 票/5,459 分，WhoRated 已为 5,673/5,459。完整 L1 过去“每日首轮后不再更新”导致陈旧；现改为**每个完整 L1 轮都原子替换**，半截轮不覆盖。
- 报告 25 暴露了更细的顺序竞态：`scp-cn-2000` 初始 ListPages 5,674/5,460，随后 WhoRated 5,675/5,461；`old:scp-1046` 初始 revision claim 0，随后 RevisionList 3 行。
- 新逻辑在不一致时立即定向重读 ListPages；只有第二次 ListPages 与后读模块完全一致才记 `source_changed_during_triangle`。报告 28、30、33 均为 **votes 10/10、revisions 10/10、未解释 0**。
- **归因/终态**：真实站点在顺序请求间变化；已用第三次读取闭环，不加 ±1 容差。

## 额外发现并修复的两项假警/回归

1. 报告 25 的已删页 vote checksum 假警来自合法 restored 身份退出“当前 deleted 集合”。checksum 口径升级到 v3，按上轮 report cutoff 重建当时的生命周期成员，即使本轮已 restored 仍参与保护比较。报告 27 与完整报告 28 均 `changed=false`，156,149 行完全一致。
2. 重开 deleted/resolved 身份的修复一度误重开 5 个 `wanderers-adult:* → wanderers:*` 的受限历史别名。现明确排除 `restricted_listpages_v1_reuse`；正常 resolver 已以既有只读证据恢复 5/5，零 HTTP、零失败。该问题由未修改断言的活库测试发现并修正。

## 白名单纪律

本轮只加入一组**精确且整体锁死**的 v1 历史测试污染白名单：

- WID 800019414 / `test-image-page-1759148576016`
- WID 800080727 / `test-image-page-1759149352271`
- WID 800041112 / `test-image-page-1759413342363`

理由是三页只存在于 v1 生产历史，完整 sitemap/ListPages 均不存在，v2 正确未导入。测试用 `deepEqual` 固定整个 Map；新增、删除或改名任何一项都会失败。其余差异都使用可重复的来源规则或当轮 Page GET 证据，没有页面级静态放行；0.1% 阈值未改。

## Reconcile 前后与当前状态

| 证据轮 | 输入完整性 | 文本告警数 | 关键结果 |
|---|---:|---:|---|
| report 24，06:13（修复前） | 完整 CROM | 6 | 12.1507%/100；existence 32；fields 83；enum 5；triangle votes 1 |
| report 28，13:41（完整修复验收轮） | CROM 36,421，全轨完整 | **5** | 4.9705%/1,813；CROM-only 0、existence 7；fields 27；enum 4；triangle 0/0；冻结 0 |
| report 30，13:56（枚举/主动三角定向验收） | 快照+Page GET+20 模块检查完整 | **0** | enum 0；votes 10/10；revisions 10/10 |
| report 33，14:13（最新 `mode=all`） | parity/triangle 完整，CROM 首批 429 | 3 | 4.9449%/1,805；enum 0；active triangle 0/0；CROM 明确 inconclusive、不计算差异 |

因此“至少一次完整 reconcile 且告警下降”已满足：完整 report 24→28 为 **6→5**。report 28 之后的枚举修复已由 report 30/33 实测归零；但 CROM 公共 API 当前硬限流（服务端即使请求 `first=1000` 仍固定每批 100），两次最终全轨重跑分别在第 116 批和首批收到 429，不能伪称已取得“最新代码下的又一轮完整 CROM”。下一次限流窗口释放后的完整轮，已知仍会保留 4 条真实告警文本：状态率、状态页数、CROM existence 7、CROM fields 27。

**Reconcile 仍未通过。** 这不是阈值或白名单问题，剩余每一类及计划如下：

1. 状态 1,805 页：让正常 `votes_full` 队列继续按完整 WhoRated+L1 双门收敛；完成前不放行。
2. CROM existence 7：取得两组间隔至少 2 小时、`page-scan=all` 的完整 sitemap/ListPages 证据，逐页末次 GET；404 才安全删除，live 则修身份。
3. CROM fields 27：优先消费相关 votes/revisions 任务；用 WhoRated/RevisionList 一手证据裁决，CROM 只作发现源。
4. CROM 429：限流窗口释放后重跑 `npm run schedule:reconcile`；任何截断轮继续保持 inconclusive。

## 验收与安全断言

- `npx tsc --noEmit`：通过。
- `npm test`：最终 **548/548 通过**（新增回归后高于基线 542）；中途活库断言发现上述 5 个别名回归，未改断言，修复生产状态后全绿。
- `git diff --check`：通过。未 commit、未 push；未改 schema，因此无迁移顺序问题。
- L1：最近 8 个全站轮均 `source='wikidot_listpages' status='ok'`，36,545–36,546 页；其中 7 轮 89.4–100.2 秒，最新轮 102.8 秒，保持约 86–100 秒量级且全站覆盖。
- work-queue：run 27479 `claimed=50 processed=50 unprocessedReleased=0 status=ok`；此前多轮同样 50/50。
- forum-consume：run 27362（以及 27337/27276/27237/27232）均 `claimed=50 processed=50 succeeded=50 unprocessedReleased=0 status=ok`。
- v1：环境 URL 仍保留 `options=-c default_transaction_read_only=on`；显式查询 `scpper-cn` 得到 `default_transaction_read_only=on`、`transaction_read_only=on`；reconcile 代码先验证只读且所有 v1 查询都在 `BEGIN READ ONLY` 中。本轮没有向 v1 发出任何写语句。
- 未访问 `/home/andyblocker/qqbot`，未发送任何 QQ 消息。
