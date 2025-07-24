# SCPPER-CN 性能优化建议

## 📊 数据量分析
- 原始数据: 2-3GB JSON
- 内存占用: 4-5GB (包含Node.js运行时)
- 用户数: 27,499
- 页面数: 30,839
- 投票记录: 876,838

## 🎯 针对小型应用的最佳实践

### 方案1: 混合架构 (推荐)

**核心思路**: 热数据内存 + 冷数据数据库

```javascript
// 内存中保留热数据
const hotData = {
  topUsers: rankings.slice(0, 1000),     // 前1000用户
  userBasicInfo: Map,                    // 基础用户信息
  pageRatings: Map,                      // 页面评分
  socialGraph: Map                       // 核心社交关系
};

// 数据库存储完整数据
// SQLite/PostgreSQL存储投票历史、修订记录等
```

**优点**:
- 内存占用降至 500MB-1GB
- 90%查询仍然很快
- 支持复杂历史查询
- 易于扩展

### 方案2: 智能缓存 (适合现状)

```javascript
class SmartDataService {
  constructor() {
    this.cache = new LRU({ max: 10000 }); // 缓存1万个用户
    this.rankings = null;                  // 全量排行榜保留
    this.pageIndex = null;                 // 页面索引保留
  }
  
  async getUserProfile(userId) {
    // 先查缓存
    if (this.cache.has(userId)) {
      return this.cache.get(userId);
    }
    
    // 按需从数据库加载
    const profile = await this.loadUserFromDB(userId);
    this.cache.set(userId, profile);
    return profile;
  }
}
```

### 方案3: 预计算 + 静态化

```javascript
// 定期生成静态数据文件
const staticData = {
  'rankings-top-100.json': topUsers,
  'user-network-graph.json': socialNetwork,
  'community-stats.json': overallStats
};

// API直接返回预计算结果
app.get('/api/rankings', (req, res) => {
  res.sendFile('rankings-top-100.json');
});
```

## 🚀 具体实施建议

### 阶段1: 优化当前方案 (1-2天)
1. **数据压缩**: 使用更紧凑的数据结构
2. **延迟加载**: 按需加载投票历史
3. **内存监控**: 添加内存使用监控

```javascript
// 压缩数据结构示例
const compactUser = {
  i: wikidotId,        // id
  n: name,            // name  
  s: score,           // score
  r: rank,            // rank
  a: isActive ? 1 : 0 // active
};
```

### 阶段2: 引入轻量数据库 (3-5天)
1. **SQLite**: 文件数据库，零配置
2. **索引优化**: 为常用查询建索引
3. **连接池**: 管理数据库连接

```sql
-- 关键索引
CREATE INDEX idx_user_score ON users(score DESC);
CREATE INDEX idx_vote_page_user ON votes(page_url, user_id);
CREATE INDEX idx_vote_timestamp ON votes(timestamp);
```

### 阶段3: 混合架构 (1周)
1. **热数据识别**: 分析查询模式
2. **缓存策略**: 实现智能缓存
3. **异步更新**: 后台更新缓存

## 📈 性能对比预测

| 方案 | 内存占用 | 查询延迟 | 启动时间 | 并发能力 |
|------|----------|----------|----------|----------|
| 全内存 | 4-5GB | <1ms | 30-60s | 中等 |
| 混合架构 | 1GB | 1-10ms | 5-10s | 高 |
| 纯数据库 | 200MB | 10-50ms | <5s | 很高 |

## 🎯 小型应用最佳配置

```javascript
// 推荐配置 (混合方案)
const config = {
  // 内存保留核心数据
  memoryCache: {
    topUsers: 1000,
    basicUserInfo: 'all',
    pageRatings: 'all',
    socialRelations: 'top-connections-only'
  },
  
  // 数据库存储详细数据
  database: {
    type: 'sqlite',
    file: './data/scpper.db',
    connectionPool: 5
  },
  
  // 缓存策略
  cache: {
    userProfiles: { ttl: '1h', max: 1000 },
    searchResults: { ttl: '10m', max: 100 },
    analytics: { ttl: '24h', max: 50 }
  }
};
```

## 🔧 实施优先级

### 高优先级 (立即实施)
1. ✅ **数据结构优化**: 减少内存占用30-50%
2. ✅ **查询缓存**: 避免重复计算
3. ✅ **内存监控**: 防止内存泄漏

### 中优先级 (有时间时)
1. 🔄 **SQLite集成**: 渐进式数据库化
2. 🔄 **智能预加载**: 预测用户查询
3. 🔄 **压缩存储**: 使用更高效格式

### 低优先级 (用户增长后)
1. ⏳ **分布式缓存**: Redis集群
2. ⏳ **微服务拆分**: 按功能拆分服务
3. ⏳ **CDN加速**: 静态资源CDN

## 💰 成本效益分析

| 方案 | 开发成本 | 运维成本 | 性能收益 | 推荐指数 |
|------|----------|----------|----------|----------|
| 数据结构优化 | 低 | 无 | 中等 | ⭐⭐⭐⭐⭐ |
| SQLite混合 | 中等 | 低 | 高 | ⭐⭐⭐⭐ |
| PostgreSQL | 高 | 中等 | 很高 | ⭐⭐⭐ |

## 结论

**对于当前规模的SCPPER-CN应用，建议:**

1. **短期**: 优化数据结构，降低内存占用
2. **中期**: 引入SQLite作为混合架构
3. **长期**: 根据用户增长情况考虑更复杂方案

**关键指标监控:**
- 内存使用率 < 80%
- 查询响应时间 < 100ms  
- 启动时间 < 30s
- 并发处理能力 > 100 QPS