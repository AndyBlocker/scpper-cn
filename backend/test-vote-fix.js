import { ProductionSync } from './src/sync/production-sync.js';

async function testVoteFix() {
  console.log('🧪 测试投票获取修复...');
  
  const sync = new ProductionSync();
  
  // 模拟full sync环境
  sync.config.enableIncrementalUpdate = true;
  sync.config.voteOnlyMode = false;
  sync.incrementalData.newVotesOnly = true;
  
  const testPages = [
    'http://scp-wiki-cn.wikidot.com/173-festival',  // 之前的问题页面
    'http://scp-wiki-cn.wikidot.com/173love',       // 之前的问题页面
    'http://scp-wiki-cn.wikidot.com/scp-173',       // 一个肯定有投票的页面
  ];
  
  for (const pageUrl of testPages) {
    console.log(`\n📋 测试页面: ${pageUrl}`);
    
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
      
      if (!page) {
        console.log('   ❌ 页面不存在或无法访问');
        continue;
      }
      
      console.log(`   标题: ${page.title}`);
      console.log(`   投票数: ${page.voteCount}, 评分: ${page.rating}`);
      
      // 2. 测试fetchPageVotesWithResume
      console.log('   🔧 测试fetchPageVotesWithResume...');
      const voteResult = await sync.fetchPageVotesWithResume(pageUrl, page.voteCount);
      
      console.log(`   结果:`);
      console.log(`     获取投票数: ${voteResult.votes?.length || 0}/${page.voteCount}`);
      console.log(`     是否完整: ${voteResult.isComplete}`);
      console.log(`     是否跳过: ${voteResult.skipped}`);
      console.log(`     错误信息: ${voteResult.error || '无'}`);
      
      // 验证结果
      if (page.voteCount > 0) {
        if (voteResult.votes && voteResult.votes.length === page.voteCount && voteResult.isComplete) {
          console.log(`   ✅ 投票获取成功！`);
        } else {
          console.log(`   ❌ 投票获取失败！期望${page.voteCount}票，实际获得${voteResult.votes?.length || 0}票`);
        }
      } else {
        console.log(`   ✅ 页面无投票，跳过正常`);
      }
      
    } catch (error) {
      console.error(`   ❌ 测试失败: ${error.message}`);
    }
    
    // 等待一下避免rate limit
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('\n✅ 投票获取修复测试完成');
}

testVoteFix().catch(console.error);