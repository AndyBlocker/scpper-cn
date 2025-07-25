import { ProductionSync } from './src/sync/production-sync.js';

async function debugVoteIssue() {
  console.log('🔍 调试投票获取问题...');
  
  const sync = new ProductionSync({ voteOnly: true });
  
  // 测试一个具体页面的投票获取
  const testPages = [
    'http://scp-wiki-cn.wikidot.com/34bae', // 检查点中显示问题的页面
    'http://scp-wiki-cn.wikidot.com/scp-173',
    'http://scp-wiki-cn.wikidot.com/34-the-cruelest-fight'
  ];
  
  for (const pageUrl of testPages) {
    console.log(`\n📋 测试页面: ${pageUrl}`);
    
    try {
      // 先测试基本页面信息查询
      const pageInfoQuery = `
        query GetPageInfo($pageUrl: URL!) {
          wikidotPage(url: $pageUrl) {
            title
            rating
            voteCount
          }
        }
      `;
      
      const pageInfo = await sync.cromClient.request(pageInfoQuery, { pageUrl });
      const page = pageInfo.wikidotPage;
      
      if (!page) {
        console.log('❌ 页面不存在或无法访问');
        continue;
      }
      
      console.log(`📄 页面信息: ${page.title}, 评分: ${page.rating}, 投票数: ${page.voteCount}`);
      
      if (page.voteCount === 0) {
        console.log('ℹ️  页面投票数为0，跳过投票获取测试');
        continue;
      }
      
      // 测试投票获取
      console.log('🗳️  测试投票获取...');
      const voteResult = await sync.fetchPageVotesWithResume(pageUrl, page.voteCount);
      
      console.log(`📊 投票获取结果:`, {
        votesCount: voteResult.votes?.length || 0,
        isComplete: voteResult.isComplete,
        hasError: !!voteResult.error,
        error: voteResult.error,
        skipped: voteResult.skipped
      });
      
      if (voteResult.votes && voteResult.votes.length > 0) {
        console.log('✅ 成功获取投票，前3条:');
        voteResult.votes.slice(0, 3).forEach((vote, i) => {
          console.log(`  ${i + 1}. ${vote.user?.displayName || '未知'} (${vote.userWikidotId}): ${vote.direction} at ${vote.timestamp}`);
        });
      } else {
        console.log('❌ 未获取到投票数据');
      }
      
    } catch (error) {
      console.error(`❌ 测试失败: ${error.message}`);
      if (error.response) {
        console.error('详细错误:', error.response.errors?.[0]?.message || error.response);
      }
    }
    
    // 等待一下避免rate limit
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

debugVoteIssue().catch(console.error);