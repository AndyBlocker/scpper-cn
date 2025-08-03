import { PrismaClient } from '@prisma/client';

export async function calculateSiteStatistics(prisma: PrismaClient) {
  console.log('🏗️ 开始计算全站统计数据...');
  
  try {
    // Calculate SCP-CN series statistics
    await calculateScpSeriesStats(prisma);
    
    // Calculate daily site statistics
    await calculateDailySiteStats(prisma);
    
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
    for (const [seriesNumber, data] of seriesData.entries()) {
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
        const sampleNumbers = Array.from(data.numbers).sort((a, b) => a - b);
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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Get total counts
    const totalStats = await prisma.$queryRaw<Array<{
      totalUsers: bigint,
      activeUsers: bigint,
      totalPages: bigint,
      totalVotes: bigint
    }>>`
      SELECT 
        (SELECT COUNT(*) FROM "User") as "totalUsers",
        (SELECT COUNT(*) FROM "User" WHERE "firstActivityAt" IS NOT NULL) as "activeUsers",
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
    const end = new Date();
    
    console.log(`生成从 ${start.toISOString().split('T')[0]} 到 ${end.toISOString().split('T')[0]} 的历史数据`);
    
    // Generate stats for each day
    const currentDate = new Date(start);
    while (currentDate <= end) {
      const dateStr = currentDate.toISOString().split('T')[0];
      
      // Calculate cumulative stats up to this date
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
          (SELECT COUNT(*) FROM "User" WHERE "firstActivityAt" IS NOT NULL AND DATE("firstActivityAt") <= ${currentDate}) as "activeUsers",
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