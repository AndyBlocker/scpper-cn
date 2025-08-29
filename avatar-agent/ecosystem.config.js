module.exports = {
  apps: [
    {
      name: "avatar-agent",
      script: "dist/index.js",
      exec_mode: "fork",
      instances: 1,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        AVATAR_ROOT: "/home/andyblocker/scpper-cn/.data/avatar-agent/avatars",
        LOG_LEVEL: "info"
      }
    },
    {
      name: "avatar-prune",
      script: "dist/scripts/prune.js",
      exec_mode: "fork",
      instances: 1,
      cron_restart: "15 4 * * *",
      autorestart: false,
      env: {
        NODE_ENV: "production",
        AVATAR_ROOT: "/home/andyblocker/scpper-cn/.data/avatar-agent/avatars",
        LOG_LEVEL: "info"
      }
    }
  ]
}

