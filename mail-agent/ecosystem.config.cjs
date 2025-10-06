module.exports = {
  apps: [
    {
      name: 'mail-agent',
      script: './src/server.mjs',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
