/**
 * 文件路径: src/sync/core/base-sync.js
 * 功能概述: SCPPER-CN 基础同步类核心模块
 * 
 * 主要功能:
 * - 提供通用的同步配置和环境设置
 * - GraphQL 客户端初始化和连接管理
 * - 错误处理和重试机制的基础框架
 * - 进度显示和统计信息的通用逻辑
 * - 目录管理和文件系统操作
 * - Rate Limit 基础配置和管理
 * 
 * 核心特性:
 * - 统一的配置管理（批处理大小、超时设置等）
 * - 可继承的基础类设计，供其他同步类扩展
 * - 标准化的目录结构和文件管理
 * - 环境变量集成和配置灵活性
 * 
 * 继承类:
 * - UpdateSyncStrategyV3: 增量更新同步策略
 * - 其他专用同步策略类
 */

import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();
export class BaseSync {
  constructor(options = {}) {
    this.cromClient = new GraphQLClient('https://apiv2.crom.avn.sh/graphql');
    
    // 目录设置
    this.dataDir = './production-data';
    this.checkpointDir = './production-checkpoints';
    
    // 确保目录存在
    [this.dataDir, this.checkpointDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
    
    // 基础配置
    this.config = {
      targetSiteUrl: process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com',
      pagesBatchSize: 5,
      votesBatchSize: 100,
      maxRequestsPerSecond: 4,
      maxRetries: 15,
      retryDelayMs: 60000,
      networkRetryDelayMs: 8000,
      max429Retries: 50,
      checkpointInterval: 1000,
      rateLimitPoints: 300000,
      rateLimitWindowMs: 5 * 60 * 1000,
      ...options
    };
    
    // 统计信息
    this.stats = {
      startTime: null,
      endTime: null,
      actualSyncStartTime: null,
      pagesProcessed: 0,
      actualPagesProcessed: 0,
      votesProcessed: 0,
      usersProcessed: 0,
      batchesCompleted: 0,
      errors: [],
      requestTimes: []
    };
    
    // 数据存储
    this.data = {
      pages: [],
      voteRecords: [],
      users: [],
      attributions: [],
      revisions: [],
      alternateTitles: []
    };
    
    // 缓存
    this.userCache = new Set();
  }
  
  /**
   * 生成时间戳文件名
   */
  generateTimestamp() {
    return new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
  }
  
  /**
   * 保存数据到文件
   */
  async saveDataToFile(filename, data) {
    const filePath = path.join(this.dataDir, filename);
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    return filePath;
  }
  
  /**
   * 从文件加载数据
   */
  async loadDataFromFile(filePath) {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const rawData = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(rawData);
  }
  
  /**
   * 找到最新的数据文件
   */
  async findLatestDataFile(pattern = 'production-data-final-') {
    const files = fs.readdirSync(this.dataDir)
      .filter(file => file.startsWith(pattern) && file.endsWith('.json'))
      .map(file => ({
        name: file,
        path: path.join(this.dataDir, file),
        mtime: fs.statSync(path.join(this.dataDir, file)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime);
    
    return files.length > 0 ? files[0].path : null;
  }
  
  /**
   * 记录错误
   */
  recordError(type, error, context = {}) {
    const errorRecord = {
      type,
      error: error?.message || error || 'Unknown error',
      context,
      timestamp: new Date()
    };
    
    this.stats.errors.push(errorRecord);
    console.error(`❌ ${type}: ${errorRecord.error}`);
    
    if (context.pageUrl) {
      console.error(`   页面: ${context.pageUrl}`);
    }
  }
  
  /**
   * 记录请求时间（用于性能分析）
   */
  recordRequestTime(duration) {
    this.stats.requestTimes.push(duration);
    
    // 只保留最近1000次请求的时间记录
    if (this.stats.requestTimes.length > 1000) {
      this.stats.requestTimes.shift();
    }
  }
  
  /**
   * 获取平均请求时间
   */
  getAverageRequestTime() {
    if (this.stats.requestTimes.length === 0) return 0;
    
    const sum = this.stats.requestTimes.reduce((a, b) => a + b, 0);
    return sum / this.stats.requestTimes.length;
  }
  
  /**
   * 生成同步报告
   */
  async generateSyncReport() {
    const duration = this.stats.endTime - this.stats.startTime;
    const actualSyncDuration = this.stats.actualSyncStartTime ? 
      this.stats.endTime - this.stats.actualSyncStartTime : duration;
    
    console.log('\n📊 同步统计报告');
    console.log('='.repeat(80));
    console.log(`⏱️  总耗时: ${Math.round(duration / 1000 / 60)} 分钟`);
    console.log(`🌐 实际网络同步耗时: ${Math.round(actualSyncDuration / 1000 / 60)} 分钟`);
    console.log(`📄 页面处理: ${this.stats.pagesProcessed} 个`);
    console.log(`🆕 实际网络同步页面: ${this.stats.actualPagesProcessed} 个`);
    console.log(`🗳️  投票记录: ${this.stats.votesProcessed} 条`);
    console.log(`👥 用户数据: ${this.stats.usersProcessed} 个`);
    console.log(`📦 完成批次: ${this.stats.batchesCompleted} 个`);
    console.log(`⚡ 平均请求时间: ${Math.round(this.getAverageRequestTime())}ms`);
    
    if (this.stats.errors.length > 0) {
      console.log(`❌ 错误统计: ${this.stats.errors.length} 个`);
      
      // 按错误类型分组统计
      const errorsByType = {};
      this.stats.errors.forEach(error => {
        errorsByType[error.type] = (errorsByType[error.type] || 0) + 1;
      });
      
      Object.entries(errorsByType).forEach(([type, count]) => {
        console.log(`   ${type}: ${count} 个`);
      });
    }
    
    console.log(`✅ 同步完成时间: ${this.stats.endTime.toLocaleString()}`);
  }
  
  /**
   * 延迟执行（用于Rate Limit控制）
   */
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 执行带重试的网络请求
   */
  async executeWithRetry(operation, context = {}, maxRetries = null) {
    maxRetries = maxRetries || this.config.maxRetries;
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const startTime = Date.now();
        const result = await operation();
        const duration = Date.now() - startTime;
        
        this.recordRequestTime(duration);
        return result;
        
      } catch (error) {
        lastError = error;
        
        // Rate limit错误特殊处理
        if (error.message && error.message.includes('429')) {
          console.log(`⏳ Rate limit触发，等待 ${this.config.retryDelayMs/1000}s... (尝试 ${attempt}/${maxRetries})`);
          await this.delay(this.config.retryDelayMs);
        } else {
          console.log(`🔄 网络错误重试... (尝试 ${attempt}/${maxRetries}): ${error.message}`);
          await this.delay(this.config.networkRetryDelayMs);
        }
        
        // 最后一次尝试失败，记录错误
        if (attempt === maxRetries) {
          this.recordError('network_error', error, { 
            ...context, 
            attempts: maxRetries 
          });
        }
      }
    }
    
    throw lastError;
  }
}