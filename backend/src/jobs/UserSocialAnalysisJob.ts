// src/jobs/UserSocialAnalysisJob.ts
import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection';

/**
 * 用户社交分析任务
 * 负责填充和更新：
 * - UserTagPreference: 用户对不同标签的投票偏好
 * - UserVoteInteraction: 用户间的投票交互关系
 */
export class UserSocialAnalysisJob {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || getPrismaClient();
  }

  /**
   * 执行社交分析
   */
  async execute(options: {
    forceFullAnalysis?: boolean;
    batchSize?: number;
  } = {}): Promise<void> {
    const { forceFullAnalysis = false, batchSize = 1000 } = options;

    console.log('🔍 Starting user social analysis job...');

    try {
      // 1. 更新用户标签偏好
      await this.updateUserTagPreferences(forceFullAnalysis, batchSize);

      // 2. 更新用户投票交互
      await this.updateUserVoteInteractions(forceFullAnalysis, batchSize);

      // 3. 显示统计信息
      await this.showStatistics();

      console.log('✅ User social analysis job completed');
    } catch (error) {
      console.error('❌ User social analysis job failed:', error);
      throw error;
    }
  }

  /**
   * 更新用户标签偏好
   */
  private async updateUserTagPreferences(forceFullAnalysis: boolean, batchSize: number): Promise<void> {
    console.log('🏷️ Updating user tag preferences...');

    if (forceFullAnalysis) {
      await this.rebuildAllUserTagPreferences();
      return;
    }

    // 获取需要分析的用户
    const users = await this.getUsersForTagAnalysis(forceFullAnalysis, batchSize);
    console.log(`  ✓ Found ${users.length} users to analyze`);

    let processedCount = 0;

    // 批量处理用户
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      const userIds = batch.map(u => u.id);

      // 使用 SQL 批量计算用户的标签偏好：Vote 存储改投历史，统计只取每个用户对每页的最后一票。
      await this.prisma.$transaction([
        this.prisma.userTagPreference.deleteMany({
          where: {
            userId: { in: userIds }
          }
        }),
        this.prisma.$executeRaw`
        WITH affected_users AS (
          SELECT unnest(${userIds}::int[]) AS "userId"
        ),
        latest_vote_candidates AS (
          SELECT
            v.id,
            v."userId",
            pv."pageId",
            v.direction,
            v.timestamp,
            ROW_NUMBER() OVER (
              PARTITION BY v."userId", pv."pageId"
              ORDER BY v.timestamp DESC, v.id DESC
            ) AS rn
          FROM "Vote" v
          JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
          JOIN affected_users au ON au."userId" = v."userId"
          WHERE v."userId" IS NOT NULL
        ),
        latest_user_page_votes AS (
          SELECT "userId", "pageId", direction, timestamp
          FROM latest_vote_candidates
          WHERE rn = 1
            AND direction != 0
        ),
        user_tag_votes AS (
          SELECT
            lupv."userId",
            unnest(pv_pick.tags) as tag,
            lupv.direction,
            lupv.timestamp
          FROM latest_user_page_votes lupv
          JOIN LATERAL (
            SELECT pv2.tags, pv2."isDeleted"
            FROM "PageVersion" pv2
            WHERE pv2."pageId" = lupv."pageId"
            ORDER BY
              (pv2."validTo" IS NULL) DESC,
              (NOT pv2."isDeleted") DESC,
              pv2."validFrom" DESC NULLS LAST,
              pv2.id DESC
            LIMIT 1
          ) pv_pick ON TRUE
          WHERE pv_pick."isDeleted" = false
            AND pv_pick.tags IS NOT NULL
            AND array_length(pv_pick.tags, 1) > 0
        ),
        tag_stats AS (
          SELECT
            "userId",
            tag,
            COUNT(*) FILTER (WHERE direction > 0) as upvote_count,
            COUNT(*) FILTER (WHERE direction < 0) as downvote_count,
            COUNT(*) as total_votes,
            MAX(timestamp) as last_vote_at
          FROM user_tag_votes
          WHERE tag NOT IN ('页面', '重定向', '管理', '_cc')
          GROUP BY "userId", tag
          HAVING COUNT(*) >= 3  -- 至少投过3次票的标签才记录
        )
        INSERT INTO "UserTagPreference" (
          "userId",
          tag,
          "upvoteCount",
          "downvoteCount",
          "totalVotes",
          "lastVoteAt",
          "createdAt",
          "updatedAt"
        )
        SELECT
          "userId",
          tag,
          upvote_count,
          downvote_count,
          total_votes,
          last_vote_at,
          NOW(),
          NOW()
        FROM tag_stats
        ON CONFLICT ("userId", tag) DO UPDATE SET
          "upvoteCount" = EXCLUDED."upvoteCount",
          "downvoteCount" = EXCLUDED."downvoteCount",
          "totalVotes" = EXCLUDED."totalVotes",
          "lastVoteAt" = EXCLUDED."lastVoteAt",
          "updatedAt" = NOW()
        `
      ]);

      processedCount += batch.length;
      if (processedCount % 1000 === 0) {
        console.log(`  📈 Progress: ${processedCount}/${users.length} users processed`);
      }
    }

    console.log(`  ✓ Updated tag preferences for ${users.length} users`);
  }

  private async rebuildAllUserTagPreferences(): Promise<void> {
    console.log('  🔁 Rebuilding all tag preference data...');

    await this.prisma.$transaction([
      this.prisma.userTagPreference.deleteMany({}),
      this.prisma.$executeRaw`
        WITH latest_vote_candidates AS (
          SELECT
            v.id,
            v."userId",
            pv."pageId",
            v.direction,
            v.timestamp,
            ROW_NUMBER() OVER (
              PARTITION BY v."userId", pv."pageId"
              ORDER BY v.timestamp DESC, v.id DESC
            ) AS rn
          FROM "Vote" v
          JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
          WHERE v."userId" IS NOT NULL
        ),
        latest_user_page_votes AS (
          SELECT "userId", "pageId", direction, timestamp
          FROM latest_vote_candidates
          WHERE rn = 1
            AND direction != 0
        ),
        user_tag_votes AS (
          SELECT
            lupv."userId",
            unnest(pv_pick.tags) as tag,
            lupv.direction,
            lupv.timestamp
          FROM latest_user_page_votes lupv
          JOIN LATERAL (
            SELECT pv2.tags, pv2."isDeleted"
            FROM "PageVersion" pv2
            WHERE pv2."pageId" = lupv."pageId"
            ORDER BY
              (pv2."validTo" IS NULL) DESC,
              (NOT pv2."isDeleted") DESC,
              pv2."validFrom" DESC NULLS LAST,
              pv2.id DESC
            LIMIT 1
          ) pv_pick ON TRUE
          WHERE pv_pick."isDeleted" = false
            AND pv_pick.tags IS NOT NULL
            AND array_length(pv_pick.tags, 1) > 0
        ),
        tag_stats AS (
          SELECT
            "userId",
            tag,
            COUNT(*) FILTER (WHERE direction > 0) as upvote_count,
            COUNT(*) FILTER (WHERE direction < 0) as downvote_count,
            COUNT(*) as total_votes,
            MAX(timestamp) as last_vote_at
          FROM user_tag_votes
          WHERE tag NOT IN ('页面', '重定向', '管理', '_cc')
          GROUP BY "userId", tag
          HAVING COUNT(*) >= 3
        )
        INSERT INTO "UserTagPreference" (
          "userId",
          tag,
          "upvoteCount",
          "downvoteCount",
          "totalVotes",
          "lastVoteAt",
          "createdAt",
          "updatedAt"
        )
        SELECT
          "userId",
          tag,
          upvote_count,
          downvote_count,
          total_votes,
          last_vote_at,
          NOW(),
          NOW()
        FROM tag_stats
      `
    ]);

    console.log('  ✓ Rebuilt all tag preference data');
  }

  /**
   * 更新用户投票交互
   */
  private async updateUserVoteInteractions(forceFullAnalysis: boolean, batchSize: number): Promise<void> {
    console.log('🤝 Updating user vote interactions...');

    if (forceFullAnalysis) {
      await this.rebuildAllUserVoteInteractions();
      return;
    }

    // 获取需要分析的用户对
    const userPairs = await this.getUserPairsForInteractionAnalysis(forceFullAnalysis, batchSize);
    console.log(`  ✓ Found ${userPairs.length} user pairs to analyze`);

    // 批量处理用户对
    for (let i = 0; i < userPairs.length; i += batchSize) {
      const batch = userPairs.slice(i, i + batchSize);

      // 使用 VALUES 构建成对的 from/to 列表并进行半连接，避免文本条件拼接导致的类型问题
      const valuesSql = batch.map(p => `(${Number(p.fromUserId)}, ${Number(p.toUserId)})`).join(', ');

      const deleteSql = `
        WITH pair_list(from_user_id, to_user_id) AS (
          VALUES ${valuesSql}
        )
        DELETE FROM "UserVoteInteraction" uvi
        USING pair_list pl
        WHERE uvi."fromUserId" = pl.from_user_id
          AND uvi."toUserId" = pl.to_user_id
      `;

      const insertSql = `
        WITH effective_attributions AS (
          SELECT DISTINCT a."pageVerId", a."userId"
          FROM (
            SELECT
              a.*,
              BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
          FROM "Attribution" a
          ) a
          WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
            AND a."userId" IS NOT NULL
        ),
        pair_list(from_user_id, to_user_id) AS (
          VALUES ${valuesSql}
        ),
        pair_voters AS (
          SELECT DISTINCT from_user_id FROM pair_list
        ),
        latest_vote_candidates AS (
          SELECT
            v.id,
            v."userId" AS from_user_id,
            pv."pageId" AS page_id,
            v.direction,
            v.timestamp,
            ROW_NUMBER() OVER (
              PARTITION BY v."userId", pv."pageId"
              ORDER BY v.timestamp DESC, v.id DESC
            ) AS rn
          FROM "Vote" v
          JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
          JOIN pair_voters pvu ON pvu.from_user_id = v."userId"
          WHERE v."userId" IS NOT NULL
        ),
        latest_user_page_votes AS (
          SELECT from_user_id, page_id, direction, timestamp
          FROM latest_vote_candidates
          WHERE rn = 1
            AND direction != 0
        ),
        vote_interactions AS (
          SELECT
            lupv.from_user_id,
            a."userId" as to_user_id,
            lupv.direction,
            lupv.timestamp
          FROM latest_user_page_votes lupv
          JOIN LATERAL (
            SELECT pv2.id, pv2."isDeleted"
            FROM "PageVersion" pv2
            WHERE pv2."pageId" = lupv.page_id
            ORDER BY
              (pv2."validTo" IS NULL) DESC,
              (NOT pv2."isDeleted") DESC,
              pv2."validFrom" DESC NULLS LAST,
              pv2.id DESC
            LIMIT 1
          ) pv_pick ON TRUE
          JOIN effective_attributions a ON a."pageVerId" = pv_pick.id
          JOIN pair_list pl ON pl.from_user_id = lupv.from_user_id AND pl.to_user_id = a."userId"
          WHERE lupv.from_user_id != a."userId"
            AND pv_pick."isDeleted" = false
        ),
        interaction_stats AS (
          SELECT
            from_user_id,
            to_user_id,
            COUNT(*) FILTER (WHERE direction > 0) as upvote_count,
            COUNT(*) FILTER (WHERE direction < 0) as downvote_count,
            COUNT(*) as total_votes,
            MAX(timestamp) as last_vote_at
          FROM vote_interactions
          GROUP BY from_user_id, to_user_id
        )
        INSERT INTO "UserVoteInteraction" (
          "fromUserId",
          "toUserId",
          "upvoteCount",
          "downvoteCount",
          "totalVotes",
          "lastVoteAt",
          "createdAt",
          "updatedAt"
        )
        SELECT
          from_user_id,
          to_user_id,
          upvote_count,
          downvote_count,
          total_votes,
          last_vote_at,
          NOW(),
          NOW()
        FROM interaction_stats
        WHERE total_votes > 0
        ON CONFLICT ("fromUserId", "toUserId") DO UPDATE SET
          "upvoteCount" = EXCLUDED."upvoteCount",
          "downvoteCount" = EXCLUDED."downvoteCount",
          "totalVotes" = EXCLUDED."totalVotes",
          "lastVoteAt" = EXCLUDED."lastVoteAt",
          "updatedAt" = NOW()
      `;

      await this.prisma.$transaction([
        this.prisma.$executeRawUnsafe(deleteSql),
        this.prisma.$executeRawUnsafe(insertSql)
      ]);

      if ((i + batch.length) % 5000 === 0) {
        console.log(`  📈 Progress: ${i + batch.length}/${userPairs.length} user pairs processed`);
      }
    }

    console.log(`  ✓ Updated vote interactions for ${userPairs.length} user pairs`);
  }

  private async rebuildAllUserVoteInteractions(): Promise<void> {
    console.log('  🔁 Rebuilding all vote interaction data...');

    await this.prisma.$transaction([
      this.prisma.userVoteInteraction.deleteMany({}),
      this.prisma.$executeRaw`
        WITH effective_attributions AS (
          SELECT DISTINCT a."pageVerId", a."userId"
          FROM (
            SELECT
              a.*,
              BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
            FROM "Attribution" a
          ) a
          WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
            AND a."userId" IS NOT NULL
        ),
        latest_vote_candidates AS (
          SELECT
            v.id,
            v."userId" AS from_user_id,
            pv."pageId" AS page_id,
            v.direction,
            v.timestamp,
            ROW_NUMBER() OVER (
              PARTITION BY v."userId", pv."pageId"
              ORDER BY v.timestamp DESC, v.id DESC
            ) AS rn
          FROM "Vote" v
          JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
          WHERE v."userId" IS NOT NULL
        ),
        latest_user_page_votes AS (
          SELECT from_user_id, page_id, direction, timestamp
          FROM latest_vote_candidates
          WHERE rn = 1
            AND direction != 0
        ),
        vote_interactions AS (
          SELECT
            lupv.from_user_id,
            a."userId" as to_user_id,
            lupv.direction,
            lupv.timestamp
          FROM latest_user_page_votes lupv
          JOIN LATERAL (
            SELECT pv2.id, pv2."isDeleted"
            FROM "PageVersion" pv2
            WHERE pv2."pageId" = lupv.page_id
            ORDER BY
              (pv2."validTo" IS NULL) DESC,
              (NOT pv2."isDeleted") DESC,
              pv2."validFrom" DESC NULLS LAST,
              pv2.id DESC
            LIMIT 1
          ) pv_pick ON TRUE
          JOIN effective_attributions a ON a."pageVerId" = pv_pick.id
          WHERE lupv.from_user_id != a."userId"
            AND pv_pick."isDeleted" = false
        ),
        interaction_stats AS (
          SELECT
            from_user_id,
            to_user_id,
            COUNT(*) FILTER (WHERE direction > 0) as upvote_count,
            COUNT(*) FILTER (WHERE direction < 0) as downvote_count,
            COUNT(*) as total_votes,
            MAX(timestamp) as last_vote_at
          FROM vote_interactions
          GROUP BY from_user_id, to_user_id
        )
        INSERT INTO "UserVoteInteraction" (
          "fromUserId",
          "toUserId",
          "upvoteCount",
          "downvoteCount",
          "totalVotes",
          "lastVoteAt",
          "createdAt",
          "updatedAt"
        )
        SELECT
          from_user_id,
          to_user_id,
          upvote_count,
          downvote_count,
          total_votes,
          last_vote_at,
          NOW(),
          NOW()
        FROM interaction_stats
        WHERE total_votes > 0
      `
    ]);

    console.log('  ✓ Rebuilt all vote interaction data');
  }

  /**
   * 获取需要分析标签偏好的用户
   */
  private async getUsersForTagAnalysis(forceFullAnalysis: boolean, limit: number): Promise<Array<{ id: number }>> {
    if (forceFullAnalysis) {
      // 获取所有有投票记录的用户
      return await this.prisma.$queryRaw<Array<{ id: number }>>`
        SELECT DISTINCT v."userId" as id
        FROM "Vote" v
        WHERE v."userId" IS NOT NULL
        ORDER BY v."userId"
      `;
    } else {
      // 增量模式：获取最近有投票活动的用户
      return await this.prisma.$queryRaw<Array<{ id: number }>>`
        WITH recent_voters AS (
          SELECT DISTINCT v."userId" as id
          FROM "Vote" v
          WHERE v."userId" IS NOT NULL
            AND v.timestamp >= NOW() - INTERVAL '7 days'
        ),
        outdated_preferences AS (
          SELECT DISTINCT "userId" as id
          FROM "UserTagPreference"
          WHERE "updatedAt" < NOW() - INTERVAL '7 days'
        )
        SELECT id FROM recent_voters
        UNION
        SELECT id FROM outdated_preferences
        ORDER BY id
        LIMIT ${limit}
      `;
    }
  }

  /**
   * 获取需要分析投票交互的用户对
   */
  private async getUserPairsForInteractionAnalysis(forceFullAnalysis: boolean, limit: number): Promise<Array<{ fromUserId: number; toUserId: number }>> {
    if (forceFullAnalysis) {
      // 获取所有有投票交互的用户对
      return await this.prisma.$queryRaw<Array<{ fromUserId: number; toUserId: number }>>`
        WITH effective_attributions AS (
          SELECT DISTINCT a."pageVerId", a."userId"
          FROM (
            SELECT
              a.*,
              BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
            FROM "Attribution" a
          ) a
          WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
            AND a."userId" IS NOT NULL
        ),
        latest_vote_candidates AS (
          SELECT
            v.id,
            v."userId" AS from_user_id,
            pv."pageId" AS page_id,
            v.direction,
            v.timestamp,
            ROW_NUMBER() OVER (
              PARTITION BY v."userId", pv."pageId"
              ORDER BY v.timestamp DESC, v.id DESC
            ) AS rn
          FROM "Vote" v
          JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
          WHERE v."userId" IS NOT NULL
        ),
        latest_user_page_votes AS (
          SELECT from_user_id, page_id
          FROM latest_vote_candidates
          WHERE rn = 1
            AND direction != 0
        )
        SELECT DISTINCT
          lupv.from_user_id as "fromUserId",
          a."userId" as "toUserId"
        FROM latest_user_page_votes lupv
        JOIN LATERAL (
          SELECT pv2.id, pv2."isDeleted"
          FROM "PageVersion" pv2
          WHERE pv2."pageId" = lupv.page_id
          ORDER BY
            (pv2."validTo" IS NULL) DESC,
            (NOT pv2."isDeleted") DESC,
            pv2."validFrom" DESC NULLS LAST,
            pv2.id DESC
          LIMIT 1
        ) pv_pick ON TRUE
        JOIN effective_attributions a ON a."pageVerId" = pv_pick.id
        WHERE lupv.from_user_id != a."userId"
          AND pv_pick."isDeleted" = false
        ORDER BY lupv.from_user_id, a."userId"
      `;
    } else {
      // 增量模式：获取最近有新投票的用户对
      return await this.prisma.$queryRaw<Array<{ fromUserId: number; toUserId: number }>>`
        WITH effective_attributions AS (
          SELECT DISTINCT a."pageVerId", a."userId"
          FROM (
            SELECT
              a.*,
              BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
            FROM "Attribution" a
          ) a
          WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
            AND a."userId" IS NOT NULL
        ),
        recent_interactions AS (
          SELECT DISTINCT
            v."userId" as "fromUserId",
            a."userId" as "toUserId"
          FROM "Vote" v
          JOIN "PageVersion" vote_pv ON vote_pv.id = v."pageVersionId"
          JOIN LATERAL (
            SELECT pv2.id, pv2."isDeleted"
            FROM "PageVersion" pv2
            WHERE pv2."pageId" = vote_pv."pageId"
            ORDER BY
              (pv2."validTo" IS NULL) DESC,
              (NOT pv2."isDeleted") DESC,
              pv2."validFrom" DESC NULLS LAST,
              pv2.id DESC
            LIMIT 1
          ) pv_pick ON TRUE
          JOIN effective_attributions a ON a."pageVerId" = pv_pick.id
          WHERE v."userId" IS NOT NULL
            AND v."userId" != a."userId"
            AND pv_pick."isDeleted" = false
            AND v.timestamp >= NOW() - INTERVAL '7 days'
        ),
        outdated_interactions AS (
          SELECT "fromUserId", "toUserId"
          FROM "UserVoteInteraction"
          WHERE "updatedAt" < NOW() - INTERVAL '7 days'
        )
        SELECT "fromUserId", "toUserId" FROM recent_interactions
        UNION
        SELECT "fromUserId", "toUserId" FROM outdated_interactions
        ORDER BY "fromUserId", "toUserId"
        LIMIT ${limit}
      `;
    }
  }

  /**
   * 显示统计信息
   */
  private async showStatistics(): Promise<void> {
    console.log('\n📊 User social analysis statistics:');

    // 标签偏好统计
    const tagStats = await this.prisma.$queryRaw<Array<{
      total_preferences: bigint;
      unique_users: bigint;
      unique_tags: bigint;
      avg_tags_per_user: number;
    }>>`
      SELECT
        (SELECT COUNT(*) FROM "UserTagPreference") as total_preferences,
        (SELECT COUNT(DISTINCT "userId") FROM "UserTagPreference") as unique_users,
        (SELECT COUNT(DISTINCT tag) FROM "UserTagPreference") as unique_tags,
        (
          SELECT AVG(tags_per_user) FROM (
            SELECT "userId", COUNT(*) as tags_per_user
            FROM "UserTagPreference"
            GROUP BY "userId"
          ) s
        ) as avg_tags_per_user
    `;

    const tagStat = tagStats[0];
    console.log('\n🏷️ Tag Preferences:');
    console.log(`  Total preference records: ${tagStat.total_preferences}`);
    console.log(`  Users with preferences: ${tagStat.unique_users}`);
    console.log(`  Unique tags tracked: ${tagStat.unique_tags}`);
    console.log(`  Average tags per user: ${tagStat.avg_tags_per_user?.toFixed(1) || '0'}`);

    // 投票交互统计
    const interactionStats = await this.prisma.$queryRaw<Array<{
      total_interactions: bigint;
      unique_from_users: bigint;
      unique_to_users: bigint;
      mutual_interactions: bigint;
      avg_votes_per_interaction: number;
    }>>`
      WITH interaction_pairs AS (
        SELECT
          i1."fromUserId",
          i1."toUserId",
          i1."totalVotes",
          CASE
            WHEN i2."fromUserId" IS NOT NULL THEN 1
            ELSE 0
          END as is_mutual
        FROM "UserVoteInteraction" i1
        LEFT JOIN "UserVoteInteraction" i2
          ON i1."fromUserId" = i2."toUserId"
          AND i1."toUserId" = i2."fromUserId"
      )
      SELECT
        COUNT(*) as total_interactions,
        COUNT(DISTINCT "fromUserId") as unique_from_users,
        COUNT(DISTINCT "toUserId") as unique_to_users,
        SUM(is_mutual) / 2 as mutual_interactions,
        AVG("totalVotes") as avg_votes_per_interaction
      FROM interaction_pairs
    `;

    const interactionStat = interactionStats[0];
    console.log('\n🤝 Vote Interactions:');
    console.log(`  Total interaction records: ${interactionStat.total_interactions}`);
    console.log(`  Users who voted: ${interactionStat.unique_from_users}`);
    console.log(`  Users who received votes: ${interactionStat.unique_to_users}`);
    console.log(`  Mutual interaction pairs: ${interactionStat.mutual_interactions}`);
    console.log(`  Average votes per interaction: ${interactionStat.avg_votes_per_interaction?.toFixed(1) || '0'}`);

    // 热门标签统计
    const popularTags = await this.prisma.$queryRaw<Array<{
      tag: string;
      user_count: bigint;
      total_votes: bigint;
      avg_upvote_ratio: number;
    }>>`
      SELECT
        tag,
        COUNT(DISTINCT "userId") as user_count,
        SUM("totalVotes") as total_votes,
        AVG(
          CASE
            WHEN "totalVotes" > 0
            THEN "upvoteCount"::float / "totalVotes"::float
            ELSE 0
          END
        ) as avg_upvote_ratio
      FROM "UserTagPreference"
      GROUP BY tag
      ORDER BY total_votes DESC
      LIMIT 10
    `;

    console.log('\n🏷️ Top 10 Popular Tags:');
    popularTags.forEach((tag, index) => {
      console.log(`  ${index + 1}. ${tag.tag}: ${tag.total_votes} votes by ${tag.user_count} users (${(tag.avg_upvote_ratio * 100).toFixed(1)}% upvote ratio)`);
    });
  }
}

/**
 * 便捷的执行函数
 */
export async function updateUserSocialAnalysis(prisma?: PrismaClient, options?: { forceFullAnalysis?: boolean; batchSize?: number }) {
  const job = new UserSocialAnalysisJob(prisma);
  await job.execute(options);
}
