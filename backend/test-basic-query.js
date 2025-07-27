import { GraphQLClient } from 'graphql-request';

const client = new GraphQLClient('https://apiv2.crom.avn.sh/graphql');

const basicQuery = `
  query FetchPagesBasic($filter: PageQueryFilter, $first: Int, $after: ID) {
    pages(filter: $filter, first: $first, after: $after) {
      edges {
        node {
          url
          ... on WikidotPage {
            wikidotId
            title
            rating
            voteCount
            category
            tags
            createdAt
            revisionCount
            commentCount
            isHidden
            isUserPage
            thumbnailUrl
            source
            textContent
            
            createdBy {
              ... on WikidotUser {
                displayName
                wikidotId
              }
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
`;

const variables = {
  filter: {
    onWikidotPage: {
      url: { startsWith: "http://scp-wiki-cn.wikidot.com" }
    }
  },
  first: 2
};

try {
  console.log('🧪 测试基础查询...');
  const result = await client.request(basicQuery, variables);
  console.log('✅ 基础查询成功');
  console.log(`📊 获得 ${result.pages.edges.length} 个页面`);
  
  if (result.pages.edges.length > 0) {
    const firstPage = result.pages.edges[0].node;
    console.log(`📄 示例页面: ${firstPage.title} (${firstPage.url})`);
    console.log(`   评分: ${firstPage.rating}, 投票: ${firstPage.voteCount}`);
    console.log(`   源代码长度: ${firstPage.source?.length || 0}`);
  }
  
} catch (error) {
  console.log('❌ 基础查询失败:', error.message);
  console.log('详细错误:', JSON.stringify(error.response?.errors, null, 2));
}