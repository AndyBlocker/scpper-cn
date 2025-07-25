import { ProductionSync } from './src/sync/production-sync.js';

async function testNewIncrementalLogic() {
  console.log('🧪 测试新的增量更新逻辑...');
  
  const sync = new ProductionSync();
  
  // 模拟历史数据
  sync.incrementalData.newVotesOnly = true;
  
  // 测试页面
  const testPages = [
    'http://scp-wiki-cn.wikidot.com/scp-173',  // 经典页面，应该有很多投票
    'http://scp-wiki-cn.wikidot.com/20230301', // 之前的问题页面
    'http://scp-wiki-cn.wikidot.com/scp-001', // 另一个有投票的页面
  ];
  
  for (const pageUrl of testPages) {
    console.log(`\n📋 测试页面: ${pageUrl}`);
    
    try {
      // 1. 先获取页面基本信息
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
      
      if (!page) {
        console.log('   ❌ 页面不存在或无法访问');
        continue;
      }
      
      console.log(`   页面: ${page.title}`);
      console.log(`   投票数: ${page.voteCount}, 评分: ${page.rating}`);
      
      // 2. 测试在没有历史数据时的行为
      console.log('\n   🧪 测试场景1: 没有历史数据（首次同步）');
      const shouldSkip1 = await sync.checkVoteChangesAndDecideSync(pageUrl, page.voteCount);
      console.log(`   结果: ${shouldSkip1 ? '跳过同步' : '进行同步'} ✓`);
      
      // 3. 模拟历史数据
      console.log('\n   🧪 测试场景2: 设置模拟历史数据');
      
      // 先获取当前最新5个投票作为历史数据
      const currentVotesQuery = `
        query GetCurrentVotes($pageUrl: URL!) {
          wikidotPage(url: $pageUrl) {
            fuzzyVoteRecords(first: 5) {
              edges {
                node {
                  userWikidotId
                  direction
                  timestamp
                }
              }
            }
          }
        }
      `;
      
      const currentVotesResult = await sync.cromClient.request(currentVotesQuery, { pageUrl });
      const currentVotes = currentVotesResult.wikidotPage?.fuzzyVoteRecords?.edges || [];
      
      // 模拟历史投票数据
      if (currentVotes.length > 0) {
        const voteKeys = new Set();
        currentVotes.forEach(edge => {
          const vote = edge.node;
          const voteKey = `${vote.userWikidotId}-${vote.timestamp}`;
          voteKeys.add(voteKey);
        });
        sync.incrementalData.existingVotes.set(pageUrl, voteKeys);
        
        // 模拟历史页面状态
        sync.incrementalData.pageVoteStates.set(pageUrl, {
          voteCount: page.voteCount,
          rating: page.rating,
          lastUpdated: new Date().toISOString()
        });
        
        console.log(`   设置了 ${voteKeys.size} 个历史投票记录`);
        console.log(`   历史状态: voteCount=${page.voteCount}, rating=${page.rating}`);
        
        // 4. 测试相同数据时的行为
        console.log('\n   🧪 测试场景3: 数据完全相同（应该跳过）');
        const shouldSkip2 = await sync.checkVoteChangesAndDecideSync(pageUrl, page.voteCount);
        console.log(`   结果: ${shouldSkip2 ? '跳过同步' : '进行同步'} ✓`);
        
        // 5. 测试修改voteCount后的行为
        console.log('\n   🧪 测试场景4: 修改历史voteCount（应该同步）');
        sync.incrementalData.pageVoteStates.set(pageUrl, {
          voteCount: page.voteCount - 1, // 模拟不同的投票数
          rating: page.rating,
          lastUpdated: new Date().toISOString()
        });
        
        const shouldSkip3 = await sync.checkVoteChangesAndDecideSync(pageUrl, page.voteCount);
        console.log(`   结果: ${shouldSkip3 ? '跳过同步' : '进行同步'} ✓`);
        
        // 6. 测试修改rating后的行为
        console.log('\n   🧪 测试场景5: 修改历史rating（应该同步）');
        sync.incrementalData.pageVoteStates.set(pageUrl, {
          voteCount: page.voteCount,
          rating: page.rating + 1.0, // 模拟不同的评分
          lastUpdated: new Date().toISOString()
        });
        
        const shouldSkip4 = await sync.checkVoteChangesAndDecideSync(pageUrl, page.voteCount);
        console.log(`   结果: ${shouldSkip4 ? '跳过同步' : '进行同步'} ✓`);
        
      } else {
        console.log('   ⚠️  页面没有投票，跳过历史数据测试');
      }
      
      // 清理测试数据
      sync.incrementalData.existingVotes.delete(pageUrl);
      sync.incrementalData.pageVoteStates.delete(pageUrl);
      
    } catch (error) {
      console.error(`   ❌ 测试失败: ${error.message}`);
    }
    
    // 等待一下避免rate limit
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('\n✅ 新增量更新逻辑测试完成');
}

testNewIncrementalLogic().catch(console.error);