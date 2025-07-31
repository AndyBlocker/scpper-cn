// src/config/RateLimitConfig.js
export const MAX_POINTS_PER_QUERY = 1000;
export const MAX_FIRST = 100;            // 服务器硬上限
export const SIMPLE_PAGE_THRESHOLD = 400; // ≤600 视为 simple
export const BUCKET_SOFT_LIMIT = 900;     // Phase 2 每包上限
export const MAX_RETRY_ATTEMPTS = 30;
