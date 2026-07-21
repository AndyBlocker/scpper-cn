module.exports = {
  apps: [
    {
      name: 'scpper-bff',
      script: './dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '768M',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '4396',
        DATABASE_URL: process.env.DATABASE_URL,
        SYNCER_DATABASE_URL: process.env.SYNCER_DATABASE_URL,
        ENABLE_CACHE: process.env.ENABLE_CACHE || 'true',
        USER_BACKEND_BASE_URL: process.env.USER_BACKEND_BASE_URL || 'http://127.0.0.1:4455',
        AVATAR_AGENT_BASE_URL: process.env.AVATAR_AGENT_BASE_URL || 'http://127.0.0.1:3200',
        REDIS_URL: process.env.REDIS_URL,
        REDIS_HOST: process.env.REDIS_HOST,
        REDIS_PORT: process.env.REDIS_PORT,
        REDIS_PASSWORD: process.env.REDIS_PASSWORD || process.env.REDIS_AUTH,
        REDIS_DB: process.env.REDIS_DB,
        CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
        BFF_INTERNAL_API_KEY: process.env.BFF_INTERNAL_API_KEY,
        HTML_SNIPPET_PUBLIC_BASE: process.env.HTML_SNIPPET_PUBLIC_BASE || 'https://scpper.mer.run',
        CSS_PROXY_CACHE_CONTROL: process.env.CSS_PROXY_CACHE_CONTROL || 'public, max-age=3600, s-maxage=7200',
        CSS_PROXY_RATE_WINDOW_MS: process.env.CSS_PROXY_RATE_WINDOW_MS || '60000',
        CSS_PROXY_RATE_MAX_PER_MINUTE: process.env.CSS_PROXY_RATE_MAX_PER_MINUTE || '180',
        BFF_GLOBAL_RATE_LIMIT_PER_MINUTE: process.env.BFF_GLOBAL_RATE_LIMIT_PER_MINUTE || '900',
        BFF_EXPENSIVE_RATE_LIMIT_PER_MINUTE: process.env.BFF_EXPENSIVE_RATE_LIMIT_PER_MINUTE || '90',
        TRACKING_COUNT_REFERER_ALLOWLIST: process.env.TRACKING_COUNT_REFERER_ALLOWLIST,
        // 硬编码关闭:debug 表存完整请求头+原始 IP,曾因 shell env 透传漂移以 100% 采样
        // 常开数月(2026-06-10 审计)。需要临时开 debug 时改这里并走部署流程,不走 env。
        ENABLE_TRACKING_DEBUG: 'false',
        TRACKING_DEBUG_SAMPLE_RATE: '0',
        // 启用 ETag 缓存型持久访客标识(站方决定开启,2026-06-10)。像素响应改 no-cache+ETag,
        // 浏览器每次条件请求回送 If-None-Match→恢复 token,命中自动 304 不丢计数。
        TRACKING_VISITOR_TOKEN: 'true'
      }
    }
  ]
};
