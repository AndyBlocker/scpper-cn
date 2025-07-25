import { ProductionSync } from './src/sync/production-sync.js';

async function analyzeVoteDiscrepancy() {
  const pageUrl = process.argv[2];
  
  if (!pageUrl) {
    console.log('使用方法: node analyze-vote-discrepancy.js <page-url>');
    console.log('例如: node analyze-vote-discrepancy.js http://scp-wiki-cn.wikidot.com/10th-noodle');
    process.exit(1);
  }
  
  console.log('🔍 投票数据差异分析器');
  console.log('='.repeat(80));
  console.log(`📋 页面URL: ${pageUrl}`);
  console.log('='.repeat(80));
  
  const sync = new ProductionSync({ voteOnly: true });
  
  try {
    // 1. 获取页面基本信息
    console.log('\n📊 页面基本信息:');
    const pageQuery = `
      query GetPageInfo($pageUrl: URL!) {
        wikidotPage(url: $pageUrl) {
          title
          rating
          voteCount
          createdAt
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
    console.log(`   投票数 (voteCount): ${page.voteCount}`);
    console.log(`   创建者: ${page.createdBy?.displayName || '未知'}`);
    console.log(`   创建时间: ${page.createdAt}`);
    
    // 2. 获取完整的 fuzzyVoteRecords
    console.log('\n🗳️  fuzzyVoteRecords 分析:');
    
    const voteQuery = `
      query GetAllVotes($pageUrl: URL!, $first: Int) {
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
    
    // 获取所有投票（使用较大的数字）
    const voteResult = await sync.cromClient.request(voteQuery, { 
      pageUrl, 
      first: Math.max(200, page.voteCount * 2) 
    });
    
    const voteData = voteResult.wikidotPage?.fuzzyVoteRecords;
    const votes = voteData?.edges || [];
    
    console.log(`   fuzzyVoteRecords 返回数量: ${votes.length}`);
    console.log(`   期望数量 (voteCount): ${page.voteCount}`);
    console.log(`   数据差异: ${page.voteCount - votes.length}`);
    console.log(`   有下一页: ${voteData?.pageInfo?.hasNextPage ? '是' : '否'}`);
    
    // 3. 详细分析差异
    console.log('\n🔬 差异原因分析:');
    
    if (votes.length === page.voteCount) {
      console.log('✅ 数据完全匹配，无差异');
    } else if (votes.length < page.voteCount) {
      const missing = page.voteCount - votes.length;
      console.log(`❌ fuzzyVoteRecords 缺少 ${missing} 条投票记录`);
      
      console.log('\n可能原因:');
      console.log('   1. fuzzyVoteRecords 数据延迟更新');
      console.log('   2. 某些投票者账户状态发生变化（被封禁/删除）');
      console.log('   3. 投票被撤销但 voteCount 尚未更新');
      console.log('   4. API 权限限制（fuzzy vs current records）');
      console.log('   5. 数据同步窗口差异');
      
    } else {
      const extra = votes.length - page.voteCount;
      console.log(`🔍 fuzzyVoteRecords 超出预期 ${extra} 条记录`);
      console.log('   这种情况很少见，可能是数据缓存问题');
    }
    
    // 4. 投票统计分析  
    if (votes.length > 0) {
      console.log('\n📈 投票统计:');
      
      const upvotes = votes.filter(edge => edge.node.direction === 1).length;
      const downvotes = votes.filter(edge => edge.node.direction === -1).length;
      const neutrals = votes.filter(edge => edge.node.direction === 0).length;
      const calculatedRating = upvotes - downvotes;
      
      console.log(`   👍 正面投票: ${upvotes}`);
      console.log(`   👎 负面投票: ${downvotes}`);
      console.log(`   ⚪ 中性投票: ${neutrals}`);
      console.log(`   📊 计算评分: ${calculatedRating}`);
      console.log(`   📊 页面评分: ${page.rating}`);
      
      if (calculatedRating !== page.rating) {
        console.log(`   ⚠️  计算评分与页面评分不匹配！差异: ${page.rating - calculatedRating}`);
      } else {
        console.log(`   ✅ 评分计算正确`);
      }
      
      // 时间分析
      const timestamps = votes.map(edge => new Date(edge.node.timestamp)).filter(d => !isNaN(d));
      if (timestamps.length > 0) {
        const earliest = new Date(Math.min(...timestamps));
        const latest = new Date(Math.max(...timestamps));
        const daysDiff = (latest - earliest) / (1000 * 60 * 60 * 24);
        
        console.log('\n📅 时间范围分析:');
        console.log(`   最早投票: ${earliest.toISOString().substring(0, 10)}`);
        console.log(`   最新投票: ${latest.toISOString().substring(0, 10)}`);
        console.log(`   时间跨度: ${Math.round(daysDiff)} 天`);
        
        // 按月统计投票分布
        const monthlyStats = {};
        timestamps.forEach(date => {
          const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          monthlyStats[month] = (monthlyStats[month] || 0) + 1;
        });
        
        console.log('\n📊 月度投票分布:');
        Object.entries(monthlyStats)
          .sort(([a], [b]) => a.localeCompare(b))
          .forEach(([month, count]) => {
            console.log(`   ${month}: ${count} 票`);
          });
      }
      
      // 用户分析
      const userStats = {};
      votes.forEach(edge => {
        const vote = edge.node;
        const userId = vote.userWikidotId;
        if (!userStats[userId]) {
          userStats[userId] = {
            name: vote.user?.displayName || '未知用户',
            votes: []
          };
        }
        userStats[userId].votes.push({
          direction: vote.direction,
          timestamp: vote.timestamp
        });
      });
      
      const duplicateVoters = Object.entries(userStats).filter(([_, data]) => data.votes.length > 1);
      if (duplicateVoters.length > 0) {
        console.log('\n⚠️  重复投票用户:');
        duplicateVoters.forEach(([userId, data]) => {
          console.log(`   ${data.name} (${userId}): ${data.votes.length} 票`);
          data.votes.forEach((vote, i) => {
            const direction = vote.direction === 1 ? '+1' : (vote.direction === -1 ? '-1' : '0');
            console.log(`     ${i+1}. ${direction} @ ${vote.timestamp.substring(0, 10)}`);
          });
        });
      }
    }
    
    console.log('\n📋 总结:');
    console.log('fuzzyVoteRecords 是历史数据快照，与实时统计存在差异属于正常现象。');
    console.log('对于数据分析和投票网络分析，这些数据仍然具有很高的价值。');
    console.log('如果需要100%准确的当前投票状态，需要 CRAWLER 权限访问 accountVoteRecords。');
    
  } catch (error) {
    console.error(`❌ 分析失败: ${error.message}`);
    console.error(error.stack);
  }
}

analyzeVoteDiscrepancy().catch(console.error);