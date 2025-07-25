/**
 * 小规模Rate Limit测试脚本 - 仅测试3个页面
 * 用于验证GraphQL查询和基本功能
 */

import { GraphQLClient } from 'graphql-request';
import 'dotenv/config';

class SmallRateLimitTester {
  constructor() {
    this.cromClient = new GraphQLClient('https://apiv2.crom.avn.sh/graphql');
    
    this.config = {
      targetSite: process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com',
      sampleSize: 3,             // 只测试3个页面
      votesBatchSize: 50,        // 投票批次大小
      maxRequestsPerSecond: 2,   // 保守的请求频率
      testDurationSeconds: 30    // 每个页面最多测试30秒
    };
    
    this.stats = {
      startTime: null,
      endTime: null,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalVotes: 0,
      requestTimes: [],
      errors: []
    };
    
    this.samplePages = [];
  }

  async run() {
    console.log('🧪 小规模Rate Limit测试');
    console.log('='.repeat(40));
    console.log(`📊 样本大小: ${this.config.sampleSize}页`);
    console.log(`🗳️  投票批次: ${this.config.votesBatchSize}`);
    console.log(`⚡ 请求频率: ${this.config.maxRequestsPerSecond} req/s`);
    console.log('');

    this.stats.startTime = Date.now();
    
    try {
      // 获取测试页面
      await this.getSamplePages();
      
      // 测试投票数据获取
      await this.testVoteFetching();
      
      // 输出结果
      this.generateReport();
      
    } catch (error) {
      console.error('❌ 测试过程发生错误:', error);
      this.stats.errors.push({
        message: error.message,
        timestamp: new Date().toISOString()
      });
    } finally {
      this.stats.endTime = Date.now();
    }
  }

  async getSamplePages() {
    console.log('📥 获取测试页面...');
    
    const pagesQuery = `
      query GetPagesWithVotes($filter: PageQueryFilter, $first: Int) {
        pages(filter: $filter, first: $first) {
          edges {
            node {
              url
              ... on WikidotPage {
                wikidotId  
                title
                voteCount
                rating
                category
              }
            }
          }
        }
      }
    `;
    
    const filter = {
      onWikidotPage: {
        url: { startsWith: this.config.targetSite }
      }
    };
    
    try {
      const result = await this.makeRequest(pagesQuery, {
        filter,
        first: 20 // 获取20个页面用于筛选
      });
      
      if (result.pages?.edges) {
        // 筛选有投票的页面
        const validPages = result.pages.edges
          .map(edge => edge.node)
          .filter(page => page.voteCount > 0 && page.voteCount <= 100) // 选择中小投票数的页面
          .slice(0, this.config.sampleSize);
        
        this.samplePages = validPages;
        
        console.log(`✅ 获得 ${this.samplePages.length} 个测试页面:`);
        this.samplePages.forEach((page, i) => {
          console.log(`   ${i + 1}. ${page.title} (${page.voteCount}票)`);
        });
        console.log('');
        
      } else {
        throw new Error('未能获取页面数据');
      }
      
    } catch (error) {
      console.error('❌ 获取页面失败:', error.message);
      throw error;
    }
  }

  async testVoteFetching() {
    console.log('🗳️  开始投票数据获取测试...');
    
    for (let i = 0; i < this.samplePages.length; i++) {
      const page = this.samplePages[i];
      console.log(`\n📄 测试页面 ${i + 1}/${this.samplePages.length}: ${page.title}`);
      
      try {
        const voteResult = await this.fetchPageVotes(page.url, page.voteCount);
        
        if (voteResult.success) {
          this.stats.totalVotes += voteResult.votesCount;
          console.log(`   ✅ 成功获取 ${voteResult.votesCount}/${page.voteCount} 票`);
          console.log(`   ⏱️  用时: ${voteResult.duration}ms`);
          console.log(`   📊 请求数: ${voteResult.requestCount}`);
        } else {
          console.log(`   ❌ 获取失败: ${voteResult.error}`);
        }
        
        // 控制频率
        await this.sleep(1000 / this.config.maxRequestsPerSecond);
        
      } catch (error) {
        console.log(`   ❌ 页面处理异常: ${error.message}`);
        this.stats.errors.push({
          pageUrl: page.url,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  async fetchPageVotes(pageUrl, expectedVoteCount) {
    const startTime = Date.now();
    let allVotes = [];
    let cursor = null;
    let hasNextPage = true;
    let requestCount = 0;
    
    try {
      while (hasNextPage && allVotes.length < expectedVoteCount) {
        const query = `
          query FetchPageVotes($pageUrl: URL!, $first: Int, $after: ID) {
            wikidotPage(url: $pageUrl) {
              fuzzyVoteRecords(first: $first, after: $after) {
                edges {
                  node {
                    userWikidotId
                    direction
                    timestamp
                    user {
                      wikidotId
                      displayName
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `;
        
        const variables = {
          pageUrl,
          first: this.config.votesBatchSize,
          after: cursor
        };
        
        const result = await this.makeRequest(query, variables);
        const voteData = result.wikidotPage?.fuzzyVoteRecords;
        
        if (!voteData || !voteData.edges.length) {
          break;
        }
        
        const batchVotes = voteData.edges.map(edge => edge.node);
        allVotes.push(...batchVotes);
        
        hasNextPage = voteData.pageInfo.hasNextPage;
        cursor = voteData.pageInfo.endCursor;
        requestCount++;
        
        console.log(`     📥 批次 ${requestCount}: 获得 ${batchVotes.length} 票 (总计: ${allVotes.length})`);
      }
      
      const duration = Date.now() - startTime;
      
      return {
        success: true,
        votesCount: allVotes.length,
        requestCount,
        duration,
        expectedCount: expectedVoteCount,
        completeness: (allVotes.length / expectedVoteCount * 100).toFixed(1)
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      return {
        success: false,
        error: error.message,
        duration,
        requestCount
      };
    }
  }

  async makeRequest(query, variables) {
    const startTime = Date.now();
    
    try {
      const result = await this.cromClient.request(query, variables);
      this.stats.successfulRequests++;
      this.stats.totalRequests++;
      
      const duration = Date.now() - startTime;
      this.stats.requestTimes.push(duration);
      
      return result;
      
    } catch (error) {
      this.stats.failedRequests++;
      this.stats.totalRequests++;
      
      if (error.message.includes('429')) {
        console.log('⚠️  遇到429错误，等待5秒...');
        await this.sleep(5000);
      }
      
      throw error;
    }
  }

  generateReport() {
    const duration = (this.stats.endTime - this.stats.startTime) / 1000;
    
    console.log('\n📋 测试报告');
    console.log('='.repeat(30));
    console.log(`🕐 总耗时: ${duration.toFixed(1)} 秒`);
    console.log(`📊 测试页面: ${this.samplePages.length}`);
    console.log(`🗳️  总投票数: ${this.stats.totalVotes}`);
    console.log(`📡 总请求数: ${this.stats.totalRequests}`);
    console.log(`✅ 成功请求: ${this.stats.successfulRequests}`);
    console.log(`❌ 失败请求: ${this.stats.failedRequests}`);
    
    if (this.stats.requestTimes.length > 0) {
      const avgTime = this.stats.requestTimes.reduce((a, b) => a + b, 0) / this.stats.requestTimes.length;
      console.log(`⏱️  平均响应时间: ${avgTime.toFixed(0)}ms`);
    }
    
    const requestsPerSecond = this.stats.totalRequests / duration;
    console.log(`🚀 实际请求速率: ${requestsPerSecond.toFixed(2)} req/s`);
    
    if (this.stats.errors.length > 0) {
      console.log('\n❌ 错误详情:');
      this.stats.errors.forEach((error, i) => {
        console.log(`   ${i + 1}. ${error.error || error.message}`);
      });
    }
    
    console.log('\n✅ 小规模测试完成');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 运行测试
const tester = new SmallRateLimitTester();
tester.run().catch(console.error);