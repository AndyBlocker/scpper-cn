module.exports = {
  apps: [
    {
      name: 'scpper-bff',
      script: './dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: '4396',
        DATABASE_URL: 'postgresql://REDACTED@localhost:5434/scpper-cn',
        ENABLE_CACHE: 'false'
      }
    }
  ]
};

