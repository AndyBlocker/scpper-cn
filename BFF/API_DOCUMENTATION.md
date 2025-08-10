# SCPPER-CN BFF API 完整文档

## 📋 概述

SCPPER-CN BFF (Backend For Frontend) 是一个专为 SCP 中文维基前端设计的API服务层，提供页面、用户、搜索和统计数据的统一访问接口。

### 基本信息
- **版本**: v1.0.0
- **基础URL**: `http://localhost:4396` (开发环境) / `https://scpper.mer.run/api` (生产环境)
- **数据格式**: JSON
- **字符编码**: UTF-8
- **缓存策略**: Redis分布式缓存 + 内存降级
- **限流**: 分层限流（通用100次/分钟，搜索30次/分钟）
- **安全**: Helmet安全头 + CORS跨域保护

### 路径映射
- 生产环境：`https://scpper.mer.run/api/*` → BFF服务:4396
- 开发环境：`http://localhost:4396/*`
- 负载均衡：Nginx反向代理 + PM2集群模式

---

## 🌐 通用响应格式

### 成功响应
```json
{
  "success": true,
  "data": {
    // 具体数据内容
  },
  "meta": {
    "timestamp": 1754741612573,
    "version": "1.0.0",
    "requestId": "b3e0dec2-e5cf-44e8-8b2d-42ca67019c95"
  }
}
```

### 错误响应
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "User not found"
  },
  "meta": {
    "timestamp": 1754741612573,
    "version": "1.0.0",
    "requestId": "b3e0dec2-e5cf-44e8-8b2d-42ca67019c95"
  }
}
```

### 分页响应
```json
{
  "pagination": {
    "total": 27510,
    "page": 1,
    "limit": 20,
    "totalPages": 1376,
    "hasNext": true,
    "hasPrev": false
  }
}
```

---

## 👥 用户相关端点

### 1. 获取用户列表
**GET** `/users`

#### 请求参数
| 参数 | 类型 | 默认值 | 描述 |
|-----|-----|-------|-----|
| page | integer | 1 | 页码 |
| limit | integer | 20 | 每页数量 (1-100) |
| sort | string | karma | 排序方式：karma/contributions/latest |

#### 响应示例
```json
{
  "success": true,
  "data": {
    "users": [
      {
        "id": 2534,
        "displayName": "ashausesall",
        "wikidotId": 1546989,
        "firstActivityAt": "2013-08-18T00:00:00.000Z",
        "lastActivityAt": "2025-08-09T02:30:59.000Z",
        "stats": {
          "totalUp": 91,
          "totalDown": 53,
          "totalRating": 15337,
          "pageCount": 1119,
          "overallRating": 15337,
          "overallRank": 3,
          "scpPageCount": 10,
          "scpRating": 1350,
          "scpRank": 49,
          "goiPageCount": 0,
          "goiRating": 0,
          "goiRank": null,
          "storyPageCount": 3,
          "storyRating": 1649,
          "storyRank": 28,
          "translationPageCount": 1105,
          "translationRating": 12246,
          "translationRank": 2,
          "artPageCount": 0,
          "artRating": 0,
          "artRank": null,
          "wanderersPageCount": 0,
          "wanderersRating": 0,
          "wanderersRank": null,
          "favTag": "scp",
          "ratingUpdatedAt": "2025-08-09T06:38:06.402Z"
        },
        "contributionCount": 1122
      }
    ],
    "pagination": {
      "total": 27510,
      "page": 1,
      "limit": 20,
      "totalPages": 1376,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### 2. 获取用户详情
**GET** `/users/{identifier}`

#### 路径参数
| 参数 | 类型 | 描述 |
|-----|-----|-----|
| identifier | string | 用户ID、wikidotId或displayName |

#### 响应示例
```json
{
  "success": true,
  "data": {
    "id": 7,
    "displayName": "M Element",
    "wikidotId": 2941964,
    "firstActivityAt": "2017-02-01T19:11:26.000Z",
    "lastActivityAt": "2022-11-12T13:46:21.000Z",
    "stats": {
      "totalUp": 368,
      "totalDown": 99,
      "totalRating": 12097,
      "pageCount": 1423,
      "overallRating": 12097,
      "overallRank": 10,
      "scpPageCount": 18,
      "scpRating": 574,
      "scpRank": 113,
      "goiPageCount": 0,
      "goiRating": 0,
      "goiRank": null,
      "storyPageCount": 1,
      "storyRating": 16,
      "storyRank": 767,
      "translationPageCount": 1351,
      "translationRating": 10634,
      "translationRank": 3,
      "artPageCount": 0,
      "artRating": 0,
      "artRank": null,
      "wanderersPageCount": 2,
      "wanderersRating": 2,
      "wanderersRank": 405,
      "favTag": "原创",
      "ratingUpdatedAt": "2025-08-09T06:38:06.402Z"
    },
    "contributionCount": 1446
  }
}
```

### 3. 获取用户统计详情
**GET** `/users/{identifier}/stats`

#### 响应示例
```json
{
  "success": true,
  "data": {
    "user": {
      // 用户基本信息（同上）
    },
    "recentActivity": [
      {
        "type": "revision",
        "date": "2025-08-09T02:30:59.000Z",
        "pageTitle": "SCP-8252",
        "pageUrl": "http://scp-wiki-cn.wikidot.com/scp-8252"
      },
      {
        "type": "vote",
        "date": "2025-08-08T14:29:56.000Z",
        "pageTitle": "SCP-1229",
        "pageUrl": "http://scp-wiki-cn.wikidot.com/scp-1229",
        "voteDirection": 1
      }
    ],
    "contributionHistory": [
      {
        "type": "SCP",
        "count": 10,
        "rating": 1350,
        "rank": 49
      },
      {
        "type": "故事",
        "count": 3,
        "rating": 1649,
        "rank": 28
      },
      {
        "type": "翻译",
        "count": 1105,
        "rating": 12246,
        "rank": 2
      }
    ],
    "tagPreferences": [
      {
        "tag": "scp",
        "upvoteCount": 69,
        "downvoteCount": 48,
        "totalVotes": 117
      }
    ]
  }
}
```

### 4. 获取用户贡献记录
**GET** `/users/{identifier}/attributions`

#### 请求参数
| 参数 | 类型 | 默认值 | 描述 |
|-----|-----|-------|-----|
| page | integer | 1 | 页码 |
| limit | integer | 20 | 每页数量 |

#### 响应示例
```json
{
  "success": true,
  "data": {
    "attributions": [
      {
        "id": 123456,
        "type": "SUBMITTER",
        "order": 0,
        "date": "2025-08-09T02:30:59.000Z",
        "page": {
          "id": 14155,
          "url": "http://scp-wiki-cn.wikidot.com/scp-173",
          "title": "SCP-173",
          "rating": 1926
        }
      }
    ],
    "pagination": {
      "total": 1122,
      "page": 1,
      "limit": 20,
      "totalPages": 57,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### 5. 获取用户投票记录
**GET** `/users/{identifier}/votes`

#### 请求参数
| 参数 | 类型 | 默认值 | 描述 |
|-----|-----|-------|-----|
| page | integer | 1 | 页码 |
| limit | integer | 20 | 每页数量 |

#### 响应示例
```json
{
  "success": true,
  "data": {
    "votes": [
      {
        "id": 4933786,
        "timestamp": "2025-08-08T00:00:00.000Z",
        "direction": 1,
        "page": {
          "id": 14155,
          "url": "http://scp-wiki-cn.wikidot.com/scp-173",
          "title": "SCP-173",
          "rating": 1926
        }
      }
    ],
    "pagination": {
      "total": 5420,
      "page": 1,
      "limit": 20,
      "totalPages": 271,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### 6. 获取用户活动记录
**GET** `/users/{identifier}/activity`

#### 请求参数
| 参数 | 类型 | 默认值 | 描述 |
|-----|-----|-------|-----|
| page | integer | 1 | 页码 |
| limit | integer | 20 | 每页数量 |

#### 响应示例
```json
{
  "success": true,
  "data": {
    "activities": [
      {
        "type": "vote",
        "timestamp": "2025-08-09T02:30:59.000Z",
        "details": {
          "direction": 1,
          "voteId": 4933786
        },
        "page": {
          "id": 14155,
          "url": "http://scp-wiki-cn.wikidot.com/scp-173",
          "title": "SCP-173",
          "rating": 1926
        }
      },
      {
        "type": "revision",
        "timestamp": "2025-08-08T14:29:56.000Z",
        "details": {
          "type": "SOURCE_CHANGED",
          "comment": "修复图片链接",
          "wikidotId": 1460091856
        },
        "page": {
          "id": 14155,
          "url": "http://scp-wiki-cn.wikidot.com/scp-173",
          "title": "SCP-173",
          "rating": 1926
        }
      },
      {
        "type": "attribution",
        "timestamp": "2025-08-07T14:50:30.000Z",
        "details": {
          "attributionType": "SUBMITTER",
          "order": 0
        },
        "page": {
          "id": 16789,
          "url": "http://scp-wiki-cn.wikidot.com/scp-8393",
          "title": "SCP-8393",
          "rating": 45
        }
      }
    ],
    "pagination": {
      "total": 15670,
      "page": 1,
      "limit": 20,
      "totalPages": 784,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

---

## 📄 页面相关端点

### 1. 获取页面列表
**GET** `/pages`

#### 请求参数
| 参数 | 类型 | 默认值 | 描述 |
|-----|-----|-------|-----|
| page | integer | 1 | 页码 |
| limit | integer | 20 | 每页数量 |
| tags | string | - | 标签过滤，逗号分隔 |
| category | string | - | 分类过滤：scp/goi/story/translation |
| sort | string | rating | 排序方式：rating/date/votes |

### 2. 获取页面详情
**GET** `/pages/{identifier}`

#### 路径参数
| 参数 | 类型 | 描述 |
|-----|-----|-----|
| identifier | string | 页面URL、urlKey或pageUuid |

#### 响应示例
```json
{
  "success": true,
  "data": {
    "page": {
      "id": 14155,
      "url": "http://scp-wiki-cn.wikidot.com/scp-173",
      "pageUuid": "a393ba8e-fb74-4b15-8a85-fea9ea1c2d90",
      "urlKey": "scp-173",
      "historicalUrls": [],
      "firstPublishedAt": "2014-11-29T02:12:06.000Z"
    },
    "currentVersion": {
      "id": 14155,
      "title": "SCP-173",
      "rating": 1926,
      "voteCount": 1950,
      "revisionCount": 59,
      "tags": ["euclid", "scp", "敌意", "自主", "观察影响", "雕像-最初之作", "雕塑", "crom:series-1"],
      "isDeleted": false,
      "createdAt": "2025-07-31T18:24:09.573Z",
      "updatedAt": "2025-08-08T17:55:11.236Z"
    },
    "stats": {
      "wilson95": 0.9880090590312575,
      "controversy": 0.05078138718631601,
      "likeRatio": 0.9928352098259979,
      "upvotes": 1940,
      "downvotes": 13
    },
    "attributions": [
      {
        "type": "SUBMITTER",
        "order": 0,
        "user": {
          "id": 2534,
          "displayName": "ashausesall",
          "wikidotId": 1546989
        },
        "date": "2014-11-29T02:12:06.000Z"
      }
    ],
    "recentRevisions": [
      {
        "id": 309923,
        "wikidotId": 1460091856,
        "timestamp": "2022-04-13T04:21:08.000Z",
        "type": "SOURCE_CHANGED",
        "comment": null,
        "user": {
          "displayName": "M Element",
          "wikidotId": 2941964
        }
      }
    ],
    "recentVotes": [
      {
        "id": 4933786,
        "timestamp": "2025-08-08T00:00:00.000Z",
        "direction": 1,
        "user": {
          "displayName": "USER_0",
          "wikidotId": 5814081
        }
      }
    ],
    "relatedPages": [
      {
        "id": 16669,
        "url": "http://scp-wiki-cn.wikidot.com/scp-3693",
        "title": "SCP-3693",
        "rating": 13,
        "common_tags": 6
      }
    ]
  }
}
```

### 3. 获取页面投票详情
**GET** `/pages/{identifier}/votes`

#### 请求参数
| 参数 | 类型 | 默认值 | 描述 |
|-----|-----|-------|-----|
| page | integer | 1 | 页码 |
| limit | integer | 20 | 每页数量 |
| direction | integer | - | 投票方向过滤：1(赞成)/-1(反对) |

#### 响应示例
```json
{
  "success": true,
  "data": {
    "votes": [
      {
        "id": 4933786,
        "timestamp": "2025-08-08T00:00:00.000Z",
        "direction": 1,
        "user": {
          "id": 1051145,
          "displayName": "USER_0",
          "wikidotId": 5814081
        },
        "anonKey": null
      }
    ],
    "pagination": {
      "total": 1956,
      "page": 1,
      "limit": 20,
      "totalPages": 98,
      "hasNext": true,
      "hasPrev": false
    },
    "summary": {
      "totalVotes": 1956,
      "upvotes": 1943,
      "downvotes": 13
    }
  }
}
```

### 4. 获取页面修订历史
**GET** `/pages/{identifier}/revisions`

#### 请求参数
| 参数 | 类型 | 默认值 | 描述 |
|-----|-----|-------|-----|
| page | integer | 1 | 页码 |
| limit | integer | 20 | 每页数量 |
| type | string | - | 修订类型过滤 |

#### 响应示例
```json
{
  "success": true,
  "data": {
    "revisions": [
      {
        "id": 309923,
        "wikidotId": 1460091856,
        "timestamp": "2022-04-13T04:21:08.000Z",
        "type": "SOURCE_CHANGED",
        "comment": null,
        "user": {
          "id": 7,
          "displayName": "M Element",
          "wikidotId": 2941964
        }
      }
    ],
    "pagination": {
      "total": 60,
      "page": 1,
      "limit": 20,
      "totalPages": 3,
      "hasNext": true,
      "hasPrev": false
    },
    "summary": {
      "totalRevisions": 60,
      "revisionTypes": [
        {
          "type": "SOURCE_CHANGED",
          "count": 51
        },
        {
          "type": "TAGS_CHANGED",
          "count": 5
        },
        {
          "type": "TITLE_CHANGED",
          "count": 3
        },
        {
          "type": "PAGE_CREATED",
          "count": 1
        }
      ]
    }
  }
}
```

### 5. 获取页面版本历史
**GET** `/pages/{identifier}/versions`

#### 请求参数
| 参数 | 类型 | 默认值 | 描述 |
|-----|-----|-------|-----|
| page | integer | 1 | 页码 |
| limit | integer | 20 | 每页数量 |

#### 响应示例
```json
{
  "success": true,
  "data": {
    "versions": [
      {
        "id": 14155,
        "wikidotId": 1234567,
        "title": "SCP-173",
        "rating": 1926,
        "voteCount": 1950,
        "revisionCount": 59,
        "tags": ["euclid", "scp", "敌意"],
        "validFrom": "2025-07-31T18:24:09.573Z",
        "validTo": null,
        "isDeleted": false,
        "isCurrent": true,
        "stats": {
          "wilson95": 0.988,
          "controversy": 0.051,
          "likeRatio": 0.993,
          "upvotes": 1940,
          "downvotes": 13
        },
        "attributions": [
          {
            "type": "SUBMITTER",
            "order": 0,
            "user": {
              "id": 2534,
              "displayName": "ashausesall",
              "wikidotId": 1546989
            },
            "date": "2014-11-29T02:12:06.000Z"
          }
        ]
      }
    ],
    "pagination": {
      "total": 5,
      "page": 1,
      "limit": 20,
      "totalPages": 1,
      "hasNext": false,
      "hasPrev": false
    }
  }
}
```

### 6. 获取页面统计信息
**GET** `/pages/{identifier}/stats`

---

## 🔍 搜索相关端点

### 1. 全文搜索
**GET** `/search`

#### 请求参数
| 参数 | 类型 | 默认值 | 描述 |
|-----|-----|-------|-----|
| q | string | - | 搜索关键词 |
| tags | string | - | 标签过滤，逗号分隔 |
| category | string | - | 分类过滤 |
| sort | string | relevance | 排序：relevance/rating/date |
| page | integer | 1 | 页码 |
| limit | integer | 20 | 每页数量 |

#### 响应示例
```json
{
  "success": true,
  "data": {
    "results": [
      {
        "pageId": 14155,
        "url": "http://scp-wiki-cn.wikidot.com/scp-173",
        "urlKey": "scp-173",
        "title": "SCP-173",
        "rating": 1926,
        "voteCount": 1950,
        "tags": ["euclid", "scp", "敌意"],
        "content": "SCP-173是一个由混凝土和钢筋构成的雕塑...",
        "score": 0.896
      }
    ],
    "total": 1247,
    "query": "雕塑",
    "filters": {
      "tags": ["scp"],
      "category": null
    },
    "suggestions": ["雕像", "混凝土", "艺术作品"],
    "pagination": {
      "limit": 20,
      "offset": 0,
      "hasMore": true,
      "totalPages": 63
    }
  }
}
```

### 2. 搜索建议
**GET** `/search/suggest`

### 3. 标签搜索
**GET** `/search/tags`

### 4. 高级搜索
**GET** `/search/advanced`

---

## 📊 统计相关端点

### 1. 站点统计
**GET** `/stats/site`

#### 响应示例
```json
{
  "success": true,
  "data": {
    "current": {
      "totalUsers": 27510,
      "activeUsers": 25420,
      "totalPages": 31179,
      "totalVotes": 920227,
      "lastUpdated": "2025-08-09T12:00:00.000Z"
    },
    "recent": {
      "newUsersToday": 15,
      "newPagesToday": 8,
      "newVotesToday": 1247
    },
    "categories": [
      {
        "name": "Translation",
        "pageCount": 18567,
        "avgRating": 45.2,
        "totalVotes": 456789,
        "maxRating": 2845,
        "minRating": -156
      },
      {
        "name": "SCP",
        "pageCount": 8932,
        "avgRating": 78.5,
        "totalVotes": 312456,
        "maxRating": 1926,
        "minRating": -89
      }
    ],
    "topTags": [
      {
        "tag": "scp",
        "count": 8932
      },
      {
        "tag": "原创",
        "count": 7654
      }
    ],
    "ratingDistribution": {
      "ranges": [
        { "min": -100, "max": 0, "count": 1245 },
        { "min": 0, "max": 50, "count": 15672 },
        { "min": 50, "max": 100, "count": 8934 },
        { "min": 100, "max": 500, "count": 4521 },
        { "min": 500, "max": 1000, "count": 567 },
        { "min": 1000, "max": 9999, "count": 89 }
      ]
    },
    "topContributors": [
      {
        "user": {
          "id": 2534,
          "displayName": "ashausesall",
          "wikidotId": 1546989
        },
        "contributionCount": 1119
      }
    ]
  }
}
```

### 2. 系列统计
**GET** `/stats/series`

### 3. 特定系列详情
**GET** `/stats/series/{number}`

### 4. 有趣统计
**GET** `/stats/interesting`

#### 响应示例
```json
{
  "success": true,
  "data": {
    "timeMilestones": [
      {
        "type": "FIRST_PAGE_OF_YEAR",
        "year": 2025,
        "pageTitle": "SCP-8000",
        "pageId": 12345,
        "achievedAt": "2025-01-01T00:15:23.000Z"
      }
    ],
    "tagRecords": [
      {
        "tag": "scp",
        "recordType": "HIGHEST_RATED",
        "pageTitle": "SCP-173",
        "value": 1926,
        "achievedAt": "2025-08-08T00:00:00.000Z"
      }
    ],
    "contentRecords": [
      {
        "recordType": "LONGEST_PAGE",
        "pageTitle": "安德森机器人员工手册",
        "sourceLength": 45678,
        "contentLength": 89123
      }
    ],
    "ratingRecords": [
      {
        "recordType": "HIGHEST_RATED_SCP",
        "pageTitle": "SCP-173",
        "rating": 1926,
        "voteCount": 1950
      }
    ],
    "userActivityRecords": [
      {
        "recordType": "MOST_CONTRIBUTIONS",
        "userDisplayName": "ashausesall",
        "value": 1119,
        "achievedAt": "2025-08-09T06:38:06.402Z"
      }
    ],
    "trendingStats": [
      {
        "statType": "HOT_PAGE",
        "name": "SCP-8252",
        "entityId": 16789,
        "entityType": "page",
        "score": 98.5,
        "period": "daily"
      }
    ]
  }
}
```

### 5. 趋势统计
**GET** `/stats/trending`

### 6. 排行榜
**GET** `/stats/leaderboard`

### 7. 标签统计
**GET** `/stats/tags`

---

## 🏷️ 元数据端点

### 1. 获取所有标签
**GET** `/meta/tags`

### 2. 获取分类信息
**GET** `/meta/categories`

#### 响应示例
```json
{
  "success": true,
  "data": [
    {
      "id": "scp",
      "name": "SCP",
      "description": "SCP项目"
    },
    {
      "id": "goi",
      "name": "GOI格式",
      "description": "关注组织格式"
    },
    {
      "id": "story",
      "name": "故事",
      "description": "原创故事"
    },
    {
      "id": "translation",
      "name": "译文",
      "description": "翻译作品"
    },
    {
      "id": "art",
      "name": "艺术作品",
      "description": "艺术创作"
    }
  ]
}
```

### 3. 获取站点配置
**GET** `/meta/config`

#### 响应示例
```json
{
  "success": true,
  "data": {
    "siteName": "SCP中文维基",
    "version": "2.0.0",
    "apiVersion": "v1",
    "supportedCategories": ["scp", "goi", "story", "translation", "art"],
    "maxSearchResults": 100,
    "defaultPageSize": 20
  }
}
```

---

## 🏠 核心端点

### 1. API信息
**GET** `/`

#### 响应示例
```json
{
  "success": true,
  "data": {
    "message": "SCPPER-CN BFF API",
    "version": "v1",
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

### 2. 健康检查
**GET** `/health`

检查服务和依赖的健康状态，包括数据库连接和Redis状态。

#### 响应示例
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "timestamp": "2025-08-09T12:00:00.000Z",
    "uptime": 86400,
    "environment": "production",
    "services": {
      "database": true,
      "redis": true
    }
  }
}
```

### 3. 就绪检查
**GET** `/ready`

检查服务是否准备好接受请求。包含缓存状态信息。

#### 响应示例
```json
{
  "success": true,
  "data": {
    "status": "ready",
    "redis": "connected",
    "cache": {
      "type": "redis",
      "status": "healthy",
      "hitRate": 0.85,
      "totalHits": 12456,
      "totalMisses": 2345
    }
  }
}
```

### 4. 版本信息  
**GET** `/version`

获取服务版本和构建信息。

#### 响应示例
```json
{
  "success": true,
  "data": {
    "version": "1.0.0",
    "buildDate": "2025-08-09T12:00:00.000Z",
    "nodeVersion": "v20.15.0",
    "environment": "production"
  }
}
```

### 5. 监控指标
**GET** `/metrics`

返回Prometheus格式的监控指标。

#### 响应格式
```text
# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",status="200"} 12456
# HELP cache_hits_total Total number of cache hits
# TYPE cache_hits_total counter
cache_hits_total{type="redis"} 8567
```

### 6. 缓存状态 (仅开发环境)
**GET** `/cache-status`

详细的缓存状态信息，仅在开发环境可用。

#### 响应示例
```json
{
  "success": true,
  "data": {
    "type": "redis",
    "status": "healthy", 
    "hitRate": 0.85,
    "totalHits": 12456,
    "totalMisses": 2345,
    "cacheSize": 1024000,
    "uptime": 86400
  }
}
```

---

## ⚡ 性能特性

### 缓存策略
| 端点类型 | TTL | 描述 |
|---------|-----|-----|
| 热点数据 | 60秒 | 实时投票、活动 |
| 搜索结果 | 5分钟 | 搜索查询结果 |
| 页面详情 | 15分钟 | 页面基本信息 |
| 用户资料 | 30分钟 | 用户基本信息 |
| 页面统计 | 1小时 | 页面统计数据 |
| 用户统计 | 2小时 | 用户统计数据 |
| 站点统计 | 6小时 | 全站统计数据 |
| 系列统计 | 12小时 | 系列统计数据 |

### 限流规则
- **通用API**: 100请求/分钟
- **搜索API**: 30请求/分钟  
- **重型API**: 10请求/分钟

### 响应头
```http
X-Cache-Hit: true/false
X-Cache-Key: page:scp-173
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1754741672
```

---

## 🚨 错误代码

| 状态码 | 错误代码 | 描述 |
|-------|---------|-----|
| 400 | VALIDATION_ERROR | 请求参数验证失败 |
| 404 | NOT_FOUND | 资源不存在 |
| 429 | RATE_LIMIT_EXCEEDED | 请求频率超限 |
| 500 | INTERNAL_ERROR | 服务器内部错误 |
| 503 | SERVICE_UNAVAILABLE | 服务不可用 |

### 错误响应示例
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Page not found",
    "details": {
      "identifier": "scp-999999",
      "searchedFields": ["url", "urlKey", "pageUuid"]
    }
  },
  "meta": {
    "timestamp": 1754741612573,
    "version": "1.0.0",
    "requestId": "error-request-uuid"
  }
}
```

---

## 🏗️ 技术架构

### 技术栈
- **运行时**: Node.js 20.x + ESM模块
- **框架**: Express.js + TypeScript
- **数据库**: PostgreSQL + Prisma ORM
- **缓存**: Redis + ioredis (支持降级到内存缓存)
- **验证**: Zod参数验证
- **日志**: Winston + 日志轮转
- **监控**: Prometheus监控指标
- **部署**: PM2集群 + Nginx反向代理
- **安全**: Helmet安全头 + CORS + 限流

### 数据流
```
Frontend → Nginx → PM2 Cluster → BFF Service → Redis Cache (可选)
                                           ↓
                                      PostgreSQL Database
                                           ↑
                                    Memory Cache (降级)
```

### 缓存架构
1. **主缓存**: Redis分布式缓存 (优先使用)
2. **降级缓存**: 内存缓存 (Redis不可用时自动切换)
3. **缓存键**: 结构化命名 + 分层TTL策略
4. **失效机制**: TTL自动过期 + 手动清理
5. **健康检查**: `/health`、`/ready`端点监控缓存状态

---

## 🎯 数据统计概览

基于当前数据库的真实统计：

- **总用户数**: 27,510 (活跃用户 27,510)
- **总页面数**: 31,179
- **总投票数**: 920,227
- **最高评分页面**: SCP-173 (1,926分)
- **最多贡献用户**: ashausesall (1,119个贡献)
- **最长标题**: 82个字符

### 顶级贡献者
1. **M Element**: 1,423个贡献 (wikidotId: 2941964)
2. **ashausesall**: 1,119个贡献 (wikidotId: 1546989)  
3. **Re_spectators**: (wikidotId: 3722555)

### 热门页面
1. **SCP-173**: 1,926分, 1,956票
2. **SCP-CN-2000**: 3,833分 (Re_spectators)
3. **SCP-CN-963-J**: 3,863分 (qipajun & fuban合作)