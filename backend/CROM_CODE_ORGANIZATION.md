# SCPPER-CN CROM代码整理文档

## 📁 目录结构概览

```
backend/
├── src/
│   ├── sync/                 # CROM数据同步相关
│   │   ├── archive/         # 已废弃的历史版本
│   │   ├── database-sync.js # 🌟 当前主要数据库同步脚本
│   │   ├── final-sync.js    # 🌟 最终整合的同步脚本
│   │   ├── full-data-pull.js # 完整数据拉取脚本
│   │   ├── schema-explorer.js # CROM API结构探索
│   │   └── sqlite-test.js   # SQLite测试脚本
│   └── analysis/            # 数据分析相关
│       ├── user-analytics.js # 用户分析系统
│       ├── database-user-query.js # 数据库查询接口 
│       └── ...
├── prisma/
│   └── schema.prisma        # 数据库结构定义
├── resume-sync-data/        # 同步数据和检查点
└── user-analysis/          # 用户分析结果
```

## 🎯 核心脚本分类

### A. 生产就绪脚本 ✅

#### 1. `database-sync.js` - 数据库同步服务
**用途**: 生产环境的完整数据库同步脚本
**功能**:
- 基于revision数量检测页面变更
- 页面历史版本管理
- 删除页面检测和用户评分重计算
- 完整的错误处理和同步日志

**运行方式**:
```bash
node src/sync/database-sync.js
```

#### 2. `final-sync.js` - 最终整合脚本
**用途**: 集成所有优化功能的主同步脚本
**功能**:
- 断点续传
- 智能频率控制 (≤2 req/sec)
- 完整数据拉取 (页面+投票+修订+用户)
- JSON数据持久化

**运行方式**:
```bash
node src/sync/final-sync.js
```

#### 3. `user-analytics.js` - 用户分析系统
**用途**: 综合用户数据分析和排行榜生成
**功能**:
- 27,499用户数据挖掘
- 投票关系分析
- 合著评分修正
- 时间序列可视化准备

### B. 开发测试脚本 🧪

#### 1. `schema-explorer.js` - API结构探索
**用途**: 分析CROM GraphQL API的数据结构
**功能**: 探索可用字段和数据关系

#### 2. `sqlite-test.js` - 数据库测试
**用途**: SQLite集成测试
**功能**: 验证数据库操作和查询性能

#### 3. `full-data-pull.js` - 完整数据拉取
**用途**: 一次性全量数据获取
**功能**: 30,849页面完整数据拉取

### C. 已废弃脚本 🗂️ (archive/)

所有archive/目录下的脚本都是开发过程中的历史版本，已被更好的版本替代：

- `test-full-sync.js` → 被 `final-sync.js` 替代
- `optimized-sync.js` → 被 `database-sync.js` 替代  
- `optimized-full-pull.js` → 被 `full-data-pull.js` 替代
- `rate-limited-pull.js` → 频率控制集成到主脚本
- `resume-pull.js` → 断点续传集成到主脚本
- `fixed-resume-pull.js` → 问题修复版本
- `diagnose-users.js` → 用户问题诊断，已解决

## 🚀 推荐使用脚本

### 1. 日常数据同步
```bash
# 推荐：使用数据库同步（支持增量更新）
node src/sync/database-sync.js

# 备选：使用最终整合脚本（JSON格式）
node src/sync/final-sync.js
```

### 2. 数据分析查询
```bash
# 用户档案查询
node src/analysis/database-user-query.js user "AndyBlocker"

# 用户分析系统
node src/analysis/user-analytics.js
```

### 3. 初次部署或完整重建
```bash
# 1. 完整数据拉取
node src/sync/full-data-pull.js

# 2. 用户分析
node src/analysis/user-analytics.js

# 3. 启动数据库同步
node src/sync/database-sync.js
```

## 📊 数据流程图

```
CROM GraphQL API
       ↓
[final-sync.js] → JSON文件 → [user-analytics.js] → 用户排行榜
       ↓
[database-sync.js] → PostgreSQL → [database-user-query.js] → 查询接口
       ↓
页面历史版本管理 & 删除检测
```

## 🛠️ 配置文件

### 环境变量 (.env)
```env
# CROM API
CROM_API_URL=https://apiv1.crom.avn.sh/graphql
TARGET_SITE_URL=http://scp-wiki-cn.wikidot.com

# 数据库
DATABASE_URL=postgresql://user:password@localhost/scpper_cn
```

### 频率限制配置
- 最大请求频率: 2 requests/second
- 配额限制: 300,000 points per 5-minute window
- 自动断点续传支持

## 🔧 维护建议

### 应该保留的文件
- ✅ `database-sync.js` - 主要同步脚本
- ✅ `final-sync.js` - 备用同步脚本  
- ✅ `user-analytics.js` - 分析系统
- ✅ `database-user-query.js` - 查询接口
- ✅ `schema-explorer.js` - API探索工具

### 可以清理的文件
- 🗑️ `archive/` 整个目录 (7个历史脚本)
- 🗑️ `sqlite-test.js` (如果不使用SQLite)
- 🗑️ `full-data-pull.js` (如果只使用增量同步)

### 建议的清理操作
```bash
# 安全起见，先移动到临时目录
mv src/sync/archive /tmp/scpper-archive-backup

# 如果确认不需要，可以删除
# rm -rf /tmp/scpper-archive-backup
```

## 📈 性能特征

| 脚本 | 内存占用 | 处理速度 | 断点续传 | 数据格式 |
|------|----------|----------|----------|----------|
| database-sync.js | 中等 | 2 pages/sec | ✅ | PostgreSQL |
| final-sync.js | 高 | 2 pages/sec | ✅ | JSON |
| user-analytics.js | 高 | - | - | JSON输出 |

## 🎯 下一步优化

1. **代码清理**: 删除archive目录下的废弃脚本
2. **文档完善**: 为主要脚本添加详细注释
3. **错误处理**: 统一错误处理和日志格式
4. **配置管理**: 集中管理所有配置参数