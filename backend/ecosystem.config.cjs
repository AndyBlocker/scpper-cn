module.exports = {
  apps: [
    {
      name: 'scpper-sync',
      cwd: __dirname,
      script: '/bin/bash',
      args: ['-lc', 'exec node --max-old-space-size=1024 --import tsx/esm src/cli/index.ts sync-hourly'],
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1024M',
      time: true,
      env: {
        NODE_ENV: 'production',
        DISABLE_WIKIDOT_BINDING_VERIFY: '1',
      },
      watch: false,
    },
    {
      name: 'scpper-binding-verify',
      cwd: __dirname,
      script: '/bin/bash',
      args: ['-lc', 'exec node --import tsx/esm src/cli/index.ts wikidot-binding-verify-loop --interval-seconds 300 --run-immediately'],
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        http_proxy: '',
        https_proxy: '',
        all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      watch: false,
    },
    {
      // #90：增量社交分析对"撤票"产生的陈旧/孤立互动行不会删除（只 DELETE+INSERT 它处理到的
      // 配对），长期缓慢累积。全量重算(repair --social-only)是事务化的(deleteMany+INSERT 同一
      // $transaction，读者无空白窗口)、安全且自愈。用独立 pm2 cron 进程每周跑一次自动清理，
      // 与关键 sync 守护进程隔离；autorestart:false 表示每个 cron tick 只跑一次后退出。
      name: 'scpper-social-rebuild',
      cwd: __dirname,
      script: '/bin/bash',
      args: ['-lc', 'exec node --max-old-space-size=1024 --import tsx/esm src/cli/index.ts repair-user-vote-stats --social-only'],
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '30 4 * * 1',
      time: true,
      env: {
        NODE_ENV: 'production',
      },
      watch: false,
    },
  ],
}
