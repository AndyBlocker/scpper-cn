import { Pool } from 'pg';

// 连接池配置
const POOL_CONFIG = {
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
};

// 主库连接池（用于写操作和需要最新数据的读操作）
let primaryPool: Pool | null = null;

// 从库连接池（用于只读查询，减少主库压力）
let replicaPool: Pool | null = null;

// 从库是否可用
let replicaAvailable = false;

/**
 * 初始化数据库连接池
 * 支持主库 + 从库的读写分离架构
 */
export function initPools(): { primary: Pool; replica: Pool | null } {
  const primaryUrl = process.env.DATABASE_URL;
  const replicaUrl = process.env.DATABASE_REPLICA_URL;

  if (!primaryUrl) {
    throw new Error('DATABASE_URL is required');
  }

  // 初始化主库连接池
  primaryPool = new Pool({
    connectionString: primaryUrl,
    ...POOL_CONFIG
  });

  primaryPool.on('error', (err) => {
    console.error('[dbPool] Primary pool error:', err.message);
  });

  // 初始化从库连接池（如果配置了）
  if (replicaUrl) {
    replicaPool = new Pool({
      connectionString: replicaUrl,
      ...POOL_CONFIG
    });

    replicaPool.on('error', (err) => {
      console.error('[dbPool] Replica pool error:', err.message);
      replicaAvailable = false;
    });

    // 测试从库连接
    replicaPool.query('SELECT 1')
      .then(() => {
        replicaAvailable = true;
        console.log('[dbPool] Replica pool initialized successfully');
      })
      .catch((err) => {
        console.warn('[dbPool] Replica pool not available, falling back to primary:', err.message);
        replicaAvailable = false;
      });

    console.log('[dbPool] Dual pool mode: primary + replica');
  } else {
    console.log('[dbPool] Single pool mode: primary only (set DATABASE_REPLICA_URL to enable read-write separation)');
  }

  return {
    primary: primaryPool,
    replica: replicaPool
  };
}

/**
 * 获取主库连接池（用于写操作）
 */
export function getPrimaryPool(): Pool {
  if (!primaryPool) {
    throw new Error('Database pools not initialized. Call initPools() first.');
  }
  return primaryPool;
}

/**
 * 获取只读连接池（优先使用从库，如果不可用则回退到主库）
 * 用于纯读操作，减少主库压力
 */
export function getReadPool(): Pool {
  if (!primaryPool) {
    throw new Error('Database pools not initialized. Call initPools() first.');
  }

  // 如果从库可用，使用从库
  if (replicaPool && replicaAvailable) {
    return replicaPool;
  }

  // 否则回退到主库
  return primaryPool;
}

/**
 * 同步获取只读连接池（供路由直接使用）
 * 这是一个便捷方法，用于在路由中直接获取读连接池
 */
export function getReadPoolSync(): Pool {
  return getReadPool();
}

/**
 * 获取连接池状态
 */
export function getPoolStatus(): {
  primary: { total: number; idle: number; waiting: number };
  replica: { total: number; idle: number; waiting: number; available: boolean } | null;
} {
  const primaryStatus = primaryPool ? {
    total: primaryPool.totalCount,
    idle: primaryPool.idleCount,
    waiting: primaryPool.waitingCount
  } : { total: 0, idle: 0, waiting: 0 };

  const replicaStatus = replicaPool ? {
    total: replicaPool.totalCount,
    idle: replicaPool.idleCount,
    waiting: replicaPool.waitingCount,
    available: replicaAvailable
  } : null;

  return {
    primary: primaryStatus,
    replica: replicaStatus
  };
}

/**
 * 关闭所有连接池
 */
export async function closePools(): Promise<void> {
  const promises: Promise<void>[] = [];

  if (primaryPool) {
    promises.push(primaryPool.end());
  }

  if (replicaPool) {
    promises.push(replicaPool.end());
  }

  await Promise.all(promises);
  primaryPool = null;
  replicaPool = null;
  replicaAvailable = false;
}
