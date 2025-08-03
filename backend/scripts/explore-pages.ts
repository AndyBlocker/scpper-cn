import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function explorePages() {
  try {
    console.log('🔍 探索页面数据...');
    
    // Check some sample pages with scp in URL
    const samplePages = await prisma.$queryRaw<Array<{url: string, title: string, tags: string[]}>>`
      SELECT p.url, pv.title, pv.tags
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND p.url LIKE '%scp%'
      ORDER BY p.url
      LIMIT 10;
    `;
    
    console.log(`找到 ${samplePages.length} 个包含scp的页面:`);
    samplePages.forEach(page => {
      console.log(`- ${page.url}: "${page.title}" [${page.tags.join(', ')}]`);
    });
    
    // Check pages with 原创 tag
    const originalPages = await prisma.$queryRaw<Array<{url: string, title: string, tags: string[]}>>`
      SELECT p.url, pv.title, pv.tags
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND '原创' = ANY(pv.tags)
      ORDER BY p.url
      LIMIT 10;
    `;
    
    console.log(`\n找到 ${originalPages.length} 个原创页面:`);
    originalPages.forEach(page => {
      console.log(`- ${page.url}: "${page.title}" [${page.tags.join(', ')}]`);
    });
    
    // Check specific patterns
    const cnPages = await prisma.$queryRaw<Array<{url: string, title: string, tags: string[]}>>`
      SELECT p.url, pv.title, pv.tags
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND p.url LIKE 'scp-cn-%'
      ORDER BY p.url
      LIMIT 5;
    `;
    
    console.log(`\n找到 ${cnPages.length} 个scp-cn-开头的页面:`);
    cnPages.forEach(page => {
      console.log(`- ${page.url}: "${page.title}" [${page.tags.join(', ')}]`);
    });
    
  } catch (error) {
    console.error('❌ 探索失败:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

explorePages()
  .then(() => {
    console.log('🎉 探索完成!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 探索失败:', error);
    process.exit(1);
  });