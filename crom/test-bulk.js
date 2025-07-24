import { CromClient } from './client.js';

async function testBulkCapabilities() {
  const client = new CromClient();
  
  console.log('📦 Testing CROM API Bulk Sync Capabilities\n');

  const cnBaseUrl = 'https://scp-wiki-cn.wikidot.com';

  try {
    // 1. 测试渐进式增大批量大小
    const batchSizes = [50, 100, 500, 1000, 2000, 5000];
    
    for (const batchSize of batchSizes) {
      console.log(`\n🔍 Testing batch size: ${batchSize}`);
      
      try {
        const startTime = Date.now();
        const result = await client.testBulkSearchPages(cnBaseUrl, '', batchSize);
        const endTime = Date.now();
        
        console.log(`✅ Success! Retrieved ${result.searchPages.length} pages`);
        console.log(`   Time taken: ${endTime - startTime}ms`);
        console.log(`   Rate limit cost: ${result.rateLimit.cost}`);
        console.log(`   Rate limit remaining: ${result.rateLimit.remaining}`);
        
        // 分析数据质量
        const pagesWithVotes = result.searchPages.filter(p => 
          p.wikidotInfo?.coarseVoteRecords?.length > 0
        );
        console.log(`   Pages with vote records: ${pagesWithVotes.length}`);
        
        if (pagesWithVotes.length > 0) {
          const totalVotes = pagesWithVotes.reduce((sum, p) => 
            sum + (p.wikidotInfo?.coarseVoteRecords?.length || 0), 0
          );
          console.log(`   Total vote records: ${totalVotes}`);
        }
        
        // 显示一些样例
        if (result.searchPages.length > 0) {
          console.log('   Sample pages:');
          result.searchPages.slice(0, 3).forEach((page, i) => {
            const info = page.wikidotInfo;
            console.log(`     ${i+1}. ${info?.title || 'No title'} (Rating: ${info?.rating || 'N/A'})`);
            if (info?.coarseVoteRecords?.length > 0) {
              console.log(`        Vote records: ${info.coarseVoteRecords.length}`);
            }
          });
        }
        
        // 如果达到了限制，就停止测试更大的批次
        if (result.searchPages.length < batchSize) {
          console.log(`📊 Reached maximum available data: ${result.searchPages.length} total pages`);
          break;
        }
        
      } catch (error) {
        console.log(`❌ Batch size ${batchSize} failed: ${error.message}`);
        if (error.response?.errors) {
          console.log('   Errors:', error.response.errors.map(e => e.message));
        }
        // 如果这个批次失败了，不要尝试更大的批次
        break;
      }
      
      // 等待以避免速率限制
      console.log('   Waiting 3 seconds...');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // 2. 对比传统分页方式
    console.log(`\n📄 Comparing with traditional pagination...`);
    try {
      const startTime = Date.now();
      const paginatedResult = await client.getPagesPaginated(cnBaseUrl, 100);
      const endTime = Date.now();
      
      console.log(`✅ Paginated fetch: ${paginatedResult.pages.edges.length} pages`);
      console.log(`   Time taken: ${endTime - startTime}ms`);
      console.log(`   Rate limit cost: ${paginatedResult.rateLimit.cost}`);
      console.log(`   Has next page: ${paginatedResult.pages.pageInfo.hasNextPage}`);
      
    } catch (error) {
      console.log(`❌ Pagination test failed: ${error.message}`);
    }

    // 3. 测试特定查询的全量获取
    console.log(`\n🎯 Testing targeted bulk queries...`);
    
    const targetedQueries = [
      { query: 'scp-', description: 'SCP条目' },
      { query: '原创', description: '原创标签' },
      { query: '基金会', description: '基金会相关' }
    ];

    for (const targetQuery of targetedQueries) {
      try {
        console.log(`\n  Testing: ${targetQuery.description} ("${targetQuery.query}")`);
        const result = await client.testBulkSearchPages(cnBaseUrl, targetQuery.query, 1000);
        console.log(`  Found ${result.searchPages.length} pages`);
        console.log(`  Rate limit cost: ${result.rateLimit.cost}`);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        console.log(`  ❌ Error: ${error.message}`);
      }
    }

  } catch (error) {
    console.error('❌ Bulk test failed:', error.message);
  }
}

// 运行测试
testBulkCapabilities().catch(console.error);