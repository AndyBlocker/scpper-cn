import { ProductionSync } from './src/sync/production-sync.js';

async function checkIncrementalSkip() {
  console.log('🔍 检查增量更新是否跳过了问题页面...');
  
  const sync = new ProductionSync();
  
  // 模拟full sync的设置
  sync.config.enableIncrementalUpdate = true;
  sync.config.voteOnlyMode = false;
  sync.incrementalData.newVotesOnly = true; // 模拟已加载历史数据
  
  const problematicPages = [
    'http://scp-wiki-cn.wikidot.com/173-festival',
    'http://scp-wiki-cn.wikidot.com/173love'
  ];
  
  for (const pageUrl of problematicPages) {
    console.log(`\n📋 检查页面: ${pageUrl}`);
    
    try {
      // 1. 获取页面基本信息
      const pageInfoQuery = `
        query GetPageInfo($pageUrl: URL!) {
          wikidotPage(url: $pageUrl) {
            title
            voteCount
            rating
          }
        }
      `;
      
      const pageInfo = await sync.cromClient.request(pageInfoQuery, { pageUrl });
      const page = pageInfo.wikidotPage;
      
      console.log(`   标题: ${page.title}`);
      console.log(`   投票数: ${page.voteCount}, 评分: ${page.rating}`);
      
      // 2. 模拟不同的历史数据状态来测试增量更新
      console.log('\n   🧪 测试场景1: 无历史数据（应该同步）');
      sync.incrementalData.existingVotes.clear();
      sync.incrementalData.pageVoteStates.clear();
      
      const result1 = await sync.fetchPageVotesWithResume(pageUrl, page.voteCount);
      console.log(`     结果: 获取${result1.votes?.length || 0}票, 完整性:${result1.isComplete}, 跳过:${result1.skipped}`);
      
      // 3. 模拟有历史数据但数据不同（应该同步）  
      console.log('\n   🧪 测试场景2: 有不同的历史数据（应该同步）');
      
      // 设置一些假的历史数据
      const fakeVoteKeys = new Set(['123456-2020-01-01T00:00:00.000Z']);
      sync.incrementalData.existingVotes.set(pageUrl, fakeVoteKeys);
      sync.incrementalData.pageVoteStates.set(pageUrl, {
        voteCount: page.voteCount - 1, // 不同的投票数
        rating: page.rating,
        lastUpdated: new Date().toISOString()
      });
      
      const result2 = await sync.fetchPageVotesWithResume(pageUrl, page.voteCount);
      console.log(`     结果: 获取${result2.votes?.length || 0}票, 完整性:${result2.isComplete}, 跳过:${result2.skipped}`);
      
      // 4. 模拟有相同的历史数据（应该跳过）
      console.log('\n   🧪 测试场景3: 设置相同的历史数据（应该跳过）');
      
      // 先获取实际的投票数据来设置历史数据
      sync.incrementalData.existingVotes.clear();
      sync.incrementalData.pageVoteStates.clear();
      const actualVotes = await sync.fetchPageVotesWithResume(pageUrl, page.voteCount);
      
      if (actualVotes.votes && actualVotes.votes.length > 0) {
        const realVoteKeys = new Set();
        actualVotes.votes.slice(0, 5).forEach(vote => {
          const voteKey = `${vote.userWikidotId}-${vote.timestamp}`;
          realVoteKeys.add(voteKey);
        });
        
        sync.incrementalData.existingVotes.set(pageUrl, realVoteKeys);
        sync.incrementalData.pageVoteStates.set(pageUrl, {
          voteCount: page.voteCount,
          rating: page.rating,
          lastUpdated: new Date().toISOString()
        });
        
        console.log(`     设置了 ${realVoteKeys.size} 个真实的历史投票记录`);
        
        const result3 = await sync.fetchPageVotesWithResume(pageUrl, page.voteCount);
        console.log(`     结果: 获取${result3.votes?.length || 0}票, 完整性:${result3.isComplete}, 跳过:${result3.skipped}`);
        
        if (result3.skipped) {
          console.log('     ✅ 正确跳过了同步（数据相同）');
        } else {
          console.log('     ⚠️  没有跳过同步，可能有其他原因');
        }
      }
      
      // 清理测试数据
      sync.incrementalData.existingVotes.clear();
      sync.incrementalData.pageVoteStates.clear();
      
    } catch (error) {
      console.error(`   ❌ 检查失败: ${error.message}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('\n✅ 增量更新检查完成');
}

checkIncrementalSkip().catch(console.error);