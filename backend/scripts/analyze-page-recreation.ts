#!/usr/bin/env tsx

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function analyzePageRecreation() {
  console.log('🔍 分析页面重建情况...');
  
  // 查找特定的问题页面IDs
  const problemPageIds = [23790, 23615, 21658, 24254, 978];
  
  for (const pageId of problemPageIds) {
    console.log(`\n📄 分析页面 ID ${pageId}:`);
    
    // 查找页面和所有版本
    const page = await prisma.page.findUnique({
      where: { id: pageId },
      include: {
        versions: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });
    
    if (!page) {
      console.log(`❌ 页面 ${pageId} 不存在`);
      continue;
    }
    
    console.log(`  URL: ${page.url}`);
    console.log(`  Page UUID: ${page.pageUuid}`);
    console.log(`  版本历史:`);
    
    // 分析版本历史中的wikidotId变化
    const wikidotIds = new Set();
    page.versions.forEach((version, index) => {
      console.log(`    ${index + 1}. Version ${version.id}:`);
      console.log(`       创建时间: ${version.createdAt}`);
      console.log(`       wikidotId: ${version.wikidotId}`);
      console.log(`       validFrom: ${version.validFrom}`);
      console.log(`       validTo: ${version.validTo}`);
      console.log(`       isDeleted: ${version.isDeleted}`);
      console.log(`       title: ${version.title}`);
      
      if (version.wikidotId) {
        wikidotIds.add(version.wikidotId);
      }
    });
    
    console.log(`  🎯 该页面涉及的wikidotIds: [${Array.from(wikidotIds).join(', ')}]`);
    
    if (wikidotIds.size > 1) {
      console.log(`  ⚠️ 检测到wikidotId变化，可能是页面重建`);
    }
  }
  
  // 统计整体的wikidotId重复情况
  console.log(`\n📊 分析整体wikidotId情况:`);
  
  const wikidotIdStats = await prisma.$queryRaw<Array<{
    wikidotId: number;
    pageCount: number;
    urls: string[];
  }>>`
    SELECT 
      pv."wikidotId",
      COUNT(DISTINCT p.id) as "pageCount",
      ARRAY_AGG(DISTINCT p.url) as urls
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."wikidotId" IS NOT NULL
      AND pv."validTo" IS NULL
    GROUP BY pv."wikidotId"
    HAVING COUNT(DISTINCT p.id) > 1
    ORDER BY "pageCount" DESC
    LIMIT 10
  `;
  
  console.log(`发现 ${wikidotIdStats.length} 个wikidotId对应多个页面:`);
  wikidotIdStats.forEach(stat => {
    console.log(`  wikidotId ${stat.wikidotId}: ${stat.pageCount} 个页面`);
    stat.urls.forEach(url => {
      console.log(`    - ${url}`);
    });
  });
}

analyzePageRecreation()
  .catch(console.error)
  .finally(() => prisma.$disconnect());