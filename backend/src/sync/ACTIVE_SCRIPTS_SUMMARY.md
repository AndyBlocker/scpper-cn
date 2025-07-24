# SCPPER-CN 活跃脚本总结

## 🌟 当前活跃的核心脚本

### 1. `database-sync.js` - 生产主力脚本
**状态**: ✅ 生产就绪  
**最后更新**: 2025-07-24 (基于revision检测)  
**核心功能**:
- 增量页面同步 (基于revisionCount检测变更)
- PostgreSQL数据库存储
- 页面历史版本管理 (不存储源代码内容)
- 删除页面检测和用户评分重计算
- 完整错误处理和日志系统

**运行命令**:
```bash
node src/sync/database-sync.js
```

**关键特性**:
- 内存占用: 中等 (~500MB-1GB)
- 处理速度: ~2 pages/second
- 支持断点续传: ✅
- 数据完整性: ✅
- 适合定时任务: ✅

---

### 2. `final-sync.js` - JSON备用脚本  
**状态**: ✅ 功能完整  
**用途**: 数据分析和研究  
**核心功能**:
- 完整数据拉取 (页面+投票+修订+用户信息)
- JSON格式数据存储
- 断点续传功能
- 详细进度报告和统计

**运行命令**:
```bash
node src/sync/final-sync.js  
```

**关键特性**:
- 内存占用: 高 (~2-4GB)
- 数据格式: JSON (便于分析)
- 完整度: 包含所有可用字段
- 适合研究: ✅

---

### 3. `full-data-pull.js` - 一次性拉取
**状态**: ✅ 稳定  
**用途**: 初始化部署或完整重建  
**核心功能**:
- 30,849页面完整数据获取
- 无断点续传 (一次性任务)
- 详细统计报告

**运行命令**:
```bash
node src/sync/full-data-pull.js
```

**适用场景**: 新环境初始化

---

### 4. `schema-explorer.js` - API探索工具
**状态**: ✅ 开发工具  
**用途**: 探索CROM GraphQL API结构  
**核心功能**:
- 分析可用字段和数据类型
- 生成API文档
- 开发调试辅助

**运行命令**:
```bash
node src/sync/schema-explorer.js
```

**适用场景**: API结构研究，新功能开发

---

### 5. `sqlite-test.js` - 数据库测试
**状态**: ✅ 测试工具  
**用途**: SQLite集成测试  
**核心功能**:
- 数据库操作验证
- 性能测试
- 功能完整性检查

**运行命令**:
```bash
node src/sync/sqlite-test.js
```

**适用场景**: 开发环境测试

## 📊 脚本使用优先级

### 生产环境推荐顺序
1. **`database-sync.js`** - 首选，适合定时同步
2. **`final-sync.js`** - 备选，适合数据分析需求
3. **`full-data-pull.js`** - 特殊情况，完整重建时使用

### 开发环境工具
1. **`schema-explorer.js`** - API结构研究
2. **`sqlite-test.js`** - 数据库功能测试

## 🔧 维护状态

### 活跃维护 ✅
- `database-sync.js` - 持续优化中
- `final-sync.js` - 稳定维护

### 稳定状态 ✅  
- `full-data-pull.js` - 功能完整，无需频繁更新
- `schema-explorer.js` - 工具类脚本，按需更新
- `sqlite-test.js` - 测试脚本，按需更新

### 已废弃 🗑️
- `archive/` 目录下的7个历史脚本
- 建议使用 `CLEANUP_SCRIPT.sh` 安全清理

## 🚀 部署建议

### 生产环境配置
```bash
# 1. 环境变量配置
export DATABASE_URL="postgresql://user:pass@localhost/scpper_cn"
export CROM_API_URL="https://apiv1.crom.avn.sh/graphql"
export TARGET_SITE_URL="http://scp-wiki-cn.wikidot.com"

# 2. 定时同步 (每日凌晨3点)
# crontab -e
# 0 3 * * * cd /path/to/scpper-cn/backend && node src/sync/database-sync.js

# 3. 监控日志
tail -f sync-logs/database-sync-$(date +%Y-%m-%d).log
```

### 开发环境配置
```bash
# 1. 使用JSON格式便于调试
node src/sync/final-sync.js

# 2. 数据分析
node src/analysis/user-analytics.js

# 3. API结构探索
node src/sync/schema-explorer.js
```

## 📈 性能指标

| 脚本 | 处理速度 | 内存峰值 | 磁盘占用 | 可靠性 |
|------|----------|----------|----------|--------|
| database-sync.js | 2 pages/sec | 1GB | 低 (数据库) | 高 |
| final-sync.js | 2 pages/sec | 4GB | 高 (JSON) | 高 |
| full-data-pull.js | 2 pages/sec | 4GB | 高 (JSON) | 中 |

## 🎯 未来规划

### 短期优化 (1-2周)
- [ ] 统一日志格式
- [ ] 添加健康检查接口
- [ ] 完善错误重试机制

### 中期发展 (1-2月)  
- [ ] 支持增量用户数据同步
- [ ] 添加实时监控面板
- [ ] 优化内存使用效率

### 长期目标 (3-6月)
- [ ] 微服务架构重构
- [ ] 分布式部署支持
- [ ] 机器学习数据分析