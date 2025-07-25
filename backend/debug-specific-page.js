import { ProductionSync } from './src/sync/production-sync.js';

async function debugSpecificPage() {
  console.log('🔍 调试特定页面的投票问题...');
  
  const sync = new ProductionSync({ voteOnly: true });
  const problematicUrl = 'http://scp-wiki-cn.wikidot.com/20230301';
  
  try {
    // 1. 先查询页面基本信息
    console.log(`📋 查询页面基本信息: ${problematicUrl}`);
    
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
    
    const pageInfo = await sync.cromClient.request(pageInfoQuery, { pageUrl: problematicUrl });
    const page = pageInfo.wikidotPage;
    
    if (!page) {
      console.log('❌ 页面不存在或无法访问');
      return;
    }
    
    console.log('📄 页面基本信息:');
    console.log(`   标题: ${page.title}`);
    console.log(`   评分: ${page.rating}`);
    console.log(`   投票数: ${page.voteCount}`);
    console.log(`   标签: ${page.tags?.join(', ') || '无'}`);
    console.log(`   创建时间: ${page.createdAt}`);
    
    // 2. 尝试不同的投票查询方法
    console.log('\\n🗳️  测试不同的投票查询方法...');
    
    // 方法1: fuzzyVoteRecords (当前使用的)
    console.log('\\n📊 方法1: fuzzyVoteRecords');
    let fuzzyResult;
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
      
      fuzzyResult = await sync.cromClient.request(fuzzyQuery, { 
        pageUrl: problematicUrl, 
        first: 50 
      });
      
      const fuzzyVotes = fuzzyResult.wikidotPage?.fuzzyVoteRecords;
      console.log(`   返回的投票数: ${fuzzyVotes?.edges?.length || 0}`);
      console.log(`   hasNextPage: ${fuzzyVotes?.pageInfo?.hasNextPage}`);
      console.log(`   endCursor: ${fuzzyVotes?.pageInfo?.endCursor}`);
      
      if (fuzzyVotes?.edges?.length > 0) {
        console.log('   前3条投票:');
        fuzzyVotes.edges.slice(0, 3).forEach((edge, i) => {
          const vote = edge.node;
          console.log(`     ${i+1}. ${vote.user?.displayName || '未知'} (${vote.userWikidotId}): ${vote.direction} at ${vote.timestamp}`);
        });
      }
    } catch (error) {
      console.log(`   ❌ fuzzyVoteRecords查询失败: ${error.message}`);
    }
    
    // 方法2: 尝试获取总的投票统计
    console.log('\\n📊 方法2: 投票统计信息');
    try {
      const statsQuery = `
        query GetVoteStats($pageUrl: URL!) {
          wikidotPage(url: $pageUrl) {
            voteCount
            upvoteCount
            downvoteCount
            rating
          }
        }
      `;
      
      const statsResult = await sync.cromClient.request(statsQuery, { pageUrl: problematicUrl });
      const stats = statsResult.wikidotPage;
      
      console.log(`   总投票数: ${stats?.voteCount}`);
      console.log(`   正面投票: ${stats?.upvoteCount}`);
      console.log(`   负面投票: ${stats?.downvoteCount}`);
      console.log(`   最终评分: ${stats?.rating}`);
      
    } catch (error) {
      console.log(`   ❌ 统计查询失败: ${error.message}`);
    }
    
    // 3. 检查页面是否有特殊状态
    console.log('\\n🔍 诊断可能的问题:');
    
    if (page.tags?.includes('deleted')) {
      console.log('   ⚠️  页面可能已被删除，投票记录可能不可访问');
    }
    
    if (page.voteCount > 0 && (!fuzzyResult.wikidotPage?.fuzzyVoteRecords?.edges || fuzzyResult.wikidotPage.fuzzyVoteRecords.edges.length === 0)) {
      console.log('   ⚠️  页面显示有投票但API返回空结果');
      console.log('   可能原因:');
      console.log('     - API权限问题');
      console.log('     - fuzzyVoteRecords数据延迟');
      console.log('     - 页面状态特殊（被隐藏、私有等）');
      console.log('     - API内部错误');
    }
    
    // 4. 尝试使用ProductionSync的方法
    console.log('\\n🔧 使用ProductionSync方法测试...');
    try {
      const voteResult = await sync.fetchPageVotesWithResume(problematicUrl, page.voteCount);
      console.log(`   fetchPageVotesWithResume结果:`);
      console.log(`     获取投票数: ${voteResult.votes?.length || 0}`);
      console.log(`     是否完整: ${voteResult.isComplete}`);
      console.log(`     是否跳过: ${voteResult.skipped}`);
      console.log(`     错误信息: ${voteResult.error || '无'}`);
      
    } catch (error) {
      console.log(`   ❌ ProductionSync方法失败: ${error.message}`);
    }
    
  } catch (error) {
    console.error(`❌ 调试失败: ${error.message}`);
    console.error(error.stack);
  }
}

debugSpecificPage().catch(console.error);