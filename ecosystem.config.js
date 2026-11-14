// pm2 settings for the leads bot.
//   start:   pm2 start ecosystem.config.js
//   logs:    pm2 logs leads-bot
//   after git pull:  pm2 restart leads-bot
module.exports = {
  apps: [
    {
      name: "leads-bot",
      script: "fetch-companies.js",
      cwd: __dirname,
      // Restart after a crash, waiting a bit longer each time (no tight loops)...
      autorestart: true,
      exp_backoff_restart_delay: 5000,
      // ...but not after a clean finish (exit code 0) or a config error
      // (exit code 2, "CONFIG ERROR" in the log: fix .env, then pm2 restart).
      stop_exit_codes: [0, 2],
      max_memory_restart: "800M",
      kill_timeout: 5000, // lets it save progress on stop
      time: true,         // timestamps in pm2 logs
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      merge_logs: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
