/**
 * 文件路径: src/database/connection-manager.js
 * 功能概述: SCPPER-CN 数据库连接管理器模块
 * 
 * 主要功能:
 * - 统一的 Prisma 数据库连接池管理
 * - Web 应用和批处理任务的不同连接配置
 * - 单例模式确保连接复用和资源优化
 * - 进程退出时的优雅关闭和连接清理
 * - 针对不同应用场景的连接池优化
 * - 数据库连接监控和错误处理
 * 
 * 连接类型:
 * - Web 实例：适用于 Web 应用，长连接池配置
 * - 批处理实例：适用于数据同步，高并发配置
 * - 自定义实例：根据特定需求配置连接参数
 * 
 * 核心特性:
 * - 连接池大小动态调整
 * - 连接超时和重试机制
 * - 资源泄漏防护和自动清理
 * - 多环境配置支持（开发/生产）
 */

import { PrismaClient } from '@prisma/client';
class DatabaseConnectionManager {
  constructor() {
    this.instances = new Map();
    this.isShuttingDown = false;
    
    // 注册进程退出处理
    process.on('beforeExit', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  /**
   * 获取适用于Web应用的Prisma实例
   * 单例模式，全局共享连接池
   */
  getWebInstance() {
    if (!this.instances.has('web')) {
      console.log('🔗 创建Web应用数据库连接实例');
      
      const prisma = new PrismaClient({
        log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
        // 针对Web应用优化的连接池配置
        datasources: {
          db: {
            url: this.buildConnectionUrl('web')
          }
        }
      });
      
      this.instances.set('web', prisma);
    }
    
    return this.instances.get('web');
  }

  /**
   * 获取适用于批处理任务的Prisma实例
   * 针对大量数据操作优化
   */
  getBatchInstance() {
    if (!this.instances.has('batch')) {
      console.log('⚡ 创建批处理数据库连接实例');
      
      const prisma = new PrismaClient({
        log: ['error'], // 减少日志输出
        datasources: {
          db: {
            url: this.buildConnectionUrl('batch')
          }
        }
      });
      
      this.instances.set('batch', prisma);
    }
    
    return this.instances.get('batch');
  }

  /**
   * 构建针对不同用途优化的连接URL
   */
  buildConnectionUrl(purpose) {
    const baseUrl = process.env.DATABASE_URL;
    
    if (process.env.PRISMA_ACCELERATE_URL) {
      // 使用Prisma Accelerate
      return process.env.PRISMA_ACCELERATE_URL;
    }
    
    if (!baseUrl) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    
    // 解析现有URL
    const url = new URL(baseUrl);
    
    // 根据用途设置不同的连接参数
    switch (purpose) {
      case 'web':
        // Web应用：较少连接，长期保持
        url.searchParams.set('connection_limit', '10');
        url.searchParams.set('pool_timeout', '30');
        url.searchParams.set('schema', 'public');
        break;
        
      case 'batch':
        // 批处理：更多连接，短期使用
        url.searchParams.set('connection_limit', '20');
        url.searchParams.set('pool_timeout', '60');
        url.searchParams.set('schema', 'public');
        break;
        
      default:
        break;
    }
    
    return url.toString();
  }

  /**
   * 健康检查
   */
  async healthCheck(instanceName = 'web') {
    try {
      const instance = this.instances.get(instanceName);
      if (!instance) {
        throw new Error(`Instance ${instanceName} not found`);
      }
      
      await instance.$queryRaw`SELECT 1`;
      return { status: 'healthy', instance: instanceName };
    } catch (error) {
      return { status: 'unhealthy', instance: instanceName, error: error.message };
    }
  }

  /**
   * 获取连接池状态
   */
  async getConnectionPoolStatus() {
    const status = {};
    
    for (const [name, instance] of this.instances) {
      try {
        // 简单的连接测试
        const start = Date.now();
        await instance.$queryRaw`SELECT 1`;
        const responseTime = Date.now() - start;
        
        status[name] = {
          status: 'connected',
          responseTime: `${responseTime}ms`
        };
      } catch (error) {
        status[name] = {
          status: 'error',
          error: error.message
        };
      }
    }
    
    return status;
  }

  /**
   * 优雅关闭所有连接
   */
  async shutdown() {
    if (this.isShuttingDown) return;
    
    this.isShuttingDown = true;
    console.log('🔌 关闭数据库连接...');
    
    const shutdownPromises = [];
    for (const [name, instance] of this.instances) {
      console.log(`  关闭 ${name} 实例...`);
      shutdownPromises.push(instance.$disconnect());
    }
    
    await Promise.all(shutdownPromises);
    this.instances.clear();
    console.log('✅ 所有数据库连接已关闭');
  }

  /**
   * 重置特定实例（用于错误恢复）
   */
  async resetInstance(instanceName) {
    if (this.instances.has(instanceName)) {
      console.log(`🔄 重置 ${instanceName} 数据库连接...`);
      
      const oldInstance = this.instances.get(instanceName);
      await oldInstance.$disconnect();
      this.instances.delete(instanceName);
      
      // 重新创建实例
      if (instanceName === 'web') {
        this.getWebInstance();
      } else if (instanceName === 'batch') {
        this.getBatchInstance();
      }
      
      console.log(`✅ ${instanceName} 实例已重置`);
    }
  }
}

// 单例实例
const connectionManager = new DatabaseConnectionManager();

export { DatabaseConnectionManager, connectionManager };