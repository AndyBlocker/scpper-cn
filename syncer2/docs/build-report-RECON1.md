# RECON1：v1↔v2 对账首轮归因与 `inconclusive` 语义修复

## 技术摘要

本次没有把 29.1208% “调绿”。原报告 `meta.reconcile_report.id=3`
把第 61 批 429 后的 6,000 页 CROM 前缀当成全站，因而
`v2-only=30,115` 没有统计意义；同时它先比较 2026-07-30 sitemap 与
2026-07-28 ListPages L3 快照，再把旧快照告警附在已有差异计数上。两条轨均已改为：
输入未完整走完或时点不可比时返回 `inconclusive`，差异明细为 `null`、
`differenceCountsAvailable=false`，汇总 difference 固定不参与总数。

29.1208% 与旧 ListPages 快照无关。状态对齐轨从未读取 ListPages 文件，而是按
Wikidot page id 直接比较 v1/v2 当前库。最终重跑 `report id=8 / run_id=4632`
同口径原始差异为 10,479 / 36,060 = 29.0599%；其中 7,575 页有确定性来源判据，
剩余 2,904 页 = 8.0532%，仍远高于 0.1%，所以 parity 和整轮保持 `failed`。

主要原始差异不是一个原因：7,179 页含 v1 的 `crom:*` 派生标签差、
2,744 页含未解释 vote state 差、407 页是 v1 PageVersion rating 滞后、
247 页只有 Unicode 空白差。页级类别有重叠，完整互斥组合见下表。

## 关键结论

1. **29.12% 不是 L3 旧快照造成。** 旧 L3 只污染 sitemap/ListPages 和以其 claims
   为基准的页级三角；状态 parity 的输入是两个数据库的 current state。
2. **合法差异已编码为判据，不是页面白名单。** 当前已解释 7,575 页；0.1%
   阈值没有放宽，且仍要求 `unexplainedPages === 0` 才 qualified。
3. **剩余 2,904 页仍是真告警。** 其中 2,744 个未解释字段是 vote state，
   另有 title 158、rating 158、tags 24、existence 12；字段可在同页重叠。
4. **最终生产重跑真实遇到第 199 批 429。** CROM 状态为 `inconclusive`，
   `cromOnly/v2Only`、四字段 mismatch/actionable 均为 `null`，没有输出截断集合差。
5. **完整 CROM 参考轮也已取得。** `report id=7` 完成 362/362 批、36,106 页、
   362 个 HTTP 200、0 重试；完整轮显示 CROM 自身滞后字段 2 项，
   v2 相对新鲜 L1 滞后 1,146 项，仍未归因 106 项。
6. **旧 42 个枚举差是跨时点比较。** 41 个 sitemap-only 是 7/30 当前 sitemap
   对 7/28 L3 的差；唯一 `dly-01` 已在 v1 删除但 v2 仍标 live。
7. **旧三角 votes=3/revisions=2 不是五个独立 v2 错。** 两页是旧 L3 claims，
   `scp-cn-2000` 则是复用 slug 被解析到已删除的旧 WID。

## 范围、数据与定义

### 数据源

| 来源 | 用途 | 完整性/权威性 |
|---|---|---|
| v1 `scpper-cn` | live Page/PageVersion/LatestVote 对照、历史身份取证 | 连接串服务端强制只读；所有代码查询还在 `BEGIN READ ONLY` 内 |
| v2 `scpper-v2` | current state、L1 观测、报告持久化 | 唯一允许写入的数据库 |
| CROM GraphQL | live 页面存在性与 title/rating/voteCount/revisionCount 二手金丝雀 | 爬虫，不是一手源；必须走完整游标 |
| Wikidot L1 | 当日 rating/votes/revision claims 的独立直接观测 | 字段裁决源；slug 唯一且 `page_id` 一致时才可用于身份相关裁决 |
| sitemap full | 当前全站 URL 枚举 | 完整轮才可用于 absence |
| ListPages L3 | 全字段周级快照与三角 claims | 不能作为每日枚举 parity 的当日基准 |

### 状态语义

| status | 含义 | 进程退出 |
|---|---|---|
| `ok` | 完整测量且合格 | 0 |
| `partial` | 测量有效，但处于基线/七日门暖机 | 0 |
| `inconclusive` | 输入没走完或不可比，本轮没有形成差异结论 | 0 |
| `failed` | 完整测量形成结论且不合格 | 1 |
| `aborted` | 熔断/主动中止 | 1 |

整轮合并优先级是 `aborted > failed > inconclusive > partial > ok`。因此 id=8 中
parity 的真实 `failed` 不会被 CROM/triangle 的 `inconclusive` 掩盖；反过来，
如果一轮只有不完整输入，也不会制造调度失败。

## 方法与实现

### 不完整输入门

- CROM 只有到达 `hasNextPage=false` 才允许比较；429/500、解析失败、重复 WID、
  重复 cursor、页数上限或安全批数上限均为 `inconclusive`。
- CROM CLI 默认批间等待 1,300ms。节流提高成功率，但不能替代完整性门。
- sitemap/ListPages 在结构校验和年龄校验通过前不做集合比较。
- ListPages 旧、缺失或损坏时，依赖其 claims 的 active triangle 同样
  `inconclusive`，不会对空 outcomes 调用“0 个差异”汇总。
- `meta.reconcile_report.status` 通过迁移
  `migrations/0031_reconcile_inconclusive.sql` 增加 `inconclusive`。
  `meta.ingest_run` 的旧状态词表不扩张，运行层把它记录成 `partial`，详细报告仍保留
  `inconclusive`。

### 状态 parity 判据

状态轨只比较双方 live 页，并按 `wikidotId` join；排除任一侧最近 60 分钟更新的页。
原始字段是 existence/title/rating/tags/vote_state。以下三个新解释器逐字段运行：

- `v1_crom_synthetic_tags`：双方移除 `crom:*` 后标签集合逐项完全相同。
- `source_title_unicode_whitespace`：只折叠 Unicode 空白并 trim；不做相似度匹配。
- `v1_pageversion_rating_stale`：双方 vote sum 相同，且 v2 rating 等于该 vote sum。
- `v2_anonymous_actor_space`：只有双方实名 Wikidot actor 子集的 count/rating/checksum
  全部相同，且 v2 确有匿名 actor 时才解释额外匿名部分。

现有 operator allowlist 仍保留给人工临时例外，但本次没有添加任何页面 id。

### CROM/L1 字段裁决

- CROM 与 v2 不同、且 CROM 等于新鲜 L1：`v2_stale_vs_current_l1`，可行动。
- v2 等于新鲜 L1、CROM 不同：`crom_stale_vs_current_l1`，已解释。
- 标题只允许 NFKC/空白、`…`、破折号和 `//` 标记的确定性来源归一。
- L1 只有在 v2 live slug 唯一且 `incremental_page_state.page_id` 与本页一致时可用。
  这条门防止 `scp-9311` 一类复用 slug 把新页 claims 贴到旧 WID。
- v2-only 若仍在 60 分钟窗口内，或唯一身份的新鲜 L1 已确认存在，则不把 CROM
  的二手枚举滞后报成 v2 错；`deleted:/old:` 使用独立类别判据。
- 无法由上述判据裁决的项保持 `unresolved_*`，继续失败。

## 29.12% 逐类归因

### 字段视角

最终 id=8 的 10,479 个原始差异页中，字段可重叠：

| 差异字段 | 原始字段差异页 | 已解释字段页 | 未解释字段页 | 判据/结论 |
|---|---:|---:|---:|---|
| tags | 7,203 | 7,179 | 24 | 仅移除 `crom:*` 后集合完全相同才合法 |
| title | 405 | 247 | 158 | 仅 Unicode 空白差合法 |
| rating | 565 | 407 | 158 | 两侧 vote sum 与 v2 rating 三者一致时，判 v1 PageVersion 滞后 |
| vote_state | 2,744 | 0 | 2,744 | 当前 live 页没有匿名 vote；全部保留未解释 |
| existence | 12 | 0 | 12 | 3 个 v2 缺 live 页；8 个 v1 已删但 v2 仍 live；1 个 v1 尚无身份 |

### 页级互斥归因表

下面 19 行是报告实际输出的全部互斥组合，合计 10,479；没有“其他”桶。

| 差异类别组合 | 页数 | 是否全部合法 | 判据 |
|---|---:|---|---|
| 仅 `v1_crom_synthetic_tags` | 6,995 | 是 | 去掉双方 `crom:*` 后标签集合相同 |
| 仅 `v1_pageversion_rating_stale` | 319 | 是 | 两侧 vote sum 相同且等于 v2 rating |
| 仅 `source_title_unicode_whitespace` | 245 | 是 | 仅空白归一后相同 |
| `crom tags` + `v1 rating stale` | 16 | 是 | 两条确定性判据同时成立 |
| 仅未解释 vote_state | 2,352 | 否 | actor/checksum 不同，未满足匿名子集判据 |
| 仅未解释 title | 123 | 否 | 不只是空白差 |
| 仅未解释 rating+vote_state | 137 | 否 | rating 未满足 vote sum 判据，且票态不同 |
| 仅未解释 tags+title | 16 | 否 | tags 还剩非 `crom:*` 差，title 也非空白差 |
| 仅未解释 title+vote_state | 15 | 否 | 两字段均无合法判据 |
| 仅未解释 existence | 12 | 否 | 当前 live 集不一致 |
| 仅未解释 tags | 8 | 否 | 去掉 `crom:*` 后仍不同 |
| 仅未解释 rating+title+vote_state | 1 | 否 | 三字段均无合法判据 |
| 已解释 `crom tags` + 未解释 vote_state | 146 | 否 | tags 合法，票态仍真告警 |
| 已解释 `v1 rating stale` + 未解释 vote_state | 67 | 否 | rating 合法，票态仍真告警 |
| 已解释 `crom tags` + 未解释 rating+vote_state | 20 | 否 | tags 合法，rating/票态仍真告警 |
| 已解释空白 title + 未解释 vote_state | 2 | 否 | title 合法，票态仍真告警 |
| 已解释 `v1 rating stale` + 未解释 title+vote_state | 2 | 否 | rating 合法，另两字段仍真告警 |
| 已解释 `v1 rating stale` + 未解释 title | 1 | 否 | title 仍非空白差 |
| 已解释 `crom tags`+`v1 rating stale` + 未解释 vote_state | 2 | 否 | 两字段合法，票态仍真告警 |

完全解释页为 7,575；含任一未解释字段的页为 2,904。2,904 的互斥组合是上表所有
“否”行，已逐项列出。

### 用户已拍板的四类口径如何落到本轨

| 已知口径 | 当前规模 | 对 29.12% 的贡献 | 处理 |
|---|---:|---:|---|
| v2 保存已删页、CROM 不保存 | v2 `status=deleted` 11,814 页 | 0 | parity 与 CROM 本地集合都只取 live；正确 deleted 不进入比较 |
| v1 slug 复用 | 用户观测 3,334/10,062；取证时已自然增长到 3,340 slug / 10,082 Page 行 | 0 | 状态轨按 WID join；triangle/CROM 的 L1 身份佐证增加 slug 唯一门 |
| v2 匿名 actor 保留段 | 保留段内匿名 actor 412；live `vote_current` 涉及匿名 actor 的页为 0 | 0 | 预置严格实名子集 checksum 判据，当前没有页命中 |
| v2 HTML 正文、v1 正文口径不同 | 正文未进入五个状态字段 | 0 | 结构性排除，不拿正文差解释 title/tags/vote |

这四类“已知合法”不能用于冲销当前 2,904 页。尤其 v2 页面虽然应保存删除事实，
但若 `page_current.status='live'`，它就不是“合法 deleted”。

### 12 个 existence 页

| side | WID / slug | 结论 |
|---|---|---|
| v1-only | 1469072557 `scp-cn-4957` | v1/L1/CROM live，v2 current 缺失；slug 曾复用 3 个 Page 行，v2 真缺口 |
| v1-only | 1469066236 `pissweed` | v1/L1/CROM live，v2 current 缺失；v2 真缺口 |
| v1-only | 1469069345 `scp-cn-4303` | v1/L1/CROM live，v2 current 缺失；slug 曾复用 3 个 Page 行，v2 真缺口 |
| v2-only | 1468083305 `deleted:experiment-log-914-cn-3` | v1 已删；v2 仍 live。CROM 枚举缺失本身合法，但 v2 status 需修 |
| v2-only | 1468818346 `dly-01` | v1 已删；v2 仍 live，删除投影滞后 |
| v2-only | 1469069330 `scp-cn-4905` | v1 已删；v2 仍 live，删除投影滞后 |
| v2-only | 1469069944 `jiuhu2` | v1 已删；v2 仍 live，删除投影滞后 |
| v2-only | 1469070861 `scp-cn-4866` | v1 已删；v2 仍 live，删除投影滞后 |
| v2-only | 1469071979 `qpioendfioqwhnfoliqwnf` | v1 已删；v2 仍 live，删除投影滞后 |
| v2-only | 1469066350 `scp-9311` | 旧 WID 在 v1 已删；v2 同 slug 有两个 live WID，身份/删除状态真错 |
| v2-only | 1469066854 `scp-cn-4156` | v1 已删；v2 仍 live，删除投影滞后 |
| v2-only | 1469072534 `fragment:scp-cn-4885-1` | v1 尚无该 WID，超过一小时窗；来源身份差仍未归因 |

## CROM 五项

### 为什么原 259 不能继续引用

id=3 只抓到 CROM 6,000 页便 429。该前缀中字段原始 mismatch 是
title=83、rating=86、voteCount=87、revisionCount=4，共 260；旧逻辑排除 1 个新近
title 后报“可行动 259”。旧报告只持久化 100 个总样本，没有保存分类 totals，
所以无法事后把这 259 精确重分；这一证据缺口明确保留，不用“其他”补齐。

更重要的是，它与伪 `v2-only=30,115` 一样只描述前 6,000 页，不能外推全站。

### 完整参考轮的逐字段分类

`report id=7` 于 2026-07-30 08:44–08:54 UTC 完成 362 批，CROM=36,106、
v2 live=36,118、共有=36,103。`scp-9311` 的后续身份门收紧只影响其 existence
分类；id=7 样本中该 slug 没有字段 mismatch，因此下列字段 totals 不受影响。

| 字段 | 原始 mismatch | CROM 自身滞后 | v2 相对 L1 滞后 | 来源归一 | 60m 窗 | 明确未归因 | 可行动 |
|---|---:|---:|---:|---:|---:|---:|---:|
| title | 428 | 0 | 0 | 311 | 24 | 93 | 93 |
| rating | 593 | 1 | 559 | 0 | 27 | 6 | 565 |
| voteCount | 604 | 1 | 569 | 0 | 27 | 7 | 576 |
| revisionCount | 27 | 0 | 18 | 0 | 9 | 0 | 18 |
| **合计** | **1,652** | **2** | **1,146** | **311** | **87** | **106** | **1,252** |

结论：CROM 本身是二手爬虫，但本轮 rating/vote/revision 的主问题不是 CROM 旧，
而是 v2 current 没有追上当日 L1；例如 `10th-noodle`、`114514leitra`、
`a120-suicide-guide` 的 CROM 与 L1 完全一致，v2 少/多一票；修订样本
`alt:scp9000contesthub` 与 `ankv` 也由 CROM/L1 同向确认 v2 落后。

106 个未归因字段明确分列为 title=93、rating=6、voteCount=7、revision=0；
它们继续告警，不并入来源归一或 CROM 滞后。

### 完整轮的 18 个存在性页

最终判据对 id=7 的稳定 18 页集合重分如下：

| 类别 | 页数 | 页面 | 处理 |
|---|---:|---|---|
| v2 缺 live 页，CROM-only | 3 | `pissweed`, `scp-cn-4303`, `scp-cn-4957` | v1/L1 同时确认，v2 真缺口 |
| 新近 v2-only | 3 | `diaoyu`, `scp-cn-4289`, `zhonguozhiguaiwangjiansuoye` | 60m 窗，非行动 |
| CROM 不含 deleted 分类 | 1 | `deleted:experiment-log-914-cn-3` | 来源口径合法；但其 v2 status=live 另在 parity 告警 |
| 未解释 v2-only | 8 | `dly-01`, `fragment:scp-cn-4885-1`, `jiuhu2`, `qpioendfioqwhnfoliqwnf`, `scp-9311`, `scp-cn-4156`, `scp-cn-4866`, `scp-cn-4905` | 继续行动；多项是删除/身份投影错 |
| 测试页泄入 v2 live | 3 | `test-image-page-1759148576016`, `test-image-page-1759149352271`, `test-image-page-1759413342363` | 真实环境污染，继续行动 |

最终判据下，18 个原始 existence 差中 14 个可行动、4 个已解释/窗口排除。

## sitemap/ListPages 42 项逐个取证

旧报告比较的是 7/30 sitemap 与 7/28 12:05:40Z L3，故整轨在方法上无效。
下面仍逐项列出旧报告的 42 个未解释样本，避免它们消失在总数中。

| side | slug | 当前取证结论 |
|---|---|---|
| ListPages-only | `dly-01` | v1 `isDeleted=true`，v2 仍 live；真实删除投影问题 |
| sitemap-only | `divergences` | 当前 v1 live；旧 L3 未含，跨时点差 |
| sitemap-only | `ertyuiop` | 当前 v1 live；旧 L3 后出现/变化 |
| sitemap-only | `fragment:scp-cn-4306-1` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `fragment:scp-cn-4306-2` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `fragment:scp-cn-4306-3` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `fragment:scp-cn-4885-01` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `fragment:scp-cn-4885-02` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `jiechuang` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `pinocchio-hub` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `pissweed` | 当前 v1/L1/CROM live；v2 缺页 |
| sitemap-only | `scp-032-j` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-032-th` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-091-ko` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-1327-jp` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-2014-j` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-230-j` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-688-jp` | 当前 v1 live；旧 L3 未含，跨时点差 |
| sitemap-only | `scp-746-jp` | 当前 v1 live；旧 L3 后出现/变化 |
| sitemap-only | `scp-7826` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-824-jp` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-8410` | 当前 v1 live；旧 L3 后出现/变化 |
| sitemap-only | `scp-9057` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-9199` | 当前 v1 live；旧 L3 后出现/变化 |
| sitemap-only | `scp-9249` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-9293` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-9311` | slug 有 2 个 v1 Page/WID；新 WID live，v2 错把新旧两个 WID 都标 live |
| sitemap-only | `scp-9785` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-cn-4303` | slug 历史有 3 个 Page 行；当前 WID live，v2 缺当前页 |
| sitemap-only | `scp-cn-4306` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-cn-4308` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-cn-4885` | slug 历史有 2 个 Page 行；当前新 WID live |
| sitemap-only | `scp-cn-4957` | slug 历史有 3 个 Page 行；当前 WID live，v2 缺当前页 |
| sitemap-only | `scp-l011` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scp-l113` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `scpdeclassified:scp-5008` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `short-stories:00427` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `site-cn-900` | 当前 v1 live；旧 L3 后出现/变化 |
| sitemap-only | `sleepiness` | 当前 v1 live；旧 L3 后出现/变化 |
| sitemap-only | `theater` | 当前 v1 live；旧 L3 后出现 |
| sitemap-only | `user-ringray-writer` | 当前 v1 live；旧 L3 后出现/变化 |
| sitemap-only | `wanderers:summer-cicadas-dog-days-afternoon` | 当前 v1 live；旧 L3 后出现/变化 |

处置不是把 41 页加入白名单，而是禁止每日任务拿两天前 L3 与今日 sitemap 出差异数。
目前调度没有独立持久化的“当日完整 ListPages 枚举”；因此该轨在下一次 L3 full
之前必须显式 `inconclusive`。若要每日恢复该轨，应新增同日、完整、原子 L1
枚举快照，而不是把前几批 L1 当全站。

## 三角 votes=3 / revisions=2

旧 id=3 的失败样本只有三页：

| 页面 | votes | revisions | 根因 |
|---|---|---|---|
| `scp-cn-2000` | 请求旧 WID 1174018293 后 HTTP 500 | 旧 WID 返回 no_page | slug 被 5 个 Page/WID 复用；旧 resolver 的 Map 覆盖选到已删身份。当前 live WID 是 1306943399 |
| `statement-on-disabling-offset` | L3 -4447/4649，现场 -4449/4655 | 2→现场列表 3，匹配 offset | 两天旧 claims；vote 差不是当前 v2 状态比较 |
| `third-control-and-research-bureau-for-psychic-space-anomalie` | L3 5/7，现场 54/70 | L3 4，现场列表 13 | 页面在旧快照后快速变化，两个模块同向证明 claims 旧 |

实现现在遇到复用 slug 会回源 page GET 取当前 WID；更重要的是，L3 快照过旧时根本
不再运行 active triangle。因此最终 id=8 的 enumeration 与 active 都是
`inconclusive`，votes/revisions difference 不可用，而不是 0 个不一致。

## 最终实际重跑

### 最终代码轮：report id=8 / run_id=4632

时间：2026-07-30T08:55:36.494Z – 09:01:08.199Z。

| 层/轨 | status | compared | differences | unexplained | 说明 |
|---|---|---:|---:|---:|---|
| state alignment | failed | 36,060 | 10,479 原始页 | 2,904 | 未解释率 8.0532% |
| whitelist | ok | 4 | 0 | 0 | 与上一轮基线相同 |
| deleted vote freeze | ok | 159,425 | 0 | 0 | checksum 未变 |
| parity 汇总 | failed | 195,489 | 10,479 | 2,904 | 真实分歧 |
| CROM | inconclusive | 0 | 0（不可用） | 0（不可用） | 198 批后第 199 批 429 |
| triangle enumeration | inconclusive | 0 | 0（不可用） | 0（不可用） | L3 过旧 |
| triangle active | inconclusive | 0 | 0（不可用） | 0（不可用） | claims 过旧，未执行 |
| **整轮** | **failed** | **195,489** | **10,479** | **2,904** | 退出码 1 来自 parity，不来自 inconclusive |

实际 alerts：

```text
状态对齐未解释 diff 8.0532% 未低于 0.1%
状态对齐有 2904 页未解释差异
CROM 枚举不完整：已完成 198 批、取得 19800 页；CROM 第 199 批请求失败：HttpStatusError: HTTP 429 for https://apiv2.crom.avn.sh/graphql :: {"data":{"pages":{"edges":[{"node":{"url":"http://scp-wiki-cn.wikidot.com/scp-4355","wikidotId":"800088670","title":"SCP-4355","rating":2,"voteCount":2,"revisionCount":9},"cursor":"eyJ0eXBlIjoiUGFnZSI；本轨 inconclusive，未计算存在性或字段 difference
ListPages 快照过旧：2026-07-28T12:05:40.131Z；快照时点不可比，本轨 inconclusive，未计算 difference
ListPages claims 来自缺失、损坏或过旧的完整快照，禁止继续页级比对；页级三角 inconclusive，未计算 difference
```

CROM 报告字段为：

```text
status=inconclusive
completedBatches=198
failedBatch=199
cromPages=19800
differenceCountsAvailable=false
cromOnly=null
v2Only=null
title/rating/voteCount/revisionCount mismatches=null
```

### 完整 CROM 参考轮：report id=7

id=7 是同一实现的前一完整轮：CROM 362/362 批均为 HTTP 200、0 retry，
`isFull=true`。它用于上文的全量字段归因；id=8 用于证明最终 429 生产路径没有再出
截断差异数。两轮用途分开，没有把 id=8 的半截集合与 id=7 拼接。

## 验证

| 验证项 | 结果 |
|---|---|
| 模拟 CROM 429 | 通过：`inconclusive`、counts=0、存在性/字段 mismatch=`null` |
| 模拟旧快照 | 通过：`inconclusive`，alert 含具体时间与“未计算 difference” |
| 真实分歧仍 failed | 通过：vote checksum、revision offset、未知 existence 的负向测试仍 failed |
| CROM/L1 合法差 | 通过：新鲜 L1 确认的 CROM lag 不行动；无佐证缺口仍 failed |
| 整轮状态/退出 | 通过：`isReconcileFailure` 仅对 failed/aborted 为真；operations 回归钉住 exit |
| v1 服务端只读 | `scpper-cn`, `default_transaction_read_only=on`, `transaction_read_only=on`；零行 UPDATE 被 SQLSTATE 25006 拒绝 |
| TypeScript | `npx tsc --noEmit` 通过；测试 tsconfig 通过 |
| 全套既有测试 | 316/316 通过，0 fail；身份门收紧后 reconcile/operations 24/24 再通过 |
| 数据库迁移 | 只对 `scpper-v2` 应用 0031；constraint 已含 `inconclusive` |
| 外部副作用 | 未发送 QQ；未触碰 `/home/andyblocker/qqbot`；未控制或打断源码回填 |

## 限制与稳健性

- id=3 的 259 只保存 100 个样本，无法精确追溯全部旧前缀项的新分类；本报告明确把它
  作为历史证据缺口，不进行猜测。
- 状态 parity 的 2,904 页已精确到字段组合，但 vote_state 仍需事件级 diff 才能判断
  是 v1 LatestVote 重复折叠、v2 缺票、actor 映射还是撤票时序。当前不能把 2,744
  个 vote 字段差统称为某一个原因。
- v1 在调查期间持续变化，slug 复用从用户观测的 3,334/10,062 增长到
  3,340/10,082；因此 id=3、id=7、id=8 的小幅计数差是自然时点差。
- 周级 L3 没有资格支撑每日 enum parity。在新增当日完整快照前，持续
  `inconclusive` 是正确结果，不是阻塞或失败。
- 1,300ms 节流连续完成过多轮，但累计短时重复全量请求后 id=8 仍在第 199 批 429；
  完整性门是必要保障，节流不能承诺服务端配额。

## 下一步

1. 对 2,744 个未解释 vote_state 页做 actor 集合差的互斥分类：
   `v1-only actor`、`v2-only actor`、同 actor direction 不同、仅 checksum 编码异常；
   仍按 WID actor join，不按 slug。
2. 修复 3 个 v2 缺 live 页与 8 个 v1 已删/v2 live 页；优先处理
   `scp-9311` 两个 live WID 的身份冲突。
3. 清理 3 个 `test-image-page-*` 生产 live 污染，并加测试 WID/slug 写入生产的门。
4. 追查 1,146 个由 CROM+L1 同向确认的 v2 current 滞后字段，检查 L1 触发任务到
   page_current 投影链。
5. 如需每日 sitemap/ListPages parity，设计并原子持久化当日完整 L1 enum；
   在此之前保持该轨 `inconclusive`。

## 进一步问题

- `v1_latestvote_fold_delta` 是否仍应要求“每日不增长”？它是活动 v1 库中的原始
  LatestVote 重复量，站点继续投票时可自然增长。需要单独定义按日增量的错误判据，
  不能把总量增长直接等同于 v2 回归。
- 对 `deleted:` category 的页面，v2 `status` 与“站点物理删除”是否需要两个独立状态？
  当前 `deleted:experiment-log-914-cn-3` 同时体现了来源枚举口径和 status 语义混用。
