import { PrismaClient, Prisma } from '@prisma/client';
import { CacheService } from './cache.service.js';
import { logger } from '../utils/logger.js';

export interface RatingHistoryParams {
  period?: 'daily' | 'weekly' | 'monthly';
  duration?: '30d' | '90d' | '1y' | 'all';
  category?: 'overall' | 'scp' | 'story' | 'translation' | 'goi' | 'art' | 'wanderers';
}

export interface RatingHistoryPoint {
  date: string;
  rating: number;
  dailyChange: number;
  voteCount?: number;
  upvotes?: number;
  downvotes?: number;
}

export interface RatingHistoryDTO {
  entity: {
    type: 'user' | 'page';
    id: number;
    name: string;
  };
  period: string;
  duration: string;
  category: string;
  history: RatingHistoryPoint[];
  summary: {
    currentRating: number;
    highestRating: number;
    lowestRating: number;
    totalChange: number;
    trendDirection: 'upward' | 'downward' | 'stable';
  };
}

export class RatingHistoryService {
  constructor(
    private prisma: PrismaClient,
    private cache: CacheService
  ) {}

  /**
   * 获取用户rating历史 - 混合策略
   */
  async getUserRatingHistory(
    identifier: string, 
    params: RatingHistoryParams
  ): Promise<RatingHistoryDTO> {
    const cacheKey = `user_rating_history:${identifier}:${JSON.stringify(params)}`;
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const duration = params.duration || '90d';
        const category = params.category || 'overall';
        
        // 获取用户信息
        const user = await this.findUser(identifier);
        
        // 根据时间范围选择不同策略
        const history = await this.getHistoryByStrategy(
          'user', 
          user.id, 
          category, 
          duration
        );
        
        return this.formatRatingHistory('user', user, history, params);
      },
      this.getCacheTTL(params.duration || '90d')
    );
  }

  /**
   * 获取页面rating历史 - 混合策略  
   */
  async getPageRatingHistory(
    identifier: string,
    params: RatingHistoryParams
  ): Promise<RatingHistoryDTO> {
    const cacheKey = `page_rating_history:${identifier}:${JSON.stringify(params)}`;
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const duration = params.duration || '90d';
        
        // 获取页面信息
        const page = await this.findPage(identifier);
        
        const history = await this.getHistoryByStrategy(
          'page',
          page.id,
          'overall', // 页面只有overall category
          duration
        );
        
        return this.formatRatingHistory('page', page, history, params);
      },
      this.getCacheTTL(params.duration || '90d')
    );
  }

  /**
   * 分层策略选择
   */
  private async getHistoryByStrategy(
    entityType: 'user' | 'page',
    entityId: number,
    category: string,
    duration: string
  ): Promise<RatingHistoryPoint[]> {
    const now = new Date();
    const durationDays = this.parseDuration(duration);
    
    if (durationDays <= 30) {
      // 热数据：实时计算
      return await this.calculateRealtimeHistory(entityType, entityId, category, duration);
    } else if (durationDays <= 365) {
      // 温数据：混合策略（预聚合 + 实时）
      return await this.getHybridHistory(entityType, entityId, category, duration);
    } else {
      // 冷数据：完全使用预聚合
      return await this.getPreAggregatedHistory(entityType, entityId, category, duration);
    }
  }

  /**
   * 热数据：实时计算（最近30天）
   */
  private async calculateRealtimeHistory(
    entityType: 'user' | 'page',
    entityId: number,
    category: string,
    duration: string
  ): Promise<RatingHistoryPoint[]> {
    logger.info(`Calculating realtime history for ${entityType}:${entityId}`);
    
    if (entityType === 'user') {
      return await this.calculateUserRealtimeHistory(entityId, category, duration);
    } else {
      return await this.calculatePageRealtimeHistory(entityId, duration);
    }
  }

  /**
   * 温数据：混合策略（30天-1年）
   */
  private async getHybridHistory(
    entityType: 'user' | 'page',
    entityId: number,
    category: string,
    duration: string
  ): Promise<RatingHistoryPoint[]> {
    logger.info(`Getting hybrid history for ${entityType}:${entityId}`);
    
    // 获取预聚合的历史数据（30天前开始）
    const preAggregated = await this.getPreAggregatedHistory(
      entityType, 
      entityId, 
      category, 
      this.getOlderDuration(duration)
    );
    
    // 获取最近30天的实时数据
    const recent = await this.calculateRealtimeHistory(entityType, entityId, category, '30d');
    
    // 合并数据
    return this.mergeHistoryData(preAggregated, recent);
  }

  /**
   * 冷数据：使用预聚合（1年以上）
   */
  private async getPreAggregatedHistory(
    entityType: 'user' | 'page',
    entityId: number,
    category: string,
    duration: string
  ): Promise<RatingHistoryPoint[]> {
    logger.info(`Getting pre-aggregated history for ${entityType}:${entityId}`);
    
    const period = this.getOptimalPeriod(duration);
    const startDate = this.getStartDate(duration);
    
    const results = await this.prisma.$queryRaw<any[]>`
      SELECT 
        date,
        rating,
        "dailyChange",
        "voteCount"
      FROM "RatingHistoryCache"
      WHERE "entityType" = ${entityType}
        AND "entityId" = ${entityId}
        AND "category" = ${category}
        AND "period" = ${period}
        AND date >= ${startDate}
      ORDER BY date ASC
    `;
    
    return results.map(r => ({
      date: r.date.toISOString().split('T')[0],
      rating: Number(r.rating),
      dailyChange: Number(r.dailyChange),
      voteCount: Number(r.voteCount)
    }));
  }

  /**
   * 用户实时历史计算
   */
  private async calculateUserRealtimeHistory(
    userId: number,
    category: string,
    duration: string
  ): Promise<RatingHistoryPoint[]> {
    // 根据category构建不同的查询
    let categoryFilter = '';
    if (category !== 'overall') {
      const tagFilters = this.getCategoryTags(category);
      categoryFilter = `AND pv.tags && ARRAY[${tagFilters.map(t => `'${t}'`).join(',')}]::text[]`;
    }
    
    const results = await this.prisma.$queryRaw<any[]>`
      WITH user_pages AS (
        SELECT DISTINCT pv."pageId", pv.id as "pageVersionId"
        FROM "Attribution" a
        JOIN "PageVersion" pv ON a."pageVerId" = pv.id
        WHERE a."userId" = ${userId}
          AND pv."validTo" IS NULL
          ${categoryFilter ? Prisma.raw(categoryFilter) : Prisma.empty}
      ),
      daily_votes AS (
        SELECT 
          v.timestamp::date as date,
          SUM(v.direction) as daily_change,
          COUNT(*) as vote_count
        FROM "Vote" v
        JOIN user_pages up ON v."pageVersionId" = up."pageVersionId"
        WHERE v.timestamp >= NOW() - INTERVAL '${duration}'
        GROUP BY v.timestamp::date
        ORDER BY date
      )
      SELECT 
        date,
        daily_change,
        vote_count,
        SUM(daily_change) OVER (ORDER BY date) as cumulative_rating
      FROM daily_votes
    `;
    
    return results.map(r => ({
      date: r.date.toISOString().split('T')[0],
      rating: Number(r.cumulative_rating),
      dailyChange: Number(r.daily_change),
      voteCount: Number(r.vote_count)
    }));
  }

  /**
   * 页面实时历史计算
   */
  private async calculatePageRealtimeHistory(
    pageId: number,
    duration: string
  ): Promise<RatingHistoryPoint[]> {
    const pageVersion = await this.prisma.pageVersion.findFirst({
      where: { pageId, validTo: null }
    });
    
    if (!pageVersion) throw new Error('Page version not found');
    
    const results = await this.prisma.$queryRaw<any[]>`
      WITH daily_votes AS (
        SELECT 
          timestamp::date as date,
          SUM(direction) as daily_change,
          COUNT(CASE WHEN direction > 0 THEN 1 END) as upvotes,
          COUNT(CASE WHEN direction < 0 THEN 1 END) as downvotes,
          COUNT(*) as vote_count
        FROM "Vote"
        WHERE "pageVersionId" = ${pageVersion.id}
          AND timestamp >= NOW() - INTERVAL '${duration}'
        GROUP BY timestamp::date
        ORDER BY date
      )
      SELECT 
        date,
        daily_change,
        upvotes,
        downvotes,
        vote_count,
        SUM(daily_change) OVER (ORDER BY date) as cumulative_rating
      FROM daily_votes
    `;
    
    return results.map(r => ({
      date: r.date.toISOString().split('T')[0],
      rating: Number(r.cumulative_rating),
      dailyChange: Number(r.daily_change),
      voteCount: Number(r.vote_count),
      upvotes: Number(r.upvotes),
      downvotes: Number(r.downvotes)
    }));
  }

  /**
   * 预聚合任务 - 由定时任务调用
   */
  async preAggregateRatingHistory() {
    logger.info('Starting rating history pre-aggregation');
    
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    // 聚合所有活跃用户的rating历史
    await this.aggregateUsersRatingHistory(yesterday);
    
    // 聚合所有页面的rating历史  
    await this.aggregatePagesRatingHistory(yesterday);
    
    logger.info('Completed rating history pre-aggregation');
  }

  /**
   * 聚合用户rating历史
   */
  private async aggregateUsersRatingHistory(date: Date) {
    const activeUsers = await this.prisma.user.findMany({
      where: {
        lastActivityAt: {
          gte: new Date(date.getTime() - 90 * 24 * 60 * 60 * 1000) // 最近90天活跃
        }
      },
      select: { id: true }
    });
    
    for (const user of activeUsers) {
      for (const category of ['overall', 'scp', 'story', 'translation', 'goi']) {
        await this.aggregateUserRatingForDate(user.id, category, date);
      }
    }
  }

  /**
   * 为特定日期聚合用户rating
   */
  private async aggregateUserRatingForDate(userId: number, category: string, date: Date) {
    // 计算该日期的rating变化
    const dailyRating = await this.calculateUserDailyRating(userId, category, date);
    
    if (dailyRating.voteCount > 0) {
      // 存储或更新聚合数据
      await this.prisma.$executeRaw`
        INSERT INTO "RatingHistoryCache" 
        ("entityType", "entityId", "category", "date", "rating", "dailyChange", "voteCount", "period")
        VALUES ('user', ${userId}, ${category}, ${date}, ${dailyRating.cumulativeRating}, ${dailyRating.dailyChange}, ${dailyRating.voteCount}, 'daily')
        ON CONFLICT ("entityType", "entityId", "category", "date", "period")
        DO UPDATE SET 
          "rating" = ${dailyRating.cumulativeRating},
          "dailyChange" = ${dailyRating.dailyChange},
          "voteCount" = ${dailyRating.voteCount},
          "updatedAt" = NOW()
      `;
    }
  }

  // 辅助方法
  private getCacheTTL(duration: string): number {
    const ttlMap = {
      '30d': 1800,    // 30分钟
      '90d': 3600,    // 1小时
      '1y': 7200,     // 2小时
      'all': 21600,   // 6小时
    };
    return ttlMap[duration as keyof typeof ttlMap] || 1800;
  }

  private parseDuration(duration: string): number {
    const map = {
      '30d': 30,
      '90d': 90, 
      '1y': 365,
      'all': 9999
    };
    return map[duration as keyof typeof map] || 90;
  }

  private getOptimalPeriod(duration: string): 'daily' | 'weekly' | 'monthly' {
    const days = this.parseDuration(duration);
    if (days <= 90) return 'daily';
    if (days <= 365) return 'weekly';
    return 'monthly';
  }

  private getCategoryTags(category: string): string[] {
    const tagMap = {
      scp: ['scp', '原创'],
      story: ['故事', '原创'],
      translation: [], // 不包含'原创'
      goi: ['goi格式', '原创'],
      art: ['艺术作品', '原创'],
      wanderers: ['wanderers', '原创']
    };
    return tagMap[category as keyof typeof tagMap] || [];
  }

  private calculateTrend(history: RatingHistoryPoint[]): 'upward' | 'downward' | 'stable' {
    if (history.length < 2) return 'stable';
    
    const recent = history.slice(-7); // 最近7个点
    const trend = recent[recent.length - 1].rating - recent[0].rating;
    
    if (trend > 10) return 'upward';
    if (trend < -10) return 'downward';
    return 'stable';
  }

  private formatRatingHistory(
    entityType: 'user' | 'page',
    entity: any,
    history: RatingHistoryPoint[],
    params: RatingHistoryParams
  ): RatingHistoryDTO {
    const ratings = history.map(h => h.rating);
    
    return {
      entity: {
        type: entityType,
        id: entity.id,
        name: entityType === 'user' ? entity.displayName : entity.title
      },
      period: params.period || 'daily',
      duration: params.duration || '90d',
      category: params.category || 'overall',
      history,
      summary: {
        currentRating: ratings[ratings.length - 1] || 0,
        highestRating: Math.max(...ratings),
        lowestRating: Math.min(...ratings),
        totalChange: (ratings[ratings.length - 1] || 0) - (ratings[0] || 0),
        trendDirection: this.calculateTrend(history)
      }
    };
  }

  // 省略一些辅助方法的具体实现...
  private async findUser(identifier: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { id: isNaN(parseInt(identifier)) ? undefined : parseInt(identifier) },
          { wikidotId: isNaN(parseInt(identifier)) ? undefined : parseInt(identifier) },
          { displayName: identifier },
        ],
      },
    });
    
    if (!user) {
      throw new Error('User not found');
    }
    
    return user;
  }
  private async findPage(identifier: string) {
    const page = await this.prisma.page.findFirst({
      where: {
        OR: [
          { url: identifier },
          { urlKey: identifier },
          { pageUuid: identifier },
        ],
      },
      include: {
        PageVersion: {
          where: { validTo: null },
        },
      },
    });
    
    if (!page || !page.PageVersion.length) {
      throw new Error('Page not found');
    }
    
    return { ...page, ...page.PageVersion[0] };
  }
  private mergeHistoryData(old: RatingHistoryPoint[], recent: RatingHistoryPoint[]): RatingHistoryPoint[] {
    const merged = [...old];
    
    for (const recentPoint of recent) {
      const existingIndex = merged.findIndex(p => p.date === recentPoint.date);
      if (existingIndex >= 0) {
        merged[existingIndex] = recentPoint;
      } else {
        merged.push(recentPoint);
      }
    }
    
    return merged.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }
  private getOlderDuration(duration: string): string {
    const map = {
      '30d': '90d',
      '90d': '1y',
      '1y': 'all',
      'all': 'all'
    };
    return map[duration as keyof typeof map] || '90d';
  }
  private getStartDate(duration: string): Date {
    const days = this.parseDuration(duration);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    return startDate;
  }
  private async aggregatePagesRatingHistory(date: Date): Promise<void> {
    console.log(`Aggregating pages rating history for ${date.toISOString().split('T')[0]}`);
    
    const pages = await this.prisma.$queryRaw<Array<{ pageId: number }>>`
      SELECT DISTINCT pv."pageId" as "pageId"
      FROM "Vote" v
      JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
      WHERE DATE(v."timestamp") = ${date}::date
    `;
    
    for (const { pageId } of pages) {
      await this.aggregatePageRatingForDate(pageId, 'overall', date);
    }
  }

  private async aggregatePageRatingForDate(pageId: number, category: string, date: Date): Promise<void> {
    const dailyRating = await this.calculatePageDailyRating(pageId, category, date);
    
    if (dailyRating.voteCount > 0) {
      await this.prisma.$executeRaw`
        INSERT INTO "RatingHistoryCache" 
        ("entityType", "entityId", "category", "date", "rating", "dailyChange", "voteCount", "period")
        VALUES ('page', ${pageId}, ${category}, ${date}, ${dailyRating.cumulativeRating}, ${dailyRating.dailyChange}, ${dailyRating.voteCount}, 'daily')
        ON CONFLICT ("entityType", "entityId", "category", "date", "period")
        DO UPDATE SET 
          "rating" = ${dailyRating.cumulativeRating},
          "dailyChange" = ${dailyRating.dailyChange},
          "voteCount" = ${dailyRating.voteCount},
          "updatedAt" = NOW()
      `;
    }
  }

  private async calculatePageDailyRating(pageId: number, category: string, date: Date): Promise<{
    cumulativeRating: number;
    dailyChange: number;
    voteCount: number;
  }> {
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    
    const result = await this.prisma.$queryRaw<Array<{
      cumulativeRating: number;
      voteCount: number;
    }>>`
      SELECT 
        COALESCE(pv.rating, 0) as "cumulativeRating",
        COUNT(v.id) as "voteCount"
      FROM "PageVersion" pv
      LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id AND v."timestamp" <= ${endOfDay}
      WHERE pv."pageId" = ${pageId}
        AND pv."validTo" IS NULL
        AND pv."isDeleted" = false
      GROUP BY pv.rating
    `;
    
    const dayBeforeResult = await this.prisma.$queryRaw<Array<{
      previousRating: number;
    }>>`
      SELECT 
        COALESCE(pv.rating, 0) as "previousRating"
      FROM "PageVersion" pv
      LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id AND v."timestamp" < ${date}
      WHERE pv."pageId" = ${pageId}
        AND pv."validTo" IS NULL
        AND pv."isDeleted" = false
      GROUP BY pv.rating
    `;
    
    const current = result[0] || { cumulativeRating: 0, voteCount: 0 };
    const previous = dayBeforeResult[0] || { previousRating: 0 };
    
    return {
      cumulativeRating: Number(current.cumulativeRating),
      dailyChange: Number(current.cumulativeRating) - Number(previous.previousRating),
      voteCount: Number(current.voteCount)
    };
  }
  private async calculateUserDailyRating(userId: number, category: string, date: Date): Promise<{
    cumulativeRating: number;
    dailyChange: number;
    voteCount: number;
  }> {
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    
    const categoryTags = this.getCategoryTags(category);
    
    const result = await this.prisma.$queryRaw<Array<{
      cumulativeRating: number;
      voteCount: number;
    }>>`
      SELECT 
        COALESCE(SUM(pv.rating), 0) as "cumulativeRating",
        COUNT(DISTINCT v.id) as "voteCount"
      FROM "Attribution" a
      JOIN "PageVersion" pv ON a."pageVerId" = pv.id
      JOIN "Vote" v ON v."pageVersionId" = pv.id
      WHERE a."userId" = ${userId}
        AND v."timestamp" <= ${endOfDay}
        AND pv."validTo" IS NULL
        AND pv."isDeleted" = false
        ${category !== 'overall' ? `AND pv.tags && ${categoryTags}::text[]` : ''}
    `;
    
    const dayBeforeResult = await this.prisma.$queryRaw<Array<{
      previousRating: number;
    }>>`
      SELECT 
        COALESCE(SUM(pv.rating), 0) as "previousRating"
      FROM "Attribution" a
      JOIN "PageVersion" pv ON a."pageVerId" = pv.id
      JOIN "Vote" v ON v."pageVersionId" = pv.id
      WHERE a."userId" = ${userId}
        AND v."timestamp" < ${date}
        AND pv."validTo" IS NULL
        AND pv."isDeleted" = false
        ${category !== 'overall' ? `AND pv.tags && ${categoryTags}::text[]` : ''}
    `;
    
    const current = result[0] || { cumulativeRating: 0, voteCount: 0 };
    const previous = dayBeforeResult[0] || { previousRating: 0 };
    
    return {
      cumulativeRating: Number(current.cumulativeRating),
      dailyChange: Number(current.cumulativeRating) - Number(previous.previousRating),
      voteCount: Number(current.voteCount)
    };
  }
}