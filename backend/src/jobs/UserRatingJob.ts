// src/jobs/UserRatingJob.ts
import { PrismaClient } from '@prisma/client';

/**
 * 用户Rating和Ranking系统
 * 根据页面的attribution计算用户的rating和排名
 */
export class UserRatingSystem {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * 确保所有用户都有UserStats记录
   */
  private async ensureUserStatsExist(): Promise<void> {
    console.log('📋 确保所有用户都有UserStats记录...');
    
    // 插入缺失的UserStats记录
    await this.prisma.$executeRawUnsafe(`
      INSERT INTO "UserStats" (
        "userId", 
        "totalUp", "totalDown", "totalRating",
        "scpRating", "scpPageCount",
        "translationRating", "translationPageCount",
        "goiRating", "goiPageCount",
        "storyRating", "storyPageCount",
        "wanderersRating", "wanderersPageCount",
        "artRating", "artPageCount",
        "pageCount", "overallRating"
      )
      SELECT 
        u.id,
        0, 0, 0,
        0, 0,
        0, 0,
        0, 0,
        0, 0,
        0, 0,
        0, 0,
        0, 0
      FROM "User" u
      LEFT JOIN "UserStats" us ON u.id = us."userId"
      WHERE us."userId" IS NULL
      ON CONFLICT ("userId") DO NOTHING
    `);
    
    console.log('✅ UserStats记录创建完成');
  }

  /**
   * 主要的rating计算和排名更新函数
   */
  async updateUserRatingsAndRankings(): Promise<void> {
    console.log('🎯 开始更新用户Rating和Ranking...');
    
    try {
      // 第一步：计算所有用户的rating
      await this.calculateUserRatings();
      
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
   */
  private async calculateUserRatings(): Promise<void> {
    console.log('📊 计算用户rating...');
    
    // 首先确保所有有attribution的用户都有UserStats记录
    await this.ensureUserStatsExist();
    
    // 使用复杂SQL一次性计算所有用户的rating
    await this.prisma.$executeRawUnsafe(`
      WITH pages_attr_on_current AS (
        -- 仅统计用户在“当前版本”上存在归属的页面（按用户-页面去重）
        SELECT DISTINCT a."userId", pv."pageId"
        FROM "Attribution" a
        INNER JOIN "PageVersion" pv ON pv.id = a."pageVerId"
        WHERE a."userId" IS NOT NULL
          AND pv."validTo" IS NULL
          AND pv."isDeleted" = false
      ),
      current_versions AS (
        -- 当前版本（用于读取rating和tags）
        SELECT pv."pageId", pv.rating, pv.tags
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL
          AND pv."isDeleted" = false
          AND pv.rating IS NOT NULL
      ),
      user_contributions AS (
        -- 将“当前版本有归属”的页面映射到其当前版本聚合
        SELECT 
          pac."userId" as "userId",
          SUM(cv.rating::float) as overall_rating,
          COUNT(*) as total_pages,
          
          -- SCP分类 (原创 + scp)
          SUM(CASE 
            WHEN cv.tags @> ARRAY['原创', 'scp'] 
            THEN cv.rating::float
            ELSE 0 
          END) as scp_rating,
          COUNT(CASE 
            WHEN cv.tags @> ARRAY['原创', 'scp'] 
            THEN 1 
          END) as scp_pages,
          
          -- 翻译分类（定义：不包含“原创”标签的页面）
          SUM(CASE 
            WHEN NOT (cv.tags @> ARRAY['原创'])
            THEN cv.rating::float
            ELSE 0 
          END) as translation_rating,
          COUNT(CASE 
            WHEN NOT (cv.tags @> ARRAY['原创']) 
            THEN 1 
          END) as translation_pages,
          
          -- GOI格式分类 (原创 + goi格式)
          SUM(CASE 
            WHEN cv.tags @> ARRAY['原创', 'goi格式'] 
            THEN cv.rating::float
            ELSE 0 
          END) as goi_rating,
          COUNT(CASE 
            WHEN cv.tags @> ARRAY['原创', 'goi格式'] 
            THEN 1 
          END) as goi_pages,
          
          -- 故事分类 (原创 + 故事)
          SUM(CASE 
            WHEN cv.tags @> ARRAY['原创', '故事'] 
            THEN cv.rating::float
            ELSE 0 
          END) as story_rating,
          COUNT(CASE 
            WHEN cv.tags @> ARRAY['原创', '故事'] 
            THEN 1 
          END) as story_pages,
          
          -- Wanderers/图书馆分类 (原创 + wanderers)
          SUM(CASE 
            WHEN cv.tags @> ARRAY['原创', 'wanderers'] 
            THEN cv.rating::float
            ELSE 0 
          END) as wanderers_rating,
          COUNT(CASE 
            WHEN cv.tags @> ARRAY['原创', 'wanderers'] 
            THEN 1 
          END) as wanderers_pages,
          
          -- 艺术作品分类 (原创 + 艺术作品)
          SUM(CASE 
            WHEN cv.tags @> ARRAY['原创', '艺术作品'] 
            THEN cv.rating::float
            ELSE 0 
          END) as art_rating,
          COUNT(CASE 
            WHEN cv.tags @> ARRAY['原创', '艺术作品'] 
            THEN 1 
          END) as art_pages
        FROM pages_attr_on_current pac
        INNER JOIN current_versions cv ON cv."pageId" = pac."pageId"
        GROUP BY pac."userId"
      )
      UPDATE "UserStats" us
      SET 
        "overallRating" = uc.overall_rating,
        "totalRating" = uc.overall_rating::int,
        "pageCount" = uc.total_pages,
        "scpRating" = uc.scp_rating,
        "scpPageCount" = uc.scp_pages,
        "translationRating" = uc.translation_rating,
        "translationPageCount" = uc.translation_pages,
        "goiRating" = uc.goi_rating,
        "goiPageCount" = uc.goi_pages,
        "storyRating" = uc.story_rating,
        "storyPageCount" = uc.story_pages,
        "wanderersRating" = uc.wanderers_rating,
        "wanderersPageCount" = uc.wanderers_pages,
        "artRating" = uc.art_rating,
        "artPageCount" = uc.art_pages
      FROM user_contributions uc
      WHERE us."userId" = uc."userId"
    `);

    console.log('✅ 用户rating计算完成');
  }

  /**
   * 计算排名
   */
  private async calculateRankings(): Promise<void> {
    console.log('🏆 计算用户排名...');
    
    // Overall排名
    await this.calculateCategoryRanking('overallRating', 'overallRank');
    
    // 各分类排名
    await this.calculateCategoryRanking('scpRating', 'scpRank');
    await this.calculateCategoryRanking('translationRating', 'translationRank');
    await this.calculateCategoryRanking('goiRating', 'goiRank');
    await this.calculateCategoryRanking('storyRating', 'storyRank');
    await this.calculateCategoryRanking('wanderersRating', 'wanderersRank');
    await this.calculateCategoryRanking('artRating', 'artRank');
    
    console.log('✅ 用户排名计算完成');
  }

  /**
   * 计算特定分类的排名
   */
  private async calculateCategoryRanking(ratingField: string, rankField: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(`
      WITH ranked_users AS (
        SELECT 
          "userId",
          "${ratingField}",
          ROW_NUMBER() OVER (ORDER BY "${ratingField}" DESC, "userId" ASC) as rank
        FROM "UserStats"
        WHERE "${ratingField}" > 0
      )
      UPDATE "UserStats" us
      SET "${rankField}" = ru.rank
      FROM ranked_users ru
      WHERE us."userId" = ru."userId"
    `);

    // 清除rating为0的用户的排名
    await this.prisma.$executeRawUnsafe(`
      UPDATE "UserStats" 
      SET "${rankField}" = NULL 
      WHERE "${ratingField}" <= 0
    `);
  }

  /**
   * 更新时间戳
   */
  private async updateTimestamps(): Promise<void> {
    await this.prisma.$executeRawUnsafe(`
      UPDATE "UserStats" 
      SET "ratingUpdatedAt" = NOW()
      WHERE "overallRating" > 0
    `);
  }

  /**
   * 获取排行榜数据
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
   * 获取用户的详细rating信息
   */
  async getUserRating(userId: number) {
    return await this.prisma.userStats.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            displayName: true,
            wikidotId: true
          }
        }
      }
    });
  }

  /**
   * 获取用户投票模式相关的查询接口
   */
  
  /**
   * 获取用户的投票目标Top5 (我投票给谁最多)
   */
  async getUserVoteTargets(userId: number, limit: number = 5) {
    return await this.prisma.$queryRaw<Array<{
      toUserId: number;
      displayName: string;
      wikidotId: string;
      upvoteCount: number;
      downvoteCount: number;
      totalVotes: number;
      lastVoteAt: Date | null;
    }>>`
      SELECT 
        uvi."toUserId",
        u."displayName",
        u."wikidotId",
        uvi."upvoteCount",
        uvi."downvoteCount", 
        uvi."totalVotes",
        uvi."lastVoteAt"
      FROM "UserVoteInteraction" uvi
      INNER JOIN "User" u ON uvi."toUserId" = u.id
      WHERE uvi."fromUserId" = ${userId}
      ORDER BY uvi."totalVotes" DESC, uvi."lastVoteAt" DESC
      LIMIT ${limit}
    `;
  }

  /**
   * 获取用户的投票来源Top5 (谁投票给我最多)
   */
  async getUserVoteSources(userId: number, limit: number = 5) {
    return await this.prisma.$queryRaw<Array<{
      fromUserId: number;
      displayName: string;
      wikidotId: string;
      upvoteCount: number;
      downvoteCount: number;
      totalVotes: number;
      lastVoteAt: Date | null;
    }>>`
      SELECT 
        uvi."fromUserId",
        u."displayName",
        u."wikidotId",
        uvi."upvoteCount",
        uvi."downvoteCount",
        uvi."totalVotes",
        uvi."lastVoteAt"
      FROM "UserVoteInteraction" uvi
      INNER JOIN "User" u ON uvi."fromUserId" = u.id
      WHERE uvi."toUserId" = ${userId}
      ORDER BY uvi."totalVotes" DESC, uvi."lastVoteAt" DESC
      LIMIT ${limit}
    `;
  }

  /**
   * 获取用户的标签偏好Top5
   */
  async getUserTagPreferences(userId: number, limit: number = 5) {
    return await this.prisma.$queryRaw<Array<{
      tag: string;
      upvoteCount: number;
      downvoteCount: number;
      totalVotes: number;
      upvoteRatio: number;
      lastVoteAt: Date | null;
    }>>`
      SELECT 
        utp."tag",
        utp."upvoteCount",
        utp."downvoteCount",
        utp."totalVotes",
        CASE 
          WHEN utp."totalVotes" > 0 
          THEN utp."upvoteCount"::float / utp."totalVotes"::float
          ELSE 0
        END as "upvoteRatio",
        utp."lastVoteAt"
      FROM "UserTagPreference" utp
      WHERE utp."userId" = ${userId}
      ORDER BY utp."totalVotes" DESC, utp."upvoteRatio" DESC
      LIMIT ${limit}
    `;
  }

  /**
   * 获取用户的完整投票模式信息
   */
  async getUserVotePattern(userId: number) {
    const [voteTargets, voteSources, tagPreferences] = await Promise.all([
      this.getUserVoteTargets(userId, 5),
      this.getUserVoteSources(userId, 5),
      this.getUserTagPreferences(userId, 10)
    ]);

    return {
      userId,
      voteTargets,      // 我投票给谁最多
      voteSources,      // 谁投票给我最多
      tagPreferences    // 我的标签偏好
    };
  }

  /**
   * 获取最活跃的投票交互对 (用于发现潜在的相互投票)
   */
  async getTopVoteInteractions(limit: number = 20) {
    return await this.prisma.$queryRaw<Array<{
      fromUserId: number;
      fromDisplayName: string;
      toUserId: number;
      toDisplayName: string;
      totalVotes: number;
      upvoteCount: number;
      downvoteCount: number;
      mutualVotes: number | null;
    }>>`
      SELECT 
        uvi1."fromUserId",
        u1."displayName" as "fromDisplayName",
        uvi1."toUserId",
        u2."displayName" as "toDisplayName",
        uvi1."totalVotes",
        uvi1."upvoteCount",
        uvi1."downvoteCount",
        uvi2."totalVotes" as "mutualVotes"
      FROM "UserVoteInteraction" uvi1
      INNER JOIN "User" u1 ON uvi1."fromUserId" = u1.id
      INNER JOIN "User" u2 ON uvi1."toUserId" = u2.id
      LEFT JOIN "UserVoteInteraction" uvi2 
        ON uvi1."fromUserId" = uvi2."toUserId" 
        AND uvi1."toUserId" = uvi2."fromUserId"
      ORDER BY uvi1."totalVotes" DESC
      LIMIT ${limit}
    `;
  }

  /**
   * 获取最受欢迎的标签统计
   */
  async getPopularTags(limit: number = 20) {
    return await this.prisma.$queryRaw<Array<{
      tag: string;
      totalVoters: bigint;
      totalUpvotes: bigint;
      totalDownvotes: bigint;
      totalVotes: bigint;
      avgUpvoteRatio: number;
    }>>`
      SELECT 
        utp."tag",
        COUNT(DISTINCT utp."userId") as "totalVoters",
        SUM(utp."upvoteCount") as "totalUpvotes",
        SUM(utp."downvoteCount") as "totalDownvotes",
        SUM(utp."totalVotes") as "totalVotes",
        AVG(
          CASE 
            WHEN utp."totalVotes" > 0 
            THEN utp."upvoteCount"::float / utp."totalVotes"::float
            ELSE 0
          END
        ) as "avgUpvoteRatio"
      FROM "UserTagPreference" utp
      GROUP BY utp."tag"
      ORDER BY "totalVotes" DESC
      LIMIT ${limit}
    `;
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
 * 集成到分析系统的主函数
 */
export async function calculateUserRatings(prisma: PrismaClient) {
  const ratingSystem = new UserRatingSystem(prisma);
  
  console.log('🎯 开始用户Rating和Ranking分析...');
  await ratingSystem.updateUserRatingsAndRankings();
  
  // 显示统计信息
  const stats = await ratingSystem.getStats();
  console.log('📊 Rating系统统计:');
  console.log(`  总用户数: ${stats.totalUsers}`);
  console.log(`  有rating用户数: ${stats.ratedUsers}`);
  console.log(`  最高rating: ${stats.maxRating?.toFixed(2) || '0'}`);
  console.log(`  平均rating: ${stats.avgRating?.toFixed(2) || '0'}`);
  console.log(`  SCP作者数: ${stats.scpUsers}`);
  console.log(`  翻译作者数: ${stats.translationUsers}`);
  console.log(`  GOI作者数: ${stats.goiUsers}`);
  console.log(`  故事作者数: ${stats.storyUsers}`);
  console.log(`  Wanderers作者数: ${stats.wanderersUsers}`);
  console.log(`  艺术作品作者数: ${stats.artUsers}`);
  
  return stats;
}