#!/usr/bin/env node

/**
 * 强制运行全量统计分析脚本
 * 
 * 这个脚本会：
 * 1. 清空 InterestingFacts 表以强制全量模式
 * 2. 清空 SiteStats 表以强制全量站点统计
 * 3. 运行完整的分析过程
 */

import { PrismaClient } from '@prisma/client';
import { analyze } from '../src/jobs/AnalyzeJob.js';

const prisma = new PrismaClient();

async function forceFullAnalysis() {
  try {
    console.log('🚀 开始强制全量统计分析...');
    
    // 步骤1: 清空InterestingFacts表以强制全量模式
    console.log('🧹 清空InterestingFacts表以触发全量模式...');
    const factsCount = await prisma.interestingFacts.count();
    console.log(`   当前InterestingFacts记录数: ${factsCount}`);
    
    await prisma.interestingFacts.deleteMany({});
    console.log('   ✅ InterestingFacts表已清空');
    
    // 步骤2: 清空SiteStats表以强制全量站点统计
    console.log('🧹 清空SiteStats表以触发全量站点统计...');
    const siteStatsCount = await prisma.siteStats.count();
    console.log(`   当前SiteStats记录数: ${siteStatsCount}`);
    
    await prisma.siteStats.deleteMany({});
    console.log('   ✅ SiteStats表已清空');
    
    // 步骤3: 清空其他相关统计表以确保完整重建
    console.log('🧹 清空其他统计表...');
    
    const tablesToClear = [
      { name: 'TimeMilestones', action: () => prisma.timeMilestones.deleteMany({}) },
      { name: 'TagRecords', action: () => prisma.tagRecords.deleteMany({}) },
      { name: 'ContentRecords', action: () => prisma.contentRecords.deleteMany({}) },
      { name: 'RatingRecords', action: () => prisma.ratingRecords.deleteMany({}) },
      { name: 'UserActivityRecords', action: () => prisma.userActivityRecords.deleteMany({}) },
      { name: 'AuthorAchievements', action: () => prisma.authorAchievements.deleteMany({}) },
      { name: 'SiteMilestones', action: () => prisma.siteMilestones.deleteMany({}) },
      { name: 'TagDetailedStats', action: () => prisma.tagDetailedStats.deleteMany({}) },
      { name: 'DailyVoteAggregates', action: () => prisma.dailyVoteAggregates.deleteMany({}) },
      { name: 'DailyUserAggregates', action: () => prisma.dailyUserAggregates.deleteMany({}) },
      { name: 'DailyPageAggregates', action: () => prisma.dailyPageAggregates.deleteMany({}) },
      { name: 'DailyTagTrends', action: () => prisma.dailyTagTrends.deleteMany({}) }
    ];
    
    for (const table of tablesToClear) {
      try {
        await table.action();
        console.log(`   ✅ ${table.name}表已清空`);
      } catch (error) {
        console.warn(`   ⚠️ 清空${table.name}表失败: ${error.message}`);
      }
    }
    
    console.log('✅ 所有统计表已清空，现在开始全量分析...');
    console.log('=====================================');
    
    // 步骤4: 运行完整的分析过程
    const startTime = Date.now();
    await analyze();
    const endTime = Date.now();
    
    console.log('=====================================');
    console.log(`🎉 全量统计分析完成！耗时: ${((endTime - startTime) / 1000).toFixed(1)}秒`);
    
    // 步骤5: 验证结果
    console.log('📊 验证统计结果...');
    const finalStats = await Promise.all([
      prisma.interestingFacts.count(),
      prisma.timeMilestones.count(),
      prisma.tagRecords.count(),
      prisma.authorAchievements.count(),
      prisma.siteMilestones.count(),
      prisma.siteStats.count()
    ]);
    
    console.log(`📈 最终统计结果:`);
    console.log(`   InterestingFacts: ${finalStats[0]}`);
    console.log(`   TimeMilestones: ${finalStats[1]}`);
    console.log(`   TagRecords: ${finalStats[2]}`);
    console.log(`   AuthorAchievements: ${finalStats[3]}`);
    console.log(`   SiteMilestones: ${finalStats[4]}`);
    console.log(`   SiteStats: ${finalStats[5]}`);
    
  } catch (error) {
    console.error('❌ 全量统计分析失败:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  forceFullAnalysis().catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
}

export { forceFullAnalysis };