import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function findUnusedNumbers() {
  try {
    console.log('🔍 查找每个系列未使用的编号...');
    
    // Get all SCP-CN pages with their numbers
    const scpPages = await prisma.$queryRaw<Array<{url: string, title: string}>>`
      SELECT p.url, pv.title
      FROM "Page" p
      INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL 
        AND pv."isDeleted" = false
        AND p.url ~ 'scp-cn-[0-9]{3,4}$'
        AND p.url NOT LIKE '%deleted:%'
        AND '原创' = ANY(pv.tags)  -- Must have 原创 tag
        AND NOT ('待删除' = ANY(pv.tags))  -- Must not have 待删除 tag
        AND NOT ('待刪除' = ANY(pv.tags))  -- Must not have 待刪除 tag (traditional Chinese)
      ORDER BY p.url;
    `;
    
    // Extract used numbers
    const usedNumbers = new Set<number>();
    
    for (const page of scpPages) {
      const match = page.url.match(/scp-cn-(\d{3,4})$/);
      if (!match) continue;
      
      const num = parseInt(match[1]);
      if (num >= 1) {
        usedNumbers.add(num);
      }
    }
    
    console.log(`总共找到 ${usedNumbers.size} 个已使用的编号\n`);
    
    // Check each series for unused numbers
    const series = [
      { num: 1, start: 2, end: 999, name: '系列1' },      // 001 is special, starts from 002
      { num: 2, start: 1000, end: 1999, name: '系列2' },
      { num: 3, start: 2000, end: 2999, name: '系列3' },
      { num: 4, start: 3000, end: 3999, name: '系列4' },
      { num: 5, start: 4000, end: 4999, name: '系列5' }
    ];
    
    for (const seriesInfo of series) {
      const unused = [];
      
      for (let i = seriesInfo.start; i <= seriesInfo.end; i++) {
        if (!usedNumbers.has(i)) {
          unused.push(i);
        }
      }
      
      const totalSlots = seriesInfo.end - seriesInfo.start + 1;
      const usedSlots = totalSlots - unused.length;
      const percentage = (usedSlots / totalSlots * 100).toFixed(1);
      
      console.log(`${seriesInfo.name} (${seriesInfo.start}-${seriesInfo.end}):`);
      console.log(`  已使用: ${usedSlots}/${totalSlots} (${percentage}%)`);
      console.log(`  未使用: ${unused.length} 个编号`);
      
      if (unused.length > 0) {
        const samples = unused.slice(0, 10);
        console.log(`  前${Math.min(10, unused.length)}个未使用编号: ${samples.join(', ')}${unused.length > 10 ? '...' : ''}`);
      } else {
        console.log(`  ⚠️  所有编号已用完!`);
      }
      
      console.log('');
    }
    
    // Check for any unexpected series
    const maxUsed = Math.max(...Array.from(usedNumbers));
    const maxExpectedSeries = Math.floor(maxUsed / 1000) + 1;
    
    if (maxExpectedSeries > 5) {
      console.log(`⚠️  发现超出预期的系列: 最大编号是 ${maxUsed} (系列${maxExpectedSeries})`);
    }
    
  } catch (error) {
    console.error('❌ 查找失败:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

findUnusedNumbers()
  .then(() => {
    console.log('🎉 查找完成!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 查找失败:', error);
    process.exit(1);
  });