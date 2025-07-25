/**
 * 真实Rate Limit测试脚本
 * 通过逐步增加请求强度来发现真实的API限制
 */

import { GraphQLClient } from 'graphql-request';
import 'dotenv/config';

class RealRateLimitTester {
  constructor() {
    this.cromClient = new GraphQLClient('https://apiv2.crom.avn.sh/graphql');
    
    this.config = {
      targetSite: process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com',
      sampleSize: 150,           // 测试用的页面数量
      votesBatchSize: 100,       // 投票批次大小
      initialRequestsPerSecond: 1, // 初始请求频率
      maxRequestsPerSecond: 10,  // 最大测试频率
      stepIncrement: 0.5,        // 每次增加0.5 req/s
      testDurationPerStep: 120,  // 每个强度测试2分钟
      rateLimitDetectionThreshold: 3 // 连续3次429错误就认为达到限制
    };
    
    this.testResults = {
      startTime: null,
      endTime: null,
      steps: [], // 每个测试强度的结果
      realRateLimit: null,
      optimalRequestRate: null
    };
    
    this.currentStep = {
      requestsPerSecond: 0,
      startTime: null,
      totalRequests: 0,
      successfulRequests: 0,
      rateLimitErrors: 0,
      consecutive429Errors: 0,
      responseTimes: [],
      totalVotes: 0,
      errorDetails: []
    };
    
    this.samplePages = [];
  }

  async run() {
    console.log('🧪 真实Rate Limit测试开始');
    console.log('='.repeat(60));
    console.log(`🎯 目标站点: ${this.config.targetSite}`);
    console.log(`📊 样本大小: ${this.config.sampleSize}页`);
    console.log(`🗳️  投票批次: ${this.config.votesBatchSize}`);
    console.log(`⚡ 测试范围: ${this.config.initialRequestsPerSecond}-${this.config.maxRequestsPerSecond} req/s`);
    console.log(`⏱️  每步时长: ${this.config.testDurationPerStep}秒`);
    console.log('');

    this.testResults.startTime = Date.now();
    
    try {
      // 准备测试数据
      await this.prepareSamplePages();
      
      // 逐步增加请求强度进行测试
      await this.runSteppedRateLimitTest();
      
      // 分析结果
      this.analyzeResults();
      
    } catch (error) {
      console.error('❌ 测试过程发生严重错误:', error);
    } finally {
      this.testResults.endTime = Date.now();
      this.generateFinalReport();
    }
  }

  async prepareSamplePages() {
    console.log('📥 准备测试页面样本...');
    
    // 获取有投票的页面
    const pagesQuery = `
      query GetPagesWithVotes($filter: PageQueryFilter, $first: Int, $after: ID) {
        pages(filter: $filter, first: $first, after: $after) {
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
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;
    
    // 分批获取，使用cursor分页避免在准备阶段就触发限制
    let cursor = null;
    const batchSize = 50;
    let attempts = 0;
    const maxAttempts = 10;
    
    const filter = {
      onWikidotPage: {
        url: { startsWith: this.config.targetSite }
      }
    };
    
    while (this.samplePages.length < this.config.sampleSize && attempts < maxAttempts) {
      try {
        const result = await this.cromClient.request(pagesQuery, {
          filter,
          first: batchSize,
          after: cursor
        });
        
        if (result.pages?.edges) {
          const pages = result.pages.edges
            .map(edge => edge.node)
            .filter(page => page.voteCount > 0 && page.voteCount <= 200); // 选择中等投票数的页面
          
          this.samplePages.push(...pages);
          
          if (result.pages.pageInfo.hasNextPage) {
            cursor = result.pages.pageInfo.endCursor;
          } else {
            break; // 没有更多页面了
          }
        } else {
          break;
        }
        
        attempts++;
        console.log(`   获得 ${this.samplePages.length}/${this.config.sampleSize} 个有效页面`);
        
        // 准备阶段使用较慢速度
        await this.sleep(2000);
        
      } catch (error) {
        console.log(`⚠️  准备阶段遇到错误: ${error.message}`);
        await this.sleep(5000);
        attempts++;
      }
    }
    
    // 随机打乱并选择最终样本
    this.samplePages = this.shuffleArray(this.samplePages).slice(0, this.config.sampleSize);
    
    console.log(`✅ 样本准备完成: ${this.samplePages.length}个页面`);
    console.log(`📊 投票数范围: ${Math.min(...this.samplePages.map(p => p.voteCount))} - ${Math.max(...this.samplePages.map(p => p.voteCount))}`);
    console.log('');
  }

  async runSteppedRateLimitTest() {
    console.log('🚀 开始分步rate limit测试...');
    
    let currentRate = this.config.initialRequestsPerSecond;
    let rateLimitReached = false;
    
    while (currentRate <= this.config.maxRequestsPerSecond && !rateLimitReached) {
      console.log(`\n⚡ 测试频率: ${currentRate} req/s`);
      console.log('-'.repeat(40));
      
      // 重置当前步骤统计
      this.resetCurrentStep(currentRate);
      
      const stepResult = await this.testRequestRate(currentRate);
      this.testResults.steps.push(stepResult);
      
      // 分析本步结果
      this.analyzeStepResult(stepResult);
      
      // 检查是否达到rate limit
      if (stepResult.rateLimitHit) {
        console.log(`🛑 检测到rate limit，停止测试`);
        this.testResults.realRateLimit = currentRate;
        rateLimitReached = true;
      } else {
        console.log(`✅ ${currentRate} req/s 测试通过`);
      }
      
      currentRate += this.config.stepIncrement;
      
      // 步骤间等待，让API恢复
      if (!rateLimitReached) {
        console.log('⏸️  等待API恢复...');
        await this.sleep(30000); // 等待30秒
      }
    }
    
    // 确定最优请求速率（rate limit的80%）
    if (this.testResults.realRateLimit) {
      this.testResults.optimalRequestRate = this.testResults.realRateLimit * 0.8;
    }
  }

  async testRequestRate(requestsPerSecond) {
    const testEndTime = Date.now() + (this.config.testDurationPerStep * 1000);
    const requestInterval = 1000 / requestsPerSecond;
    
    let pageIndex = 0;
    let lastRequestTime = 0;
    
    while (Date.now() < testEndTime && !this.isRateLimitReached()) {
      const now = Date.now();
      
      // 控制请求频率
      if (now - lastRequestTime < requestInterval) {
        await this.sleep(requestInterval - (now - lastRequestTime));
      }
      
      // 选择页面（循环使用样本）
      const page = this.samplePages[pageIndex % this.samplePages.length];
      pageIndex++;
      
      try {
        await this.testSinglePageVotes(page);
        lastRequestTime = Date.now();
        
        // 实时显示进度
        this.showProgress(testEndTime);
        
      } catch (error) {
        this.handleRequestError(error);
        
        // 如果连续遇到太多429错误，提前结束
        if (this.isRateLimitReached()) {
          break;
        }
        
        lastRequestTime = Date.now();
      }
    }
    
    return this.getCurrentStepResult();
  }

  async testSinglePageVotes(page) {
    const startTime = Date.now();
    
    // 获取页面投票的第一批（测试请求）
    const query = `
      query TestPageVotes($pageUrl: URL!, $first: Int) {
        wikidotPage(url: $pageUrl) {
          fuzzyVoteRecords(first: $first) {
            edges {
              node {
                userWikidotId
                direction
                timestamp
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      }
    `;
    
    const result = await this.cromClient.request(query, {
      pageUrl: page.url,
      first: Math.min(this.config.votesBatchSize, page.voteCount)
    });
    
    const responseTime = Date.now() - startTime;
    
    // 记录统计
    this.currentStep.totalRequests++;
    this.currentStep.successfulRequests++;
    this.currentStep.responseTimes.push(responseTime);
    this.currentStep.consecutive429Errors = 0; // 重置连续错误计数
    
    const votes = result.wikidotPage?.fuzzyVoteRecords?.edges || [];
    this.currentStep.totalVotes += votes.length;
    
    return result;
  }

  handleRequestError(error) {
    this.currentStep.totalRequests++;
    
    if (error.message.includes('429')) {
      this.currentStep.rateLimitErrors++;
      this.currentStep.consecutive429Errors++;
      
      console.log(`⚠️  429错误 (连续${this.currentStep.consecutive429Errors}次)`);
      
    } else {
      this.currentStep.consecutive429Errors = 0;
      this.currentStep.errorDetails.push({
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  isRateLimitReached() {
    return this.currentStep.consecutive429Errors >= this.config.rateLimitDetectionThreshold;
  }

  resetCurrentStep(requestsPerSecond) {
    this.currentStep = {
      requestsPerSecond,
      startTime: Date.now(),
      totalRequests: 0,
      successfulRequests: 0,
      rateLimitErrors: 0,
      consecutive429Errors: 0,
      responseTimes: [],
      totalVotes: 0,
      errorDetails: []
    };
  }

  getCurrentStepResult() {
    const duration = Date.now() - this.currentStep.startTime;
    const avgResponseTime = this.currentStep.responseTimes.length > 0 
      ? this.currentStep.responseTimes.reduce((a, b) => a + b, 0) / this.currentStep.responseTimes.length 
      : 0;
    
    return {
      requestsPerSecond: this.currentStep.requestsPerSecond,
      duration: duration / 1000, // 转换为秒
      totalRequests: this.currentStep.totalRequests,
      successfulRequests: this.currentStep.successfulRequests,
      rateLimitErrors: this.currentStep.rateLimitErrors,
      successRate: (this.currentStep.successfulRequests / this.currentStep.totalRequests * 100).toFixed(1),
      avgResponseTime: Math.round(avgResponseTime),
      totalVotes: this.currentStep.totalVotes,
      actualRequestRate: this.currentStep.totalRequests / (duration / 1000),
      rateLimitHit: this.isRateLimitReached(),
      errorDetails: [...this.currentStep.errorDetails]
    };
  }

  showProgress(testEndTime) {
    const now = Date.now();
    const elapsed = now - this.currentStep.startTime;
    const remaining = Math.max(0, testEndTime - now);
    const progress = (elapsed / (elapsed + remaining) * 100).toFixed(1);
    
    const successRate = this.currentStep.totalRequests > 0 
      ? (this.currentStep.successfulRequests / this.currentStep.totalRequests * 100).toFixed(1) 
      : 0;
    
    process.stdout.write(`\r📊 ${progress}% | 请求: ${this.currentStep.totalRequests} | 成功率: ${successRate}% | 429错误: ${this.currentStep.rateLimitErrors} | 剩余: ${Math.ceil(remaining/1000)}s`);
  }

  analyzeStepResult(result) {
    console.log(`\n📈 ${result.requestsPerSecond} req/s 测试结果:`);
    console.log(`   总请求: ${result.totalRequests}`);
    console.log(`   成功率: ${result.successRate}%`);  
    console.log(`   平均响应时间: ${result.avgResponseTime}ms`);
    console.log(`   429错误: ${result.rateLimitErrors}`);
    console.log(`   实际请求速率: ${result.actualRequestRate.toFixed(2)} req/s`);
    console.log(`   获取投票数: ${result.totalVotes}`);
    
    if (result.rateLimitHit) {
      console.log(`   ❌ Rate limit 触发!`);
    } else {
      console.log(`   ✅ 未触发限制`);
    }
  }

  analyzeResults() {
    console.log('\n📊 整体分析结果');
    console.log('='.repeat(50));
    
    const successfulSteps = this.testResults.steps.filter(step => !step.rateLimitHit);
    const failedSteps = this.testResults.steps.filter(step => step.rateLimitHit);
    
    console.log(`✅ 成功测试步骤: ${successfulSteps.length}`);
    console.log(`❌ 触发限制步骤: ${failedSteps.length}`);
    
    if (successfulSteps.length > 0) {
      const maxSafeRate = Math.max(...successfulSteps.map(s => s.requestsPerSecond));
      console.log(`🛡️  最大安全请求速率: ${maxSafeRate} req/s`);
    }
    
    if (this.testResults.realRateLimit) {
      console.log(`🚫 检测到的rate limit: ${this.testResults.realRateLimit} req/s`);
      console.log(`⚡ 建议使用速率: ${this.testResults.optimalRequestRate.toFixed(2)} req/s (80%)`);
    }
  }

  generateFinalReport() {
    const totalDuration = (this.testResults.endTime - this.testResults.startTime) / 1000 / 60;
    
    console.log('\n📋 真实Rate Limit测试报告');
    console.log('='.repeat(60));
    console.log(`🕐 总测试时长: ${totalDuration.toFixed(1)} 分钟`);
    console.log(`📊 测试步骤数: ${this.testResults.steps.length}`);
    
    // 详细步骤报告
    console.log('\n📈 各步骤详细结果:');
    console.log('请求率 | 总请求 | 成功率 | 平均响应 | 429错误 | 状态');
    console.log('-'.repeat(60));
    
    this.testResults.steps.forEach(step => {
      const status = step.rateLimitHit ? '❌限制' : '✅通过';
      console.log(`${step.requestsPerSecond.toString().padEnd(6)} | ${step.totalRequests.toString().padEnd(6)} | ${step.successRate.padEnd(6)} | ${step.avgResponseTime.toString().padEnd(8)} | ${step.rateLimitErrors.toString().padEnd(7)} | ${status}`);
    });
    
    // 关键发现
    console.log('\n🔍 关键发现:');
    
    if (this.testResults.realRateLimit) {
      console.log(`• 实际rate limit约为: ${this.testResults.realRateLimit} req/s`);
      console.log(`• 建议生产环境使用: ${this.testResults.optimalRequestRate.toFixed(2)} req/s`);
      
      // 与官方声明对比  
      const officialLimit = 300000 / (5 * 60); // 300k points per 5 min to points per second
      const estimatedPointsPerRequest = 200; // 估算每请求消耗点数
      const officialRequestLimit = officialLimit / estimatedPointsPerRequest;
      
      console.log(`• 官方理论限制: ~${officialRequestLimit.toFixed(2)} req/s (基于300k点/5分钟)`);
      console.log(`• 实测vs理论比率: ${(this.testResults.realRateLimit / officialRequestLimit * 100).toFixed(1)}%`);
    } else {
      console.log(`• 未达到rate limit (测试范围内)`);
      console.log(`• 可以尝试更高的请求频率`);
    }
    
    // 性能统计
    const allRequests = this.testResults.steps.reduce((sum, step) => sum + step.totalRequests, 0);
    const allVotes = this.testResults.steps.reduce((sum, step) => sum + step.totalVotes, 0);
    
    console.log(`• 总请求数: ${allRequests}`);
    console.log(`• 总获取投票数: ${allVotes.toLocaleString()}`);
    console.log(`• 平均投票/分钟: ${Math.round(allVotes / totalDuration)}`);
    
    // 建议配置
    console.log('\n⚙️  建议的生产环境配置:');
    if (this.testResults.optimalRequestRate) {
      console.log(`maxRequestsPerSecond: ${Math.floor(this.testResults.optimalRequestRate * 10) / 10}`);
      console.log(`votesBatchSize: ${this.config.votesBatchSize}`);
      console.log(`networkRetryDelayMs: 8000`);
    }
  }

  shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 运行测试
const tester = new RealRateLimitTester();
tester.run().catch(console.error);