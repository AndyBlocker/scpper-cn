import { PrismaClient } from '@prisma/client';
import { CacheService } from './cache.service.js';
import { SiteStatsDTO, InterestingStatsDTO } from '../types/dto.js';
import { CACHE_TTL } from '../types/cache.js';

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
    
    return {
      totalUsers: Number(stats[0]?.totalUsers || 0),
      activeUsers: Number(stats[0]?.activeUsers || 0),
      totalPages: Number(stats[0]?.totalPages || 0),
      totalVotes: Number(stats[0]?.totalVotes || 0),
      lastUpdated: stats[0]?.lastUpdated?.toISOString() || new Date().toISOString(),
    };
  }

  private async getCategoryStats() {
    const result = await this.prisma.$queryRaw<any[]>`
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
    
    // Convert BigInt values to numbers
    return result.map(row => ({
      ...row,
      pageCount: Number(row.pageCount),
      avgRating: row.avgRating ? Number(row.avgRating) : null,
      totalVotes: row.totalVotes ? Number(row.totalVotes) : null,
      maxRating: row.maxRating ? Number(row.maxRating) : null,
      minRating: row.minRating ? Number(row.minRating) : null,
    }));
  }

  private async getTopTags(limit: number) {
    const result = await this.prisma.$queryRaw<any[]>`
      SELECT 
        tag,
        COUNT(*) as count
      FROM (
        SELECT unnest(tags) as tag
        FROM "PageVersion"
        WHERE "validTo" IS NULL AND NOT "isDeleted"
      ) tag_list
      WHERE tag != '原创' AND tag != '译文'
      GROUP BY tag
      ORDER BY count DESC
      LIMIT ${limit}
    `;
    
    return result.map(r => ({
      tag: r.tag,
      count: Number(r.count),
    }));
  }

  private async getRatingDistribution() {
    const result = await this.prisma.$queryRaw<any[]>`
      SELECT 
        CASE
          WHEN rating >= 100 THEN '100+'
          WHEN rating >= 50 THEN '50-99'
          WHEN rating >= 20 THEN '20-49'
          WHEN rating >= 10 THEN '10-19'
          WHEN rating >= 0 THEN '0-9'
          WHEN rating >= -10 THEN '-1 to -10'
          ELSE '-10 or lower'
        END as range,
        COUNT(*) as count
      FROM "PageVersion"
      WHERE "validTo" IS NULL AND NOT "isDeleted"
      GROUP BY 
        CASE
          WHEN rating >= 100 THEN '100+'
          WHEN rating >= 50 THEN '50-99'
          WHEN rating >= 20 THEN '20-49'
          WHEN rating >= 10 THEN '10-19'
          WHEN rating >= 0 THEN '0-9'
          WHEN rating >= -10 THEN '-1 to -10'
          ELSE '-10 or lower'
        END
      ORDER BY count DESC
    `;
    
    return result.map(r => ({
      range: r.range,
      count: Number(r.count),
    }));
  }

  private async getTopContributors(limit: number) {
    const result = await this.prisma.$queryRaw<any[]>`
      SELECT 
        u.id,
        u."displayName",
        u."wikidotId",
        COUNT(a.id) as "contributionCount"
      FROM "User" u
      JOIN "Attribution" a ON u.id = a."userId"
      JOIN "PageVersion" pv ON a."pageVerId" = pv.id
      WHERE pv."validTo" IS NULL AND NOT pv."isDeleted"
      GROUP BY u.id, u."displayName", u."wikidotId"
      ORDER BY "contributionCount" DESC
      LIMIT ${limit}
    `;
    
    return result.map(r => ({
      user: {
        id: r.id,
        displayName: r.displayName,
        wikidotId: r.wikidotId,
        karma: 0, // Default karma value
        firstActivityAt: undefined,
        lastActivityAt: undefined,
        createdAt: '',
      },
      contributionCount: Number(r.contributionCount),
    }));
  }

  private async getRecentActivity() {
    // 获取最近活动统计
    const result = await this.prisma.$queryRaw<any[]>`
      SELECT 
        DATE(pv."createdAt") as date,
        COUNT(*) as "newPages"
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL 
        AND pv."createdAt" >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE(pv."createdAt")
      ORDER BY date DESC
      LIMIT 30
    `;
    
    return result.map(r => ({
      date: r.date,
      newPages: Number(r.newPages),
    }));
  }

  async getInterestingStats(options?: {
    limit?: number;
    category?: string;
    random?: boolean;
    randomPerCategory?: boolean;
  }): Promise<InterestingStatsDTO> {
    // 对于随机查询，我们不使用缓存，确保每次都是不同的结果
    const useCache = !options?.random && !options?.randomPerCategory;
    const cacheKey = useCache 
      ? `stats:interesting:${options?.limit || 'all'}:${options?.category || 'all'}`
      : null;
    
    const executeQuery = async () => {
        // 如果需要每个类别随机一个
        if (options?.randomPerCategory) {
          return await this.getRandomPerCategory(options.limit || 1);
        }

        // 构建查询条件
        const whereClause: any = { isActive: true };
        if (options?.category) {
          whereClause.category = options.category;
        }

        let orderByClause: any[] = [
          { category: 'asc' },
          { type: 'asc' },
          { rank: 'asc' }
        ];

        // 如果需要随机排序
        if (options?.random) {
          let facts: any[];
          
          if (options.category) {
            facts = await this.prisma.$queryRaw<any[]>`
              SELECT * FROM "InterestingFacts"
              WHERE "isActive" = true AND category = ${options.category}
              ORDER BY RANDOM()
              LIMIT ${options.limit || 50}
            `;
          } else {
            facts = await this.prisma.$queryRaw<any[]>`
              SELECT * FROM "InterestingFacts"
              WHERE "isActive" = true
              ORDER BY RANDOM()
              LIMIT ${options.limit || 50}
            `;
          }
          
          // 手动include关联数据
          const factsWithIncludes = await Promise.all(
            facts.map(async (fact) => {
              const page = fact.pageId ? await this.prisma.page.findUnique({
                where: { id: fact.pageId },
                select: { url: true }
              }) : null;
              
              const user = fact.userId ? await this.prisma.user.findUnique({
                where: { id: fact.userId },
                select: { displayName: true, wikidotId: true }
              }) : null;
              
              return {
                ...fact,
                Page: page,
                User: user
              };
            })
          );
          
          return this.formatInterestingStatsResponse(factsWithIncludes, { 
            perCategoryLimit: options.limit 
          });
        }

        // 普通查询
        const facts = await this.prisma.interestingFacts.findMany({
          where: whereClause,
          include: {
            Page: {
              select: {
                url: true
              }
            },
            User: {
              select: {
                displayName: true,
                wikidotId: true
              }
            }
          },
          orderBy: orderByClause,
          take: options?.limit
        });

        return this.formatInterestingStatsResponse(facts, { 
          perCategoryLimit: options?.limit 
        });
    };

    // 根据是否使用缓存来决定执行方式
    if (useCache && cacheKey) {
      return this.cache.getOrSet(cacheKey, executeQuery, CACHE_TTL.SITE_STATS);
    } else {
      return executeQuery();
    }
  }

  /**
   * 每个类别随机获取指定数量的记录
   */
  private async getRandomPerCategory(limitPerCategory: number = 1) {
    const categories = ['time_milestone', 'tag_record', 'content_record', 'rating_record', 'rating_milestone', 'user_activity_record'];
    
    const allFacts: any[] = [];
    
    for (const category of categories) {
      try {
        const facts = await this.prisma.$queryRaw<any[]>`
          SELECT * FROM "InterestingFacts"
          WHERE "isActive" = true AND category = ${category}
          ORDER BY RANDOM()
          LIMIT ${limitPerCategory}
        `;
        
        // 手动include关联数据
        const factsWithIncludes = await Promise.all(
          facts.map(async (fact) => {
            const page = fact.pageId ? await this.prisma.page.findUnique({
              where: { id: fact.pageId },
              select: { url: true }
            }) : null;
            
            const user = fact.userId ? await this.prisma.user.findUnique({
              where: { id: fact.userId },
              select: { displayName: true, wikidotId: true }
            }) : null;
            
            return {
              ...fact,
              Page: page,
              User: user
            };
          })
        );
        
        allFacts.push(...factsWithIncludes);
      } catch (error) {
        console.warn(`Failed to get random facts for category ${category}:`, error);
      }
    }
    
    return this.formatInterestingStatsResponse(allFacts, { perCategoryLimit: limitPerCategory });
  }

  /**
   * 格式化有趣事实响应数据
   */
  private async formatInterestingStatsResponse(facts: any[], options?: { perCategoryLimit?: number }) {
    const limit = options?.perCategoryLimit || 50; // 每个类别的默认限制
    
    // 按类别分组整理数据，并应用每类别限制
    const timeMilestones = facts
      .filter(f => f.category === 'time_milestone')
      .slice(0, limit)
      .map(f => this.formatInterestingFact(f));

    const tagRecords = facts
      .filter(f => f.category === 'tag_record')
      .slice(0, limit)
      .map(f => this.formatInterestingFact(f));

    const contentRecords = facts
      .filter(f => f.category === 'content_record')
      .slice(0, limit)
      .map(f => this.formatInterestingFact(f));

    const ratingRecords = facts
      .filter(f => f.category === 'rating_record' || f.category === 'rating_milestone')
      .slice(0, limit)
      .map(f => this.formatInterestingFact(f));

    const userActivityRecords = facts
      .filter(f => f.category === 'user_activity_record')
      .slice(0, limit)
      .map(f => this.formatInterestingFact(f));

    // 趋势统计仍然实时计算（因为需要最新数据）
    const trendingStats = await this.getTrendingStats();

    return {
      timeMilestones,
      tagRecords,
      contentRecords,
      ratingRecords,
      userActivityRecords,
      trendingStats,
    };
  }

  /**
   * 格式化有趣事实数据为统一格式
   */
  private formatInterestingFact(fact: any) {
    const metadata = fact.metadata || {};
    
    return {
      title: fact.title,
      description: fact.description,
      value: fact.value,
      metadata: {
        ...metadata,
        pageUrl: fact.Page?.url,
        userDisplayName: fact.User?.displayName,
        userWikidotId: fact.User?.wikidotId,
        calculatedAt: fact.calculatedAt,
        category: fact.category,
        type: fact.type,
        rank: fact.rank
      }
    };
  }


  private async getTrendingStats() {
    // 趋势统计 - 最近7天最受关注的页面
    const result = await this.prisma.$queryRaw<any[]>`
      SELECT 
        p.url,
        pv.title,
        pv.rating,
        COUNT(v.id) as "recentVotes"
      FROM "Page" p
      JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      LEFT JOIN "Vote" v ON pv.id = v."pageVersionId" 
        AND v.timestamp >= CURRENT_DATE - INTERVAL '7 days'
      WHERE NOT pv."isDeleted"
      GROUP BY p.url, pv.title, pv.rating
      HAVING COUNT(v.id) > 0
      ORDER BY "recentVotes" DESC, pv.rating DESC
      LIMIT 10
    `;
    
    // Convert BigInt values to numbers
    return result.map(row => ({
      ...row,
      recentVotes: Number(row.recentVotes)
    }));
  }
}