import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkScpPages() {
  try {
    console.log('🔍 检查SCP-CN页面格式...');
    
    // Check for pages that might be SCP-CN pages
    const scpCnPages = await prisma.$queryRaw<Array<{url: string, title: string, tags: string[]}>>`
      SELECT p.url, pv.title, pv.tags
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND (
          p.url LIKE 'scp-cn-%' 
          OR p.url LIKE 'scp-%'
        )
        AND 'scp' = ANY(pv.tags)
      ORDER BY p.url
      LIMIT 20;
    `;
    
    console.log(`找到 ${scpCnPages.length} 个SCP页面:`);
    scpCnPages.forEach(page => {
      console.log(`- ${page.url}: "${page.title}" [${page.tags.join(', ')}]`);
    });
    
    // Check specifically for scp-cn pattern with numbers
    const scpCnNumberPages = await prisma.$queryRaw<Array<{url: string, title: string, tags: string[]}>>`
      SELECT p.url, pv.title, pv.tags
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND p.url ~ '^scp-cn-[0-9]+'
      ORDER BY p.url
      LIMIT 10;
    `;
    
    console.log(`\n找到 ${scpCnNumberPages.length} 个SCP-CN编号页面:`);
    scpCnNumberPages.forEach(page => {
      console.log(`- ${page.url}: "${page.title}" [${page.tags.join(', ')}]`);
    });
    
  } catch (error) {
    console.error('❌ 检查失败:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

checkScpPages()
  .then(() => {
    console.log('🎉 检查完成!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 检查失败:', error);
    process.exit(1);
  });