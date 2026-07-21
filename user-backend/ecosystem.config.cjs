module.exports = {
  apps: [
    {
      name: 'scpper-user-backend',
      cwd: __dirname,
      script: './dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=1536',
        // 限制 Prisma 查询引擎(Rust/Tokio)在高核数机器上拉起的 worker 线程数，
        // 默认按 CPU 核数(本机 56 核)拉起 ~56 线程，空闲即占用约 700MB+。
        TOKIO_WORKER_THREADS: process.env.TOKIO_WORKER_THREADS || '8',
        USER_BACKEND_PORT: process.env.USER_BACKEND_PORT || '4455',
        USER_DATABASE_URL: process.env.USER_DATABASE_URL,
        MAIL_AGENT_BASE_URL: process.env.MAIL_AGENT_BASE_URL || 'http://127.0.0.1:3110',
        USER_VERIFICATION_CODE_LENGTH: process.env.USER_VERIFICATION_CODE_LENGTH || '6',
        USER_VERIFICATION_TTL_MINUTES: process.env.USER_VERIFICATION_TTL_MINUTES || '10',
        USER_VERIFICATION_MAX_ATTEMPTS: process.env.USER_VERIFICATION_MAX_ATTEMPTS || '5',
        USER_REGISTER_RATE_WINDOW_SECONDS: process.env.USER_REGISTER_RATE_WINDOW_SECONDS || '60',
        USER_SESSION_SECURE: process.env.USER_SESSION_SECURE || 'true',
        USER_SESSION_SAMESITE: process.env.USER_SESSION_SAMESITE || 'lax',
        USER_SESSION_COOKIE: process.env.USER_SESSION_COOKIE || 'scpper_session',
        USER_SESSION_TTL_HOURS: process.env.USER_SESSION_TTL_HOURS || String(24 * 7),
        BFF_BASE_URL: process.env.BFF_BASE_URL || 'http://127.0.0.1:4396',
        BFF_INTERNAL_API_KEY: process.env.BFF_INTERNAL_API_KEY,
        BFF_INTERNAL_FETCH_TIMEOUT_MS: process.env.BFF_INTERNAL_FETCH_TIMEOUT_MS || '4500',
        MAIL_AGENT_API_KEY: process.env.MAIL_AGENT_API_KEY,
        INTERNAL_API_KEY: process.env.INTERNAL_API_KEY,
        CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS
      }
    }
  ]
};
