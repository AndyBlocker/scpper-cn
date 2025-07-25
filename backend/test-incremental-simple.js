import { ProductionSync } from './src/sync/production-sync.js';

async function testIncrementalSimple() {
  console.log('🧪 简单测试增量更新逻辑...');
  
  const sync = new ProductionSync();
  sync.incrementalData.newVotesOnly = true;
  
  const testPageUrl = 'http://scp-wiki-cn.wikidot.com/20230301';
  
  // 1. 获取当前页面投票数据
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
  
  console.log(`📋 页面: ${pageData.title}`);
  console.log(`   投票数: ${pageData.voteCount}, 评分: ${pageData.rating}`);
  console.log(`   前5个投票:`);
  
  const votes = pageData.fuzzyVoteRecords.edges;
  votes.forEach((edge, i) => {
    const vote = edge.node;
    console.log(`     ${i+1}. ${vote.userWikidotId} (${typeof vote.userWikidotId}) @${vote.timestamp}`);
  });
  
  // 2. 模拟完全相同的历史数据
  console.log(`\n🔧 设置完全相同的历史数据...`);
  
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
  
  console.log(`   设置了 ${voteKeys.size} 个历史投票记录`);
  console.log(`   历史状态: voteCount=${pageData.voteCount}, rating=${pageData.rating}`);
  
  // 3. 测试增量更新决策
  console.log(`\n🎯 测试增量更新决策（应该跳过）...`);
  const shouldSkip = await sync.checkVoteChangesAndDecideSync(testPageUrl, pageData.voteCount);
  
  console.log(`\n📊 结果: ${shouldSkip ? '✅ 跳过同步' : '❌ 进行同步'}`);
  
  if (shouldSkip) {
    console.log('🎉 增量更新逻辑工作正常！');
  } else {
    console.log('⚠️  增量更新逻辑可能需要调试');
  }
}

testIncrementalSimple().catch(console.error);