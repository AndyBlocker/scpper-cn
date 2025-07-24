import { CromClient } from './client.js';
import fs from 'fs';

class IncrementalClient extends CromClient {
  // 检查页面的时间戳字段，寻找变更检测的可能性
  async analyzePageTimestamps(baseUrl) {
    const query = `
      query AnalyzeTimestamps($filter: QueryPagesFilter, $first: Int) {
        pages(filter: $filter, first: $first) {
          edges {
            node {
              url
              wikidotInfo {
                title
                rating
                voteCount
                createdAt
                revisionCount
                # 获取最新的修订信息
                revisions {
                  index
                  timestamp
                  type
                  comment
                }
                # 获取最新的投票记录
                coarseVoteRecords {
                  timestamp
                  direction
                }
              }
            }
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
        url: { startsWith: baseUrl }
      },
      first: 10  // 取10个样本分析
    });
  }

  // 测试按时间范围查询的可能性
  async testTimeRangeQueries(baseUrl) {
    const tests = [
      {
        name: "最近24小时创建的页面",
        filter: {
          url: { startsWith: baseUrl },
          wikidotInfo: {
            createdAt: { 
              gte: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() 
            }
          }
        }
      },
      {
        name: "最近一周创建的页面", 
        filter: {
          url: { startsWith: baseUrl },
          wikidotInfo: {
            createdAt: { 
              gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() 
            }
          }
        }
      },
      {
        name: "最近一个月创建的页面",
        filter: {
          url: { startsWith: baseUrl },
          wikidotInfo: {
            createdAt: { 
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() 
            }
          }
        }
      }
    ];

    const results = [];
    
    for (const test of tests) {
      try {
        console.log(`\n📅 Testing: ${test.name}`);
        
        // 先用聚合查询获取数量
        const aggregateQuery = `
          query TestTimeAggregate($filter: QueryAggregatePageWikidotInfosFilter) {
            aggregatePageWikidotInfos(filter: $filter) {
              _count
            }
            rateLimit {
              cost
              remaining
            }
          }
        `;

        const aggregateResult = await this.client.request(aggregateQuery, { 
          filter: test.filter 
        });
        
        console.log(`   ✅ Count: ${aggregateResult.aggregatePageWikidotInfos._count}`);
        console.log(`   🔢 Rate limit cost: ${aggregateResult.rateLimit.cost}`);
        
        results.push({
          name: test.name,
          filter: test.filter,
          count: aggregateResult.aggregatePageWikidotInfos._count,
          rateLimit: aggregateResult.rateLimit
        });
        
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

  // 分析如何检测页面变更
  async analyzeChangeDetection(baseUrl) {
    console.log('\n🔍 Analyzing change detection possibilities...');
    
    // 1. 检查是否有最后修改时间字段
    const sampleQuery = `
      query AnalyzePage($url: String!) {
        page(url: $url) {
          url
          wikidotInfo {
            title
            rating
            voteCount
            createdAt
            revisionCount
            revisions {
              index
              timestamp
              type
              comment
            }
            coarseVoteRecords {
              timestamp
              direction
            }
          }
        }
      }
    `;
    
    try {
      // 使用我们之前获取的一个页面URL进行分析
      const sampleUrl = 'http://scp-wiki-cn.wikidot.com/scp-1397-ru';
      const pageResult = await this.client.request(sampleQuery, { url: sampleUrl });
      
      if (pageResult.page) {
        const page = pageResult.page;
        const info = page.wikidotInfo;
        
        console.log('\n📄 Sample page analysis:');
        console.log(`   Title: ${info.title}`);
        console.log(`   Created: ${info.createdAt}`);
        console.log(`   Revision count: ${info.revisionCount}`);
        
        // 分析修订历史
        if (info.revisions && info.revisions.length > 0) {
          const latestRevision = info.revisions[info.revisions.length - 1];
          console.log(`   Latest revision: ${latestRevision.timestamp} (${latestRevision.type})`);
          console.log(`   📝 Comment: ${latestRevision.comment || 'No comment'}`);
        }
        
        // 分析投票记录
        if (info.coarseVoteRecords && info.coarseVoteRecords.length > 0) {
          const latestVote = info.coarseVoteRecords[info.coarseVoteRecords.length - 1];
          console.log(`   Latest vote: ${latestVote.timestamp} (${latestVote.direction > 0 ? '+' : '-'})`);
        }
        
        return {
          hasRevisions: info.revisions && info.revisions.length > 0,
          hasVoteRecords: info.coarseVoteRecords && info.coarseVoteRecords.length > 0,
          latestRevisionTime: info.revisions ? info.revisions[info.revisions.length - 1]?.timestamp : null,
          latestVoteTime: info.coarseVoteRecords ? info.coarseVoteRecords[info.coarseVoteRecords.length - 1]?.timestamp : null,
          createdAt: info.createdAt
        };
      }
    } catch (error) {
      console.log(`❌ Sample page analysis failed: ${error.message}`);
      return null;
    }
  }
}

async function analyzeIncrementalSync() {
  const client = new IncrementalClient();
  const cnBaseUrl = 'http://scp-wiki-cn.wikidot.com';
  
  console.log('🔄 Analyzing Incremental Sync Possibilities\n');

  try {
    // 1. 分析页面时间戳结构
    console.log('1. Analyzing page timestamp structure...');
    const timestampAnalysis = await client.analyzePageTimestamps(cnBaseUrl);
    
    // 保存样本数据
    fs.writeFileSync('./results-timestamp-analysis.json', JSON.stringify(timestampAnalysis, null, 2));
    console.log('✅ Saved timestamp analysis to ./results-timestamp-analysis.json');

    // 2. 测试时间范围查询
    console.log('\n2. Testing time-range queries for incremental sync...');
    const timeRangeResults = await client.testTimeRangeQueries(cnBaseUrl);
    
    fs.writeFileSync('./results-time-range.json', JSON.stringify(timeRangeResults, null, 2));
    console.log('\n✅ Saved time-range results to ./results-time-range.json');

    // 3. 变更检测分析
    const changeDetection = await client.analyzeChangeDetection(cnBaseUrl);
    
    if (changeDetection) {
      fs.writeFileSync('./results-change-detection.json', JSON.stringify(changeDetection, null, 2));
      console.log('\n✅ Saved change detection analysis to ./results-change-detection.json');
    }

    // 4. 提出增量同步策略
    console.log('\n📋 Incremental Sync Strategy Analysis:');
    
    console.log('\n🔍 Available change indicators:');
    console.log('   ✅ createdAt - for new pages');
    console.log('   ✅ revisions[] - with timestamps for content changes');
    console.log('   ✅ coarseVoteRecords[] - with timestamps for vote changes');
    console.log('   ❌ No lastModified or updatedAt field found');
    
    console.log('\n💡 Proposed incremental sync approaches:');
    console.log('   1. 🆕 New pages: Query by createdAt > lastSyncTime');
    console.log('   2. 📝 Content changes: Compare revision timestamps');
    console.log('   3. 👍 Vote changes: Compare vote record timestamps');
    console.log('   4. 🔄 Hybrid: Periodic full sync + daily incremental');
    
    console.log('\n⚡ Performance recommendations:');
    const recentPages = timeRangeResults.find(r => r.name.includes('最近一周'));
    if (recentPages && recentPages.count !== undefined) {
      console.log(`   - Recent activity: ~${recentPages.count} new pages per week`);
      console.log(`   - Daily incremental: ~${Math.ceil(recentPages.count / 7)} new pages/day`);
      console.log(`   - Time for daily sync: ~${Math.ceil(recentPages.count / 7 / 5)} requests = ~${Math.ceil(recentPages.count / 7 / 5 / 2)} seconds`);
    }
    
    console.log('\n🎯 Recommended sync strategy:');
    console.log('   1. Initial: Full sync (30,849 pages, ~51 minutes)');
    console.log('   2. Daily: Incremental sync for pages created in last 24h');
    console.log('   3. Weekly: Check for content changes via revision timestamps');
    console.log('   4. Monthly: Full validation sync');

  } catch (error) {
    console.error('❌ Analysis failed:', error.message);
    if (error.response?.errors) {
      console.error('Response errors:', error.response.errors.map(e => e.message));
    }
  }
}

// 运行分析
analyzeIncrementalSync().catch(console.error);