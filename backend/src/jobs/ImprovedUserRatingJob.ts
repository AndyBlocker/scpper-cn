import { PrismaClient, Prisma } from '@prisma/client';

/**
 * 改进的用户Rating和Ranking系统
 * 移除了所有$executeRawUnsafe的使用，改用参数化查询
 * 支持增量更新和分片处理
 */
export class ImprovedUserRatingSystem {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * 主要的rating计算和排名更新函数
   */
  async updateUserRatingsAndRankings(affectedUserIds?: number[]): Promise<void> {
    console.log('🎯 开始更新用户Rating和Ranking...');
    
    try {
      // 第一步：计算用户ratings
      await this.calculateUserRatings(affectedUserIds);
      
      // 第二步：计算排名
      await this.calculateRankings();
      
      // 第三步：更新时间戳
      await this.updateTimestamps();
      
      console.log('✅ 用户Rating和Ranking更新完成');
      
    } catch (error) {
      console.error('❌ 更新用户Rating和Ranking失败:', error);
      throw error;
    }
  }

  /**
   * 计算用户rating（基于attribution的页面rating分配）
   * 支持增量更新指定用户
   */
  private async calculateUserRatings(affectedUserIds?: number[]): Promise<void> {
    console.log('📊 计算用户rating...');
    
    const whereClause = affectedUserIds ? Prisma.sql`AND a."userId" = ANY(${affectedUserIds}::int[])` : Prisma.empty;
    
    // 使用参数化查询替代$executeRawUnsafe
    await this.prisma.$executeRaw`
      WITH page_attributions AS (
        -- 获取所有有效页面的attribution信息
        SELECT 
          pv.id as page_version_id,
          pv.rating,
          pv.tags,
          a."userId"
        FROM "PageVersion" pv
        INNER JOIN "Attribution" a ON a."pageVerId" = pv.id
        WHERE pv."validTo" IS NULL 
          AND pv."isDeleted" = false
          AND pv.rating IS NOT NULL
          AND a."userId" IS NOT NULL
          ${whereClause}
      ),
      user_contributions AS (
        -- 计算每个用户的贡献 (每个作者获得完整的页面评分)
        SELECT 
          "userId",
          -- Overall统计
          SUM(rating::float) as overall_rating,
          COUNT(*) as total_pages,
          
          -- SCP分类 (原创 + scp)
          SUM(CASE 
            WHEN tags @> ARRAY['原创', 'scp'] 
            THEN rating::float
            ELSE 0 
          END) as scp_rating,
          COUNT(CASE 
            WHEN tags @> ARRAY['原创', 'scp'] 
            THEN 1 
          END) as scp_pages,
          
          -- 翻译分类 (不包含原创和掩藏页的页面)
          SUM(CASE 
            WHEN NOT (tags @> ARRAY['原创']) 
                 AND NOT (tags @> ARRAY['掩藏页'])
            THEN rating::float
            ELSE 0 
          END) as translation_rating,
          COUNT(CASE 
            WHEN NOT (tags @> ARRAY['原创']) 
                 AND NOT (tags @> ARRAY['掩藏页'])
            THEN 1 
          END) as translation_pages,
          
          -- GOI格式分类 (原创 + goi格式)
          SUM(CASE 
            WHEN tags @> ARRAY['原创', 'goi格式'] 
            THEN rating::float
            ELSE 0 
          END) as goi_rating,
          COUNT(CASE 
            WHEN tags @> ARRAY['原创', 'goi格式'] 
            THEN 1 
          END) as goi_pages,
          
          -- 故事分类 (原创 + 故事)
          SUM(CASE 
            WHEN tags @> ARRAY['原创', '故事'] 
            THEN rating::float
            ELSE 0 
          END) as story_rating,
          COUNT(CASE 
            WHEN tags @> ARRAY['原创', '故事'] 
            THEN 1 
          END) as story_pages,
          
          -- Wanderers/图书馆分类 (原创 + wanderers)
          SUM(CASE 
            WHEN tags @> ARRAY['原创', 'wanderers'] 
            THEN rating::float
            ELSE 0 
          END) as wanderers_rating,
          COUNT(CASE 
            WHEN tags @> ARRAY['原创', 'wanderers'] 
            THEN 1 
          END) as wanderers_pages,
          
          -- 艺术作品分类 (原创 + 艺术作品)
          SUM(CASE 
            WHEN tags @> ARRAY['原创', '艺术作品'] 
            THEN rating::float
            ELSE 0 
          END) as art_rating,
          COUNT(CASE 
            WHEN tags @> ARRAY['原创', '艺术作品'] 
            THEN 1 
          END) as art_pages
          
        FROM page_attributions
        GROUP BY "userId"
      )
      INSERT INTO "UserStats" ("userId", "overallRating", "pageCount", "scpRating", "scpPageCount", 
                               "translationRating", "translationPageCount", "goiRating", "goiPageCount",
                               "storyRating", "storyPageCount", "wanderersRating", "wanderersPageCount",
                               "artRating", "artPageCount", "totalUp", "totalDown", "totalRating")
      SELECT uc."userId", uc.overall_rating, uc.total_pages, uc.scp_rating, uc.scp_pages,
             uc.translation_rating, uc.translation_pages, uc.goi_rating, uc.goi_pages,
             uc.story_rating, uc.story_pages, uc.wanderers_rating, uc.wanderers_pages,
             uc.art_rating, uc.art_pages, 0, 0, uc.overall_rating::int
      FROM user_contributions uc
      ON CONFLICT ("userId") DO UPDATE SET 
        "overallRating" = EXCLUDED."overallRating",
        "pageCount" = EXCLUDED."pageCount",
        "scpRating" = EXCLUDED."scpRating",
        "scpPageCount" = EXCLUDED."scpPageCount",
        "translationRating" = EXCLUDED."translationRating",
        "translationPageCount" = EXCLUDED."translationPageCount",
        "goiRating" = EXCLUDED."goiRating",
        "goiPageCount" = EXCLUDED."goiPageCount",
        "storyRating" = EXCLUDED."storyRating",
        "storyPageCount" = EXCLUDED."storyPageCount",
        "wanderersRating" = EXCLUDED."wanderersRating",
        "wanderersPageCount" = EXCLUDED."wanderersPageCount",
        "artRating" = EXCLUDED."artRating",
        "artPageCount" = EXCLUDED."artPageCount",
        "totalRating" = EXCLUDED."totalRating"
    `;

    console.log('✅ 用户rating计算完成');
  }

  /**
   * 计算排名
   */
  private async calculateRankings(): Promise<void> {
    console.log('🏆 计算用户排名...');
    
    // 定义字段映射
    const rankings = [
      { ratingField: 'overallRating', rankField: 'overallRank' },
      { ratingField: 'scpRating', rankField: 'scpRank' },
      { ratingField: 'translationRating', rankField: 'translationRank' },
      { ratingField: 'goiRating', rankField: 'goiRank' },
      { ratingField: 'storyRating', rankField: 'storyRank' },
      { ratingField: 'wanderersRating', rankField: 'wanderersRank' },
      { ratingField: 'artRating', rankField: 'artRank' }
    ];
    
    // 为每个分类计算排名
    for (const { ratingField, rankField } of rankings) {
      await this.calculateCategoryRanking(ratingField, rankField);
    }
    
    console.log('✅ 用户排名计算完成');
  }

  /**
   * 计算特定分类的排名（使用参数化查询）
   */
  private async calculateCategoryRanking(ratingField: string, rankField: string): Promise<void> {
    // 使用临时表来存储排名结果，然后批量更新
    const tempTableName = `temp_ranking_${Date.now()}`;
    
    await this.prisma.$executeRaw`
      CREATE TEMP TABLE ${Prisma.raw(tempTableName)} AS
      SELECT 
        "userId",
        ROW_NUMBER() OVER (ORDER BY ${Prisma.raw(`"${ratingField}"`)} DESC, "userId" ASC) as rank
      FROM "UserStats"
      WHERE ${Prisma.raw(`"${ratingField}"`)} > 0
    `;

    // 批量更新排名
    await this.prisma.$executeRaw`
      UPDATE "UserStats" us
      SET ${Prisma.raw(`"${rankField}"`)} = tr.rank
      FROM ${Prisma.raw(tempTableName)} tr
      WHERE us."userId" = tr."userId"
    `;

    // 清除rating为0的用户的排名
    await this.prisma.$executeRaw`
      UPDATE "UserStats" 
      SET ${Prisma.raw(`"${rankField}"`)} = NULL 
      WHERE ${Prisma.raw(`"${ratingField}"`)} <= 0
    `;
  }

  /**
   * 更新时间戳
   */
  private async updateTimestamps(): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "UserStats" 
      SET "ratingUpdatedAt" = NOW()
      WHERE "overallRating" > 0
    `;
  }

  /**
   * 分片重算用户投票交互（避免全量TRUNCATE）
   */
  async updateUserVoteInteractions(affectedUserIds?: number[]): Promise<void> {
    console.log('🔄 更新用户投票交互数据...');
    
    if (affectedUserIds && affectedUserIds.length > 0) {
      // 增量更新：删除受影响用户的旧数据
      await this.prisma.$executeRaw`
        DELETE FROM "UserVoteInteraction" 
        WHERE "fromUserId" = ANY(${affectedUserIds}::int[])
      `;

      // 重新计算这些用户的投票交互
      await this.prisma.$executeRaw`
        INSERT INTO "UserVoteInteraction" ("fromUserId", "toUserId", "upvoteCount", "downvoteCount", "totalVotes", "lastVoteAt")
        SELECT 
          v."userId" as "fromUserId",
          a."userId" as "toUserId",
          SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END)::int as "upvoteCount",
          SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END)::int as "downvoteCount",
          COUNT(CASE WHEN v.direction != 0 THEN 1 END)::int as "totalVotes",
          MAX(v."timestamp") as "lastVoteAt"
        FROM "Vote" v
        INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        INNER JOIN "Attribution" a ON a."pageVerId" = pv.id
        WHERE v."userId" = ANY(${affectedUserIds}::int[])
          AND a."userId" IS NOT NULL
          AND v."userId" != a."userId"  -- 排除自投
          AND v.direction != 0  -- 排除中性投票
        GROUP BY v."userId", a."userId"
        HAVING COUNT(*) > 0
        ON CONFLICT ("fromUserId", "toUserId") DO UPDATE SET
          "upvoteCount" = EXCLUDED."upvoteCount",
          "downvoteCount" = EXCLUDED."downvoteCount",
          "totalVotes" = EXCLUDED."totalVotes",
          "lastVoteAt" = EXCLUDED."lastVoteAt"
      `;
    } else {
      // 全量重算（仅在必要时使用）
      console.log('⚠️ 执行全量用户投票交互重算...');
      await this.prisma.$executeRaw`TRUNCATE TABLE "UserVoteInteraction" RESTART IDENTITY CASCADE`;
      
      await this.prisma.$executeRaw`
        INSERT INTO "UserVoteInteraction" ("fromUserId", "toUserId", "upvoteCount", "downvoteCount", "totalVotes", "lastVoteAt")
        SELECT 
          v."userId" as "fromUserId",
          a."userId" as "toUserId",
          SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END)::int as "upvoteCount",
          SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END)::int as "downvoteCount",
          COUNT(CASE WHEN v.direction != 0 THEN 1 END)::int as "totalVotes",
          MAX(v."timestamp") as "lastVoteAt"
        FROM "Vote" v
        INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        INNER JOIN "Attribution" a ON a."pageVerId" = pv.id
        WHERE v."userId" IS NOT NULL 
          AND a."userId" IS NOT NULL
          AND v."userId" != a."userId"  -- 排除自投
          AND v.direction != 0  -- 排除中性投票
        GROUP BY v."userId", a."userId"
        HAVING COUNT(*) > 0
      `;
    }
    
    console.log('✅ 用户投票交互数据更新完成');
  }

  /**
   * 分片重算用户标签偏好（避免全量TRUNCATE）
   */
  async updateUserTagPreferences(affectedUserIds?: number[]): Promise<void> {
    console.log('🏷️ 更新用户标签偏好数据...');
    
    if (affectedUserIds && affectedUserIds.length > 0) {
      // 增量更新：删除受影响用户的旧数据
      await this.prisma.$executeRaw`
        DELETE FROM "UserTagPreference" 
        WHERE "userId" = ANY(${affectedUserIds}::int[])
      `;

      // 重新计算这些用户的标签偏好
      await this.prisma.$executeRaw`
        INSERT INTO "UserTagPreference" ("userId", "tag", "upvoteCount", "downvoteCount", "totalVotes", "lastVoteAt")
        SELECT 
          v."userId",
          unnest(pv.tags) as tag,
          SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END)::int as "upvoteCount",
          SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END)::int as "downvoteCount",
          COUNT(CASE WHEN v.direction != 0 THEN 1 END)::int as "totalVotes",
          MAX(v."timestamp") as "lastVoteAt"
        FROM "Vote" v
        INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        WHERE v."userId" = ANY(${affectedUserIds}::int[])
          AND array_length(pv.tags, 1) > 0
          AND v.direction != 0  -- 排除中性投票
        GROUP BY v."userId", unnest(pv.tags)
        HAVING COUNT(*) > 0
        ON CONFLICT ("userId", "tag") DO UPDATE SET
          "upvoteCount" = EXCLUDED."upvoteCount",
          "downvoteCount" = EXCLUDED."downvoteCount",
          "totalVotes" = EXCLUDED."totalVotes",
          "lastVoteAt" = EXCLUDED."lastVoteAt"
      `;
    } else {
      // 全量重算（仅在必要时使用）
      console.log('⚠️ 执行全量用户标签偏好重算...');
      await this.prisma.$executeRaw`TRUNCATE TABLE "UserTagPreference" RESTART IDENTITY CASCADE`;
      
      await this.prisma.$executeRaw`
        INSERT INTO "UserTagPreference" ("userId", "tag", "upvoteCount", "downvoteCount", "totalVotes", "lastVoteAt")
        SELECT 
          v."userId",
          unnest(pv.tags) as tag,
          SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END)::int as "upvoteCount",
          SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END)::int as "downvoteCount",
          COUNT(CASE WHEN v.direction != 0 THEN 1 END)::int as "totalVotes",
          MAX(v."timestamp") as "lastVoteAt"
        FROM "Vote" v
        INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        WHERE v."userId" IS NOT NULL 
          AND array_length(pv.tags, 1) > 0
          AND v.direction != 0  -- 排除中性投票
        GROUP BY v."userId", unnest(pv.tags)
        HAVING COUNT(*) > 0
      `;
    }
    
    console.log('✅ 用户标签偏好数据更新完成');
  }

  /**
   * 获取排行榜数据（使用TypeScript类型安全）
   */
  async getRankings(category: 'overall' | 'scp' | 'translation' | 'goi' | 'story' | 'wanderers' | 'art' = 'overall', limit: number = 50) {
    const fieldMapping = {
      overall: { rating: 'overallRating', rank: 'overallRank', count: 'pageCount' },
      scp: { rating: 'scpRating', rank: 'scpRank', count: 'scpPageCount' },
      translation: { rating: 'translationRating', rank: 'translationRank', count: 'translationPageCount' },
      goi: { rating: 'goiRating', rank: 'goiRank', count: 'goiPageCount' },
      story: { rating: 'storyRating', rank: 'storyRank', count: 'storyPageCount' },
      wanderers: { rating: 'wanderersRating', rank: 'wanderersRank', count: 'wanderersPageCount' },
      art: { rating: 'artRating', rank: 'artRank', count: 'artPageCount' }
    };

    const fields = fieldMapping[category];
    
    return await this.prisma.userStats.findMany({
      where: {
        [fields.rating]: { gt: 0 }
      },
      include: {
        user: {
          select: {
            displayName: true,
            wikidotId: true
          }
        }
      },
      orderBy: [
        { [fields.rank]: 'asc' }
      ],
      take: limit
    });
  }

  /**
   * 缓存排行榜到LeaderboardCache表
   */
  async cacheLeaderboards(): Promise<void> {
    console.log('💾 缓存排行榜数据...');
    
    const categories = ['overall', 'scp', 'translation', 'goi', 'story', 'wanderers', 'art'] as const;
    const periods = ['7d', '30d', 'all_time'];
    
    for (const category of categories) {
      const rankings = await this.getRankings(category, 100);
      
      for (const period of periods) {
        await this.prisma.leaderboardCache.upsert({
          where: {
            key_period: {
              key: `user_ranking_${category}`,
              period: period
            }
          },
          create: {
            key: `user_ranking_${category}`,
            period: period,
            payload: rankings,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24小时过期
          },
          update: {
            payload: rankings,
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
          }
        });
      }
    }
    
    console.log('✅ 排行榜缓存完成');
  }

  /**
   * 获取统计信息
   */
  async getStats() {
    const stats = await this.prisma.$queryRaw<Array<{
      total_users: bigint;
      rated_users: bigint;
      max_rating: number | null;
      avg_rating: number | null;
      scp_users: bigint;
      translation_users: bigint;
      goi_users: bigint;
      story_users: bigint;
      wanderers_users: bigint;
      art_users: bigint;
    }>>`
      SELECT 
        COUNT(*) as total_users,
        COUNT(CASE WHEN "overallRating" > 0 THEN 1 END) as rated_users,
        MAX("overallRating") as max_rating,
        AVG("overallRating") as avg_rating,
        COUNT(CASE WHEN "scpRating" > 0 THEN 1 END) as scp_users,
        COUNT(CASE WHEN "translationRating" > 0 THEN 1 END) as translation_users,
        COUNT(CASE WHEN "goiRating" > 0 THEN 1 END) as goi_users,
        COUNT(CASE WHEN "storyRating" > 0 THEN 1 END) as story_users,
        COUNT(CASE WHEN "wanderersRating" > 0 THEN 1 END) as wanderers_users,
        COUNT(CASE WHEN "artRating" > 0 THEN 1 END) as art_users
      FROM "UserStats"
    `;

    return {
      totalUsers: Number(stats[0].total_users),
      ratedUsers: Number(stats[0].rated_users),
      maxRating: stats[0].max_rating,
      avgRating: stats[0].avg_rating,
      scpUsers: Number(stats[0].scp_users),
      translationUsers: Number(stats[0].translation_users),
      goiUsers: Number(stats[0].goi_users),
      storyUsers: Number(stats[0].story_users),
      wanderersUsers: Number(stats[0].wanderers_users),
      artUsers: Number(stats[0].art_users)
    };
  }
}

/**
 * 集成到增量分析系统的函数
 */
export async function calculateImprovedUserRatings(prisma: PrismaClient, affectedUserIds?: number[]) {
  const ratingSystem = new ImprovedUserRatingSystem(prisma);
  
  console.log('🎯 开始改进的用户Rating和Ranking分析...');
  
  // 更新用户ratings和rankings
  await ratingSystem.updateUserRatingsAndRankings(affectedUserIds);
  
  // 更新投票交互和标签偏好（如果有受影响的用户）
  if (affectedUserIds && affectedUserIds.length > 0) {
    await ratingSystem.updateUserVoteInteractions(affectedUserIds);
    await ratingSystem.updateUserTagPreferences(affectedUserIds);
  }
  
  // 缓存排行榜
  await ratingSystem.cacheLeaderboards();
  
  // 显示统计信息
  const stats = await ratingSystem.getStats();
  console.log('📊 改进版Rating系统统计:');
  console.log(`  总用户数: ${stats.totalUsers}`);
  console.log(`  有rating用户数: ${stats.ratedUsers}`);
  console.log(`  最高rating: ${stats.maxRating?.toFixed(2) || '0'}`);
  console.log(`  平均rating: ${stats.avgRating?.toFixed(2) || '0'}`);
  
  return stats;
}