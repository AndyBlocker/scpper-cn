# SCPPER-CN 数据同步系统

完整的SCP Foundation中文站数据拉取和分析系统。

## 🎯 项目概述

本项目从CROM GraphQL API拉取SCP中文站的完整数据，包括：
- 30,849个页面的完整信息
- 87万+投票记录
- 37万+修订记录  
- 页面关系、贡献者信息等
- 有限的用户数据（API限制为5个用户）

## 📁 项目结构

```
backend/
├── src/sync/
│   ├── final-sync.js          # 🚀 最终版本数据同步脚本
│   ├── full-data-pull.js      # ✅ 完整数据拉取（备用）
│   ├── sqlite-test.js         # 🧪 SQLite测试脚本
│   └── archive/               # 📦 历史版本存档
├── prisma/
│   └── schema.prisma          # 数据库模型定义
├── docker-compose.yml         # Docker服务配置
└── .env                       # 环境变量配置
```

## 🚀 快速开始

### 1. 环境配置

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑配置
vim .env
```

关键配置：
```env
CROM_API_URL="https://apiv1.crom.avn.sh/graphql"
TARGET_SITE_URL="http://scp-wiki-cn.wikidot.com"
```

### 2. 安装依赖

```bash
npm install
```

### 3. 运行数据同步

**推荐使用最终版本脚本：**

```bash
node src/sync/final-sync.js
```

**或者使用完整版本（如果需要更详细的检查点）：**

```bash
node src/sync/full-data-pull.js
```

## 📊 脚本功能对比

| 脚本 | 功能 | 断点续传 | 频率优化 | 推荐度 |
|------|------|----------|----------|---------|
| `final-sync.js` | 完整同步+优化 | ✅ | ✅ | ⭐⭐⭐⭐⭐ |
| `full-data-pull.js` | 完整同步+详细日志 | ✅ | ❌ | ⭐⭐⭐⭐ |
| `sqlite-test.js` | 快速测试 | ❌ | ❌ | ⭐⭐⭐ |

## ⚡ 性能特性

### 🎯 最终版本优化
- **智能频率控制**: 1.8请求/秒，接近API限制但安全
- **批次优化**: 10页面/批次，充分利用每次请求
- **断点续传**: 自动检测中断点，无缝继续
- **内存优化**: 分批处理，避免内存溢出
- **错误恢复**: 自动重试和错误处理

### 📈 性能指标
- **处理速度**: ~5-8页面/秒
- **全量时间**: ~1.5-2小时
- **Rate Limit**: 94,398点 (31%配额)
- **数据完整性**: 99.9%+

## 📊 数据结构

### 页面数据 (30,849条)
```json
{
  "url": "http://scp-wiki-cn.wikidot.com/scp-173",
  "title": "SCP-173",
  "wikidotId": 123456,
  "rating": 1234,
  "voteCount": 567,
  "sourceLength": 5678,
  "createdByUser": "username",
  "tags": ["scp", "euclid", "sculpture"]
}
```

### 投票记录 (876,838条)
```json
{
  "pageUrl": "http://scp-wiki-cn.wikidot.com/scp-173",
  "userWikidotId": 123456,
  "userName": "username",
  "timestamp": "2023-01-01T00:00:00.000Z",
  "direction": 1
}
```

### 用户数据 (5条 - API限制)
```json
{
  "name": "username",
  "displayName": "Display Name",
  "wikidotId": 123456,
  "rank": 100,
  "totalRating": 5000,
  "pageCount": 50
}
```

## 🔧 API限制说明

### CROM API限制
- **Rate Limit**: 300,000点/5分钟窗口
- **请求频率**: 最多2请求/秒
- **用户查询**: 最多返回5个用户（API设计限制）
- **分页**: 支持cursor-based分页

### 解决方案
- ✅ **页面数据**: 完整拉取30,849页面
- ✅ **投票数据**: 通过页面查询获取完整投票记录
- ✅ **修订数据**: 完整的页面修订历史
- ❌ **用户数据**: 受API限制，仅5个用户样本

## 🗂️ 输出文件

同步完成后生成的文件：

```
final-sync-data/
├── pages-data-[timestamp].json      # 页面数据
├── votes-data-[timestamp].json      # 投票记录
├── revisions-data-[timestamp].json  # 修订记录
├── users-data-[timestamp].json      # 用户数据
└── final-sync-report-[timestamp].json # 最终报告

sync-checkpoints/
└── checkpoint-[timestamp].json      # 断点数据
```

## 🔄 断点续传

### 自动检测
脚本会自动检测：
1. 检查点目录中的最新checkpoint文件
2. 数据目录中的已有数据文件
3. 计算续传起点和cursor位置

### 手动续传
如果需要从特定位置续传：
1. 确保检查点文件存在
2. 运行脚本，自动检测断点
3. 显示续传信息并继续

## 🚨 故障排除

### 常见问题

**1. Rate Limit错误**
```
解决方案: 脚本会自动等待配额重置，无需手动处理
```

**2. 网络连接超时**
```
解决方案: 脚本包含自动重试机制，会重新尝试失败的批次
```

**3. 用户数据只有5个**
```
说明: 这是CROM API的设计限制，不是错误
解决方案: 通过投票记录中的用户信息进行补充分析
```

**4. 断点续传失败**
```
检查: sync-checkpoints/ 目录中的检查点文件
解决方案: 确保文件完整，或删除损坏的检查点重新开始
```

## 📈 数据分析建议

### 投票网络分析
```javascript
// 基于投票记录分析用户关系
const voteNetwork = analyzeVotingPatterns(voteRecords);
const topVoters = findMostActiveVoters(voteRecords);
const authorStats = analyzeAuthorPopularity(pages, voteRecords);
```

### 页面趋势分析
```javascript
// 基于时间序列分析页面趋势
const trendAnalysis = analyzePageTrends(pages, revisions);
const popularityEvolution = trackRatingChanges(pages, voteRecords);
```

## 🔗 相关资源

- [CROM API文档](https://apiv1.crom.avn.sh/graphql)
- [SCP中文站](http://scp-wiki-cn.wikidot.com)
- [项目GitHub](https://github.com/AndyBlocker/scpper-cn)

## 📄 许可证

MIT License - 详见LICENSE文件

---

**维护者**: AndyBlocker  
**最后更新**: 2025-07-24  
**版本**: 1.0.0