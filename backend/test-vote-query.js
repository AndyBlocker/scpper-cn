import { GraphQLClient } from 'graphql-request';
import dotenv from 'dotenv';

dotenv.config();

const cromClient = new GraphQLClient('https://apiv2.crom.avn.sh/graphql');

// 测试投票查询
async function testVoteQuery() {
  console.log('🧪 测试投票查询...');
  
  // 选一个肯定有投票的页面进行测试
  const testPageUrl = 'http://scp-wiki-cn.wikidot.com/scp-173';
  
  const query = `
    query TestVoteQuery($pageUrl: URL!, $first: Int) {
      wikidotPage(url: $pageUrl) {
        title
        rating
        voteCount
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
  
  try {
    console.log(`📋 查询页面: ${testPageUrl}`);
    const result = await cromClient.request(query, { 
      pageUrl: testPageUrl, 
      first: 5 
    });
    
    console.log('✅ 查询成功！');
    console.log(`📄 页面标题: ${result.wikidotPage?.title}`);
    console.log(`⭐ 评分: ${result.wikidotPage?.rating}`);
    console.log(`🗳️  投票数: ${result.wikidotPage?.voteCount}`);
    
    const voteData = result.wikidotPage?.fuzzyVoteRecords;
    if (voteData && voteData.edges) {
      console.log(`📊 获取到投票记录: ${voteData.edges.length} 条`);
      console.log(`🔄 有下一页: ${voteData.pageInfo.hasNextPage}`);
      
      if (voteData.edges.length > 0) {
        console.log('📝 前几条投票记录:');
        voteData.edges.forEach((edge, index) => {
          const vote = edge.node;
          console.log(`  ${index + 1}. 投票者: ${vote.user?.displayName || '未知'} (${vote.userWikidotId}), 方向: ${vote.direction}, 时间: ${vote.timestamp}`);
        });
      }
    } else {
      console.log('❌ 未获取到投票数据');
      console.log('📊 返回结果:', JSON.stringify(result, null, 2));
    }
    
  } catch (error) {
    console.error('❌ 查询失败:', error.message);
    if (error.response) {
      console.error('📋 错误详情:', JSON.stringify(error.response, null, 2));
    }
  }
}

testVoteQuery().catch(console.error);