import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function analyzeDuplicates() {
  try {
    console.log('🔍 分析SCP-CN编号重复情况...');
    
    // Get all SCP-CN pages with their numbers
    const scpPages = await prisma.$queryRaw<Array<{url: string, title: string, pageId: number}>>`
      SELECT p.url, pv.title, p.id as "pageId"
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND p.url ~ 'scp-cn-[0-9]{3,4}$'
        AND 'scp' = ANY(pv.tags)
        AND '原创' = ANY(pv.tags)
      ORDER BY p.url;
    `;
    
    // Extract numbers and find duplicates
    const numberCount = new Map<number, Array<{url: string, title: string}>>();
    
    for (const page of scpPages) {
      const match = page.url.match(/scp-cn-(\d{3,4})$/);
      if (!match) continue;
      
      const num = parseInt(match[1]);
      if (num < 1) continue;
      
      if (!numberCount.has(num)) {
        numberCount.set(num, []);
      }
      
      numberCount.get(num)!.push({
        url: page.url,
        title: page.title
      });
    }
    
    // Find and display duplicates
    const duplicates = Array.from(numberCount.entries())
      .filter(([num, pages]) => pages.length > 1)
      .sort(([a], [b]) => a - b);
    
    console.log(`\n📊 重复编号分析结果:`);
    console.log(`总编号数: ${numberCount.size}`);
    console.log(`重复编号数: ${duplicates.length}`);
    console.log(`总页面数: ${scpPages.length}`);
    console.log(`重复页面数: ${scpPages.length - numberCount.size}`);
    
    if (duplicates.length > 0) {
      console.log(`\n⚠️  发现的重复编号:`);
      
      duplicates.slice(0, 10).forEach(([num, pages]) => {
        console.log(`\n编号 ${num} (${pages.length}个页面):`);
        pages.forEach((page, index) => {
          console.log(`  ${index + 1}. ${page.url}`);
          console.log(`     "${page.title}"`);
        });
      });
      
      if (duplicates.length > 10) {
        console.log(`\n... 还有 ${duplicates.length - 10} 个重复编号`);
      }
    } else {
      console.log(`\n✅ 没有发现重复编号`);
    }
    
  } catch (error) {
    console.error('❌ 分析失败:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

analyzeDuplicates()
  .then(() => {
    console.log('\n🎉 分析完成!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 分析失败:', error);
    process.exit(1);
  });