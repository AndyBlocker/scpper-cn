module.exports = {
  apps: [
    {
      name: 'scpper-bff',
      script: './dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '4396',
        DATABASE_URL: process.env.DATABASE_URL,
        ENABLE_CACHE: process.env.ENABLE_CACHE || 'true',
        USER_BACKEND_BASE_URL: process.env.USER_BACKEND_BASE_URL || 'http://127.0.0.1:4455',
        REDIS_URL: process.env.REDIS_URL,
        HTML_SNIPPET_PUBLIC_BASE: process.env.HTML_SNIPPET_PUBLIC_BASE || 'https://scpper.mer.run',
        CSS_PROXY_CACHE_CONTROL: process.env.CSS_PROXY_CACHE_CONTROL || 'public, max-age=3600, s-maxage=7200',
        ENABLE_TRACKING_DEBUG: process.env.ENABLE_TRACKING_DEBUG || 'false',
        TRACKING_DEBUG_SAMPLE_RATE: process.env.TRACKING_DEBUG_SAMPLE_RATE || '0'
      }
    }
  ]
};
