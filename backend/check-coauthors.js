import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkCoauthors() {
  const pageUrl = process.argv[2];
  
  if (!pageUrl) {
    console.log('使用方法: node check-coauthors.js <page-url>');
    console.log('例如: node check-coauthors.js http://scp-wiki-cn.wikidot.com/scp-cn-3301');
    process.exit(1);
  }
  
  console.log('🔍 检查合著者信息');
  console.log('='.repeat(80));
  console.log(`📋 页面URL: ${pageUrl}`);
  console.log('='.repeat(80));
  
  try {
    // 1. 获取页面基本信息
    const page = await prisma.page.findUnique({
      where: { url: pageUrl },
      select: {
        title: true,
        rating: true,
        voteCount: true,
        createdByUser: true,
        createdByWikidotId: true,
        tags: true
      }
    });
    
    if (!page) {
      console.log('❌ 页面不存在于数据库中');
      process.exit(1);
    }
    
    console.log('\n📊 页面基本信息:');
    console.log(`   标题: ${page.title}`);
    console.log(`   评分: ${page.rating}`);
    console.log(`   投票数: ${page.voteCount}`);
    console.log(`   创建者: ${page.createdByUser} (ID: ${page.createdByWikidotId})`);
    console.log(`   标签: ${page.tags?.join(', ') || '无'}`);
    
    // 2. 获取合著者信息
    const attributions = await prisma.attribution.findMany({
      where: { pageUrl: pageUrl },
      orderBy: { orderIndex: 'asc' }
    });
    
    console.log('\n👥 合著者信息:');
    
    if (attributions.length === 0) {
      console.log('   没有合著者记录');
    } else {
      console.log(`   发现 ${attributions.length} 条合著者记录:`);
      console.log(`   ${'类型'.padEnd(12)} ${'用户名'.padEnd(20)} ${'用户ID'.padEnd(10)} ${'Unix名'.padEnd(15)} ${'日期'.padEnd(12)} ${'顺序'}`);
      console.log('   ' + '-'.repeat(85));
      
      attributions.forEach((attr, index) => {
        const type = attr.attributionType || '未知';
        const userName = attr.userName || '未知用户';
        const userId = attr.userId || 'N/A';
        const unixName = attr.userUnixName || 'N/A';
        const date = attr.date ? attr.date.toISOString().substring(0, 10) : '未知';
        const order = attr.orderIndex || 0;
        
        console.log(`   ${type.padEnd(12)} ${userName.padEnd(20)} ${userId.padEnd(10)} ${unixName.padEnd(15)} ${date.padEnd(12)} #${order}`);
      });
      
      // 统计贡献类型
      const typeStats = {};
      attributions.forEach(attr => {
        const type = attr.attributionType || '未知';
        typeStats[type] = (typeStats[type] || 0) + 1;
      });
      
      console.log(`\n   贡献类型统计:`);
      Object.entries(typeStats).forEach(([type, count]) => {
        console.log(`   📝 ${type}: ${count}条`);
      });
      
      // 检查特定用户
      const targetUsers = ['silverIce', 'ColorlessL'];
      console.log(`\n🎯 检查目标用户:`);
      
      targetUsers.forEach(targetUser => {
        const userAttribution = attributions.find(attr => 
          attr.userName === targetUser || 
          attr.userUnixName === targetUser.toLowerCase()
        );
        
        if (userAttribution) {
          console.log(`   ✅ ${targetUser}: 找到 (${userAttribution.attributionType}, 顺序 #${userAttribution.orderIndex})`);
        } else {
          console.log(`   ❌ ${targetUser}: 未找到`);
        }
      });
    }
    
  } catch (error) {
    console.error(`❌ 检查失败: ${error.message}`);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

checkCoauthors().catch(console.error);