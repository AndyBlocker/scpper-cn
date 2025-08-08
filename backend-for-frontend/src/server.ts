import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import jwt from '@fastify/jwt'
import compress from '@fastify/compress'
import etag from '@fastify/etag'
import mercurius from 'mercurius'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'

import depthLimit from 'graphql-depth-limit'
// import { createComplexityLimitRule, fieldExtensionsEstimator, simpleEstimator } from 'graphql-query-complexity'
// import { GraphQLError } from 'graphql'

import { typeDefs } from './modules/schema.js'
import { resolvers } from './modules/resolvers.js'
import authPlugin from './plugins/auth.js'
import cachePlugin from './plugins/cache.js'
import metricsPlugin from './plugins/metrics.js'

const PORT = parseInt(process.env.PORT || '4000')
const NODE_ENV = process.env.NODE_ENV || 'development'

// 初始化 Prisma 客户端
const prisma = new PrismaClient({
  log: NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['warn', 'error']
})

// 初始化 Redis 客户端（可选）
let redis: Redis | undefined
if (process.env.REDIS_URL) {
  try {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true
    })
    
    redis.on('error', (err) => {
      console.warn('Redis connection failed, using memory cache instead:', err.message)
      redis = undefined
    })
  } catch (error) {
    console.warn('Redis initialization failed, using memory cache instead')
    redis = undefined
  }
}

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  },
  trustProxy: true  // 信任代理以获取真实IP
})

// 注册插件
await fastify.register(cors, {
  origin: (origin, cb) => {
    // 在开发环境中允许所有来源
    if (NODE_ENV === 'development') {
      cb(null, true)
      return
    }
    
    // 生产环境允许的来源
    const allowedOrigins = [
      'https://scpper.mer.run',
      'https://www.scpper.mer.run',
      /^https:\/\/.*\.mer\.run$/  // 允许所有 mer.run 子域名
    ]
    
    if (!origin) {
      // 允许无来源（比如移动应用或直接访问）
      cb(null, true)
      return
    }
    
    // 检查字符串匹配
    const stringMatch = allowedOrigins.some(allowed => 
      typeof allowed === 'string' && allowed === origin
    )
    
    // 检查正则匹配
    const regexMatch = allowedOrigins.some(allowed => 
      allowed instanceof RegExp && allowed.test(origin)
    )
    
    if (stringMatch || regexMatch) {
      cb(null, true)
    } else {
      cb(new Error(`CORS: origin ${origin} not allowed`), false)
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  preflightContinue: false,
  optionsSuccessStatus: 204
})

await fastify.register(helmet, {
  contentSecurityPolicy: NODE_ENV === 'production'
})

await fastify.register(compress)
await fastify.register(etag)

await fastify.register(rateLimit, {
  max: parseInt(process.env.RATE_LIMIT_MAX || '200'),
  timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
  redis: redis
})

// JWT配置 - 生产环境必须提供安全的密钥
if (NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET must be set and at least 32 characters long in production')
}

await fastify.register(jwt, {
  secret: process.env.JWT_SECRET || 'change-me-in-production-use-32-chars-min'
})

// 注册自定义插件
await fastify.register(authPlugin)
await fastify.register(cachePlugin, { redis })
await fastify.register(metricsPlugin)

// 注册 GraphQL
await fastify.register(mercurius, {
  schema: typeDefs,
  resolvers: resolvers as any,
  context: async (request) => {
    return {
      prisma,
      redis,
      user: request.user,
      logger: request.log
    }
  },
  loaders: {
    // Page相关的批量加载器
    Page: {
      currentVersion: async (queries: any[], { prisma }: any) => {
        const pageIds = queries.map(q => q.obj.id)
        const versions = await prisma.pageVersion.findMany({
          where: {
            pageId: { in: pageIds },
            validTo: null
          },
          include: { stats: true }
        })
        const versionMap = new Map(versions.map((v: any) => [v.pageId, v]))
        return queries.map(q => versionMap.get(q.obj.id) || null)
      }
    },
    // Vote相关的批量加载器
    Vote: {
      user: async (queries: any[], { prisma }: any) => {
        const userIds = [...new Set(queries.map(q => q.obj.userId).filter(Boolean))]
        const users = await prisma.user.findMany({
          where: { id: { in: userIds } },
          include: { stats: true }
        })
        const userMap = new Map(users.map((u: any) => [u.id, u]))
        return queries.map(q => q.obj.userId ? userMap.get(q.obj.userId) || null : null)
      },
      pageVersion: async (queries: any[], { prisma }: any) => {
        const versionIds = [...new Set(queries.map(q => q.obj.pageVersionId))]
        const versions = await prisma.pageVersion.findMany({
          where: { id: { in: versionIds } },
          include: { page: true, stats: true }
        })
        const versionMap = new Map(versions.map((v: any) => [v.id, v]))
        return queries.map(q => versionMap.get(q.obj.pageVersionId) || null)
      }
    },
    // PageVersion相关的批量加载器
    PageVersion: {
      stats: async (queries: any[], { prisma }: any) => {
        const versionIds = queries.map(q => q.obj.id)
        const stats = await prisma.pageStats.findMany({
          where: { pageVersionId: { in: versionIds } }
        })
        const statsMap = new Map(stats.map((s: any) => [s.pageVersionId, s]))
        return queries.map(q => statsMap.get(q.obj.id) || null)
      },
      attributions: async (queries: any[], { prisma }: any) => {
        const versionIds = queries.map(q => q.obj.id)
        const attributions = await prisma.attribution.findMany({
          where: { pageVersionId: { in: versionIds } },
          include: { user: true },
          orderBy: { order: 'asc' }
        })
        const attributionMap = new Map()
        attributions.forEach((attr: any) => {
          if (!attributionMap.has(attr.pageVersionId)) {
            attributionMap.set(attr.pageVersionId, [])
          }
          attributionMap.get(attr.pageVersionId).push(attr)
        })
        return queries.map(q => attributionMap.get(q.obj.id) || [])
      }
    },
    // User相关的批量加载器
    User: {
      stats: async (queries: any[], { prisma }: any) => {
        const userIds = queries.map(q => q.obj.id)
        const stats = await prisma.userStats.findMany({
          where: { userId: { in: userIds } }
        })
        const statsMap = new Map(stats.map((s: any) => [s.userId, s]))
        return queries.map(q => statsMap.get(q.obj.id) || null)
      }
    }
  },
  graphiql: NODE_ENV === 'development',
  validationRules: [
    depthLimit(8) // 最大查询深度
    // TODO: Add complexity rule when proper configuration is available
  ]
})

// REST API 路由
fastify.get('/api/health', {
  schema: {
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          timestamp: { type: 'string' }
        }
      }
    }
  }
}, async () => {
  return { status: 'ok', timestamp: new Date().toISOString() }
})

// 数据库连接测试端点 - 仅在开发环境可用
if (NODE_ENV === 'development') {
  fastify.get('/api/db-test', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            database: { type: 'string' },
            timestamp: { type: 'string' }
          }
        },
        500: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            error: { type: 'string' },
            timestamp: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const result = await prisma.$queryRaw`SELECT version() as version` as Array<{version: string}>
      return { 
        status: 'connected',
        database: result[0]?.version || 'Unknown',
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      request.log.error(error, 'Database connection failed')
      reply.status(500)
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      }
    }
  })
}

fastify.get('/api/stats/summary', {
  schema: {
    response: {
      200: {
        type: 'object',
        properties: {
          totalUsers: { type: 'integer' },
          totalPages: { type: 'integer' },
          totalVotes: { type: 'integer' },
          activeUsers: { type: 'integer' },
          lastUpdated: { type: 'string' },
          status: { type: 'string' }
        }
      },
      500: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          details: { type: 'string' },
          status: { type: 'string' }
        }
      }
    }
  }
}, async (request, reply) => {
  const cache = fastify.cache
  const cacheKey = 'stats:summary'
  
  // 尝试从缓存获取
  if (cache) {
    try {
      const cached = await cache.get(cacheKey)
      if (cached) {
        return JSON.parse(cached)
      }
    } catch (cacheError) {
      request.log.warn(cacheError, 'Cache get failed')
    }
  }
  
  try {
    // 测试数据库连接
    await prisma.$queryRaw`SELECT 1`
    request.log.info('Database connection successful')
    
    // 从数据库获取最新统计数据
    const [totalUsers, totalPages, totalVotes, latestStats] = await Promise.all([
      prisma.user.count().catch(() => 0),
      prisma.page.count().catch(() => 0), 
      prisma.vote.count().catch(() => 0),
      prisma.siteStats.findFirst({
        orderBy: { date: 'desc' }
      }).catch(() => null)
    ])
    
    const summary = {
      totalUsers,
      totalPages,
      totalVotes,
      activeUsers: latestStats?.activeUsers || 0,
      lastUpdated: latestStats?.date || new Date(),
      status: 'connected'
    }
    
    // 缓存结果
    if (cache) {
      try {
        await cache.setex(cacheKey, 300, JSON.stringify(summary)) // 5分钟
      } catch (cacheError) {
        request.log.warn(cacheError, 'Cache set failed')
      }
    }
    
    return summary
  } catch (error) {
    request.log.error(error, 'Failed to fetch stats summary')
    
    // 如果是开发环境，返回模拟数据
    if (NODE_ENV === 'development') {
      request.log.warn('Using mock data due to database connection failure')
      return {
        totalUsers: 28500,
        totalPages: 45200,
        totalVotes: 9800000,
        activeUsers: 15300,
        lastUpdated: new Date(),
        status: 'mock'
      }
    }
    
    // 返回更详细的错误信息
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    reply.status(500)
    return { 
      error: 'Failed to fetch statistics',
      details: errorMessage,
      status: 'error'
    }
  }
})

// 启动服务器
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' })
    console.log(`🚀 BFF Server running on http://localhost:${PORT}`)
    console.log(`📊 GraphQL playground: http://localhost:${PORT}/graphiql`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

// 优雅关闭
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...')
  await prisma.$disconnect()
  if (redis) await redis.disconnect()
  await fastify.close()
})

start()