import { CromClient } from './client.js';
import fs from 'fs';

class RateLimitAnalysisClient extends CromClient {
  
  // 专门测试rate limit信息
  async analyzeRateLimit() {
    console.log('⏱️ 分析Rate Limit详细信息\n');
    
    const rateLimitTests = [];
    
    // 进行多次查询，观察rate limit的变化
    for (let i = 0; i < 5; i++) {
      try {
        console.log(`🔍 测试 ${i + 1}/5 - 基础rate limit查询`);
        
        const query = `
          query TestRateLimit {
            rateLimit {
              cost
              limit
              remaining
              resetAt
            }
          }
        `;
        
        const startTime = new Date();
        const result = await this.client.request(query);
        const endTime = new Date();
        
        const rateLimitInfo = result.rateLimit;
        
        console.log(`   Cost: ${rateLimitInfo.cost}`);
        console.log(`   Limit: ${rateLimitInfo.limit}`);
        console.log(`   Remaining: ${rateLimitInfo.remaining}`);
        console.log(`   ResetAt: ${rateLimitInfo.resetAt}`);
        console.log(`   ResetAt type: ${typeof rateLimitInfo.resetAt}`);
        console.log(`   Current time: ${startTime.toISOString()}`);
        
        // 如果resetAt存在，计算距离重置的时间
        if (rateLimitInfo.resetAt) {
          const resetTime = new Date(rateLimitInfo.resetAt);
          const timeToReset = resetTime.getTime() - startTime.getTime();
          console.log(`   Time to reset: ${Math.round(timeToReset / 1000)} seconds`);
          console.log(`   Reset time parsed: ${resetTime.toISOString()}`);
        } else {
          console.log(`   ⚠️ ResetAt is null/undefined`);
        }
        
        rateLimitTests.push({
          testNumber: i + 1,
          timestamp: startTime.toISOString(),
          rateLimit: rateLimitInfo,
          queryDuration: endTime.getTime() - startTime.getTime()
        });
        
        console.log('');
        
        // 等待1秒再进行下一次测试
        if (i < 4) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
      } catch (error) {
        console.log(`   ❌ 测试 ${i + 1} 失败: ${error.message}`);
        rateLimitTests.push({
          testNumber: i + 1,
          timestamp: new Date().toISOString(),
          error: error.message
        });
      }
    }
    
    return rateLimitTests;
  }
  
  // 测试不同复杂度查询的cost
  async analyzeCostPattern() {
    console.log('💰 分析不同查询的Cost模式\n');
    
    const costTests = [
      {
        name: "简单rate limit查询",
        query: `
          query SimpleCost {
            rateLimit {
              cost
              remaining
              resetAt
            }
          }
        `
      },
      {
        name: "获取站点列表",
        query: `
          query SitesCost {
            sites {
              displayName
              url
            }
            rateLimit {
              cost
              remaining
              resetAt
            }
          }
        `
      },
      {
        name: "聚合查询",
        query: `
          query AggregateCost($filter: QueryAggregatePageWikidotInfosFilter) {
            aggregatePageWikidotInfos(filter: $filter) {
              _count
            }
            rateLimit {
              cost
              remaining
              resetAt
            }
          }
        `,
        variables: {
          filter: {
            url: { startsWith: 'http://scp-wiki-cn.wikidot.com' }
          }
        }
      },
      {
        name: "单个页面查询",
        query: `
          query SinglePageCost($filter: QueryPagesFilter) {
            pages(filter: $filter, first: 1) {
              edges {
                node {
                  url
                  wikidotInfo {
                    title
                    rating
                  }
                }
              }
            }
            rateLimit {
              cost
              remaining
              resetAt
            }
          }
        `,
        variables: {
          filter: {
            url: { startsWith: 'http://scp-wiki-cn.wikidot.com' }
          }
        }
      },
      {
        name: "5个页面查询",
        query: `
          query FivePagesCost($filter: QueryPagesFilter) {
            pages(filter: $filter, first: 5) {
              edges {
                node {
                  url
                  wikidotInfo {
                    title
                    rating
                    tags
                  }
                }
              }
            }
            rateLimit {
              cost
              remaining
              resetAt
            }
          }
        `,
        variables: {
          filter: {
            url: { startsWith: 'http://scp-wiki-cn.wikidot.com' }
          }
        }
      }
    ];
    
    const costResults = [];
    
    for (const test of costTests) {
      try {
        console.log(`🧮 测试: ${test.name}`);
        
        const startTime = new Date();
        const result = await this.client.request(test.query, test.variables || {});
        const endTime = new Date();
        
        const rateLimit = result.rateLimit;
        
        console.log(`   Cost: ${rateLimit.cost}`);
        console.log(`   Remaining: ${rateLimit.remaining}`);
        console.log(`   ResetAt: ${rateLimit.resetAt}`);
        console.log(`   Duration: ${endTime.getTime() - startTime.getTime()}ms`);
        
        costResults.push({
          testName: test.name,
          timestamp: startTime.toISOString(),
          cost: rateLimit.cost,
          remaining: rateLimit.remaining,
          resetAt: rateLimit.resetAt,
          duration: endTime.getTime() - startTime.getTime()
        });
        
        console.log('');
        
        // 等待避免过快请求
        await new Promise(resolve => setTimeout(resolve, 1500));
        
      } catch (error) {
        console.log(`   ❌ 失败: ${error.message}`);
        costResults.push({
          testName: test.name,
          timestamp: new Date().toISOString(),
          error: error.message
        });
        console.log('');
      }
    }
    
    return costResults;
  }
  
  // 分析rate limit恢复模式
  async analyzeResetPattern(costResults) {
    console.log('🔄 分析Rate Limit恢复模式\n');
    
    // 计算cost消耗模式
    let totalCostUsed = 0;
    const validResults = costResults.filter(r => !r.error);
    
    if (validResults.length > 1) {
      const firstResult = validResults[0];
      const lastResult = validResults[validResults.length - 1];
      
      totalCostUsed = firstResult.remaining - lastResult.remaining;
      
      console.log(`📊 Cost消耗分析:`);
      console.log(`   初始remaining: ${firstResult.remaining}`);
      console.log(`   最终remaining: ${lastResult.remaining}`);
      console.log(`   总计消耗: ${totalCostUsed}`);
      console.log(`   测试次数: ${validResults.length}`);
      console.log(`   平均每次消耗: ${(totalCostUsed / validResults.length).toFixed(1)}`);
      
      // 分析resetAt模式
      const resetTimes = validResults.map(r => r.resetAt).filter(Boolean);
      const uniqueResetTimes = [...new Set(resetTimes)];
      
      console.log(`\n⏰ ResetAt分析:`);
      console.log(`   有效resetAt值数量: ${resetTimes.length}/${validResults.length}`);
      console.log(`   唯一resetAt值: ${uniqueResetTimes.length}`);
      
      if (uniqueResetTimes.length > 0) {
        console.log(`   ResetAt值:`);
        uniqueResetTimes.forEach((resetTime, i) => {
          const resetDate = new Date(resetTime);
          const now = new Date();
          const timeDiff = resetDate.getTime() - now.getTime();
          console.log(`     ${i + 1}. ${resetTime} (${resetDate.toISOString()})`);
          console.log(`        距现在: ${Math.round(timeDiff / 1000)}秒`);
        });
        
        // 判断是固定重置还是滚动窗口
        if (uniqueResetTimes.length === 1) {
          console.log(`\n   💡 分析: 固定重置时间模式`);
          const resetTime = new Date(uniqueResetTimes[0]);
          const now = new Date();
          const hoursToReset = Math.round((resetTime.getTime() - now.getTime()) / (1000 * 60 * 60));
          console.log(`   重置时间: ${resetTime.toISOString()}`);
          console.log(`   距离重置: ~${hoursToReset}小时`);
        } else {
          console.log(`\n   💡 分析: 可能是滚动窗口模式`);
        }
      } else {
        console.log(`\n   ⚠️ 所有resetAt都是null/undefined`);
        console.log(`   💡 这可能表示:`);
        console.log(`      1. 使用滚动窗口限制 (如每秒2个请求)`);
        console.log(`      2. API返回数据不完整`);
        console.log(`      3. 无固定重置时间`);
      }
    }
    
    return {
      totalCostUsed,
      validTestCount: validResults.length,
      resetAnalysis: {
        hasResetTimes: validResults.some(r => r.resetAt),
        uniqueResetTimes: [...new Set(validResults.map(r => r.resetAt).filter(Boolean))]
      }
    };
  }
}

async function analyzeRateLimitBehavior() {
  const client = new RateLimitAnalysisClient();
  
  console.log('⚡ CROM API Rate Limit 详细分析\n');

  try {
    // 1. 基础rate limit测试
    console.log('=' .repeat(50));
    const rateLimitTests = await client.analyzeRateLimit();
    
    // 2. 不同查询的cost分析
    console.log('=' .repeat(50));
    const costResults = await client.analyzeCostPattern();
    
    // 3. 恢复模式分析
    console.log('=' .repeat(50));
    const resetAnalysis = await client.analyzeResetPattern(costResults);
    
    // 4. 保存详细结果
    const fullAnalysis = {
      timestamp: new Date().toISOString(),
      rateLimitTests,
      costResults,
      resetAnalysis,
      summary: {
        totalTestsRun: rateLimitTests.length + costResults.length,
        totalCostUsed: resetAnalysis.totalCostUsed,
        hasResetTimes: resetAnalysis.resetAnalysis.hasResetTimes,
        conclusion: resetAnalysis.resetAnalysis.hasResetTimes 
          ? "Fixed reset time detected" 
          : "Likely rolling window rate limit"
      }
    };
    
    fs.writeFileSync('./results-rate-limit-analysis.json', JSON.stringify(fullAnalysis, null, 2));
    console.log('✅ 详细分析保存到 ./results-rate-limit-analysis.json');
    
    // 5. 总结
    console.log('\n🎯 Rate Limit 总结:');
    console.log(`   总限制: ${costResults[0]?.remaining ? costResults[0].remaining + resetAnalysis.totalCostUsed : '300000 (推测)'}点`);
    console.log(`   当前剩余: ${costResults[costResults.length - 1]?.remaining || 'Unknown'}`);
    console.log(`   测试消耗: ${resetAnalysis.totalCostUsed}点`);
    console.log(`   重置机制: ${resetAnalysis.resetAnalysis.hasResetTimes ? '固定时间重置' : '可能是滚动窗口'}`);
    
    if (!resetAnalysis.resetAnalysis.hasResetTimes) {
      console.log('\n   💡 滚动窗口限制的含义:');
      console.log('      - 每秒2个请求的硬限制');
      console.log('      - 300000点可能是日限制或总限制');
      console.log('      - 无固定"重置时间"概念');
      console.log('      - 需要持续监控remaining值');
    }

  } catch (error) {
    console.error('❌ Rate limit分析失败:', error.message);
    if (error.response?.errors) {
      console.error('Response errors:', error.response.errors.map(e => e.message));
    }
  }
}

// 运行分析
analyzeRateLimitBehavior().catch(console.error);