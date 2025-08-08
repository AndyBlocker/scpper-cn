import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type Redis from 'ioredis'

interface CacheOptions {
  redis?: Redis
}

declare module 'fastify' {
  interface FastifyInstance {
    cache?: {
      get(key: string): Promise<string | null>
      set(key: string, value: string, ttl?: number): Promise<void>
      del(key: string): Promise<void>
      setex(key: string, ttl: number, value: string): Promise<void>
    }
  }
}

const cachePlugin: FastifyPluginAsync<CacheOptions> = async (fastify, options) => {
  const { redis } = options
  
  if (redis) {
    // Redis 缓存实现
    fastify.decorate('cache', {
      async get(key: string): Promise<string | null> {
        try {
          return await redis.get(key)
        } catch (error) {
          fastify.log.warn({ error, key }, 'Redis get failed')
          return null
        }
      },
      
      async set(key: string, value: string, ttl?: number): Promise<void> {
        try {
          if (ttl) {
            await redis.setex(key, ttl, value)
          } else {
            await redis.set(key, value)
          }
        } catch (error) {
          fastify.log.warn({ error, key }, 'Redis set failed')
        }
      },
      
      async setex(key: string, ttl: number, value: string): Promise<void> {
        try {
          await redis.setex(key, ttl, value)
        } catch (error) {
          fastify.log.warn({ error, key }, 'Redis setex failed')
        }
      },
      
      async del(key: string): Promise<void> {
        try {
          await redis.del(key)
        } catch (error) {
          fastify.log.warn({ error, key }, 'Redis del failed')
        }
      }
    })
  } else {
    // 内存缓存实现（用于开发环境或小规模部署）
    const memoryCache = new Map<string, { value: string, expires?: number }>()
    
    // 定期清理过期缓存
    setInterval(() => {
      const now = Date.now()
      for (const [key, item] of memoryCache.entries()) {
        if (item.expires && item.expires < now) {
          memoryCache.delete(key)
        }
      }
    }, 60000) // 每分钟清理一次
    
    fastify.decorate('cache', {
      async get(key: string): Promise<string | null> {
        const item = memoryCache.get(key)
        if (!item) return null
        
        if (item.expires && item.expires < Date.now()) {
          memoryCache.delete(key)
          return null
        }
        
        return item.value
      },
      
      async set(key: string, value: string, ttl?: number): Promise<void> {
        const expires = ttl ? Date.now() + ttl * 1000 : undefined
        memoryCache.set(key, { value, expires })
      },
      
      async setex(key: string, ttl: number, value: string): Promise<void> {
        const expires = Date.now() + ttl * 1000
        memoryCache.set(key, { value, expires })
      },
      
      async del(key: string): Promise<void> {
        memoryCache.delete(key)
      }
    })
  }
  
  // 缓存中间件
  fastify.decorateRequest('cached', null)
  
  // 缓存装饰器
  fastify.decorate('cached', (ttl: number = 300) => {
    return async (request: any, reply: any) => {
      if (!fastify.cache) return
      
      const cacheKey = `req:${request.method}:${request.url}:${JSON.stringify(request.query)}`
      
      try {
        const cached = await fastify.cache.get(cacheKey)
        if (cached) {
          reply.header('X-Cache', 'HIT')
          reply.type('application/json')
          return reply.send(cached)
        }
        
        // 标记需要缓存响应
        request.cacheKey = cacheKey
        request.cacheTtl = ttl
      } catch (error) {
        fastify.log.warn({ error }, 'Cache middleware error')
      }
    }
  })
  
  // 响应缓存钩子
  fastify.addHook('onSend', async (request: any, reply, payload) => {
    if (request.cacheKey && fastify.cache && reply.statusCode === 200) {
      try {
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
        await fastify.cache.setex(request.cacheKey, request.cacheTtl, data)
        reply.header('X-Cache', 'MISS')
      } catch (error) {
        fastify.log.warn({ error }, 'Failed to cache response')
      }
    }
    return payload
  })
}

export default fp(cachePlugin)