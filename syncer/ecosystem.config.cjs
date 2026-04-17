module.exports = {
  apps: [
    {
      name: 'scpper-vote-sentinel',
      cwd: __dirname,
      script: '/bin/bash',
      args: ['-lc', 'node --import tsx/esm src/index.ts sentinel --run-immediately'],
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
      watch: false,
    },
    {
      name: 'scpper-fast-vote',
      cwd: __dirname,
      script: '/bin/bash',
      args: ['-lc', 'node --import tsx/esm src/index.ts fast-vote --interval 300 --concurrency 5 --run-immediately'],
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
      watch: false,
    },
    {
      name: 'scpper-syncer-v2',
      cwd: __dirname,
      script: '/bin/bash',
      args: ['-lc', 'node --import tsx/esm src/index.ts sync --interval 3600 --run-immediately'],
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
      watch: false,
    },
  ],
};
