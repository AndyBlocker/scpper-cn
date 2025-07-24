import { CromClient } from './client.js';
import fs from 'fs';

class FullDataQueryClient extends CromClient {
  
  // 测试一次性获取页面的所有数据
  async testFullDataQuery(baseUrl) {
    console.log('🎯 测试一次性获取页面所有数据\n');
    
    const fullDataQuery = `
      query GetFullPageData($filter: QueryPagesFilter, $first: Int) {
        pages(filter: $filter, first: $first) {
          edges {
            node {
              url
              wikidotInfo {
                # 基础信息
                title
                category
                wikidotId
                createdAt
                revisionCount
                isPrivate
                commentCount
                
                # 评分和投票信息
                rating
                realtimeRating
                voteCount
                realtimeVoteCount
                
                # 完整投票历史
                coarseVoteRecords {
                  timestamp
                  userWikidotId
                  direction
                  user {
                    name
                  }
                }
                
                # 内容数据
                source
                textContent
                thumbnailUrl
                
                # 标签和分类
                tags
                
                # 修订历史
                revisions {
                  index
                  timestamp
                  type
                  comment
                  userWikidotId
                  user {
                    name
                  }
                }
                
                # 页面关系
                parent {
                  url
                  wikidotInfo {
                    title
                  }
                }
                
                children {
                  url
                  wikidotInfo {
                    title
                  }
                }
                
                # 作者信息
                createdBy {
                  name
                  wikidotInfo {
                    displayName
                    wikidotId
                  }
                }
              }
              
              # 贡献者信息
              attributions {
                type
                user {
                  name
                  wikidotInfo {
                    displayName
                    wikidotId
                  }
                }
                date
                order
                isCurrent
              }
              
              # 翻译关系
              translations {
                url
                wikidotInfo {
                  title
                }
              }
              
              translationOf {
                url
                wikidotInfo {
                  title
                }
              }
              
              # 替代标题
              alternateTitles {
                type
                title
              }
            }
            cursor
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        rateLimit {
          cost
          remaining
          resetAt
        }
      }
    `;
    
    try {
      console.log('🔍 执行完整数据查询...');
      const startTime = Date.now();
      
      const result = await this.client.request(fullDataQuery, {
        filter: {
          url: { startsWith: baseUrl }
        },
        first: 3  // 先测试3个页面
      });
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      console.log(`✅ 查询完成!`);
      console.log(`   耗时: ${duration}ms`);
      console.log(`   Cost: ${result.rateLimit.cost}`);
      console.log(`   Remaining: ${result.rateLimit.remaining}`);
      console.log(`   获取页面数: ${result.pages.edges.length}`);
      
      // 分析获取到的数据质量
      const pages = result.pages.edges.map(edge => edge.node);
      
      console.log('\n📊 数据质量分析:');
      
      let totalVoteRecords = 0;
      let totalRevisions = 0;
      let pagesWithContent = 0;
      let pagesWithAttributions = 0;
      let pagesWithTranslations = 0;
      
      pages.forEach((page, index) => {
        const info = page.wikidotInfo;
        
        // 统计数据
        totalVoteRecords += info.coarseVoteRecords?.length || 0;
        totalRevisions += info.revisions?.length || 0;
        
        if (info.source || info.textContent) pagesWithContent++;
        if (page.attributions?.length > 0) pagesWithAttributions++;
        if (page.translations?.length > 0) pagesWithTranslations++;
        
        console.log(`\n   📄 页面 ${index + 1}: ${info.title}`);
        console.log(`      URL: ${page.url}`);
        console.log(`      评分: ${info.rating} (${info.voteCount} votes)`);
        console.log(`      投票记录: ${info.coarseVoteRecords?.length || 0}`);
        console.log(`      修订记录: ${info.revisions?.length || 0}`);
        console.log(`      标签: ${info.tags?.slice(0, 3).join(', ') || 'None'}${info.tags?.length > 3 ? '...' : ''}`);
        console.log(`      创建者: ${info.createdBy?.name || 'Unknown'}`);
        console.log(`      贡献者: ${page.attributions?.length || 0}个`);
        console.log(`      内容长度: ${info.source?.length || 0} chars`);
        
        if (info.coarseVoteRecords?.length > 0) {
          const latestVote = info.coarseVoteRecords[info.coarseVoteRecords.length - 1];
          console.log(`      最新投票: ${latestVote.timestamp} by ${latestVote.user?.name || latestVote.userWikidotId}`);
        }
        
        if (info.revisions?.length > 0) {
          const latestRevision = info.revisions[info.revisions.length - 1];
          console.log(`      最新修订: ${latestRevision.timestamp} (${latestRevision.type})`);
        }
      });
      
      console.log('\n📈 总体统计:');
      console.log(`   总投票记录: ${totalVoteRecords}`);
      console.log(`   总修订记录: ${totalRevisions}`);
      console.log(`   有内容的页面: ${pagesWithContent}/${pages.length}`);
      console.log(`   有贡献者的页面: ${pagesWithAttributions}/${pages.length}`);
      console.log(`   有翻译的页面: ${pagesWithTranslations}/${pages.length}`);
      
      return {
        queryDuration: duration,
        rateLimitCost: result.rateLimit.cost,
        pagesRetrieved: pages.length,
        dataQuality: {
          totalVoteRecords,
          totalRevisions,
          pagesWithContent,
          pagesWithAttributions,
          pagesWithTranslations
        },
        fullData: pages
      };
      
    } catch (error) {
      console.log(`❌ 完整数据查询失败: ${error.message}`);
      if (error.response?.errors) {
        console.log('GraphQL errors:');
        error.response.errors.forEach((err, i) => {
          console.log(`   ${i + 1}. ${err.message}`);
          if (err.path) console.log(`      Path: ${err.path.join(' -> ')}`);
        });
      }
      return null;
    }
  }
  
  // 测试增量检测的新策略
  async testIncrementalWithFullData(baseUrl) {
    console.log('\n🔄 基于完整数据的增量检测策略\n');
    
    console.log('💡 新策略思路:');
    console.log('   1. 每次查询直接获取页面的所有数据');
    console.log('   2. 本地比较完整数据判断是否有变化');
    console.log('   3. 无需分步骤：先检测->再获取详情');
    console.log('   4. 简化了逻辑，提高了效率');
    
    // 模拟增量检测流程
    console.log('\n📋 模拟增量同步流程:');
    
    // 步骤1: 获取最近更新的页面（示例：最近7天创建的）
    console.log('\n   🔍 步骤1: 获取最近变化的页面');
    try {
      const recentPagesQuery = `
        query GetRecentPagesFullData($filter: QueryPagesFilter) {
          pages(filter: $filter, first: 5) {
            edges {
              node {
                url
                wikidotInfo {
                  title
                  rating
                  voteCount
                  createdAt
                  coarseVoteRecords {
                    timestamp
                    direction
                  }
                  revisions {
                    timestamp
                    type
                  }
                }
              }
            }
          }
          rateLimit { cost }
        }
      `;
      
      const recentResult = await this.client.request(recentPagesQuery, {
        filter: {
          url: { startsWith: baseUrl },
          wikidotInfo: {
            createdAt: { gte: new Date(Date.now() - 7*24*60*60*1000).toISOString() }
          }
        }
      });
      
      console.log(`      ✅ 找到 ${recentResult.pages.edges.length} 个最近页面`);
      console.log(`      💰 Cost: ${recentResult.rateLimit.cost}`);
      
      // 步骤2: 本地数据比较（模拟）
      console.log('\n   📊 步骤2: 本地数据比较');
      const recentPages = recentResult.pages.edges.map(e => e.node);
      
      recentPages.forEach((page, i) => {
        const info = page.wikidotInfo;
        
        // 模拟本地数据比较
        const hasVotingChanges = info.coarseVoteRecords?.length > 0;
        const hasContentChanges = info.revisions?.length > 1;
        
        console.log(`      📄 ${info.title}:`);
        console.log(`         投票变化: ${hasVotingChanges ? '✅' : '❌'}`);
        console.log(`         内容变化: ${hasContentChanges ? '✅' : '❌'}`);
        
        if (hasVotingChanges) {
          const latestVote = info.coarseVoteRecords[info.coarseVoteRecords.length - 1];
          console.log(`         最新投票: ${latestVote.timestamp}`);
        }
      });
      
    } catch (error) {
      console.log(`      ❌ 最近页面查询失败: ${error.message}`);
    }
    
    // 总结新策略的优势
    console.log('\n🎯 新策略优势分析:');
    console.log('   ✅ 简化流程: 一次查询获取所有需要的数据');
    console.log('   ✅ 减少请求: 无需先检测再获取详情');
    console.log('   ✅ 降低延迟: 减少了网络往返');
    console.log('   ✅ 易于实现: 逻辑更直观，错误处理更简单');
    console.log('   ✅ 数据一致性: 避免了两次查询间的数据变化');
    
    console.log('\n💡 实际应用建议:');
    console.log('   1. 每日全量同步: 获取所有页面的完整数据');
    console.log('   2. 增量检测: 基于创建时间或修订时间查询');
    console.log('   3. 本地比较: 对比完整数据确定实际变化');
    console.log('   4. 智能更新: 只更新真正发生变化的部分');
  }
  
  // 计算不同数据获取策略的成本对比
  async calculateCostComparison() {
    console.log('\n💰 数据获取策略成本对比\n');
    
    const strategies = [
      {
        name: "旧策略: 分步检测",
        description: "先检测变化，再获取详情",
        steps: [
          { action: "检测rating变化", pages: 30849, costPerPage: 1, note: "只获取基础信息" },
          { action: "获取变化页面详情", pages: 1000, costPerPage: 10, note: "假设1000个页面有变化" }
        ]
      },
      {
        name: "新策略: 一次性获取",
        description: "直接获取所有需要的数据",
        steps: [
          { action: "获取所有页面完整数据", pages: 30849, costPerPage: 10, note: "一次性获取所有信息" }
        ]
      },
      {
        name: "混合策略: 智能增量",
        description: "结合聚合检测和完整获取",
        steps: [
          { action: "聚合统计检测", pages: 1, costPerPage: 2, note: "快速检测总体变化" },
          { action: "获取变化页面完整数据", pages: 500, costPerPage: 10, note: "基于检测结果获取" }
        ]
      }
    ];
    
    strategies.forEach((strategy, index) => {
      console.log(`${index + 1}. ${strategy.name}`);
      console.log(`   ${strategy.description}`);
      
      let totalCost = 0;
      let totalTime = 0;
      
      strategy.steps.forEach((step, stepIndex) => {
        const requests = Math.ceil(step.pages / 5); // 5页面/请求
        const cost = requests * (step.costPerPage * 5 / 5); // 标准化计算
        const time = requests / 2; // 2请求/秒
        
        totalCost += cost;
        totalTime += time;
        
        console.log(`   步骤${stepIndex + 1}: ${step.action}`);
        console.log(`      处理页面: ${step.pages}`);
        console.log(`      需要请求: ${requests}`);
        console.log(`      成本: ${cost}点`);
        console.log(`      时间: ${Math.round(time)}秒`);
        console.log(`      说明: ${step.note}`);
      });
      
      console.log(`   总成本: ${totalCost}点`);
      console.log(`   总时间: ${Math.round(totalTime)}秒 (${Math.round(totalTime/60)}分钟)`);
      console.log(`   配额占用: ${((totalCost/300000)*100).toFixed(2)}% (5分钟窗口)`);
      console.log('');
    });
    
    console.log('🎯 结论:');
    console.log('   新策略虽然单次成本更高，但简化了架构');
    console.log('   对于每日全量同步场景，复杂度和维护成本更低');
    console.log('   避免了分步检测可能遗漏变化的风险');
  }
}

async function testFullDataStrategy() {
  const client = new FullDataQueryClient();
  const cnBaseUrl = 'http://scp-wiki-cn.wikidot.com';
  
  console.log('🎯 测试一次性获取所有页面数据的策略\n');
  console.log('验证: 在查询页面rating时，是否可以同时获取所有相关信息\n');

  try {
    // 1. 测试完整数据查询
    const fullDataResult = await client.testFullDataQuery(cnBaseUrl);
    
    if (fullDataResult) {
      // 保存测试结果
      fs.writeFileSync('./results-full-data-query.json', JSON.stringify(fullDataResult, null, 2));
      console.log('\n✅ 完整数据查询结果保存到 ./results-full-data-query.json');
    }
    
    // 2. 测试基于完整数据的增量策略
    await client.testIncrementalWithFullData(cnBaseUrl);
    
    // 3. 成本对比分析
    await client.calculateCostComparison();

  } catch (error) {
    console.error('❌ 测试失败:', error.message);
    if (error.response?.errors) {
      console.error('Response errors:', error.response.errors.map(e => e.message));
    }
  }
}

// 运行测试
testFullDataStrategy().catch(console.error);