import { PrismaClient } from '@prisma/client';

async function analyzeFragmentParentChildRelationships() {
  const prisma = new PrismaClient();
  
  console.log('🔍 分析Fragment页面的父子关系...\n');
  
  try {
    // 1. 获取所有fragment页面的parentUrl信息
    console.log('=== Fragment页面父子关系统计 ===');
    const fragmentParentStats = await prisma.$queryRaw<Array<{
      total: number;
      hasParent: number;
      noParent: number;
      hasChildren: number;
      noChildren: number;
    }>>`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN "parentUrl" IS NOT NULL THEN 1 END) as "hasParent",
        COUNT(CASE WHEN "parentUrl" IS NULL THEN 1 END) as "noParent",
        COUNT(CASE WHEN "childCount" > 0 THEN 1 END) as "hasChildren",
        COUNT(CASE WHEN "childCount" = 0 OR "childCount" IS NULL THEN 1 END) as "noChildren"
      FROM "PageMetaStaging" 
      WHERE url LIKE '%fragment:%'
    `;
    
    const stats = fragmentParentStats[0];
    console.log(`总Fragment页面数: ${stats.total}`);
    console.log(`有父页面的: ${stats.hasParent} (${((Number(stats.hasParent) / Number(stats.total)) * 100).toFixed(1)}%)`);
    console.log(`无父页面的: ${stats.noParent} (${((Number(stats.noParent) / Number(stats.total)) * 100).toFixed(1)}%)`);
    console.log(`有子页面的: ${stats.hasChildren} (${((Number(stats.hasChildren) / Number(stats.total)) * 100).toFixed(1)}%)`);
    console.log(`无子页面的: ${stats.noChildren} (${((Number(stats.noChildren) / Number(stats.total)) * 100).toFixed(1)}%)`);
    
    console.log('\n=== Fragment页面父页面分析 ===');
    
    // 2. 分析有父页面的fragment
    const fragmentsWithParents = await prisma.$queryRaw<Array<{
      url: string;
      parentUrl: string;
      title: string;
    }>>`
      SELECT url, "parentUrl", title
      FROM "PageMetaStaging" 
      WHERE url LIKE '%fragment:%' AND "parentUrl" IS NOT NULL
      ORDER BY "parentUrl"
      LIMIT 20
    `;
    
    console.log('前20个有父页面的Fragment示例:');
    fragmentsWithParents.forEach(f => {
      console.log(`  ${f.url} -> 父页面: ${f.parentUrl} (标题: ${f.title})`);
    });
    
    // 3. 分析没有父页面的fragment
    console.log('\n=== 无父页面的Fragment分析 ===');
    const orphanFragments = await prisma.$queryRaw<Array<{
      url: string;
      title: string;
      rating: number;
      voteCount: number;
    }>>`
      SELECT url, title, rating, "voteCount"
      FROM "PageMetaStaging" 
      WHERE url LIKE '%fragment:%' AND "parentUrl" IS NULL
      ORDER BY rating DESC NULLS LAST
      LIMIT 15
    `;
    
    console.log('前15个无父页面的Fragment（按评分排序）:');
    orphanFragments.forEach(f => {
      console.log(`  ${f.url} (评分: ${f.rating || 'N/A'}, 投票: ${f.voteCount || 'N/A'}) - ${f.title}`);
    });
    
    // 4. 分析父页面类型分布
    console.log('\n=== Fragment父页面类型分布 ===');
    const parentTypeDistribution = await prisma.$queryRaw<Array<{
      parentPattern: string;
      count: number;
    }>>`
      SELECT 
        CASE 
          WHEN "parentUrl" LIKE '%scp-cn-%' THEN 'SCP-CN页面'
          WHEN "parentUrl" LIKE '%scp-%' AND "parentUrl" NOT LIKE '%scp-cn-%' THEN 'SCP页面'
          WHEN "parentUrl" LIKE '%goi-%' THEN 'GOI页面'
          WHEN "parentUrl" LIKE '%hub%' THEN 'Hub页面'
          WHEN "parentUrl" LIKE '%tale-%' THEN 'Tale页面'
          WHEN "parentUrl" = 'main' THEN '主页'
          ELSE '其他类型'
        END as "parentPattern",
        COUNT(*) as count
      FROM "PageMetaStaging" 
      WHERE url LIKE '%fragment:%' AND "parentUrl" IS NOT NULL
      GROUP BY 1
      ORDER BY count DESC
    `;
    
    parentTypeDistribution.forEach(p => {
      console.log(`  ${p.parentPattern}: ${p.count}个fragment`);
    });
    
    // 5. 检查是否有fragment作为其他页面的父页面
    console.log('\n=== Fragment是否作为其他页面的父页面 ===');
    const fragmentAsParent = await prisma.$queryRaw<Array<{
      count: number;
    }>>`
      SELECT COUNT(*) as count
      FROM "PageMetaStaging" 
      WHERE "parentUrl" LIKE '%fragment:%'
    `;
    
    const fragmentParentCount = Number(fragmentAsParent[0].count);
    console.log(`以Fragment作为父页面的页面数量: ${fragmentParentCount}`);
    
    if (fragmentParentCount > 0) {
      const childrenOfFragments = await prisma.$queryRaw<Array<{
        url: string;
        parentUrl: string;
        title: string;
      }>>`
        SELECT url, "parentUrl", title
        FROM "PageMetaStaging" 
        WHERE "parentUrl" LIKE '%fragment:%'
        LIMIT 10
      `;
      
      console.log('以Fragment作为父页面的页面示例:');
      childrenOfFragments.forEach(c => {
        console.log(`  ${c.url} -> Fragment父页面: ${c.parentUrl} (标题: ${c.title})`);
      });
    }
    
    // 6. 分析Fragment的命名模式
    console.log('\n=== Fragment命名模式分析 ===');
    const namingPatterns = await prisma.$queryRaw<Array<{
      pattern: string;
      count: number;
    }>>`
      SELECT 
        CASE 
          WHEN url ~ 'fragment:[0-9]+-[0-9]+$' THEN '数字-数字模式 (如fragment:123-1)'
          WHEN url ~ 'fragment:scp-cn-[0-9]+-' THEN 'SCP-CN相关模式'
          WHEN url ~ 'fragment:[a-z]+-hub-' THEN 'Hub相关模式'
          WHEN url ~ 'fragment:[0-9]+$' THEN '纯数字模式'
          ELSE '其他模式'
        END as pattern,
        COUNT(*) as count
      FROM "PageMetaStaging" 
      WHERE url LIKE '%fragment:%'
      GROUP BY 1
      ORDER BY count DESC
    `;
    
    namingPatterns.forEach(p => {
      console.log(`  ${p.pattern}: ${p.count}个`);
    });
    
  } catch (error) {
    console.error('分析过程中出错:', error);
  } finally {
    await prisma.$disconnect();
  }
}

analyzeFragmentParentChildRelationships();