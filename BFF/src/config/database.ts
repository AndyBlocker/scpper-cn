import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';
import { config } from './index.js';

let prisma: PrismaClient;

export function createPrismaClient(): PrismaClient {
  if (prisma) {
    return prisma;
  }

  prisma = new PrismaClient({
    log: config.nodeEnv === 'development' ? ['query', 'info', 'warn', 'error'] : ['warn', 'error'],
    datasources: {
      db: {
        url: config.database.url,
      },
    },
  });

  // 添加中间件来记录慢查询
  prisma.$use(async (params, next) => {
    const before = Date.now();
    const result = await next(params);
    const after = Date.now();
    
    const queryTime = after - before;
    
    // 记录超过1秒的查询
    if (queryTime > 1000) {
      logger.warn({
        type: 'slow_query',
        model: params.model,
        action: params.action,
        duration: queryTime,
      });
    }
    
    return result;
  });

  return prisma;
}

export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    throw new Error('Prisma client not initialized. Call createPrismaClient() first.');
  }
  return prisma;
}

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info('Database connected successfully');
  } catch (error) {
    logger.error('Failed to connect to database:', error);
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    logger.info('Database disconnected successfully');
  } catch (error) {
    logger.error('Failed to disconnect from database:', error);
    throw error;
  }
}

// 健康检查
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error('Database health check failed:', error);
    return false;
  }
}