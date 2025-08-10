import { Request, Response, NextFunction } from 'express';
import { CacheService } from '../services/cache.service.js';

export function cacheMiddleware(ttl?: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // 只缓存GET请求
    if (req.method !== 'GET') {
      return next();
    }

    const cache = new CacheService();
    const key = `route:${req.originalUrl}`;
    
    try {
      // 检查缓存
      const cached = await cache.get(key);
      if (cached) {
        res.setHeader('X-Cache-Hit', 'true');
        res.setHeader('X-Cache-Key', key);
        return res.json(cached);
      }

      // 劫持res.json以缓存响应
      const originalJson = res.json;
      res.json = function(data: any) {
        res.setHeader('X-Cache-Hit', 'false');
        res.setHeader('X-Cache-Key', key);
        
        // 只缓存成功的响应
        if (res.statusCode === 200 && data.success) {
          cache.set(key, data, ttl || 300).catch(err => {
            console.error('Cache set error:', err);
          });
        }
        
        return originalJson.call(this, data);
      };

      next();
    } catch (error) {
      // 缓存错误不应该影响正常请求
      console.error('Cache middleware error:', error);
      next();
    }
  };
}