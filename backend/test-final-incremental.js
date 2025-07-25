import { ProductionSync } from './src/sync/production-sync.js';

async function testFinalIncremental() {
  console.log('🎯 最终增量更新逻辑测试...');
  
  const sync = new ProductionSync();
  sync.incrementalData.newVotesOnly = true;
  
  const testPageUrl = 'http://scp-wiki-cn.wikidot.com/20230301';
  
  // 获取页面数据
  const query = `
    query GetPageData($pageUrl: URL!) {
      wikidotPage(url: $pageUrl) {
        title
        voteCount
        rating
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
  
  const result = await sync.cromClient.request(query, { pageUrl: testPageUrl });
  const pageData = result.wikidotPage;
  
  console.log(`📋 测试页面: ${pageData.title} (${pageData.voteCount}票, 评分${pageData.rating})`);
  
  // 场景1: 首次同步（无历史数据）
  console.log(`\\n✅ 场景1: 首次同步`);
  const result1 = await sync.checkVoteChangesAndDecideSync(testPageUrl, pageData.voteCount);
  console.log(`   结果: ${result1 ? '跳过' : '同步'} ✓`);
  
  // 设置历史数据
  const votes = pageData.fuzzyVoteRecords.edges;
  const voteKeys = new Set();
  votes.forEach(edge => {
    const vote = edge.node;
    const voteKey = `${vote.userWikidotId}-${vote.timestamp}`;
    voteKeys.add(voteKey);
  });
  
  sync.incrementalData.existingVotes.set(testPageUrl, voteKeys);
  sync.incrementalData.pageVoteStates.set(testPageUrl, {
    voteCount: pageData.voteCount,
    rating: pageData.rating,
    lastUpdated: new Date().toISOString()
  });
  
  // 场景2: 数据完全相同
  console.log(`\\n✅ 场景2: 数据完全相同`);
  const result2 = await sync.checkVoteChangesAndDecideSync(testPageUrl, pageData.voteCount);
  console.log(`   结果: ${result2 ? '跳过' : '同步'} ✓`);
  
  // 场景3: voteCount变化
  console.log(`\\n✅ 场景3: voteCount变化`);
  sync.incrementalData.pageVoteStates.set(testPageUrl, {
    voteCount: pageData.voteCount - 1,
    rating: pageData.rating,
    lastUpdated: new Date().toISOString()
  });
  const result3 = await sync.checkVoteChangesAndDecideSync(testPageUrl, pageData.voteCount);
  console.log(`   结果: ${result3 ? '跳过' : '同步'} ✓`);
  
  // 场景4: rating变化
  console.log(`\\n✅ 场景4: rating变化`);
  sync.incrementalData.pageVoteStates.set(testPageUrl, {
    voteCount: pageData.voteCount,
    rating: pageData.rating + 1.0,
    lastUpdated: new Date().toISOString()
  });
  const result4 = await sync.checkVoteChangesAndDecideSync(testPageUrl, pageData.voteCount);
  console.log(`   结果: ${result4 ? '跳过' : '同步'} ✓`);
  
  // 场景5: 投票记录变化（模拟删除一个投票）
  console.log(`\\n✅ 场景5: 投票记录变化`);
  const modifiedVoteKeys = new Set(Array.from(voteKeys).slice(1)); // 删除第一个投票
  sync.incrementalData.existingVotes.set(testPageUrl, modifiedVoteKeys);
  sync.incrementalData.pageVoteStates.set(testPageUrl, {
    voteCount: pageData.voteCount,
    rating: pageData.rating,
    lastUpdated: new Date().toISOString()
  });
  const result5 = await sync.checkVoteChangesAndDecideSync(testPageUrl, pageData.voteCount);
  console.log(`   结果: ${result5 ? '跳过' : '同步'} ✓`);
  
  // 总结
  console.log(`\\n🎉 增量更新逻辑测试完成！`);
  console.log(`📊 测试结果总结:`);
  console.log(`   首次同步: ${!result1 ? '✅' : '❌'} 正确进行同步`);
  console.log(`   数据相同: ${result2 ? '✅' : '❌'} 正确跳过同步`);
  console.log(`   voteCount变化: ${!result3 ? '✅' : '❌'} 正确进行同步`);
  console.log(`   rating变化: ${!result4 ? '✅' : '❌'} 正确进行同步`);
  console.log(`   投票变化: ${!result5 ? '✅' : '❌'} 正确进行同步`);
  
  const allCorrect = !result1 && result2 && !result3 && !result4 && !result5;
  console.log(`\\n${allCorrect ? '🎉 所有测试通过！' : '⚠️  部分测试失败，需要检查逻辑'}`);
}

testFinalIncremental().catch(console.error);