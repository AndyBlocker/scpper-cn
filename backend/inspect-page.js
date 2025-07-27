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
          source
          textContent
          thumbnailUrl
          isHidden
          isUserPage
          parent {
            url
          }
          children {
            url
          }
          createdBy {
            ... on WikidotUser {
              displayName
              wikidotId
              unixName
            }
          }
          attributions {
            type
            date
            order
            user {
              displayName
              ... on UserWikidotNameReference {
                wikidotUser {
                  displayName
                  wikidotId
                  unixName
                }
              }
            }
          }
          alternateTitles {
            title
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
    console.log(`   创建者: ${page.createdBy?.displayName || '未知'} (ID: ${page.createdBy?.wikidotId || 'N/A'}, Unix: ${page.createdBy?.unixName || 'N/A'})`);
    console.log(`   评论数: ${page.commentCount}`);
    console.log(`   修订数: ${page.revisionCount}`);
    console.log(`   子页面数: ${page.children?.length || 0}`);
    console.log(`   父页面: ${page.parent?.url || '无'}`);
    console.log(`   缩略图: ${page.thumbnailUrl || '无'}`);
    console.log(`   是否隐藏: ${page.isHidden ? '是' : '否'}`);
    console.log(`   是否用户页: ${page.isUserPage ? '是' : '否'}`);
    console.log(`   标签: ${page.tags?.join(', ') || '无'}`);
    console.log(`   源代码长度: ${page.source?.length || 0} 字符`);
    console.log(`   文本内容长度: ${page.textContent?.length || 0} 字符`);
    
    // 显示子页面列表
    if (page.children && page.children.length > 0) {
      console.log(`\n   子页面列表:`);
      page.children.forEach((child, index) => {
        console.log(`   ${index + 1}. ${child.url}`);
      });
    }
    
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
      
      // 只获取前5个投票记录进行检查
      const voteResult = await sync.cromClient.request(voteQuery, { 
        pageUrl, 
        first: 5 
      });
      
      const voteData = voteResult.wikidotPage?.fuzzyVoteRecords;
      const votes = voteData?.edges || [];
      
      console.log(`   API返回投票数: ${votes.length} (仅显示前5个) / 总数: ${page.voteCount}`);
      console.log(`   有下一页: ${voteData?.pageInfo?.hasNextPage ? '是' : '否'}`);
      console.log(`   结束游标: ${voteData?.pageInfo?.endCursor || '无'}`);
      
      if (votes.length > 0) {
        console.log(`\n   投票详情 (前5个):`);
        console.log(`   ${'序号'.padEnd(4)} ${'用户名'.padEnd(20)} ${'用户ID'.padEnd(10)} ${'方向'.padEnd(4)} ${'时间'.padEnd(20)}`);
        console.log('   ' + '-'.repeat(70));
        
        votes.forEach((edge, index) => {
          const vote = edge.node;
          const direction = vote.direction === 1 ? '+1' : (vote.direction === -1 ? '-1' : '0');
          const userName = vote.user?.displayName || '未知用户';
          const timestamp = vote.timestamp.substring(0, 10); // 只显示日期部分
          
          console.log(`   ${String(index + 1).padEnd(4)} ${userName.padEnd(20)} ${String(vote.userWikidotId).padEnd(10)} ${direction.padEnd(4)} ${timestamp.padEnd(20)}`);
        });
        
        // 统计投票方向（仅针对显示的5个投票）
        const upvotes = votes.filter(edge => edge.node.direction === 1).length;
        const downvotes = votes.filter(edge => edge.node.direction === -1).length;
        const neutrals = votes.filter(edge => edge.node.direction === 0).length;
        
        console.log(`\n   样本投票统计 (前${votes.length}个):`);
        console.log(`   👍 正面投票: ${upvotes}`);
        console.log(`   👎 负面投票: ${downvotes}`);
        console.log(`   ⚪ 中性投票: ${neutrals}`);
        console.log(`   📊 样本净评分: ${upvotes - downvotes}`);
        console.log(`   📈 页面总评分: ${page.rating}`);
        
        // 时间分析（基于前5个投票）
        const timestamps = votes.map(edge => new Date(edge.node.timestamp)).filter(d => !isNaN(d));
        if (timestamps.length > 0) {
          const earliest = new Date(Math.min(...timestamps));
          const latest = new Date(Math.max(...timestamps));
          console.log(`\n   样本时间分析 (前${votes.length}个):`);
          console.log(`   📅 样本中最早投票: ${earliest.toISOString().substring(0, 10)}`);
          console.log(`   📅 样本中最新投票: ${latest.toISOString().substring(0, 10)}`);
        }
      } else {
        console.log('   ❌ API返回空的投票记录，但页面显示有投票！');
        console.log('   这可能是API数据不一致的问题。');
      }
    }
    
    // 3. 显示合著者/贡献者信息
    console.log('\n👥 合著者/贡献者信息:');
    const attributions = page.attributions || [];
    
    if (attributions.length === 0) {
      console.log('   没有贡献者记录');
    } else {
      console.log(`   发现 ${attributions.length} 条贡献记录:`);
      console.log(`   ${'类型'.padEnd(12)} ${'用户名'.padEnd(25)} ${'用户ID'.padEnd(10)} ${'Unix名'.padEnd(15)} ${'日期'.padEnd(12)} ${'顺序'}`);
      console.log('   ' + '-'.repeat(85));
      
      attributions.forEach((attr, index) => {
        // 尝试从两个位置获取用户信息
        const userName = attr.user?.displayName || '未知用户';
        const wikidotUserInfo = attr.user?.wikidotUser;
        const userId = wikidotUserInfo?.wikidotId || 'N/A';
        const unixName = wikidotUserInfo?.unixName || 'N/A';
        const wikidotDisplayName = wikidotUserInfo?.displayName || '';
        
        const date = attr.date ? attr.date.substring(0, 10) : '未知';
        const type = attr.type || '未知';
        const order = attr.order || 0;
        
        // 显示用户信息，如果有wikidot详细信息则优先显示
        const displayName = wikidotDisplayName || userName;
        const nameInfo = wikidotDisplayName && wikidotDisplayName !== userName ? 
          `${displayName}(${userName})` : displayName;
        
        console.log(`   ${type.padEnd(12)} ${nameInfo.padEnd(25)} ${String(userId).padEnd(10)} ${unixName.padEnd(15)} ${date.padEnd(12)} #${order}`);
      });
      
      // 统计贡献类型
      const typeStats = {};
      attributions.forEach(attr => {
        const type = attr.type || '未知';
        typeStats[type] = (typeStats[type] || 0) + 1;
      });
      
      console.log(`\n   贡献类型统计:`);
      Object.entries(typeStats).forEach(([type, count]) => {
        console.log(`   📝 ${type}: ${count}条`);
      });
    }
    
    // 4. 显示备用标题信息
    console.log('\n🏷️  备用标题:');
    const alternateTitles = page.alternateTitles || [];
    
    if (alternateTitles.length === 0) {
      console.log('   没有备用标题');
    } else {
      console.log(`   发现 ${alternateTitles.length} 个备用标题:`);
      alternateTitles.forEach((title, index) => {
        console.log(`   ${index + 1}. ${title.title}`);
      });
    }
    
    // 5. 测试ProductionSync方法
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