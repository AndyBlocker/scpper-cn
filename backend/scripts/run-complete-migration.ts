#!/usr/bin/env node

/**
 * 完整的数据库迁移和系统升级脚本
 * 
 * 使用方法:
 * 1. 确保数据库连接配置正确
 * 2. 运行: npm run migrate:complete 或 node scripts/run-complete-migration.js
 * 
 * 这个脚本将执行：
 * - 数据库schema迁移
 * - 数据回填
 * - 增量分析框架初始化
 * - 全文搜索初始化
 * - 扩展统计生成
 */

import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { IncrementalAnalyzeJob } from '../src/jobs/IncrementalAnalyzeJob.js';
import { SearchService } from '../src/services/SearchService.js';
import { calculateImprovedUserRatings } from '../src/jobs/ImprovedUserRatingJob.js';
import { generateExtendedInterestingStats } from '../src/jobs/ExtendedInterestingStatsJob.js';

const prisma = new PrismaClient({
  log: ['warn', 'error']  // 减少日志输出
});

interface MigrationStep {
  name: string;
  description: string;
  required: boolean;
  execute: () => Promise<void>;
}

async function main() {
  console.log('🚀 开始完整的数据库迁移和系统升级');
  console.log('=====================================');
  console.log('⚠️  重要提醒：');
  console.log('   1. 请确保数据库已备份');
  console.log('   2. 请确保有足够的磁盘空间');
  console.log('   3. 这个过程可能需要较长时间');
  console.log('=====================================\n');

  const startTime = Date.now();
  
  // 定义迁移步骤
  const migrationSteps: MigrationStep[] = [
    {
      name: 'schema_migration',
      description: '应用数据库Schema变更',
      required: true,
      execute: applyDatabaseMigration
    },
    {
      name: 'prisma_generate',
      description: '重新生成Prisma客户端',
      required: true,
      execute: generatePrismaClient
    },
    {
      name: 'verify_migration',
      description: '验证迁移完成',
      required: true,
      execute: verifyMigration
    },
    {
      name: 'initialize_watermarks',
      description: '初始化分析水位线',
      required: true,
      execute: initializeWatermarks
    },
    {
      name: 'backfill_data',
      description: '回填历史数据',
      required: true,
      execute: backfillHistoricalData
    },
    {
      name: 'initialize_search',
      description: '初始化全文搜索索引',
      required: true,
      execute: initializeSearchIndex
    },
    {
      name: 'run_initial_analysis',
      description: '执行初始完整分析',
      required: true,
      execute: runInitialAnalysis
    },
    {
      name: 'generate_extended_stats',
      description: '生成扩展有趣统计',
      required: false,
      execute: generateExtendedStats
    },
    {
      name: 'refresh_materialized_views',
      description: '刷新物化视图',
      required: false,
      execute: refreshMaterializedViews
    },
    {
      name: 'final_verification',
      description: '最终验证',
      required: true,
      execute: finalVerification
    }
  ];

  let completedSteps = 0;
  const totalSteps = migrationSteps.length;

  try {
    for (const step of migrationSteps) {
      const stepStartTime = Date.now();
      
      console.log(`\n📌 步骤 ${completedSteps + 1}/${totalSteps}: ${step.description}`);
      console.log(`   ${step.required ? '必需' : '可选'} | ID: ${step.name}`);
      
      try {
        await step.execute();
        const stepDuration = Date.now() - stepStartTime;
        console.log(`✅ 完成 (耗时: ${formatDuration(stepDuration)})`);
        completedSteps++;
      } catch (error) {
        const stepDuration = Date.now() - stepStartTime;
        console.error(`❌ 失败 (耗时: ${formatDuration(stepDuration)})`);
        console.error(`   错误: ${error.message}`);
        
        if (step.required) {
          console.error(`\n💥 关键步骤失败，迁移终止`);
          throw error;
        } else {
          console.warn(`⚠️ 可选步骤失败，继续执行后续步骤`);
        }
      }
    }

    const totalDuration = Date.now() - startTime;
    console.log('\n🎉 迁移成功完成！');
    console.log('=====================================');
    console.log(`📊 统计信息:`);
    console.log(`   完成步骤: ${completedSteps}/${totalSteps}`);
    console.log(`   总耗时: ${formatDuration(totalDuration)}`);
    console.log('=====================================');

    // 输出系统状态摘要
    await printSystemSummary();

  } catch (error) {
    const totalDuration = Date.now() - startTime;
    console.error('\n💥 迁移失败');
    console.error('=====================================');
    console.error(`错误: ${error.message}`);
    console.error(`完成步骤: ${completedSteps}/${totalSteps}`);
    console.error(`总耗时: ${formatDuration(totalDuration)}`);
    console.error('=====================================');
    
    console.log('\n🔧 问题排查建议:');
    console.log('1. 检查数据库连接和权限');
    console.log('2. 确认磁盘空间充足');
    console.log('3. 查看详细错误日志');
    console.log('4. 联系技术支持');
    
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 应用数据库迁移
 */
async function applyDatabaseMigration() {
  console.log('   正在应用数据库迁移...');
  try {
    execSync('npx prisma migrate deploy', { 
      stdio: 'pipe',
      cwd: process.cwd()
    });
    console.log('   数据库迁移应用成功');
  } catch (error) {
    throw new Error(`数据库迁移失败: ${error.message}`);
  }
}

/**
 * 重新生成Prisma客户端
 */
async function generatePrismaClient() {
  console.log('   正在生成Prisma客户端...');
  try {
    execSync('npx prisma generate', { 
      stdio: 'pipe',
      cwd: process.cwd()
    });
    console.log('   Prisma客户端生成成功');
  } catch (error) {
    throw new Error(`Prisma客户端生成失败: ${error.message}`);
  }
}

/**
 * 验证迁移
 */
async function verifyMigration() {
  console.log('   正在验证迁移结果...');
  
  // 检查关键表是否存在
  const tables = ['AnalysisWatermark', 'SearchIndex', 'PageDailyStats', 'UserDailyStats', 'LeaderboardCache'];
  
  for (const table of tables) {
    try {
      await (prisma as any)[table.toLowerCase()].findFirst();
      console.log(`   ✓ 表 ${table} 验证通过`);
    } catch (error) {
      throw new Error(`表 ${table} 不存在或访问失败: ${error.message}`);
    }
  }
  
  // 检查关键字段
  try {
    await prisma.page.findFirst({
      select: { firstPublishedAt: true }
    });
    console.log('   ✓ Page.firstPublishedAt 字段验证通过');
  } catch (error) {
    throw new Error(`Page.firstPublishedAt 字段不存在: ${error.message}`);
  }
}

/**
 * 初始化水位线
 */
async function initializeWatermarks() {
  console.log('   正在初始化分析水位线...');
  
  const tasks = [
    'page_stats', 'user_stats', 'site_stats', 
    'search_index', 'daily_aggregates', 'materialized_views', 'facts_generation'
  ];
  
  let initializedCount = 0;
  for (const task of tasks) {
    await prisma.analysisWatermark.upsert({
      where: { task },
      create: {
        task,
        lastRunAt: new Date(),
        cursorTs: null
      },
      update: {
        lastRunAt: new Date()
      }
    });
    initializedCount++;
  }
  
  console.log(`   初始化了 ${initializedCount} 个分析任务水位线`);
}

/**
 * 回填历史数据
 */
async function backfillHistoricalData() {
  console.log('   正在回填历史数据...');
  
  // 回填Page.firstPublishedAt
  const nullCount = await prisma.page.count({
    where: { firstPublishedAt: null }
  });
  
  if (nullCount > 0) {
    console.log(`   需要回填 ${nullCount} 个页面的创建时间`);
    
    const batchSize = 500;
    const batches = Math.ceil(nullCount / batchSize);
    
    for (let i = 0; i < batches; i++) {
      await prisma.$executeRaw`
        UPDATE "Page" 
        SET "firstPublishedAt" = subq.earliest_date
        FROM (
          SELECT 
            p.id,
            COALESCE(
              MIN(a.date),
              MIN(r."timestamp"),
              MIN(pv."validFrom"),
              p."createdAt"
            ) AS earliest_date
          FROM "Page" p
          LEFT JOIN "PageVersion" pv ON pv."pageId" = p.id
          LEFT JOIN "Attribution" a ON a."pageVerId" = pv.id
          LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
          WHERE p."firstPublishedAt" IS NULL
          GROUP BY p.id, p."createdAt"
          LIMIT ${batchSize}
        ) subq
        WHERE "Page".id = subq.id AND "Page"."firstPublishedAt" IS NULL
      `;
      
      if (i % 10 === 0) {
        console.log(`   回填进度: ${Math.min((i + 1) * batchSize, nullCount)}/${nullCount}`);
      }
    }
  }
  
  console.log('   历史数据回填完成');
}

/**
 * 初始化搜索索引
 */
async function initializeSearchIndex() {
  console.log('   正在初始化搜索索引...');
  
  const searchService = new SearchService(prisma);
  
  const totalPages = await prisma.page.count();
  const indexedPages = await prisma.searchIndex.count();
  
  console.log(`   总页面数: ${totalPages}, 已索引: ${indexedPages}`);
  
  if (indexedPages < totalPages) {
    await searchService.syncPagesToSearchIndex();
    
    const stats = await searchService.getSearchStats();
    console.log(`   搜索索引初始化完成，索引页面数: ${stats.totalIndexedPages}`);
  } else {
    console.log('   搜索索引已是最新');
  }
}

/**
 * 执行初始分析
 */
async function runInitialAnalysis() {
  console.log('   正在执行初始完整分析...');
  
  const analyzer = new IncrementalAnalyzeJob(prisma);
  
  // 执行所有分析任务
  await analyzer.analyze({ 
    forceFullAnalysis: true,
    tasks: ['page_stats', 'user_stats', 'site_stats', 'search_index']
  });
  
  // 执行改进版用户评级计算
  await calculateImprovedUserRatings(prisma);
  
  console.log('   初始分析完成');
}

/**
 * 生成扩展统计
 */
async function generateExtendedStats() {
  console.log('   正在生成扩展有趣统计...');
  
  const summary = await generateExtendedInterestingStats(prisma);
  const totalStats = summary.reduce((sum, item) => sum + item.count, 0);
  
  console.log(`   生成了 ${totalStats} 项扩展统计，涵盖 ${summary.length} 个类别`);
}

/**
 * 刷新物化视图
 */
async function refreshMaterializedViews() {
  console.log('   正在刷新物化视图...');
  
  try {
    await prisma.$executeRaw`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_pages_30d`;
    console.log('   物化视图刷新成功');
  } catch (error) {
    // 物化视图刷新失败通常不是致命错误
    console.log('   物化视图刷新跳过（可能数据量不足）');
  }
}

/**
 * 最终验证
 */
async function finalVerification() {
  console.log('   正在执行最终验证...');
  
  const stats = await prisma.$queryRaw<Array<{
    total_pages: bigint;
    pages_with_stats: bigint;
    total_users: bigint;
    users_with_stats: bigint;
    indexed_pages: bigint;
    watermarks: bigint;
  }>>`
    SELECT 
      (SELECT COUNT(*) FROM "Page") as total_pages,
      (SELECT COUNT(*) FROM "PageStats") as pages_with_stats,
      (SELECT COUNT(*) FROM "User") as total_users,
      (SELECT COUNT(*) FROM "UserStats") as users_with_stats,
      (SELECT COUNT(*) FROM "SearchIndex") as indexed_pages,
      (SELECT COUNT(*) FROM "AnalysisWatermark") as watermarks
  `;
  
  const result = stats[0];
  
  // 验证覆盖率
  const pagesCoverage = Number(result.pages_with_stats) / Number(result.total_pages);
  const indexCoverage = Number(result.indexed_pages) / Number(result.total_pages);
  
  console.log('   数据覆盖率验证:');
  console.log(`   页面统计覆盖率: ${(pagesCoverage * 100).toFixed(1)}%`);
  console.log(`   搜索索引覆盖率: ${(indexCoverage * 100).toFixed(1)}%`);
  
  if (pagesCoverage < 0.5 || indexCoverage < 0.5) {
    throw new Error('数据覆盖率过低，可能存在问题');
  }
  
  console.log('   最终验证通过');
}

/**
 * 打印系统状态摘要
 */
async function printSystemSummary() {
  console.log('\n📊 系统状态摘要:');
  
  const analyzer = new IncrementalAnalyzeJob(prisma);
  const analysisStats = await analyzer.getAnalysisStats();
  
  console.log('🔍 分析系统状态:');
  for (const watermark of analysisStats.watermarks) {
    console.log(`   ${watermark.task}: ${watermark.lastRunAt.toLocaleString()}`);
  }
  
  console.log('\n📈 数据统计:');
  const stats = analysisStats.statistics;
  console.log(`   页面总数: ${stats.pages}`);
  console.log(`   用户总数: ${stats.users}`);
  console.log(`   投票总数: ${stats.votes}`);
  console.log(`   已分析页面: ${stats.analyzed_pages}`);
  console.log(`   已分析用户: ${stats.analyzed_users}`);
  console.log(`   已索引页面: ${stats.indexed_pages}`);
}

/**
 * 格式化持续时间
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

/**
 * 错误处理
 */
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// 信号处理
process.on('SIGINT', async () => {
  console.log('\n⏹️ 收到中断信号，正在清理...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n⏹️ 收到终止信号，正在清理...');
  await prisma.$disconnect();
  process.exit(0);
});

// 执行主函数
main().catch((error) => {
  console.error('💥 迁移脚本执行失败:', error);
  process.exit(1);
});