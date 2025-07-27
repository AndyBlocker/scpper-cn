import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function verifyCoauthors() {
  console.log('🔍 验证合著者功能集成状态');
  console.log('='.repeat(80));
  
  try {
    // 1. 检查数据库中是否有合著者数据
    const totalAttributions = await prisma.attribution.count();
    console.log(`📊 数据库中合著者记录总数: ${totalAttributions}`);
    
    if (totalAttributions === 0) {
      console.log('⚠️  数据库中没有合著者记录，需要运行数据同步');
      console.log('   建议运行: npm run database 或 npm run full');
      return;
    }
    
    // 2. 查找有合著者的页面
    const pagesWithCoauthors = await prisma.page.findMany({
      where: {
        attributions: {
          some: {}
        }
      },
      select: {
        url: true,
        title: true,
        tags: true,
        _count: {
          select: {
            attributions: true
          }
        },
        attributions: {
          select: {
            userName: true,
            userId: true,
            userUnixName: true,
            attributionType: true,
            orderIndex: true
          },
          orderBy: {
            orderIndex: 'asc'
          }
        }
      },
      take: 10
    });
    
    console.log(`\n📋 发现 ${pagesWithCoauthors.length} 个有合著者的页面:`);
    
    pagesWithCoauthors.forEach((page, index) => {
      console.log(`\n${index + 1}. ${page.title}`);
      console.log(`   URL: ${page.url}`);
      console.log(`   合著者数: ${page._count.attributions}`);
      console.log(`   标签: ${page.tags?.includes('合著') ? '✅ 包含"合著"标签' : '❌ 无"合著"标签'}`);
      console.log(`   合著者列表:`);
      
      page.attributions.forEach(attr => {
        console.log(`     #${attr.orderIndex} [${attr.attributionType}] ${attr.userName} (${attr.userId || 'N/A'})`);
      });
    });
    
    // 3. 检查特定页面 (SCP-CN-3301)
    console.log(`\n🎯 检查SCP-CN-3301页面:`);
    const scpCn3301 = await prisma.page.findUnique({
      where: { url: 'http://scp-wiki-cn.wikidot.com/scp-cn-3301' },
      select: {
        title: true,
        tags: true,
        attributions: {
          select: {
            userName: true,
            userId: true,
            userUnixName: true,
            attributionType: true,
            orderIndex: true
          },
          orderBy: {
            orderIndex: 'asc'
          }
        }
      }
    });
    
    if (scpCn3301) {
      console.log(`   ✅ 页面存在: ${scpCn3301.title}`);
      console.log(`   合著者数量: ${scpCn3301.attributions.length}`);
      console.log(`   是否标记为合著: ${scpCn3301.tags?.includes('合著') ? '是' : '否'}`);
      
      if (scpCn3301.attributions.length > 0) {
        console.log(`   合著者详情:`);
        scpCn3301.attributions.forEach(attr => {
          console.log(`     #${attr.orderIndex} [${attr.attributionType}] ${attr.userName} (ID: ${attr.userId || 'N/A'}, Unix: ${attr.userUnixName || 'N/A'})`);
        });
        
        // 检查目标用户
        const targetUsers = ['silverIce', 'ColorlessL'];
        console.log(`\n   🔍 目标用户检查:`);
        targetUsers.forEach(target => {
          const found = scpCn3301.attributions.find(attr => 
            attr.userName === target || 
            attr.userUnixName === target.toLowerCase()
          );
          console.log(`     ${target}: ${found ? '✅ 找到' : '❌ 未找到'}`);
        });
      }
    } else {
      console.log(`   ❌ SCP-CN-3301页面不存在于数据库中`);
    }
    
    // 4. 统计合著者信息
    console.log(`\n📈 合著者统计:`);
    const attributionStats = await prisma.attribution.groupBy({
      by: ['attributionType'],
      _count: {
        attributionType: true
      }
    });
    
    attributionStats.forEach(stat => {
      console.log(`   ${stat.attributionType}: ${stat._count.attributionType} 条记录`);
    });
    
    console.log(`\n✅ 合著者功能验证完成`);
    
  } catch (error) {
    console.error(`❌ 验证失败: ${error.message}`);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

verifyCoauthors().catch(console.error);