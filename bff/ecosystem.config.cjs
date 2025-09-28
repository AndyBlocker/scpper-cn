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
        DATABASE_URL: 'postgresql://user_dxzbdi:password_NxStQy@localhost:5434/scpper-cn',
        ENABLE_CACHE: 'false'
      }
    }
  ]
};

