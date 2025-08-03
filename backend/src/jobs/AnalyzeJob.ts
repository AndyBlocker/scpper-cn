import { PrismaClient } from '@prisma/client';
import { calculateUserRatings } from './UserRatingJob.js';
import { calculateSiteStatistics } from './SiteStatsJob.js';

export async function analyze({ since }: { since?: Date } = {}) {
  const prisma = new PrismaClient();

  try {
    console.log('Starting analysis with pure SQL aggregation...');
    
    // Step 1: Calculate page statistics using pure SQL with Wilson and controversy formulas
    const sinceFilter = since ? `AND pv."updatedAt" > '${since.toISOString()}'` : '';
    
    await prisma.$executeRawUnsafe(`
      WITH vote_stats AS (
        SELECT 
          v."pageVersionId",
          SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END) AS uv,
          SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END) AS dv,
          COUNT(*) FILTER (WHERE v.direction != 0) AS total_votes
        FROM "Vote" v
        INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        WHERE 1=1 ${sinceFilter}
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
    `);

    // Step 2: Calculate user statistics with attribution-based logic
    console.log('Calculating user statistics with attribution-based logic...');
    await prisma.$executeRawUnsafe(`
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
    `);

    // Step 3: Calculate and update user first activity timestamps with details
    console.log('Calculating user first activity timestamps with detailed information...');
    
    // First, update just the timestamps and types (faster)
    await prisma.$executeRawUnsafe(`
      WITH user_first_activities AS (
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
          ) as first_activity_at
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
        WHERE LEAST(
          COALESCE(first_vote.timestamp, '2099-01-01'::timestamp),
          COALESCE(first_revision.timestamp, '2099-01-01'::timestamp),
          COALESCE(first_attribution.date, '2099-01-01'::timestamp)
        ) < '2099-01-01'::timestamp
      )
      UPDATE "User" u
      SET 
        "firstActivityAt" = ufa.first_activity_at,
        "firstActivityType" = ufa.activity_type
      FROM user_first_activities ufa
      WHERE u.id = ufa."userId";
    `);

    // Then update activity details for users who have activity types (batch processing)
    console.log('Adding detailed activity descriptions...');
    
    // Update VOTE details
    await prisma.$executeRawUnsafe(`
      UPDATE "User" u
      SET "firstActivityDetails" = '给页面 "' || COALESCE(pv.title, p.url, 'Unknown') || '" 投票'
      FROM "Vote" v
      INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
      INNER JOIN "Page" p ON pv."pageId" = p.id
      WHERE u."firstActivityType" = 'VOTE' 
        AND v."userId" = u.id 
        AND v."timestamp" = u."firstActivityAt"
        AND u."firstActivityDetails" IS NULL;
    `);

    // Update REVISION details
    await prisma.$executeRawUnsafe(`
      UPDATE "User" u
      SET "firstActivityDetails" = '修改了页面 "' || COALESCE(pv.title, p.url, 'Unknown') || '" (' || r.type || ')'
      FROM "Revision" r
      INNER JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
      INNER JOIN "Page" p ON pv."pageId" = p.id
      WHERE u."firstActivityType" = 'REVISION' 
        AND r."userId" = u.id 
        AND r."timestamp" = u."firstActivityAt"
        AND u."firstActivityDetails" IS NULL;
    `);

    // Update ATTRIBUTION details
    await prisma.$executeRawUnsafe(`
      UPDATE "User" u
      SET "firstActivityDetails" = '创建/参与了页面 "' || COALESCE(pv.title, p.url, 'Unknown') || '" (' || a.type || ')'
      FROM "Attribution" a
      INNER JOIN "PageVersion" pv ON a."pageVerId" = pv.id
      INNER JOIN "Page" p ON pv."pageId" = p.id
      WHERE u."firstActivityType" = 'ATTRIBUTION' 
        AND a."userId" = u.id 
        AND a."date" = u."firstActivityAt"
        AND u."firstActivityDetails" IS NULL;
    `);

    // Step 4: Update most common tags for users
    console.log('Updating user favorite tags...');
    await prisma.$executeRawUnsafe(`
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
    `);

    // Step 5: Sync PageVersion counts
    // NOTE: Disabled to prevent dirty queue false positives
    // The voteCount/revisionCount fields are used by buildDirtyQueue for change detection
    // Updating them here causes mismatch with API counts, leading to unnecessary dirty marking
    console.log('Skipping PageVersion count sync to prevent dirty queue false positives...');
    /*
    await prisma.$executeRawUnsafe(`
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
    `);
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
    await calculateSiteStatistics(prisma);

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
 * 计算用户投票模式分析
 * 包括：用户间投票交互统计、用户标签偏好统计
 */
export async function calculateUserVotePatterns(prisma: PrismaClient) {
  console.log('📊 开始分析用户投票模式...');
  
  try {
    // 1. 计算用户间投票交互统计
    console.log('👥 计算用户间投票交互统计...');
    await prisma.$executeRawUnsafe(`
      WITH vote_interactions AS (
        SELECT 
          v."userId" as from_user_id,
          a."userId" as to_user_id,
          SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END) as upvote_count,
          SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END) as downvote_count,
          COUNT(*) FILTER (WHERE v.direction != 0) as total_votes,
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
      )
      INSERT INTO "UserVoteInteraction" (
        "fromUserId", 
        "toUserId", 
        "upvoteCount", 
        "downvoteCount", 
        "totalVotes", 
        "lastVoteAt",
        "updatedAt"
      )
      SELECT 
        from_user_id,
        to_user_id,
        upvote_count,
        downvote_count,
        total_votes,
        last_vote_at,
        CURRENT_TIMESTAMP
      FROM vote_interactions
      ON CONFLICT ("fromUserId", "toUserId") DO UPDATE SET
        "upvoteCount" = EXCLUDED."upvoteCount",
        "downvoteCount" = EXCLUDED."downvoteCount",
        "totalVotes" = EXCLUDED."totalVotes",
        "lastVoteAt" = EXCLUDED."lastVoteAt",
        "updatedAt" = CURRENT_TIMESTAMP;
    `);

    // 2. 计算用户标签偏好统计
    console.log('🏷️ 计算用户标签偏好统计...');
    await prisma.$executeRawUnsafe(`
      WITH tag_preferences AS (
        SELECT 
          v."userId",
          unnest(pv.tags) as tag,
          SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END) as upvote_count,
          SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END) as downvote_count,
          COUNT(*) FILTER (WHERE v.direction != 0) as total_votes,
          MAX(v."timestamp") as last_vote_at
        FROM "Vote" v
        INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        WHERE v."userId" IS NOT NULL 
          AND array_length(pv.tags, 1) > 0
          AND v.direction != 0  -- 排除中性投票
        GROUP BY v."userId", unnest(pv.tags)
        HAVING COUNT(*) > 0
      )
      INSERT INTO "UserTagPreference" (
        "userId", 
        "tag", 
        "upvoteCount", 
        "downvoteCount", 
        "totalVotes", 
        "lastVoteAt",
        "updatedAt"
      )
      SELECT 
        "userId",
        tag,
        upvote_count,
        downvote_count,
        total_votes,
        last_vote_at,
        CURRENT_TIMESTAMP
      FROM tag_preferences
      ON CONFLICT ("userId", "tag") DO UPDATE SET
        "upvoteCount" = EXCLUDED."upvoteCount",
        "downvoteCount" = EXCLUDED."downvoteCount",
        "totalVotes" = EXCLUDED."totalVotes",
        "lastVoteAt" = EXCLUDED."lastVoteAt",
        "updatedAt" = CURRENT_TIMESTAMP;
    `);

    // 3. 获取统计信息
    const interactionStats = await prisma.$queryRaw`
      SELECT 
        COUNT(*) as total_interactions,
        AVG("totalVotes"::float) as avg_votes_per_interaction,
        MAX("totalVotes") as max_votes_to_single_user,
        COUNT(CASE WHEN "totalVotes" >= 10 THEN 1 END) as high_interaction_pairs
      FROM "UserVoteInteraction"
    `;

    const preferenceStats = await prisma.$queryRaw`
      SELECT 
        COUNT(*) as total_preferences,
        COUNT(DISTINCT "userId") as users_with_preferences,
        COUNT(DISTINCT "tag") as unique_tags,
        AVG("totalVotes"::float) as avg_votes_per_tag
      FROM "UserTagPreference"
    `;

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
      
      const mostCommonTag = [...tagCounts.entries()]
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