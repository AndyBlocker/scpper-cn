module.exports = {
  apps: [
    {
      name: 'scpper-sync',
      cwd: __dirname,
      script: '/bin/bash',
      args: ['-lc', 'proxychains4 npm run sync'],
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
      cron_restart: '0 */2 * * *',
      watch: false,
    },
  ],
}


