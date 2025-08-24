module.exports = {
  apps: [
    {
      name: 'scpper-nuxt',
      script: 'node_modules/nuxt/bin/nuxt.mjs',
      args: 'start --port 9876 --host 0.0.0.0',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        NITRO_PRESET: 'node-server',
        // 生产环境使用 /api 相对路径
        BFF_BASE: process.env.BFF_BASE || '/api'
      },
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      watch: false
    }
  ]
};


