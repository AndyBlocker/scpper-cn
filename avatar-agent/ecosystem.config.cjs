module.exports = {
  apps: [
    {
      name: 'avatar-agent',
      script: './dist/src/index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        AVATAR_ROOT: '/home/andyblocker/scpper-cn/.data/avatar-agent/avatars',
        DEFAULT_AVATAR: '/home/andyblocker/scpper-cn/avatar-agent/default-avatar.png',
        LOG_LEVEL: 'info',
        UPSTREAM_ALLOWED_HOSTS: '*'
      }
    },
    {
      name: 'avatar-prune',
      script: './dist/scripts/prune.js',
      instances: 1,
      exec_mode: 'fork',
      cron_restart: '15 4 * * *',
      autorestart: false,
      env: {
        NODE_ENV: 'production',
        AVATAR_ROOT: '/home/andyblocker/scpper-cn/.data/avatar-agent/avatars',
        DEFAULT_AVATAR: '/home/andyblocker/scpper-cn/avatar-agent/default-avatar.png',
        LOG_LEVEL: 'info',
        UPSTREAM_ALLOWED_HOSTS: '*'
      }
    }
  ]
};


