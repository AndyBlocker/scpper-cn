module.exports = {
  apps: [
    {
      name: 'avatar-agent',
      script: './dist/src/index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: '3200',
        AVATAR_ROOT: '/home/andyblocker/scpper-cn/.data/avatar-agent/avatars',
        DEFAULT_AVATAR: '/home/andyblocker/scpper-cn/avatar-agent/default-avatar.png',
        LOG_LEVEL: 'info',
        UPSTREAM_ALLOWED_HOSTS: 'd2qhngyckgiutd.cloudfront.net,graph.facebook.com',
        PAGE_IMAGE_WORKER_ENABLED: process.env.PAGE_IMAGE_WORKER_ENABLED || 'true',
        PAGE_IMAGE_DATABASE_URL: process.env.PAGE_IMAGE_DATABASE_URL || process.env.DATABASE_URL,
        PAGE_IMAGE_ROOT: process.env.PAGE_IMAGE_ROOT || '/home/andyblocker/scpper-cn/.data/page-images',
        PAGE_IMAGE_WORKER_CONCURRENCY: process.env.PAGE_IMAGE_WORKER_CONCURRENCY || '1',
        PAGE_IMAGE_FETCH_DELAY_MS: process.env.PAGE_IMAGE_FETCH_DELAY_MS || '2500',
        PAGE_IMAGE_IDLE_DELAY_MS: process.env.PAGE_IMAGE_IDLE_DELAY_MS || '5000',
        PAGE_IMAGE_REQUEST_TIMEOUT_MS: process.env.PAGE_IMAGE_REQUEST_TIMEOUT_MS || '10000',
        PAGE_IMAGE_RETRY_BASE_MS: process.env.PAGE_IMAGE_RETRY_BASE_MS || '60000',
        PAGE_IMAGE_RETRY_MAX_MS: process.env.PAGE_IMAGE_RETRY_MAX_MS || '3600000',
        PAGE_IMAGE_MAX_ATTEMPTS: process.env.PAGE_IMAGE_MAX_ATTEMPTS || '24',
        PAGE_IMAGE_MAX_BYTES: process.env.PAGE_IMAGE_MAX_BYTES || String(5 * 1024 * 1024),
        PAGE_IMAGE_USER_AGENT: process.env.PAGE_IMAGE_USER_AGENT || 'scpper-image-cache/1.0',
        PAGE_IMAGE_ALLOWED_HOSTS: process.env.PAGE_IMAGE_ALLOWED_HOSTS || '*.wikidot.com,*.wdfiles.com,upload.wikimedia.org,images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com',
        PAGE_IMAGE_BLOCKED_HOSTS: process.env.PAGE_IMAGE_BLOCKED_HOSTS || 'cdn.mer.run,cdn.mer.dev',
        PAGE_IMAGE_VARIANT_ENABLED: process.env.PAGE_IMAGE_VARIANT_ENABLED || 'true',
        PAGE_IMAGE_VARIANT_MAX_WIDTH: process.env.PAGE_IMAGE_VARIANT_MAX_WIDTH || '640',
        PAGE_IMAGE_VARIANT_QUALITY: process.env.PAGE_IMAGE_VARIANT_QUALITY || '72'
      }
    },
    {
      name: 'avatar-prune',
      script: './dist/scripts/prune.js',
      instances: 1,
      exec_mode: 'fork',
      cron_restart: '15 4 * * *',
      autorestart: false,
      env: {
        NODE_ENV: 'production',
        AVATAR_ROOT: '/home/andyblocker/scpper-cn/.data/avatar-agent/avatars',
        DEFAULT_AVATAR: '/home/andyblocker/scpper-cn/avatar-agent/default-avatar.png',
        LOG_LEVEL: 'info',
        UPSTREAM_ALLOWED_HOSTS: 'd2qhngyckgiutd.cloudfront.net,graph.facebook.com'
      }
    }
  ]
};
