import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

let redisClient: any | null = null;

// 尝试创建Redis客户端，失败时使用内存存储
try {
  if (config.cache.enabled) {
    redisClient = new (Redis as any)({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      retryStrategy: () => null, // 不重试，直接fallback到内存存储
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });

    redisClient.on('error', (error: Error) => {
      logger.warn('Rate limiter Redis connection error, using memory store:', error.message);
      redisClient = null;
    });

    redisClient.on('end', () => {
      logger.info('Rate limiter Redis connection ended');
      redisClient = null;
    });

    // Suppress unhandled rejection warnings
    redisClient.on('ready', () => {
      logger.info('Rate limiter Redis ready');
    });
  }
} catch (error) {
  logger.warn('Failed to initialize Redis for rate limiter, using memory store:', error);
  redisClient = null;
}

export const createRateLimiter = (options: {
  windowMs?: number;
  max?: number;
  keyPrefix?: string;
}) => {
  const rateLimiterConfig: any = {
    windowMs: options.windowMs || 60 * 1000, // 1分钟
    max: options.max || 100, // 最大请求数
    message: {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests, please try again later.',
      },
      meta: {
        timestamp: Date.now(),
        version: '1.0.0',
        requestId: 'rate-limit-error',
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
  };

  // 如果Redis可用，使用Redis存储；否则使用默认内存存储
  if (redisClient) {
    try {
      rateLimiterConfig.store = new RedisStore({
        sendCommand: (...args: string[]) => redisClient!.call(...args),
        prefix: options.keyPrefix || 'rate_limit:',
      });
      logger.info(`Rate limiter using Redis store with prefix: ${options.keyPrefix || 'rate_limit:'}`);
    } catch (error) {
      logger.warn('Failed to create Redis store for rate limiter, using memory store:', error);
    }
  } else {
    logger.info(`Rate limiter using memory store for prefix: ${options.keyPrefix || 'rate_limit:'}`);
  }

  return rateLimit(rateLimiterConfig);
};

// 不同类型的限流器
export const rateLimiters = {
  // 通用API限流 - 每分钟100次请求
  api: createRateLimiter({ 
    max: 100, 
    windowMs: 60 * 1000,
    keyPrefix: 'api:' 
  }),
  
  // 搜索API限流 - 每分钟30次请求
  search: createRateLimiter({ 
    max: 30, 
    windowMs: 60 * 1000, 
    keyPrefix: 'search:' 
  }),
  
  // 重度操作限流 - 每分钟10次请求
  heavy: createRateLimiter({ 
    max: 10, 
    windowMs: 60 * 1000, 
    keyPrefix: 'heavy:' 
  }),

  // 统计API限流 - 每分钟20次请求
  stats: createRateLimiter({
    max: 20,
    windowMs: 60 * 1000,
    keyPrefix: 'stats:'
  }),
};