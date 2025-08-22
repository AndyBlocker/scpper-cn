# 用户数据完整性改进

## 概述
本次更新主要解决了两个问题：
1. 用户数据不完整：缺失关键时间戳和用户名信息
2. 社交分析缺失：用户关系和偏好分析表未使用

## 实现的功能

### 1. UserDataCompletenessJob - 用户数据完整性填充
负责填充 User 表中缺失的关键字段：

#### username 字段处理逻辑
- **游客用户**（wikidotId < 0）：使用 `guest_` 前缀，如 `guest_12345`
- **已删除用户**（wikidotId >= 0 但 displayName 为 NULL）：设为 `(user deleted)`
- **正常用户**：基于 displayName 生成，转换为小写并替换空格为下划线

#### 时间戳字段
- **firstActivityAt**：从投票、修订、归属记录中找到最早的活动时间
- **lastActivityAt**：从所有活动记录中找到最新的活动时间

### 2. UserSocialAnalysisJob - 用户社交分析
填充和更新社交分析相关表：

#### UserTagPreference - 用户标签偏好
- 统计每个用户对不同标签的投票倾向
- 记录点赞数、点踩数、总投票数和最后投票时间
- 过滤掉无意义标签（页面、重定向、管理、_cc）
- 只记录至少投过3次票的标签

#### UserVoteInteraction - 用户投票交互
- 记录用户A对用户B作品的投票统计
- 支持发现相互投票模式
- 基于作者归属（Attribution）关系建立交互

### 3. 增量更新支持
两个新任务都完全支持基于 watermark 的增量更新：
- 只处理变更集（changeSet）中受影响的用户
- 使用批量 SQL 更新，避免 N+1 查询
- 支持 UPSERT 操作，可重复运行

## 集成到分析框架
新任务已添加到 `IncrementalAnalyzeJob` 的任务列表中：
- `user_data_completeness` - 用户数据完整性任务
- `user_social_analysis` - 用户社交分析任务

运行方式：
```bash
# 运行所有分析任务（包括新任务）
npm run analyze

# 仅运行特定任务
npm run analyze -- --tasks user_data_completeness,user_social_analysis

# 强制全量分析
npm run analyze:full
```

## 关于 isGuest 字段
根据需求，isGuest 字段已被废弃。判断用户是否为游客应该直接检查 `wikidotId < 0`。

## 关于搜索过滤
对于用户搜索功能，应该在搜索时过滤掉：
- username 为 `(user deleted)` 的用户
- displayName 为 NULL 的用户

这可以在搜索查询中添加相应的 WHERE 条件来实现。

## Rating 和 Ranking 统计验证
经过验证，当前的 UserRatingJob 中的分类统计逻辑是正确的：
- **SCP分类**：同时包含 `原创` 和 `scp` 标签
- **翻译分类**：非原创且非掩藏页的页面
- **GOI格式**：同时包含 `原创` 和 `goi格式` 标签
- **故事分类**：同时包含 `原创` 和 `故事` 标签
- **Wanderers**：同时包含 `原创` 和 `wanderers` 标签
- **艺术作品**：同时包含 `原创` 和 `艺术作品` 标签

排名计算使用 ROW_NUMBER() 窗口函数，按评分降序排列，确保了正确的排名顺序。