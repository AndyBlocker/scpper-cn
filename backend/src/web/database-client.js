/**
 * 文件路径: src/web/database-client.js
 * 功能概述: SCPPER-CN Web 应用数据库客户端模块
 * 
 * 主要功能:
 * - 专门为 Web 应用优化的 Prisma 数据库客户端
 * - 单例模式确保全局唯一连接池实例
 * - 针对 10-20 并发用户的连接池优化配置
 * - Web 应用场景下的数据库操作封装
 * - 优雅的连接关闭和资源清理
 * - 多环境数据库 URL 支持
 * 
 * 核心特性:
 * - 单例设计模式，避免重复连接创建
 * - Web 专用连接池配置（与批处理区分）
 * - 进程生命周期管理和自动清理
 * - 开发/生产环境的日志级别区分
 * - 数据库连接状态管理和监控
 * 
 * 适用场景:
 * - Fastify Web 服务器数据库操作
 * - API 接口的数据查询和操作
 * - 用户界面的数据展示和交互
 */

import { PrismaClient } from '@prisma/client';
class WebDatabaseClient {
  constructor() {
    if (WebDatabaseClient.instance) {
      return WebDatabaseClient.instance;
    }

    this.prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
      datasources: {
        db: {
          url: process.env.DATABASE_WEB_URL || process.env.DATABASE_URL
        }
      }
    });

    // 注册关闭处理
    process.on('beforeExit', () => this.disconnect());
    process.on('SIGINT', () => this.disconnect());
    process.on('SIGTERM', () => this.disconnect());

    WebDatabaseClient.instance = this;
  }

  /**
   * 获取Prisma客户端实例
   */
  getClient() {
    return this.prisma;
  }

  /**
   * 常用查询方法 - 获取页面列表（分页）
   */
  async getPages(options = {}) {
    const { 
      page = 1, 
      limit = 20, 
      category = null, 
      orderBy = 'rating',
      order = 'desc',
      search = null 
    } = options;

    const skip = (page - 1) * limit;
    
    const where = {
      isDeleted: false,
      ...(category && { category }),
      ...(search && {
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { url: { contains: search, mode: 'insensitive' } }
        ]
      })
    };

    const [pages, total] = await Promise.all([
      this.prisma.page.findMany({
        where,
        orderBy: { [orderBy]: order },
        skip,
        take: limit,
        select: {
          url: true,
          title: true,
          category: true,
          rating: true,
          voteCount: true,
          createdByUser: true,
          createdAt: true,
          tags: true,
          wilsonScore: true,
          upVoteRatio: true
        }
      }),
      this.prisma.page.count({ where })
    ]);

    return {
      pages,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * 获取单个页面详情
   */
  async getPage(url) {
    return await this.prisma.page.findUnique({
      where: { url, isDeleted: false },
      include: {
        voteRecords: {
          take: 100, // 限制投票记录数量
          orderBy: { timestamp: 'desc' }
        },
        attributions: {
          where: { isCurrent: true },
          orderBy: { orderIndex: 'asc' }
        },
        alternateTitles: true
      }
    });
  }

  /**
   * 获取用户统计信息
   */
  async getUser(wikidotId) {
    return await this.prisma.user.findUnique({
      where: { wikidotId },
      select: {
        wikidotId: true,
        displayName: true,
        totalRating: true,
        pageCount: true,
        pageCountScp: true,
        pageCountTale: true,
        pageCountGoiFormat: true,
        joinTime: true,
        isActive: true,
        lastAnalyzedAt: true
      }
    });
  }

  /**
   * 获取用户创建的页面
   */
  async getUserPages(wikidotId, options = {}) {
    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;

    const [pages, total] = await Promise.all([
      this.prisma.page.findMany({
        where: { 
          createdByWikidotId: wikidotId,
          isDeleted: false 
        },
        orderBy: { rating: 'desc' },
        skip,
        take: limit,
        select: {
          url: true,
          title: true,
          category: true,
          rating: true,
          voteCount: true,
          createdAt: true,
          wilsonScore: true
        }
      }),
      this.prisma.page.count({ 
        where: { 
          createdByWikidotId: wikidotId,
          isDeleted: false 
        } 
      })
    ]);

    return { pages, total };
  }

  /**
   * 搜索页面
   */
  async searchPages(query, options = {}) {
    const { limit = 20 } = options;

    return await this.prisma.page.findMany({
      where: {
        isDeleted: false,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { url: { contains: query, mode: 'insensitive' } },
          { tags: { has: query } }
        ]
      },
      orderBy: [
        { wilsonScore: 'desc' },
        { rating: 'desc' }
      ],
      take: limit,
      select: {
        url: true,
        title: true,
        category: true,
        rating: true,
        voteCount: true,
        createdByUser: true,
        tags: true,
        wilsonScore: true
      }
    });
  }

  /**
   * 获取统计数据（首页用）
   */
  async getStatistics() {
    const [
      totalPages,
      totalUsers,
      totalVotes,
      recentPages
    ] = await Promise.all([
      this.prisma.page.count({ where: { isDeleted: false } }),
      this.prisma.user.count(),
      this.prisma.voteRecord.count(),
      this.prisma.page.findMany({
        where: { isDeleted: false },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          url: true,
          title: true,
          createdByUser: true,
          rating: true,
          createdAt: true
        }
      })
    ]);

    return {
      totalPages,
      totalUsers,
      totalVotes,
      recentPages
    };
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'healthy' };
    } catch (error) {
      return { status: 'unhealthy', error: error.message };
    }
  }

  /**
   * 关闭连接
   */
  async disconnect() {
    if (this.prisma) {
      await this.prisma.$disconnect();
      console.log('🔌 Web数据库连接已关闭');
    }
  }
}

// 导出单例实例
const webDB = new WebDatabaseClient();

export { WebDatabaseClient, webDB };