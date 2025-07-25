import { ProductionSync } from './src/sync/production-sync.js';

async function forceSaveData() {
  console.log('💾 强制保存当前数据...');
  console.log('='.repeat(50));
  
  const sync = new ProductionSync({ voteOnly: true });
  
  try {
    // 1. 尝试从最新的checkpoint恢复数据
    console.log('🔄 尝试恢复数据...');
    
    // 加载投票进度checkpoint
    await sync.loadVoteProgressCheckpoint();
    
    // 如果没有投票数据，尝试加载页面数据
    if (sync.data.voteRecords.length === 0) {
      console.log('📋 投票数据为空，尝试加载页面数据...');
      await sync.loadExistingPageData();
    }
    
    console.log('\n📊 当前数据状态:');
    console.log(`   页面数据: ${sync.data.pages.length.toLocaleString()}`);
    console.log(`   投票记录: ${sync.data.voteRecords.length.toLocaleString()}`);
    console.log(`   用户数据: ${sync.data.users.length.toLocaleString()}`);
    console.log(`   归属记录: ${sync.data.attributions.length.toLocaleString()}`);
    console.log(`   修订记录: ${sync.data.revisions.length.toLocaleString()}`);
    console.log(`   备用标题: ${sync.data.alternateTitles.length.toLocaleString()}`);
    
    if (sync.data.pages.length === 0) {
      console.log('\n❌ 没有数据可保存');
      console.log('请确保已运行过同步并有checkpoint文件');
      return;
    }
    
    // 2. 汇总用户数据
    if (sync.data.voteRecords.length > 0) {
      console.log('\n👤 汇总用户数据...');
      await sync.consolidateUserData();
    }
    
    // 3. 设置统计信息
    sync.stats.startTime = new Date();
    sync.stats.endTime = new Date();
    sync.stats.votesProcessed = sync.data.voteRecords.length;
    sync.stats.pagesProcessed = sync.data.pages.length;
    
    // 4. 保存最终数据文件
    console.log('\n💾 保存最终数据文件...');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = sync.data.voteRecords.length > 0 ? 'emergency-with-votes' : 'emergency-pages-only';
    const filepath = await sync.saveCurrentData(suffix);
    
    console.log('\n🎉 数据保存完成！');
    console.log('='.repeat(50));
    console.log(`📁 文件路径: ${filepath}`);
    
    const fs = await import('fs');
    const fileSize = (fs.statSync(filepath).size / 1024 / 1024).toFixed(2);
    console.log(`📦 文件大小: ${fileSize} MB`);
    
    // 5. 数据完整性验证
    if (sync.data.voteRecords.length > 0) {
      console.log('\n🔍 数据完整性验证:');
      const uniquePages = new Set(sync.data.voteRecords.map(v => v.pageUrl)).size;
      const avgVotesPerPage = sync.data.voteRecords.length / uniquePages;
      console.log(`   涉及页面: ${uniquePages.toLocaleString()}`);
      console.log(`   平均投票/页面: ${avgVotesPerPage.toFixed(1)}`);
      
      // 投票方向统计
      const upvotes = sync.data.voteRecords.filter(v => v.direction === 1).length;
      const downvotes = sync.data.voteRecords.filter(v => v.direction === -1).length;
      console.log(`   正面投票: ${upvotes.toLocaleString()} (${(upvotes/sync.data.voteRecords.length*100).toFixed(1)}%)`);
      console.log(`   负面投票: ${downvotes.toLocaleString()} (${(downvotes/sync.data.voteRecords.length*100).toFixed(1)}%)`);
      
      // 时间范围
      const timestamps = sync.data.voteRecords.map(v => new Date(v.timestamp)).filter(d => !isNaN(d));
      if (timestamps.length > 0) {
        const earliestVote = new Date(Math.min(...timestamps));
        const latestVote = new Date(Math.max(...timestamps));
        console.log(`   投票时间范围: ${earliestVote.getFullYear()}-${String(earliestVote.getMonth()+1).padStart(2,'0')} 到 ${latestVote.getFullYear()}-${String(latestVote.getMonth()+1).padStart(2,'0')}`);
      }
    }
    
    console.log('\n✅ 紧急数据保存完成！');
    console.log('现在可以安全地重新启动同步进程了');
    
  } catch (error) {
    console.error(`❌ 保存过程发生错误: ${error.message}`);
    console.error(error.stack);
  }
}

forceSaveData().catch(console.error);