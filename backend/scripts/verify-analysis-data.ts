#!/usr/bin/env node

/**
 * 验证分析数据的正确性脚本
 * 检查13年跨度的数据处理是否正确
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function verifyAnalysisData() {
  try {
    console.log('📊 开始验证分析数据的正确性...\n');
    
    // 1. 验证时间跨度分析
    console.log('⏰ === 验证时间跨度数据 ===');
    await verifyTimeSpanData();
    
    // 2. 验证用户分布统计
    console.log('\n👥 === 验证用户分布统计 ===');
    await verifyUserDistribution();
    
    // 3. 验证年度和月度里程碑
    console.log('\n🏆 === 验证时间里程碑 ===');
    await verifyTimeMilestones();
    
    // 4. 验证页面创建时间分布
    console.log('\n📄 === 验证页面时间分布 ===');
    await verifyPageTimeDistribution();
    
    // 5. 验证投票时间分布
    console.log('\n🗳️ === 验证投票时间分布 ===');
    await verifyVoteTimeDistribution();
    
    // 6. 验证数据一致性
    console.log('\n✅ === 验证数据一致性 ===');
    await verifyDataConsistency();
    
    console.log('\n🎉 数据验证完成！');
    
  } catch (error) {
    console.error('❌ 验证过程中出错:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 验证时间跨度数据
 */
async function verifyTimeSpanData() {
  // 检查数据库中的时间范围
  const timeSpanStats = await prisma.$queryRaw`
    WITH page_attributions AS (
      SELECT 
        "pageVerId",
        MIN("date") as min_attribution_date
      FROM "Attribution"
      WHERE "date" IS NOT NULL
      GROUP BY "pageVerId"
    ),
    page_revisions AS (
      SELECT 
        "pageVersionId",
        MIN(timestamp) as min_revision_timestamp
      FROM "Revision"
      GROUP BY "pageVersionId"
    )
    SELECT 
      'Pages (Correct Dates)' as table_name,
      MIN(COALESCE(
        pa.min_attribution_date,
        pr.min_revision_timestamp,
        pv."validFrom"
      )) as earliest_date,
      MAX(COALESCE(
        pa.min_attribution_date,
        pr.min_revision_timestamp,
        pv."validFrom"
      )) as latest_date,
      COUNT(*) as total_count
    FROM "Page" p
    INNER JOIN "PageVersion" pv ON p.id = pv."pageId" 
    LEFT JOIN page_attributions pa ON pa."pageVerId" = pv.id
    LEFT JOIN page_revisions pr ON pr."pageVersionId" = pv.id
    WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
    UNION ALL
    SELECT 
      'Users (FirstActivity)' as table_name,
      MIN(u."firstActivityAt") as earliest_date,
      MAX(u."firstActivityAt") as latest_date,
      COUNT(*) as total_count
    FROM "User" u
    WHERE u."firstActivityAt" IS NOT NULL
    UNION ALL
    SELECT 
      'Votes' as table_name,
      MIN(v."timestamp") as earliest_date,
      MAX(v."timestamp") as latest_date,
      COUNT(*) as total_count
    FROM "Vote" v
    WHERE v."timestamp" IS NOT NULL
    UNION ALL
    SELECT 
      'Revisions' as table_name,
      MIN(r."timestamp") as earliest_date,
      MAX(r."timestamp") as latest_date,
      COUNT(*) as total_count
    FROM "Revision" r
    WHERE r."timestamp" IS NOT NULL
  `;
  
  console.log('📅 数据时间跨度分析:');
  (timeSpanStats as any[]).forEach((stat: any) => {
    const earliest = new Date(stat.earliest_date);
    const latest = new Date(stat.latest_date);
    const yearSpan = latest.getFullYear() - earliest.getFullYear();
    console.log(`   ${stat.table_name}: ${earliest.getFullYear()}-${latest.getFullYear()} (${yearSpan}年跨度) - ${stat.total_count}条记录`);
  });
}

/**
 * 验证用户分布统计
 */
async function verifyUserDistribution() {
  // 用户按首次活动年度分布
  const userYearlyDistribution = await prisma.$queryRaw`
    SELECT 
      EXTRACT(YEAR FROM "firstActivityAt") as activity_year,
      COUNT(*) as user_count,
      COUNT(CASE WHEN "lastActivityAt" IS NOT NULL THEN 1 END) as users_with_last_activity
    FROM "User"
    WHERE "firstActivityAt" IS NOT NULL
    GROUP BY EXTRACT(YEAR FROM "firstActivityAt")
    ORDER BY activity_year
  `;
  
  console.log('👤 用户按首次活动年度分布:');
  (userYearlyDistribution as any[]).forEach((stat: any) => {
    console.log(`   ${stat.activity_year}: ${stat.user_count} 首次活动用户, ${stat.users_with_last_activity} 有最后活动记录`);
  });
  
  // 用户活动类型分布
  const activityTypeDistribution = await prisma.$queryRaw`
    SELECT 
      "firstActivityType",
      COUNT(*) as count,
      ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 2) as percentage
    FROM "User"
    WHERE "firstActivityType" IS NOT NULL
    GROUP BY "firstActivityType"
    ORDER BY count DESC
  `;
  
  console.log('🎯 用户首次活动类型分布:');
  (activityTypeDistribution as any[]).forEach((stat: any) => {
    console.log(`   ${stat.firstActivityType}: ${stat.count} 用户 (${stat.percentage}%)`);
  });
}

/**
 * 验证时间里程碑
 */
async function verifyTimeMilestones() {
  // 年度里程碑分布
  const yearlyMilestones = await prisma.$queryRaw`
    SELECT 
      "periodValue" as year,
      "milestoneType",
      "pageTitle",
      "pageRating",
      "pageCreatedAt"
    FROM "TimeMilestones"
    WHERE "period" = 'year'
    ORDER BY "periodValue", "milestoneType"
  `;
  
  console.log('📊 年度里程碑统计:');
  const yearGroups = new Map();
  (yearlyMilestones as any[]).forEach((milestone: any) => {
    if (!yearGroups.has(milestone.year)) {
      yearGroups.set(milestone.year, []);
    }
    yearGroups.get(milestone.year).push(milestone);
  });
  
  for (const [year, milestones] of yearGroups) {
    console.log(`   ${year}年: ${milestones.length} 个里程碑`);
    milestones.forEach((m: any) => {
      if (m.milestoneType === 'first_page') {
        console.log(`     首个页面: "${m.pageTitle}" (评分: ${m.pageRating})`);
      }
    });
  }
  
  // 月度里程碑数量分布
  const monthlyMilestonesCount = await prisma.$queryRaw`
    SELECT 
      COUNT(*) as total_monthly_milestones,
      COUNT(DISTINCT "periodValue") as unique_months,
      MIN("periodValue") as earliest_month,
      MAX("periodValue") as latest_month
    FROM "TimeMilestones"
    WHERE "period" = 'month'
  `;
  
  console.log('📅 月度里程碑统计:');
  (monthlyMilestonesCount as any[]).forEach((stat: any) => {
    console.log(`   总计: ${stat.total_monthly_milestones} 个里程碑`);
    console.log(`   覆盖月份: ${stat.unique_months} 个月 (${stat.earliest_month} 到 ${stat.latest_month})`);
  });
}

/**
 * 验证页面时间分布
 */
async function verifyPageTimeDistribution() {
  // 页面创建的年度分布（使用正确的创建时间逻辑）
  const pageYearlyDistribution = await prisma.$queryRaw`
    WITH page_attributions AS (
      SELECT 
        "pageVerId",
        MIN("date") as min_attribution_date
      FROM "Attribution"
      WHERE "date" IS NOT NULL
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
    )
    SELECT 
      EXTRACT(YEAR FROM created_at) as creation_year,
      COUNT(*) as page_count,
      AVG(rating) as avg_rating,
      COUNT(CASE WHEN rating > 0 THEN 1 END) as positive_rating_count
    FROM page_dates
    WHERE created_at IS NOT NULL 
    GROUP BY EXTRACT(YEAR FROM created_at)
    ORDER BY creation_year
  `;
  
  console.log('📝 页面按年度创建分布:');
  (pageYearlyDistribution as any[]).forEach((stat: any) => {
    console.log(`   ${stat.creation_year}: ${stat.page_count} 页面, 平均评分: ${Number(stat.avg_rating).toFixed(1)}, 正评分: ${stat.positive_rating_count}`);
  });
}

/**
 * 验证投票时间分布
 */
async function verifyVoteTimeDistribution() {
  // 投票的年度分布
  const voteYearlyDistribution = await prisma.$queryRaw`
    SELECT 
      EXTRACT(YEAR FROM v."timestamp") as vote_year,
      COUNT(*) as total_votes,
      SUM(CASE WHEN v."direction" = 1 THEN 1 ELSE 0 END) as upvotes,
      SUM(CASE WHEN v."direction" = -1 THEN 1 ELSE 0 END) as downvotes,
      COUNT(DISTINCT v."userId") as unique_voters
    FROM "Vote" v
    WHERE v."timestamp" IS NOT NULL
    GROUP BY EXTRACT(YEAR FROM v."timestamp")
    ORDER BY vote_year
  `;
  
  console.log('🗳️ 投票按年度分布:');
  (voteYearlyDistribution as any[]).forEach((stat: any) => {
    const totalVotes = Number(stat.total_votes);
    const upvotes = Number(stat.upvotes);
    const downvotes = Number(stat.downvotes);
    const uniqueVoters = Number(stat.unique_voters);
    const upvoteRatio = ((upvotes / totalVotes) * 100).toFixed(1);
    console.log(`   ${stat.vote_year}: ${totalVotes} 票 (↑${upvotes} ↓${downvotes}, ${upvoteRatio}%好评), ${uniqueVoters} 投票者`);
  });
}

/**
 * 验证数据一致性
 */
async function verifyDataConsistency() {
  // 检查各种统计表的数据完整性
  const consistencyChecks = await Promise.all([
    prisma.interestingFacts.count(),
    prisma.timeMilestones.count(),
    prisma.tagRecords.count(),
    prisma.userStats.count(),
    prisma.pageStats.count(),
    prisma.dailyPageAggregates.count(),
    prisma.dailyUserAggregates.count(),
    prisma.dailyVoteAggregates.count(),
  ]);
  
  console.log('🔍 统计表数据完整性检查:');
  const tableNames = [
    'InterestingFacts', 'TimeMilestones', 'TagRecords', 'UserStats',
    'PageStats', 'DailyPageAggregates', 'DailyUserAggregates', 'DailyVoteAggregates'
  ];
  
  consistencyChecks.forEach((count, index) => {
    console.log(`   ${tableNames[index]}: ${count} 条记录`);
  });
  
  // 检查用户统计数据的一致性
  const userStatsConsistency = await prisma.$queryRaw`
    SELECT 
      COUNT(*) as total_users_in_system,
      COUNT(CASE WHEN us."userId" IS NOT NULL THEN 1 END) as users_with_stats,
      COUNT(CASE WHEN u."firstActivityAt" IS NOT NULL THEN 1 END) as users_with_activity
    FROM "User" u
    LEFT JOIN "UserStats" us ON u.id = us."userId"
  `;
  
  console.log('📈 用户数据一致性检查:');
  (userStatsConsistency as any[]).forEach((stat: any) => {
    console.log(`   系统总用户: ${stat.total_users_in_system}`);
    console.log(`   有统计数据的用户: ${stat.users_with_stats}`);
    console.log(`   有活动记录的用户: ${stat.users_with_activity}`);
  });
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  verifyAnalysisData().catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
}