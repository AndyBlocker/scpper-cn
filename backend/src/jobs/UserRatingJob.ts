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
    
    // 使用复杂SQL一次性计算所有用户的rating
    await this.prisma.$executeRawUnsafe(`
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
          
          -- 翻译分类
          SUM(CASE 
            WHEN tags @> ARRAY['翻译'] 
            THEN rating::float
            ELSE 0 
          END) as translation_rating,
          COUNT(CASE 
            WHEN tags @> ARRAY['翻译'] 
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
          END) as story_pages
          
        FROM page_attributions
        GROUP BY "userId"
      )
      UPDATE "UserStats" us
      SET 
        "overallRating" = uc.overall_rating,
        "pageCount" = uc.total_pages,
        "scpRating" = uc.scp_rating,
        "scpPageCount" = uc.scp_pages,
        "translationRating" = uc.translation_rating,
        "translationPageCount" = uc.translation_pages,
        "goiRating" = uc.goi_rating,
        "goiPageCount" = uc.goi_pages,
        "storyRating" = uc.story_rating,
        "storyPageCount" = uc.story_pages
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
  async getRankings(category: 'overall' | 'scp' | 'translation' | 'goi' | 'story' = 'overall', limit: number = 50) {
    const fieldMapping = {
      overall: { rating: 'overallRating', rank: 'overallRank', count: 'pageCount' },
      scp: { rating: 'scpRating', rank: 'scpRank', count: 'scpPageCount' },
      translation: { rating: 'translationRating', rank: 'translationRank', count: 'translationPageCount' },
      goi: { rating: 'goiRating', rank: 'goiRank', count: 'goiPageCount' },
      story: { rating: 'storyRating', rank: 'storyRank', count: 'storyPageCount' }
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
        COUNT(CASE WHEN "storyRating" > 0 THEN 1 END) as story_users
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
      storyUsers: Number(stats[0].story_users)
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
  
  return stats;
}