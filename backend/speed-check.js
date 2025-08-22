import { PrismaClient } from '@prisma/client';

async function speedCheck() {
  const prisma = new PrismaClient();
  
  try {
    const now = new Date();
    console.log(`🚀 同步速度检查 - ${now.toLocaleTimeString()}`);
    console.log('='.repeat(60));
    
    // 获取当前基础数据
    const [totalPages, stagingPages] = await Promise.all([
      prisma.page.count(),
      prisma.pageMetaStaging.count()
    ]);
    
    const remaining = stagingPages - totalPages;
    const progress = ((totalPages / stagingPages) * 100).toFixed(1);
    
    console.log(`📊 当前状态:`);
    console.log(`  已完成: ${totalPages.toLocaleString()} / ${stagingPages.toLocaleString()} (${progress}%)`);
    console.log(`  剩余: ${remaining.toLocaleString()} 页面`);
    
    // 检查最近的活动状态
    const intervals = [1, 2, 5, 10, 15, 30, 60];
    
    console.log(`\n⚡ 实时速度监控:`);
    
    for (const minutes of intervals) {
      const timeAgo = new Date(now.getTime() - minutes * 60 * 1000);
      const pagesInInterval = await prisma.page.count({
        where: {
          createdAt: { gte: timeAgo }
        }
      });
      
      const pagesPerHour = (pagesInInterval / minutes) * 60;
      
      let status = '';
      if (pagesInInterval === 0) {
        status = '🔴 停止';
      } else if (pagesPerHour > 5000) {
        status = '🟢 高速';
      } else if (pagesPerHour > 2000) {
        status = '🟡 中速';
      } else {
        status = '🟠 低速';
      }
      
      console.log(`  ${minutes.toString().padStart(2)}分钟: ${pagesInInterval.toString().padStart(4)} 页面 | ${pagesPerHour.toFixed(0).padStart(4)}/h | ${status}`);
    }
    
    // 获取最新同步的页面
    const latestPages = await prisma.page.findMany({
      orderBy: { createdAt: 'desc' },
      take: 3,
      include: {
        versions: {
          where: { validTo: null },
          take: 1
        }
      }
    });
    
    console.log(`\n📄 最近同步页面:`);
    latestPages.forEach((page, i) => {
      const timeAgo = (now.getTime() - page.createdAt.getTime()) / 1000;
      const version = page.versions[0];
      console.log(`  ${i+1}. ${page.url.split('/').pop()} - ${timeAgo.toFixed(0)}秒前`);
      console.log(`     ${version?.title || '无标题'} (评分: ${version?.rating || 0})`);
    });
    
    // 计算不同速度下的完成时间
    const speeds = [
      { name: '最近1分钟速度', minutes: 1 },
      { name: '最近5分钟速度', minutes: 5 },
      { name: '最近15分钟速度', minutes: 15 },
      { name: '最近30分钟速度', minutes: 30 }
    ];
    
    console.log(`\n🎯 基于不同速度的预测:`);
    
    for (const speed of speeds) {
      const timeAgo = new Date(now.getTime() - speed.minutes * 60 * 1000);
      const pagesInInterval = await prisma.page.count({
        where: {
          createdAt: { gte: timeAgo }
        }
      });
      
      if (pagesInInterval > 0) {
        const hourlyRate = (pagesInInterval / speed.minutes) * 60;
        const hoursToComplete = remaining / hourlyRate;
        const finishTime = new Date(now.getTime() + hoursToComplete * 60 * 60 * 1000);
        
        console.log(`  ${speed.name}: ${hourlyRate.toFixed(0)} 页面/小时`);
        console.log(`    完成时间: ${hoursToComplete.toFixed(1)}小时 (${finishTime.toLocaleString()})`);
      } else {
        console.log(`  ${speed.name}: 0 页面/小时 (已暂停)`);
      }
    }
    
    // 检查是否有速率限制模式
    const last10Seconds = new Date(now.getTime() - 10 * 1000);
    const veryRecentPages = await prisma.page.count({
      where: {
        createdAt: { gte: last10Seconds }
      }
    });
    
    console.log(`\n🚦 运行状态诊断:`);
    console.log(`  最近10秒: ${veryRecentPages} 页面`);
    
    if (veryRecentPages > 0) {
      console.log(`  状态: 🟢 正在活跃同步`);
    } else {
      console.log(`  状态: 🔴 当前暂停/等待中`);
      
      // 检查最后一次同步时间
      const lastPage = latestPages[0];
      if (lastPage) {
        const secondsSinceLastSync = (now.getTime() - lastPage.createdAt.getTime()) / 1000;
        console.log(`  上次同步: ${secondsSinceLastSync.toFixed(0)} 秒前`);
        
        if (secondsSinceLastSync < 120) {
          console.log(`  可能原因: 短期速率限制`);
        } else {
          console.log(`  可能原因: 遇到问题或长期限制`);
        }
      }
    }
    
    // 显示使用说明
    console.log(`\n💡 使用说明:`);
    console.log(`  运行命令: node speed-check.js`);
    console.log(`  建议间隔: 每5-10分钟检查一次`);
    console.log(`  脚本位置: backend/speed-check.js`);
    
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('❌ 速度检查失败:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

speedCheck();