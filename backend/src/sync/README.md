# SCPPER-CN 同步脚本使用指南

## 🎯 核心脚本说明

### 生产环境推荐脚本

#### 1. `database-sync.js` - 数据库同步服务 ⭐
**最新的生产就绪脚本，推荐使用**

```bash
node src/sync/database-sync.js
```

**功能特性**:
- ✅ 基于revision数量检测页面变更 (无需存储源代码)
- ✅ 智能页面历史版本管理
- ✅ 自动删除页面检测和用户评分重计算  
- ✅ PostgreSQL数据库存储
- ✅ 完整的错误处理和同步日志
- ✅ 频率控制 (≤2 requests/second)

**适用场景**: 正式部署、定期数据同步、生产环境

#### 2. `final-sync.js` - JSON格式同步脚本
**功能完整的备用脚本**

```bash
node src/sync/final-sync.js
```

**功能特性**:
- ✅ 断点续传功能
- ✅ 完整数据拉取 (页面+投票+修订+用户)
- ✅ JSON文件格式存储
- ✅ 详细进度显示和统计报告
- ✅ 智能频率控制

**适用场景**: 数据分析、备份、开发测试

### 开发测试脚本

#### 3. `schema-explorer.js` - API结构探索
```bash
node src/sync/schema-explorer.js
```
**用途**: 探索CROM GraphQL API的数据结构和字段

#### 4. `sqlite-test.js` - 数据库测试
```bash
node src/sync/sqlite-test.js  
```
**用途**: SQLite集成测试和性能验证

#### 5. `full-data-pull.js` - 完整数据拉取
```bash
node src/sync/full-data-pull.js
```
**用途**: 一次性获取30,849页面的完整数据

## 🗂️ 废弃脚本说明

`archive/` 目录包含7个历史开发版本 (148KB)，已被更好的版本替代：

| 废弃脚本 | 替代脚本 | 废弃原因 |
|---------|----------|----------|
| `test-full-sync.js` | `final-sync.js` | 功能不完整 |
| `optimized-sync.js` | `database-sync.js` | 缺少数据库支持 |
| `optimized-full-pull.js` | `full-data-pull.js` | 性能优化不足 |
| `rate-limited-pull.js` | 集成到主脚本 | 功能已合并 |
| `resume-pull.js` | 集成到主脚本 | 断点续传已完善 |
| `fixed-resume-pull.js` | `final-sync.js` | Bug修复版本 |
| `diagnose-users.js` | 问题已解决 | 诊断工具 |

## 🚀 推荐使用流程

### 新环境部署
```bash
# 1. 首次完整数据同步
node src/sync/database-sync.js

# 2. 验证数据完整性
node src/analysis/user-analytics.js

# 3. 设置定时任务 (每日凌晨)
# crontab: 0 3 * * * cd /path/to/scpper-cn/backend && node src/sync/database-sync.js
```

### 日常维护
```bash
# 增量数据同步
node src/sync/database-sync.js

# 用户数据分析
node src/analysis/user-analytics.js

# 数据库查询测试
node src/analysis/database-user-query.js user "MScarlet"
```

### 数据分析研究
```bash
# 使用JSON格式同步 (便于数据处理)
node src/sync/final-sync.js

# 用户关系分析
node src/analysis/user-analytics.js

# 时间序列可视化准备
node src/analysis/timeseries-visualization-prep.js
```

## ⚙️ 配置说明

### 环境变量
```env
# CROM API配置
CROM_API_URL=https://apiv1.crom.avn.sh/graphql
TARGET_SITE_URL=http://scp-wiki-cn.wikidot.com

# 数据库配置 (database-sync.js)
DATABASE_URL=postgresql://user:password@localhost/scpper_cn

# 频率控制
MAX_REQUESTS_PER_SECOND=1.8
BATCH_SIZE=10
```

### 频率限制
- **CROM API限制**: 300,000 points per 5-minute window
- **建议频率**: ≤2 requests/second
- **批次大小**: 10 pages per request
- **实际处理速度**: ~2 pages/second

## 📊 性能对比

| 脚本 | 存储格式 | 内存占用 | 断点续传 | 历史版本 | 推荐度 |
|------|----------|----------|----------|----------|--------|
| `database-sync.js` | PostgreSQL | 中等 | ✅ | ✅ | ⭐⭐⭐⭐⭐ |
| `final-sync.js` | JSON | 高 | ✅ | ❌ | ⭐⭐⭐⭐ |
| `full-data-pull.js` | JSON | 高 | ❌ | ❌ | ⭐⭐⭐ |

## 🛠️ 维护建议

### 代码清理
```bash
# 可以安全删除archive目录 (已有备份)
rm -rf src/sync/archive/

# 或者先备份
mv src/sync/archive /tmp/scpper-archive-backup
```

### 监控指标
- 同步成功率 > 95%
- 内存使用 < 2GB
- 处理速度 ~2 pages/second
- API配额使用率 < 80%

### 故障排除
1. **API配额耗尽**: 等待5分钟重置窗口
2. **网络超时**: 自动重试机制
3. **数据库连接**: 检查DATABASE_URL配置
4. **内存不足**: 使用database-sync.js而非final-sync.js