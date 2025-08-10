# SCPPER-CN BFF API 完整使用指南

## 概述

SCPPER-CN BFF (Backend For Frontend) 提供了一套完整的REST API接口，为前端应用提供SCP中文维基的数据服务。

### 基础信息
- **Base URL**: `http://localhost:3000` (开发环境)
- **API Version**: `1.0.0`
- **Content-Type**: `application/json`
- **字符编码**: `UTF-8`

## API响应格式

所有API响应都遵循统一的格式：

```json
{
  "success": true,
  "data": {
    // 实际数据内容
  },
  "meta": {
    "timestamp": 1704067200000,
    "version": "1.0.0", 
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "cached": true,
    "cacheKey": "pages:scp-173",
    "cacheTTL": 300
  }
}
```

### 错误响应格式
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Page not found",
    "details": {
      "identifier": "scp-999999"
    }
  },
  "meta": {
    "timestamp": 1704067200000,
    "version": "1.0.0",
    "requestId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

## 限流政策

### 限流规则
- **通用API**: 100次/分钟
- **搜索API**: 30次/分钟  
- **统计API**: 20次/分钟
- **重型操作**: 10次/分钟

### 限流响应
当超过限流阈值时，API返回HTTP 429状态码：

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests, please try again later."
  },
  "meta": {
    "timestamp": 1704067200000,
    "version": "1.0.0",
    "requestId": "rate-limit-error"
  }
}
```

### 限流响应头
- `X-RateLimit-Limit`: 限流阈值
- `X-RateLimit-Remaining`: 剩余请求数
- `X-RateLimit-Reset`: 重置时间戳
- `Retry-After`: 建议重试时间(秒)

## 认证与授权

目前API为只读服务，无需认证。未来版本可能会添加API Key认证。

## API端点详情

### 1. 根端点

#### GET /
获取API基础信息

**请求示例:**
```bash
curl http://localhost:3000/
```

**响应示例:**
```json
{
  "success": true,
  "data": {
    "message": "SCPPER-CN BFF API",
    "version": "1.0.0",
    "endpoints": {
      "pages": "/pages",
      "search": "/search",
      "stats": "/stats", 
      "users": "/users",
      "meta": "/meta"
    },
    "documentation": "https://docs.scpper.cn/api"
  }
}
```

### 2. 元数据端点

#### GET /meta/config
获取站点配置信息

**响应示例:**
```json
{
  "success": true,
  "data": {
    "siteName": "SCP中文维基",
    "version": "2.0.0", 
    "apiVersion": "1.0.0",
    "supportedCategories": ["scp", "goi", "story", "translation", "art"],
    "maxSearchResults": 100,
    "defaultPageSize": 20
  }
}
```

#### GET /meta/categories
获取页面分类列表

**响应示例:**
```json
{
  "success": true,
  "data": [
    { "id": "scp", "name": "SCP", "description": "SCP项目" },
    { "id": "goi", "name": "GOI格式", "description": "关注组织格式" },
    { "id": "story", "name": "故事", "description": "原创故事" },
    { "id": "translation", "name": "译文", "description": "翻译作品" },
    { "id": "art", "name": "艺术作品", "description": "艺术创作" }
  ]
}
```

#### GET /meta/tags
获取所有标签(待实现)

### 3. 页面端点

#### GET /pages
获取页面列表

**查询参数:**
- `page` (number): 页码，默认1
- `limit` (number): 每页数量，默认20，最大100
- `category` (string): 页面分类过滤
- `sort` (string): 排序方式(created, updated, rating)
- `order` (string): 排序顺序(asc, desc)

**请求示例:**
```bash
curl "http://localhost:3000/pages?page=1&limit=10&category=scp&sort=rating&order=desc"
```

**响应示例:**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 173,
        "identifier": "scp-173",
        "title": "雕像 - 最初之作",
        "category": "scp",
        "rating": 450,
        "created": "2008-07-19T00:00:00.000Z",
        "updated": "2023-12-01T12:00:00.000Z",
        "author": "Moto42",
        "tags": ["euclid", "艺术性", "敌意", "雕塑", "观察影响"]
      }
    ],
    "pagination": {
      "total": 7000,
      "page": 1,
      "limit": 10,
      "totalPages": 700,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

#### GET /pages/:identifier
获取页面详情

**路径参数:**
- `identifier` (string): 页面标识符(如"scp-173")

**请求示例:**
```bash
curl http://localhost:3000/pages/scp-173
```

**响应示例:**
```json
{
  "success": true,
  "data": {
    "id": 173,
    "identifier": "scp-173", 
    "title": "雕像 - 最初之作",
    "content": "项目编号：SCP-173...",
    "category": "scp",
    "rating": 450,
    "votes": 120,
    "created": "2008-07-19T00:00:00.000Z",
    "updated": "2023-12-01T12:00:00.000Z",
    "author": "Moto42",
    "contributors": ["User1", "User2"],
    "tags": ["euclid", "艺术性", "敌意", "雕塑", "观察影响"],
    "stats": {
      "wordCount": 1200,
      "readingTime": 5,
      "viewCount": 45000,
      "commentCount": 89
    }
  }
}
```

#### GET /pages/:identifier/versions
获取页面版本历史

**响应示例:**
```json
{
  "success": true,
  "data": [
    {
      "id": "v1.5.0",
      "created": "2023-12-01T12:00:00.000Z",
      "author": "User123",
      "comment": "修正语法错误",
      "changes": {
        "added": 15,
        "removed": 8,
        "modified": 3
      }
    }
  ]
}
```

#### GET /pages/:identifier/votes
获取页面投票记录

**响应示例:**
```json
{
  "success": true,
  "data": {
    "summary": {
      "totalVotes": 120,
      "upvotes": 85,
      "downvotes": 35,
      "rating": 50
    },
    "votes": [
      {
        "id": 1,
        "user": "VoterUser",
        "value": 1,
        "created": "2023-12-01T10:30:00.000Z"
      }
    ]
  }
}
```

#### GET /pages/:identifier/revisions
获取页面修订记录

#### GET /pages/:identifier/stats
获取页面统计信息

#### GET /pages/:identifier/voting-history
获取页面投票历史时间序列

**响应示例:**
```json
{
  "success": true,
  "data": {
    "identifier": "scp-173",
    "timeSeriesData": [
      {
        "date": "2023-12-01",
        "rating": 450,
        "votes": 120,
        "cumulativeRating": 450
      }
    ],
    "summary": {
      "currentRating": 450,
      "peakRating": 475,
      "peakDate": "2023-11-15",
      "trendDirection": "stable"
    }
  }
}
```

### 4. 搜索端点 (限流: 30次/分钟)

#### GET /search
全文搜索

**查询参数:**
- `q` (string, required): 搜索关键词
- `category` (string): 分类过滤
- `tags` (string): 标签过滤，逗号分隔
- `author` (string): 作者过滤
- `page` (number): 页码
- `limit` (number): 结果数量，最大100

**请求示例:**
```bash
curl "http://localhost:3000/search?q=雕像&category=scp&limit=5"
```

**响应示例:**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 173,
        "identifier": "scp-173",
        "title": "雕像 - 最初之作",
        "category": "scp",
        "rating": 450,
        "highlight": "...这个<em>雕像</em>由混凝土和钢筋制成...",
        "relevance": 0.95
      }
    ],
    "pagination": {
      "total": 25,
      "page": 1,
      "limit": 5,
      "totalPages": 5,
      "hasNext": true,
      "hasPrev": false
    },
    "facets": {
      "categories": {
        "scp": 20,
        "story": 3,
        "art": 2
      },
      "tags": {
        "euclid": 15,
        "艺术性": 8,
        "雕塑": 10
      }
    }
  }
}
```

#### GET /search/suggest
搜索建议

**查询参数:**
- `q` (string): 部分关键词

**响应示例:**
```json
{
  "success": true,
  "data": {
    "suggestions": [
      "雕像",
      "雕塑",
      "雕刻"
    ]
  }
}
```

#### GET /search/tags
按标签搜索

**查询参数:**
- `tags` (string, required): 标签列表，逗号分隔
- `operator` (string): 操作符(and, or)，默认and

#### GET /search/advanced
高级搜索

**查询参数:**
- `title` (string): 标题搜索
- `content` (string): 内容搜索  
- `author` (string): 作者搜索
- `dateFrom` (string): 开始日期(ISO格式)
- `dateTo` (string): 结束日期(ISO格式)
- `minRating` (number): 最低评分
- `maxRating` (number): 最高评分

### 5. 统计端点 (限流: 20次/分钟)

#### GET /stats/site
获取站点总体统计

**响应示例:**
```json
{
  "success": true,
  "data": {
    "totalPages": 7000,
    "totalUsers": 15000,
    "totalVotes": 250000,
    "averageRating": 45.6,
    "categoryCounts": {
      "scp": 6000,
      "story": 800,
      "art": 200
    },
    "recentActivity": {
      "newPagesThisWeek": 12,
      "newUsersThisWeek": 45,
      "votesThisWeek": 1200
    }
  }
}
```

#### GET /stats/series
获取系列统计

**响应示例:**
```json
{
  "success": true,
  "data": [
    {
      "seriesNumber": 1,
      "name": "SCP-001 到 SCP-999",
      "totalPages": 999,
      "completedPages": 856,
      "averageRating": 52.3,
      "topRatedPage": {
        "identifier": "scp-173",
        "title": "雕像 - 最初之作",
        "rating": 450
      }
    }
  ]
}
```

#### GET /stats/series/:number
获取特定系列详情

**路径参数:**
- `number` (number): 系列号(1, 2, 3, 4, 5, 6)

#### GET /stats/interesting
获取有趣统计

**响应示例:**
```json
{
  "success": true,
  "data": {
    "mostVotedPage": {
      "identifier": "scp-173",
      "title": "雕像 - 最初之作", 
      "votes": 450
    },
    "longestPage": {
      "identifier": "scp-3008",
      "title": "一个完全正常的宜家",
      "wordCount": 15000
    },
    "mostActiveAuthor": {
      "username": "DrClef",
      "pageCount": 89
    }
  }
}
```

#### GET /stats/trending
获取趋势统计

**响应示例:**
```json
{
  "success": true,
  "data": {
    "trendingPages": [
      {
        "identifier": "scp-6000",
        "title": "最新发现的异常",
        "ratingChange": "+45",
        "trend": "up"
      }
    ],
    "trendingTags": [
      {"name": "euclid", "count": 1500, "change": "+10%"},
      {"name": "keter", "count": 800, "change": "+5%"}
    ]
  }
}
```

#### GET /stats/leaderboard
获取排行榜

**响应示例:**
```json
{
  "success": true,
  "data": {
    "topRatedPages": [
      {
        "rank": 1,
        "identifier": "scp-173",
        "title": "雕像 - 最初之作",
        "rating": 450
      }
    ],
    "topAuthors": [
      {
        "rank": 1,
        "username": "DrClef", 
        "totalRating": 5000,
        "pageCount": 89
      }
    ]
  }
}
```

#### GET /stats/tags
获取标签统计

### 6. 用户端点

#### GET /users
获取用户列表

**查询参数:**
- `page` (number): 页码
- `limit` (number): 每页数量
- `sort` (string): 排序方式(joined, karma, pages)

**响应示例:**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 1,
        "username": "DrClef",
        "displayName": "Dr. Clef",
        "joined": "2008-05-01T00:00:00.000Z",
        "karma": 5000,
        "pageCount": 89,
        "avatar": "https://avatar.example.com/drclef.png"
      }
    ],
    "pagination": {
      "total": 15000,
      "page": 1,
      "limit": 20,
      "totalPages": 750,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

#### GET /users/:identifier
获取用户详情

**响应示例:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "username": "DrClef",
    "displayName": "Dr. Alto Clef",
    "joined": "2008-05-01T00:00:00.000Z",
    "lastActive": "2023-12-01T15:30:00.000Z",
    "karma": 5000,
    "biography": "资深研究员，专长异常物品收容...",
    "avatar": "https://avatar.example.com/drclef.png",
    "stats": {
      "totalPages": 89,
      "totalRating": 5000,
      "totalVotes": 1200,
      "averageRating": 56.2
    }
  }
}
```

#### GET /users/:identifier/stats
获取用户统计信息

#### GET /users/:identifier/attributions
获取用户贡献页面

**响应示例:**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "type": "author",
        "page": {
          "identifier": "scp-173",
          "title": "雕像 - 最初之作",
          "category": "scp", 
          "rating": 450
        },
        "contribution": "original_author",
        "date": "2008-07-19T00:00:00.000Z"
      }
    ]
  }
}
```

#### GET /users/:identifier/votes
获取用户投票记录

#### GET /users/:identifier/activity
获取用户活动记录

#### GET /users/:identifier/rating-history
获取用户评分历史时间序列

## 错误处理

### 常见错误码
- `VALIDATION_ERROR`: 请求参数验证失败
- `NOT_FOUND`: 资源不存在
- `RATE_LIMIT_EXCEEDED`: 超过限流阈值
- `INTERNAL_ERROR`: 服务器内部错误
- `SERVICE_UNAVAILABLE`: 服务暂时不可用

### 错误响应示例
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid query parameters",
    "details": {
      "field": "limit",
      "issue": "must be between 1 and 100"
    }
  }
}
```

## 缓存机制

### 缓存策略
- **页面详情**: 5分钟TTL
- **搜索结果**: 2分钟TTL  
- **统计数据**: 10分钟TTL
- **用户信息**: 5分钟TTL
- **热点数据**: 1分钟TTL

### 缓存头
API响应包含相关缓存信息：
- `meta.cached`: 是否来自缓存
- `meta.cacheKey`: 缓存键名
- `meta.cacheTTL`: 缓存剩余时间(秒)

## 最佳实践

### 1. 分页处理
```javascript
// 获取所有页面(分页处理)
async function getAllPages() {
  let allPages = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(`/pages?page=${page}&limit=50`);
    const data = await response.json();
    
    allPages.push(...data.data.items);
    hasMore = data.data.pagination.hasNext;
    page++;
    
    // 避免触发限流
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return allPages;
}
```

### 2. 错误处理
```javascript
async function handleApiCall(url) {
  try {
    const response = await fetch(url);
    
    if (response.status === 429) {
      // 处理限流
      const retryAfter = response.headers.get('retry-after');
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return handleApiCall(url); // 重试
    }
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(`API Error: ${data.error.code} - ${data.error.message}`);
    }
    
    return data.data;
  } catch (error) {
    console.error('API call failed:', error);
    throw error;
  }
}
```

### 3. 搜索优化
```javascript
// 带防抖的搜索
function createDebouncedSearch(delay = 300) {
  let timeoutId;
  
  return function(query) {
    clearTimeout(timeoutId);
    
    return new Promise((resolve) => {
      timeoutId = setTimeout(async () => {
        try {
          const results = await fetch(`/search?q=${encodeURIComponent(query)}`);
          resolve(await results.json());
        } catch (error) {
          resolve({ success: false, error });
        }
      }, delay);
    });
  };
}
```

### 4. 限流避免
```javascript
// 请求队列管理
class ApiQueue {
  constructor(maxConcurrent = 3, delayBetweenRequests = 100) {
    this.queue = [];
    this.running = 0;
    this.maxConcurrent = maxConcurrent;
    this.delay = delayBetweenRequests;
  }

  async add(apiCall) {
    return new Promise((resolve, reject) => {
      this.queue.push({ apiCall, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    this.running++;
    const { apiCall, resolve, reject } = this.queue.shift();

    try {
      const result = await apiCall();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.running--;
      setTimeout(() => this.process(), this.delay);
    }
  }
}
```