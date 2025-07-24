import { CromClient } from './client.js';
import fs from 'fs';

class VotingAnalysisClient extends CromClient {
  
  // 测试是否能按投票时间过滤页面
  async testVoteTimeFiltering() {
    console.log('🗳️ Testing vote-based filtering capabilities...\n');
    
    // 尝试各种可能的投票时间过滤方式
    const tests = [
      {
        name: "测试投票记录时间过滤 (如果支持)",
        description: "尝试通过coarseVoteRecords的timestamp过滤"
      }
    ];

    // 先检查schema中是否有相关的过滤器
    console.log('1. 分析schema中的投票相关过滤器...');
    
    // 从我们的schema分析中，QueryPagesWikidotInfoFilter似乎不包含投票时间过滤
    // 让我们尝试一些可能的查询
    
    const recentTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    console.log(`   使用时间点: ${recentTime}`);
    
    // 测试1: 尝试获取最近一周有投票活动的页面数量
    try {
      console.log('\n2. 尝试聚合查询...');
      const aggregateQuery = `
        query TestVoteAggregate($filter: QueryAggregatePageWikidotInfosFilter) {
          aggregatePageWikidotInfos(filter: $filter) {
            _count
          }
          rateLimit {
            cost
            remaining
          }
        }
      `;

      // 尝试一个基础过滤，看看有多少页面有投票记录
      const result = await this.client.request(aggregateQuery, {
        filter: {
          url: { startsWith: 'http://scp-wiki-cn.wikidot.com' }
          // 注意：这里我们无法过滤投票时间，因为schema不支持
        }
      });
      
      console.log(`   ✅ 获取到总页面数: ${result.aggregatePageWikidotInfos._count}`);
      console.log(`   🔢 Rate limit cost: ${result.rateLimit.cost}`);
      console.log(`   💰 Rate limit remaining: ${result.rateLimit.remaining}`);
      console.log(`   ⏰ Rate limit reset at: ${result.rateLimit.resetAt}`);
      
    } catch (error) {
      console.log(`   ❌ 聚合查询失败: ${error.message}`);
    }

    return null;
  }

  // 分析实际的投票数据模式
  async analyzeVotingPatterns(baseUrl) {
    console.log('\n📊 分析实际投票数据模式...');
    
    const query = `
      query AnalyzeVotingPatterns($filter: QueryPagesFilter, $first: Int) {
        pages(filter: $filter, first: $first) {
          edges {
            node {
              url
              wikidotInfo {
                title
                rating
                voteCount
                realtimeRating
                realtimeVoteCount
                createdAt
                coarseVoteRecords {
                  timestamp
                  userWikidotId
                  direction
                  user {
                    name
                  }
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

    try {
      const result = await this.client.request(query, {
        filter: {
          url: { startsWith: baseUrl }
        },
        first: 10
      });

      const pages = result.pages.edges.map(edge => edge.node);
      
      console.log(`   ✅ 分析了 ${pages.length} 个页面`);
      console.log(`   🔢 Rate limit cost: ${result.rateLimit.cost}`);
      console.log(`   💰 Rate limit remaining: ${result.rateLimit.remaining}`);
      console.log(`   ⏰ Rate limit reset at: ${result.rateLimit.resetAt}`);
      
      let totalVoteRecords = 0;
      let pagesWithRecentVotes = 0;
      const recentThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30天前
      
      const analysis = pages.map(page => {
        const info = page.wikidotInfo;
        const voteRecords = info.coarseVoteRecords || [];
        totalVoteRecords += voteRecords.length;
        
        // 检查是否有最近的投票
        const recentVotes = voteRecords.filter(vote => 
          new Date(vote.timestamp) > recentThreshold
        );
        
        if (recentVotes.length > 0) {
          pagesWithRecentVotes++;
        }
        
        // 找到最新的投票时间
        const latestVoteTime = voteRecords.length > 0 
          ? voteRecords.reduce((latest, vote) => {
              const voteTime = new Date(vote.timestamp);
              return voteTime > latest ? voteTime : latest;
            }, new Date(0))
          : null;
        
        return {
          url: page.url,
          title: info.title,
          rating: info.rating,
          voteCount: info.voteCount,
          realtimeRating: info.realtimeRating,
          realtimeVoteCount: info.realtimeVoteCount,
          createdAt: info.createdAt,
          totalVoteRecords: voteRecords.length,
          recentVoteRecords: recentVotes.length,
          latestVoteTime: latestVoteTime?.toISOString(),
          hasRatingDifference: info.rating !== info.realtimeRating,
          hasVoteCountDifference: info.voteCount !== info.realtimeVoteCount
        };
      });
      
      console.log(`\n   📈 投票数据统计:`);
      console.log(`      总投票记录数: ${totalVoteRecords}`);
      console.log(`      最近30天有投票的页面: ${pagesWithRecentVotes}/${pages.length}`);
      console.log(`      平均每页投票记录: ${(totalVoteRecords / pages.length).toFixed(1)}`);
      
      // 检查rating vs realtimeRating的差异
      const withRatingDiff = analysis.filter(p => p.hasRatingDifference);
      const withVoteCountDiff = analysis.filter(p => p.hasVoteCountDifference);
      
      console.log(`\n   🔍 实时数据差异分析:`);
      console.log(`      rating ≠ realtimeRating: ${withRatingDiff.length}/${pages.length}`);
      console.log(`      voteCount ≠ realtimeVoteCount: ${withVoteCountDiff.length}/${pages.length}`);
      
      if (withRatingDiff.length > 0) {
        console.log(`      示例差异:`);
        withRatingDiff.slice(0, 3).forEach(page => {
          console.log(`        ${page.title}: rating=${page.rating}, realtime=${page.realtimeRating}`);
        });
      }
      
      // 保存详细分析结果
      const fullAnalysis = {
        summary: {
          totalPages: pages.length,
          totalVoteRecords,
          pagesWithRecentVotes,
          averageVoteRecordsPerPage: totalVoteRecords / pages.length,
          pagesWithRatingDifference: withRatingDiff.length,
          pagesWithVoteCountDifference: withVoteCountDiff.length
        },
        pages: analysis,
        rateLimit: result.rateLimit
      };
      
      fs.writeFileSync('./results-voting-analysis.json', JSON.stringify(fullAnalysis, null, 2));
      console.log(`\n   ✅ 详细分析保存到 ./results-voting-analysis.json`);
      
      return fullAnalysis;
      
    } catch (error) {
      console.log(`   ❌ 投票分析失败: ${error.message}`);
      return null;
    }
  }

  // 提出投票变化检测的解决方案
  async proposeVotingSyncSolutions() {
    console.log('\n💡 投票变化检测解决方案分析:\n');
    
    console.log('❌ 问题确认:');
    console.log('   - CROM API无法直接查询"最近有投票变化的页面"');
    console.log('   - 搜索API限制为5个结果，无法用于大规模检测');
    console.log('   - 分页API需要遍历所有页面才能检测投票变化\n');
    
    console.log('✅ 可行的解决方案:\n');
    
    console.log('方案1: 【智能抽样检测】');
    console.log('   - 每日随机抽样检查1000个页面 (200个请求, 100秒)');
    console.log('   - 基于历史数据预测高活跃页面');
    console.log('   - 重点监控高评分页面的投票变化');
    console.log('   - 优点: 成本低，能捕获大部分重要变化');
    console.log('   - 缺点: 可能遗漏一些变化\n');
    
    console.log('方案2: 【分批轮询】');
    console.log('   - 将30849个页面分为30组，每天检查一组');
    console.log('   - 每组~1000页面，需要200个请求 (100秒/天)');
    console.log('   - 30天完成一轮完整检查');
    console.log('   - 优点: 保证完整性');
    console.log('   - 缺点: 投票变化可能延迟最多30天被发现\n');
    
    console.log('方案3: 【混合策略】(推荐)');
    console.log('   - 高频检查: 热门页面 (评分>50) 每日检查');
    console.log('   - 中频检查: 中等页面 (评分10-50) 每周检查');
    console.log('   - 低频检查: 低分页面 (<10) 每月检查');
    console.log('   - 实时监控: 使用realtime字段检测即时变化');
    console.log('   - 优点: 平衡了时效性和成本\n');
    
    console.log('方案4: 【利用realtime字段】');
    console.log('   - rating vs realtimeRating 的差异表示新投票');
    console.log('   - 只同步有差异的页面的完整投票记录');
    console.log('   - 这可能是最高效的方法！');
    console.log('   - 需要验证: realtime字段是否实时更新\n');
    
    console.log('🎯 建议的实现顺序:');
    console.log('   1. 先验证realtime字段的更新频率');
    console.log('   2. 实现基于realtime差异的变化检测');
    console.log('   3. 结合热门页面的高频检查');
    console.log('   4. 建立投票变化的本地缓存和去重机制');
  }
}

async function analyzeVotingChanges() {
  const client = new VotingAnalysisClient();
  const cnBaseUrl = 'http://scp-wiki-cn.wikidot.com';
  
  console.log('🗳️ 分析投票变化检测机制\n');

  try {
    // 1. 测试投票过滤能力
    await client.testVoteTimeFiltering();
    
    // 2. 分析实际投票数据模式
    const analysis = await client.analyzeVotingPatterns(cnBaseUrl);
    
    // 3. 提出解决方案
    await client.proposeVotingSyncSolutions();

  } catch (error) {
    console.error('❌ 分析失败:', error.message);
    if (error.response?.errors) {
      console.error('Response errors:', error.response.errors.map(e => e.message));
    }
  }
}

// 运行分析
analyzeVotingChanges().catch(console.error);