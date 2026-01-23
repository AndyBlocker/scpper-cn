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
      WITH ordered AS (
        SELECT
          DATE(v."timestamp") AS vote_date,
          v."timestamp",
          v.direction AS current_direction,
          CASE
            WHEN v."userId" IS NOT NULL THEN 'u:' || v."userId"::text
            WHEN v."anonKey" IS NOT NULL THEN 'a:' || v."anonKey"
            ELSE 'g:' || v.id::text
          END AS actor_key,
          LAG(v.direction) OVER (
            PARTITION BY CASE
              WHEN v."userId" IS NOT NULL THEN 'u:' || v."userId"::text
              WHEN v."anonKey" IS NOT NULL THEN 'a:' || v."anonKey"
              ELSE 'g:' || v.id::text
            END
            ORDER BY v."timestamp", v.id
          ) AS prev_direction
        FROM "Vote" v
        JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        WHERE pv."pageId" = ${pageId}
          AND pv."validTo" IS NULL
          AND pv."isDeleted" = false
      ),
      deltas AS (
        SELECT
          vote_date,
          (CASE WHEN current_direction = 1 THEN 1 ELSE 0 END)
            - (CASE WHEN COALESCE(prev_direction, 0) = 1 THEN 1 ELSE 0 END) AS up_delta,
          (CASE WHEN current_direction = -1 THEN 1 ELSE 0 END)
            - (CASE WHEN COALESCE(prev_direction, 0) = -1 THEN 1 ELSE 0 END) AS down_delta,
          (CASE WHEN current_direction <> 0 THEN 1 ELSE 0 END)
            - (CASE WHEN COALESCE(prev_direction, 0) <> 0 THEN 1 ELSE 0 END) AS total_delta
        FROM ordered
      ),
      daily_votes AS (
        SELECT
          vote_date,
          SUM(up_delta)::int AS daily_upvotes,
          SUM(down_delta)::int AS daily_downvotes,
          SUM(total_delta)::int AS daily_total
        FROM deltas
        GROUP BY vote_date
      ),
      cumulative_votes AS (
        SELECT
          vote_date,
          daily_upvotes,
          daily_downvotes,
          daily_total,
          SUM(daily_upvotes) OVER (ORDER BY vote_date) AS cumulative_upvotes,
          SUM(daily_downvotes) OVER (ORDER BY vote_date) AS cumulative_downvotes,
          SUM(daily_total) OVER (ORDER BY vote_date) AS cumulative_total
        FROM daily_votes
      )
      SELECT * FROM cumulative_votes ORDER BY vote_date
    `;

    const dates = result.map(row => row.vote_date.toISOString().split('T')[0]);
    const dailyUpvotes = result.map(row => Number(row.daily_upvotes));
    const dailyDownvotes = result.map(row => Number(row.daily_downvotes));
    const dailyTotals = result.map(row => Number(row.daily_total));

    const upvotes: number[] = [];
    const downvotes: number[] = [];
    const totalVotes: number[] = [];

    let runningUp = 0;
    let runningDown = 0;
    let runningTotal = 0;

    for (let i = 0; i < result.length; i += 1) {
      runningUp = Math.max(0, runningUp + dailyUpvotes[i]);
      runningDown = Math.max(0, runningDown + dailyDownvotes[i]);
      runningTotal = Math.max(0, runningTotal + dailyTotals[i]);

      upvotes.push(runningUp);
      downvotes.push(runningDown);
      totalVotes.push(runningTotal);
    }

    return {
      dates,
      dailyUpvotes,
      dailyDownvotes,
      upvotes,
      downvotes,
      totalVotes
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
      WITH latest_versions AS (
        SELECT
          pv."pageId" AS page_id,
          pv.id AS version_id,
          pv."isDeleted" AS is_deleted,
          DATE(COALESCE(pv."validFrom", pv."updatedAt")) AS effective_date
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL
      ),
      effective_attributions AS (
        SELECT a.*
        FROM (
          SELECT
            a.*,
            BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
          FROM "Attribution" a
          JOIN latest_versions lv ON lv.version_id = a."pageVerId"
        ) a
        WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
      ),
      active_versions AS (
        SELECT lv.page_id, lv.version_id
        FROM latest_versions lv
        WHERE lv.is_deleted = false
          AND EXISTS (
            SELECT 1
            FROM effective_attributions a
            WHERE a."pageVerId" = lv.version_id
              AND a."userId" = ${userId}
          )
      ),
      deleted_versions AS (
        SELECT
          lv.page_id,
          lv.version_id AS deletion_version_id,
          lv.effective_date AS deletion_date
        FROM latest_versions lv
        WHERE lv.is_deleted = true
          AND EXISTS (
            SELECT 1
            FROM effective_attributions a
            WHERE a."pageVerId" = lv.version_id
              AND a."userId" = ${userId}
          )
      ),
      deleted_sources AS (
        SELECT
          dv.page_id,
          src.version_id,
          dv.deletion_version_id,
          dv.deletion_date,
          src.drop_date,
          COALESCE(src.rating, 0) AS rating,
          COALESCE(src.total_votes, 0) AS total_votes
        FROM deleted_versions dv
        JOIN LATERAL (
          SELECT
            pv.id AS version_id,
            pv.rating,
            pv."voteCount" AS total_votes,
            (
              SELECT MAX(v."timestamp")
              FROM "Vote" v
              WHERE v."pageVersionId" = pv.id
            ) AS last_vote_timestamp,
            NULL::date AS drop_date_placeholder
          FROM "PageVersion" pv
          WHERE pv."pageId" = dv.page_id
            AND (pv."isDeleted" = false OR pv.id = dv.deletion_version_id)
          ORDER BY
            CASE WHEN pv."isDeleted" = false THEN 0 ELSE 1 END,
            pv."validTo" DESC NULLS LAST,
            pv."updatedAt" DESC
          LIMIT 1
        ) src_raw ON true
        CROSS JOIN LATERAL (
          SELECT
            DATE(
              GREATEST(
                COALESCE(src_raw.last_vote_timestamp, dv.deletion_date::timestamp),
                dv.deletion_date::timestamp
              ) + INTERVAL '1 day'
            ) AS drop_date,
            src_raw.version_id,
            src_raw.rating,
            src_raw.total_votes
        ) src
      ),
      tracked_versions AS (
        SELECT page_id, version_id
        FROM active_versions
        UNION ALL
        SELECT page_id, version_id
        FROM deleted_sources
      ),
      raw_votes AS (
        SELECT
          v.id AS vote_id,
          tv.page_id,
          DATE(v."timestamp") AS vote_date,
          v."timestamp",
          v.direction AS current_direction,
          CASE
            WHEN v."userId" IS NOT NULL THEN 'u:' || v."userId"::text
            WHEN v."anonKey" IS NOT NULL THEN 'a:' || v."anonKey"
            ELSE 'g:' || v.id::text
          END AS actor_key
        FROM "Vote" v
        JOIN tracked_versions tv ON v."pageVersionId" = tv.version_id
      ),
      ordered AS (
        SELECT
          vote_id,
          page_id,
          vote_date,
          "timestamp",
          current_direction,
          actor_key,
          LAG(current_direction) OVER (
            PARTITION BY page_id, actor_key
            ORDER BY "timestamp", vote_id
          ) AS prev_direction
        FROM raw_votes
      ),
      vote_deltas AS (
        SELECT
          vote_date,
          (CASE WHEN current_direction = 1 THEN 1 ELSE 0 END)
            - (CASE WHEN COALESCE(prev_direction, 0) = 1 THEN 1 ELSE 0 END) AS up_delta,
          (CASE WHEN current_direction = -1 THEN 1 ELSE 0 END)
            - (CASE WHEN COALESCE(prev_direction, 0) = -1 THEN 1 ELSE 0 END) AS down_delta,
          (CASE WHEN current_direction <> 0 THEN 1 ELSE 0 END)
            - (CASE WHEN COALESCE(prev_direction, 0) <> 0 THEN 1 ELSE 0 END) AS total_delta
        FROM ordered
      ),
      deletion_events AS (
        SELECT
          COALESCE(ds.drop_date, ds.deletion_date) AS deletion_date,
          ds.total_votes,
          ds.rating
        FROM deleted_sources ds
        WHERE ds.deletion_date IS NOT NULL
          AND (COALESCE(ds.total_votes, 0) <> 0 OR COALESCE(ds.rating, 0) <> 0)
      ),
      deletion_adjustments AS (
        -- Transform rating + voteCount totals into explicit up/down vote counts so we can subtract them
        SELECT
          deletion_date,
          total_votes,
          LEAST(
            GREATEST(
              ROUND(((total_votes + rating)::numeric) / 2)::int,
              0
            ),
            total_votes
          ) AS up_votes
        FROM deletion_events
      ),
      deletion_deltas AS (
        SELECT
          deletion_date AS vote_date,
          -up_votes AS up_delta,
          -(total_votes - up_votes) AS down_delta,
          -total_votes AS total_delta
        FROM deletion_adjustments
      ),
      deltas AS (
        SELECT vote_date, up_delta, down_delta, total_delta
        FROM vote_deltas
        UNION ALL
        SELECT vote_date, up_delta, down_delta, total_delta
        FROM deletion_deltas
      ),
      daily_votes AS (
        SELECT
          vote_date,
          SUM(up_delta)::int AS daily_upvotes,
          SUM(down_delta)::int AS daily_downvotes,
          SUM(total_delta)::int AS daily_total
        FROM deltas
        GROUP BY vote_date
      ),
      cumulative_votes AS (
        SELECT 
          vote_date,
          daily_upvotes,
          daily_downvotes,
          daily_total,
          SUM(daily_upvotes) OVER (ORDER BY vote_date) as cumulative_upvotes,
          SUM(daily_downvotes) OVER (ORDER BY vote_date) as cumulative_downvotes,
          SUM(daily_total) OVER (ORDER BY vote_date) as cumulative_total
        FROM daily_votes
      )
      SELECT * FROM cumulative_votes ORDER BY vote_date
    `;

    const dates = result.map(row => row.vote_date.toISOString().split('T')[0]);
    const dailyUpvotes = result.map(row => Number(row.daily_upvotes));
    const dailyDownvotes = result.map(row => Number(row.daily_downvotes));
    const dailyTotals = result.map(row => Number(row.daily_total));

    const upvotes: number[] = [];
    const downvotes: number[] = [];
    const totalVotes: number[] = [];

    let runningUp = 0;
    let runningDown = 0;
    let runningTotal = 0;

    for (let i = 0; i < result.length; i += 1) {
      runningUp = Math.max(0, runningUp + dailyUpvotes[i]);
      runningDown = Math.max(0, runningDown + dailyDownvotes[i]);
      runningTotal = Math.max(0, runningTotal + dailyTotals[i]);

      upvotes.push(runningUp);
      downvotes.push(runningDown);
      totalVotes.push(runningTotal);
    }

    return {
      dates,
      dailyUpvotes,
      dailyDownvotes,
      upvotes,
      downvotes,
      totalVotes
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
      WITH effective_attributions AS (
        SELECT a.*
        FROM (
          SELECT
            a.*,
            BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
          FROM "Attribution" a
        ) a
        WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
      )
      SELECT DISTINCT a."userId" as "userId"
      FROM "Vote" v
      JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
      JOIN effective_attributions a ON a."pageVerId" = pv.id
      JOIN "User" u ON a."userId" = u.id
      WHERE v."timestamp" >= ${cutoffTime}
        AND a."userId" IS NOT NULL
        AND (u."attributionVotingCacheUpdatedAt" IS NULL OR u."attributionVotingCacheUpdatedAt" < ${cutoffTime})
    `;
    
    return users.map(u => u.userId);
  }
}
