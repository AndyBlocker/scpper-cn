# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

SCPPER-CN 是一个基于 CROM GraphQL API 的数据同步和分析系统，专门用于 SCP 基金会中文分部的数据管理。项目已从 API v1 迁移至 API v2，支持页面、用户、投票记录等数据的全量和增量同步。

## 核心架构

### 主要组件

- **backend/**: Node.js 后端服务，包含主要的数据同步和分析逻辑
  - `src/main.js`: 系统主入口，支持多种运行模式
  - `src/sync/production-sync.js`: 生产环境数据同步服务
  - `src/sync/database-sync.js`: 数据库同步服务
  - `src/analyze/vote-analyzer.js`: 投票数据分析器
  - `src/sync/schema-explorer.js`: GraphQL Schema 探索工具

### 数据流

1. **数据获取**: 通过 CROM GraphQL API v2 获取页面、用户、投票等数据
2. **数据处理**: 支持增量更新、断点续传、智能变化检测
3. **数据存储**: 使用 PostgreSQL + Prisma ORM 进行数据管理
4. **数据分析**: 提供投票网络分析、用户关系分析等功能

## 常用命令

### 开发环境
```bash
# 启动开发服务器（带文件监控）
npm run dev

# 设置数据库（Docker）
npm run db:setup

# 运行数据库迁移
npm run db:migrate

# 打开 Prisma Studio
npm run db:studio
```

### 数据同步命令
```bash
# 完整数据同步流程
npm run main full

# 仅生产环境数据同步
npm run main sync
# 或直接运行
npm run sync

# 仅数据库同步
npm run main database
# 或直接运行
npm run database

# Schema 探索
npm run main schema
# 或直接运行
npm run schema
```

### 数据分析命令
```bash
# 运行投票数据分析（需要提供数据文件路径）
npm run main analyze <data-file-path>
# 或直接运行
npm run analyze <data-file-path>

# 分析示例
node src/analyze/vote-analyzer.js ./production-data/production-data-final-2025-01-15.json who-voted-me "作者名"
node src/analyze/vote-analyzer.js ./production-data/production-data-final-2025-01-15.json i-voted-whom "用户名"
node src/analyze/vote-analyzer.js ./production-data/production-data-final-2025-01-15.json mutual-voting
```

## 技术栈和依赖

### 核心技术
- **Node.js** (ES Modules)
- **GraphQL** (CROM API v2)
- **PostgreSQL** (通过 Docker)
- **Prisma ORM**
- **Fastify** (Web 框架)
- **Redis** (缓存)

### 主要依赖
- `graphql-request`: GraphQL 客户端
- `@prisma/client`: 数据库 ORM
- `fastify`: Web 服务器
- `redis`: Redis 客户端
- `pg`: PostgreSQL 客户端
- `dotenv`: 环境变量管理

## 配置和环境变量

项目使用 `.env` 文件管理配置，主要变量包括：
- `DATABASE_URL`: PostgreSQL 连接字符串
- `REDIS_URL`: Redis 连接字符串
- `TARGET_SITE_URL`: 目标站点 URL（默认：http://scp-wiki-cn.wikidot.com）

## 数据同步特性

### 高级功能
- **增量更新**: 基于投票时间戳和页面状态的智能更新检测
- **断点续传**: 支持大规模数据同步的中断恢复
- **Rate Limit 管理**: 智能频率控制（300,000点/5分钟）
- **错误处理**: 429错误重试机制和错误恢复
- **进度追踪**: 实时进度显示和时间预估

### 数据类型
- **页面数据**: URL、标题、评分、投票数、标签等
- **投票记录**: fuzzyVoteRecords（历史投票数据）
- **用户数据**: 作者、投票者、贡献者信息
- **修订历史**: 页面编辑记录
- **贡献记录**: 页面归属信息
- **备用标题**: 多语言标题支持

## 分析功能

### 投票网络分析
- **"谁给我投票"分析**: 基于 fuzzyVoteRecords 分析特定作者的投票者
- **"我给谁投票"分析**: 分析特定用户的投票历史和偏好
- **双向投票关系**: 发现相互投票的用户对
- **投票网络统计**: 用户影响力、投票模式等综合分析

### 数据质量保证
- **删除页面检测**: 自动标记已删除页面，确保统计准确性
- **用户统计修正**: 正确处理已删除页面对用户评分的影响
- **数据完整性**: 多层级数据验证和错误恢复

## 文件结构说明

```
backend/
├── src/
│   ├── main.js                 # 主入口文件
│   ├── sync/
│   │   ├── production-sync.js  # 生产数据同步
│   │   ├── database-sync.js    # 数据库同步
│   │   └── schema-explorer.js  # Schema 探索
│   └── analyze/
│       └── vote-analyzer.js    # 投票分析器
├── production-data/            # 数据文件存储目录
├── production-checkpoints/     # 断点续传检查点
└── package.json
```

## 开发注意事项

### API 版本迁移
- 项目已从 CROM API v1 迁移至 v2
- 使用 `schema-explorer.js` 探索新的 API 结构
- 保持向后兼容性，支持增量迁移

### 性能优化
- 使用批量操作减少数据库查询
- 智能缓存机制减少重复 API 调用
- 分页查询处理大量数据

### 错误处理
- 区分 429（Rate Limit）和其他错误类型
- 实现指数退避重试策略
- 保存中间状态以支持错误恢复

### 数据一致性
- 使用事务确保数据完整性
- 实现乐观锁避免并发冲突
- 定期数据校验和修复

## 测试和验证

运行数据同步后，检查以下指标：
- 页面总数与预期是否一致
- 投票记录完整性（与页面投票数对比）
- 用户统计准确性（排除已删除页面）
- 错误日志和处理情况

## 监控和日志

系统提供详细的执行日志：
- 实时进度显示（进度条、速度、ETA）
- 错误分类和计数
- 性能统计（响应时间、批次处理速度）
- 数据质量报告