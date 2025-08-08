import { PrismaClient } from '@prisma/client';
import { calculateUserRatings } from './UserRatingJob.js';
import { calculateSiteStatistics } from './SiteStatsJob.js';
import { calculateInterestingStats } from './InterestingStatsJob.js';

export async function analyze({ since }: { since?: Date } = {}) {
  const prisma = new PrismaClient();

  try {
    console.log('Starting analysis with pure SQL aggregation...');
    
    // Step 1: Calculate page statistics using pure SQL with Wilson and controversy formulas
    if (since) {
      await prisma.$executeRaw`
        WITH vote_stats AS (
          SELECT 
            v."pageVersionId",
            SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END) AS uv,
            SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END) AS dv,
            COUNT(*) FILTER (WHERE v.direction != 0) AS total_votes
          FROM "Vote" v
          INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
          WHERE pv."updatedAt" > ${since}
          GROUP BY v."pageVersionId"
        ),
        calculated_stats AS (
          SELECT 
            "pageVersionId",
            uv,
            dv,
            total_votes,
            CASE 
              WHEN total_votes = 0 THEN 0.0
              ELSE uv::float / total_votes::float
            END as like_ratio,
            CASE 
              WHEN total_votes = 0 THEN 0.0
              ELSE (
                (uv::float / total_votes::float + 1.96 * 1.96 / (2.0 * total_votes))
                - 1.96 / (2.0 * total_votes) * sqrt(4.0 * total_votes * (uv::float / total_votes::float) * (1.0 - uv::float / total_votes::float) + 1.96 * 1.96)
              ) / (1.0 + 1.96 * 1.96 / total_votes)
            END as wilson95,
            CASE 
              WHEN total_votes = 0 OR GREATEST(uv, dv) = 0 THEN 0.0
              ELSE (LEAST(uv, dv)::float / GREATEST(uv, dv)::float) * ln(total_votes + 1)
            END as controversy
          FROM vote_stats
        )
        INSERT INTO "PageStats" ("pageVersionId", uv, dv, "wilson95", controversy, "likeRatio")
        SELECT "pageVersionId", uv, dv, wilson95, controversy, like_ratio
        FROM calculated_stats
        ON CONFLICT ("pageVersionId") DO UPDATE SET
          uv = EXCLUDED.uv,
          dv = EXCLUDED.dv,
          "wilson95" = EXCLUDED."wilson95",
          controversy = EXCLUDED.controversy,
          "likeRatio" = EXCLUDED."likeRatio";
      `;
    } else {
      await prisma.$executeRaw`
        WITH vote_stats AS (
          SELECT 
            v."pageVersionId",
            SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END) AS uv,
            SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END) AS dv,
            COUNT(*) FILTER (WHERE v.direction != 0) AS total_votes
          FROM "Vote" v
          INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
          GROUP BY v."pageVersionId"
        ),
        calculated_stats AS (
          SELECT 
            "pageVersionId",
            uv,
            dv,
            total_votes,
            CASE 
              WHEN total_votes = 0 THEN 0.0
              ELSE uv::float / total_votes::float
            END as like_ratio,
            CASE 
              WHEN total_votes = 0 THEN 0.0
              ELSE (
                (uv::float / total_votes::float + 1.96 * 1.96 / (2.0 * total_votes))
                - 1.96 / (2.0 * total_votes) * sqrt(4.0 * total_votes * (uv::float / total_votes::float) * (1.0 - uv::float / total_votes::float) + 1.96 * 1.96)
              ) / (1.0 + 1.96 * 1.96 / total_votes)
            END as wilson95,
            CASE 
              WHEN total_votes = 0 OR GREATEST(uv, dv) = 0 THEN 0.0
              ELSE (LEAST(uv, dv)::float / GREATEST(uv, dv)::float) * ln(total_votes + 1)
            END as controversy
          FROM vote_stats
        )
        INSERT INTO "PageStats" ("pageVersionId", uv, dv, "wilson95", controversy, "likeRatio")
        SELECT "pageVersionId", uv, dv, wilson95, controversy, like_ratio
        FROM calculated_stats
        ON CONFLICT ("pageVersionId") DO UPDATE SET
          uv = EXCLUDED.uv,
          dv = EXCLUDED.dv,
          "wilson95" = EXCLUDED."wilson95",
          controversy = EXCLUDED.controversy,
          "likeRatio" = EXCLUDED."likeRatio";
      `;
    }

    // Step 2: Calculate user statistics with attribution-based logic
    console.log('Calculating user statistics with attribution-based logic...');
    await prisma.$executeRaw`
      WITH user_vote_stats AS (
        SELECT 
          u.id as "userId",
          SUM(CASE 
            WHEN v.direction = 1 THEN 
              CASE 
                WHEN pv.rating IS NOT NULL THEN pv.rating
                ELSE 1
              END
            ELSE 0 
          END) as total_up_rating,
          SUM(CASE 
            WHEN v.direction = -1 THEN 
              CASE 
                WHEN pv.rating IS NOT NULL THEN ABS(pv.rating)
                ELSE 1
              END
            ELSE 0 
          END) as total_down_rating,
          SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END) as total_up,
          SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END) as total_down
        FROM "User" u
        INNER JOIN "Vote" v ON u.id = v."userId"
        INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        WHERE v."userId" IS NOT NULL
        GROUP BY u.id
      ),
      user_attribution_stats AS (
        SELECT 
          u.id as "userId",
          SUM(COALESCE(pv.rating, 0)::float) as total_rating
        FROM "User" u
        INNER JOIN "Attribution" a ON u.id = a."userId"
        INNER JOIN "PageVersion" pv ON a."pageVerId" = pv.id
        WHERE a."userId" IS NOT NULL
          AND pv."validTo" IS NULL 
          AND pv."isDeleted" = false
          AND pv.rating IS NOT NULL
        GROUP BY u.id
      )
      INSERT INTO "UserStats" ("userId", "totalUp", "totalDown", "totalRating")
      SELECT 
        COALESCE(uvs."userId", uas."userId") as "userId",
        COALESCE(uvs.total_up, 0) as total_up,
        COALESCE(uvs.total_down, 0) as total_down,
        COALESCE(uas.total_rating, 0) as total_rating
      FROM user_vote_stats uvs
      FULL OUTER JOIN user_attribution_stats uas ON uvs."userId" = uas."userId"
      ON CONFLICT ("userId") DO UPDATE SET
        "totalUp" = EXCLUDED."totalUp",
        "totalDown" = EXCLUDED."totalDown",
        "totalRating" = EXCLUDED."totalRating";
    `;

    // Step 3: Calculate and update user first and last activity timestamps with details
    console.log('Calculating user first and last activity timestamps with detailed information...');
    
    // First, update the timestamps and types (faster)
    await prisma.$executeRaw`
      WITH user_activities AS (
        SELECT 
          u.id as "userId",
          CASE 
            WHEN LEAST(
              COALESCE(first_vote.timestamp, '2099-01-01'::timestamp),
              COALESCE(first_revision.timestamp, '2099-01-01'::timestamp),
              COALESCE(first_attribution.date, '2099-01-01'::timestamp)
            ) = COALESCE(first_vote.timestamp, '2099-01-01'::timestamp) 
            AND first_vote.timestamp IS NOT NULL THEN 'VOTE'
            WHEN LEAST(
              COALESCE(first_vote.timestamp, '2099-01-01'::timestamp),
              COALESCE(first_revision.timestamp, '2099-01-01'::timestamp),
              COALESCE(first_attribution.date, '2099-01-01'::timestamp)
            ) = COALESCE(first_revision.timestamp, '2099-01-01'::timestamp) 
            AND first_revision.timestamp IS NOT NULL THEN 'REVISION'
            WHEN LEAST(
              COALESCE(first_vote.timestamp, '2099-01-01'::timestamp),
              COALESCE(first_revision.timestamp, '2099-01-01'::timestamp),
              COALESCE(first_attribution.date, '2099-01-01'::timestamp)
            ) = COALESCE(first_attribution.date, '2099-01-01'::timestamp) 
            AND first_attribution.date IS NOT NULL THEN 'ATTRIBUTION'
            ELSE NULL
          END as activity_type,
          LEAST(
            COALESCE(first_vote.timestamp, '2099-01-01'::timestamp),
            COALESCE(first_revision.timestamp, '2099-01-01'::timestamp),
            COALESCE(first_attribution.date, '2099-01-01'::timestamp)
          ) as first_activity_at,
          GREATEST(
            COALESCE(last_vote.timestamp, '1900-01-01'::timestamp),
            COALESCE(last_revision.timestamp, '1900-01-01'::timestamp),
            COALESCE(last_attribution.date, '1900-01-01'::timestamp)
          ) as last_activity_at
        FROM "User" u
        LEFT JOIN (
          SELECT "userId", MIN("timestamp") as timestamp
          FROM "Vote" WHERE "userId" IS NOT NULL
          GROUP BY "userId"
        ) first_vote ON u.id = first_vote."userId"
        LEFT JOIN (
          SELECT "userId", MIN("timestamp") as timestamp  
          FROM "Revision" WHERE "userId" IS NOT NULL
          GROUP BY "userId"
        ) first_revision ON u.id = first_revision."userId"
        LEFT JOIN (
          SELECT "userId", MIN("date") as date
          FROM "Attribution" WHERE "userId" IS NOT NULL AND "date" IS NOT NULL
          GROUP BY "userId"
        ) first_attribution ON u.id = first_attribution."userId"
        LEFT JOIN (
          SELECT "userId", MAX("timestamp") as timestamp
          FROM "Vote" WHERE "userId" IS NOT NULL
          GROUP BY "userId"
        ) last_vote ON u.id = last_vote."userId"
        LEFT JOIN (
          SELECT "userId", MAX("timestamp") as timestamp  
          FROM "Revision" WHERE "userId" IS NOT NULL
          GROUP BY "userId"
        ) last_revision ON u.id = last_revision."userId"
        LEFT JOIN (
          SELECT "userId", MAX("date") as date
          FROM "Attribution" WHERE "userId" IS NOT NULL AND "date" IS NOT NULL
          GROUP BY "userId"
        ) last_attribution ON u.id = last_attribution."userId"
        WHERE LEAST(
          COALESCE(first_vote.timestamp, '2099-01-01'::timestamp),
          COALESCE(first_revision.timestamp, '2099-01-01'::timestamp),
          COALESCE(first_attribution.date, '2099-01-01'::timestamp)
        ) < '2099-01-01'::timestamp
      )
      UPDATE "User" u
      SET 
        "firstActivityAt" = ua.first_activity_at,
        "lastActivityAt" = CASE 
          WHEN ua.last_activity_at > '1900-01-01'::timestamp 
          THEN ua.last_activity_at 
          ELSE NULL 
        END,
        "firstActivityType" = ua.activity_type
      FROM user_activities ua
      WHERE u.id = ua."userId";
    `;

    // Then update activity details for users who have activity types (batch processing)
    console.log('Adding detailed activity descriptions...');
    
    // Update VOTE details
    await prisma.$executeRaw`
      UPDATE "User" u
      SET "firstActivityDetails" = '给页面 "' || COALESCE(pv.title, p.url, 'Unknown') || '" 投票'
      FROM "Vote" v
      INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
      INNER JOIN "Page" p ON pv."pageId" = p.id
      WHERE u."firstActivityType" = 'VOTE' 
        AND v."userId" = u.id 
        AND v."timestamp" = u."firstActivityAt"
        AND u."firstActivityDetails" IS NULL;
    `;

    // Update REVISION details
    await prisma.$executeRaw`
      UPDATE "User" u
      SET "firstActivityDetails" = '修改了页面 "' || COALESCE(pv.title, p.url, 'Unknown') || '" (' || r.type || ')'
      FROM "Revision" r
      INNER JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
      INNER JOIN "Page" p ON pv."pageId" = p.id
      WHERE u."firstActivityType" = 'REVISION' 
        AND r."userId" = u.id 
        AND r."timestamp" = u."firstActivityAt"
        AND u."firstActivityDetails" IS NULL;
    `;

    // Update ATTRIBUTION details
    await prisma.$executeRaw`
      UPDATE "User" u
      SET "firstActivityDetails" = '创建/参与了页面 "' || COALESCE(pv.title, p.url, 'Unknown') || '" (' || a.type || ')'
      FROM "Attribution" a
      INNER JOIN "PageVersion" pv ON a."pageVerId" = pv.id
      INNER JOIN "Page" p ON pv."pageId" = p.id
      WHERE u."firstActivityType" = 'ATTRIBUTION' 
        AND a."userId" = u.id 
        AND a."date" = u."firstActivityAt"
        AND u."firstActivityDetails" IS NULL;
    `;

    // Step 4: Update most common tags for users
    console.log('Updating user favorite tags...');
    await prisma.$executeRaw`
      WITH user_tags AS (
        SELECT 
          v."userId",
          unnest(pv.tags) as tag,
          COUNT(*) as tag_count
        FROM "Vote" v
        INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        WHERE v."userId" IS NOT NULL AND array_length(pv.tags, 1) > 0
        GROUP BY v."userId", unnest(pv.tags)
      ),
      user_fav_tags AS (
        SELECT DISTINCT ON ("userId") 
          "userId", 
          tag as fav_tag
        FROM user_tags
        ORDER BY "userId", tag_count DESC, tag
      )
      UPDATE "UserStats" us
      SET "favTag" = uft.fav_tag
      FROM user_fav_tags uft
      WHERE us."userId" = uft."userId";
    `;

    // Step 5: Sync PageVersion counts
    // NOTE: Disabled to prevent dirty queue false positives
    // The voteCount/revisionCount fields are used by buildDirtyQueue for change detection
    // Updating them here causes mismatch with API counts, leading to unnecessary dirty marking
    console.log('Skipping PageVersion count sync to prevent dirty queue false positives...');
    /*
    await prisma.$executeRaw`
      UPDATE "PageVersion" 
      SET 
        "voteCount" = COALESCE(vote_counts.cnt, 0),
        "revisionCount" = COALESCE(revision_counts.cnt, 0)
      FROM (
        SELECT 
          "pageVersionId", 
          COUNT(*) FILTER (WHERE direction != 0) as cnt
        FROM "Vote" 
        GROUP BY "pageVersionId"
      ) vote_counts
      FULL OUTER JOIN (
        SELECT 
          "pageVersionId", 
          COUNT(*) as cnt
        FROM "Revision" 
        GROUP BY "pageVersionId"
      ) revision_counts ON vote_counts."pageVersionId" = revision_counts."pageVersionId"
      WHERE "PageVersion".id = COALESCE(vote_counts."pageVersionId", revision_counts."pageVersionId");
    `;
    */

    // Get final statistics
    const stats = await prisma.$queryRaw`
      SELECT 
        (SELECT COUNT(*) FROM "Page") as pages,
        (SELECT COUNT(*) FROM "PageVersion") as versions,
        (SELECT COUNT(*) FROM "User") as users,
        (SELECT COUNT(*) FROM "Vote") as votes,
        (SELECT COUNT(*) FROM "Revision") as revisions,
        (SELECT COUNT(*) FROM "PageStats") as analyzed_pages,
        (SELECT COUNT(*) FROM "UserStats") as analyzed_users
    `;

    // Step 6: Calculate user vote pattern analysis
    console.log('Calculating user vote patterns...');
    await calculateUserVotePatterns(prisma);

    // Step 7: Calculate user ratings and rankings
    console.log('Calculating user ratings and rankings...');
    await calculateUserRatings(prisma);

    // Step 8: Calculate site statistics
    console.log('Calculating site-wide statistics...');
    // 检查是否为首次运行站点统计
    const existingSiteStats = await prisma.siteStats.count();
    const isSiteStatsIncremental = existingSiteStats > 0;
    await calculateSiteStatistics(prisma);
    
    // Generate daily aggregates with proper incremental mode
    const { generateDailyAggregates } = await import('./SiteStatsJob.js');
    await generateDailyAggregates(prisma, isSiteStatsIncremental);

    // Step 9: Calculate interesting statistics and facts
    console.log('Calculating interesting statistics and facts...');
    // 默认增量模式，除非是首次运行
    const existingFacts = await prisma.interestingFacts.count();
    const isIncremental = existingFacts > 0;
    await calculateInterestingStats(prisma, isIncremental);

    console.log('Analysis completed successfully!');
    console.log('Final statistics:', stats[0]);
    
  } catch (error) {
    console.error('Analysis failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 计算用户投票模式分析（优化版）
 * 包括：用户间投票交互统计、用户标签偏好统计
 */
export async function calculateUserVotePatterns(prisma: PrismaClient) {
  console.log('📊 开始分析用户投票模式...');
  
  try {
    // 并行处理用户交互和标签偏好数据
    const [voteInteractions, tagPreferences] = await Promise.all([
      // 1. 用户间投票交互统计
      prisma.$queryRaw<Array<{
        from_user_id: number;
        to_user_id: number;
        upvote_count: number;
        downvote_count: number;
        total_votes: number;
        last_vote_at: Date;
      }>>`
        SELECT 
          v."userId" as from_user_id,
          a."userId" as to_user_id,
          SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END)::int as upvote_count,
          SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END)::int as downvote_count,
          COUNT(CASE WHEN v.direction != 0 THEN 1 END)::int as total_votes,
          MAX(v."timestamp") as last_vote_at
        FROM "Vote" v
        INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        INNER JOIN "Attribution" a ON a."pageVerId" = pv.id
        WHERE v."userId" IS NOT NULL 
          AND a."userId" IS NOT NULL
          AND v."userId" != a."userId"  -- 排除自投
          AND v.direction != 0  -- 排除中性投票
        GROUP BY v."userId", a."userId"
        HAVING COUNT(*) > 0
      `,
      
      // 2. 用户标签偏好统计
      prisma.$queryRaw<Array<{
        userId: number;
        tag: string;
        upvote_count: number;
        downvote_count: number;
        total_votes: number;
        last_vote_at: Date;
      }>>`
        SELECT 
          v."userId",
          unnest(pv.tags) as tag,
          SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END)::int as upvote_count,
          SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END)::int as downvote_count,
          COUNT(CASE WHEN v.direction != 0 THEN 1 END)::int as total_votes,
          MAX(v."timestamp") as last_vote_at
        FROM "Vote" v
        INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        WHERE v."userId" IS NOT NULL 
          AND array_length(pv.tags, 1) > 0
          AND v.direction != 0  -- 排除中性投票
        GROUP BY v."userId", unnest(pv.tags)
        HAVING COUNT(*) > 0
      `
    ]);
    
    console.log(`Found ${voteInteractions.length} user vote interactions`);
    console.log(`Found ${tagPreferences.length} user tag preferences`);
    
    // 并行处理两个表的数据更新
    await Promise.all([
      processUserVoteInteractions(prisma, voteInteractions),
      processUserTagPreferences(prisma, tagPreferences)
    ]);


    // 获取统计信息
    const [interactionStats, preferenceStats] = await Promise.all([
      prisma.$queryRaw`
        SELECT 
          COUNT(*) as total_interactions,
          AVG("totalVotes"::float) as avg_votes_per_interaction,
          MAX("totalVotes") as max_votes_to_single_user,
          COUNT(CASE WHEN "totalVotes" >= 10 THEN 1 END) as high_interaction_pairs
        FROM "UserVoteInteraction"
      `,
      prisma.$queryRaw`
        SELECT 
          COUNT(*) as total_preferences,
          COUNT(DISTINCT "userId") as users_with_preferences,
          COUNT(DISTINCT "tag") as unique_tags,
          AVG("totalVotes"::float) as avg_votes_per_tag
        FROM "UserTagPreference"
      `
    ]);

    console.log('✅ 用户投票模式分析完成');
    console.log('📊 用户间投票交互统计:', (interactionStats as any)[0]);
    console.log('🏷️ 用户标签偏好统计:', (preferenceStats as any)[0]);

  } catch (error) {
    console.error('❌ 用户投票模式分析失败:', error);
    throw error;
  }
}

// Calculate most common tags for users
export async function calculateUserTags() {
  const prisma = new PrismaClient();

  try {
    const users = await prisma.user.findMany({
      include: {
        votes: {
          include: {
            pageVersion: {
              select: { tags: true }
            }
          }
        }
      }
    });

    for (const user of users) {
      const tagCounts = new Map<string, number>();
      
      for (const vote of user.votes) {
        for (const tag of vote.pageVersion.tags) {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
      }
      
      const mostCommonTag = Array.from(tagCounts.entries())
        .sort((a, b) => b[1] - a[1])[0]?.[0];

      if (mostCommonTag) {
        await prisma.userStats.upsert({
          where: { userId: user.id },
          update: { favTag: mostCommonTag },
          create: {
            userId: user.id,
            totalUp: 0,
            totalDown: 0,
            totalRating: 0,
            favTag: mostCommonTag
          }
        });
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * \u5904\u7406\u7528\u6237\u6295\u7968\u4ea4\u4e92\u6570\u636e\uff08\u4f18\u5316\u7248\uff09
 */
async function processUserVoteInteractions(
  prisma: PrismaClient, 
  voteInteractions: Array<{
    from_user_id: number;
    to_user_id: number;
    upvote_count: number;
    downvote_count: number;
    total_votes: number;
    last_vote_at: Date;
  }>
) {
  if (voteInteractions.length === 0) return;
  
  console.log('\ud83d\udc65 \u4f7f\u7528\u9ad8\u6548\u6279\u91cf\u5904\u7406\u7528\u6237\u6295\u7968\u4ea4\u4e92\u6570\u636e...');
  
  // \u6e05\u7a7a\u73b0\u6709\u6570\u636e
  await prisma.$executeRaw`TRUNCATE TABLE "UserVoteInteraction" RESTART IDENTITY CASCADE`;
  
  // \u4f7f\u7528\u66f4\u5927\u7684\u6279\u6b21\u5927\u5c0f\u548c\u4f18\u5316\u7684SQL\u8bed\u53e5
  const batchSize = 15000;
  const totalBatches = Math.ceil(voteInteractions.length / batchSize);
  
  for (let i = 0; i < totalBatches; i++) {
    const startIdx = i * batchSize;
    const endIdx = Math.min(startIdx + batchSize, voteInteractions.length);
    const batch = voteInteractions.slice(startIdx, endIdx);
    
    try {
      // Use createMany instead of string concatenation for safety
      await prisma.userVoteInteraction.createMany({
        data: batch.map(interaction => ({
          fromUserId: interaction.from_user_id,
          toUserId: interaction.to_user_id,
          upvoteCount: interaction.upvote_count,
          downvoteCount: interaction.downvote_count,
          totalVotes: interaction.total_votes,
          lastVoteAt: interaction.last_vote_at,
        })),
        skipDuplicates: false
      });
      
      if (i % 5 === 0) { // \u6bcf5\u4e2a\u6279\u6b21\u663e\u793a\u4e00\u6b21\u8fdb\u5ea6
        console.log(`\u6279\u91cf\u5904\u7406\u7b2c ${i + 1}/${totalBatches} \u6279 (${batch.length} \u6761\u8bb0\u5f55)`);
      }
    } catch (error) {
      console.error(`\u6279\u91cf\u5904\u7406\u6279\u6b21 ${i + 1} \u5931\u8d25:`, error.message);
      // \u7ee7\u7eed\u5904\u7406\u4e0b\u4e00\u6279
    }
  }
  
  console.log(`\u2705 \u7528\u6237\u6295\u7968\u4ea4\u4e92\u6570\u636e\u5904\u7406\u5b8c\u6210\uff08${voteInteractions.length} \u6761\u8bb0\u5f55\uff09`);
}

/**
 * \u5904\u7406\u7528\u6237\u6807\u7b7e\u504f\u597d\u6570\u636e\uff08\u4f18\u5316\u7248\uff09
 */
async function processUserTagPreferences(
  prisma: PrismaClient,
  tagPreferences: Array<{
    userId: number;
    tag: string;
    upvote_count: number;
    downvote_count: number;
    total_votes: number;
    last_vote_at: Date;
  }>
) {
  if (tagPreferences.length === 0) return;
  
  console.log('\ud83c\udff7\ufe0f \u4f7f\u7528\u9ad8\u6548\u6279\u91cf\u5904\u7406\u7528\u6237\u6807\u7b7e\u504f\u597d\u6570\u636e...');
  
  // \u6e05\u7a7a\u73b0\u6709\u6570\u636e
  await prisma.$executeRaw`TRUNCATE TABLE "UserTagPreference" RESTART IDENTITY CASCADE`;
  
  // \u4f7f\u7528\u66f4\u5927\u7684\u6279\u6b21\u5927\u5c0f
  const batchSize = 25000;
  const totalBatches = Math.ceil(tagPreferences.length / batchSize);
  
  for (let i = 0; i < totalBatches; i++) {
    const startIdx = i * batchSize;
    const endIdx = Math.min(startIdx + batchSize, tagPreferences.length);
    const batch = tagPreferences.slice(startIdx, endIdx);
    
    try {
      // Use createMany instead of string concatenation for safety
      await prisma.userTagPreference.createMany({
        data: batch.map(preference => ({
          userId: preference.userId,
          tag: preference.tag,
          upvoteCount: preference.upvote_count,
          downvoteCount: preference.downvote_count,
          totalVotes: preference.total_votes,
          lastVoteAt: preference.last_vote_at,
        })),
        skipDuplicates: false
      });
      
      if (i % 3 === 0) { // \u6bcf3\u4e2a\u6279\u6b21\u663e\u793a\u4e00\u6b21\u8fdb\u5ea6
        console.log(`\u6279\u91cf\u5904\u7406\u7b2c ${i + 1}/${totalBatches} \u6279 (${batch.length} \u6761\u8bb0\u5f55)`);
      }
    } catch (error) {
      console.error(`\u6279\u91cf\u5904\u7406\u6279\u6b21 ${i + 1} \u5931\u8d25:`, error.message);
      // \u7ee7\u7eed\u5904\u7406\u4e0b\u4e00\u6279
    }
  }
  
  console.log(`\u2705 \u7528\u6237\u6807\u7b7e\u504f\u597d\u6570\u636e\u5904\u7406\u5b8c\u6210\uff08${tagPreferences.length} \u6761\u8bb0\u5f55\uff09`);
}