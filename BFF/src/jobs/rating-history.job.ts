import { CronJob } from 'cron';
import { PrismaClient } from '@prisma/client';
import { CacheService } from '../services/cache.service.js';
import { RatingHistoryService } from '../services/rating-history.service.js';
import { logger } from '../utils/logger.js';

export class RatingHistoryJob {
  private prisma: PrismaClient;
  private cache: CacheService;
  private ratingHistoryService: RatingHistoryService;
  private jobs: CronJob[] = [];

  constructor() {
    this.prisma = new PrismaClient();
    this.cache = new CacheService();
    this.ratingHistoryService = new RatingHistoryService(this.prisma, this.cache);
  }

  /**
   * 启动所有rating历史相关的定时任务
   */
  start() {
    // 1. 每日预聚合任务 - 每天凌晨2点运行
    this.jobs.push(new CronJob(
      '0 2 * * *', // 每天凌晨2点
      async () => {
        try {
          logger.info('Starting daily rating history aggregation');
          await this.ratingHistoryService.preAggregateRatingHistory();
          logger.info('Completed daily rating history aggregation');
        } catch (error) {
          logger.error('Daily rating aggregation failed:', error);
        }
      },
      null,
      true,
      'Asia/Shanghai'
    ));

    // 2. 每周聚合任务 - 每周一凌晨3点
    this.jobs.push(new CronJob(
      '0 3 * * 1', // 每周一凌晨3点
      async () => {
        try {
          logger.info('Starting weekly rating history aggregation');
          await this.aggregateWeeklyData();
          logger.info('Completed weekly rating history aggregation');
        } catch (error) {
          logger.error('Weekly rating aggregation failed:', error);
        }
      },
      null,
      true,
      'Asia/Shanghai'
    ));

    // 3. 每月聚合任务 - 每月1号凌晨4点
    this.jobs.push(new CronJob(
      '0 4 1 * *', // 每月1号凌晨4点
      async () => {
        try {
          logger.info('Starting monthly rating history aggregation');
          await this.aggregateMonthlyData();
          logger.info('Completed monthly rating history aggregation');
        } catch (error) {
          logger.error('Monthly rating aggregation failed:', error);
        }
      },
      null,
      true,
      'Asia/Shanghai'
    ));

    // 4. 缓存清理任务 - 每小时运行
    this.jobs.push(new CronJob(
      '0 * * * *', // 每小时
      async () => {
        try {
          await this.cleanupExpiredCache();
        } catch (error) {
          logger.error('Cache cleanup failed:', error);
        }
      },
      null,
      true,
      'Asia/Shanghai'
    ));

    logger.info(`Started ${this.jobs.length} rating history jobs`);
  }

  /**
   * 停止所有定时任务
   */
  stop() {
    this.jobs.forEach(job => job.stop());
    this.jobs = [];
    logger.info('Stopped all rating history jobs');
  }

  /**
   * 聚合周度数据
   */
  private async aggregateWeeklyData() {
    // 将过去7天的daily数据聚合为weekly
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);

    await this.prisma.$executeRaw`
      INSERT INTO "RatingHistoryCache" 
      ("entityType", "entityId", "category", "date", "rating", "dailyChange", "voteCount", "period")
      SELECT 
        "entityType",
        "entityId", 
        "category",
        DATE_TRUNC('week', date) as week_date,
        AVG(rating) as avg_rating,
        SUM("dailyChange") as total_change,
        SUM("voteCount") as total_votes,
        'weekly' as period
      FROM "RatingHistoryCache"
      WHERE period = 'daily'
        AND date >= ${lastWeek}
        AND date < CURRENT_DATE
      GROUP BY "entityType", "entityId", "category", DATE_TRUNC('week', date)
      ON CONFLICT ("entityType", "entityId", "category", "date", "period")
      DO UPDATE SET
        "rating" = EXCLUDED."rating",
        "dailyChange" = EXCLUDED."dailyChange", 
        "voteCount" = EXCLUDED."voteCount",
        "updatedAt" = NOW()
    `;
  }

  /**
   * 聚合月度数据
   */
  private async aggregateMonthlyData() {
    // 将上个月的daily数据聚合为monthly
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    lastMonth.setDate(1);

    await this.prisma.$executeRaw`
      INSERT INTO "RatingHistoryCache"
      ("entityType", "entityId", "category", "date", "rating", "dailyChange", "voteCount", "period")
      SELECT 
        "entityType",
        "entityId",
        "category", 
        DATE_TRUNC('month', date) as month_date,
        AVG(rating) as avg_rating,
        SUM("dailyChange") as total_change,
        SUM("voteCount") as total_votes,
        'monthly' as period
      FROM "RatingHistoryCache"
      WHERE period = 'daily'
        AND date >= ${lastMonth}
        AND date < DATE_TRUNC('month', CURRENT_DATE)
      GROUP BY "entityType", "entityId", "category", DATE_TRUNC('month', date)
      ON CONFLICT ("entityType", "entityId", "category", "date", "period") 
      DO UPDATE SET
        "rating" = EXCLUDED."rating",
        "dailyChange" = EXCLUDED."dailyChange",
        "voteCount" = EXCLUDED."voteCount", 
        "updatedAt" = NOW()
    `;
  }

  /**
   * 清理过期缓存
   */
  private async cleanupExpiredCache() {
    // 清理rating history相关的缓存
    await this.cache.invalidate([
      'user_rating_history:*',
      'page_rating_history:*',
      'recent_rating:*'
    ]);

    // 清理90天前的daily记录（保留weekly/monthly）
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    await this.prisma.$executeRaw`
      DELETE FROM "RatingHistoryCache"
      WHERE period = 'daily'
        AND date < ${ninetyDaysAgo}
    `;
  }

  /**
   * 手动触发特定实体的重新聚合
   */
  async reAggregateEntity(entityType: 'user' | 'page', entityId: number) {
    logger.info(`Re-aggregating ${entityType}:${entityId}`);
    
    // 删除现有缓存
    await this.cache.invalidate([
      `${entityType}_rating_history:${entityId}:*`,
      `recent_rating:${entityId}`
    ]);

    // 删除预聚合数据，强制重新计算
    await this.prisma.$executeRaw`
      DELETE FROM "RatingHistoryCache"
      WHERE "entityType" = ${entityType}
        AND "entityId" = ${entityId}
    `;

    // 重新聚合最近90天的数据
    const categories = entityType === 'user' 
      ? ['overall', 'scp', 'story', 'translation', 'goi', 'art'] 
      : ['overall'];

    for (let i = 90; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      
      for (const category of categories) {
        if (entityType === 'user') {
          await this.ratingHistoryService['aggregateUserRatingForDate'](entityId, category, date);
        } else {
          // 实现页面的重新聚合
          await this.aggregatePageRatingForDate(entityId, date);
        }
      }
    }

    logger.info(`Completed re-aggregation for ${entityType}:${entityId}`);
  }

  private async aggregatePageRatingForDate(pageId: number, date: Date) {
    // 实现页面特定日期的聚合逻辑
    // 类似用户的聚合方法
  }
}