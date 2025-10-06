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
      env: {
        NODE_ENV: 'production',
        USER_BACKEND_PORT: '4455',
        USER_DATABASE_URL: 'postgresql://REDACTED@localhost:5434/scpper_user?schema=public',
        MAIL_AGENT_BASE_URL: 'http://127.0.0.1:3110',
        USER_VERIFICATION_CODE_LENGTH: '6',
        USER_VERIFICATION_TTL_MINUTES: '10',
        USER_VERIFICATION_MAX_ATTEMPTS: '5',
        USER_REGISTER_RATE_WINDOW_SECONDS: '60'
      }
    }
  ]
};
