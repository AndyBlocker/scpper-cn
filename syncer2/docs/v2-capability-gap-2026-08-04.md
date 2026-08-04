# v2 能力缺口盘点（2026-08-04）

前提：新版 `scpper.mer.run` 必须提供当前项目的**全部**能力。本文对照 v1 实际有数据的表
与 v2 `serve`/`app` 的现状，列出所有缺口。

BFF 现有 **24 个路由模块 / 168 个端点**。数据侧缺口分三类。

---

## A. 用户产生的数据：从未迁移（最高优先）

v2 的 `app` schema 表**全部存在但全部 0 行**。历次回填只覆盖 wiki 数据，
用户自己产生的内容一次都没迁过。切流即丢失。

| v1 表 | 行数 | v2 对应 | 影响的 BFF 路由 |
|---|---:|---|---|
| `tracking_debug_event` | 359,781 | `app.tracking_debug_event` | tracking (14 端点) |
| `PageMetricAlert` | 35,802 | `app.page_metric_alert` | alerts (8) |
| `ForumInteractionAlert` | 30,296 | `app.forum_interaction_alert` | forumAlerts |
| `UserActivityAlert` | 4,227 | `app.user_activity_alert` | alerts |
| `PageMetricWatch` | 157,128 | `app.page_metric_watch` | alerts / tracking |
| `UserCollectionItem` | 786 | `app.user_collection_item` | collections (9) |
| `CollectionAccountOwner` | 770 | `app.collection_account_owner` | collections / internalCollectionOwner |
| `UserCollection` | 177 | `app.user_collection` | collections |
| `UserFollow` | 169 | `app.user_follow` | follows / followAlerts |
| `UserMetricPreference` | 72 | `app.user_metric_preference` | users |
| `PageViewEvent` | 1,241,792 | `app.page_view_event` | analytics (7) |
| `UserPixelEvent` | 297,892 | `app.user_pixel_event` | tracking |

**注意**：这类数据**没有权威外部源**——wiki 上不存在，重抓不回来。
与 wiki 数据不同，它只能从 v1 迁移，且迁移窗口内 v1 必须停止写入或做增量追平。
这是唯一一类「切流时点必须精确协调」的数据。

`PageMetricWatch` 另有既知问题：`lastObserved` 需重新基线化，
不做的话切流会对 1,007 名用户产生约 1,790 条误报告警。

---

## B. 派生数据：v2 有表但未建设

v2 `serve` 有 20 张空表。以下对应 v1 **确实在用**的功能：

| v1 表 | 行数 | v2 空表 | 说明 |
|---|---:|---|---|
| `PageReference` | **4,048,851** | `page_reference` | 页面引用图。**纯解析产物、零网络请求**，详见下方说明 |
| `PageEmbedding` | 124,955 | `chunk_embedding` / `text_chunk` / `page_semantic` | 语义检索。曾决定 C1 延后、可暂停 embedding 功能 |
| `ImageAsset` | 47,050 | `image_asset` | 图片资产（v2 已有 78,818 条 `page_image` 引用，但资产表为空） |
| `CategoryIndexTick` | 25,194 | `category_index_tick` | 分类指数 |
| `CategoryIndexForecastTick` | 20,736 | `category_index_forecast_tick` | 分类指数预测 |
| `TagValidationCache` | 2,559 | `tag_validation_cache` | 标签校验缓存 |
| `TrendingStats` | 442 | `trending_stats` | 热度榜 |
| `InterestingFacts` | 130 | `interesting_facts` | 趣味统计 |
| `SeriesStats` | 10 | `series_stats` | 系列统计 |
| `LeaderboardCache` | 2 | `leaderboard_cache` | 排行缓存（曾决定「榜单 ranking 暂时不需要」） |
| `PageReferenceGraphSnapshot` | 1 | `page_reference_graph_snapshot` | 引用图快照 |

这类**可从 v2 已有事实重算**，不需要 v1 迁移，但需要实现投影逻辑。

### `page_reference` 的性质（此前我归类错误）

`backend/src/services/PageReferenceService.ts` 的 `extractInternalReferences(source)`
**唯一输入是页面源码**，用三种正则从 wikitext 提取内链（`TRIPLE` `[[[目标|显示]]]`、
`SHORT`、`DIRECT` 裸 URL），并做域名剥离、协议相对地址、`javascript:`/`mailto:` 排除、
`local--files/` 识别、fragment 与显示变体归一。**全程零网络请求。**

因此它不占日预算，也不需要「是否要抓」的决策——v2 已有 **347,558 份逐版本源码**
（v1 的 `SourceVersion` 只有 111,095），完全可以本地重算，且**结果会比 v1 更完整**：
v1 缺失大量历史版本源码，其引用图对早期版本是有洞的。

用户原话「页面引用我们应该可以自己解析而不是从 wikidot 获取」指的正是这件事，
先前被误读成「暂时不做」。

---

## C. 已明确延后、需确认是否仍延后

- `textHtml`（正文 HTML）：曾定「是需要增加的功能，但 MCP 上不需要处理」
- 附件实时抓取：曾定「放弃 realtime，只在之后某个时候做一次重建」
  （scp-cn.wikidot 附件功能已停用；但**从正文提取并分析**的功能要保留，已在做）
- 标签变更历史：可经独立 diff 请求可靠获取（结构化字段不受 nl2br 影响），未做

---

## D. v2 已经超过 v1 的部分（不是缺口，供对照）

- 论坛：551,612 帖（v1 无完整论坛数据）
- 父子层级：深度 0–7（v1 完全没有此机制）
- 逐版本源码：347,558 份（v1 只有 `SourceVersion` 111,095）
- 投票多重性：与 wikidot 显示分数一致（v1 会重复计票）
- 已删页：完整保留并参与站点总览

---

## 优先级建议

1. **A 类**（用户数据）——唯一不可重建的一类，且切流时点必须精确协调。应最先设计迁移方案。
2. **B 类中的 `page_reference`**——400 万行、纯本地重算、零请求成本，且 v2 源码覆盖更全，重算结果优于 v1。
3. **B 类其余**——可从 v2 事实重算，排在对账稳定之后。
4. **C 类**——增量功能，不阻塞切流。

## 一条结构性提醒

`app` schema 是 BFF **可写**的，与 `ingest`/`serve` 的只读投影语义不同。
新前端重构时，写路径只能落 `app`；任何把用户数据写进 `serve` 的做法都会在下次
投影重建时被抹掉——`serve` 按定义是可重建的。
