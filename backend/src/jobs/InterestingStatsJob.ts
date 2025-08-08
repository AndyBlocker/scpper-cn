import { PrismaClient } from '@prisma/client';

/**
 * 创建有效的日期对象，避免Invalid Date错误
 */
function createValidDate(periodValue: string, period: string): Date | null {
  try {
    if (period === 'year') {
      return new Date(`${periodValue}-01-01`);
    } else if (period === 'month') {
      return new Date(`${periodValue}-01`);
    } else {
      // 尝试直接解析
      const date = new Date(periodValue);
      return isNaN(date.getTime()) ? null : date;
    }
  } catch {
    return null;
  }
}

/**
 * 计算有趣统计信息的主要任务（优化版）
 */
export async function calculateInterestingStats(prisma: PrismaClient, isIncremental = false) {
  console.log('🎯 开始计算有趣统计信息...');
  
  try {
    // 优化增量更新逻辑
    const lastUpdate = isIncremental ? await getLastUpdateTime(prisma) : null;
    const cutoffDate = isIncremental && lastUpdate 
      ? new Date(lastUpdate.getTime() - 24 * 60 * 60 * 1000) // 往前推一天确保不遗漏
      : null;
    
    if (isIncremental) {
      console.log(cutoffDate 
        ? `📈 增量更新模式，处理 ${cutoffDate.toISOString().split('T')[0]} 之后的数据` 
        : '📈 增量更新模式，但未找到上次更新时间，将执行全量处理');
    } else {
      console.log('📊 全量更新模式，处理所有历史数据');
    }
    
    // 并行处理能够并行的任务以提升性能
    await Promise.all([
      // 1. 时间里程碑统计
      calculateTimeMilestones(prisma, isIncremental, cutoffDate),
      
      // 2. 标签记录统计 
      calculateTagRecords(prisma, isIncremental, cutoffDate),
      
      // 3. 内容分析记录
      calculateContentRecords(prisma, isIncremental, cutoffDate),
      
      // 4. 评分投票记录  
      calculateRatingRecords(prisma, isIncremental, cutoffDate),
      
      // 5. 用户活动记录
      calculateUserActivityRecords(prisma, isIncremental, cutoffDate)
    ]);
    
    // 6. 实时热点统计（总是需要重新计算）
    await calculateTrendingStats(prisma);
    
    // 需要全量数据的统计项目（在增量模式下跳过，避免影响性能）
    if (!isIncremental) {
      await Promise.all([
        // 7. 计算作者成就统计
        calculateAuthorAchievements(prisma, isIncremental, cutoffDate),
        
        // 8. 计算站点里程碑
        calculateSiteMilestones(prisma, isIncremental, cutoffDate)
      ]);
    } else {
      console.log('📝 增量更新：跳过作者成就统计（需要全量数据计算排名）');
      console.log('📝 增量更新：跳过站点里程碑统计（需要全量数据计算里程碑）');
    }
    
    // 9. 生成通用有趣事实
    await generateInterestingFacts(prisma, isIncremental, cutoffDate);
    
    // 记录更新时间
    await updateLastUpdateTime(prisma);
    
    console.log('✅ 有趣统计信息计算完成');
  } catch (error) {
    console.error('❌ 有趣统计信息计算失败:', error);
    throw error;
  }
}

/**
 * 获取最后更新时间
 */
async function getLastUpdateTime(prisma: PrismaClient): Promise<Date | null> {
  try {
    const lastFact = await prisma.interestingFacts.findFirst({
      orderBy: { calculatedAt: 'desc' },
      select: { calculatedAt: true }
    });
    return lastFact?.calculatedAt || null;
  } catch {
    return null;
  }
}

/**
 * 记录更新时间
 */
async function updateLastUpdateTime(prisma: PrismaClient): Promise<void> {
  try {
    // 这里可以创建一个专门的记录来跟踪更新时间，但现在我们依赖InterestingFacts的calculatedAt
    console.log('📝 更新时间已记录');
  } catch (error) {
    console.error('⚠️ 记录更新时间失败:', error);
  }
}

/**
 * 计算时间里程碑统计
 */
export async function calculateTimeMilestones(prisma: PrismaClient, isIncremental = false, cutoffDate: Date | null = null) {
  console.log('📅 计算时间里程碑统计...');
  
  try {
    if (!isIncremental) {
      // 全量更新时清空旧数据
      await prisma.timeMilestones.deleteMany();
    }
    
    // 计算每年的第一个和最后一个页面
    // 增量更新：确定需要计算的年份和月份范围
    let affectedYearsSet: Set<string> = new Set();
    let affectedMonthsSet: Set<string> = new Set();
    let affectedPages: Array<{page_id: number, created_year: string, created_month: string}> = [];
    
    if (isIncremental && cutoffDate) {
      // 重新获取受影响的页面（在函数内部定义）
      affectedPages = await prisma.$queryRaw<Array<{
        page_id: number,
        created_year: string,
        created_month: string
      }>>`
        SELECT DISTINCT 
          p.id as page_id,
          EXTRACT(YEAR FROM created_at)::text as created_year,
          TO_CHAR(created_at, 'YYYY-MM') as created_month
        FROM "Page" p
        INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
        INNER JOIN (
          SELECT 
            p.id as page_id,
            COALESCE(
              (SELECT MIN(a.date) FROM "Attribution" a WHERE a."pageVerId" = pv.id AND a.date IS NOT NULL),
              (SELECT MIN(r.timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id),
              pv."validFrom"
            ) as created_at
          FROM "Page" p
          INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
          WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
        ) dates ON p.id = dates.page_id
        WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
        AND (
          p."createdAt" >= ${cutoffDate} OR
          p."updatedAt" >= ${cutoffDate} OR
          pv."validFrom" >= ${cutoffDate} OR
          EXISTS (SELECT 1 FROM "Attribution" a WHERE a."pageVerId" = pv.id AND a.date >= ${cutoffDate}) OR
          EXISTS (SELECT 1 FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.timestamp >= ${cutoffDate})
        )
        AND dates.created_at IS NOT NULL
      `;
      
      for (const page of affectedPages) {
        affectedYearsSet.add(page.created_year);
        affectedMonthsSet.add(page.created_month);
      }
      
      if (affectedPages.length > 0) {
        console.log(`📝 找到 ${affectedPages.length} 个受影响的页面`);
        console.log(`📝 影响的年份: ${[...affectedYearsSet].join(', ')}`);
        console.log(`📝 影响的月份: ${[...affectedMonthsSet].join(', ')}`);
        
        // 删除受影响时间段的记录，保留其他时间段的数据
        for (const year of affectedYearsSet) {
          await prisma.timeMilestones.deleteMany({
            where: {
              period: 'year',
              periodValue: year
            }
          });
        }
        
        for (const month of affectedMonthsSet) {
          await prisma.timeMilestones.deleteMany({
            where: {
              period: 'month', 
              periodValue: month
            }
          });
        }
        
        console.log(`📝 增量更新：清理了 ${affectedYearsSet.size} 个年份和 ${affectedMonthsSet.size} 个月份的里程碑记录`);
      } else {
        console.log('📝 增量更新：未发现受影响的页面，跳过处理');
        return;
      }
    }
    
    // 计算年度里程碑 - 支持增量更新年份过滤
    let yearlyMilestones: Array<{
      year: string,
      first_page_id: number,
      first_page_title: string,
      first_page_rating: number,
      first_page_created: Date,
      last_page_id: number,
      last_page_title: string,  
      last_page_rating: number,
      last_page_created: Date
    }> = [];
    
    if (isIncremental && cutoffDate && affectedYearsSet.size > 0) {
      // 增量模式：只计算受影响的年份
      for (const year of affectedYearsSet) {
        const yearInt = parseInt(year);
        const yearMilestones = await prisma.$queryRaw<Array<{
          year: string,
          first_page_id: number,
          first_page_title: string,
          first_page_rating: number,
          first_page_created: Date,
          last_page_id: number,
          last_page_title: string,  
          last_page_rating: number,
          last_page_created: Date
        }>>`
          WITH page_attributions AS (
            SELECT 
              "pageVerId",
              MIN(date) as min_attribution_date
            FROM "Attribution" 
            WHERE date IS NOT NULL
            GROUP BY "pageVerId"
          ),
          page_revisions AS (
            SELECT 
              "pageVersionId",
              MIN(timestamp) as min_revision_timestamp
            FROM "Revision"
            GROUP BY "pageVersionId"
          ),
          page_dates AS (
            SELECT 
              p.id as page_id,
              pv.title,
              COALESCE(pv.rating, 0) as rating,
              COALESCE(
                pa.min_attribution_date,
                pr.min_revision_timestamp,
                pv."validFrom"
              ) as created_at
            FROM "Page" p
            INNER JOIN "PageVersion" pv ON p.id = pv."pageId" 
            LEFT JOIN page_attributions pa ON pa."pageVerId" = pv.id
            LEFT JOIN page_revisions pr ON pr."pageVersionId" = pv.id
            WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
          ),
          yearly_pages AS (
            SELECT 
              EXTRACT(YEAR FROM created_at)::text as year,
              page_id,
              title,
              rating,
              created_at,
              ROW_NUMBER() OVER (PARTITION BY EXTRACT(YEAR FROM created_at) ORDER BY created_at ASC) as first_rank,
              ROW_NUMBER() OVER (PARTITION BY EXTRACT(YEAR FROM created_at) ORDER BY created_at DESC) as last_rank
            FROM page_dates
            WHERE created_at IS NOT NULL AND EXTRACT(YEAR FROM created_at) = ${yearInt}
          ),
          first_pages AS (
            SELECT year, page_id as first_page_id, title as first_page_title, 
                   rating as first_page_rating, created_at as first_page_created
            FROM yearly_pages WHERE first_rank = 1
          ),
          last_pages AS (
            SELECT year, page_id as last_page_id, title as last_page_title,
                   rating as last_page_rating, created_at as last_page_created  
            FROM yearly_pages WHERE last_rank = 1
          )
          SELECT f.*, l.last_page_id, l.last_page_title, l.last_page_rating, l.last_page_created
          FROM first_pages f
          INNER JOIN last_pages l ON f.year = l.year
        `;
        yearlyMilestones.push(...yearMilestones);
      }
    } else {
      // 全量模式：计算所有年份
      yearlyMilestones = await prisma.$queryRaw`
        WITH page_attributions AS (
          SELECT 
            "pageVerId",
            MIN(date) as min_attribution_date
          FROM "Attribution" 
          WHERE date IS NOT NULL
          GROUP BY "pageVerId"
        ),
        page_revisions AS (
          SELECT 
            "pageVersionId",
            MIN(timestamp) as min_revision_timestamp
          FROM "Revision"
          GROUP BY "pageVersionId"
        ),
        page_dates AS (
          SELECT 
            p.id as page_id,
            pv.title,
            COALESCE(pv.rating, 0) as rating,
            COALESCE(
              pa.min_attribution_date,
              pr.min_revision_timestamp,
              pv."validFrom"
            ) as created_at
          FROM "Page" p
          INNER JOIN "PageVersion" pv ON p.id = pv."pageId" 
          LEFT JOIN page_attributions pa ON pa."pageVerId" = pv.id
          LEFT JOIN page_revisions pr ON pr."pageVersionId" = pv.id
          WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
        ),
        yearly_pages AS (
          SELECT 
            EXTRACT(YEAR FROM created_at)::text as year,
            page_id,
            title,
            rating,
            created_at,
            ROW_NUMBER() OVER (PARTITION BY EXTRACT(YEAR FROM created_at) ORDER BY created_at ASC) as first_rank,
            ROW_NUMBER() OVER (PARTITION BY EXTRACT(YEAR FROM created_at) ORDER BY created_at DESC) as last_rank
          FROM page_dates
          WHERE created_at IS NOT NULL
        ),
        first_pages AS (
          SELECT year, page_id as first_page_id, title as first_page_title, 
                 rating as first_page_rating, created_at as first_page_created
          FROM yearly_pages WHERE first_rank = 1
        ),
        last_pages AS (
          SELECT year, page_id as last_page_id, title as last_page_title,
                 rating as last_page_rating, created_at as last_page_created  
          FROM yearly_pages WHERE last_rank = 1
        )
        SELECT f.*, l.last_page_id, l.last_page_title, l.last_page_rating, l.last_page_created
        FROM first_pages f
        INNER JOIN last_pages l ON f.year = l.year
        ORDER BY f.year
      `;
    }
    
    for (const milestone of yearlyMilestones) {
      // 使用upsert插入第一个页面记录
      await prisma.timeMilestones.upsert({
        where: {
          period_periodValue_milestoneType: {
            period: 'year',
            periodValue: milestone.year,
            milestoneType: 'first_page'
          }
        },
        update: {
          pageId: milestone.first_page_id,
          pageTitle: milestone.first_page_title,
          pageRating: milestone.first_page_rating,
          pageCreatedAt: milestone.first_page_created
        },
        create: {
          period: 'year',
          periodValue: milestone.year,
          milestoneType: 'first_page',
          pageId: milestone.first_page_id,
          pageTitle: milestone.first_page_title,
          pageRating: milestone.first_page_rating,
          pageCreatedAt: milestone.first_page_created
        }
      });
      
      // 插入最后一个页面记录（如果不是同一个页面）
      if (milestone.first_page_id !== milestone.last_page_id) {
        await prisma.timeMilestones.upsert({
          where: {
            period_periodValue_milestoneType: {
              period: 'year',
              periodValue: milestone.year,
              milestoneType: 'last_page'
            }
          },
          update: {
            pageId: milestone.last_page_id,
            pageTitle: milestone.last_page_title,
            pageRating: milestone.last_page_rating,
            pageCreatedAt: milestone.last_page_created
          },
          create: {
            period: 'year',
            periodValue: milestone.year,
            milestoneType: 'last_page',
            pageId: milestone.last_page_id,
            pageTitle: milestone.last_page_title,
            pageRating: milestone.last_page_rating,
            pageCreatedAt: milestone.last_page_created
          }
        });
      }
    }
    
    // 计算每年的第一个高分页面（评分>50）
    const highRatedMilestones = await prisma.$queryRaw<Array<{
      year: string,
      page_id: number,
      title: string,
      rating: number,
      created_at: Date
    }>>`
      WITH page_dates AS (
        SELECT 
          p.id as page_id,
          pv.title,
          pv.rating,
          COALESCE(
            (SELECT MIN(a.date) FROM "Attribution" a WHERE a."pageVerId" = pv.id AND a.date IS NOT NULL),
            (SELECT MIN(r.timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id),
            pv."validFrom"
          ) as created_at
        FROM "Page" p
        INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
        WHERE pv."validTo" IS NULL 
          AND pv."isDeleted" = false
          AND pv.rating > 50
      )
      SELECT DISTINCT ON (EXTRACT(YEAR FROM created_at))
        EXTRACT(YEAR FROM created_at)::text as year,
        page_id,
        title,
        rating,
        created_at
      FROM page_dates
      WHERE created_at IS NOT NULL
      ORDER BY EXTRACT(YEAR FROM created_at), created_at ASC
    `;
    
    for (const milestone of highRatedMilestones) {
      await prisma.timeMilestones.upsert({
        where: {
          period_periodValue_milestoneType: {
            period: 'year',
            periodValue: milestone.year,
            milestoneType: 'first_high_rated'
          }
        },
        update: {
          pageId: milestone.page_id,
          pageTitle: milestone.title,
          pageRating: milestone.rating,
          pageCreatedAt: milestone.created_at
        },
        create: {
          period: 'year',
          periodValue: milestone.year,
          milestoneType: 'first_high_rated',
          pageId: milestone.page_id,
          pageTitle: milestone.title,
          pageRating: milestone.rating,
          pageCreatedAt: milestone.created_at
        }
      });
    }
    
    // 计算月度里程碑 - 支持增量更新
    let monthlyMilestones: Array<{
      month: string,
      page_id: number,
      title: string,
      rating: number,
      created_at: Date
    }> = [];
    
    if (isIncremental && cutoffDate && affectedPages && affectedPages.length > 0) {
      // 增量模式：只计算受影响的月份
      const affectedMonthsSet = new Set(affectedPages.map(p => p.created_month));
      for (const month of affectedMonthsSet) {
        const monthMilestones = await prisma.$queryRaw<Array<{
          month: string,
          page_id: number,
          title: string,
          rating: number,
          created_at: Date
        }>>`
          WITH page_dates AS (
            SELECT 
              p.id as page_id,
              pv.title,
              COALESCE(pv.rating, 0) as rating,
              COALESCE(
                (SELECT MIN(a.date) FROM "Attribution" a WHERE a."pageVerId" = pv.id AND a.date IS NOT NULL),
                (SELECT MIN(r.timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id),
                pv."validFrom"
              ) as created_at
            FROM "Page" p
            INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
            WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
          )
          SELECT DISTINCT ON (TO_CHAR(created_at, 'YYYY-MM'))
            TO_CHAR(created_at, 'YYYY-MM') as month,
            page_id,
            title,
            rating,
            created_at
          FROM page_dates
          WHERE created_at IS NOT NULL AND TO_CHAR(created_at, 'YYYY-MM') = ${month}
          ORDER BY TO_CHAR(created_at, 'YYYY-MM'), created_at ASC
        `;
        monthlyMilestones.push(...monthMilestones);
      }
      console.log(`📝 只重新计算受影响的月份: ${[...affectedMonthsSet].join(', ')}`);
    } else {
      // 全量模式：计算所有月份
      monthlyMilestones = await prisma.$queryRaw`
        WITH page_dates AS (
          SELECT 
            p.id as page_id,
            pv.title,
            COALESCE(pv.rating, 0) as rating,
            COALESCE(
              (SELECT MIN(a.date) FROM "Attribution" a WHERE a."pageVerId" = pv.id AND a.date IS NOT NULL),
              (SELECT MIN(r.timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id),
              pv."validFrom"
            ) as created_at
          FROM "Page" p
          INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
          WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
        )
        SELECT DISTINCT ON (TO_CHAR(created_at, 'YYYY-MM'))
          TO_CHAR(created_at, 'YYYY-MM') as month,
          page_id,
          title,
          rating,
          created_at
        FROM page_dates
        WHERE created_at IS NOT NULL
        ORDER BY TO_CHAR(created_at, 'YYYY-MM'), created_at ASC
      `;
    }
    
    for (const milestone of monthlyMilestones) {
      await prisma.timeMilestones.upsert({
        where: {
          period_periodValue_milestoneType: {
            period: 'month',
            periodValue: milestone.month,
            milestoneType: 'first_page'
          }
        },
        update: {
          pageId: milestone.page_id,
          pageTitle: milestone.title,
          pageRating: milestone.rating,
          pageCreatedAt: milestone.created_at
        },
        create: {
          period: 'month',
          periodValue: milestone.month,
          milestoneType: 'first_page',
          pageId: milestone.page_id,
          pageTitle: milestone.title,
          pageRating: milestone.rating,
          pageCreatedAt: milestone.created_at
        }
      });
    }
    
    console.log(`✅ 时间里程碑统计完成 - 年度: ${yearlyMilestones.length}, 月度: ${monthlyMilestones.length}, 高分: ${highRatedMilestones.length}`);
    
  } catch (error) {
    console.error('❌ 时间里程碑统计失败:', error);
    throw error;
  }
}

/**
 * 计算标签记录统计
 */
export async function calculateTagRecords(prisma: PrismaClient, isIncremental = false, cutoffDate: Date | null = null) {
  console.log('🏷️ 计算标签记录统计...');
  
  try {
    if (!isIncremental) {
      // 全量更新时清空旧数据
      await prisma.tagRecords.deleteMany();
    } else if (cutoffDate) {
      // 增量更新时，删除可能受影响的标签记录
      // 获取自上次更新以来发生变化的页面的标签
      const affectedTags = await prisma.$queryRaw<Array<{tag: string}>>`
        SELECT DISTINCT unnest(pv.tags) as tag
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
        AND array_length(pv.tags, 1) > 0
        AND (
          pv."validFrom" >= ${cutoffDate} OR
          pv."updatedAt" >= ${cutoffDate} OR
          EXISTS (SELECT 1 FROM "Attribution" a WHERE a."pageVerId" = pv.id AND a.date >= ${cutoffDate}) OR
          EXISTS (SELECT 1 FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.timestamp >= ${cutoffDate})
        )
      `;
      
      // 删除受影响标签的相关记录，这样它们会被重新计算
      for (const tagData of affectedTags) {
        if (tagData.tag) {
          await prisma.tagRecords.deleteMany({
            where: { tag: tagData.tag }
          });
        }
      }
      
      console.log(`📝 增量更新：清理了 ${affectedTags.length} 个受影响标签的记录`);
    }
    
    // 计算每个标签的最高评分页面
    // 优化：使用DISTINCT ON代替ROW_NUMBER窗口函数
    const tagHighestRated = await prisma.$queryRaw<Array<{
      tag: string,
      page_id: number,
      rating: number,
      title: string
    }>>`
      SELECT DISTINCT ON (unnest(pv.tags))
        unnest(pv.tags) as tag,
        p.id as page_id,
        pv.title,
        pv.rating
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND array_length(pv.tags, 1) > 0
        AND pv.rating IS NOT NULL
      ORDER BY unnest(pv.tags), pv.rating DESC NULLS LAST, p.id
    `;
    
    for (const record of tagHighestRated) {
      await prisma.tagRecords.upsert({
        where: {
          tag_recordType: {
            tag: record.tag,
            recordType: 'highest_rated'
          }
        },
        update: {
          pageId: record.page_id,
          value: record.rating,
          metadata: {
            title: record.title
          }
        },
        create: {
          tag: record.tag,
          recordType: 'highest_rated',
          pageId: record.page_id,
          value: record.rating,
          metadata: {
            title: record.title
          }
        }
      });
    }
    
    // 计算每个标签的第一个页面（最早创建）
    const tagFirstPages = await prisma.$queryRaw<Array<{
      tag: string,
      page_id: number,
      title: string,
      created_at: Date
    }>>`
      WITH page_dates AS (
        SELECT 
          p.id as page_id,
          pv.title,
          pv.tags,
          COALESCE(
            (SELECT MIN(a.date) FROM "Attribution" a WHERE a."pageVerId" = pv.id AND a.date IS NOT NULL),
            (SELECT MIN(r.timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id),
            pv."validFrom"
          ) as created_at
        FROM "Page" p
        INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
        WHERE pv."validTo" IS NULL 
          AND pv."isDeleted" = false
          AND array_length(pv.tags, 1) > 0
      ),
      tag_pages AS (
        SELECT 
          unnest(tags) as tag,
          page_id,
          title,
          created_at,
          ROW_NUMBER() OVER (PARTITION BY unnest(tags) ORDER BY created_at ASC, page_id) as rank
        FROM page_dates
        WHERE created_at IS NOT NULL
      )
      SELECT tag, page_id, title, created_at
      FROM tag_pages
      WHERE rank = 1
      ORDER BY created_at ASC
    `;
    
    for (const record of tagFirstPages) {
      await prisma.tagRecords.upsert({
        where: {
          tag_recordType: {
            tag: record.tag,
            recordType: 'first_page'
          }
        },
        update: {
          pageId: record.page_id,
          metadata: {
            title: record.title,
            createdAt: record.created_at
          }
        },
        create: {
          tag: record.tag,
          recordType: 'first_page',
          pageId: record.page_id,
          metadata: {
            title: record.title,
            createdAt: record.created_at
          }
        }
      });
    }
    
    // 计算标签流行度（页面数量）
    const tagPopularity = await prisma.$queryRaw<Array<{
      tag: string,
      page_count: number
    }>>`
      SELECT 
        unnest(pv.tags) as tag,
        COUNT(DISTINCT p.id)::int as page_count
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND array_length(pv.tags, 1) > 0
      GROUP BY unnest(pv.tags)
      ORDER BY page_count DESC
    `;
    
    for (const record of tagPopularity) {
      await prisma.tagRecords.upsert({
        where: {
          tag_recordType: {
            tag: record.tag,
            recordType: 'most_popular'
          }
        },
        update: {
          value: Number(record.page_count),
          metadata: {
            pageCount: record.page_count
          }
        },
        create: {
          tag: record.tag,
          recordType: 'most_popular',
          value: Number(record.page_count),
          metadata: {
            pageCount: record.page_count
          }
        }
      });
    }
    
    // 计算标签详细统计（用于生成有趣事实）
    console.log('📊 计算标签详细统计信息...');
    await calculateTagDetailedStats(prisma, isIncremental, cutoffDate);
    
    console.log(`✅ 标签记录统计完成 - 最高分: ${tagHighestRated.length}, 首个: ${tagFirstPages.length}, 流行度: ${tagPopularity.length}`);
    
  } catch (error) {
    console.error('❌ 标签记录统计失败:', error);
    throw error;
  }
}

/**
 * 计算标签的详细统计信息，生成有趣事实
 */
export async function calculateTagDetailedStats(prisma: PrismaClient, isIncremental = false, cutoffDate: Date | null = null) {
  try {
    // 获取热门标签（页面数量 > 10）的详细统计
    const popularTags = await prisma.$queryRaw<Array<{
      tag: string,
      page_count: number,
      avg_rating: number,
      highest_rating: number,
      first_page_id: number,
      first_page_title: string,
      first_page_created: Date,
      highest_rated_page_id: number,
      highest_rated_page_title: string,
      top_author_id: number,
      top_author_name: string,
      top_author_total_rating: number,
      top_author_page_count: number
    }>>`
      WITH tag_stats AS (
        SELECT 
          unnest(pv.tags) as tag,
          COUNT(DISTINCT p.id) as page_count,
          AVG(COALESCE(pv.rating, 0))::numeric as avg_rating,
          MAX(COALESCE(pv.rating, 0)) as highest_rating
        FROM "Page" p
        INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
        WHERE pv."validTo" IS NULL 
          AND pv."isDeleted" = false
          AND array_length(pv.tags, 1) > 0
        GROUP BY unnest(pv.tags)
        HAVING COUNT(DISTINCT p.id) > 10
      ),
      tag_first_pages AS (
        SELECT DISTINCT ON (tag)
          tag,
          page_id as first_page_id,
          title as first_page_title,
          created_at as first_page_created
        FROM (
          SELECT 
            unnest(pv.tags) as tag,
            p.id as page_id,
            pv.title,
            COALESCE(
              (SELECT MIN(a.date) FROM "Attribution" a WHERE a."pageVerId" = pv.id AND a.date IS NOT NULL),
              (SELECT MIN(r.timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id),
              pv."validFrom"
            ) as created_at
          FROM "Page" p
          INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
          WHERE pv."validTo" IS NULL 
            AND pv."isDeleted" = false
            AND array_length(pv.tags, 1) > 0
        ) tagged_pages
        ORDER BY tag, created_at ASC
      ),
      tag_highest_rated AS (
        SELECT DISTINCT ON (tag)
          tag,
          page_id as highest_rated_page_id,
          title as highest_rated_page_title
        FROM (
          SELECT 
            unnest(pv.tags) as tag,
            p.id as page_id,
            pv.title,
            pv.rating
          FROM "Page" p
          INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
          WHERE pv."validTo" IS NULL 
            AND pv."isDeleted" = false
            AND array_length(pv.tags, 1) > 0
            AND pv.rating IS NOT NULL
        ) rated_pages
        ORDER BY tag, rating DESC
      ),
      tag_top_authors AS (
        SELECT DISTINCT ON (tag)
          tag,
          user_id as top_author_id,
          display_name as top_author_name,
          total_rating as top_author_total_rating,
          page_count as top_author_page_count
        FROM (
          SELECT 
            unnest(pv.tags) as tag,
            u.id as user_id,
            u."displayName" as display_name,
            SUM(COALESCE(pv.rating, 0)) as total_rating,
            COUNT(DISTINCT p.id) as page_count
          FROM "Page" p
          INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
          INNER JOIN "Attribution" a ON a."pageVerId" = pv.id
          INNER JOIN "User" u ON u.id = a."userId"
          WHERE pv."validTo" IS NULL 
            AND pv."isDeleted" = false
            AND array_length(pv.tags, 1) > 0
            AND a."userId" IS NOT NULL
            AND a.type = 'author'
          GROUP BY unnest(pv.tags), u.id, u."displayName"
          HAVING COUNT(DISTINCT p.id) > 1  -- 至少2个作品
        ) author_stats
        ORDER BY tag, total_rating DESC
      )
      SELECT 
        ts.tag,
        ts.page_count,
        ts.avg_rating,
        ts.highest_rating,
        tfp.first_page_id,
        tfp.first_page_title,
        tfp.first_page_created,
        thr.highest_rated_page_id,
        thr.highest_rated_page_title,
        tta.top_author_id,
        tta.top_author_name,
        tta.top_author_total_rating,
        tta.top_author_page_count
      FROM tag_stats ts
      LEFT JOIN tag_first_pages tfp ON ts.tag = tfp.tag
      LEFT JOIN tag_highest_rated thr ON ts.tag = thr.tag
      LEFT JOIN tag_top_authors tta ON ts.tag = tta.tag
      ORDER BY ts.page_count DESC
      LIMIT 50
    `;

    console.log(`生成 ${popularTags.length} 个热门标签的详细统计`);

    // 为每个标签生成多个有趣事实
    for (const tagData of popularTags) {
      const facts = [];

      // 事实1: 标签概览
      if (tagData.first_page_title && tagData.first_page_created) {
        const createdDate = new Date(tagData.first_page_created);
        const yearsSince = new Date().getFullYear() - createdDate.getFullYear();
        
        facts.push({
          category: 'tag_record',
          type: 'tag_overview',
          title: `"${tagData.tag}"标签发展历程`,
          description: `"${tagData.tag}"标签的第一个页面是"${tagData.first_page_title}"，创建于${createdDate.getFullYear()}年${createdDate.getMonth() + 1}月。经过${yearsSince}年发展，现在"${tagData.tag}"标签下已经有${tagData.page_count}个页面了。`,
          value: tagData.page_count.toString(),
          tagContext: tagData.tag,
          pageId: tagData.first_page_id,
          metadata: {
            firstPageTitle: tagData.first_page_title,
            firstPageDate: tagData.first_page_created,
            currentPageCount: tagData.page_count,
            yearsSinceFirst: yearsSince
          }
        });
      }

      // 事实2: 标签质量统计
      if (tagData.avg_rating !== null && tagData.highest_rating > 0) {
        facts.push({
          category: 'tag_record', 
          type: 'tag_quality',
          title: `"${tagData.tag}"标签质量统计`,
          description: `"${tagData.tag}"标签下页面的平均评分为${Number(tagData.avg_rating).toFixed(1)}分，最高评分为${tagData.highest_rating}分${tagData.highest_rated_page_title ? `（"${tagData.highest_rated_page_title}"）` : ''}。`,
          value: tagData.highest_rating.toString(),
          tagContext: tagData.tag,
          pageId: tagData.highest_rated_page_id,
          metadata: {
            avgRating: Number(tagData.avg_rating),
            highestRating: tagData.highest_rating,
            highestRatedTitle: tagData.highest_rated_page_title
          }
        });
      }

      // 事实3: 标签顶级作者
      if (tagData.top_author_name && tagData.top_author_total_rating > 0) {
        facts.push({
          category: 'tag_record',
          type: 'tag_top_author', 
          title: `"${tagData.tag}"标签顶级作者`,
          description: `在"${tagData.tag}"标签领域，最高分作者是${tagData.top_author_name}，共创作${tagData.top_author_page_count}个作品，总评分达到${tagData.top_author_total_rating}分。`,
          value: tagData.top_author_total_rating.toString(),
          tagContext: tagData.tag,
          userId: tagData.top_author_id,
          metadata: {
            authorName: tagData.top_author_name,
            totalRating: tagData.top_author_total_rating,
            pageCount: tagData.top_author_page_count
          }
        });
      }

      // 批量插入事实
      for (const fact of facts) {
        await prisma.interestingFacts.create({
          data: fact
        });
      }
    }

    console.log(`✅ 标签详细统计完成，共生成 ${popularTags.length * 3} 个标签事实`);

  } catch (error) {
    console.error('❌ 标签详细统计失败:', error);
    throw error;
  }
}

/**
 * 计算内容分析记录
 */
export async function calculateContentRecords(prisma: PrismaClient, isIncremental = false, cutoffDate: Date | null = null) {
  console.log('📝 计算内容分析记录...');
  
  try {
    // 对于内容记录，由于数据量相对较少，总是全量重建
    await prisma.contentRecords.deleteMany();
    
    // 计算源代码最长的页面
    const longestSource = await prisma.$queryRaw<Array<{
      page_id: number,
      title: string,
      source_length: number
    }>>`
      SELECT 
        p.id as page_id,
        pv.title,
        LENGTH(pv.source) as source_length
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND pv.source IS NOT NULL
      ORDER BY source_length DESC
      LIMIT 10
    `;
    
    for (let i = 0; i < longestSource.length; i++) {
      const record = longestSource[i];
      await prisma.contentRecords.create({
        data: {
          recordType: i === 0 ? 'longest_source' : `longest_source_top_${i + 1}`,
          pageId: record.page_id,
          pageTitle: record.title,
          sourceLength: record.source_length,
          complexity: {
            rank: i + 1,
            totalLength: record.source_length
          }
        }
      });
    }
    
    // 计算源代码最短的页面（排除删除页面和空内容）
    const shortestSource = await prisma.$queryRaw<Array<{
      page_id: number,
      title: string,
      source_length: number
    }>>`
      SELECT 
        p.id as page_id,
        pv.title,
        LENGTH(pv.source) as source_length
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND pv.source IS NOT NULL
        AND LENGTH(TRIM(pv.source)) > 50  -- 排除过短内容
      ORDER BY source_length ASC
      LIMIT 10
    `;
    
    for (let i = 0; i < shortestSource.length; i++) {
      const record = shortestSource[i];
      await prisma.contentRecords.create({
        data: {
          recordType: i === 0 ? 'shortest_source' : `shortest_source_top_${i + 1}`,
          pageId: record.page_id,
          pageTitle: record.title,
          sourceLength: record.source_length,
          complexity: {
            rank: i + 1,
            totalLength: record.source_length
          }
        }
      });
    }
    
    // 计算文本内容最长的页面
    const longestContent = await prisma.$queryRaw<Array<{
      page_id: number,
      title: string,
      content_length: number
    }>>`
      SELECT 
        p.id as page_id,
        pv.title,
        LENGTH(pv."textContent") as content_length
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND pv."textContent" IS NOT NULL
      ORDER BY content_length DESC
      LIMIT 5
    `;
    
    for (let i = 0; i < longestContent.length; i++) {
      const record = longestContent[i];
      await prisma.contentRecords.create({
        data: {
          recordType: i === 0 ? 'longest_content' : `longest_content_top_${i + 1}`,
          pageId: record.page_id,
          pageTitle: record.title,
          contentLength: record.content_length,
          complexity: {
            rank: i + 1,
            totalLength: record.content_length
          }
        }
      });
    }
    
    console.log(`✅ 内容分析记录完成 - 最长源码: ${longestSource.length}, 最短源码: ${shortestSource.length}, 最长内容: ${longestContent.length}`);
    
  } catch (error) {
    console.error('❌ 内容分析记录失败:', error);
    throw error;
  }
}

/**
 * 计算评分投票记录
 */
export async function calculateRatingRecords(prisma: PrismaClient, isIncremental = false, cutoffDate: Date | null = null) {
  console.log('⭐ 计算评分投票记录...');
  
  try {
    // 对于评分记录，由于数据量相对较少，总是全量重建
    await prisma.ratingRecords.deleteMany();
    
    // 历史最高评分页面
    const highestRated = await prisma.$queryRaw<Array<{
      page_id: number,
      title: string,
      rating: number,
      vote_count: number
    }>>`
      SELECT 
        p.id as page_id,
        pv.title,
        pv.rating,
        COALESCE(pv."voteCount", 0) as vote_count
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND pv.rating IS NOT NULL
      ORDER BY pv.rating DESC
      LIMIT 10
    `;
    
    for (let i = 0; i < highestRated.length; i++) {
      const record = highestRated[i];
      await prisma.ratingRecords.create({
        data: {
          recordType: 'highest_rated',
          pageId: record.page_id,
          pageTitle: record.title,
          rating: record.rating,
          voteCount: record.vote_count,
          timeframe: 'all_time',
          value: record.rating,
          achievedAt: new Date() // 这里应该用实际的达成时间，但目前数据中没有
        }
      });
    }
    
    // 投票数最多的页面
    const mostVotes = await prisma.$queryRaw<Array<{
      page_id: number,
      title: string,
      rating: number,
      vote_count: number
    }>>`
      SELECT 
        p.id as page_id,
        pv.title,
        COALESCE(pv.rating, 0) as rating,
        COALESCE(pv."voteCount", 0) as vote_count
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND pv."voteCount" IS NOT NULL
        AND pv."voteCount" > 0
      ORDER BY pv."voteCount" DESC
      LIMIT 10
    `;
    
    for (let i = 0; i < mostVotes.length; i++) {
      const record = mostVotes[i];
      await prisma.ratingRecords.create({
        data: {
          recordType: 'most_votes',
          pageId: record.page_id,
          pageTitle: record.title,
          rating: record.rating,
          voteCount: record.vote_count,
          timeframe: 'all_time',
          value: record.vote_count
        }
      });
    }
    
    // 最有争议的页面（基于现有的 PageStats 数据）
    const mostControversial = await prisma.$queryRaw<Array<{
      page_id: number,
      title: string,
      rating: number,
      controversy: number,
      wilson95: number
    }>>`
      SELECT 
        p.id as page_id,
        pv.title,
        COALESCE(pv.rating, 0) as rating,
        ps.controversy,
        ps.wilson95
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      INNER JOIN "PageStats" ps ON pv.id = ps."pageVersionId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND ps.controversy > 0
      ORDER BY ps.controversy DESC
      LIMIT 10
    `;
    
    for (let i = 0; i < mostControversial.length; i++) {
      const record = mostControversial[i];
      await prisma.ratingRecords.create({
        data: {
          recordType: 'most_controversial',
          pageId: record.page_id,
          pageTitle: record.title,
          rating: record.rating,
          controversy: record.controversy,
          wilson95: record.wilson95,
          timeframe: 'all_time',
          value: record.controversy
        }
      });
    }
    
    console.log(`✅ 评分投票记录完成 - 最高分: ${highestRated.length}, 最多票: ${mostVotes.length}, 最争议: ${mostControversial.length}`);
    
  } catch (error) {
    console.error('❌ 评分投票记录失败:', error);
    throw error;
  }
}

/**
 * 计算用户活动记录
 */
export async function calculateUserActivityRecords(prisma: PrismaClient, isIncremental = false, cutoffDate: Date | null = null) {
  console.log('👥 计算用户活动记录...');
  
  try {
    // 对于用户活动记录，由于数据量相对较少，总是全量重建
    await prisma.userActivityRecords.deleteMany();
    
    // 第一个投票的用户
    const firstVote = await prisma.$queryRaw<Array<{
      user_id: number,
      display_name: string,
      first_vote_at: Date
    }>>`
      SELECT 
        u.id as user_id,
        u."displayName" as display_name,
        MIN(v."timestamp") as first_vote_at
      FROM "User" u
      INNER JOIN "Vote" v ON u.id = v."userId"
      WHERE v."userId" IS NOT NULL
      GROUP BY u.id, u."displayName"
      ORDER BY first_vote_at ASC
      LIMIT 1
    `;
    
    if (firstVote.length > 0) {
      const record = firstVote[0];
      await prisma.userActivityRecords.create({
        data: {
          recordType: 'first_vote',
          userId: record.user_id,
          userDisplayName: record.display_name,
          achievedAt: record.first_vote_at,
          context: {
            description: '站点历史上第一个投票'
          }
        }
      });
    }
    
    // 第一个创建页面的用户（基于 Attribution 数据）
    const firstPageCreator = await prisma.$queryRaw<Array<{
      user_id: number,
      display_name: string,
      first_creation: Date,
      page_count: number
    }>>`
      SELECT 
        u.id as user_id,
        u."displayName" as display_name,
        MIN(a.date) as first_creation,
        COUNT(DISTINCT a."pageVerId") as page_count
      FROM "User" u
      INNER JOIN "Attribution" a ON u.id = a."userId"
      WHERE a."userId" IS NOT NULL 
        AND a.date IS NOT NULL
        AND a.type = 'author'
      GROUP BY u.id, u."displayName"
      ORDER BY first_creation ASC
      LIMIT 1
    `;
    
    if (firstPageCreator.length > 0) {
      const record = firstPageCreator[0];
      await prisma.userActivityRecords.create({
        data: {
          recordType: 'first_page',
          userId: record.user_id,
          userDisplayName: record.display_name,
          value: Number(record.page_count),
          achievedAt: record.first_creation,
          context: {
            description: '站点历史上第一个创建页面的用户',
            pageCount: record.page_count
          }
        }
      });
    }
    
    // 单日投票最多的用户
    const mostVotesInDay = await prisma.$queryRaw<Array<{
      user_id: number,
      display_name: string,
      vote_date: Date,
      vote_count: number
    }>>`
      SELECT 
        u.id as user_id,
        u."displayName" as display_name,
        DATE(v."timestamp") as vote_date,
        COUNT(*) as vote_count
      FROM "User" u
      INNER JOIN "Vote" v ON u.id = v."userId"
      WHERE v."userId" IS NOT NULL
      GROUP BY u.id, u."displayName", DATE(v."timestamp")
      ORDER BY vote_count DESC
      LIMIT 5
    `;
    
    for (let i = 0; i < mostVotesInDay.length; i++) {
      const record = mostVotesInDay[i];
      await prisma.userActivityRecords.create({
        data: {
          recordType: i === 0 ? 'most_votes_single_day' : `most_votes_single_day_top_${i + 1}`,
          userId: record.user_id,
          userDisplayName: record.display_name,
          value: Number(record.vote_count),
          achievedAt: record.vote_date,
          context: {
            description: `单日投票 ${record.vote_count} 次`,
            rank: i + 1
          }
        }
      });
    }
    
    console.log(`✅ 用户活动记录完成 - 第一投票: ${firstVote.length}, 第一创建: ${firstPageCreator.length}, 单日最多: ${mostVotesInDay.length}`);
    
  } catch (error) {
    console.error('❌ 用户活动记录失败:', error);
    throw error;
  }
}

/**
 * 计算实时热点统计
 */
export async function calculateTrendingStats(prisma: PrismaClient) {
  console.log('🔥 计算实时热点统计...');
  
  try {
    // 清空旧数据
    await prisma.trendingStats.deleteMany();
    
    // 今日热门标签（基于今日投票）
    // 优化：添加索引提示和更高效的日期过滤
    const todayHotTags = await prisma.$queryRaw<Array<{
      tag: string,
      vote_count: number,
      avg_rating: number
    }>>`
      SELECT 
        unnest(pv.tags) as tag,
        COUNT(v.id)::int as vote_count,
        AVG(COALESCE(pv.rating, 0))::numeric as avg_rating
      FROM "Vote" v
      INNER JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
      WHERE v."timestamp" >= CURRENT_DATE 
        AND v."timestamp" < CURRENT_DATE + INTERVAL '1 day'
        AND array_length(pv.tags, 1) > 0
        AND v.direction != 0
      GROUP BY unnest(pv.tags)
      HAVING COUNT(v.id) > 0
      ORDER BY vote_count DESC, avg_rating DESC
      LIMIT 10
    `;
    
    for (let i = 0; i < todayHotTags.length; i++) {
      const tag = todayHotTags[i];
      await prisma.trendingStats.create({
        data: {
          statType: 'hot_tag',
          name: tag.tag,
          entityType: 'tag',
          score: tag.vote_count + (Number(tag.avg_rating) / 10), // 混合分数
          period: 'today',
          metadata: {
            voteCount: tag.vote_count,
            avgRating: tag.avg_rating,
            rank: i + 1
          }
        }
      });
    }
    
    // 本周最活跃用户
    const weekActiveUsers = await prisma.$queryRaw<Array<{
      user_id: number,
      display_name: string,
      activity_score: number,
      vote_count: number,
      creation_count: number
    }>>`
      WITH user_activities AS (
        SELECT 
          u.id as user_id,
          u."displayName" as display_name,
          COUNT(DISTINCT v.id) as vote_count,
          COUNT(DISTINCT a.id) as creation_count
        FROM "User" u
        LEFT JOIN "Vote" v ON u.id = v."userId" 
          AND v."timestamp" >= CURRENT_DATE - INTERVAL '7 days'
        LEFT JOIN "Attribution" a ON u.id = a."userId" 
          AND a.date >= CURRENT_DATE - INTERVAL '7 days'
        WHERE u.id IS NOT NULL
        GROUP BY u.id, u."displayName"
        HAVING COUNT(DISTINCT v.id) > 0 OR COUNT(DISTINCT a.id) > 0
      )
      SELECT 
        user_id,
        display_name,
        (vote_count * 1 + creation_count * 10)::numeric as activity_score,
        vote_count,
        creation_count
      FROM user_activities
      ORDER BY activity_score DESC
      LIMIT 10
    `;
    
    for (let i = 0; i < weekActiveUsers.length; i++) {
      const user = weekActiveUsers[i];
      await prisma.trendingStats.create({
        data: {
          statType: 'active_user',
          name: user.display_name || `User ${user.user_id}`,
          entityId: user.user_id,
          entityType: 'user',
          score: user.activity_score,
          period: 'this_week',
          metadata: {
            voteCount: user.vote_count,
            creationCount: user.creation_count,
            rank: i + 1
          }
        }
      });
    }
    
    // 本月趋势页面（评分增长快的页面）
    const trendingPages = await prisma.$queryRaw<Array<{
      page_id: number,
      title: string,
      current_rating: number,
      recent_votes: number
    }>>`
      SELECT 
        p.id as page_id,
        pv.title,
        COALESCE(pv.rating, 0) as current_rating,
        COUNT(v.id)::int as recent_votes
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      LEFT JOIN "Vote" v ON pv.id = v."pageVersionId" 
        AND v."timestamp" >= CURRENT_DATE - INTERVAL '30 days'
        AND v.direction != 0
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
      GROUP BY p.id, pv.title, pv.rating
      HAVING COUNT(v.id) > 0
      ORDER BY recent_votes DESC, current_rating DESC
      LIMIT 10
    `;
    
    for (let i = 0; i < trendingPages.length; i++) {
      const page = trendingPages[i];
      await prisma.trendingStats.create({
        data: {
          statType: 'trending_page',
          name: page.title || `Page ${page.page_id}`,
          entityId: page.page_id,
          entityType: 'page',
          score: page.recent_votes + (page.current_rating / 10), // 混合分数
          period: 'this_month',
          metadata: {
            currentRating: page.current_rating,
            recentVotes: page.recent_votes,
            rank: i + 1
          }
        }
      });
    }
    
    console.log(`✅ 实时热点统计完成 - 今日标签: ${todayHotTags.length}, 周活跃用户: ${weekActiveUsers.length}, 月趋势页面: ${trendingPages.length}`);
    
  } catch (error) {
    console.error('❌ 实时热点统计失败:', error);
    throw error;
  }
}

/**
 * 计算作者成就统计
 */
export async function calculateAuthorAchievements(prisma: PrismaClient, isIncremental = false, cutoffDate: Date | null = null) {
  console.log('🏆 计算作者成就统计...');
  
  try {
    if (!isIncremental || !cutoffDate) {
      // 全量更新时清空旧数据
      await prisma.interestingFacts.deleteMany({
        where: { category: 'author_achievement' }
      });
    } else {
      // 增量更新时，跳过作者成就统计，因为需要全量数据计算排名
      console.log('📝 增量更新：跳过作者成就统计（需要全量数据计算排名）');
      return;
    }

    // 1. "夜猫子作者" - 深夜时段（22:00-06:00）活跃的作者
    console.log('🌙 分析夜猫子作者...');
    
    const nightOwlAuthors = await prisma.$queryRaw<Array<{
      user_id: number,
      display_name: string,
      night_creations: bigint,
      total_creations: bigint,
      night_percentage: number,
      avg_creation_hour: number
    }>>`
      WITH author_time_stats AS (
        SELECT 
          u.id as user_id,
          u."displayName" as display_name,
          COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM a.date) >= 22 OR EXTRACT(HOUR FROM a.date) <= 6) as night_creations,
          COUNT(*) as total_creations,
          AVG(EXTRACT(HOUR FROM a.date)) as avg_creation_hour
        FROM "User" u
        INNER JOIN "Attribution" a ON u.id = a."userId"
        WHERE a.type = 'author' 
          AND a.date IS NOT NULL
          AND EXTRACT(HOUR FROM a.date) != 0  -- 确保有具体时间信息
        GROUP BY u.id, u."displayName"
        HAVING COUNT(*) >= 5  -- 至少5个作品
      )
      SELECT 
        user_id,
        display_name,
        night_creations,
        total_creations,
        (night_creations::numeric * 100.0 / total_creations) as night_percentage,
        avg_creation_hour
      FROM author_time_stats
      WHERE (night_creations::numeric / total_creations) > 0.6  -- 60%以上夜间创作
      ORDER BY night_percentage DESC
      LIMIT 10
    `;

    for (let i = 0; i < nightOwlAuthors.length; i++) {
      const author = nightOwlAuthors[i];
      await prisma.interestingFacts.create({
        data: {
          category: 'author_achievement',
          type: 'night_owl_author',
          title: `夜猫子作者 #${i + 1}`,
          description: `${author.display_name}有${Number(author.night_percentage).toFixed(1)}%的作品都是在深夜时段（22:00-06:00）创作的，共${author.night_creations}/${author.total_creations}个作品。`,
          value: author.night_percentage.toString(),
          userId: author.user_id,
          rank: i + 1,
          metadata: {
            nightCreations: Number(author.night_creations),
            totalCreations: Number(author.total_creations),
            avgCreationHour: Number(author.avg_creation_hour)
          }
        }
      });
    }

    // 2. "马拉松作者" - 单日创作最多页面的记录
    console.log('🏃 分析马拉松作者...');
    
    const marathonAuthors = await prisma.$queryRaw<Array<{
      user_id: number,
      display_name: string,
      creation_date: Date,
      pages_created: bigint,
      avg_rating: number
    }>>`
      SELECT 
        u.id as user_id,
        u."displayName" as display_name,
        DATE(a.date) as creation_date,
        COUNT(*) as pages_created,
        AVG(COALESCE(pv.rating, 0)) as avg_rating
      FROM "User" u
      INNER JOIN "Attribution" a ON u.id = a."userId"
      INNER JOIN "PageVersion" pv ON a."pageVerId" = pv.id
      WHERE a.type = 'author' 
        AND a.date IS NOT NULL
        AND pv."validTo" IS NULL
        AND pv."isDeleted" = false
      GROUP BY u.id, u."displayName", DATE(a.date)
      HAVING COUNT(*) >= 3  -- 单日至少3个页面
      ORDER BY pages_created DESC, avg_rating DESC
      LIMIT 10
    `;

    for (let i = 0; i < marathonAuthors.length; i++) {
      const author = marathonAuthors[i];
      await prisma.interestingFacts.create({
        data: {
          category: 'author_achievement',
          type: 'marathon_author',
          title: `马拉松作者记录 #${i + 1}`,
          description: `${author.display_name}在${author.creation_date.toISOString().split('T')[0]}单日创作了${author.pages_created}个页面，平均评分${Number(author.avg_rating).toFixed(1)}分。`,
          value: author.pages_created.toString(),
          userId: author.user_id,
          dateContext: author.creation_date,
          rank: i + 1,
          metadata: {
            creationDate: author.creation_date,
            pagesCreated: Number(author.pages_created),
            avgRating: Number(author.avg_rating)
          }
        }
      });
    }

    // 3. "连号奇迹" - 连续编号被同一作者创建
    console.log('🔢 分析连号奇迹...');
    
    const consecutiveNumbers = await prisma.$queryRaw<Array<{
      user_id: number,
      display_name: string,
      start_number: number,
      end_number: number,
      consecutive_count: number,
      avg_rating: number
    }>>`
      WITH scp_pages AS (
        SELECT 
          p.url,
          u.id as user_id,
          u."displayName" as display_name,
          CAST(SUBSTRING(p.url FROM 'scp-cn-([0-9]+)') AS INTEGER) as scp_number,
          pv.rating,
          ROW_NUMBER() OVER (PARTITION BY u.id ORDER BY CAST(SUBSTRING(p.url FROM 'scp-cn-([0-9]+)') AS INTEGER)) as seq
        FROM "Page" p
        INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
        INNER JOIN "Attribution" a ON a."pageVerId" = pv.id
        INNER JOIN "User" u ON u.id = a."userId"
        WHERE p.url ~ '^scp-cn-[0-9]+$'
          AND pv."validTo" IS NULL
          AND pv."isDeleted" = false  
          AND a.type = 'author'
          AND '原创' = ANY(pv.tags)
      ),
      consecutive_groups AS (
        SELECT 
          user_id,
          display_name,
          scp_number,
          rating,
          scp_number - seq as group_id
        FROM scp_pages
      ),
      consecutive_counts AS (
        SELECT 
          user_id,
          display_name,
          group_id,
          MIN(scp_number) as start_number,
          MAX(scp_number) as end_number,
          COUNT(*) as consecutive_count,
          AVG(COALESCE(rating, 0)) as avg_rating
        FROM consecutive_groups
        GROUP BY user_id, display_name, group_id
        HAVING COUNT(*) >= 3  -- 至少3个连续编号
      )
      SELECT 
        user_id,
        display_name,
        start_number,
        end_number,
        consecutive_count,
        avg_rating
      FROM consecutive_counts
      ORDER BY consecutive_count DESC, avg_rating DESC
      LIMIT 5
    `;

    for (let i = 0; i < consecutiveNumbers.length; i++) {
      const record = consecutiveNumbers[i];
      await prisma.interestingFacts.create({
        data: {
          category: 'author_achievement',
          type: 'consecutive_numbers',
          title: `连号奇迹 #${i + 1}`,
          description: `${record.display_name}创作了连续${record.consecutive_count}个编号：SCP-CN-${record.start_number}到SCP-CN-${record.end_number}，平均评分${Number(record.avg_rating).toFixed(1)}分。`,
          value: record.consecutive_count.toString(),
          userId: record.user_id,
          rank: i + 1,
          metadata: {
            startNumber: record.start_number,
            endNumber: record.end_number,
            consecutiveCount: record.consecutive_count,
            avgRating: Number(record.avg_rating)
          }
        }
      });
    }

    console.log(`✅ 作者成就统计完成 - 夜猫子: ${nightOwlAuthors.length}, 马拉松: ${marathonAuthors.length}, 连号: ${consecutiveNumbers.length}`);

  } catch (error) {
    console.error('❌ 作者成就统计失败:', error);
    throw error;
  }
}

/**
 * 计算站点里程碑
 */
export async function calculateSiteMilestones(prisma: PrismaClient, isIncremental = false, cutoffDate: Date | null = null) {
  console.log('🎯 计算站点里程碑...');
  
  try {
    if (!isIncremental || !cutoffDate) {
      // 全量更新时清空旧数据
      await prisma.interestingFacts.deleteMany({
        where: { category: 'site_milestone' }
      });
    } else {
      // 增量更新时，跳过站点里程碑统计，因为需要全量数据计算里程碑
      console.log('📝 增量更新：跳过站点里程碑统计（需要全量数据计算里程碑）');
      return;
    }

    // 1. 投票里程碑 - 特殊投票数量节点
    console.log('🗳️ 分析投票里程碑...');
    
    const voteMilestones = [100000, 200000, 500000, 750000, 900000];
    
    for (const milestone of voteMilestones) {
      // 找到达到该投票数的大致时间点
      const milestoneData = await prisma.$queryRaw<Array<{
        milestone_date: Date,
        total_votes: bigint,
        milestone_vote_id: number
      }>>`
        WITH cumulative_votes AS (
          SELECT 
            id,
            "timestamp",
            ROW_NUMBER() OVER (ORDER BY "timestamp", id) as vote_number
          FROM "Vote"
          ORDER BY "timestamp", id
        )
        SELECT 
          cv."timestamp" as milestone_date,
          cv.vote_number as total_votes,
          cv.id as milestone_vote_id
        FROM cumulative_votes cv
        WHERE cv.vote_number >= ${milestone}
        ORDER BY cv.vote_number ASC
        LIMIT 1
      `;

      if (milestoneData.length > 0) {
        const data = milestoneData[0];
        await prisma.interestingFacts.create({
          data: {
            category: 'site_milestone',
            type: 'vote_milestone',
            title: `第${milestone.toLocaleString()}票里程碑`,
            description: `SCP-CN分部在${data.milestone_date.toISOString().split('T')[0]}达到了第${milestone.toLocaleString()}票的里程碑。`,
            value: milestone.toString(),
            dateContext: data.milestone_date,
            metadata: {
              milestone: milestone,
              achievedDate: data.milestone_date,
              milestoneVoteId: data.milestone_vote_id
            }
          }
        });
      }
    }

    // 2. 用户数里程碑
    console.log('👥 分析用户数里程碑...');
    
    const userMilestones = [1000, 5000, 10000, 20000, 30000];
    
    for (const milestone of userMilestones) {
      const milestoneData = await prisma.$queryRaw<Array<{
        milestone_date: Date,
        milestone_user_id: number
      }>>`
        WITH user_sequence AS (
          SELECT 
            id,
            "firstActivityAt",
            ROW_NUMBER() OVER (ORDER BY "firstActivityAt", id) as user_number
          FROM "User"
          WHERE "firstActivityAt" IS NOT NULL
          ORDER BY "firstActivityAt", id
        )
        SELECT 
          us."firstActivityAt" as milestone_date,
          us.id as milestone_user_id
        FROM user_sequence us
        WHERE us.user_number = ${milestone}
      `;

      if (milestoneData.length > 0) {
        const data = milestoneData[0];
        await prisma.interestingFacts.create({
          data: {
            category: 'site_milestone',
            type: 'user_milestone',
            title: `第${milestone.toLocaleString()}位用户里程碑`,
            description: `SCP-CN分部的第${milestone.toLocaleString()}位用户在${data.milestone_date.toISOString().split('T')[0]}加入了社区。`,
            value: milestone.toString(),
            dateContext: data.milestone_date,
            userId: data.milestone_user_id,
            metadata: {
              milestone: milestone,
              achievedDate: data.milestone_date,
              milestoneUserId: data.milestone_user_id
            }
          }
        });
      }
    }

    // 3. 评分对称页面 - 回文数评分
    console.log('🔄 分析评分对称页面...');
    
    const palindromeRatings = await prisma.$queryRaw<Array<{
      page_id: number,
      title: string,
      rating: number,
      vote_count: number
    }>>`
      SELECT 
        p.id as page_id,
        pv.title,
        pv.rating,
        pv."voteCount" as vote_count
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND pv."isDeleted" = false
        AND pv.rating IS NOT NULL
        AND pv.rating > 0
        AND pv.rating::text = REVERSE(pv.rating::text)  -- 回文数检测
        AND LENGTH(pv.rating::text) > 1  -- 至少两位数
      ORDER BY pv.rating DESC
      LIMIT 10
    `;

    for (let i = 0; i < palindromeRatings.length; i++) {
      const page = palindromeRatings[i];
      await prisma.interestingFacts.create({
        data: {
          category: 'site_milestone',
          type: 'palindrome_rating',
          title: `评分对称奇迹 #${i + 1}`,
          description: `"${page.title}"拥有完美对称的评分${page.rating}分，基于${page.vote_count}票投票。`,
          value: page.rating.toString(),
          pageId: page.page_id,
          rank: i + 1,
          metadata: {
            rating: page.rating,
            voteCount: page.vote_count,
            title: page.title
          }
        }
      });
    }

    console.log(`✅ 站点里程碑统计完成 - 投票: ${voteMilestones.length}, 用户: ${userMilestones.length}, 对称评分: ${palindromeRatings.length}`);

  } catch (error) {
    console.error('❌ 站点里程碑统计失败:', error);
    throw error;
  }
}

/**
 * 生成通用有趣事实
 */
export async function generateInterestingFacts(prisma: PrismaClient, isIncremental = false, cutoffDate: Date | null = null) {
  console.log('💡 生成通用有趣事实...');
  
  try {
    if (!isIncremental) {
      // 全量更新时清空旧数据  
      await prisma.interestingFacts.deleteMany();
    } else {
      // 增量更新时，只清理从其他专门表生成的通用事实
      // 保留直接插入到interestingFacts的特殊统计（如作者成就、站点里程碑等）
      await prisma.interestingFacts.deleteMany({
        where: {
          OR: [
            { category: 'time_milestone' },
            { category: 'tag_record' }, 
            { category: 'content_length' }
          ]
        }
      });
      console.log('📝 增量更新：清理了通用事实记录，保留特殊统计');
    }
    
    // 从各个专门表中提取数据生成有趣事实
    
    // 1. 时间里程碑事实
    const timeMilestones = await prisma.timeMilestones.findMany({
      include: { page: true }
    });
    
    for (const milestone of timeMilestones) {
      let title = '';
      let description = '';
      
      switch (milestone.milestoneType) {
        case 'first_page':
          title = `${milestone.periodValue}年的第一个页面`;
          description = `"${milestone.pageTitle}" 是${milestone.periodValue}年创建的第一个页面，评分 ${milestone.pageRating}`;
          break;
        case 'last_page':
          title = `${milestone.periodValue}年的最后一个页面`;
          description = `"${milestone.pageTitle}" 是${milestone.periodValue}年创建的最后一个页面`;
          break;
        case 'first_high_rated':
          title = `${milestone.periodValue}年的第一个高分页面`;
          description = `"${milestone.pageTitle}" 是${milestone.periodValue}年第一个超过50分的页面，评分 ${milestone.pageRating}`;
          break;
      }
      
      await prisma.interestingFacts.create({
        data: {
          category: 'time_milestone',
          type: milestone.milestoneType,
          title,
          description,
          value: milestone.pageRating?.toString(),
          pageId: milestone.pageId,
          dateContext: createValidDate(milestone.periodValue, milestone.period),
          metadata: {
            period: milestone.period,
            periodValue: milestone.periodValue
          }
        }
      });
    }
    
    // 2. 标签记录事实
    const tagRecords = await prisma.tagRecords.findMany({
      include: { page: true }
    });
    
    for (const record of tagRecords) {
      let title = '';
      let description = '';
      
      switch (record.recordType) {
        case 'highest_rated':
          title = `"${record.tag}"标签的最高分页面`;
          description = `"${record.metadata?.title}" 是"${record.tag}"标签下评分最高的页面，评分 ${record.value}`;
          break;
        case 'first_page':
          title = `"${record.tag}"标签的第一个页面`;
          description = `"${record.metadata?.title}" 是第一个使用"${record.tag}"标签的页面`;
          break;
        case 'most_popular':
          title = `最热门的"${record.tag}"标签`;
          description = `"${record.tag}"标签被 ${record.value} 个页面使用`;
          break;
      }
      
      await prisma.interestingFacts.create({
        data: {
          category: 'tag_record',
          type: record.recordType,
          title,
          description,
          value: record.value?.toString(),
          pageId: record.pageId,
          tagContext: record.tag,
          metadata: record.metadata
        }
      });
    }
    
    // 3. 内容分析事实
    const contentRecords = await prisma.contentRecords.findMany({
      include: { page: true }
    });
    
    for (const record of contentRecords) {
      let title = '';
      let description = '';
      
      if (record.recordType.includes('longest_source')) {
        title = '源代码最长的页面';
        description = `"${record.pageTitle}" 拥有最长的源代码，共 ${record.sourceLength} 个字符`;
      } else if (record.recordType.includes('shortest_source')) {
        title = '源代码最短的页面';
        description = `"${record.pageTitle}" 拥有最短的源代码，仅 ${record.sourceLength} 个字符`;
      } else if (record.recordType.includes('longest_content')) {
        title = '内容最长的页面';
        description = `"${record.pageTitle}" 拥有最长的渲染内容，共 ${record.contentLength} 个字符`;
      }
      
      await prisma.interestingFacts.create({
        data: {
          category: 'content_length',
          type: record.recordType,
          title,
          description,
          value: (record.sourceLength || record.contentLength)?.toString(),
          pageId: record.pageId,
          metadata: record.complexity
        }
      });
    }
    
    console.log(`✅ 通用有趣事实生成完成`);
    
  } catch (error) {
    console.error('❌ 通用有趣事实生成失败:', error);
    throw error;
  }
}