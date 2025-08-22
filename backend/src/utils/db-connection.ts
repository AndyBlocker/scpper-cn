import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// 在 ES 模块中获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载环境变量
dotenv.config({ path: path.join(__dirname, '../../.env') });

let prismaInstance: PrismaClient | null = null;

/**
 * 创建或获取PrismaClient实例
 * 使用单例模式避免创建多个连接
 */
export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is not set. Please check your .env file.');
    }
    
    prismaInstance = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl
        }
      },
      log: process.env.NODE_ENV === 'development' 
        ? ['query', 'error', 'warn'] 
        : ['error'],
      // Add connection pooling configuration
      __internal: {
        engine: {
          // Configure connection pool
          maxIdleConnections: 5,
          maxConnections: 20,
          connectionTimeout: 20000,
          maxWriteConnections: 10,
          maxReadConnections: 10,
        }
      }
    });
  }
  
  return prismaInstance;
}

/**
 * 断开数据库连接
 */
export async function disconnectPrisma(): Promise<void> {
  if (prismaInstance) {
    try {
      await prismaInstance.$disconnect();
    } catch (error) {
      console.error('Error disconnecting Prisma client:', error);
    } finally {
      prismaInstance = null;
    }
  }
}

/**
 * 处理连接错误的中间件
 */
export function handleDatabaseError(error: any): never {
  if (error.code === 'P1001') {
    throw new Error('Database connection failed. Please check your database is running and accessible.');
  } else if (error.code === 'P1008') {
    throw new Error('Database connection timeout. Too many connections may be open.');
  } else if (error.code === 'P1017') {
    throw new Error('Database connection lost. Will retry with new connection.');
  }
  throw error;
}

/**
 * 带重试机制的数据库操作执行器
 */
export async function executeWithRetry<T>(
  operation: (prisma: PrismaClient) => Promise<T>,
  maxRetries: number = 3,
  delay: number = 1000
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const prisma = getPrismaClient();
      return await operation(prisma);
    } catch (error: any) {
      lastError = error;
      console.warn(`Database operation failed (attempt ${attempt}/${maxRetries}):`, error.message);
      
      // If it's a connection error, reset the connection and try again
      if (error.code === 'P1001' || error.code === 'P1008' || error.code === 'P1017') {
        await disconnectPrisma();
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delay * attempt));
          continue;
        }
      }
      
      // For other errors, don't retry
      if (attempt >= maxRetries) {
        break;
      }
    }
  }
  
  handleDatabaseError(lastError);
}

// 处理进程退出时的数据库连接清理
process.on('SIGINT', async () => {
  console.log('Received SIGINT, disconnecting database...');
  await disconnectPrisma();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, disconnecting database...');
  await disconnectPrisma();
  process.exit(0);
});

process.on('beforeExit', async () => {
  await disconnectPrisma();
});

// 导出一个默认实例供向后兼容
export const prisma = getPrismaClient();