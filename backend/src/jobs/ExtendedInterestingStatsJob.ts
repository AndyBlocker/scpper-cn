import { PrismaClient } from '@prisma/client';

/**
 * 扩展的有趣统计任务
 * 基于 reply.md 文档第4部分的有趣统计扩展清单
 */
export class ExtendedInterestingStatsJob {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * 生成所有扩展的有趣统计
   */
  async generateAllStats() {
    console.log('📊 生成扩展有趣统计...');

    try {
      // 1. 作者成长曲线
      await this.generateAuthorGrowthCurves();
      
      // 2. 高争议标签
      await this.generateControversialTags();
      
      // 3. 首发时段分布
      await this.generatePublishingTimePatterns();
      
      // 4. 编号段空洞与密集区
      await this.generateNumberingPatterns();
      
      // 5. 长尾点赞王
      await this.generateLongTailChampions();
      
      // 6. 编辑英雄榜
      await this.generateEditingChampions();
      
      // 7. 里程碑统计
      await this.generateMilestoneStats();
      
      // 8. 标签组合分析
      await this.generateTagCombinationAnalysis();

      console.log('✅ 扩展有趣统计生成完成');

    } catch (error) {
      console.error('❌ 扩展有趣统计生成失败:', error);
      throw error;
    }
  }

  /**
   * 1. 作者成长曲线 - 按作者 firstPublishedAt 对其作品评分累计
   */
  private async generateAuthorGrowthCurves() {
    console.log('📈 分析作者成长曲线...');

    // 前N篇作品内增速最快的作者
    const fastGrowthAuthors = await this.prisma.$queryRaw<Array<{
      userId: number;
      displayName: string;
      firstNPages: number;
      totalRating: number;
      avgRatingPerPage: number;
      timespan: number;
    }>>`
      WITH author_pages AS (
        SELECT 
          a."userId",
          u."displayName",
          pv.rating,
          p."firstPublishedAt",
          ROW_NUMBER() OVER (PARTITION BY a."userId" ORDER BY p."firstPublishedAt" ASC) as page_order
        FROM "Attribution" a
        JOIN "User" u ON a."userId" = u.id
        JOIN "PageVersion" pv ON a."pageVerId" = pv.id
        JOIN "Page" p ON pv."pageId" = p.id
        WHERE a.type = 'author'
          AND pv."validTo" IS NULL 
          AND pv."isDeleted" = false
          AND pv.rating IS NOT NULL
          AND p."firstPublishedAt" IS NOT NULL
      ),
      first_n_pages AS (
        SELECT 
          "userId",
          "displayName",
          COUNT(*) as first_n_pages,
          SUM(rating) as total_rating,
          AVG(rating::float) as avg_rating_per_page,
          EXTRACT(EPOCH FROM (MAX("firstPublishedAt") - MIN("firstPublishedAt")))/86400 as timespan_days
        FROM author_pages
        WHERE page_order <= 5  -- 前5篇作品
        GROUP BY "userId", "displayName"
        HAVING COUNT(*) >= 3  -- 至少3篇作品
      )
      SELECT 
        "userId",
        "displayName",
        first_n_pages::int,
        total_rating::int,
        avg_rating_per_page,
        timespan_days::int as timespan
      FROM first_n_pages
      ORDER BY avg_rating_per_page DESC, total_rating DESC
      LIMIT 10
    `;

    // 保存到InterestingFacts表
    for (let i = 0; i < fastGrowthAuthors.length; i++) {
      const author = fastGrowthAuthors[i];
      await this.upsertInterestingFact({
        category: 'author_growth',
        type: 'fast_early_growth',
        title: `早期作品高分作者 #${i + 1}`,
        description: `${author.displayName} 在前${author.firstNPages}篇作品中平均获得${author.avgRatingPerPage.toFixed(1)}分，总计${author.totalRating}分`,
        value: author.avgRatingPerPage.toFixed(1),
        userId: author.userId,
        rank: i + 1,
        metadata: {
          totalRating: author.totalRating,
          pageCount: author.firstNPages,
          timespan: author.timespan
        }
      });
    }

    console.log(`✅ 生成了 ${fastGrowthAuthors.length} 个作者成长曲线统计`);
  }

  /**
   * 2. 高争议标签 - 对标签下页面的 controversy 取均值/TopN
   */
  private async generateControversialTags() {
    console.log('🔥 分析高争议标签...');

    const controversialTags = await this.prisma.$queryRaw<Array<{
      tag: string;
      pageCount: bigint;
      avgControversy: number;
      maxControversy: number;
      totalVotes: bigint;
    }>>`
      SELECT 
        unnest(pv.tags) as tag,
        COUNT(*) as page_count,
        AVG(ps.controversy) as avg_controversy,
        MAX(ps.controversy) as max_controversy,
        SUM(ps.uv + ps.dv) as total_votes
      FROM "PageVersion" pv
      JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND array_length(pv.tags, 1) > 0
        AND ps.controversy > 0
      GROUP BY unnest(pv.tags)
      HAVING COUNT(*) >= 5  -- 至少5个页面的标签
      ORDER BY avg_controversy DESC
      LIMIT 15
    `;

    for (let i = 0; i < controversialTags.length; i++) {
      const tag = controversialTags[i];
      await this.upsertInterestingFact({
        category: 'tag_controversy',
        type: 'high_controversy_tag',
        title: `高争议标签 #${i + 1}: ${tag.tag}`,
        description: `标签"${tag.tag}"下的${Number(tag.pageCount)}个页面平均争议度为${tag.avgControversy.toFixed(3)}，最高争议度${tag.maxControversy.toFixed(3)}`,
        value: tag.avgControversy.toFixed(3),
        tagContext: tag.tag,
        rank: i + 1,
        metadata: {
          pageCount: Number(tag.pageCount),
          maxControversy: tag.maxControversy,
          totalVotes: Number(tag.totalVotes)
        }
      });
    }

    console.log(`✅ 生成了 ${controversialTags.length} 个高争议标签统计`);
  }

  /**
   * 3. 首发时段分布 - 按小时/星期，统计页面首发量与平均评分
   */
  private async generatePublishingTimePatterns() {
    console.log('⏰ 分析首发时段分布...');

    // 按小时统计
    const hourlyStats = await this.prisma.$queryRaw<Array<{
      hour: number;
      pageCount: bigint;
      avgRating: number;
      topRating: number;
    }>>`
      SELECT 
        EXTRACT(HOUR FROM p."firstPublishedAt") as hour,
        COUNT(*) as page_count,
        AVG(pv.rating::float) as avg_rating,
        MAX(pv.rating) as top_rating
      FROM "Page" p
      JOIN "PageVersion" pv ON pv."pageId" = p.id
      WHERE p."firstPublishedAt" IS NOT NULL
        AND pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND pv.rating IS NOT NULL
      GROUP BY EXTRACT(HOUR FROM p."firstPublishedAt")
      ORDER BY avg_rating DESC
      LIMIT 5
    `;

    for (let i = 0; i < hourlyStats.length; i++) {
      const stat = hourlyStats[i];
      await this.upsertInterestingFact({
        category: 'time_pattern',
        type: 'best_publishing_hour',
        title: `最佳发布时段 #${i + 1}`,
        description: `${stat.hour}时发布的${Number(stat.pageCount)}篇页面平均评分${stat.avgRating.toFixed(1)}分，最高${stat.topRating}分`,
        value: stat.avgRating.toFixed(1),
        rank: i + 1,
        metadata: {
          hour: stat.hour,
          pageCount: Number(stat.pageCount),
          topRating: stat.topRating
        }
      });
    }

    // 按星期几统计
    const weekdayStats = await this.prisma.$queryRaw<Array<{
      weekday: number;
      pageCount: bigint;
      avgRating: number;
    }>>`
      SELECT 
        EXTRACT(DOW FROM p."firstPublishedAt") as weekday,
        COUNT(*) as page_count,
        AVG(pv.rating::float) as avg_rating
      FROM "Page" p
      JOIN "PageVersion" pv ON pv."pageId" = p.id
      WHERE p."firstPublishedAt" IS NOT NULL
        AND pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND pv.rating IS NOT NULL
      GROUP BY EXTRACT(DOW FROM p."firstPublishedAt")
      ORDER BY avg_rating DESC
      LIMIT 3
    `;

    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    for (let i = 0; i < weekdayStats.length; i++) {
      const stat = weekdayStats[i];
      await this.upsertInterestingFact({
        category: 'time_pattern',
        type: 'best_publishing_weekday',
        title: `最佳发布星期 #${i + 1}`,
        description: `${weekdays[stat.weekday]}发布的${Number(stat.pageCount)}篇页面平均评分${stat.avgRating.toFixed(1)}分`,
        value: stat.avgRating.toFixed(1),
        rank: i + 1,
        metadata: {
          weekday: stat.weekday,
          weekdayName: weekdays[stat.weekday],
          pageCount: Number(stat.pageCount)
        }
      });
    }

    console.log(`✅ 生成了 ${hourlyStats.length + weekdayStats.length} 个时段分布统计`);
  }

  /**
   * 4. 编号段"空洞"与"密集区" - SCP-CN 系列编号分析
   */
  private async generateNumberingPatterns() {
    console.log('🔢 分析编号段分布...');

    // 分析SCP-CN编号的使用情况
    const numberingGaps = await this.prisma.$queryRaw<Array<{
      seriesStart: number;
      seriesEnd: number;
      totalSlots: number;
      usedSlots: bigint;
      gapSize: number;
      density: number;
    }>>`
      WITH scp_numbers AS (
        SELECT 
          p.url,
          CASE 
            WHEN p.url ~ 'scp-cn-[0-9]+$' 
            THEN substring(p.url from 'scp-cn-([0-9]+)$')::int
          END as scp_number
        FROM "Page" p
        JOIN "PageVersion" pv ON pv."pageId" = p.id
        WHERE p.url ~ 'scp-cn-[0-9]+$'
          AND pv."validTo" IS NULL 
          AND pv."isDeleted" = false
      ),
      series_analysis AS (
        SELECT 
          (scp_number / 1000) * 1000 as series_start,
          (scp_number / 1000) * 1000 + 999 as series_end,
          COUNT(*) as used_slots
        FROM scp_numbers 
        WHERE scp_number IS NOT NULL
        GROUP BY (scp_number / 1000) * 1000
        HAVING COUNT(*) >= 10  -- 至少10个编号的系列
      )
      SELECT 
        series_start,
        series_end,
        1000 as total_slots,
        used_slots,
        1000 - used_slots::int as gap_size,
        (used_slots::float / 1000) as density
      FROM series_analysis
      ORDER BY density DESC
      LIMIT 10
    `;

    for (let i = 0; i < numberingGaps.length; i++) {
      const gap = numberingGaps[i];
      await this.upsertInterestingFact({
        category: 'numbering_pattern',
        type: 'series_density',
        title: `SCP-CN编号密集区 #${i + 1}`,
        description: `SCP-CN-${gap.seriesStart}-${gap.seriesEnd}区间使用了${Number(gap.usedSlots)}个编号，使用率${(gap.density * 100).toFixed(1)}%`,
        value: (gap.density * 100).toFixed(1),
        rank: i + 1,
        metadata: {
          seriesStart: gap.seriesStart,
          seriesEnd: gap.seriesEnd,
          usedSlots: Number(gap.usedSlots),
          gapSize: gap.gapSize,
          density: gap.density
        }
      });
    }

    console.log(`✅ 生成了 ${numberingGaps.length} 个编号段分析统计`);
  }

  /**
   * 5. 长尾点赞王 - 低票数但 Wilson 很高的冷门页面
   */
  private async generateLongTailChampions() {
    console.log('👑 寻找长尾点赞王...');

    const longTailChampions = await this.prisma.$queryRaw<Array<{
      pageId: number;
      title: string;
      url: string;
      rating: number;
      totalVotes: number;
      wilson95: number;
      likeRatio: number;
    }>>`
      SELECT 
        p.id as page_id,
        pv.title,
        p.url,
        pv.rating,
        (ps.uv + ps.dv) as total_votes,
        ps.wilson95,
        ps."likeRatio"
      FROM "Page" p
      JOIN "PageVersion" pv ON pv."pageId" = p.id
      JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND (ps.uv + ps.dv) BETWEEN 5 AND 20  -- 低票数
        AND ps.wilson95 > 0.7  -- 高Wilson分数
        AND ps."likeRatio" > 0.85  -- 高点赞率
      ORDER BY ps.wilson95 DESC, ps."likeRatio" DESC
      LIMIT 10
    `;

    for (let i = 0; i < longTailChampions.length; i++) {
      const champion = longTailChampions[i];
      await this.upsertInterestingFact({
        category: 'hidden_gem',
        type: 'longtail_champion',
        title: `长尾点赞王 #${i + 1}`,
        description: `"${champion.title}"仅有${champion.totalVotes}票但Wilson分数高达${champion.wilson95.toFixed(3)}，点赞率${(champion.likeRatio * 100).toFixed(1)}%`,
        value: champion.wilson95.toFixed(3),
        pageId: champion.pageId,
        rank: i + 1,
        metadata: {
          rating: champion.rating,
          totalVotes: champion.totalVotes,
          likeRatio: champion.likeRatio,
          url: champion.url
        }
      });
    }

    console.log(`✅ 发现了 ${longTailChampions.length} 个长尾点赞王`);
  }

  /**
   * 6. 编辑英雄榜 - 某一时期 Revision 数最多/评论最多的用户与页面
   */
  private async generateEditingChampions() {
    console.log('✏️ 寻找编辑英雄...');

    // 最近30天编辑最多的用户
    const editingChampions = await this.prisma.$queryRaw<Array<{
      userId: number;
      displayName: string;
      revisionCount: bigint;
      pageCount: bigint;
      avgRevisionsPerPage: number;
    }>>`
      SELECT 
        u.id as user_id,
        u."displayName",
        COUNT(r.id) as revision_count,
        COUNT(DISTINCT pv."pageId") as page_count,
        COUNT(r.id)::float / COUNT(DISTINCT pv."pageId") as avg_revisions_per_page
      FROM "User" u
      JOIN "Revision" r ON r."userId" = u.id
      JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
      WHERE r."timestamp" >= CURRENT_DATE - INTERVAL '30 days'
        AND u."displayName" IS NOT NULL
      GROUP BY u.id, u."displayName"
      ORDER BY revision_count DESC
      LIMIT 10
    `;

    for (let i = 0; i < editingChampions.length; i++) {
      const champion = editingChampions[i];
      await this.upsertInterestingFact({
        category: 'editing_hero',
        type: 'most_revisions_30d',
        title: `30天编辑英雄 #${i + 1}`,
        description: `${champion.displayName}在30天内进行了${Number(champion.revisionCount)}次编辑，涉及${Number(champion.pageCount)}个页面，平均每页面${champion.avgRevisionsPerPage.toFixed(1)}次编辑`,
        value: Number(champion.revisionCount).toString(),
        userId: champion.userId,
        rank: i + 1,
        dateContext: new Date(),
        metadata: {
          pageCount: Number(champion.pageCount),
          avgRevisionsPerPage: champion.avgRevisionsPerPage
        }
      });
    }

    console.log(`✅ 发现了 ${editingChampions.length} 个编辑英雄`);
  }

  /**
   * 7. 里程碑统计 - 第整万个用户、整N万投票等
   */
  private async generateMilestoneStats() {
    console.log('🏆 生成里程碑统计...');

    // 用户里程碑
    const userMilestones = [10000, 20000, 30000, 50000];
    for (const milestone of userMilestones) {
      const user = await this.prisma.$queryRaw<Array<{
        id: number;
        displayName: string;
        firstActivityAt: Date;
      }>>`
        SELECT id, "displayName", "firstActivityAt"
        FROM "User" 
        WHERE "firstActivityAt" IS NOT NULL
        ORDER BY "firstActivityAt" ASC
        LIMIT 1 OFFSET ${milestone - 1}
      `;

      if (user.length > 0) {
        await this.upsertInterestingFact({
          category: 'milestone',
          type: 'milestone_user',
          title: `第${milestone}个用户`,
          description: `${user[0].displayName}是本站的第${milestone}个用户，于${user[0].firstActivityAt.toLocaleDateString()}加入`,
          value: milestone.toString(),
          userId: user[0].id,
          dateContext: user[0].firstActivityAt,
          metadata: {
            milestone: milestone,
            joinDate: user[0].firstActivityAt
          }
        });
      }
    }

    // 投票里程碑
    const voteMilestones = [50000, 100000, 250000, 500000];
    for (const milestone of voteMilestones) {
      const vote = await this.prisma.$queryRaw<Array<{
        id: number;
        timestamp: Date;
        userId: number;
        displayName: string;
        pageTitle: string;
      }>>`
        SELECT 
          v.id,
          v."timestamp",
          v."userId",
          u."displayName",
          pv.title as page_title
        FROM "Vote" v
        LEFT JOIN "User" u ON v."userId" = u.id
        JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        ORDER BY v."timestamp" ASC
        LIMIT 1 OFFSET ${milestone - 1}
      `;

      if (vote.length > 0) {
        await this.upsertInterestingFact({
          category: 'milestone',
          type: 'milestone_vote',
          title: `第${milestone}个投票`,
          description: `第${milestone}个投票由${vote[0].displayName || '匿名用户'}于${vote[0].timestamp.toLocaleDateString()}投给"${vote[0].pageTitle}"`,
          value: milestone.toString(),
          userId: vote[0].userId,
          dateContext: vote[0].timestamp,
          metadata: {
            milestone: milestone,
            voteId: vote[0].id,
            pageTitle: vote[0].pageTitle
          }
        });
      }
    }

    console.log('✅ 生成里程碑统计完成');
  }

  /**
   * 8. 标签组合分析 - 最常出现的标签组合
   */
  private async generateTagCombinationAnalysis() {
    console.log('🏷️ 分析标签组合...');

    // 两标签组合
    const tagCombinations = await this.prisma.$queryRaw<Array<{
      tag1: string;
      tag2: string;
      pageCount: bigint;
      avgRating: number;
      maxRating: number;
    }>>`
      WITH tag_pairs AS (
        SELECT 
          t1.tag as tag1,
          t2.tag as tag2,
          pv."pageId",
          pv.rating
        FROM (
          SELECT "pageId", unnest(tags) as tag
          FROM "PageVersion" 
          WHERE "validTo" IS NULL AND "isDeleted" = false
            AND array_length(tags, 1) >= 2
        ) t1
        JOIN (
          SELECT "pageId", unnest(tags) as tag
          FROM "PageVersion" 
          WHERE "validTo" IS NULL AND "isDeleted" = false
            AND array_length(tags, 1) >= 2
        ) t2 ON t1."pageId" = t2."pageId"
        JOIN "PageVersion" pv ON pv."pageId" = t1."pageId" AND pv."validTo" IS NULL
        WHERE t1.tag < t2.tag  -- 避免重复组合
      )
      SELECT 
        tag1,
        tag2,
        COUNT(*) as page_count,
        AVG(rating::float) as avg_rating,
        MAX(rating) as max_rating
      FROM tag_pairs
      WHERE rating IS NOT NULL
      GROUP BY tag1, tag2
      HAVING COUNT(*) >= 5  -- 至少5个页面
      ORDER BY page_count DESC
      LIMIT 15
    `;

    for (let i = 0; i < tagCombinations.length; i++) {
      const combo = tagCombinations[i];
      await this.upsertInterestingFact({
        category: 'tag_combination',
        type: 'popular_tag_combo',
        title: `热门标签组合 #${i + 1}`,
        description: `"${combo.tag1} + ${combo.tag2}"组合出现在${Number(combo.pageCount)}个页面中，平均评分${combo.avgRating.toFixed(1)}分，最高${combo.maxRating}分`,
        value: Number(combo.pageCount).toString(),
        tagContext: `${combo.tag1},${combo.tag2}`,
        rank: i + 1,
        metadata: {
          tag1: combo.tag1,
          tag2: combo.tag2,
          avgRating: combo.avgRating,
          maxRating: combo.maxRating
        }
      });
    }

    console.log(`✅ 生成了 ${tagCombinations.length} 个标签组合统计`);
  }

  /**
   * 通用的InterestingFacts插入/更新函数
   */
  private async upsertInterestingFact(fact: {
    category: string;
    type: string;
    title: string;
    description?: string;
    value?: string;
    pageId?: number;
    userId?: number;
    dateContext?: Date;
    tagContext?: string;
    rank?: number;
    metadata?: any;
  }) {
    await this.prisma.interestingFacts.upsert({
      where: {
        category_type_dateContext_tagContext_rank: {
          category: fact.category,
          type: fact.type,
          dateContext: fact.dateContext || null,
          tagContext: fact.tagContext || null,
          rank: fact.rank || 1
        }
      },
      create: {
        category: fact.category,
        type: fact.type,
        title: fact.title,
        description: fact.description,
        value: fact.value,
        pageId: fact.pageId,
        userId: fact.userId,
        dateContext: fact.dateContext,
        tagContext: fact.tagContext,
        rank: fact.rank || 1,
        metadata: fact.metadata || {},
        calculatedAt: new Date(),
        isActive: true
      },
      update: {
        title: fact.title,
        description: fact.description,
        value: fact.value,
        pageId: fact.pageId,
        userId: fact.userId,
        metadata: fact.metadata || {},
        calculatedAt: new Date(),
        isActive: true
      }
    });
  }

  /**
   * 获取扩展统计的摘要
   */
  async getExtendedStatsSummary() {
    const summary = await this.prisma.$queryRaw<Array<{
      category: string;
      type: string;
      count: bigint;
    }>>`
      SELECT category, type, COUNT(*) as count
      FROM "InterestingFacts"
      WHERE category IN (
        'author_growth', 'tag_controversy', 'time_pattern', 
        'numbering_pattern', 'hidden_gem', 'editing_hero', 
        'milestone', 'tag_combination'
      )
      AND "isActive" = true
      GROUP BY category, type
      ORDER BY category, type
    `;

    return summary.map(s => ({
      category: s.category,
      type: s.type,
      count: Number(s.count)
    }));
  }
}

/**
 * 便捷的调用函数
 */
export async function generateExtendedInterestingStats(prisma: PrismaClient) {
  const statsJob = new ExtendedInterestingStatsJob(prisma);
  await statsJob.generateAllStats();
  
  const summary = await statsJob.getExtendedStatsSummary();
  console.log('📊 扩展有趣统计摘要:');
  for (const item of summary) {
    console.log(`  ${item.category}/${item.type}: ${item.count} 项`);
  }
  
  return summary;
}