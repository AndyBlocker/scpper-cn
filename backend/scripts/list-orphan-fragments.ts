import { PrismaClient } from '@prisma/client';
import { table } from 'table';

async function listOrphanFragments() {
  const prisma = new PrismaClient();
  
  console.log('🔍 查找所有没有父页面的Fragment页面\n');
  
  try {
    // 获取所有没有父页面的fragment
    const orphanFragments = await prisma.$queryRaw<Array<{
      url: string;
      title: string;
      rating: number | null;
      voteCount: number | null;
      tags: string[] | null;
      wikidotId: number | null;
      revisionCount: number | null;
      isDeleted: boolean | null;
    }>>`
      SELECT 
        url, 
        title, 
        rating, 
        "voteCount", 
        tags, 
        "wikidotId",
        "revisionCount",
        "isDeleted"
      FROM "PageMetaStaging" 
      WHERE url LIKE '%fragment:%' 
        AND ("parentUrl" IS NULL OR "parentUrl" = '')
      ORDER BY "voteCount" DESC NULLS LAST, rating DESC NULLS LAST
    `;

    console.log(`=== 找到 ${orphanFragments.length} 个没有父页面的Fragment ===\n`);

    if (orphanFragments.length === 0) {
      console.log('✅ 所有Fragment页面都有父页面！');
      return;
    }

    // 创建表格数据
    const tableData = [
      ['#', 'URL (简化)', '标题', '评分', '投票数', '修订数', '已删除', '主要标签']
    ];

    orphanFragments.forEach((fragment, index) => {
      const shortUrl = fragment.url.replace('http://scp-wiki-cn.wikidot.com/', '');
      const mainTags = fragment.tags 
        ? fragment.tags.filter(tag => !['段落'].includes(tag)).slice(0, 3).join(', ')
        : 'N/A';
      
      tableData.push([
        (index + 1).toString(),
        shortUrl,
        fragment.title || 'N/A',
        fragment.rating?.toString() || 'N/A',
        fragment.voteCount?.toString() || 'N/A',
        fragment.revisionCount?.toString() || 'N/A',
        fragment.isDeleted ? '是' : '否',
        mainTags || '仅段落'
      ]);
    });

    console.log(table(tableData, {
      columnDefault: {
        width: 20,
        wrapWord: true
      },
      columns: [
        { width: 3, alignment: 'center' },  // #
        { width: 35 },                      // URL
        { width: 25 },                      // 标题
        { width: 6, alignment: 'center' },  // 评分
        { width: 6, alignment: 'center' },  // 投票
        { width: 6, alignment: 'center' },  // 修订
        { width: 6, alignment: 'center' },  // 删除
        { width: 20 }                       // 标签
      ]
    }));

    // 分析统计
    console.log('\n=== 统计分析 ===');
    const hasRating = orphanFragments.filter(f => f.rating !== null && f.rating !== 0).length;
    const hasVotes = orphanFragments.filter(f => f.voteCount !== null && f.voteCount > 0).length;
    const isDeleted = orphanFragments.filter(f => f.isDeleted).length;
    const hasWikidotId = orphanFragments.filter(f => f.wikidotId !== null).length;

    console.log(`• 有评分的: ${hasRating} (${((hasRating / orphanFragments.length) * 100).toFixed(1)}%)`);
    console.log(`• 有投票的: ${hasVotes} (${((hasVotes / orphanFragments.length) * 100).toFixed(1)}%)`);
    console.log(`• 已删除的: ${isDeleted} (${((isDeleted / orphanFragments.length) * 100).toFixed(1)}%)`);
    console.log(`• 有WikidotID的: ${hasWikidotId} (${((hasWikidotId / orphanFragments.length) * 100).toFixed(1)}%)`);

    // 按模式分组
    console.log('\n=== 按命名模式分组 ===');
    const patterns = new Map<string, string[]>();
    
    orphanFragments.forEach(fragment => {
      const url = fragment.url;
      let pattern = '其他';
      
      if (url.includes('scp-cn-')) {
        pattern = 'SCP-CN相关';
      } else if (url.includes('mercuresphere')) {
        pattern = 'Mercuresphere系列';
      } else if (url.includes('meerkat')) {
        pattern = 'Meerkat系列';
      } else if (url.includes('adult-')) {
        pattern = 'Adult页面';
      } else if (url.match(/fragment:[0-9]+-/)) {
        pattern = '数字编号';
      }
      
      if (!patterns.has(pattern)) {
        patterns.set(pattern, []);
      }
      patterns.get(pattern)!.push(url.replace('http://scp-wiki-cn.wikidot.com/', ''));
    });

    Array.from(patterns.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .forEach(([pattern, urls]) => {
        console.log(`• ${pattern}: ${urls.length}个`);
        if (urls.length <= 5) {
          urls.forEach(url => console.log(`  - ${url}`));
        } else {
          urls.slice(0, 3).forEach(url => console.log(`  - ${url}`));
          console.log(`  ... 还有${urls.length - 3}个`);
        }
      });

    // 建议可能的父页面
    console.log('\n=== 可能的父页面建议 ===');
    
    for (const fragment of orphanFragments.slice(0, 10)) {
      const shortUrl = fragment.url.replace('http://scp-wiki-cn.wikidot.com/fragment:', '');
      
      // 尝试推测可能的父页面
      let possibleParents: string[] = [];
      
      if (shortUrl.startsWith('scp-cn-')) {
        const scpNumber = shortUrl.match(/scp-cn-(\d+)/);
        if (scpNumber) {
          possibleParents.push(`scp-cn-${scpNumber[1]}`);
        }
      } else if (shortUrl.includes('mercuresphere')) {
        possibleParents.push('mercuresphere');
      } else if (shortUrl.includes('meerkat')) {
        possibleParents.push('meerkat', 'dr-meerkat-s-stories-dragon');
      }
      
      if (possibleParents.length > 0) {
        console.log(`• ${fragment.url.replace('http://scp-wiki-cn.wikidot.com/', '')}`);
        console.log(`  可能的父页面: ${possibleParents.join(', ')}`);
      }
    }

    // 输出CSV格式的数据（可选）
    console.log('\n=== CSV格式输出 ===');
    console.log('URL,标题,评分,投票数,修订数,WikidotID,已删除,标签');
    orphanFragments.forEach(fragment => {
      const tags = fragment.tags ? fragment.tags.join(';') : '';
      console.log([
        fragment.url,
        `"${fragment.title || ''}"`,
        fragment.rating || '',
        fragment.voteCount || '',
        fragment.revisionCount || '',
        fragment.wikidotId || '',
        fragment.isDeleted ? 'true' : 'false',
        `"${tags}"`
      ].join(','));
    });

  } catch (error) {
    console.error('❌ 脚本执行出错:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  listOrphanFragments().catch(console.error);
}

export { listOrphanFragments };