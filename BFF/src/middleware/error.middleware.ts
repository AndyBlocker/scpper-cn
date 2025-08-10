import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { ResponseBuilder } from '../types/api.js';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = 'Too many requests') {
    super(429, 'RATE_LIMIT_EXCEEDED', message);
  }
}

export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
) {
  logger.error({
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
  });

  if (err instanceof AppError) {
    return res.status(err.statusCode).json(
      ResponseBuilder.error(err.code, err.message, err.details)
    );
  }

  // Prisma错误处理
  if (err.constructor.name === 'PrismaClientKnownRequestError') {
    const prismaError = err as any;
    switch (prismaError.code) {
      case 'P2025':
        return res.status(404).json(
          ResponseBuilder.error('NOT_FOUND', 'Resource not found')
        );
      case 'P2002':
        return res.status(409).json(
          ResponseBuilder.error('CONFLICT', 'Resource already exists')
        );
      default:
        return res.status(500).json(
          ResponseBuilder.error('DATABASE_ERROR', 'Database operation failed')
        );
    }
  }

  // Validation errors
  if (err.name === 'ZodError') {
    return res.status(400).json(
      ResponseBuilder.error('VALIDATION_ERROR', 'Invalid request data', err)
    );
  }

  // 默认错误响应
  res.status(500).json(
    ResponseBuilder.error(
      'INTERNAL_ERROR',
      process.env.NODE_ENV === 'production' 
        ? 'Internal server error'
        : err.message
    )
  );
}

// Async error wrapper
export function asyncHandler(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}