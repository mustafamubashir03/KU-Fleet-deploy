/**
 * PM2 process definition for the KU-Fleet backend.
 *
 * Intended host: Amazon Linux 2023, Node.js 22.x, local Redis on 127.0.0.1.
 *
 * SINGLE INSTANCE ON PURPOSE. dist/server.js starts the HTTP server, Socket.IO,
 * the raw GT06 TCP listener, three BullMQ workers and five cron schedules in one
 * process. Running more than one instance would:
 *   - double every cron schedule (duplicate cleanup batches)
 *   - run duplicate BullMQ consumers on the same queues
 *   - fight over the TCP port 5050
 *
 * Secrets are NOT embedded here. Environment comes from the .env file resolved
 * by src/config/env.ts, or from systemd/PM2 variables set at deploy time.
 */
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..");

module.exports = {
  apps: [
    {
      name: "kufleet-backend",
      script: "dist/server.js",

      // Must be the backend root so src/config/env.ts resolves <root>/.env and
      // dist/server.js is found regardless of how PM2 was invoked.
      cwd: APP_ROOT,

      instances: 1,
      exec_mode: "fork",

      // src/server.ts flushes the GPS buffer and closes Redis/Mongo/TCP on
      // SIGTERM. Allow time for that before PM2 escalates to SIGKILL, or
      // buffered coordinates are lost on every restart.
      kill_timeout: 20000,

      autorestart: true,
      // Avoid a crash loop hammering a 1 GiB instance.
      max_restarts: 10,
      min_uptime: 30000,
      restart_delay: 5000,

      // Keep logs bounded; the instance has an 8 GiB root volume.
      merge_logs: true,
      time: true,
      max_log_size: "10M",
      retain_logs: 5,

      env: {
        NODE_ENV: "production",
      },
    },
  ],
};