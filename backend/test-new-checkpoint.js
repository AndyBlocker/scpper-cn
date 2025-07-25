import { ProductionSync } from './src/sync/production-sync.js';

async function testNewCheckpoint() {
  console.log('🧪 测试新的Checkpoint格式...');
  
  const sync = new ProductionSync({ voteOnly: true });
  
  try {
    // 1. 加载现有页面数据
    console.log('📥 加载现有页面数据...');
    await sync.loadExistingPageData();
    console.log(`✅ 加载了 ${sync.data.pages.length} 页面`);
    
    // 2. 筛选前5个有投票的页面进行测试
    const pagesWithVotes = sync.data.pages.filter(p => p.voteCount > 0).slice(0, 5);
    console.log(`🎯 选择前 ${pagesWithVotes.length} 个有投票的页面进行测试`);
    
    // 3. 初始化投票进度追踪
    sync.voteProgress = {
      completedPages: new Set(),
      partialPages: new Map(),
      totalVotesExpected: pagesWithVotes.reduce((sum, p) => sum + p.voteCount, 0),
      totalVotesCollected: 0
    };
    
    console.log(`📊 预期收集投票: ${sync.voteProgress.totalVotesExpected} 条`);
    
    // 4. 为测试页面获取投票数据
    for (const page of pagesWithVotes) {
      try {
        console.log(`\\n🗳️  获取页面投票: ${page.title} (${page.voteCount} 票)`);
        
        await sync.rateLimit();
        const voteResult = await sync.fetchPageVotesWithResume(page.url, page.voteCount);
        
        if (voteResult.votes && voteResult.votes.length > 0) {
          // 添加投票数据到集合中
          for (const vote of voteResult.votes) {
            sync.data.voteRecords.push({
              pageUrl: page.url,
              pageTitle: page.title,
              pageAuthor: page.createdByUser,
              pageAuthorId: page.createdByWikidotId,
              voterWikidotId: vote.userWikidotId,
              voterName: vote.user?.displayName,
              direction: vote.direction,
              timestamp: vote.timestamp
            });
          }
          
          sync.stats.votesProcessed += voteResult.votes.length;
          sync.voteProgress.totalVotesCollected += voteResult.votes.length;
        }
        
        // 标记为完成
        if (voteResult.isComplete && voteResult.votes.length === page.voteCount) {
          sync.voteProgress.completedPages.add(page.url);
          console.log(`✅ 完成: ${voteResult.votes.length}/${page.voteCount} 票`);
        } else {
          console.log(`⚠️  不完整: ${voteResult.votes.length}/${page.voteCount} 票`);
        }
        
      } catch (error) {
        console.log(`❌ 获取失败: ${error.message}`);
      }
    }
    
    console.log(`\\n📊 测试结果:`);
    console.log(`   完成页面: ${sync.voteProgress.completedPages.size}/${pagesWithVotes.length}`);
    console.log(`   收集投票: ${sync.data.voteRecords.length.toLocaleString()}`);
    
    // 5. 保存新格式的checkpoint
    if (sync.data.voteRecords.length > 0) {
      console.log('\\n💾 保存新格式checkpoint...');
      await sync.saveVoteProgressCheckpoint();
      console.log('✅ 新格式checkpoint已保存');
    } else {
      console.log('\\n⚠️  没有收集到投票数据，跳过checkpoint保存');
    }
    
  } catch (error) {
    console.error(`❌ 测试失败: ${error.message}`);
    console.error(error.stack);
  }
}

testNewCheckpoint().catch(console.error);