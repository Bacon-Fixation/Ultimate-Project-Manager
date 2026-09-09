"use strict";

module.exports = {
  apps: [
    {
      name: "Ultimate_Project_Manager_LAN_Agent",
      script: "./src/remote-agent/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      time: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
