// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'scpper-nuxt',
      port: 9876,
      script: '.output/server/index.mjs',
      cwd: __dirname,
      env: {
        PORT: 9876,
        NITRO_PORT: 9876,
        NODE_ENV: 'production',
        NITRO_PRESET: 'node-server',
        BFF_BASE: process.env.BFF_BASE || '/api',
        BFF_PROXY_TARGET: process.env.BFF_PROXY_TARGET || 'http://127.0.0.1:4396',
        // 站内提醒默认开启；QQ 绑定与站外投递保持独立关闭。
        NUXT_PUBLIC_NOTIFICATIONS_ENABLED: process.env.NUXT_PUBLIC_NOTIFICATIONS_ENABLED || 'true',
        NUXT_PUBLIC_QQ_NOTIFY_ENABLED: process.env.NUXT_PUBLIC_QQ_NOTIFY_ENABLED || 'false',
      },
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '1024M',
      watch: false,
    },
  ],
}
