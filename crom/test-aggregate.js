import { CromClient } from './client.js';
import fs from 'fs';

// 扩展客户端以支持聚合查询
class ExtendedCromClient extends CromClient {
  // 测试聚合统计
  async testAggregateStats(baseUrl) {
    const query = `
      query TestAggregate($filter: QueryAggregatePageWikidotInfosFilter) {
        aggregatePageWikidotInfos(filter: $filter) {
          _count
          rating {
            sum
            mean
            min
            max
          }
        }
        rateLimit {
          cost
          remaining
        }
      }
    `;

    return await this.client.request(query, {
      filter: {
        url: {
          startsWith: baseUrl
        }
      }
    });
  }

  // 测试不同过滤条件的聚合
  async testFilteredAggregates(baseUrl) {
    const tests = [
      {
        name: "全站统计",
        filter: {
          url: { startsWith: baseUrl }
        }
      },
      {
        name: "高评分页面 (>50)",
        filter: {
          url: { startsWith: baseUrl },
          wikidotInfo: {
            rating: { gt: 50 }
          }
        }
      },
      {
        name: "SCP系列",
        filter: {
          url: { startsWith: baseUrl },
          wikidotInfo: {
            tags: { startsWith: "scp" }
          }
        }
      },
      {
        name: "原创内容",
        filter: {
          url: { startsWith: baseUrl },
          wikidotInfo: {
            tags: { eq: "原创" }
          }
        }
      },
      {
        name: "近期创建 (2023年后)",
        filter: {
          url: { startsWith: baseUrl },
          wikidotInfo: {
            createdAt: { gte: "2023-01-01T00:00:00.000Z" }
          }
        }
      }
    ];

    const results = [];
    
    for (const test of tests) {
      try {
        console.log(`\n📊 Testing: ${test.name}`);
        
        const query = `
          query TestFilteredAggregate($filter: QueryAggregatePageWikidotInfosFilter) {
            aggregatePageWikidotInfos(filter: $filter) {
              _count
              rating {
                sum
                mean
                min
                max
              }
            }
            rateLimit {
              cost
              remaining
            }
          }
        `;

        const result = await this.client.request(query, { filter: test.filter });
        
        console.log(`   ✅ Count: ${result.aggregatePageWikidotInfos._count}`);
        console.log(`   📈 Rating stats:`);
        console.log(`      Sum: ${result.aggregatePageWikidotInfos.rating.sum}`);
        console.log(`      Mean: ${result.aggregatePageWikidotInfos.rating.mean?.toFixed(2)}`);
        console.log(`      Min: ${result.aggregatePageWikidotInfos.rating.min}`);
        console.log(`      Max: ${result.aggregatePageWikidotInfos.rating.max}`);
        console.log(`   🔢 Rate limit cost: ${result.rateLimit.cost}`);
        
        results.push({
          name: test.name,
          filter: test.filter,
          result: result.aggregatePageWikidotInfos,
          rateLimit: result.rateLimit
        });
        
        // 等待避免速率限制
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.log(`   ❌ Error: ${error.message}`);
        results.push({
          name: test.name,
          filter: test.filter,
          error: error.message
        });
      }
    }
    
    return results;
  }
}

async function testAggregateCapabilities() {
  const client = new ExtendedCromClient();
  const cnBaseUrl = 'http://scp-wiki-cn.wikidot.com';
  
  console.log('📊 Testing CROM Aggregate Capabilities\n');

  try {
    // 1. 基础聚合测试
    console.log('1. Testing basic aggregate...');
    const basicResult = await client.testAggregateStats(cnBaseUrl);
    
    console.log(`✅ Total pages in CN site: ${basicResult.aggregatePageWikidotInfos._count}`);
    console.log(`📈 Rating statistics:`);
    console.log(`   Sum: ${basicResult.aggregatePageWikidotInfos.rating.sum}`);
    console.log(`   Mean: ${basicResult.aggregatePageWikidotInfos.rating.mean?.toFixed(2)}`);
    console.log(`   Min: ${basicResult.aggregatePageWikidotInfos.rating.min}`);
    console.log(`   Max: ${basicResult.aggregatePageWikidotInfos.rating.max}`);
    console.log(`🔢 Rate limit cost: ${basicResult.rateLimit.cost}`);
    
    // 保存基础结果
    fs.writeFileSync('./results-aggregate-basic.json', JSON.stringify(basicResult, null, 2));
    console.log('✅ Saved basic aggregate to ./results-aggregate-basic.json');

    // 2. 测试不同过滤条件
    console.log('\n2. Testing filtered aggregates...');
    const filteredResults = await client.testFilteredAggregates(cnBaseUrl);
    
    // 保存过滤结果
    fs.writeFileSync('./results-aggregate-filtered.json', JSON.stringify(filteredResults, null, 2));
    console.log('\n✅ Saved filtered aggregates to ./results-aggregate-filtered.json');

    // 3. 分析结果
    console.log('\n3. Analysis:');
    const totalPages = basicResult.aggregatePageWikidotInfos._count;
    console.log(`🎯 CN site has ${totalPages} total pages`);
    
    if (totalPages > 10000) {
      console.log('⚠️  This confirms large dataset - traditional pagination will be slow');
    } else {
      console.log('✅ Dataset size is manageable for full sync');
    }
    
    console.log(`💰 Aggregate queries are very cheap (cost: ${basicResult.rateLimit.cost})`);
    console.log('💡 Aggregates could be used for:');
    console.log('   - Pre-flight checks before sync');
    console.log('   - Progress tracking during sync');
    console.log('   - Data validation after sync');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response?.errors) {
      console.error('Response errors:', error.response.errors.map(e => e.message));
    }
  }
}

// 运行测试
testAggregateCapabilities().catch(console.error);