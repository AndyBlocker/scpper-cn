import { PrismaClient } from '@prisma/client';

/**
 * 在 DATABASE_URL 中追加连接池参数（如果缺失）。
 * 仅对 postgresql/postgres 协议生效；其他协议原样返回。
 */
function ensureConnectionLimit(url: string, defaultLimit = 5, defaultPoolTimeout = 10): string {
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

const databaseUrl = process.env.USER_DATABASE_URL;

export const prisma = new PrismaClient({
  datasources: databaseUrl ? {
    db: { url: ensureConnectionLimit(databaseUrl) }
  } : undefined,
  log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});
