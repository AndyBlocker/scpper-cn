import { GraphQLClient } from 'graphql-request';
import dotenv from 'dotenv';

dotenv.config();

// CROM GraphQL 客户端
export class CromClient {
  constructor() {
    this.endpoint = process.env.CROM_API_URL || 'https://apiv1.crom.avn.sh/graphql';
    this.client = new GraphQLClient(this.endpoint, {
      headers: {
        'User-Agent': 'scpper-cn-test/1.0',
        // 如果需要API key，在这里添加
        ...(process.env.CROM_API_KEY && {
          'Authorization': `Bearer ${process.env.CROM_API_KEY}`
        })
      }
    });
  }

  // 测试基础连接和速率限制
  async getRateLimit() {
    const query = `
      query {
        rateLimit {
          cost
          limit
          remaining
          resetAt
        }
      }
    `;
    
    return await this.client.request(query);
  }

  // 获取站点列表
  async getSites() {
    const query = `
      query {
        sites {
          type
          displayName
          url
          language
        }
      }
    `;
    
    return await this.client.request(query);
  }

  // 测试搜索页面 - 返回所有匹配结果
  async testSearchPages(baseUrl, query = "") {
    const searchQuery = `
      query TestSearchPages($query: String!, $filter: SearchPagesFilter) {
        searchPages(query: $query, filter: $filter) {
          url
          wikidotInfo {
            title
            rating
            tags
            createdAt
            category
            wikidotId
          }
        }
      }
    `;

    return await this.client.request(searchQuery, {
      query,
      filter: {
        anyBaseUrl: [baseUrl]
      }
    });
  }

  // 测试搜索用户 - 返回所有匹配结果
  async testSearchUsers(baseUrl, query = "") {
    const searchQuery = `
      query TestSearchUsers($query: String!, $filter: SearchUsersFilter) {
        searchUsers(query: $query, filter: $filter) {
          name
          wikidotInfo {
            displayName
            wikidotId
            unixName
          }
          statistics {
            rank
            totalRating
            pageCount
          }
        }
      }
    `;

    return await this.client.request(searchQuery, {
      query,
      filter: {
        anyBaseUrl: [baseUrl]
      }
    });
  }

  // 测试大批量搜索页面 - 包含投票记录
  async testBulkSearchPages(baseUrl, query = "") {
    const searchQuery = `
      query BulkSearchPages($query: String!, $filter: SearchPagesFilter) {
        searchPages(query: $query, filter: $filter) {
          url
          wikidotInfo {
            title
            rating
            voteCount
            tags
            createdAt
            category
            wikidotId
            # 测试是否能获取投票记录
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
        rateLimit {
          cost
          remaining
        }
      }
    `;

    return await this.client.request(searchQuery, {
      query,
      filter: {
        anyBaseUrl: [baseUrl]
      }
    });
  }

  // 使用传统分页方式获取页面（作为对比）
  async getPagesPaginated(baseUrl, limit = 100, after = null) {
    const query = `
      query GetPages($filter: QueryPagesFilter, $first: Int, $after: ID) {
        pages(filter: $filter, first: $first, after: $after) {
          edges {
            node {
              url
              wikidotInfo {
                title
                rating
                tags
                createdAt
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
        }
      }
    `;

    return await this.client.request(query, {
      filter: {
        url: {
          startsWith: baseUrl
        }
      },
      first: limit,
      after
    });
  }
}