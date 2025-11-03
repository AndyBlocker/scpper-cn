// src/jobs/VotingTimeSeriesCacheJob.ts
import { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { VotingTimeSeriesService } from '../services/VotingTimeSeriesService';

/**
 * Job for maintaining voting time series cache data
 * This job runs as part of the analysis pipeline to keep voting statistics up-to-date
 * for efficient frontend plotting
 */
export class VotingTimeSeriesCacheJob {
  private prisma: PrismaClient;
  private votingService: VotingTimeSeriesService;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || getPrismaClient();
    this.votingService = new VotingTimeSeriesService(this.prisma);
  }

  /**
   * Main job execution - updates voting caches for recently changed data
   */
  async execute(options: {
    forceFullRebuild?: boolean;
    lookbackHours?: number;
    batchSize?: number;
  } = {}) {
    const { 
      forceFullRebuild = false, 
      lookbackHours = 24,
      batchSize = 500 
    } = options;

    console.log('🔄 Starting VotingTimeSeriesCacheJob...');
    console.log(`⚙️ Options: forceFullRebuild=${forceFullRebuild}, lookbackHours=${lookbackHours}, batchSize=${batchSize}`);

    try {
      if (forceFullRebuild) {
        await this.fullRebuild(batchSize);
      } else {
        await this.incrementalUpdate(lookbackHours, batchSize);
      }

      console.log('✅ VotingTimeSeriesCacheJob completed successfully!');

    } catch (error) {
      console.error('❌ VotingTimeSeriesCacheJob failed:', error);
      throw error;
    }
  }

  /**
   * Incremental update - only update caches for pages and users with recent voting activity
   * Now includes smart detection of pages that need initial cache generation
   */
  private async incrementalUpdate(lookbackHours: number, batchSize: number) {
    console.log(`🔍 Looking for pages and users with voting activity in the last ${lookbackHours} hours...`);

    // Get pages that need cache updates (recent activity)
    const pagesToUpdate = await this.votingService.getPagesNeedingCacheUpdate(lookbackHours);
    console.log(`📄 Found ${pagesToUpdate.length} pages needing cache updates`);

    // 🆕 Smart detection: Find pages that have votes but no cache yet
    const pagesNeedingInitialCache = await this.prisma.$queryRaw<Array<{ pageId: number }>>`
      SELECT DISTINCT pv."pageId" as "pageId"
      FROM "Vote" v
      JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE p."votingTimeSeriesCache" IS NULL  -- 没有缓存
        AND pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND EXISTS (
          SELECT 1 FROM "Vote" v2 
          WHERE v2."pageVersionId" = pv.id 
          LIMIT 1
        )  -- 确保有投票记录
      ORDER BY pv."pageId"
    `;
    
    console.log(`🆕 Found ${pagesNeedingInitialCache.length} pages needing INITIAL cache generation`);
    
    // 合并需要更新的页面列表
    const allPagesToUpdate = [
      ...pagesToUpdate,
      ...pagesNeedingInitialCache.map(p => p.pageId)
    ];
    
    // 去重
    const uniquePagesToUpdate = [...new Set(allPagesToUpdate)];
    console.log(`📊 Total unique pages to process: ${uniquePagesToUpdate.length} (${pagesToUpdate.length} recent + ${pagesNeedingInitialCache.length} initial)`);

    if (uniquePagesToUpdate.length > 0) {
      await this.votingService.batchUpdatePageVotingCache(uniquePagesToUpdate, batchSize);
    }

    // Get users that need attribution voting cache updates
    const usersToUpdate = await this.votingService.getUsersNeedingCacheUpdate(lookbackHours);
    console.log(`👥 Found ${usersToUpdate.length} users needing attribution voting cache updates`);

    // 🆕 Smart detection: Find users that have attributions but no cache yet
    const usersNeedingInitialCache = await this.prisma.$queryRaw<Array<{ userId: number }>>`
      SELECT DISTINCT u.id as "userId"
      FROM "User" u
      JOIN "Attribution" a ON u.id = a."userId"
      JOIN "PageVersion" pv ON a."pageVerId" = pv.id
      WHERE u."attributionVotingTimeSeriesCache" IS NULL  -- 没有缓存
        AND a.type = 'AUTHOR'
        AND pv."validTo" IS NULL
        AND EXISTS (
          SELECT 1 FROM "Vote" v
          WHERE v."pageVersionId" = pv.id
          LIMIT 1
        )  -- 确保页面有投票记录
      ORDER BY u.id
    `;

    console.log(`🆕 Found ${usersNeedingInitialCache.length} users needing INITIAL attribution cache generation`);

    // 合并需要更新的用户列表
    const allUsersToUpdate = [
      ...usersToUpdate,
      ...usersNeedingInitialCache.map(u => u.userId)
    ];

    // 去重
    const uniqueUsersToUpdate = [...new Set(allUsersToUpdate)];
    console.log(`📊 Total unique users to process: ${uniqueUsersToUpdate.length} (${usersToUpdate.length} recent + ${usersNeedingInitialCache.length} initial)`);

    if (uniqueUsersToUpdate.length > 0) {
      await this.votingService.batchUpdateUserAttributionVotingCache(uniqueUsersToUpdate, batchSize);
    }

    console.log(`✅ Incremental update completed - updated ${uniquePagesToUpdate.length} pages and ${uniqueUsersToUpdate.length} users`);
  }

  /**
   * Full rebuild - rebuild all voting caches from scratch
   */
  private async fullRebuild(batchSize: number) {
    console.log('🔄 Starting full voting cache rebuild...');

    // Get all pages with votes on current version
    const pagesWithVotes = await this.prisma.$queryRaw<Array<{ pageId: number }>>`
      SELECT DISTINCT pv."pageId" as "pageId"
      FROM "Vote" v
      JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
      WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
      ORDER BY pv."pageId"`;

    console.log(`📄 Found ${pagesWithVotes.length} pages with voting activity`);

    if (pagesWithVotes.length > 0) {
      const pageIds = pagesWithVotes.map(p => p.pageId);
      await this.votingService.batchUpdatePageVotingCache(pageIds, batchSize);
    }

    // Get all users with attributions on pages that have votes
    const usersWithAttributions = await this.prisma.$queryRaw<Array<{ userId: number }>>`
      SELECT DISTINCT a."userId" as "userId"
      FROM "Attribution" a
      JOIN "PageVersion" pv ON a."pageVerId" = pv.id
      WHERE a."userId" IS NOT NULL
        AND pv."validTo" IS NULL
        AND EXISTS (
          SELECT 1 FROM "Vote" v
          WHERE v."pageVersionId" = pv.id
          LIMIT 1
        )
      ORDER BY a."userId"`;

    console.log(`👥 Found ${usersWithAttributions.length} users with attributions on voted pages`);

    if (usersWithAttributions.length > 0) {
      const userIds = usersWithAttributions.map(u => u.userId);
      await this.votingService.batchUpdateUserAttributionVotingCache(userIds, batchSize);
    }

    console.log(`✅ Full rebuild completed - rebuilt caches for ${pagesWithVotes.length} pages and ${usersWithAttributions.length} users`);
  }

  /**
   * Initialize voting caches for specific entities
   */
  async initializeSpecificCaches(options: {
    pageIds?: number[];
    userIds?: number[];
    batchSize?: number;
  }) {
    const { pageIds = [], userIds = [], batchSize = 100 } = options;

    console.log(`🔧 Initializing specific caches: ${pageIds.length} pages, ${userIds.length} users`);

    if (pageIds.length > 0) {
      await this.votingService.batchUpdatePageVotingCache(pageIds, batchSize);
    }

    if (userIds.length > 0) {
      await this.votingService.batchUpdateUserAttributionVotingCache(userIds, batchSize);
    }

    console.log('✅ Specific cache initialization completed');
  }

  /**
   * Get cache statistics
   */
  async getCacheStatistics() {
    const stats = await this.prisma.$queryRaw<Array<{
      pages_with_voting_cache: number;
      users_with_attribution_voting_cache: number;
      oldest_page_cache: Date | null;
      newest_page_cache: Date | null;
      oldest_user_cache: Date | null;
      newest_user_cache: Date | null;
    }>>`
      SELECT 
        (SELECT COUNT(*) FROM "Page" WHERE "votingTimeSeriesCache" IS NOT NULL) as pages_with_voting_cache,
        (SELECT COUNT(*) FROM "User" WHERE "attributionVotingTimeSeriesCache" IS NOT NULL) as users_with_attribution_voting_cache,
        (SELECT MIN("votingCacheUpdatedAt") FROM "Page" WHERE "votingCacheUpdatedAt" IS NOT NULL) as oldest_page_cache,
        (SELECT MAX("votingCacheUpdatedAt") FROM "Page" WHERE "votingCacheUpdatedAt" IS NOT NULL) as newest_page_cache,
        (SELECT MIN("attributionVotingCacheUpdatedAt") FROM "User" WHERE "attributionVotingCacheUpdatedAt" IS NOT NULL) as oldest_user_cache,
        (SELECT MAX("attributionVotingCacheUpdatedAt") FROM "User" WHERE "attributionVotingCacheUpdatedAt" IS NOT NULL) as newest_user_cache
    `;

    return stats[0];
  }

  /**
   * Clean up stale caches (older than specified days)
   */
  async cleanupStaleCaches(daysOld: number = 30) {
    console.log(`🧹 Cleaning up caches older than ${daysOld} days...`);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    // Clear page caches
    const pageResult = await this.prisma.page.updateMany({
      where: {
        votingCacheUpdatedAt: {
          lt: cutoffDate
        }
      },
      data: {
        votingTimeSeriesCache: Prisma.DbNull,
        votingCacheUpdatedAt: null
      }
    });

    // Clear user attribution voting caches
    const userResult = await this.prisma.user.updateMany({
      where: {
        attributionVotingCacheUpdatedAt: {
          lt: cutoffDate
        }
      },
      data: {
        attributionVotingTimeSeriesCache: Prisma.DbNull,
        attributionVotingCacheUpdatedAt: null
      }
    });

    console.log(`✅ Cleaned up ${pageResult.count} page caches and ${userResult.count} user caches`);
  }

  /**
   * Validate cache data integrity
   */
  async validateCacheIntegrity(): Promise<{
    validPageCaches: number;
    invalidPageCaches: number;
    validUserCaches: number;
    invalidUserCaches: number;
  }> {
    console.log('🔍 Validating cache data integrity...');

    // Check page cache structure
    const pageResults = await this.prisma.$queryRaw<Array<{
      id: number;
      has_valid_cache: boolean;
    }>>`
      SELECT 
        id,
        CASE 
          WHEN "votingTimeSeriesCache" IS NULL THEN false
          WHEN jsonb_typeof("votingTimeSeriesCache") != 'object' THEN false
          WHEN NOT ("votingTimeSeriesCache" ? 'dates') THEN false
          WHEN NOT ("votingTimeSeriesCache" ? 'upvotes') THEN false
          WHEN NOT ("votingTimeSeriesCache" ? 'downvotes') THEN false
          WHEN NOT ("votingTimeSeriesCache" ? 'totalVotes') THEN false
          ELSE true
        END as has_valid_cache
      FROM "Page"
      WHERE "votingTimeSeriesCache" IS NOT NULL
    `;

    const validPageCaches = pageResults.filter(r => r.has_valid_cache).length;
    const invalidPageCaches = pageResults.filter(r => !r.has_valid_cache).length;

    // Check user cache structure
    const userResults = await this.prisma.$queryRaw<Array<{
      id: number;
      has_valid_cache: boolean;
    }>>`
      SELECT 
        id,
        CASE 
          WHEN "attributionVotingTimeSeriesCache" IS NULL THEN false
          WHEN jsonb_typeof("attributionVotingTimeSeriesCache") != 'object' THEN false
          WHEN NOT ("attributionVotingTimeSeriesCache" ? 'dates') THEN false
          WHEN NOT ("attributionVotingTimeSeriesCache" ? 'upvotes') THEN false
          WHEN NOT ("attributionVotingTimeSeriesCache" ? 'downvotes') THEN false
          WHEN NOT ("attributionVotingTimeSeriesCache" ? 'totalVotes') THEN false
          ELSE true
        END as has_valid_cache
      FROM "User"
      WHERE "attributionVotingTimeSeriesCache" IS NOT NULL
    `;

    const validUserCaches = userResults.filter(r => r.has_valid_cache).length;
    const invalidUserCaches = userResults.filter(r => !r.has_valid_cache).length;

    console.log(`✅ Cache validation completed:`);
    console.log(`  📄 Page caches: ${validPageCaches} valid, ${invalidPageCaches} invalid`);
    console.log(`  👥 User caches: ${validUserCaches} valid, ${invalidUserCaches} invalid`);

    return {
      validPageCaches,
      invalidPageCaches,
      validUserCaches,
      invalidUserCaches
    };
  }
}

/**
 * Convenience function to run the voting time series cache job
 */
export async function runVotingTimeSeriesCacheJob(options: {
  forceFullRebuild?: boolean;
  lookbackHours?: number;
  batchSize?: number;
} = {}) {
  const job = new VotingTimeSeriesCacheJob();
  await job.execute(options);
}
