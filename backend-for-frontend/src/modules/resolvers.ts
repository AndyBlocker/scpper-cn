import type { Context } from '../types/context.js'
import { interestingStatsResolvers } from './interesting-stats-resolvers.js'

// 分页工具函数
const encodeCursor = (id: string | number): string => 
  Buffer.from(String(id)).toString('base64')

const decodeCursor = (cursor: string): string => 
  Buffer.from(cursor, 'base64').toString('ascii')

// Decimal/Float conversion utility
const toNum = (v: any) => v == null ? null : Number(v)

const buildPageInfo = (items: any[], first: number, after?: string) => {
  const hasNextPage = items.length === first + 1
  const hasPreviousPage = !!after
  
  if (hasNextPage) {
    items.pop() // 移除多查询的一条记录
  }
  
  return {
    hasNextPage,
    hasPreviousPage,
    startCursor: items.length > 0 ? encodeCursor(items[0].id) : null,
    endCursor: items.length > 0 ? encodeCursor(items[items.length - 1].id) : null
  }
}

// 合并所有解析器
const baseResolvers = {
  Query: {
    // 站点统计
    async siteSummary(_: any, __: any, { prisma, redis, logger }: Context) {
      const cacheKey = 'stats:site-summary'
      
      // 尝试从缓存获取
      if (redis) {
        try {
          const cached = await redis.get(cacheKey)
          if (cached) {
            return JSON.parse(cached)
          }
        } catch (error) {
          logger.warn({ error }, 'Redis cache get failed')
        }
      }
      
      try {
        const [totalUsers, totalPages, totalVotes, latestStats] = await Promise.all([
          prisma.user.count(),
          prisma.page.count(),
          prisma.vote.count(),
          prisma.siteStats.findFirst({
            orderBy: { date: 'desc' }
          })
        ])
        
        const summary = {
          totalUsers,
          totalPages,
          totalVotes,
          activeUsers: latestStats?.activeUsers || 0,
          lastUpdated: latestStats?.date || new Date()
        }
        
        // 缓存结果
        if (redis) {
          try {
            await redis.setex(cacheKey, 300, JSON.stringify(summary)) // 5分钟
          } catch (error) {
            logger.warn({ error }, 'Redis cache set failed')
          }
        }
        
        return summary
      } catch (error) {
        logger.error({ error }, 'Failed to fetch site summary')
        throw new Error('Failed to fetch site statistics')
      }
    },

    // 单个页面查询
    async page(_: any, { id }: { id: string }, { prisma }: Context) {
      return await prisma.page.findUnique({
        where: { id: parseInt(id) },
        include: {
          versions: {
            where: { validTo: null }, // 当前版本
            take: 1,
            include: {
              stats: true,
              attributions: {
                include: { user: true }
              }
            }
          }
        }
      })
    },

    // 页面列表查询
    async pages(_: any, { filter, sort, first = 20, after }: any, { prisma, redis, logger }: Context) {
      // 构建缓存键
      const cacheKey = `pages:${JSON.stringify({filter, sort, first, after})}`
      
      // 尝试从缓存获取
      if (redis && !filter) { // 只缓存无筛选的基础查询
        try {
          const cached = await redis.get(cacheKey)
          if (cached) {
            return JSON.parse(cached)
          }
        } catch (error) {
          logger.warn({ error }, 'Pages cache get failed')
        }
      }
      
      const where: any = {}
      let orderBy: any = {}
      
      // 构建筛选条件
      if (filter) {
        if (filter.ratingMin !== undefined || filter.ratingMax !== undefined) {
          where.versions = {
            some: {
              validTo: null,
              ...(filter.ratingMin !== undefined && { rating: { gte: filter.ratingMin } }),
              ...(filter.ratingMax !== undefined && { rating: { lte: filter.ratingMax } })
            }
          }
        }
        
        if (filter.tags && filter.tags.length > 0) {
          where.versions = {
            ...where.versions,
            some: {
              ...where.versions?.some,
              tags: { hasSome: filter.tags }
            }
          }
        }
      }
      
      // 构建排序条件
      let useRawQuery = false
      let rawSortField = ''
      let rawSortOrder = 'DESC'

      switch (sort) {
        case 'RATING_DESC':
          useRawQuery = true
          rawSortField = 'pv.rating'
          rawSortOrder = 'DESC'
          break
        case 'RATING_ASC':
          useRawQuery = true
          rawSortField = 'pv.rating'
          rawSortOrder = 'ASC'
          break
        case 'WILSON_DESC':
          useRawQuery = true
          rawSortField = 'ps.wilson95'
          rawSortOrder = 'DESC'
          break
        case 'WILSON_ASC':
          useRawQuery = true
          rawSortField = 'ps.wilson95'
          rawSortOrder = 'ASC'
          break
        case 'CONTROVERSY_DESC':
          useRawQuery = true
          rawSortField = 'ps.controversy'
          rawSortOrder = 'DESC'
          break
        case 'CREATED_DESC':
          orderBy = { createdAt: 'desc' }
          break
        case 'CREATED_ASC':
          orderBy = { createdAt: 'asc' }
          break
        case 'UPDATED_DESC':
          orderBy = { updatedAt: 'desc' }
          break
        case 'UPDATED_ASC':
          orderBy = { updatedAt: 'asc' }
          break
        default:
          orderBy = { id: 'desc' }
      }
      
      // 分页逻辑
      const cursor = after ? { id: { gt: parseInt(decodeCursor(after)) } } : undefined
      
      let items: any[]
      
      if (useRawQuery) {
        // 使用原生SQL进行复杂排序
        let pageIds: Array<{id: number}>
        
        // 构建SQL片段
        const orderByClause = rawSortField === 'pv.rating' 
          ? (rawSortOrder === 'DESC' ? 'pv.rating DESC NULLS LAST' : 'pv.rating ASC NULLS LAST')
          : rawSortField === 'ps.wilson95' 
          ? (rawSortOrder === 'DESC' ? 'ps.wilson95 DESC NULLS LAST' : 'ps.wilson95 ASC NULLS LAST')
          : (rawSortOrder === 'DESC' ? 'ps.controversy DESC NULLS LAST' : 'ps.controversy ASC NULLS LAST')
        
        if (cursor) {
          // 使用$queryRaw with Prisma.sql template
          const query = `
            SELECT DISTINCT p.id, ${rawSortField}
            FROM "Page" p
            LEFT JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
            LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
            WHERE p.id > $1
            ORDER BY ${orderByClause}, p.id DESC
            LIMIT $2
          `
          pageIds = await prisma.$queryRawUnsafe<Array<{id: number}>>(query, cursor.id.gt, first + 1)
        } else {
          const query = `
            SELECT DISTINCT p.id, ${rawSortField}
            FROM "Page" p
            LEFT JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
            LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
            ORDER BY ${orderByClause}, p.id DESC
            LIMIT $1
          `
          pageIds = await prisma.$queryRawUnsafe<Array<{id: number}>>(query, first + 1)
        }
        
        if (pageIds.length > 0) {
          items = await prisma.page.findMany({
            where: { id: { in: pageIds.map(p => p.id) } },
            include: {
              versions: {
                where: { validTo: null },
                take: 1,
                include: { stats: true }
              }
            }
          })
          
          // 保持原始排序顺序
          const idOrder = pageIds.map(p => p.id)
          items.sort((a, b) => idOrder.indexOf(a.id) - idOrder.indexOf(b.id))
        } else {
          items = []
        }
      } else {
        // 标准Prisma查询
        items = await prisma.page.findMany({
          where: { ...where, ...cursor },
          orderBy,
          take: first + 1,
          include: {
            versions: {
              where: { validTo: null },
              take: 1,
              include: { stats: true }
            }
          }
        })
      }
      
      const totalCount = await prisma.page.count({ where })
      
      const pageInfo = buildPageInfo(items, first, after)
      
      const result = {
        edges: items.map(item => ({
          node: item,
          cursor: encodeCursor(item.id)
        })),
        pageInfo,
        totalCount
      }
      
      // 缓存结果（仅基础查询）
      if (redis && !filter) {
        try {
          await redis.setex(cacheKey, 300, JSON.stringify(result)) // 5分钟缓存
        } catch (error) {
          logger.warn({ error }, 'Pages cache set failed')
        }
      }
      
      return result
    },

    // 单个用户查询
    async user(_: any, { id }: { id: string }, { prisma }: Context) {
      return await prisma.user.findUnique({
        where: { id: parseInt(id) },
        include: {
          stats: true
        }
      })
    },

    // 用户列表查询
    async users(_: any, { filter, sort, first = 20, after }: any, { prisma, redis, logger }: Context) {
      // 构建缓存键
      const cacheKey = `users:${JSON.stringify({filter, sort, first, after})}`
      
      // 尝试从缓存获取
      if (redis && !filter) {
        try {
          const cached = await redis.get(cacheKey)
          if (cached) {
            return JSON.parse(cached)
          }
        } catch (error) {
          logger.warn({ error }, 'Users cache get failed')
        }
      }
      
      const where: any = {}
      let orderBy: any = {}
      
      // 构建筛选条件
      if (filter) {
        if (filter.displayName) {
          where.displayName = { contains: filter.displayName, mode: 'insensitive' }
        }
        if (filter.hasStats !== undefined) {
          where.stats = filter.hasStats ? { isNot: null } : { is: null }
        }
      }
      
      // 构建排序条件
      let useUserRawQuery = false
      let userRawSortField = ''
      let userRawSortOrder = 'DESC'

      switch (sort) {
        case 'OVERALL_RATING_DESC':
          useUserRawQuery = true
          userRawSortField = 'us.overallRating'
          userRawSortOrder = 'DESC'
          break
        case 'SCP_RATING_DESC':
          useUserRawQuery = true
          userRawSortField = 'us.scpRating'
          userRawSortOrder = 'DESC'
          break
        case 'STORY_RATING_DESC':
          useUserRawQuery = true
          userRawSortField = 'us.storyRating'
          userRawSortOrder = 'DESC'
          break
        case 'TRANSLATION_RATING_DESC':
          useUserRawQuery = true
          userRawSortField = 'us.translationRating'
          userRawSortOrder = 'DESC'
          break
        case 'ACTIVITY_DESC':
          orderBy = { lastActivityAt: 'desc' }
          break
        case 'CREATED_DESC':
          orderBy = { firstActivityAt: 'desc' }
          break
        default:
          orderBy = { id: 'desc' }
      }
      
      const cursor = after ? { id: { gt: parseInt(decodeCursor(after)) } } : undefined
      
      let items: any[]
      
      if (useUserRawQuery) {
        // 使用原生SQL进行用户排序
        let userIds: Array<{id: number}>
        
        const userOrderByClause = userRawSortField === 'us.overallRating'
          ? 'us."overallRating" DESC NULLS LAST'
          : userRawSortField === 'us.scpRating'
          ? 'us."scpRating" DESC NULLS LAST'
          : userRawSortField === 'us.storyRating'
          ? 'us."storyRating" DESC NULLS LAST'
          : 'us."translationRating" DESC NULLS LAST'
        
        if (cursor) {
          const query = `
            SELECT DISTINCT u.id
            FROM "User" u
            LEFT JOIN "UserStats" us ON us."userId" = u.id
            WHERE u.id > $1
            ORDER BY ${userOrderByClause}, u.id DESC
            LIMIT $2
          `
          userIds = await prisma.$queryRawUnsafe<Array<{id: number}>>(query, cursor.id.gt, first + 1)
        } else {
          const query = `
            SELECT DISTINCT u.id
            FROM "User" u
            LEFT JOIN "UserStats" us ON us."userId" = u.id
            ORDER BY ${userOrderByClause}, u.id DESC
            LIMIT $1
          `
          userIds = await prisma.$queryRawUnsafe<Array<{id: number}>>(query, first + 1)
        }
        
        if (userIds.length > 0) {
          items = await prisma.user.findMany({
            where: { id: { in: userIds.map(u => u.id) } },
            include: { stats: true }
          })
          
          // 保持原始排序顺序
          const idOrder = userIds.map(u => u.id)
          items.sort((a, b) => idOrder.indexOf(a.id) - idOrder.indexOf(b.id))
        } else {
          items = []
        }
      } else {
        items = await prisma.user.findMany({
          where: { ...where, ...cursor },
          orderBy,
          take: first + 1,
          include: { stats: true }
        })
      }
      
      const totalCount = await prisma.user.count({ where })
      
      const pageInfo = buildPageInfo(items, first, after)
      
      const result = {
        edges: items.map(item => ({
          node: item,
          cursor: encodeCursor(item.id)
        })),
        pageInfo,
        totalCount
      }
      
      // 缓存结果（仅基础查询）
      if (redis && !filter) {
        try {
          await redis.setex(cacheKey, 180, JSON.stringify(result)) // 3分钟缓存
        } catch (error) {
          logger.warn({ error }, 'Users cache set failed')
        }
      }
      
      return result
    },

    // 随机页面推荐
    async randomPages(_: any, { limit = 3, tag }: { limit: number, tag?: string }, { prisma, redis }: Context) {
      const cacheKey = tag ? `random:pages:${tag}:${limit}` : `random:pages:${limit}`
      
      // 尝试从缓存获取
      if (redis) {
        try {
          const cached = await redis.get(cacheKey)
          if (cached) {
            const pageIds = JSON.parse(cached)
            return await prisma.page.findMany({
              where: { id: { in: pageIds } },
              include: {
                versions: {
                  where: { validTo: null },
                  take: 1,
                  include: { stats: true }
                }
              }
            })
          }
        } catch (error) {
          // 缓存失败，继续查询数据库
        }
      }
      
      // 从数据库随机获取
      const where: any = {}
      if (tag) {
        where.versions = {
          some: {
            validTo: null,
            tags: { has: tag }
          }
        }
      }
      
      // 简化的随机查询（生产环境可以优化）
      const totalCount = await prisma.page.count({ where })
      const skip = Math.floor(Math.random() * Math.max(0, totalCount - limit))
      
      const pages = await prisma.page.findMany({
        where,
        skip,
        take: limit,
        include: {
          versions: {
            where: { validTo: null },
            take: 1,
            include: { stats: true }
          }
        }
      })
      
      // 缓存页面ID列表
      if (redis && pages.length > 0) {
        try {
          const pageIds = pages.map(p => p.id)
          await redis.setex(cacheKey, 300, JSON.stringify(pageIds))
        } catch (error) {
          // 缓存失败不影响功能
        }
      }
      
      return pages
    },

    // 随机趣味数据
    async randomTrivia(_: any, { limit = 5 }: { limit: number }, { prisma }: Context) {
      // 这里可以实现各种有趣的统计查询
      const triviaItems = []
      
      try {
        // 示例：找出第N个投票
        const totalVotes = await prisma.vote.count()
        if (totalVotes > 100000) {
          const nthVote = await prisma.vote.findFirst({
            skip: 100000 - 1,
            include: {
              user: true,
              pageVersion: {
                include: { page: true }
              }
            },
            orderBy: { timestamp: 'asc' }
          })
          
          if (nthVote) {
            triviaItems.push({
              id: 'nth-vote-100000',
              type: 'milestone',
              title: '第100,000个投票',
              content: `第100,000个投票来自用户 ${nthVote.user?.displayName || '匿名用户'}，投给了页面《${nthVote.pageVersion.title}》，投票类型：${nthVote.direction > 0 ? '点赞' : '点踩'}`,
              data: JSON.stringify({
                userId: nthVote.userId,
                pageId: nthVote.pageVersion.pageId,
                timestamp: nthVote.timestamp
              })
            })
          }
        }
        
        // 示例：源码最长的页面
        const longestPage = await prisma.contentRecords.findFirst({
          where: {
            recordType: 'longest_source',
            sourceLength: { not: null }
          },
          orderBy: {
            sourceLength: 'desc'
          },
          include: { page: true }
        })
        
        if (longestPage && longestPage.sourceLength) {
          triviaItems.push({
            id: 'longest-source',
            type: 'record',
            title: '源码最长页面',
            content: `目前源码最长的页面是《${longestPage.pageTitle}》，包含 ${longestPage.sourceLength} 个字符`,
            data: JSON.stringify({
              pageId: longestPage.pageId,
              length: longestPage.sourceLength
            })
          })
        }
        
        return triviaItems.slice(0, limit)
      } catch (error) {
        // 返回空数组而不是抛出错误
        return []
      }
    },

    // 搜索页面
    async searchPages(_: any, { query, first = 10 }: { query: string, first: number }, { prisma }: Context) {
      const items = await prisma.page.findMany({
        where: {
          versions: {
            some: {
              validTo: null,
              OR: [
                { title: { contains: query, mode: 'insensitive' } },
                { textContent: { contains: query, mode: 'insensitive' } }
              ]
            }
          }
        },
        take: first + 1,
        include: {
          versions: {
            where: { validTo: null },
            take: 1,
            include: { stats: true }
          }
        }
      })
      
      const pageInfo = buildPageInfo(items, first)
      
      return {
        edges: items.map(item => ({
          node: item,
          cursor: encodeCursor(item.id)
        })),
        pageInfo,
        totalCount: items.length // 搜索结果不提供精确总数
      }
    },

    // 搜索用户
    async searchUsers(_: any, { query, first = 10 }: { query: string, first: number }, { prisma }: Context) {
      const items = await prisma.user.findMany({
        where: {
          OR: [
            { displayName: { contains: query, mode: 'insensitive' } },
            { firstActivityDetails: { contains: query, mode: 'insensitive' } }
          ]
        },
        take: first + 1,
        include: { stats: true }
      })
      
      const pageInfo = buildPageInfo(items, first)
      
      return {
        edges: items.map(item => ({
          node: item,
          cursor: encodeCursor(item.id)
        })),
        pageInfo,
        totalCount: items.length // 搜索结果不提供精确总数
      }
    }
  },

  // 字段解析器
  Page: {
    currentVersion: async (page: any) => {
      return page.versions?.[0] || null
    },
    versions: async (page: any, { first = 20, after }: any, { prisma }: Context) => {
      const cursor = after ? { id: { gt: parseInt(decodeCursor(after)) } } : undefined
      const items = await prisma.pageVersion.findMany({
        where: { pageId: page.id, ...cursor },
        orderBy: { id: 'asc' },
        take: first + 1,
        include: { stats: true, attributions: { include: { user: true } } }
      })
      const pageInfo = buildPageInfo(items, first, after)
      return {
        edges: items.map(i => ({ node: i, cursor: encodeCursor(i.id) })),
        pageInfo,
        totalCount: await prisma.pageVersion.count({ where: { pageId: page.id } })
      }
    }
  },

  User: {
    votes: async (user: any, { first = 20, after }: any, { prisma }: Context) => {
      const cursor = after ? { id: { gt: parseInt(decodeCursor(after)) } } : undefined
      
      const items = await prisma.vote.findMany({
        where: { userId: user.id, ...cursor },
        orderBy: { timestamp: 'desc' },
        take: first + 1,
        include: {
          pageVersion: {
            include: { page: true }
          }
        }
      })
      
      const pageInfo = buildPageInfo(items, first, after)
      
      return {
        edges: items.map(item => ({
          node: item,
          cursor: encodeCursor(item.id)
        })),
        pageInfo,
        totalCount: await prisma.vote.count({ where: { userId: user.id } })
      }
    }
  },

  PageVersion: {
    votes: async (pv: any, { first = 20, after }: any, { prisma }: Context) => {
      const cursor = after ? { id: { gt: parseInt(decodeCursor(after)) } } : undefined
      const items = await prisma.vote.findMany({
        where: { pageVersionId: pv.id, ...cursor },
        orderBy: { timestamp: 'desc' },
        take: first + 1,
        include: { user: true }
      })
      const pageInfo = buildPageInfo(items, first, after)
      return {
        edges: items.map(i => ({ node: i, cursor: encodeCursor(i.id) })),
        pageInfo,
        totalCount: await prisma.vote.count({ where: { pageVersionId: pv.id } })
      }
    }
  },

  UserStats: {
    overallRating: (p: any) => toNum(p.overallRating),
    scpRating: (p: any) => toNum(p.scpRating),
    storyRating: (p: any) => toNum(p.storyRating),
    translationRating: (p: any) => toNum(p.translationRating),
    goiRating: (p: any) => toNum(p.goiRating),
    wanderersRating: (p: any) => toNum(p.wanderersRating),
    artRating: (p: any) => toNum(p.artRating)
  },

  PageStats: {
    wilson95: (p: any) => toNum(p.wilson95),
    controversy: (p: any) => toNum(p.controversy),
    likeRatio: (p: any) => toNum(p.likeRatio)
  },
  
  // 标量类型解析器
  DateTime: {
    serialize: (date: any) => date ? new Date(date).toISOString() : null,
    parseValue: (value: any) => value ? new Date(value) : null,
    parseLiteral: (ast: any) => ast.value ? new Date(ast.value) : null
  }
}

// 合并所有解析器
export const resolvers = {
  Query: {
    ...baseResolvers.Query,
    ...interestingStatsResolvers.Query
  },
  Page: baseResolvers.Page,
  PageVersion: baseResolvers.PageVersion,
  User: baseResolvers.User,
  UserStats: baseResolvers.UserStats,
  PageStats: baseResolvers.PageStats,
  DateTime: baseResolvers.DateTime,
  // 添加新的类型解析器
  InterestingFact: interestingStatsResolvers.InterestingFact,
  TagRecord: interestingStatsResolvers.TagRecord,
  ContentRecord: interestingStatsResolvers.ContentRecord,
  RatingRecord: interestingStatsResolvers.RatingRecord,
  TimeMilestone: interestingStatsResolvers.TimeMilestone,
  UserActivityRecord: interestingStatsResolvers.UserActivityRecord,
  TrendingStat: interestingStatsResolvers.TrendingStat
}