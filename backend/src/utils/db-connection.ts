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
let signalsBound = false;

/**
 * 关停屏障：收到 SIGTERM/SIGINT 后、断开数据库之前要等待的收尾工作。
 *
 * 存在的理由是这里的信号处理会 process.exit(0) —— 同一个信号上别的监听器
 * （比如「等本轮跑完再退」）根本来不及生效。需要保护关键区的调用方注册一个
 * barrier，本模块等它 resolve 后再断连接退出。
 *
 * 有超时兜底：卡住的 barrier 不该让 PM2 的 stop 一直等到强杀。
 */
type ShutdownBarrier = () => Promise<void>;
const shutdownBarriers = new Set<ShutdownBarrier>();
const SHUTDOWN_BARRIER_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.SHUTDOWN_BARRIER_TIMEOUT_MS ?? '15000') || 15000
);

export function registerShutdownBarrier(fn: ShutdownBarrier): () => void {
  shutdownBarriers.add(fn);
  return () => { shutdownBarriers.delete(fn); };
}

async function awaitShutdownBarriers(): Promise<void> {
  if (shutdownBarriers.size === 0) return;
  const all = Promise.all([...shutdownBarriers].map(async (fn) => {
    try { await fn(); } catch (error) {
      console.warn('[shutdown] barrier 执行失败：', error instanceof Error ? error.message : error);
    }
  }));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[shutdown] barrier 超过 ${SHUTDOWN_BARRIER_TIMEOUT_MS}ms 未完成，继续退出`);
      resolve();
    }, SHUTDOWN_BARRIER_TIMEOUT_MS);
    timer.unref?.();
  });
  await Promise.race([all, timeout]);
  if (timer) clearTimeout(timer);
}

/**
 * 在 DATABASE_URL 中追加连接池参数（如果缺失）。
 * Prisma Query Engine 通过 URL 参数读取 connection_limit / pool_timeout。
 * 仅对 postgresql/postgres 协议生效；其他协议（如 file: SQLite）原样返回。
 */
function ensureConnectionLimit(url: string, defaultLimit = 10, defaultPoolTimeout = 10): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') {
      return url;
    }
    if (!u.searchParams.has('connection_limit')) {
      u.searchParams.set('connection_limit', String(defaultLimit));
    }
    if (!u.searchParams.has('pool_timeout')) {
      u.searchParams.set('pool_timeout', String(defaultPoolTimeout));
    }
    return u.toString();
  } catch {
    return url;
  }
}

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
          url: ensureConnectionLimit(databaseUrl)
        }
      },
      log: process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
    });
  }
  
  if (!signalsBound) {
    // 处理进程退出时的数据库连接清理（幂等）
    const graceful = async (signal?: string) => {
      try {
        if (signal) console.log(`Received ${signal}, disconnecting database...`);
        // 先等注册过的关键区收尾，再断连接。
        // 通知投递器就有这样一段：占位 PENDING → 调机器人 → 记录结果。
        // 在中间被 process.exit 打断的话，那批候选下轮会重新入选，
        // 等机器人那 15 分钟去重窗口一过就重复推给用户。
        await awaitShutdownBarriers();
        await disconnectPrisma();
      } finally {
        if (signal) process.exit(0);
      }
    };
    process.on('SIGINT', () => { void graceful('SIGINT'); });
    process.on('SIGTERM', () => { void graceful('SIGTERM'); });
    process.on('beforeExit', () => { void graceful(); });
    signalsBound = true;
  }

  return prismaInstance;
}

/**
 * 断开数据库连接
 */
export async function disconnectPrisma(): Promise<void> {
  if (!prismaInstance) return;
  try {
    await prismaInstance.$disconnect();
  } catch (error) {
    console.error('Error disconnecting Prisma client:', error);
  } finally {
    prismaInstance = null;
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
// 导出一个默认实例供向后兼容
export const prisma = getPrismaClient();
