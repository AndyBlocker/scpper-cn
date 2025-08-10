import { PrismaClient } from '@prisma/client';
import { VotingTimeSeriesService, VotingTimeSeriesData } from './VotingTimeSeriesService';

/**
 * Interface for API response
 */
export interface VotingTimeSeriesResponse extends VotingTimeSeriesData {
  lastUpdated: string;
  fromCache: boolean;
}

/**
 * API Service for providing voting time series data to frontend applications
 * Uses cached data when available for optimal performance
 */
export class VotingTimeSeriesApiService {
  private prisma: PrismaClient;
  private votingService: VotingTimeSeriesService;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || new PrismaClient();
    this.votingService = new VotingTimeSeriesService(this.prisma);
  }

  /**
   * Get voting time series data for a page
   * Uses cache if available and recent, otherwise generates fresh data
   * 
   * @param pageId - The ID of the page
   * @param maxCacheAge - Maximum age of cache in hours (default: 1 hour)
   * @returns Voting time series data with metadata
   */
  async getPageVotingTimeSeries(
    pageId: number, 
    maxCacheAge: number = 1
  ): Promise<VotingTimeSeriesResponse> {
    // First try to get cached data
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: {
        votingTimeSeriesCache: true,
        votingCacheUpdatedAt: true,
        url: true
      }
    });

    if (!page) {
      throw new Error(`Page with ID ${pageId} not found`);
    }

    const now = new Date();
    const cacheAgeLimit = new Date(now.getTime() - maxCacheAge * 60 * 60 * 1000);

    // Check if we have valid cached data
    if (
      page.votingTimeSeriesCache && 
      page.votingCacheUpdatedAt && 
      page.votingCacheUpdatedAt > cacheAgeLimit
    ) {
      const cached = page.votingTimeSeriesCache as VotingTimeSeriesData;
      return {
        ...cached,
        lastUpdated: page.votingCacheUpdatedAt.toISOString(),
        fromCache: true
      };
    }

    // Generate fresh data and update cache
    console.log(`🔄 Generating fresh voting time series for page ${pageId} (${page.url})`);
    const freshData = await this.votingService.generatePageVotingTimeSeries(pageId);
    
    // Update the cache
    await this.votingService.updatePageVotingCache(pageId);

    return {
      ...freshData,
      lastUpdated: now.toISOString(),
      fromCache: false
    };
  }

  /**
   * Get attribution voting time series data for a user
   * Uses cache if available and recent, otherwise generates fresh data
   * 
   * @param userId - The ID of the user
   * @param maxCacheAge - Maximum age of cache in hours (default: 1 hour)
   * @returns Attribution voting time series data with metadata
   */
  async getUserAttributionVotingTimeSeries(
    userId: number, 
    maxCacheAge: number = 1
  ): Promise<VotingTimeSeriesResponse> {
    // First try to get cached data
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        attributionVotingTimeSeriesCache: true,
        attributionVotingCacheUpdatedAt: true,
        displayName: true
      }
    });

    if (!user) {
      throw new Error(`User with ID ${userId} not found`);
    }

    const now = new Date();
    const cacheAgeLimit = new Date(now.getTime() - maxCacheAge * 60 * 60 * 1000);

    // Check if we have valid cached data
    if (
      user.attributionVotingTimeSeriesCache && 
      user.attributionVotingCacheUpdatedAt && 
      user.attributionVotingCacheUpdatedAt > cacheAgeLimit
    ) {
      const cached = user.attributionVotingTimeSeriesCache as VotingTimeSeriesData;
      return {
        ...cached,
        lastUpdated: user.attributionVotingCacheUpdatedAt.toISOString(),
        fromCache: true
      };
    }

    // Generate fresh data and update cache
    console.log(`🔄 Generating fresh attribution voting time series for user ${userId} (${user.displayName})`);
    const freshData = await this.votingService.generateUserAttributionVotingTimeSeries(userId);
    
    // Update the cache
    await this.votingService.updateUserAttributionVotingCache(userId);

    return {
      ...freshData,
      lastUpdated: now.toISOString(),
      fromCache: false
    };
  }

  /**
   * Get voting time series data for multiple pages in batch
   * 
   * @param pageIds - Array of page IDs
   * @param maxCacheAge - Maximum age of cache in hours
   * @returns Map of page ID to voting time series data
   */
  async getBatchPageVotingTimeSeries(
    pageIds: number[], 
    maxCacheAge: number = 1
  ): Promise<Map<number, VotingTimeSeriesResponse>> {
    const results = new Map<number, VotingTimeSeriesResponse>();
    
    // Process in parallel but with some concurrency limit
    const batchSize = 10;
    for (let i = 0; i < pageIds.length; i += batchSize) {
      const batch = pageIds.slice(i, i + batchSize);
      const promises = batch.map(async pageId => {
        try {
          const data = await this.getPageVotingTimeSeries(pageId, maxCacheAge);
          return { pageId, data };
        } catch (error) {
          console.error(`Failed to get voting data for page ${pageId}:`, error);
          return { pageId, data: null };
        }
      });
      
      const batchResults = await Promise.allSettled(promises);
      batchResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value.data) {
          results.set(result.value.pageId, result.value.data);
        }
      });
    }
    
    return results;
  }

  /**
   * Get basic voting statistics summary for a page
   * Uses cached data when available for better performance
   * 
   * @param pageId - The ID of the page
   * @returns Basic voting statistics
   */
  async getPageVotingSummary(pageId: number): Promise<{
    totalUpvotes: number;
    totalDownvotes: number;
    totalVotes: number;
    rating: number;
    lastVoteDate: string | null;
    fromCache: boolean;
  }> {
    const cached = await this.votingService.getPageVotingCache(pageId);
    
    if (cached && cached.upvotes.length > 0) {
      const totalUpvotes = cached.upvotes[cached.upvotes.length - 1];
      const totalDownvotes = cached.downvotes[cached.downvotes.length - 1];
      const lastVoteDate = cached.dates.length > 0 ? cached.dates[cached.dates.length - 1] : null;
      
      return {
        totalUpvotes,
        totalDownvotes,
        totalVotes: totalUpvotes + totalDownvotes,
        rating: totalUpvotes - totalDownvotes,
        lastVoteDate,
        fromCache: true
      };
    }

    // Fallback to direct database query
    const result = await this.prisma.$queryRaw<Array<{
      upvotes: number;
      downvotes: number;
      last_vote: Date | null;
    }>>`
      SELECT 
        COUNT(*) FILTER (WHERE v.direction = 1)::int as upvotes,
        COUNT(*) FILTER (WHERE v.direction = -1)::int as downvotes,
        MAX(v."timestamp") as last_vote
      FROM "Vote" v
      JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
      WHERE pv."pageId" = ${pageId}
    `;

    const data = result[0];
    if (!data) {
      return {
        totalUpvotes: 0,
        totalDownvotes: 0,
        totalVotes: 0,
        rating: 0,
        lastVoteDate: null,
        fromCache: false
      };
    }

    return {
      totalUpvotes: data.upvotes,
      totalDownvotes: data.downvotes,
      totalVotes: data.upvotes + data.downvotes,
      rating: data.upvotes - data.downvotes,
      lastVoteDate: data.last_vote ? data.last_vote.toISOString().split('T')[0] : null,
      fromCache: false
    };
  }

  /**
   * Get trending pages based on recent voting activity
   * Uses cached data and daily stats for efficient computation
   */
  async getTrendingPagesByVoting(
    days: number = 7,
    limit: number = 20
  ): Promise<Array<{
    pageId: number;
    url: string;
    title: string;
    recentUpvotes: number;
    recentDownvotes: number;
    recentRating: number;
    trendScore: number;
  }>> {
    const result = await this.prisma.$queryRaw<Array<{
      pageId: number;
      url: string;
      title: string;
      recentUpvotes: number;
      recentDownvotes: number;
      recentRating: number;
      trendScore: number;
    }>>`
      WITH recent_activity AS (
        SELECT 
          p.id as "pageId",
          p.url,
          pv.title,
          SUM(pds.votes_up) as recent_upvotes,
          SUM(pds.votes_down) as recent_downvotes,
          SUM(pds.votes_up) - SUM(pds.votes_down) as recent_rating,
          -- Simple trend score: recent votes weighted by recency
          SUM(pds.votes_up + pds.votes_down) * 
          EXP(-EXTRACT(EPOCH FROM (CURRENT_DATE - pds.date)) / (${days} * 86400)) as trend_score
        FROM "Page" p
        JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
        JOIN "PageDailyStats" pds ON pds."pageId" = p.id
        WHERE pds.date >= CURRENT_DATE - INTERVAL '${days} days'
          AND (pds.votes_up > 0 OR pds.votes_down > 0)
        GROUP BY p.id, p.url, pv.title
        HAVING SUM(pds.votes_up + pds.votes_down) > 0
      )
      SELECT *
      FROM recent_activity
      ORDER BY trend_score DESC, recent_rating DESC
      LIMIT ${limit}
    `;

    return result.map(row => ({
      pageId: Number(row.pageId),
      url: row.url,
      title: row.title || 'Untitled',
      recentUpvotes: Number(row.recentUpvotes),
      recentDownvotes: Number(row.recentDownvotes),
      recentRating: Number(row.recentRating),
      trendScore: Number(row.trendScore)
    }));
  }

  /**
   * Force refresh cache for specific entities
   * Useful for admin operations or when cache is known to be stale
   */
  async forceRefreshCache(options: {
    pageIds?: number[];
    userIds?: number[];
  }): Promise<{
    pagesRefreshed: number;
    usersRefreshed: number;
  }> {
    const { pageIds = [], userIds = [] } = options;
    
    if (pageIds.length > 0) {
      await this.votingService.batchUpdatePageVotingCache(pageIds, 50);
    }
    
    if (userIds.length > 0) {
      await this.votingService.batchUpdateUserAttributionVotingCache(userIds, 50);
    }
    
    return {
      pagesRefreshed: pageIds.length,
      usersRefreshed: userIds.length
    };
  }
}