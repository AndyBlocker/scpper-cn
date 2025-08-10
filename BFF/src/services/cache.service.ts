import Redis from 'ioredis';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

interface CacheItem {
  value: any;
  expiry: number;
}

export class CacheService {
  private redis: any | null = null;
  private memoryCache: Map<string, CacheItem> = new Map();
  private defaultTTL: number;
  private redisAvailable: boolean = false;

  constructor() {
    this.defaultTTL = config.cache.defaultTTL;
    
    if (config.cache.enabled) {
      this.initializeRedis();
    } else {
      logger.info('Cache disabled by configuration');
    }

    // 定时清理过期的内存缓存 (每5分钟)
    setInterval(() => {
      this.cleanupMemoryCache();
    }, 5 * 60 * 1000);
  }

  private async initializeRedis() {
    try {
      this.redis = new (Redis as any)({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.db,
        retryStrategy: (times: number) => {
          // 限制重试次数
          if (times > 3) {
            logger.warn('Redis connection failed after 3 retries, falling back to memory cache');
            return null; // 停止重试
          }
          return Math.min(times * 50, 2000);
        },
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
      });

      this.redis.on('connect', () => {
        logger.info('Redis connected successfully');
        this.redisAvailable = true;
      });

      this.redis.on('error', (error: Error) => {
        logger.warn('Redis connection error, falling back to memory cache:', error.message);
        this.redisAvailable = false;
      });

      this.redis.on('end', () => {
        logger.warn('Redis connection ended, using memory cache');
        this.redisAvailable = false;
      });

      // 尝试连接
      await this.redis.connect();
    } catch (error) {
      logger.warn('Failed to initialize Redis, using memory cache fallback:', error);
      this.redis = null;
      this.redisAvailable = false;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!config.cache.enabled) return null;

    // 尝试从Redis获取
    if (this.redisAvailable && this.redis) {
      try {
        const data = await this.redis.get(key);
        return data ? JSON.parse(data) : null;
      } catch (error) {
        logger.warn('Redis get error, falling back to memory cache:', error);
        this.redisAvailable = false;
      }
    }

    // 从内存缓存获取
    return this.getFromMemory<T>(key);
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    if (!config.cache.enabled) return;

    const effectiveTtl = ttl || this.defaultTTL;

    // 尝试写入Redis
    if (this.redisAvailable && this.redis) {
      try {
        const serialized = JSON.stringify(value, (key, value) => {
          // Convert BigInt to string for serialization
          return typeof value === 'bigint' ? value.toString() : value;
        });
        if (effectiveTtl > 0) {
          await this.redis.setex(key, effectiveTtl, serialized);
        } else {
          await this.redis.set(key, serialized);
        }
      } catch (error) {
        logger.warn('Redis set error, falling back to memory cache:', error);
        this.redisAvailable = false;
      }
    }

    // 写入内存缓存作为fallback
    this.setToMemory(key, value, effectiveTtl);
  }

  async del(pattern: string): Promise<void> {
    if (!config.cache.enabled) return;

    // 尝试从Redis删除
    if (this.redisAvailable && this.redis) {
      try {
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } catch (error) {
        logger.warn('Redis delete error:', error);
        this.redisAvailable = false;
      }
    }

    // 从内存缓存删除
    this.deleteFromMemory(pattern);
  }

  async invalidate(patterns: string[]): Promise<void> {
    for (const pattern of patterns) {
      await this.del(pattern);
    }
  }

  // 内存缓存辅助方法
  private getFromMemory<T>(key: string): T | null {
    const item = this.memoryCache.get(key);
    if (!item) return null;

    if (item.expiry > 0 && Date.now() > item.expiry) {
      this.memoryCache.delete(key);
      return null;
    }

    return item.value;
  }

  private setToMemory(key: string, value: any, ttl: number): void {
    const expiry = ttl > 0 ? Date.now() + (ttl * 1000) : 0;
    this.memoryCache.set(key, { value, expiry });
    
    // 限制内存缓存大小
    if (this.memoryCache.size > 1000) {
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) this.memoryCache.delete(firstKey);
    }
  }

  private deleteFromMemory(pattern: string): void {
    // 简单的模式匹配
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    for (const key of this.memoryCache.keys()) {
      if (regex.test(key as string)) {
        this.memoryCache.delete(key);
      }
    }
  }

  // 缓存穿透保护
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttl: number = this.defaultTTL
  ): Promise<T> {
    let data = await this.get<T>(key);
    
    if (data === null) {
      // 使用分布式锁防止缓存击穿 (只在Redis可用时)
      if (this.redisAvailable && this.redis) {
        const lockKey = `lock:${key}`;
        try {
          const locked = await this.redis.set(lockKey, '1', 'NX', 'EX', 10);
          
          if (locked) {
            try {
              data = await factory();
              await this.set(key, data, ttl);
            } finally {
              await this.redis.del(lockKey);
            }
          } else {
            // 等待其他请求完成
            await new Promise(resolve => setTimeout(resolve, 100));
            return this.getOrSet(key, factory, ttl);
          }
        } catch (error) {
          logger.warn('Lock operation failed, proceeding without lock:', error);
          data = await factory();
          await this.set(key, data, ttl);
        }
      } else {
        // Redis不可用时直接获取数据
        data = await factory();
        await this.set(key, data, ttl);
      }
    }
    
    return data as T;
  }

  // 批量获取
  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    if (!config.cache.enabled) return keys.map(() => null);

    // 尝试从Redis批量获取
    if (this.redisAvailable && this.redis) {
      try {
        const values = await this.redis.mget(keys);
        return values.map((v: string | null) => v ? JSON.parse(v) : null);
      } catch (error) {
        logger.warn('Redis mget error, falling back to memory cache:', error);
        this.redisAvailable = false;
      }
    }

    // 从内存缓存批量获取
    return keys.map(key => this.getFromMemory<T>(key));
  }

  // 批量设置
  async mset(items: Array<{ key: string; value: any; ttl?: number }>): Promise<void> {
    if (!config.cache.enabled) return;

    // 尝试批量写入Redis
    if (this.redisAvailable && this.redis) {
      try {
        const pipeline = this.redis.pipeline();
        
        for (const item of items) {
          const serialized = JSON.stringify(item.value);
          const effectiveTtl = item.ttl || this.defaultTTL;
          if (effectiveTtl > 0) {
            pipeline.setex(item.key, effectiveTtl, serialized);
          } else {
            pipeline.set(item.key, serialized);
          }
        }
        
        await pipeline.exec();
      } catch (error) {
        logger.warn('Redis mset error, falling back to memory cache:', error);
        this.redisAvailable = false;
      }
    }

    // 批量写入内存缓存
    for (const item of items) {
      const effectiveTtl = item.ttl || this.defaultTTL;
      this.setToMemory(item.key, item.value, effectiveTtl);
    }
  }

  async ping(): Promise<void> {
    if (this.redis) {
      await this.redis.ping();
    }
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.disconnect();
    }
    this.memoryCache.clear();
  }

  // 获取缓存状态
  getStatus() {
    return {
      redisAvailable: this.redisAvailable,
      memoryCacheSize: this.memoryCache.size,
      cacheEnabled: config.cache.enabled,
    };
  }

  // 清理过期的内存缓存
  private cleanupMemoryCache(): void {
    const now = Date.now();
    for (const [key, item] of this.memoryCache.entries()) {
      if (item.expiry > 0 && now > item.expiry) {
        this.memoryCache.delete(key);
      }
    }
  }
}