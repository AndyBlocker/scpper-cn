import { ProductionSync } from './src/sync/production-sync.js';

async function debug173Pages() {
  console.log('🔍 调试173相关页面的投票问题...');
  
  const sync = new ProductionSync({ voteOnly: true });
  
  const problematicPages = [
    'http://scp-wiki-cn.wikidot.com/173-festival',  // 显示4票但返回0票
    'http://scp-wiki-cn.wikidot.com/173love'        // 显示1票但返回0票
  ];
  
  for (const pageUrl of problematicPages) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📋 调试页面: ${pageUrl}`);
    console.log(`${'='.repeat(60)}`);
    
    try {
      // 1. 获取页面基本信息
      console.log('📊 步骤1: 获取页面基本信息');
      const pageInfoQuery = `
        query GetPageInfo($pageUrl: URL!) {
          wikidotPage(url: $pageUrl) {
            title
            rating
            voteCount
            createdAt
            tags
          }
        }
      `;
      
      const pageInfo = await sync.cromClient.request(pageInfoQuery, { pageUrl });
      const page = pageInfo.wikidotPage;
      
      if (!page) {
        console.log('❌ 页面不存在或无法访问');
        continue;
      }
      
      console.log(`   标题: ${page.title}`);
      console.log(`   评分: ${page.rating}`);
      console.log(`   投票数: ${page.voteCount}`);
      console.log(`   创建时间: ${page.createdAt}`);
      console.log(`   标签: ${page.tags?.join(', ') || '无'}`);
      
      // 2. 测试不同的投票查询方法
      console.log('\n📊 步骤2: 测试投票查询方法');
      
      // 方法1: fuzzyVoteRecords (当前使用的)
      console.log('\n   方法1: fuzzyVoteRecords (默认查询)');
      try {
        const fuzzyQuery = `
          query GetFuzzyVotes($pageUrl: URL!, $first: Int) {
            wikidotPage(url: $pageUrl) {
              fuzzyVoteRecords(first: $first) {
                edges {
                  node {
                    userWikidotId
                    direction
                    timestamp
                    user {
                      ... on WikidotUser {
                        displayName
                        wikidotId
                      }
                    }
                  }
                  cursor
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `;
        
        const fuzzyResult = await sync.cromClient.request(fuzzyQuery, { 
          pageUrl, 
          first: Math.max(10, page.voteCount) // 确保获取足够的投票
        });
        
        const fuzzyVotes = fuzzyResult.wikidotPage?.fuzzyVoteRecords;
        console.log(`     返回的投票数: ${fuzzyVotes?.edges?.length || 0}`);
        console.log(`     hasNextPage: ${fuzzyVotes?.pageInfo?.hasNextPage}`);
        console.log(`     endCursor: ${fuzzyVotes?.pageInfo?.endCursor || '无'}`);
        
        if (fuzzyVotes?.edges?.length > 0) {
          console.log('     投票记录:');
          fuzzyVotes.edges.forEach((edge, i) => {
            const vote = edge.node;
            console.log(`       ${i+1}. ${vote.user?.displayName || '未知'} (${vote.userWikidotId}): ${vote.direction} at ${vote.timestamp}`);
          });
        }
      } catch (error) {
        console.log(`     ❌ fuzzyVoteRecords查询失败: ${error.message}`);
      }
      
      // 方法2: 使用不同的参数
      console.log('\n   方法2: fuzzyVoteRecords (使用大的first参数)');
      try {
        const largeQuery = `
          query GetFuzzyVotesLarge($pageUrl: URL!) {
            wikidotPage(url: $pageUrl) {
              fuzzyVoteRecords(first: 100) {
                edges {
                  node {
                    userWikidotId
                    direction
                    timestamp
                  }
                }
              }
            }
          }
        `;
        
        const largeResult = await sync.cromClient.request(largeQuery, { pageUrl });
        const largeVotes = largeResult.wikidotPage?.fuzzyVoteRecords?.edges || [];
        console.log(`     大参数查询返回: ${largeVotes.length} 条投票`);
        
      } catch (error) {
        console.log(`     ❌ 大参数查询失败: ${error.message}`);
      }
      
      // 3. 使用ProductionSync的方法测试
      console.log('\n📊 步骤3: 使用ProductionSync方法测试');
      try {
        // 暂时禁用增量更新以确保全量获取
        const originalIncremental = sync.config.enableIncrementalUpdate;
        sync.config.enableIncrementalUpdate = false;
        
        const voteResult = await sync.fetchPageVotesWithResume(pageUrl, page.voteCount);
        
        // 恢复设置
        sync.config.enableIncrementalUpdate = originalIncremental;
        
        console.log(`   fetchPageVotesWithResume结果:`);
        console.log(`     获取投票数: ${voteResult.votes?.length || 0}`);
        console.log(`     是否完整: ${voteResult.isComplete}`);
        console.log(`     是否跳过: ${voteResult.skipped}`);
        console.log(`     错误信息: ${voteResult.error || '无'}`);
        console.log(`     下一个游标: ${voteResult.nextCursor || '无'}`);
        
        if (voteResult.votes && voteResult.votes.length > 0) {
          console.log('     实际获取的投票:');
          voteResult.votes.slice(0, 5).forEach((vote, i) => {
            console.log(`       ${i+1}. ${vote.userWikidotId}: ${vote.direction} at ${vote.timestamp}`);
          });
        }
        
      } catch (error) {
        console.log(`   ❌ ProductionSync方法失败: ${error.message}`);
      }
      
      // 4. 检查页面是否有特殊状态
      console.log('\n📊 步骤4: 诊断可能的问题');
      
      if (page.voteCount > 0) {
        console.log(`   📊 页面显示有 ${page.voteCount} 票，但API可能返回空结果`);
        console.log('   可能原因:');
        console.log('     - fuzzyVoteRecords数据不完整或延迟');
        console.log('     - 页面的投票记录被删除或隐藏');
        console.log('     - API权限或缓存问题');
        console.log('     - 页面状态异常（被删除、私有等）');
        
        if (page.tags?.includes('deleted') || page.tags?.includes('private')) {
          console.log('   ⚠️  页面可能被删除或设为私有');
        }
        
        // 检查创建时间
        const createdDate = new Date(page.createdAt);
        const daysSinceCreated = (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24);
        console.log(`   📅 页面创建于 ${daysSinceCreated.toFixed(1)} 天前`);
        
        if (daysSinceCreated < 1) {
          console.log('   ⚠️  页面创建时间很新，投票数据可能还在同步中');
        }
      }
      
    } catch (error) {
      console.error(`❌ 调试失败: ${error.message}`);
      console.error(error.stack);
    }
    
    // 等待一下避免rate limit
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('\n✅ 173页面调试完成');
}

debug173Pages().catch(console.error);