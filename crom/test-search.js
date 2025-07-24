import { CromClient } from './client.js';

async function testSearchCapabilities() {
  const client = new CromClient();
  
  console.log('🔍 Testing CROM API Search Capabilities\n');

  try {
    // 1. 测试连接和速率限制
    console.log('1. Testing connection and rate limits...');
    const rateLimit = await client.getRateLimit();
    console.log('Rate limit:', rateLimit.rateLimit);
    console.log();

    // 2. 获取站点列表
    console.log('2. Getting available sites...');
    const sites = await client.getSites();
    console.log('Available sites:');
    sites.sites.forEach(site => {
      console.log(`  - ${site.displayName} (${site.language}): ${site.url}`);
    });
    console.log();

    // 3. 测试中文站点搜索 - 小批量  
    const cnBaseUrl = 'http://scp-wiki-cn.wikidot.com'; // 注意：用http不是https
    console.log(`3. Testing small batch search on CN site...`);
    
    // 测试不同的搜索查询
    const searchTests = [
      { query: '', description: '空查询' },
      { query: '*', description: '通配符查询' },
      { query: 'scp', description: 'SCP关键词' },
      { query: '基金会', description: '中文关键词' }
    ];

    for (const test of searchTests) {
      try {
        console.log(`\n  Testing: ${test.description} ("${test.query}")`);
        const result = await client.testSearchPages(cnBaseUrl, test.query);
        console.log(`  Found ${result.searchPages.length} pages`);
        
        if (result.searchPages.length > 0) {
          console.log('  Sample results:');
          result.searchPages.slice(0, 2).forEach((page, i) => {
            console.log(`    ${i+1}. ${page.wikidotInfo?.title || 'No title'}`);
            console.log(`       URL: ${page.url}`);
            console.log(`       Rating: ${page.wikidotInfo?.rating || 'N/A'}`);
            console.log(`       Tags: ${page.wikidotInfo?.tags?.slice(0, 3).join(', ') || 'No tags'}`);
          });
        }
        
        // 短暂等待避免速率限制
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.log(`  ❌ Error: ${error.message}`);
      }
    }

    // 4. 测试用户搜索
    console.log(`\n4. Testing user search...`);
    try {
      const users = await client.testSearchUsers(cnBaseUrl, '');
      console.log(`Found ${users.searchUsers.length} users`);
      
      if (users.searchUsers.length > 0) {
        console.log('Sample users:');
        users.searchUsers.forEach((user, i) => {
          console.log(`  ${i+1}. ${user.name} (${user.wikidotInfo?.displayName || 'N/A'})`);
          console.log(`     Total rating: ${user.statistics?.totalRating || 'N/A'}`);
          console.log(`     Page count: ${user.statistics?.pageCount || 'N/A'}`);
        });
      }
    } catch (error) {
      console.log(`❌ User search error: ${error.message}`);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response:', error.response.errors);
    }
  }
}

// 运行测试
testSearchCapabilities().catch(console.error);