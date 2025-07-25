import { ProductionSync } from './src/sync/production-sync.js';

async function inspectPage() {
  const pageUrl = process.argv[2];
  
  if (!pageUrl) {
    console.log('使用方法: node inspect-page.js <page-url>');
    console.log('例如: node inspect-page.js http://scp-wiki-cn.wikidot.com/173-festival');
    process.exit(1);
  }
  
  console.log('🔍 页面详情检查器');
  console.log('='.repeat(80));
  console.log(`📋 页面URL: ${pageUrl}`);
  console.log('='.repeat(80));
  
  const sync = new ProductionSync({ voteOnly: true });
  
  try {
    // 1. 获取页面完整信息
    console.log('\n📊 基本信息:');
    const pageQuery = `
      query GetPageFullInfo($pageUrl: URL!) {
        wikidotPage(url: $pageUrl) {
          title
          rating
          voteCount
          createdAt
          tags
          commentCount
          revisionCount
          createdBy {
            ... on WikidotUser {
              displayName
              wikidotId
            }
          }
        }
      }
    `;
    
    const pageResult = await sync.cromClient.request(pageQuery, { pageUrl });
    const page = pageResult.wikidotPage;
    
    if (!page) {
      console.log('❌ 页面不存在或无法访问');
      process.exit(1);
    }
    
    console.log(`   标题: ${page.title}`);
    console.log(`   评分: ${page.rating}`);
    console.log(`   投票数: ${page.voteCount}`);
    console.log(`   创建时间: ${page.createdAt}`);
    console.log(`   创建者: ${page.createdBy?.displayName || '未知'} (${page.createdBy?.wikidotId || 'N/A'})`);
    console.log(`   评论数: ${page.commentCount}`);
    console.log(`   修订数: ${page.revisionCount}`);
    console.log(`   标签: ${page.tags?.join(', ') || '无'}`);
    
    // 2. 获取投票记录
    console.log('\n🗳️  投票记录:');
    
    if (page.voteCount === 0) {
      console.log('   该页面没有投票记录');
    } else {
      const voteQuery = `
        query GetPageVotes($pageUrl: URL!, $first: Int) {
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
      
      // 获取所有投票（使用较大的数字确保获取全部）
      const voteResult = await sync.cromClient.request(voteQuery, { 
        pageUrl, 
        first: Math.max(100, page.voteCount * 2) 
      });
      
      const voteData = voteResult.wikidotPage?.fuzzyVoteRecords;
      const votes = voteData?.edges || [];
      
      console.log(`   API返回投票数: ${votes.length}/${page.voteCount}`);
      console.log(`   有下一页: ${voteData?.pageInfo?.hasNextPage ? '是' : '否'}`);
      console.log(`   结束游标: ${voteData?.pageInfo?.endCursor || '无'}`);
      
      if (votes.length > 0) {
        console.log(`\n   投票详情:`);
        console.log(`   ${'序号'.padEnd(4)} ${'用户名'.padEnd(20)} ${'用户ID'.padEnd(10)} ${'方向'.padEnd(4)} ${'时间'.padEnd(20)}`);
        console.log('   ' + '-'.repeat(70));
        
        votes.forEach((edge, index) => {
          const vote = edge.node;
          const direction = vote.direction === 1 ? '+1' : (vote.direction === -1 ? '-1' : '0');
          const userName = vote.user?.displayName || '未知用户';
          const timestamp = vote.timestamp.substring(0, 10); // 只显示日期部分
          
          console.log(`   ${String(index + 1).padEnd(4)} ${userName.padEnd(20)} ${String(vote.userWikidotId).padEnd(10)} ${direction.padEnd(4)} ${timestamp.padEnd(20)}`);
        });
        
        // 统计投票方向
        const upvotes = votes.filter(edge => edge.node.direction === 1).length;
        const downvotes = votes.filter(edge => edge.node.direction === -1).length;
        const neutrals = votes.filter(edge => edge.node.direction === 0).length;
        
        console.log(`\n   投票统计:`);
        console.log(`   👍 正面投票: ${upvotes}`);
        console.log(`   👎 负面投票: ${downvotes}`);
        console.log(`   ⚪ 中性投票: ${neutrals}`);
        console.log(`   📊 净评分: ${upvotes - downvotes} (应该等于rating: ${page.rating})`);
        
        if (upvotes - downvotes !== page.rating) {
          console.log(`   ⚠️  计算的净评分与页面rating不匹配！`);
        }
        
        // 时间分析
        const timestamps = votes.map(edge => new Date(edge.node.timestamp)).filter(d => !isNaN(d));
        if (timestamps.length > 0) {
          const earliest = new Date(Math.min(...timestamps));
          const latest = new Date(Math.max(...timestamps));
          console.log(`\n   时间分析:`);
          console.log(`   📅 最早投票: ${earliest.toISOString().substring(0, 10)}`);
          console.log(`   📅 最新投票: ${latest.toISOString().substring(0, 10)}`);
        }
      } else {
        console.log('   ❌ API返回空的投票记录，但页面显示有投票！');
        console.log('   这可能是API数据不一致的问题。');
      }
    }
    
    // 3. 测试ProductionSync方法
    console.log('\n🔧 ProductionSync测试:');
    try {
      const syncResult = await sync.fetchPageVotesWithResume(pageUrl, page.voteCount);
      console.log(`   fetchPageVotesWithResume结果:`);
      console.log(`   - 获取投票数: ${syncResult.votes?.length || 0}`);
      console.log(`   - 是否完整: ${syncResult.isComplete}`);
      console.log(`   - 是否跳过: ${syncResult.skipped}`);
      console.log(`   - 错误信息: ${syncResult.error || '无'}`);
      
      if (syncResult.votes && syncResult.votes.length !== page.voteCount) {
        console.log(`   ⚠️  ProductionSync获取的投票数与页面显示不匹配！`);
      }
    } catch (error) {
      console.log(`   ❌ ProductionSync测试失败: ${error.message}`);
    }
    
  } catch (error) {
    console.error(`❌ 检查失败: ${error.message}`);
    console.error(error.stack);
  }
}

inspectPage().catch(console.error);