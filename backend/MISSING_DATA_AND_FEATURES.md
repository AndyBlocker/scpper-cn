# SCPPER-CN 缺失数据和功能清单

## 概述
本文档记录了在完成一次完整的 `npm run sync` 后，系统中缺失的数据字段和未实现的功能。

## 已自动生成的数据

### Phase A (扫描阶段)
- ✅ **PageMetaStaging** - 临时存储所有页面元数据
- ✅ **DirtyPage** - 需要处理的页面队列

### Phase B (内容采集)
- ✅ **Page** - 页面基本信息
- ✅ **PageVersion** - 页面版本历史
- ✅ **Attribution** - 页面贡献者信息
- ✅ **SourceVersion** - 页面源代码版本
- ✅ **Revision** - 修订记录（前MAX_FIRST条）
- ✅ **Vote** - 投票记录（前MAX_FIRST条）

### Phase C (补充采集)
- ✅ 完整的 **Revision** 记录（超过MAX_FIRST的部分）
- ✅ 完整的 **Vote** 记录（超过MAX_FIRST的部分）

### Analyze阶段 (IncrementalAnalyzeJob)
- ✅ **PageStats** - 页面统计（UV/DV、Wilson评分、争议度）
- ✅ **UserStats** - 用户统计（评分、排名、页面数量等）
- ✅ **SiteStats** - 站点统计
- ✅ **PageDailyStats** - 页面日统计
- ✅ **UserDailyStats** - 用户日统计
- ✅ **votingTimeSeriesCache** - 投票时间序列缓存（在Page表中）
- ✅ **InterestingFacts** - 有趣事实
- ✅ **TimeMilestones** - 时间里程碑
- ✅ **TagRecords** - 标签记录
- ✅ **ContentRecords** - 内容记录
- ✅ **RatingRecords** - 评分记录
- ✅ **UserActivityRecords** - 用户活动记录
- ✅ **SearchIndex** - 搜索索引（基础版本）
- ✅ **SeriesStats** - 系列统计
- ✅ **TrendingStats** - 趋势统计

## 缺失的数据和功能

### 1. User表关键字段未填充

| 字段 | 描述 | 影响 | 优先级 |
|------|------|------|--------|
| `firstActivityAt` | 用户首次活动时间 | 无法追踪用户历史 | 高 |
| `firstActivityType` | 首次活动类型 | 无法分析用户行为模式 | 中 |
| `firstActivityDetails` | 首次活动详情 | 缺少用户起始行为数据 | 低 |
| `lastActivityAt` | 最后活动时间 | 无法判断用户活跃度 | 高 |
| `username` | 用户名 | 只有displayName，缺少唯一标识 | 高 |
| `isGuest` | 是否游客 | 无法区分注册用户和游客 | 中 |

**实现建议**：
- 在 Phase B/C 处理过程中，通过分析 Revision 和 Vote 记录计算这些字段
- 需要在 `DatabaseStore.ts` 中添加相应的更新逻辑

### 2. SearchIndex表高级功能缺失

| 功能 | 描述 | 影响 | 优先级 |
|------|------|------|--------|
| `embedding` | 向量嵌入 | 无法进行语义搜索 | 高 |
| `searchVector` | 全文搜索向量 | 搜索性能受限 | 高 |
| `contentSummary` | 内容摘要 | 搜索结果预览质量差 | 中 |
| `contentType` | 内容类型分类 | 无法按类型筛选 | 中 |
| `languageType` | 语言类型 | 无法进行多语言搜索 | 低 |

**实现建议**：
- 集成已有的 `EmbeddingService.ts`
- 使用 OpenAI 或其他模型生成向量嵌入
- 实现内容分类算法

### 3. UserSearchIndex完全未实现

**影响**：
- 无法搜索用户
- 无法基于用户活动进行推荐
- 缺少用户画像功能

**需要实现的字段**：
- `activitySummary` - 活动摘要
- `lastActivityScore` - 最后活跃度评分
- `popularityScore` - 人气评分
- `searchKeywords` - 搜索关键词
- `searchScore` - 搜索评分
- `searchVector` - 搜索向量
- `statsSnapshot` - 统计快照
- `tagPreferences` - 标签偏好
- `embedding` - 向量嵌入

### 4. LeaderboardCache未使用

**影响**：
- 排行榜查询性能差
- 无法快速获取各类排名

**需要缓存的排行榜**：
- 总体评分排行
- SCP评分排行
- 翻译评分排行
- GOI评分排行
- 故事评分排行
- 流浪者图书馆排行
- 艺术作品排行

### 5. 用户行为分析表未实现

#### UserTagPreference（用户标签偏好）
- 分析用户对不同标签的投票偏好
- 用于个性化推荐

#### UserVoteInteraction（用户投票交互）
- 分析用户之间的投票关系
- 构建社交网络图谱

### 6. Page表缺失字段

| 字段 | 描述 | 获取方式 | 优先级 |
|------|------|----------|--------|
| `firstPublishedAt` | 首次发布时间 | 从最早的Revision记录推算 | 高 |

### 7. 缺失的服务集成

#### EmbeddingService（已有代码未集成）
- 位置：`backend/src/services/EmbeddingService.ts`
- 功能：生成文本向量嵌入
- 集成点：SearchIndex更新、UserSearchIndex生成

#### HybridSearchService（已有代码未集成）
- 位置：`backend/src/services/HybridSearchService.ts`
- 功能：混合搜索（全文+向量）
- 依赖：需要先集成EmbeddingService

### 8. 缺失的高级统计功能

| 功能 | 描述 | 价值 | 复杂度 |
|------|------|------|--------|
| 社交网络分析 | 用户之间的关系图谱 | 发现核心用户群体 | 高 |
| 内容质量评分 | 基于多维度的质量评估 | 内容推荐和筛选 | 中 |
| 实时热度计算 | 基于时间衰减的热度值 | 热门内容发现 | 中 |
| 细粒度时序分析 | 小时级别的活动分析 | 精确的趋势预测 | 高 |

## 实现优先级建议

### 第一阶段（基础功能完善）
1. 填充User表基础字段（username, lastActivityAt, firstActivityAt）
2. 实现Page.firstPublishedAt计算
3. 完成SearchIndex的searchVector生成

### 第二阶段（搜索增强）
1. 集成EmbeddingService
2. 实现UserSearchIndex
3. 集成HybridSearchService

### 第三阶段（用户分析）
1. 实现UserTagPreference
2. 实现UserVoteInteraction
3. 实现LeaderboardCache

### 第四阶段（高级功能）
1. 内容类型自动分类
2. 社交网络分析
3. 实时热度系统
4. 高级时序分析

## 技术债务

1. **GraphQL查询优化**：当前某些查询可能存在N+1问题
2. **事务一致性**：某些批量操作缺少事务保护
3. **错误恢复机制**：Phase处理失败后的恢复策略不完善
4. **监控和日志**：缺少详细的性能监控和错误追踪

## 备注

- 所有缺失功能都不影响基础数据同步功能
- 优先级基于对用户体验的影响程度评定
- 某些功能（如向量嵌入）需要额外的基础设施支持（如向量数据库配置）