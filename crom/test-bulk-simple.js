import { CromClient } from './client.js';
import fs from 'fs';

async function testBulkSearchCapabilities() {
  const client = new CromClient();
  const cnBaseUrl = 'http://scp-wiki-cn.wikidot.com';
  
  console.log('🎯 Testing CN Site Bulk Search Capabilities\n');

  try {
    // 1. 测试空查询是否能获取更多数据
    console.log('1. Testing empty query for bulk pages...');
    const startTime = Date.now();
    const result = await client.testBulkSearchPages(cnBaseUrl, '');
    const endTime = Date.now();
    
    // 保存页面数据到本地
    fs.writeFileSync('./results-pages.json', JSON.stringify(result, null, 2));
    console.log('   ✅ Saved page results to ./results-pages.json');
    
    console.log(`✅ Retrieved ${result.searchPages.length} pages`);
    console.log(`   Time taken: ${endTime - startTime}ms`);
    console.log(`   Rate limit cost: ${result.rateLimit.cost}`);
    console.log(`   Rate limit remaining: ${result.rateLimit.remaining}`);
    
    // 分析投票记录
    const pagesWithVotes = result.searchPages.filter(p => 
      p.wikidotInfo?.coarseVoteRecords?.length > 0
    );
    console.log(`   Pages with vote records: ${pagesWithVotes.length}`);
    
    if (pagesWithVotes.length > 0) {
      const totalVotes = pagesWithVotes.reduce((sum, p) => 
        sum + (p.wikidotInfo?.coarseVoteRecords?.length || 0), 0
      );
      console.log(`   Total vote records: ${totalVotes}`);
      
      // 显示投票记录样例
      const samplePage = pagesWithVotes[0];
      console.log(`   Sample vote records from "${samplePage.wikidotInfo.title}":`);
      samplePage.wikidotInfo.coarseVoteRecords.slice(0, 3).forEach((vote, i) => {
        console.log(`     ${i+1}. User ${vote.user?.name || vote.userWikidotId}: ${vote.direction > 0 ? '+' : '-'}${Math.abs(vote.direction)} at ${vote.timestamp}`);
      });
    }
    
    // 显示一些样例页面
    console.log('\n   Sample pages:');
    result.searchPages.slice(0, 5).forEach((page, i) => {
      const info = page.wikidotInfo;
      console.log(`     ${i+1}. ${info?.title || 'No title'}`);
      console.log(`        URL: ${page.url}`);
      console.log(`        Rating: ${info?.rating || 'N/A'} (${info?.voteCount || 0} votes)`);
      console.log(`        Tags: ${info?.tags?.slice(0, 3).join(', ') || 'No tags'}`);
      console.log(`        Created: ${info?.createdAt || 'N/A'}`);
      if (info?.coarseVoteRecords?.length > 0) {
        console.log(`        Vote records: ${info.coarseVoteRecords.length}`);
      }
    });

    // 2. 测试用户搜索
    console.log(`\n2. Testing user search...`);
    const userResult = await client.testSearchUsers(cnBaseUrl, '');
    
    // 保存用户数据到本地
    fs.writeFileSync('./results-users.json', JSON.stringify(userResult, null, 2));
    console.log('   ✅ Saved user results to ./results-users.json');
    
    console.log(`✅ Retrieved ${userResult.searchUsers.length} users`);
    
    if (userResult.searchUsers.length > 0) {
      console.log('   Sample users:');
      userResult.searchUsers.forEach((user, i) => {
        console.log(`     ${i+1}. ${user.name} (${user.wikidotInfo?.displayName || 'N/A'})`);
        console.log(`        Wikidot ID: ${user.wikidotInfo?.wikidotId || 'N/A'}`);
        console.log(`        Total rating: ${user.statistics?.totalRating || 'N/A'}`);
        console.log(`        Page count: ${user.statistics?.pageCount || 'N/A'}`);
        console.log(`        Rank: ${user.statistics?.rank || 'N/A'}`);
      });
    }

    // 3. 分析限制
    console.log(`\n3. Analysis:`);
    console.log(`   - Pages returned: ${result.searchPages.length} (seems to be capped at 5)`);
    console.log(`   - Users returned: ${userResult.searchUsers.length} (also capped at 5)`);
    console.log(`   - Vote records available: ${pagesWithVotes.length > 0 ? 'YES' : 'NO'}`);
    console.log(`   - Rate limit cost is low: ${result.rateLimit.cost}`);
    
    if (result.searchPages.length === 5) {
      console.log('\n⚠️  Search appears to be limited to 5 results.');
      console.log('   This means bulk sync via search API may not be feasible.');
      console.log('   We may need to use traditional pagination or other approaches.');
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response?.errors) {
      console.error('   Errors:', error.response.errors.map(e => e.message));
    }
  }
}

// 运行测试
testBulkSearchCapabilities().catch(console.error);