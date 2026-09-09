"use strict";

module.exports = {
  apps: [
    {
      name: "Ultimate_Project_Manager",
      script: "./src/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      min_uptime: "10s",
      max_restarts: 10,
      exp_backoff_restart_delay: 100,
      max_memory_restart: "512M",
      kill_timeout: 10000,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
