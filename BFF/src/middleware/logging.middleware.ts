import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';

// Extend Express Request interface to include requestId
declare global {
  namespace Express {
    interface Request {
      requestId: string;
      startTime: number;
    }
  }
}

export function loggingMiddleware(req: Request, res: Response, next: NextFunction) {
  // 添加请求ID和开始时间
  req.requestId = randomUUID();
  req.startTime = Date.now();

  // 设置响应头
  res.setHeader('X-Request-ID', req.requestId);

  // 记录请求开始
  logger.info({
    type: 'request_start',
    requestId: req.requestId,
    method: req.method,
    url: req.url,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    query: req.query,
  });

  // 劫持res.end以记录响应
  const originalEnd = res.end;
  res.end = function(chunk?: any, encoding?: any) {
    const duration = Date.now() - req.startTime;
    
    logger.info({
      type: 'request_end',
      requestId: req.requestId,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration,
      contentLength: res.get('Content-Length'),
    });

    return originalEnd.call(this, chunk, encoding);
  };

  next();
}