# SCPPER-CN BFF层设计文档

## 1. 系统架构概述

### 1.1 架构图
```
┌─────────────────┐
│    Frontend     │
└────────┬────────┘
         │ HTTPS
         ▼
┌─────────────────┐
│  Nginx Proxy    │ (scpper.mer.run/api/* → localhost:4396/*)
└────────┬────────┘
         │ HTTP
         ▼
┌─────────────────┐
│   BFF Service   │ (localhost:4396)
│   (Express.js)  │
└────┬──────┬─────┘
     │      │
     ▼      ▼
┌────────┐ ┌──────────┐
│ Redis  │ │PostgreSQL│
│ Cache  │ │  + Prisma│
└────────┘ └──────────┘
```

### 1.2 技术栈
- **运行时**: Node.js 20.x (ES Module)
- **框架**: Express.js + TypeScript
- **数据库ORM**: Prisma Client
- **缓存**: Redis (ioredis)
- **验证**: Zod
- **日志**: Winston
- **监控**: Prometheus metrics
- **文档**: OpenAPI 3.0 (swagger)
- **进程管理**: PM2

## 2. 项目结构

```
bff/
├── src/
│   ├── app.ts                      # Express应用初始化
│   ├── server.ts                   # 服务器启动入口
│   ├── config/
│   │   ├── index.ts               # 配置管理
│   │   ├── redis.ts               # Redis配置
│   │   └── database.ts            # 数据库配置
│   ├── controllers/
│   │   ├── page.controller.ts     # 页面控制器
│   │   ├── user.controller.ts     # 用户控制器
│   │   ├── search.controller.ts   # 搜索控制器
│   │   └── stats.controller.ts    # 统计控制器
│   ├── services/
│   │   ├── page.service.ts        # 页面业务逻辑
│   │   ├── user.service.ts        # 用户业务逻辑
│   │   ├── search.service.ts      # 搜索业务逻辑
│   │   ├── stats.service.ts       # 统计业务逻辑
│   │   └── cache.service.ts       # 缓存服务
│   ├── repositories/
│   │   ├── page.repository.ts     # 页面数据访问
│   │   ├── user.repository.ts     # 用户数据访问
│   │   └── stats.repository.ts    # 统计数据访问
│   ├── middleware/
│   │   ├── cache.middleware.ts    # 缓存中间件
│   │   ├── error.middleware.ts    # 错误处理
│   │   ├── logging.middleware.ts  # 日志记录
│   │   ├── rateLimit.middleware.ts# 限流
│   │   └── validation.middleware.ts# 请求验证
│   ├── utils/
│   │   ├── cache.ts              # 缓存工具
│   │   ├── logger.ts             # 日志工具
│   │   ├── metrics.ts            # 监控指标
│   │   └── response.ts           # 响应格式化
│   ├── types/
│   │   ├── api.ts                # API类型定义
│   │   ├── dto.ts                # 数据传输对象
│   │   └── cache.ts              # 缓存类型
│   └── routes/
│       ├── index.ts              # 路由注册
│       ├── page.routes.ts        # 页面路由
│       ├── user.routes.ts        # 用户路由
│       ├── search.routes.ts      # 搜索路由
│       └── stats.routes.ts       # 统计路由
├── prisma/
│   └── schema.prisma             # 从backend复制
├── tests/
├── .env                          # 环境变量
├── .env.example
├── tsconfig.json
├── package.json
├── ecosystem.config.js           # PM2配置
└── README.md
```

## 3. Redis缓存设计

### 3.1 缓存键命名规范
```typescript
// 缓存键前缀定义
const CACHE_PREFIXES = {
  PAGE: 'page:',
  PAGE_LIST: 'page_list:',
  PAGE_VERSION: 'page_ver:',
  USER: 'user:',
  USER_STATS: 'user_stats:',
  SEARCH: 'search:',
  STATS_SITE: 'stats:site:',
  STATS_SERIES: 'stats:series:',
  STATS_INTERESTING: 'stats:interesting:',
  LEADERBOARD: 'leaderboard:',
  TAG_CLOUD: 'tag_cloud:',
} as const;

// 缓存键生成函数
class CacheKeyBuilder {
  static pageDetail(identifier: string): string {
    return `${CACHE_PREFIXES.PAGE}${identifier}`;
  }
  
  static pageList(params: PageListParams): string {
    const hash = crypto.createHash('md5')
      .update(JSON.stringify(params))
      .digest('hex');
    return `${CACHE_PREFIXES.PAGE_LIST}${hash}`;
  }
  
  static userStats(userId: number): string {
    return `${CACHE_PREFIXES.USER_STATS}${userId}`;
  }
  
  static search(query: string, filters: any): string {
    const hash = crypto.createHash('md5')
      .update(JSON.stringify({ query, filters }))
      .digest('hex');
    return `${CACHE_PREFIXES.SEARCH}${hash}`;
  }
}
```

### 3.2 缓存策略配置
```typescript
interface CacheTTLConfig {
  // 短期缓存 (1-5分钟)
  HOT_DATA: 60;                    // 热点数据
  SEARCH_RESULTS: 300;             // 搜索结果
  
  // 中期缓存 (5-30分钟)
  PAGE_DETAIL: 900;                // 页面详情
  USER_PROFILE: 1800;              // 用户资料
  
  // 长期缓存 (1-24小时)
  PAGE_STATS: 3600;                // 页面统计
  USER_STATS: 7200;                // 用户统计
  SITE_STATS: 21600;               // 站点统计
  SERIES_STATS: 43200;             // 系列统计
  
  // 永久缓存 (手动失效)
  STATIC_CONFIG: 0;                // 静态配置
  TAG_METADATA: 0;                 // 标签元数据
}

const CACHE_TTL: CacheTTLConfig = {
  HOT_DATA: 60,
  SEARCH_RESULTS: 300,
  PAGE_DETAIL: 900,
  USER_PROFILE: 1800,
  PAGE_STATS: 3600,
  USER_STATS: 7200,
  SITE_STATS: 21600,
  SERIES_STATS: 43200,
  STATIC_CONFIG: 0,
  TAG_METADATA: 0,
};
```

### 3.3 缓存服务实现
```typescript
// src/services/cache.service.ts
import Redis from 'ioredis';
import { logger } from '../utils/logger';

export class CacheService {
  private redis: Redis;
  private defaultTTL: number = 300;

  constructor() {
    this.redis = new Redis({
      host: 'localhost',
      port: 6379,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('Cache get error:', error);
      return null;
    }
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttl && ttl > 0) {
        await this.redis.setex(key, ttl, serialized);
      } else {
        await this.redis.set(key, serialized);
      }
    } catch (error) {
      logger.error('Cache set error:', error);
    }
  }

  async del(pattern: string): Promise<void> {
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  async invalidate(patterns: string[]): Promise<void> {
    for (const pattern of patterns) {
      await this.del(pattern);
    }
  }

  // 缓存穿透保护
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttl: number = this.defaultTTL
  ): Promise<T> {
    let data = await this.get<T>(key);
    
    if (data === null) {
      // 使用分布式锁防止缓存击穿
      const lockKey = `lock:${key}`;
      const locked = await this.redis.set(lockKey, '1', 'NX', 'EX', 10);
      
      if (locked) {
        try {
          data = await factory();
          await this.set(key, data, ttl);
        } finally {
          await this.redis.del(lockKey);
        }
      } else {
        // 等待其他请求完成
        await new Promise(resolve => setTimeout(resolve, 100));
        return this.getOrSet(key, factory, ttl);
      }
    }
    
    return data;
  }

  // 批量获取
  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    const values = await this.redis.mget(keys);
    return values.map(v => v ? JSON.parse(v) : null);
  }

  // 批量设置
  async mset(items: Array<{ key: string; value: any; ttl?: number }>): Promise<void> {
    const pipeline = this.redis.pipeline();
    
    for (const item of items) {
      const serialized = JSON.stringify(item.value);
      if (item.ttl && item.ttl > 0) {
        pipeline.setex(item.key, item.ttl, serialized);
      } else {
        pipeline.set(item.key, serialized);
      }
    }
    
    await pipeline.exec();
  }
}
```

## 4. API接口设计

### 4.1 RESTful API路由规范
```typescript
// 基础路径: /api
const API_ROUTES = {
  // 页面相关
  'GET /pages': 'getPageList',
  'GET /pages/:identifier': 'getPageDetail',
  'GET /pages/:identifier/versions': 'getPageVersions',
  'GET /pages/:identifier/votes': 'getPageVotes',
  'GET /pages/:identifier/revisions': 'getPageRevisions',
  'GET /pages/:identifier/stats': 'getPageStats',
  
  // 用户相关
  'GET /users': 'getUserList',
  'GET /users/:identifier': 'getUserDetail',
  'GET /users/:identifier/stats': 'getUserStats',
  'GET /users/:identifier/attributions': 'getUserAttributions',
  'GET /users/:identifier/votes': 'getUserVotes',
  'GET /users/:identifier/activity': 'getUserActivity',
  
  // 搜索相关
  'GET /search': 'searchPages',
  'GET /search/suggest': 'getSearchSuggestions',
  'GET /search/tags': 'searchByTags',
  'GET /search/advanced': 'advancedSearch',
  
  // 统计相关
  'GET /stats/site': 'getSiteStats',
  'GET /stats/series': 'getSeriesStats',
  'GET /stats/series/:number': 'getSeriesDetail',
  'GET /stats/interesting': 'getInterestingStats',
  'GET /stats/trending': 'getTrendingStats',
  'GET /stats/leaderboard': 'getLeaderboard',
  'GET /stats/tags': 'getTagStats',
  
  // 元数据
  'GET /meta/tags': 'getAllTags',
  'GET /meta/categories': 'getCategories',
  'GET /meta/config': 'getSiteConfig',
};
```

### 4.2 响应格式规范
```typescript
// src/types/api.ts
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: ApiMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: any;
}

export interface ApiMeta {
  timestamp: number;
  version: string;
  requestId: string;
  cached?: boolean;
  cacheKey?: string;
  cacheTTL?: number;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// 响应构建器
export class ResponseBuilder {
  static success<T>(data: T, meta?: Partial<ApiMeta>): ApiResponse<T> {
    return {
      success: true,
      data,
      meta: {
        timestamp: Date.now(),
        version: '1.0.0',
        requestId: crypto.randomUUID(),
        ...meta,
      },
    };
  }

  static error(code: string, message: string, details?: any): ApiResponse {
    return {
      success: false,
      error: { code, message, details },
      meta: {
        timestamp: Date.now(),
        version: '1.0.0',
        requestId: crypto.randomUUID(),
      },
    };
  }

  static paginated<T>(
    data: T[],
    pagination: PaginationMeta,
    meta?: Partial<ApiMeta>
  ): ApiResponse<{ items: T[]; pagination: PaginationMeta }> {
    return this.success(
      { items: data, pagination },
      meta
    );
  }
}
```

## 5. 数据聚合层设计

### 5.1 页面数据聚合
```typescript
// src/services/page.service.ts
import { PrismaClient } from '@prisma/client';
import { CacheService } from './cache.service';
import { PageDetailDTO, PageListDTO } from '../types/dto';

export class PageService {
  constructor(
    private prisma: PrismaClient,
    private cache: CacheService
  ) {}

  async getPageDetail(identifier: string): Promise<PageDetailDTO> {
    const cacheKey = CacheKeyBuilder.pageDetail(identifier);
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        // 复杂的数据聚合逻辑
        const page = await this.prisma.page.findFirst({
          where: {
            OR: [
              { url: identifier },
              { urlKey: identifier },
              { pageUuid: identifier },
            ],
          },
          include: {
            versions: {
              where: { validTo: null },
              include: {
                stats: true,
                attributions: {
                  include: { user: true },
                  orderBy: { order: 'asc' },
                },
              },
            },
          },
        });

        if (!page) {
          throw new NotFoundError('Page not found');
        }

        // 并行获取额外数据
        const [recentVotes, recentRevisions, relatedPages] = await Promise.all([
          this.getRecentVotes(page.versions[0].id),
          this.getRecentRevisions(page.versions[0].id),
          this.getRelatedPages(page.id, page.versions[0].tags),
        ]);

        // 数据转换和格式化
        return this.formatPageDetail(
          page,
          recentVotes,
          recentRevisions,
          relatedPages
        );
      },
      CACHE_TTL.PAGE_DETAIL
    );
  }

  private async getRecentVotes(pageVersionId: number) {
    return this.prisma.vote.findMany({
      where: { pageVersionId },
      include: { user: true },
      orderBy: { timestamp: 'desc' },
      take: 20,
    });
  }

  private async getRecentRevisions(pageVersionId: number) {
    return this.prisma.revision.findMany({
      where: { pageVersionId },
      include: { user: true },
      orderBy: { timestamp: 'desc' },
      take: 10,
    });
  }

  private async getRelatedPages(pageId: number, tags: string[]) {
    if (tags.length === 0) return [];
    
    return this.prisma.$queryRaw`
      SELECT 
        p.id,
        p.url,
        pv.title,
        pv.rating,
        COUNT(DISTINCT tag) as common_tags
      FROM "Page" p
      JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE 
        pv."validTo" IS NULL
        AND p.id != ${pageId}
        AND pv.tags && ${tags}::text[]
      GROUP BY p.id, p.url, pv.title, pv.rating
      ORDER BY common_tags DESC, pv.rating DESC
      LIMIT 5
    `;
  }

  private formatPageDetail(
    page: any,
    votes: any[],
    revisions: any[],
    related: any[]
  ): PageDetailDTO {
    const currentVersion = page.versions[0];
    
    return {
      page: {
        id: page.id,
        url: page.url,
        pageUuid: page.pageUuid,
        urlKey: page.urlKey,
        historicalUrls: page.historicalUrls,
        firstPublishedAt: page.firstPublishedAt?.toISOString(),
      },
      currentVersion: {
        id: currentVersion.id,
        title: currentVersion.title,
        rating: currentVersion.rating,
        voteCount: currentVersion.voteCount,
        revisionCount: currentVersion.revisionCount,
        tags: currentVersion.tags,
        isDeleted: currentVersion.isDeleted,
        createdAt: currentVersion.createdAt.toISOString(),
        updatedAt: currentVersion.updatedAt.toISOString(),
      },
      stats: currentVersion.stats ? {
        wilson95: currentVersion.stats.wilson95,
        controversy: currentVersion.stats.controversy,
        likeRatio: currentVersion.stats.likeRatio,
        upvotes: currentVersion.stats.uv,
        downvotes: currentVersion.stats.dv,
      } : undefined,
      attributions: currentVersion.attributions.map((attr: any) => ({
        type: attr.type,
        order: attr.order,
        user: attr.user ? {
          id: attr.user.id,
          displayName: attr.user.displayName,
          wikidotId: attr.user.wikidotId,
        } : undefined,
        date: attr.date?.toISOString(),
      })),
      recentRevisions: revisions.map(rev => ({
        id: rev.id,
        wikidotId: rev.wikidotId,
        timestamp: rev.timestamp.toISOString(),
        type: rev.type,
        comment: rev.comment,
        user: rev.user ? {
          displayName: rev.user.displayName,
          wikidotId: rev.user.wikidotId,
        } : undefined,
      })),
      recentVotes: votes.map(vote => ({
        id: vote.id,
        timestamp: vote.timestamp.toISOString(),
        direction: vote.direction,
        user: vote.user ? {
          displayName: vote.user.displayName,
          wikidotId: vote.user.wikidotId,
        } : undefined,
      })),
      relatedPages: related,
    };
  }
}
```

### 5.2 搜索数据聚合
```typescript
// src/services/search.service.ts
export class SearchService {
  constructor(
    private prisma: PrismaClient,
    private cache: CacheService
  ) {}

  async search(params: SearchParams): Promise<SearchResultDTO> {
    const cacheKey = CacheKeyBuilder.search(params.query, params.filters);
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        // 构建搜索查询
        const searchQuery = this.buildSearchQuery(params);
        
        // 执行全文搜索
        const [results, total] = await Promise.all([
          this.executeSearch(searchQuery),
          this.countSearchResults(searchQuery),
        ]);
        
        // 获取搜索建议
        const suggestions = await this.generateSuggestions(
          params.query,
          results
        );
        
        return {
          results: results.map(this.formatSearchResult),
          total,
          query: params.query,
          filters: params.filters,
          suggestions,
          pagination: {
            limit: params.limit || 20,
            offset: params.offset || 0,
            hasMore: total > (params.offset || 0) + results.length,
            totalPages: Math.ceil(total / (params.limit || 20)),
          },
        };
      },
      CACHE_TTL.SEARCH_RESULTS
    );
  }

  private buildSearchQuery(params: SearchParams) {
    const { query, filters = {}, limit = 20, offset = 0 } = params;
    
    // PostgreSQL全文搜索查询构建
    let whereClause = `
      to_tsvector('chinese', COALESCE(si.title, '')) || 
      to_tsvector('chinese', COALESCE(si.text_content, '')) ||
      to_tsvector('chinese', COALESCE(si.source_content, ''))
      @@ plainto_tsquery('chinese', $1)
    `;
    
    const queryParams = [query];
    let paramIndex = 2;
    
    // 添加标签过滤
    if (filters.tags && filters.tags.length > 0) {
      whereClause += ` AND si.tags && $${paramIndex}::text[]`;
      queryParams.push(filters.tags);
      paramIndex++;
    }
    
    // 添加分类过滤
    if (filters.category) {
      whereClause += ` AND pv.category = $${paramIndex}`;
      queryParams.push(filters.category);
      paramIndex++;
    }
    
    return { whereClause, queryParams, limit, offset };
  }

  private async executeSearch(searchQuery: any) {
    const { whereClause, queryParams, limit, offset } = searchQuery;
    
    return this.prisma.$queryRawUnsafe(`
      SELECT 
        p.id as "pageId",
        p.url,
        p."urlKey",
        pv.title,
        pv.rating,
        pv."voteCount",
        pv.tags,
        si."textContent" as content,
        ts_rank(
          to_tsvector('chinese', COALESCE(si.title, '')) || 
          to_tsvector('chinese', COALESCE(si.text_content, '')),
          plainto_tsquery('chinese', $1)
        ) as score
      FROM "SearchIndex" si
      JOIN "Page" p ON si."pageId" = p.id
      JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      WHERE ${whereClause}
      ORDER BY score DESC, pv.rating DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `, ...queryParams);
  }
}
```

### 5.3 统计数据聚合
```typescript
// src/services/stats.service.ts
export class StatsService {
  constructor(
    private prisma: PrismaClient,
    private cache: CacheService
  ) {}

  async getSiteStats(): Promise<SiteStatsDTO> {
    return this.cache.getOrSet(
      'stats:site:current',
      async () => {
        // 并行获取多个统计数据
        const [
          basicStats,
          categoryStats,
          topTags,
          ratingDistribution,
          topContributors,
          recentActivity,
        ] = await Promise.all([
          this.getBasicStats(),
          this.getCategoryStats(),
          this.getTopTags(20),
          this.getRatingDistribution(),
          this.getTopContributors(10),
          this.getRecentActivity(),
        ]);

        return {
          current: basicStats,
          recent: recentActivity,
          categories: categoryStats,
          topTags,
          ratingDistribution,
          topContributors,
        };
      },
      CACHE_TTL.SITE_STATS
    );
  }

  private async getBasicStats() {
    const stats = await this.prisma.$queryRaw<any[]>`
      SELECT 
        (SELECT COUNT(*) FROM "User") as "totalUsers",
        (SELECT COUNT(*) FROM "User" WHERE "firstActivityAt" IS NOT NULL) as "activeUsers",
        (SELECT COUNT(*) FROM "Page") as "totalPages",
        (SELECT COUNT(*) FROM "Vote") as "totalVotes",
        (SELECT MAX("updatedAt") FROM "Page") as "lastUpdated"
    `;
    
    return stats[0];
  }

  private async getCategoryStats() {
    return this.prisma.$queryRaw`
      SELECT 
        CASE 
          WHEN tags @> ARRAY['scp', '原创'] THEN 'SCP'
          WHEN tags @> ARRAY['goi格式', '原创'] THEN 'GOI'
          WHEN tags @> ARRAY['故事', '原创'] THEN 'Story'
          WHEN tags @> ARRAY['wanderers', '原创'] THEN 'Wanderers'
          WHEN tags @> ARRAY['艺术作品', '原创'] THEN 'Art'
          WHEN NOT (tags @> ARRAY['原创']) THEN 'Translation'
          ELSE 'Other'
        END as name,
        COUNT(*) as "pageCount",
        AVG(rating) as "avgRating",
        SUM("voteCount") as "totalVotes",
        MAX(rating) as "maxRating",
        MIN(rating) as "minRating"
      FROM "PageVersion"
      WHERE "validTo" IS NULL AND NOT "isDeleted"
      GROUP BY name
      ORDER BY "pageCount" DESC
    `;
  }

  async getInterestingStats(): Promise<InterestingStatsDTO> {
    return this.cache.getOrSet(
      'stats:interesting:current',
      async () => {
        const [
          timeMilestones,
          tagRecords,
          contentRecords,
          ratingRecords,
          userActivityRecords,
          trendingStats,
        ] = await Promise.all([
          this.getTimeMilestones(),
          this.getTagRecords(),
          this.getContentRecords(),
          this.getRatingRecords(),
          this.getUserActivityRecords(),
          this.getTrendingStats(),
        ]);

        return {
          timeMilestones,
          tagRecords,
          contentRecords,
          ratingRecords,
          userActivityRecords,
          trendingStats,
        };
      },
      CACHE_TTL.SITE_STATS
    );
  }
}
```

## 6. 中间件实现

### 6.1 缓存中间件
```typescript
// src/middleware/cache.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { CacheService } from '../services/cache.service';

export function cacheMiddleware(ttl?: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // 只缓存GET请求
    if (req.method !== 'GET') {
      return next();
    }

    const cache = new CacheService();
    const key = `route:${req.originalUrl}`;
    
    // 检查缓存
    const cached = await cache.get(key);
    if (cached) {
      res.setHeader('X-Cache-Hit', 'true');
      res.setHeader('X-Cache-Key', key);
      return res.json(cached);
    }

    // 劫持res.json以缓存响应
    const originalJson = res.json;
    res.json = function(data: any) {
      res.setHeader('X-Cache-Hit', 'false');
      
      // 只缓存成功的响应
      if (res.statusCode === 200 && data.success) {
        cache.set(key, data, ttl || 300).catch(err => {
          console.error('Cache set error:', err);
        });
      }
      
      return originalJson.call(this, data);
    };

    next();
  };
}
```

### 6.2 错误处理中间件
```typescript
// src/middleware/error.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { ResponseBuilder } from '../types/api';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
) {
  logger.error({
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
  });

  if (err instanceof AppError) {
    return res.status(err.statusCode).json(
      ResponseBuilder.error(err.code, err.message, err.details)
    );
  }

  // Prisma错误处理
  if (err.constructor.name === 'PrismaClientKnownRequestError') {
    const prismaError = err as any;
    if (prismaError.code === 'P2025') {
      return res.status(404).json(
        ResponseBuilder.error('NOT_FOUND', 'Resource not found')
      );
    }
  }

  // 默认错误响应
  res.status(500).json(
    ResponseBuilder.error(
      'INTERNAL_ERROR',
      process.env.NODE_ENV === 'production' 
        ? 'Internal server error'
        : err.message
    )
  );
}
```

### 6.3 请求验证中间件
```typescript
// src/middleware/validation.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { ResponseBuilder } from '../types/api';

export function validate(schema: {
  body?: z.ZodSchema;
  query?: z.ZodSchema;
  params?: z.ZodSchema;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (schema.body) {
        req.body = await schema.body.parseAsync(req.body);
      }
      if (schema.query) {
        req.query = await schema.query.parseAsync(req.query);
      }
      if (schema.params) {
        req.params = await schema.params.parseAsync(req.params);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json(
          ResponseBuilder.error(
            'VALIDATION_ERROR',
            'Invalid request data',
            error.errors
          )
        );
      }
      next(error);
    }
  };
}

// 验证模式定义
export const schemas = {
  pagination: z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
  }),
  
  searchQuery: z.object({
    q: z.string().min(1).max(200),
    tags: z.string().optional().transform(val => 
      val ? val.split(',').filter(Boolean) : undefined
    ),
    category: z.string().optional(),
    sort: z.enum(['relevance', 'rating', 'date']).default('relevance'),
  }),
  
  identifier: z.object({
    identifier: z.string().min(1),
  }),
};
```

### 6.4 限流中间件
```typescript
// src/middleware/rateLimit.middleware.ts
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis from 'ioredis';

const redisClient = new Redis({
  host: 'localhost',
  port: 6379,
});

export const createRateLimiter = (options: {
  windowMs?: number;
  max?: number;
  keyPrefix?: string;
}) => {
  return rateLimit({
    store: new RedisStore({
      client: redisClient,
      prefix: options.keyPrefix || 'rate_limit:',
    }),
    windowMs: options.windowMs || 60 * 1000, // 1分钟
    max: options.max || 100, // 最大请求数
    message: 'Too many requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
  });
};

// 不同类型的限流器
export const rateLimiters = {
  api: createRateLimiter({ max: 100, windowMs: 60 * 1000 }),
  search: createRateLimiter({ max: 30, windowMs: 60 * 1000, keyPrefix: 'search:' }),
  heavy: createRateLimiter({ max: 10, windowMs: 60 * 1000, keyPrefix: 'heavy:' }),
};
```

## 7. 配置管理

### 7.1 环境变量配置
```bash
# .env
NODE_ENV=production
PORT=4396

# 数据库配置
DATABASE_URL="postgresql://user_RcEMEj:password_ZZ5KWn@localhost:5432/scpper-cn"

# Redis配置
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# 日志配置
LOG_LEVEL=info
LOG_DIR=./logs

# API配置
API_PREFIX=/api
API_VERSION=v1
API_TIMEOUT=30000

# 缓存配置
CACHE_ENABLED=true
CACHE_DEFAULT_TTL=300

# 监控配置
METRICS_ENABLED=true
METRICS_PORT=9090
```

### 7.2 配置加载器
```typescript
// src/config/index.ts
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().default(4396),
  
  database: z.object({
    url: z.string(),
  }),
  
  redis: z.object({
    host: z.string().default('localhost'),
    port: z.coerce.number().default(6379),
    password: z.string().optional(),
    db: z.coerce.number().default(0),
  }),
  
  api: z.object({
    prefix: z.string().default('/api'),
    version: z.string().default('v1'),
    timeout: z.coerce.number().default(30000),
  }),
  
  cache: z.object({
    enabled: z.coerce.boolean().default(true),
    defaultTTL: z.coerce.number().default(300),
  }),
  
  logging: z.object({
    level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    dir: z.string().default('./logs'),
  }),
  
  metrics: z.object({
    enabled: z.coerce.boolean().default(true),
    port: z.coerce.number().default(9090),
  }),
});

export const config = configSchema.parse({
  nodeEnv: process.env.NODE_ENV,
  port: process.env.PORT,
  
  database: {
    url: process.env.DATABASE_URL,
  },
  
  redis: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD,
    db: process.env.REDIS_DB,
  },
  
  api: {
    prefix: process.env.API_PREFIX,
    version: process.env.API_VERSION,
    timeout: process.env.API_TIMEOUT,
  },
  
  cache: {
    enabled: process.env.CACHE_ENABLED,
    defaultTTL: process.env.CACHE_DEFAULT_TTL,
  },
  
  logging: {
    level: process.env.LOG_LEVEL,
    dir: process.env.LOG_DIR,
  },
  
  metrics: {
    enabled: process.env.METRICS_ENABLED,
    port: process.env.METRICS_PORT,
  },
});
```

## 8. 主应用实现

### 8.1 Express应用初始化
```typescript
// src/app.ts
import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { PrismaClient } from '@prisma/client';
import { config } from './config';
import { errorHandler } from './middleware/error.middleware';
import { loggingMiddleware } from './middleware/logging.middleware';
import { rateLimiters } from './middleware/rateLimit.middleware';
import { setupRoutes } from './routes';
import { CacheService } from './services/cache.service';
import { logger } from './utils/logger';
import { setupMetrics } from './utils/metrics';

export class App {
  private app: Express;
  private prisma: PrismaClient;
  private cache: CacheService;

  constructor() {
    this.app = express();
    this.prisma = new PrismaClient({
      log: config.nodeEnv === 'development' ? ['query'] : [],
    });
    this.cache = new CacheService();
  }

  async initialize() {
    // 基础中间件
    this.app.use(helmet());
    this.app.use(cors());
    this.app.use(compression());
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    
    // 日志中间件
    this.app.use(loggingMiddleware);
    
    // 限流中间件
    this.app.use(config.api.prefix, rateLimiters.api);
    
    // 健康检查
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
    
    // API路由
    setupRoutes(this.app, this.prisma, this.cache);
    
    // 错误处理（必须在最后）
    this.app.use(errorHandler);
    
    // 设置监控
    if (config.metrics.enabled) {
      setupMetrics(this.app);
    }
    
    // 测试数据库连接
    await this.prisma.$connect();
    logger.info('Database connected successfully');
    
    // 测试Redis连接
    await this.cache.ping();
    logger.info('Redis connected successfully');
  }

  async start() {
    await this.initialize();
    
    this.app.listen(config.port, () => {
      logger.info(`BFF service started on port ${config.port}`);
      logger.info(`API available at http://localhost:${config.port}${config.api.prefix}`);
    });
  }

  async stop() {
    await this.prisma.$disconnect();
    await this.cache.disconnect();
    logger.info('Service stopped');
  }
}
```

### 8.2 服务器启动入口
```typescript
// src/server.ts
import { App } from './app';
import { logger } from './utils/logger';

const app = new App();

// 优雅关闭
const gracefulShutdown = async (signal: string) => {
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  await app.stop();
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 未捕获异常处理
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// 启动服务
app.start().catch((error) => {
  logger.error('Failed to start service:', error);
  process.exit(1);
});
```

## 9. PM2部署配置

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'scpper-bff',
    script: './dist/server.js',
    instances: 2,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 4396,
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    max_memory_restart: '1G',
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '10s',
    listen_timeout: 3000,
    kill_timeout: 5000,
  }],
};
```

## 10. package.json

```json
{
  "name": "scpper-cn-bff",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "pm2:start": "pm2 start ecosystem.config.js",
    "pm2:stop": "pm2 stop scpper-bff",
    "pm2:restart": "pm2 restart scpper-bff",
    "pm2:logs": "pm2 logs scpper-bff",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "test": "jest",
    "lint": "eslint src --ext .ts",
    "format": "prettier --write \"src/**/*.ts\""
  },
  "dependencies": {
    "@prisma/client": "^5.19.0",
    "compression": "^1.7.4",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.2.0",
    "helmet": "^7.1.0",
    "ioredis": "^5.3.2",
    "prom-client": "^15.1.0",
    "rate-limit-redis": "^4.2.0",
    "winston": "^3.13.0",
    "winston-daily-rotate-file": "^5.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/compression": "^1.7.5",
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "eslint": "^8.57.0",
    "jest": "^29.7.0",
    "prettier": "^3.3.0",
    "prisma": "^5.19.0",
    "tsx": "^4.11.0",
    "typescript": "^5.4.5"
  }
}
```

## 11. TypeScript配置

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "allowSyntheticDefaultImports": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

## 12. 部署步骤

### 12.1 本地开发环境设置
```bash
# 1. 克隆代码并安装依赖
cd /path/to/project
npm install

# 2. 从backend项目复制Prisma schema
cp ../backend/prisma/schema.prisma ./prisma/

# 3. 生成Prisma Client
npm run prisma:generate

# 4. 创建环境变量文件
cp .env.example .env
# 编辑.env文件，确保数据库和Redis连接信息正确

# 5. 启动开发服务器
npm run dev
```

### 12.2 生产环境部署
```bash
# 1. 构建项目
npm run build

# 2. 使用PM2启动
npm run pm2:start

# 3. 配置nginx反向代理
# 在nginx配置中添加：
```

```nginx
# /etc/nginx/sites-available/scpper
server {
    listen 80;
    server_name scpper.mer.run;

    location /api/ {
        proxy_pass http://localhost:4396/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # 缓存设置
        proxy_cache_valid 200 302 10m;
        proxy_cache_valid 404 1m;
    }
}
```

### 12.3 监控和维护
```bash
# 查看PM2状态
pm2 status

# 查看日志
pm2 logs scpper-bff

# 重启服务
pm2 restart scpper-bff

# 监控资源使用
pm2 monit

# 查看指标
curl http://localhost:9090/metrics
```

## 13. 缓存失效策略

### 13.1 缓存失效触发器
```typescript
// src/utils/cache-invalidation.ts
export class CacheInvalidator {
  constructor(private cache: CacheService) {}

  // 页面更新时的缓存失效
  async invalidatePageCache(pageId: number, url?: string) {
    const patterns = [
      `page:${pageId}`,
      `page:${url}`,
      `page_list:*`,
      `search:*`,
      `stats:site:*`,
    ];
    
    await this.cache.invalidate(patterns);
  }

  // 用户数据更新时的缓存失效
  async invalidateUserCache(userId: number) {
    const patterns = [
      `user:${userId}`,
      `user_stats:${userId}`,
      `leaderboard:*`,
    ];
    
    await this.cache.invalidate(patterns);
  }

  // 投票发生时的缓存失效
  async invalidateVoteCache(pageId: number, userId?: number) {
    const patterns = [
      `page:${pageId}`,
      `page_list:*`,
      `stats:*`,
    ];
    
    if (userId) {
      patterns.push(`user:${userId}`, `user_stats:${userId}`);
    }
    
    await this.cache.invalidate(patterns);
  }

  // 定时清理过期缓存
  async cleanupExpiredCache() {
    // 实现基于TTL的自动清理逻辑
  }
}
```

## 14. 性能优化建议

### 14.1 数据库查询优化
- 使用适当的索引
- 实施查询结果分页
- 使用数据库连接池
- 优化N+1查询问题

### 14.2 缓存优化
- 实施多级缓存策略
- 使用缓存预热
- 实施缓存更新策略
- 监控缓存命中率

### 14.3 API优化
- 实施GraphQL或字段过滤
- 使用HTTP/2
- 启用Gzip压缩
- 实施API版本控制

## 15. 安全建议

### 15.1 基础安全
- 使用Helmet.js设置安全头
- 实施CORS策略
- 输入验证和清理
- SQL注入防护

### 15.2 认证授权（如需要）
- JWT令牌认证
- API密钥管理
- 权限控制
- 审计日志

### 15.3 限流和防护
- API请求限流
- DDoS防护
- 异常检测
- 监控告警

## 总结

这个BFF设计提供了：
1. **完整的缓存层**：Redis缓存with TTL管理
2. **健壮的错误处理**：统一错误响应格式
3. **性能优化**：请求限流、响应压缩、查询优化
4. **可扩展架构**：清晰的分层设计
5. **生产就绪**：PM2集群模式、健康检查、监控指标
6. **开发友好**：TypeScript类型安全、验证中间件

按照此文档实施，可以构建一个高性能、可扩展的BFF服务层。