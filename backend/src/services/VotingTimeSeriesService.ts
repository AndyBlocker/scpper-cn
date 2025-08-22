import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';

/**
 * Interface for voting time series data structure
 */
export interface VotingTimeSeriesData {
  dates: string[];              // Array of dates (YYYY-MM-DD format)
  dailyUpvotes: number[];       // Daily new upvotes
  dailyDownvotes: number[];     // Daily new downvotes  
  upvotes: number[];            // Cumulative upvotes
  downvotes: number[];          // Cumulative downvotes
  totalVotes: number[];         // Cumulative total votes
}

/**
 * Service for managing voting time series data cache
 * Provides efficient pre-computation of voting statistics for frontend plotting
 */
export class VotingTimeSeriesService {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || getPrismaClient();
  }


  /**
   * Generate voting time series data for a specific page
   * @param pageId - The ID of the page
   * @returns Voting time series data
   */
  async generatePageVotingTimeSeries(pageId: number): Promise<VotingTimeSeriesData> {
    const result = await this.prisma.$queryRaw<Array<{
      vote_date: Date;
      daily_upvotes: number;
      daily_downvotes: number;
      daily_total: number;
      cumulative_upvotes: number;
      cumulative_downvotes: number;
      cumulative_total: number;
    }>>`
      WITH daily_votes AS (
        SELECT 
          DATE(v."timestamp") as vote_date,
          COUNT(*) FILTER (WHERE v.direction = 1) as daily_upvotes,
          COUNT(*) FILTER (WHERE v.direction = -1) as daily_downvotes,
          COUNT(*) FILTER (WHERE v.direction != 0) as daily_total
        FROM "Vote" v
        JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        WHERE pv."pageId" = ${pageId}
        GROUP BY DATE(v."timestamp")
        ORDER BY DATE(v."timestamp")
      ),
      cumulative_votes AS (
        SELECT 
          vote_date,
          daily_upvotes::int,
          daily_downvotes::int,
          daily_total::int,
          SUM(daily_upvotes::int) OVER (ORDER BY vote_date) as cumulative_upvotes,
          SUM(daily_downvotes::int) OVER (ORDER BY vote_date) as cumulative_downvotes,
          SUM(daily_total::int) OVER (ORDER BY vote_date) as cumulative_total
        FROM daily_votes
      )
      SELECT * FROM cumulative_votes ORDER BY vote_date
    `;

    return {
      dates: result.map(row => row.vote_date.toISOString().split('T')[0]),
      dailyUpvotes: result.map(row => Number(row.daily_upvotes)),
      dailyDownvotes: result.map(row => Number(row.daily_downvotes)),
      upvotes: result.map(row => Number(row.cumulative_upvotes)),
      downvotes: result.map(row => Number(row.cumulative_downvotes)),
      totalVotes: result.map(row => Number(row.cumulative_total))
    };
  }

  /**
   * Generate attribution voting time series data for a specific user
   * @param userId - The ID of the user
   * @returns Attribution voting time series data
   */
  async generateUserAttributionVotingTimeSeries(userId: number): Promise<VotingTimeSeriesData> {
    const result = await this.prisma.$queryRaw<Array<{
      vote_date: Date;
      daily_upvotes: number;
      daily_downvotes: number;
      daily_total: number;
      cumulative_upvotes: number;
      cumulative_downvotes: number;
      cumulative_total: number;
    }>>`
      WITH user_pages AS (
        SELECT DISTINCT pv."pageId"
        FROM "Attribution" a
        JOIN "PageVersion" pv ON a."pageVerId" = pv.id
        WHERE a."userId" = ${userId}
      ),
      daily_votes AS (
        SELECT 
          DATE(v."timestamp") as vote_date,
          COUNT(*) FILTER (WHERE v.direction = 1) as daily_upvotes,
          COUNT(*) FILTER (WHERE v.direction = -1) as daily_downvotes,
          COUNT(*) FILTER (WHERE v.direction != 0) as daily_total
        FROM "Vote" v
        JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        JOIN user_pages up ON pv."pageId" = up."pageId"
        GROUP BY DATE(v."timestamp")
        ORDER BY DATE(v."timestamp")
      ),
      cumulative_votes AS (
        SELECT 
          vote_date,
          daily_upvotes::int,
          daily_downvotes::int,
          daily_total::int,
          SUM(daily_upvotes::int) OVER (ORDER BY vote_date) as cumulative_upvotes,
          SUM(daily_downvotes::int) OVER (ORDER BY vote_date) as cumulative_downvotes,
          SUM(daily_total::int) OVER (ORDER BY vote_date) as cumulative_total
        FROM daily_votes
      )
      SELECT * FROM cumulative_votes ORDER BY vote_date
    `;

    return {
      dates: result.map(row => row.vote_date.toISOString().split('T')[0]),
      dailyUpvotes: result.map(row => Number(row.daily_upvotes)),
      dailyDownvotes: result.map(row => Number(row.daily_downvotes)),
      upvotes: result.map(row => Number(row.cumulative_upvotes)),
      downvotes: result.map(row => Number(row.cumulative_downvotes)),
      totalVotes: result.map(row => Number(row.cumulative_total))
    };
  }

  /**
   * Update cached voting time series data for a specific page
   * @param pageId - The ID of the page
   */
  async updatePageVotingCache(pageId: number): Promise<void> {
    const timeSeriesData = await this.generatePageVotingTimeSeries(pageId);
    
    await this.prisma.page.update({
      where: { id: pageId },
      data: {
        votingTimeSeriesCache: timeSeriesData as any,
        votingCacheUpdatedAt: new Date()
      }
    });
  }

  /**
   * Update cached attribution voting time series data for a specific user
   * @param userId - The ID of the user
   */
  async updateUserAttributionVotingCache(userId: number): Promise<void> {
    const timeSeriesData = await this.generateUserAttributionVotingTimeSeries(userId);
    
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        attributionVotingTimeSeriesCache: timeSeriesData as any,
        attributionVotingCacheUpdatedAt: new Date()
      }
    });
  }

  /**
   * Batch update voting caches for multiple pages
   * @param pageIds - Array of page IDs
   * @param batchSize - Number of pages to process in each batch
   */
  async batchUpdatePageVotingCache(pageIds: number[], batchSize: number = 100): Promise<void> {
    console.log(`🔄 Updating voting cache for ${pageIds.length} pages in batches of ${batchSize}...`);
    
    for (let i = 0; i < pageIds.length; i += batchSize) {
      const batch = pageIds.slice(i, i + batchSize);
      const promises = batch.map(pageId => this.updatePageVotingCache(pageId));
      
      await Promise.allSettled(promises);
      console.log(`  ✅ Processed batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(pageIds.length/batchSize)}`);
    }
    
    console.log(`✅ Completed updating voting cache for ${pageIds.length} pages`);
  }

  /**
   * Batch update attribution voting caches for multiple users
   * @param userIds - Array of user IDs
   * @param batchSize - Number of users to process in each batch
   */
  async batchUpdateUserAttributionVotingCache(userIds: number[], batchSize: number = 100): Promise<void> {
    console.log(`🔄 Updating attribution voting cache for ${userIds.length} users in batches of ${batchSize}...`);
    
    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);
      const promises = batch.map(userId => this.updateUserAttributionVotingCache(userId));
      
      await Promise.allSettled(promises);
      console.log(`  ✅ Processed batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(userIds.length/batchSize)}`);
    }
    
    console.log(`✅ Completed updating attribution voting cache for ${userIds.length} users`);
  }

  /**
   * Get cached voting time series data for a page
   * @param pageId - The ID of the page
   * @returns Cached voting data or null if not cached
   */
  async getPageVotingCache(pageId: number): Promise<VotingTimeSeriesData | null> {
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { 
        votingTimeSeriesCache: true,
        votingCacheUpdatedAt: true 
      }
    });
    
    if (!page?.votingTimeSeriesCache) {
      return null;
    }
    
    return page.votingTimeSeriesCache as VotingTimeSeriesData;
  }

  /**
   * Get cached attribution voting time series data for a user
   * @param userId - The ID of the user
   * @returns Cached attribution voting data or null if not cached
   */
  async getUserAttributionVotingCache(userId: number): Promise<VotingTimeSeriesData | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { 
        attributionVotingTimeSeriesCache: true,
        attributionVotingCacheUpdatedAt: true 
      }
    });
    
    if (!user?.attributionVotingTimeSeriesCache) {
      return null;
    }
    
    return user.attributionVotingTimeSeriesCache as VotingTimeSeriesData;
  }

  /**
   * Get pages that need cache updates (pages with recent voting activity)
   * @param hoursAgo - Look for voting activity within this many hours
   * @returns Array of page IDs that need cache updates
   */
  async getPagesNeedingCacheUpdate(hoursAgo: number = 24): Promise<number[]> {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hoursAgo);
    
    const pages = await this.prisma.$queryRaw<Array<{ pageId: number }>>`
      SELECT DISTINCT pv."pageId" as "pageId"
      FROM "Vote" v
      JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
      JOIN "Page" p ON pv."pageId" = p.id
      WHERE v."timestamp" >= ${cutoffTime}
        AND (p."votingCacheUpdatedAt" IS NULL OR p."votingCacheUpdatedAt" < ${cutoffTime})
    `;
    
    return pages.map(p => p.pageId);
  }

  /**
   * Get users that need attribution voting cache updates
   * @param hoursAgo - Look for voting activity within this many hours
   * @returns Array of user IDs that need cache updates
   */
  async getUsersNeedingCacheUpdate(hoursAgo: number = 24): Promise<number[]> {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hoursAgo);
    
    const users = await this.prisma.$queryRaw<Array<{ userId: number }>>`
      SELECT DISTINCT a."userId" as "userId"
      FROM "Vote" v
      JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
      JOIN "Attribution" a ON a."pageVerId" = pv.id
      JOIN "User" u ON a."userId" = u.id
      WHERE v."timestamp" >= ${cutoffTime}
        AND a."userId" IS NOT NULL
        AND (u."attributionVotingCacheUpdatedAt" IS NULL OR u."attributionVotingCacheUpdatedAt" < ${cutoffTime})
    `;
    
    return users.map(u => u.userId);
  }
}