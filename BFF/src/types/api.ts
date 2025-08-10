import { randomUUID } from 'crypto';

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: ApiMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: any;
}

export interface ApiMeta {
  timestamp: number;
  version: string;
  requestId: string;
  cached?: boolean;
  cacheKey?: string;
  cacheTTL?: number;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// 响应构建器
export class ResponseBuilder {
  static success<T>(data: T, meta?: Partial<ApiMeta>): ApiResponse<T> {
    return {
      success: true,
      data,
      meta: {
        timestamp: Date.now(),
        version: '1.0.0',
        requestId: randomUUID(),
        ...meta,
      },
    };
  }

  static error(code: string, message: string, details?: any): ApiResponse {
    return {
      success: false,
      error: { code, message, details },
      meta: {
        timestamp: Date.now(),
        version: '1.0.0',
        requestId: randomUUID(),
      },
    };
  }

  static paginated<T>(
    data: T[],
    pagination: PaginationMeta,
    meta?: Partial<ApiMeta>
  ): ApiResponse<{ items: T[]; pagination: PaginationMeta }> {
    return this.success(
      { items: data, pagination },
      meta
    );
  }
}