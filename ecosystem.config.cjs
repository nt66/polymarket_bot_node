/**
 * PM2 进程配置：用 PM2 管理 98 概率买入 Bot，后台常驻、方便启停与看日志
 *
 * 先构建再启动：npm run build && pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: "polymarket-bot",
      script: "dist/index.js",
      args: "start",
      cwd: __dirname,
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: { NODE_ENV: "production" },
      out_file: "./logs/out.log",
      error_file: "./logs/err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
