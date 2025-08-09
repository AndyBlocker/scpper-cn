# SCP-CN Backend 数据库优化和增量分析系统

基于 `reply.md` 文档的完整重构方案，本次更新包含以下主要改进：

## 🚀 主要更新内容

### 1. 数据库层优化
- **新增索引**: 针对 Vote/Revision/Attribution 等热路径添加复合索引
- **统计函数库**: Wilson下界和争议度计算函数
- **页面创建时间标准化**: 新增 `Page.firstPublishedAt` 字段
- **物化视图**: 近30天热门页面等预计算视图

### 2. 增量分析框架
- **水位线机制**: 基于时间戳的增量处理，避免全量重算
- **变更集检测**: 自动识别需要更新的数据
- **参数化查询**: 移除所有 `$executeRawUnsafe` 使用
- **分片处理**: 避免大表全量 TRUNCATE

### 3. 全文搜索功能
- **SearchIndex 表**: 页面内容、标题、标签的统一索引
- **pg_trgm 支持**: 中英文混合搜索，支持模糊匹配
- **多字段搜索**: 标题、内容、源码的权重搜索
- **搜索建议**: 自动补全和热门标签

### 4. 扩展统计功能
- **作者成长曲线**: 早期作品表现分析
- **高争议标签**: 标签下页面争议度统计
- **时段分布**: 最佳发布时间分析
- **编号段分析**: SCP编号使用密度
- **长尾点赞王**: 低票数高质量页面
- **编辑英雄榜**: 活跃编辑者统计
- **里程碑记录**: 重要数量节点
- **标签组合**: 常见标签搭配分析

### 5. 日聚合数据
- **PageDailyStats**: 页面日投票、修订统计
- **UserDailyStats**: 用户日活动统计
- **LeaderboardCache**: 榜单结果缓存

## 📋 迁移步骤

### 1. 数据库迁移
```bash
# 应用数据库schema变更
npx prisma migrate deploy

# 重新生成Prisma客户端
npx prisma generate
```

### 2. 执行完整迁移（推荐）
```bash
# 运行完整迁移脚本
npm run ts-node scripts/run-complete-migration.ts
```

### 3. 手动分步迁移
```bash
# 数据回填和初始化
npm run ts-node scripts/migrate-and-backfill.ts

# 可选：生成扩展统计
npm run ts-node -e "
import { generateExtendedInterestingStats } from './src/jobs/ExtendedInterestingStatsJob.js';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
generateExtendedInterestingStats(prisma).then(() => prisma.$disconnect());
"
```

## 🔄 使用新的分析系统

### 增量分析
```typescript
import { IncrementalAnalyzeJob } from './src/jobs/IncrementalAnalyzeJob.js';

const analyzer = new IncrementalAnalyzeJob();

// 增量分析（推荐的日常使用方式）
await analyzer.analyze();

// 强制全量分析（仅在必要时使用）
await analyzer.analyze({ forceFullAnalysis: true });

// 指定任务分析
await analyzer.analyze({ 
  tasks: ['page_stats', 'search_index'] 
});
```

### 搜索功能
```typescript
import { SearchService, searchPages } from './src/services/SearchService.js';

// 简单搜索
const results = await searchPages('SCP-173', {
  tags: ['scp', '原创'],
  limit: 20
});

// 高级搜索
const searchService = new SearchService();
const advanced = await searchService.advancedSearch({
  title: '雕像',
  content: '混凝土',
  tags: { include: ['scp'], exclude: ['掩藏页'] },
  scoringMode: 'relevance'
});
```

### 改进的用户评级
```typescript
import { calculateImprovedUserRatings } from './src/jobs/ImprovedUserRatingJob.js';

// 全量重算用户评级
await calculateImprovedUserRatings(prisma);

// 增量更新指定用户
await calculateImprovedUserRatings(prisma, [userId1, userId2]);
```

## 📊 性能提升

### 分析性能
- **增量处理**: 仅处理变更数据，减少90%+的计算量
- **批量操作**: 使用集合运算替代逐行处理
- **索引优化**: 针对热路径查询优化索引设计
- **并行处理**: 支持任务级别的并行执行

### 搜索性能
- **GIN索引**: 全文搜索和标签查询O(log n)时间复杂度
- **预计算**: 热门搜索结果预缓存
- **分页优化**: 高效的LIMIT/OFFSET处理

### 缓存策略
- **物化视图**: 复杂聚合预计算
- **LeaderboardCache**: 榜单结果缓存
- **过期清理**: 自动清理过期缓存数据

## 🔧 维护和监控

### 定期任务
```bash
# 日常增量分析（建议每5-15分钟）
npm run ts-node -e "
import { IncrementalAnalyzeJob } from './src/jobs/IncrementalAnalyzeJob.js';
new IncrementalAnalyzeJob().analyze();
"

# 物化视图刷新（建议每小时）
psql -d scpper-cn -c "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_pages_30d;"

# 缓存清理（建议每日）
npm run ts-node -e "
import { IncrementalAnalyzeJob } from './src/jobs/IncrementalAnalyzeJob.js';
new IncrementalAnalyzeJob().cleanupExpiredCache();
"
```

### 监控指标
```typescript
// 获取分析系统状态
const analyzer = new IncrementalAnalyzeJob();
const stats = await analyzer.getAnalysisStats();

// 搜索系统状态
const searchService = new SearchService();
const searchStats = await searchService.getSearchStats();
```

### 故障排查
1. **水位线重置**: 如果数据不一致，可删除对应任务的水位线记录来强制全量重算
2. **搜索索引重建**: 删除SearchIndex表数据后重新同步
3. **物化视图问题**: DROP后重新CREATE物化视图

## ⚠️ 注意事项

### 数据安全
- **备份**: 迁移前务必备份数据库
- **测试**: 在测试环境验证迁移效果
- **监控**: 迁移后密切观察系统性能

### 兼容性
- **向后兼容**: 现有API和数据结构保持兼容
- **渐进式迁移**: 新旧系统可并行运行
- **回滚计划**: 保留回滚到旧系统的能力

### 性能考虑
- **分析频率**: 根据数据变化频率调整分析间隔
- **批处理大小**: 根据系统资源调整批处理参数
- **索引维护**: 定期VACUUM和REINDEX

## 📈 预期效果

### 分析性能
- **处理时间**: 从分钟级降至秒级
- **资源占用**: 减少70%+的CPU和内存使用
- **并发能力**: 支持分析期间的正常读写操作

### 功能增强
- **全文搜索**: 支持中英文混合搜索
- **实时统计**: 更及时的数据更新
- **扩展分析**: 更丰富的统计维度
- **缓存优化**: 更快的榜单和热门内容加载

### 维护便利性
- **自动化**: 大幅减少手动干预需求
- **监控**: 完整的状态监控和报警
- **扩展性**: 易于添加新的分析任务
- **可观测性**: 详细的执行日志和性能指标

## 🤝 获得帮助

如果在迁移过程中遇到问题：

1. 检查日志输出中的错误信息
2. 确认数据库连接和权限配置
3. 验证系统资源（磁盘空间、内存）
4. 查阅本文档的故障排查部分
5. 联系开发团队获得支持

迁移成功后，建议：
- 监控系统性能指标
- 验证数据准确性
- 调整分析任务频率
- 设置监控报警