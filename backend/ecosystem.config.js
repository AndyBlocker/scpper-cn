module.exports = {
  apps: [
    {
      name: 'scpper-cn-sync',
      script: 'src/sync/database-sync.js',
      cwd: './backend',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production'
      },
      cron_restart: '0 3 * * *', // 每天凌晨3点重启
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './sync-logs/pm2-error.log',
      out_file: './sync-logs/pm2-out.log',
      log_file: './sync-logs/pm2-combined.log'
    },
    {
      name: 'scpper-cn-analysis',
      script: 'src/analysis/user-analytics.js',
      cwd: './backend',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '4G',
      env: {
        NODE_ENV: 'production'
      },
      cron_restart: '0 4 * * *' // 每天凌晨4点重启（同步后分析）
    }
  ]
};
