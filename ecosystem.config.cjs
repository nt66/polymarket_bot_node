/**
 * PM2 进程配置：远程部署时用 PM2 管理 bot，便于停止与查看输出
 *
 * 使用：
 *   pm2 start ecosystem.config.cjs     # 启动
 *   pm2 stop polymarket-bot           # 停止
 *   pm2 logs polymarket-bot           # 实时看终端输出
 *   pm2 status                        # 查看状态
 */
module.exports = {
  apps: [
    {
      name: "polymarket-bot",
      script: "dist/index.js",
      args: "start",
      cwd: __dirname,
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
