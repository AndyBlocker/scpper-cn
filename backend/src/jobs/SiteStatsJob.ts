import { PrismaClient } from '@prisma/client';

export async function calculateSiteStatistics(prisma: PrismaClient) {
  console.log('🏗️ 开始计算全站统计数据...');
  
  try {
    // Calculate SCP-CN series statistics
    await calculateScpSeriesStats(prisma);
    
    // Calculate daily site statistics
    await calculateDailySiteStats(prisma);
    
    // Note: Daily aggregates are now handled separately in AnalyzeJob to support incremental mode
    
    console.log('✅ 全站统计数据计算完成');
  } catch (error) {
    console.error('❌ 全站统计数据计算失败:', error);
    throw error;
  }
}

/**
 * 计算SCP-CN编号系列占用情况
 */
export async function calculateScpSeriesStats(prisma: PrismaClient) {
  console.log('📊 计算SCP-CN编号系列占用情况...');
  
  try {
    // Get all pages with SCP-CN pattern, excluding deleted pages
    const scpPages = await prisma.$queryRaw<Array<{url: string, title: string, pageId: number}>>`
      SELECT p.url, pv.title, p.id as "pageId"
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND p.url ~ 'scp-cn-[0-9]{3,4}$'
        AND p.url NOT LIKE '%deleted:%'  -- Exclude deleted pages
        AND '原创' = ANY(pv.tags)  -- Must have 原创 tag
        AND NOT ('待删除' = ANY(pv.tags))  -- Must not have 待删除 tag
        AND NOT ('待刪除' = ANY(pv.tags))  -- Must not have 待刪除 tag (traditional Chinese)
      ORDER BY p.url;
    `;
    
    console.log(`找到 ${scpPages.length} 个SCP-CN编号页面`);
    
    // Count total unique numbers for verification
    let totalRawPages = 0;
    let totalUniqueNumbers = 0;
    
    // Parse numbers and group by series with deduplication
    const seriesData = new Map<number, {
      numbers: Set<number>,  // Use Set to automatically handle duplicates
      milestonePageId?: number
    }>();
    
    for (const page of scpPages) {
      const match = page.url.match(/scp-cn-(\d{3,4})$/);
      if (!match) continue;
      
      totalRawPages++;
      const num = parseInt(match[1]);
      
      // Skip invalid numbers (like 0000, which shouldn't exist)
      if (num < 1) continue;
      
      let seriesNum: number;
      
      if (num >= 2 && num <= 999) {
        seriesNum = 1;
      } else if (num >= 1000) {
        seriesNum = Math.floor(num / 1000) + 1;
      } else {
        // Skip num = 1 (SCP-CN-001 is special) and invalid numbers
        continue;
      }
      
      if (!seriesData.has(seriesNum)) {
        seriesData.set(seriesNum, { numbers: new Set() });
      }
      
      // Add to set (automatically deduplicates)
      const sizeBefore = seriesData.get(seriesNum)!.numbers.size;
      seriesData.get(seriesNum)!.numbers.add(num);
      const sizeAfter = seriesData.get(seriesNum)!.numbers.size;
      
      // Count unique numbers
      if (sizeAfter > sizeBefore) {
        totalUniqueNumbers++;
      }
      
      // Check if this is a milestone page (x000)
      if (num % 1000 === 0) {
        seriesData.get(seriesNum)!.milestonePageId = page.pageId;
      }
    }
    
    console.log(`原始页面数: ${totalRawPages}, 去重后编号数: ${totalUniqueNumbers}`);
    
    // Calculate stats for each series
    for (const [seriesNumber, data] of Array.from(seriesData.entries())) {
      const totalSlots = seriesNumber === 1 ? 998 : 1000;  // Series 1: 002-999 (998 slots)
      const usedSlots = data.numbers.size;  // Use .size for Set
      const usagePercentage = (usedSlots / totalSlots) * 100;
      
      // Series is open if:
      // 1. It's series 1 (always open)
      // 2. It has a milestone page (scp-cn-x000)
      const isOpen = seriesNumber === 1 || data.milestonePageId !== undefined;
      
      await prisma.seriesStats.upsert({
        where: { seriesNumber },
        update: {
          usedSlots,
          usagePercentage,
          milestonePageId: data.milestonePageId,
          lastUpdated: new Date(),
          isOpen
        },
        create: {
          seriesNumber,
          totalSlots,
          usedSlots,
          usagePercentage,
          milestonePageId: data.milestonePageId,
          isOpen
        }
      });
      
      console.log(`系列 ${seriesNumber}: ${usedSlots}/${totalSlots} (${usagePercentage.toFixed(1)}%) ${isOpen ? '开放' : '未开放'}`);
      
      // Show some examples of numbers in this series for verification
      if (data.numbers.size > 0) {
        const sampleNumbers = Array.from(data.numbers).sort((a: number, b: number) => a - b);
        const samples = sampleNumbers.slice(0, 3);
        const hasMore = sampleNumbers.length > 3;
        console.log(`  编号示例: ${samples.join(', ')}${hasMore ? ` ... (共${sampleNumbers.length}个)` : ''}`);
      }
    }
    
    console.log('✅ SCP-CN系列统计完成');
    
  } catch (error) {
    console.error('❌ SCP-CN系列统计失败:', error);
    throw error;
  }
}

/**
 * 计算每日站点统计数据
 */
export async function calculateDailySiteStats(prisma: PrismaClient) {
  console.log('📈 计算每日站点统计数据...');
  
  try {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    
    // Get total counts
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    
    const totalStats = await prisma.$queryRaw<Array<{
      totalUsers: bigint,
      activeUsers: bigint,
      totalPages: bigint,
      totalVotes: bigint
    }>>`
      SELECT 
        (SELECT COUNT(*) FROM "User") as "totalUsers",
        (SELECT COUNT(*) FROM "User" WHERE "lastActivityAt" IS NOT NULL AND "lastActivityAt" >= ${threeMonthsAgo}) as "activeUsers",
        (SELECT COUNT(*) FROM "Page") as "totalPages",
        (SELECT COUNT(*) FROM "Vote") as "totalVotes"
    `;
    
    const stats = totalStats[0];
    
    // Get new counts for today
    const newStats = await prisma.$queryRaw<Array<{
      newUsersToday: bigint,
      newPagesToday: bigint,
      newVotesToday: bigint
    }>>`
      SELECT 
        (SELECT COUNT(*) FROM "User" WHERE DATE("firstActivityAt") = ${today}) as "newUsersToday",
        (SELECT COUNT(*) FROM "Page" WHERE DATE("createdAt") = ${today}) as "newPagesToday",
        (SELECT COUNT(*) FROM "Vote" WHERE DATE("timestamp") = ${today}) as "newVotesToday"
    `;
    
    const newCounts = newStats[0];
    
    // Upsert today's stats
    await prisma.siteStats.upsert({
      where: { date: today },
      update: {
        totalUsers: Number(stats.totalUsers),
        activeUsers: Number(stats.activeUsers),
        totalPages: Number(stats.totalPages),
        totalVotes: Number(stats.totalVotes),
        newUsersToday: Number(newCounts.newUsersToday),
        newPagesToday: Number(newCounts.newPagesToday),
        newVotesToday: Number(newCounts.newVotesToday),
        updatedAt: new Date()
      },
      create: {
        date: today,
        totalUsers: Number(stats.totalUsers),
        activeUsers: Number(stats.activeUsers),
        totalPages: Number(stats.totalPages),
        totalVotes: Number(stats.totalVotes),
        newUsersToday: Number(newCounts.newUsersToday),
        newPagesToday: Number(newCounts.newPagesToday),
        newVotesToday: Number(newCounts.newVotesToday)
      }
    });
    
    console.log(`✅ 每日统计完成 - 总用户: ${stats.totalUsers}, 活跃用户: ${stats.activeUsers}, 总页面: ${stats.totalPages}, 总投票: ${stats.totalVotes}`);
    
  } catch (error) {
    console.error('❌ 每日统计失败:', error);
    throw error;
  }
}

/**
 * 创建每日聚合视图和预处理数据
 */
export async function generateDailyAggregates(prisma: PrismaClient, isIncremental = false) {
  console.log('📊 生成每日聚合数据...');
  
  try {
    // 智能判断需要处理的日期范围
    const dateRanges = await getDailyAggregationDateRanges(prisma, isIncremental);
    
    if (dateRanges.totalDays === 0) {
      console.log('✅ 所有每日聚合数据都是最新的，跳过处理');
      return;
    }
    
    console.log(`📈 需要处理 ${dateRanges.totalDays} 天的数据 (${dateRanges.startDate.toISOString().split('T')[0]} 到 ${dateRanges.endDate.toISOString().split('T')[0]})`);
    
    // 并行处理不同类型的聚合数据以提升性能
    await Promise.all([
      generateDailyVoteAggregates(prisma, dateRanges),
      generateDailyUserAggregates(prisma, dateRanges), 
      generateDailyPageAggregates(prisma, dateRanges)
    ]);
    
    // 每日标签趋势聚合（总是重新计算最近趋势）
    await generateDailyTagAggregates(prisma);
    
    console.log('✅ 每日聚合数据生成完成');
  } catch (error) {
    console.error('❌ 每日聚合数据生成失败:', error);
    throw error;
  }
}

/**
 * 获取智能日期范围用于每日聚合
 */
async function getDailyAggregationDateRanges(prisma: PrismaClient, isIncremental: boolean) {
  if (!isIncremental) {
    // 全量模式：获取完整的历史数据范围
    const [voteRange] = await prisma.$queryRaw<Array<{
      earliest_date: Date,
      latest_date: Date
    }>>`
      SELECT 
        MIN(DATE("timestamp")) as earliest_date,
        MAX(DATE("timestamp")) as latest_date
      FROM "Vote" 
      WHERE "timestamp" IS NOT NULL
    `;
    
    const startDate = voteRange?.earliest_date ? new Date(voteRange.earliest_date) : new Date();
    const now = new Date();
    const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const totalDays = Math.max(0, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
    
    return { startDate, endDate, totalDays };
  }
  
  // 增量模式：查找缺失的日期
  const [latestStat] = await prisma.$queryRaw<Array<{latest_date: Date}>>`
    SELECT MAX(date) as latest_date 
    FROM "SiteStats"
  `;
  
  const startDate = latestStat?.latest_date 
    ? new Date(latestStat.latest_date.getTime() + 24 * 60 * 60 * 1000) // 从最新记录的下一天开始
    : new Date(new Date().getTime() - 90 * 24 * 60 * 60 * 1000); // 如果没有记录，处理最近90天
  
  const now = new Date();
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const totalDays = Math.max(0, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
  
  return { startDate, endDate, totalDays };
}

/**
 * 每日投票统计聚合（优化版）
 */
export async function generateDailyVoteAggregates(prisma: PrismaClient, dateRanges: {startDate: Date, endDate: Date, totalDays: number}) {
  console.log('🗳️ 生成每日投票聚合数据（基于日级别timestamp）...');
  
  if (dateRanges.totalDays === 0) {
    console.log('无需处理投票数据');
    return;
  }

  // 使用高效的批量查询一次性获取所有日期的投票统计
  const dailyVoteStats = await prisma.$queryRaw<Array<{
    vote_date: string,
    total_votes: bigint,
    upvotes: bigint, 
    downvotes: bigint,
    neutral_votes: bigint,
    unique_voters: bigint,
    unique_pages_voted: bigint
  }>>`
    SELECT 
      DATE("timestamp")::text as vote_date,
      COUNT(*) as total_votes,
      COUNT(*) FILTER (WHERE direction > 0) as upvotes,
      COUNT(*) FILTER (WHERE direction < 0) as downvotes,
      COUNT(*) FILTER (WHERE direction = 0) as neutral_votes,
      COUNT(DISTINCT "userId") FILTER (WHERE "userId" IS NOT NULL) as unique_voters,
      COUNT(DISTINCT "pageVersionId") as unique_pages_voted
    FROM "Vote" 
    WHERE DATE("timestamp") >= DATE(${dateRanges.startDate})
      AND DATE("timestamp") <= DATE(${dateRanges.endDate})
      AND "timestamp" IS NOT NULL
    GROUP BY DATE("timestamp")
    ORDER BY vote_date
  `;

  // 批量 upsert 操作
  const batchSize = 100;
  for (let i = 0; i < dailyVoteStats.length; i += batchSize) {
    const batch = dailyVoteStats.slice(i, i + batchSize);
    
    await prisma.$transaction(async (tx) => {
      for (const stats of batch) {
        const date = new Date(stats.vote_date);
        
        await tx.siteStats.upsert({
          where: { date },
          update: {
            newVotesToday: Number(stats.total_votes),
            updatedAt: new Date()
          },
          create: {
            date,
            newVotesToday: Number(stats.total_votes),
            totalUsers: 0,
            activeUsers: 0,
            totalPages: 0,
            totalVotes: 0,
            newUsersToday: 0,
            newPagesToday: 0
          }
        });
      }
    });
    
    console.log(`批量处理第 ${Math.floor(i/batchSize) + 1}/${Math.ceil(dailyVoteStats.length/batchSize)} 批投票数据`);
  }
  
  console.log(`✅ 处理了 ${dailyVoteStats.length} 天的投票聚合数据`);
}

/**
 * 每日用户活动聚合（优化版）
 */
export async function generateDailyUserAggregates(prisma: PrismaClient, dateRanges: {startDate: Date, endDate: Date, totalDays: number}) {
  console.log('👥 生成每日用户活动聚合数据...');
  
  if (dateRanges.totalDays === 0) {
    console.log('无需处理用户数据');
    return;
  }
  
  // 高效的分别查询方法，避免复杂的 FULL OUTER JOIN
  
  // 1. 查询新用户数据
  const newUsersData = await prisma.$queryRaw<Array<{
    activity_date: string,
    new_users: bigint
  }>>`
    SELECT 
      DATE("firstActivityAt")::text as activity_date,
      COUNT(*) as new_users
    FROM "User"
    WHERE "firstActivityAt" IS NOT NULL
      AND DATE("firstActivityAt") >= DATE(${dateRanges.startDate})
      AND DATE("firstActivityAt") <= DATE(${dateRanges.endDate})
    GROUP BY DATE("firstActivityAt")
    ORDER BY activity_date
  `;
  
  // 2. 查询每日投票用户数
  const votingUsersData = await prisma.$queryRaw<Array<{
    vote_date: string,
    users_who_voted: bigint
  }>>`
    SELECT 
      DATE("timestamp")::text as vote_date,
      COUNT(DISTINCT "userId") FILTER (WHERE "userId" IS NOT NULL) as users_who_voted
    FROM "Vote"
    WHERE "timestamp" IS NOT NULL
      AND DATE("timestamp") >= DATE(${dateRanges.startDate})
      AND DATE("timestamp") <= DATE(${dateRanges.endDate})
    GROUP BY DATE("timestamp")
    ORDER BY vote_date
  `;
  
  // 3. 查询每日创作用户数
  const creatingUsersData = await prisma.$queryRaw<Array<{
    creation_date: string,
    users_who_created: bigint
  }>>`
    SELECT 
      DATE(a.date)::text as creation_date,
      COUNT(DISTINCT a."userId") FILTER (WHERE a."userId" IS NOT NULL) as users_who_created
    FROM "Attribution" a
    WHERE a.date IS NOT NULL
      AND a.type = 'author'
      AND DATE(a.date) >= DATE(${dateRanges.startDate})
      AND DATE(a.date) <= DATE(${dateRanges.endDate})
    GROUP BY DATE(a.date)
    ORDER BY creation_date
  `;
  
  // 合并数据并批量更新
  const combinedData = new Map<string, {
    newUsers: number,
    votingUsers: number, 
    creatingUsers: number
  }>();
  
  // 初始化所有日期
  const currentDate = new Date(dateRanges.startDate);
  while (currentDate <= dateRanges.endDate) {
    const dateStr = currentDate.toISOString().split('T')[0];
    combinedData.set(dateStr, { newUsers: 0, votingUsers: 0, creatingUsers: 0 });
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  // 填充数据
  newUsersData.forEach(item => {
    const data = combinedData.get(item.activity_date);
    if (data) data.newUsers = Number(item.new_users);
  });
  
  votingUsersData.forEach(item => {
    const data = combinedData.get(item.vote_date);
    if (data) data.votingUsers = Number(item.users_who_voted);
  });
  
  creatingUsersData.forEach(item => {
    const data = combinedData.get(item.creation_date);
    if (data) data.creatingUsers = Number(item.users_who_created);
  });
  
  // 批量更新数据库
  const batchSize = 50;
  const entries = Array.from(combinedData.entries());
  
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    
    await prisma.$transaction(async (tx) => {
      for (const [dateStr, data] of batch) {
        const date = new Date(dateStr);
        const activeUsers = Math.max(data.votingUsers, data.creatingUsers);
        
        await tx.siteStats.upsert({
          where: { date },
          update: {
            newUsersToday: data.newUsers,
            updatedAt: new Date()
          },
          create: {
            date,
            newUsersToday: data.newUsers,
            activeUsers: 0, // 这里不设置 activeUsers，由其他逻辑处理
            totalUsers: 0,
            totalPages: 0,
            totalVotes: 0,
            newPagesToday: 0,
            newVotesToday: 0
          }
        });
      }
    });
    
    console.log(`批量处理第 ${Math.floor(i/batchSize) + 1}/${Math.ceil(entries.length/batchSize)} 批用户数据`);
  }
  
  console.log(`✅ 处理了 ${combinedData.size} 天的用户聚合数据`);
}

/**
 * 每日页面统计聚合（优化版）
 */
export async function generateDailyPageAggregates(prisma: PrismaClient, dateRanges: {startDate: Date, endDate: Date, totalDays: number}) {
  console.log('📄 生成每日页面聚合数据...');
  
  if (dateRanges.totalDays === 0) {
    console.log('无需处理页面数据');
    return;
  }
  
  // 优化的单次查询方法，获取所有日期的页面统计
  const dailyPageStats = await prisma.$queryRaw<Array<{
    creation_date: string,
    new_pages: bigint,
    scp_pages_created: bigint,
    story_pages_created: bigint
  }>>`
    WITH page_creation_dates AS (
      SELECT 
        p.id as page_id,
        pv.tags,
        COALESCE(
          (SELECT MIN(a.date) FROM "Attribution" a WHERE a."pageVerId" = pv.id AND a.date IS NOT NULL),
          (SELECT MIN(r.timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id),
          pv."validFrom",
          p."createdAt"
        ) as created_at
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
    ),
    daily_pages AS (
      SELECT 
        DATE(created_at)::text as creation_date,
        page_id,
        tags
      FROM page_creation_dates
      WHERE created_at IS NOT NULL
        AND DATE(created_at) >= DATE(${dateRanges.startDate})
        AND DATE(created_at) <= DATE(${dateRanges.endDate})
    )
    SELECT 
      creation_date,
      COUNT(*) as new_pages,
      COUNT(*) FILTER (WHERE 'scp' = ANY(tags)) as scp_pages_created,
      COUNT(*) FILTER (WHERE 'tale' = ANY(tags) OR 'goi格式' = ANY(tags)) as story_pages_created
    FROM daily_pages
    GROUP BY creation_date
    ORDER BY creation_date
  `;
  
  // 批量更新数据库
  const batchSize = 50;
  for (let i = 0; i < dailyPageStats.length; i += batchSize) {
    const batch = dailyPageStats.slice(i, i + batchSize);
    
    await prisma.$transaction(async (tx) => {
      for (const stats of batch) {
        const date = new Date(stats.creation_date);
        
        await tx.siteStats.upsert({
          where: { date },
          update: {
            newPagesToday: Number(stats.new_pages),
            updatedAt: new Date()
          },
          create: {
            date,
            newPagesToday: Number(stats.new_pages),
            totalUsers: 0,
            activeUsers: 0,
            totalPages: 0,
            totalVotes: 0,
            newUsersToday: 0,
            newVotesToday: 0
          }
        });
      }
    });
    
    console.log(`批量处理第 ${Math.floor(i/batchSize) + 1}/${Math.ceil(dailyPageStats.length/batchSize)} 批页面数据`);
  }
  
  console.log(`✅ 处理了 ${dailyPageStats.length} 天的页面聚合数据`);
}

/**
 * 每日标签趋势聚合
 */
export async function generateDailyTagAggregates(prisma: PrismaClient) {
  console.log('🏷️ 生成每日标签趋势聚合数据...');
  
  // 获取过去7天的热门标签趋势
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  
  const tagTrends = await prisma.$queryRaw<Array<{
    tag: string,
    daily_usage: number,
    weekly_total: number,
    trend_direction: string
  }>>`
    WITH daily_tag_usage AS (
      SELECT 
        unnest(pv.tags) as tag,
        DATE(a.date) as usage_date,
        COUNT(*) as daily_count
      FROM "PageVersion" pv
      INNER JOIN "Attribution" a ON a."pageVerId" = pv.id
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND a.type = 'author'
        AND a.date >= ${weekAgo}
        AND array_length(pv.tags, 1) > 0
      GROUP BY unnest(pv.tags), DATE(a.date)
    ),
    weekly_trends AS (
      SELECT 
        tag,
        COUNT(*) as weekly_total,
        AVG(daily_count) as avg_daily,
        MAX(daily_count) as peak_daily
      FROM daily_tag_usage
      GROUP BY tag
      HAVING COUNT(*) > 2  -- At least used 3 days this week
      ORDER BY weekly_total DESC
      LIMIT 20
    )
    SELECT 
      tag,
      avg_daily::numeric as daily_usage,
      weekly_total,
      CASE 
        WHEN peak_daily > avg_daily * 1.5 THEN 'rising'
        WHEN peak_daily < avg_daily * 0.7 THEN 'declining' 
        ELSE 'stable'
      END as trend_direction
    FROM weekly_trends
  `;

  // 清空旧的热点统计，重新生成
  await prisma.trendingStats.deleteMany({
    where: {
      statType: 'trending_tag',
      period: 'this_week'
    }
  });

  for (let i = 0; i < tagTrends.length; i++) {
    const trend = tagTrends[i];
    await prisma.trendingStats.create({
      data: {
        statType: 'trending_tag',
        name: trend.tag,
        entityType: 'tag',
        score: trend.weekly_total,
        period: 'this_week',
        metadata: {
          dailyUsage: trend.daily_usage,
          trendDirection: trend.trend_direction,
          rank: i + 1
        }
      }
    });
  }
  
  console.log(`✅ 标签趋势聚合完成，生成${tagTrends.length}个趋势标签`);
}

/**
 * 生成历史统计数据（回填）
 */
export async function generateHistoricalStats(prisma: PrismaClient, startDate?: Date) {
  console.log('🔄 生成历史统计数据...');
  
  try {
    // Get earliest and latest dates from user activities
    const dateRange = await prisma.$queryRaw<Array<{
      earliestDate: Date,
      latestDate: Date
    }>>`
      SELECT 
        MIN(DATE("firstActivityAt")) as "earliestDate",
        MAX(DATE("firstActivityAt")) as "latestDate"
      FROM "User" 
      WHERE "firstActivityAt" IS NOT NULL
    `;
    
    if (!dateRange[0]?.earliestDate) {
      console.log('没有找到用户活动数据');
      return;
    }
    
    const start = startDate || dateRange[0].earliestDate;
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    
    console.log(`生成从 ${start.toISOString().split('T')[0]} 到 ${end.toISOString().split('T')[0]} 的历史数据`);
    
    // Generate stats for each day
    const currentDate = new Date(start);
    while (currentDate <= end) {
      const dateStr = currentDate.toISOString().split('T')[0];
      
      // Calculate cumulative stats up to this date
      const threeMonthsBeforeCurrentDate = new Date(currentDate);
      threeMonthsBeforeCurrentDate.setMonth(threeMonthsBeforeCurrentDate.getMonth() - 3);
      
      const cumulativeStats = await prisma.$queryRaw<Array<{
        totalUsers: bigint,
        activeUsers: bigint,
        totalPages: bigint,
        totalVotes: bigint,
        newUsersToday: bigint,
        newPagesToday: bigint,
        newVotesToday: bigint
      }>>`
        SELECT 
          (SELECT COUNT(*) FROM "User" WHERE DATE("firstActivityAt") <= ${currentDate}) as "totalUsers",
          (SELECT COUNT(*) FROM "User" WHERE "lastActivityAt" IS NOT NULL AND DATE("lastActivityAt") >= ${threeMonthsBeforeCurrentDate} AND DATE("lastActivityAt") <= ${currentDate}) as "activeUsers",
          (SELECT COUNT(*) FROM "Page" WHERE DATE("createdAt") <= ${currentDate}) as "totalPages",
          (SELECT COUNT(*) FROM "Vote" WHERE DATE("timestamp") <= ${currentDate}) as "totalVotes",
          (SELECT COUNT(*) FROM "User" WHERE DATE("firstActivityAt") = ${currentDate}) as "newUsersToday",
          (SELECT COUNT(*) FROM "Page" WHERE DATE("createdAt") = ${currentDate}) as "newPagesToday",
          (SELECT COUNT(*) FROM "Vote" WHERE DATE("timestamp") = ${currentDate}) as "newVotesToday"
      `;
      
      const stats = cumulativeStats[0];
      
      // Only insert if there's some activity on this day
      if (Number(stats.newUsersToday) > 0 || Number(stats.newPagesToday) > 0 || Number(stats.newVotesToday) > 0) {
        await prisma.siteStats.upsert({
          where: { date: currentDate },
          update: {
            totalUsers: Number(stats.totalUsers),
            activeUsers: Number(stats.activeUsers),
            totalPages: Number(stats.totalPages),
            totalVotes: Number(stats.totalVotes),
            newUsersToday: Number(stats.newUsersToday),
            newPagesToday: Number(stats.newPagesToday),
            newVotesToday: Number(stats.newVotesToday)
          },
          create: {
            date: new Date(currentDate),
            totalUsers: Number(stats.totalUsers),
            activeUsers: Number(stats.activeUsers),
            totalPages: Number(stats.totalPages),
            totalVotes: Number(stats.totalVotes),
            newUsersToday: Number(stats.newUsersToday),
            newPagesToday: Number(stats.newPagesToday),
            newVotesToday: Number(stats.newVotesToday)
          }
        });
        
        if (currentDate.getDate() === 1) {
          console.log(`处理月份: ${dateStr} - 用户: ${stats.totalUsers}, 页面: ${stats.totalPages}, 投票: ${stats.totalVotes}`);
        }
      }
      
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    console.log('✅ 历史统计数据生成完成');
    
  } catch (error) {
    console.error('❌ 历史统计数据生成失败:', error);
    throw error;
  }
}