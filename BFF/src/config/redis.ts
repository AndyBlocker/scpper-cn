import Redis from 'ioredis';
import { logger } from '../utils/logger.js';
import { config } from './index.js';

let redis: any;

export function createRedisClient(): any {
  if (redis) {
    return redis;
  }

  redis = new (Redis as any)({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    retryStrategy: (times: number) => {
      const delay = Math.min(times * 50, 2000);
      logger.warn(`Redis retry attempt ${times}, delay: ${delay}ms`);
      return delay;
    },
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  redis.on('connect', () => {
    logger.info('Redis connected successfully');
  });

  redis.on('error', (error: Error) => {
    logger.error('Redis connection error:', error);
  });

  redis.on('reconnecting', () => {
    logger.info('Redis reconnecting...');
  });

  redis.on('ready', () => {
    logger.info('Redis ready for operations');
  });

  return redis;
}

export function getRedisClient(): any {
  if (!redis) {
    throw new Error('Redis client not initialized. Call createRedisClient() first.');
  }
  return redis;
}

export async function connectRedis(): Promise<void> {
  if (!redis) {
    throw new Error('Redis client not initialized. Call createRedisClient() first.');
  }
  
  try {
    await redis.connect();
    logger.info('Redis connected successfully');
  } catch (error) {
    logger.error('Failed to connect to Redis:', error);
    throw error;
  }
}

export async function disconnectRedis(): Promise<void> {
  try {
    await redis.disconnect();
    logger.info('Redis disconnected successfully');
  } catch (error) {
    logger.error('Failed to disconnect from Redis:', error);
    throw error;
  }
}

// 健康检查
export async function checkRedisHealth(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === 'PONG';
  } catch (error) {
    logger.error('Redis health check failed:', error);
    return false;
  }
}