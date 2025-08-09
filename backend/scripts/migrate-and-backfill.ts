import { PrismaClient } from '@prisma/client';
import { IncrementalAnalyzeJob } from '../src/jobs/IncrementalAnalyzeJob.js';
import { SearchService } from '../src/services/SearchService.js';
import { calculateImprovedUserRatings } from '../src/jobs/ImprovedUserRatingJob.js';

/**
 * 数据库迁移和回填脚本
 * 基于 reply.md 文档的完整重构方案
 * 安全地迁移现有数据到新的架构
 */

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 开始数据库迁移和回填...');
  console.log('⚠️  请确保已经运行了数据库迁移: 20250808000000_database_optimization_and_search');
  
  try {
    // 步骤1：验证迁移是否已执行
    await verifyMigration();
    
    // 步骤2：初始化水位线
    await initializeWatermarks();
    
    // 步骤3：回填Page.firstPublishedAt
    await backfillPageFirstPublishedAt();
    
    // 步骤4：初始化SearchIndex
    await initializeSearchIndex();
    
    // 步骤5：生成历史统计数据
    await generateHistoricalStats();
    
    // 步骤6：执行一次完整的增量分析
    await performInitialAnalysis();
    
    // 步骤7：验证数据完整性
    await verifyDataIntegrity();
    
    console.log('✅ 数据库迁移和回填完成！');
    
  } catch (error) {
    console.error('❌ 迁移失败:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 验证迁移是否已执行
 */
async function verifyMigration() {
  console.log('🔍 验证数据库迁移状态...');
  
  try {
    // 检查新表是否存在
    await prisma.analysisWatermark.findFirst();
    await prisma.searchIndex.findFirst();
    console.log('✅ 迁移验证通过');
  } catch (error) {
    console.error('❌ 迁移验证失败。请先运行数据库迁移');
    throw new Error('Database migration not applied. Please run: npx prisma migrate deploy');
  }
}

/**
 * 初始化水位线
 */
async function initializeWatermarks() {
  console.log('🔖 初始化分析水位线...');
  
  const tasks = [
    'page_stats',
    'user_stats',
    'site_stats',
    'search_index',
    'daily_aggregates',
    'materialized_views',
    'facts_generation'
  ];
  
  for (const task of tasks) {
    await prisma.analysisWatermark.upsert({
      where: { task },
      create: {
        task,
        lastRunAt: new Date(),
        cursorTs: null // 初始状态为null，表示需要全量处理
      },
      update: {
        lastRunAt: new Date()
      }
    });
  }
  
  console.log(`✅ 初始化了 ${tasks.length} 个分析任务水位线`);
}

/**
 * 回填Page.firstPublishedAt字段
 */
async function backfillPageFirstPublishedAt() {
  console.log('📅 回填页面创建时间...');
  
  // 获取需要回填的页面数量
  const { count } = await prisma.page.aggregate({
    where: { firstPublishedAt: null },
    _count: true
  });
  
  if (count === 0) {
    console.log('⏭️ 所有页面的创建时间已填充，跳过回填');
    return;
  }
  
  console.log(`📊 需要回填 ${count} 个页面的创建时间`);
  
  // 分批处理，避免长时间锁表
  const batchSize = 500;
  const totalBatches = Math.ceil(count / batchSize);
  
  for (let i = 0; i < totalBatches; i++) {
    const offset = i * batchSize;
    
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
        ORDER BY p.id
        LIMIT ${batchSize}
        OFFSET ${offset}
      ) subq
      WHERE "Page".id = subq.id AND "Page"."firstPublishedAt" IS NULL
    `;
    
    if (i % 10 === 0) {
      console.log(`⏳ 回填进度: ${Math.min((i + 1) * batchSize, count)}/${count} (${Math.round(((i + 1) / totalBatches) * 100)}%)`);
    }
  }
  
  // 验证回填结果
  const { count: remainingNull } = await prisma.page.aggregate({
    where: { firstPublishedAt: null },
    _count: true
  });
  
  console.log(`✅ 页面创建时间回填完成，剩余未填充: ${remainingNull}`);
}

/**
 * 初始化搜索索引
 */
async function initializeSearchIndex() {
  console.log('🔍 初始化搜索索引...');
  
  const searchService = new SearchService(prisma);
  
  // 获取需要索引的页面数量
  const totalPages = await prisma.page.count();
  const indexedPages = await prisma.searchIndex.count();
  
  console.log(`📊 总页面数: ${totalPages}, 已索引页面数: ${indexedPages}`);
  
  if (indexedPages === totalPages) {
    console.log('⏭️ 搜索索引已是最新，跳过初始化');
    return;
  }
  
  // 批量同步所有页面到搜索索引
  await searchService.syncPagesToSearchIndex();
  
  // 获取统计信息
  const stats = await searchService.getSearchStats();
  console.log('📈 搜索索引统计:');
  console.log(`  索引页面数: ${stats.totalIndexedPages}`);
  console.log(`  有标题页面: ${stats.pagesWithTitle}`);
  console.log(`  有内容页面: ${stats.pagesWithContent}`);
  console.log(`  有源码页面: ${stats.pagesWithSource}`);
  console.log(`  平均标签数: ${stats.avgTagsPerPage?.toFixed(2) || '0'}`);
  
  console.log('✅ 搜索索引初始化完成');
}

/**
 * 生成历史统计数据
 */
async function generateHistoricalStats() {
  console.log('📊 生成历史统计数据...');
  
  // 生成近30天的日聚合数据
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  console.log('📅 生成近30天的页面日聚合数据...');
  
  // 获取有投票活动的日期
  const activeDays = await prisma.$queryRaw<Array<{ date: Date; vote_count: bigint }>>`
    SELECT date(v."timestamp") as date, COUNT(*) as vote_count
    FROM "Vote" v
    WHERE v."timestamp" >= ${thirtyDaysAgo}
    GROUP BY date(v."timestamp")
    ORDER BY date
  `;
  
  for (const { date } of activeDays) {
    // 生成该日期的PageDailyStats
    await prisma.$executeRaw`
      INSERT INTO "PageDailyStats" ("pageId", date, votes_up, votes_down, total_votes, unique_voters, revisions)
      SELECT 
        p.id as "pageId",
        ${date}::date as date,
        COUNT(v.id) FILTER (WHERE v.direction = 1) as votes_up,
        COUNT(v.id) FILTER (WHERE v.direction = -1) as votes_down,
        COUNT(v.id) FILTER (WHERE v.direction != 0) as total_votes,
        COUNT(DISTINCT v."userId") FILTER (WHERE v."userId" IS NOT NULL) as unique_voters,
        COALESCE(r_count.revisions, 0) as revisions
      FROM "Page" p
      JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL AND pv."isDeleted" = false
      LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id AND date(v."timestamp") = ${date}::date
      LEFT JOIN (
        SELECT pv2."pageId", COUNT(r.id) as revisions
        FROM "Revision" r
        JOIN "PageVersion" pv2 ON r."pageVersionId" = pv2.id
        WHERE date(r."timestamp") = ${date}::date
        GROUP BY pv2."pageId"
      ) r_count ON r_count."pageId" = p.id
      GROUP BY p.id, r_count.revisions
      HAVING COUNT(v.id) > 0 OR COALESCE(r_count.revisions, 0) > 0
      ON CONFLICT ("pageId", date) DO UPDATE SET
        votes_up = EXCLUDED.votes_up,
        votes_down = EXCLUDED.votes_down,
        total_votes = EXCLUDED.total_votes,
        unique_voters = EXCLUDED.unique_voters,
        revisions = EXCLUDED.revisions
    `;

    // 生成该日期的UserDailyStats
    await prisma.$executeRaw`
      INSERT INTO "UserDailyStats" ("userId", date, votes_cast, pages_created, last_activity)
      SELECT 
        u.id as "userId",
        ${date}::date as date,
        COUNT(v.id) as votes_cast,
        COALESCE(p_count.pages_created, 0) as pages_created,
        MAX(GREATEST(
          COALESCE(v."timestamp", '1900-01-01'::timestamp),
          COALESCE(r."timestamp", '1900-01-01'::timestamp),
          COALESCE(a."date", '1900-01-01'::timestamp)
        )) as last_activity
      FROM "User" u
      LEFT JOIN "Vote" v ON v."userId" = u.id AND date(v."timestamp") = ${date}::date
      LEFT JOIN "Revision" r ON r."userId" = u.id AND date(r."timestamp") = ${date}::date
      LEFT JOIN "Attribution" a ON a."userId" = u.id AND date(a."date") = ${date}::date
      LEFT JOIN (
        SELECT a2."userId", COUNT(DISTINCT pv."pageId") as pages_created
        FROM "Attribution" a2
        JOIN "PageVersion" pv ON a2."pageVerId" = pv.id
        JOIN "Page" p ON pv."pageId" = p.id
        WHERE date(COALESCE(p."firstPublishedAt", p."createdAt")) = ${date}::date
          AND a2.type = 'author'
        GROUP BY a2."userId"
      ) p_count ON p_count."userId" = u.id
      WHERE v.id IS NOT NULL OR r.id IS NOT NULL OR a.id IS NOT NULL
      GROUP BY u.id, p_count.pages_created
      ON CONFLICT ("userId", date) DO UPDATE SET
        votes_cast = EXCLUDED.votes_cast,
        pages_created = EXCLUDED.pages_created,
        last_activity = EXCLUDED.last_activity
    `;
  }
  
  console.log(`✅ 生成了 ${activeDays.length} 天的历史聚合数据`);
  
  // 生成站点统计
  console.log('🌐 生成站点统计数据...');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  await prisma.$executeRaw`
    INSERT INTO "SiteStats" (date, "totalUsers", "activeUsers", "totalPages", "totalVotes", "newUsersToday", "newPagesToday", "newVotesToday")
    SELECT 
      ${today}::date as date,
      (SELECT COUNT(*) FROM "User") as "totalUsers",
      (SELECT COUNT(*) FROM "User" WHERE "firstActivityAt" IS NOT NULL) as "activeUsers",
      (SELECT COUNT(*) FROM "Page") as "totalPages",
      (SELECT COUNT(*) FROM "Vote") as "totalVotes",
      (SELECT COUNT(*) FROM "User" WHERE date("firstActivityAt") = ${today}::date) as "newUsersToday",
      (SELECT COUNT(*) FROM "Page" WHERE date("firstPublishedAt") = ${today}::date) as "newPagesToday",
      (SELECT COUNT(*) FROM "Vote" WHERE date("timestamp") = ${today}::date) as "newVotesToday"
    ON CONFLICT (date) DO UPDATE SET
      "totalUsers" = EXCLUDED."totalUsers",
      "activeUsers" = EXCLUDED."activeUsers",
      "totalPages" = EXCLUDED."totalPages",
      "totalVotes" = EXCLUDED."totalVotes",
      "newUsersToday" = EXCLUDED."newUsersToday",
      "newPagesToday" = EXCLUDED."newPagesToday",
      "newVotesToday" = EXCLUDED."newVotesToday",
      "updatedAt" = now()
  `;
  
  console.log('✅ 历史统计数据生成完成');
}

/**
 * 执行初始完整分析
 */
async function performInitialAnalysis() {
  console.log('🔄 执行初始完整分析...');
  
  const analyzer = new IncrementalAnalyzeJob(prisma);
  
  // 强制全量分析所有任务
  await analyzer.analyze({ 
    forceFullAnalysis: true,
    tasks: ['page_stats', 'user_stats', 'site_stats', 'search_index']
  });
  
  // 执行改进版用户评级计算
  await calculateImprovedUserRatings(prisma);
  
  // 刷新物化视图
  try {
    await prisma.$executeRaw`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_pages_30d`;
    console.log('✅ 物化视图刷新完成');
  } catch (error) {
    console.warn('⚠️ 物化视图刷新失败，可能是数据量不足:', error.message);
  }
  
  console.log('✅ 初始分析完成');
}

/**
 * 验证数据完整性
 */
async function verifyDataIntegrity() {
  console.log('🔍 验证数据完整性...');
  
  // 验证统计信息
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
  
  console.log('📊 数据完整性报告:');
  console.log(`  总页面数: ${result.total_pages}`);
  console.log(`  已分析页面数: ${result.pages_with_stats}`);
  console.log(`  总用户数: ${result.total_users}`);
  console.log(`  已分析用户数: ${result.users_with_stats}`);
  console.log(`  已索引页面数: ${result.indexed_pages}`);
  console.log(`  水位线任务数: ${result.watermarks}`);
  
  // 验证关键指标
  const pagesCoverage = Number(result.pages_with_stats) / Number(result.total_pages);
  const usersCoverage = Number(result.users_with_stats) / Number(result.total_users);
  const indexCoverage = Number(result.indexed_pages) / Number(result.total_pages);
  
  console.log('📈 覆盖率统计:');
  console.log(`  页面统计覆盖率: ${(pagesCoverage * 100).toFixed(1)}%`);
  console.log(`  用户统计覆盖率: ${(usersCoverage * 100).toFixed(1)}%`);
  console.log(`  搜索索引覆盖率: ${(indexCoverage * 100).toFixed(1)}%`);
  
  if (pagesCoverage < 0.8 || indexCoverage < 0.8) {
    console.warn('⚠️ 数据覆盖率较低，请检查分析流程');
  } else {
    console.log('✅ 数据完整性验证通过');
  }
}

/**
 * 错误处理和恢复
 */
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// 执行主函数
main()
  .then(() => {
    console.log('🎉 迁移和回填脚本执行完成！');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 迁移和回填脚本失败:', error);
    process.exit(1);
  });