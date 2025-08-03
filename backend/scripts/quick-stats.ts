import { PrismaClient } from '@prisma/client';
import { calculateSiteStatistics } from '../src/jobs/SiteStatsJob.js';

const prisma = new PrismaClient();

async function quickStats() {
  try {
    console.log('🚀 快速生成统计数据...');
    
    await calculateSiteStatistics(prisma);
    
    console.log('✅ 统计数据生成完成!');
    
  } catch (error) {
    console.error('❌ 统计数据生成失败:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

quickStats()
  .then(() => {
    console.log('🎉 完成!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 失败:', error);
    process.exit(1);
  });