import { Express, Request, Response } from 'express';
import client from 'prom-client';
import { config } from '../config/index.js';

// 创建度量指标
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

const cacheHitsTotal = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['cache_type'],
});

const cacheMissesTotal = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['cache_type'],
});

const activeConnections = new client.Gauge({
  name: 'active_connections',
  help: 'Number of active connections',
});

const memoryUsage = new client.Gauge({
  name: 'nodejs_memory_usage_bytes',
  help: 'Node.js memory usage in bytes',
  labelNames: ['type'],
});

// 收集默认指标
client.collectDefaultMetrics({
  prefix: 'scpper_bff_',
});

// 定期更新内存使用情况
setInterval(() => {
  const usage = process.memoryUsage();
  memoryUsage.set({ type: 'rss' }, usage.rss);
  memoryUsage.set({ type: 'heapUsed' }, usage.heapUsed);
  memoryUsage.set({ type: 'heapTotal' }, usage.heapTotal);
  memoryUsage.set({ type: 'external' }, usage.external);
}, 10000);

export function metricsMiddleware(req: Request, res: Response, next: any) {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path;
    const method = req.method;
    const statusCode = res.statusCode.toString();
    
    httpRequestDuration
      .labels(method, route, statusCode)
      .observe(duration);
    
    httpRequestsTotal
      .labels(method, route, statusCode)
      .inc();
  });
  
  next();
}

export function setupMetrics(app: Express) {
  // 添加指标中间件
  app.use(metricsMiddleware);
  
  // 指标端点
  app.get('/metrics', async (req: Request, res: Response) => {
    try {
      res.set('Content-Type', client.register.contentType);
      const metrics = await client.register.metrics();
      res.end(metrics);
    } catch (error) {
      res.status(500).end(error);
    }
  });
}

// 导出指标以供服务使用
export const metrics = {
  httpRequestDuration,
  httpRequestsTotal,
  cacheHitsTotal,
  cacheMissesTotal,
  activeConnections,
  memoryUsage,
};

export default client;