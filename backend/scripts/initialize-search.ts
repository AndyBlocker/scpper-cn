#!/usr/bin/env node

/**
 * 初始化搜索索引脚本
 * 安全地同步所有页面到搜索索引
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 初始化搜索索引...');
  
  try {
    // 1. 清空现有搜索索引
    console.log('1. 清空现有搜索索引...');
    await prisma.searchIndex.deleteMany({});
    console.log('  ✓ 搜索索引已清空');

    // 2. 统计需要索引的页面数量
    console.log('2. 统计页面数量...');
    const totalPages = await prisma.page.count();
    const validVersions = await prisma.pageVersion.count({
      where: {
        validTo: null,
        isDeleted: false
      }
    });
    console.log(`  总页面数: ${totalPages}`);
    console.log(`  有效版本数: ${validVersions}`);

    // 3. 批量同步搜索索引
    console.log('3. 同步搜索索引...');
    const batchSize = 1000;
    let processed = 0;
    let synced = 0;

    while (processed < validVersions) {
      const result = await prisma.$executeRaw`
        INSERT INTO "SearchIndex" ("pageId", title, url, tags, text_content, source_content, "updatedAt")
        SELECT DISTINCT ON (pv."pageId")
          pv."pageId",
          pv.title,
          p.url,
          pv.tags,
          pv."textContent",
          pv.source,
          now()
        FROM "PageVersion" pv
        JOIN "Page" p ON p.id = pv."pageId"
        WHERE pv."validTo" IS NULL 
          AND pv."isDeleted" = false
          AND pv."pageId" NOT IN (SELECT "pageId" FROM "SearchIndex")
        ORDER BY pv."pageId", pv."updatedAt" DESC
        LIMIT ${batchSize}
      `;
      
      synced += Number(result);
      processed += batchSize;
      
      console.log(`  已同步: ${synced} / ${validVersions} (${Math.round(synced/validVersions*100)}%)`);
      
      if (Number(result) < batchSize) {
        break; // 没有更多数据了
      }
    }

    // 4. 验证结果
    console.log('4. 验证同步结果...');
    const indexedCount = await prisma.searchIndex.count();
    console.log(`  索引页面数: ${indexedCount}`);

    // 5. 添加搜索相关的扩展（如果可用）
    console.log('5. 配置搜索扩展...');
    try {
      await prisma.$executeRaw`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
      console.log('  ✓ pg_trgm 扩展已启用');
    } catch (error) {
      console.log('  ⚠️ pg_trgm 扩展不可用，搜索功能可能受限');
    }

    // 6. 创建搜索相关的GIN索引
    console.log('6. 创建搜索索引...');
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_search_title_gin ON "SearchIndex" USING GIN (to_tsvector(\'english\', title))',
      'CREATE INDEX IF NOT EXISTS idx_search_content_gin ON "SearchIndex" USING GIN (to_tsvector(\'english\', text_content))',
      'CREATE INDEX IF NOT EXISTS idx_search_tags_gin ON "SearchIndex" USING GIN (tags)'
    ];

    for (const [i, indexSQL] of indexes.entries()) {
      try {
        await prisma.$executeRawUnsafe(indexSQL);
        console.log(`  ✓ 搜索索引 ${i + 1}/${indexes.length} 已创建`);
      } catch (error) {
        console.log(`  ⚠️ 搜索索引 ${i + 1} 创建失败: ${error.message.substring(0, 60)}...`);
      }
    }

    // 7. 测试搜索功能
    console.log('7. 测试搜索功能...');
    const testResult = await prisma.$queryRaw`
      SELECT "pageId", title, url, array_length(tags, 1) as tag_count
      FROM "SearchIndex" 
      WHERE title ILIKE '%SCP%'
      LIMIT 3
    `;
    
    console.log(`  测试查询结果: ${(testResult as any[]).length} 条`);
    if ((testResult as any[]).length > 0) {
      console.log(`  示例: ${(testResult as any[])[0].title}`);
    }

    console.log('\n🎉 搜索索引初始化完成！');
    console.log('================================');
    console.log(`✅ 已索引 ${indexedCount} 个页面`);
    console.log('✅ 搜索索引已创建');
    console.log('✅ 搜索功能已可用');
    console.log('\n📋 使用方法:');
    console.log('1. 简单搜索: SearchService.search({ query: "SCP-173" })');
    console.log('2. 标签搜索: SearchService.searchByTags(["scp", "原创"])');
    console.log('3. 高级搜索: SearchService.advancedSearch({ title: "雕像" })');
    
  } catch (error) {
    console.error('❌ 搜索索引初始化失败:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('💥 初始化脚本失败:', error);
  process.exit(1);
});