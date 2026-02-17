/**
 * 入口：加载 .env，解析 start/stop 命令
 */

import "dotenv/config";
import { run, requestStop, isStopRequested } from "./runner.js";

const cmd = process.argv[2] ?? "start";

if (cmd === "stop") {
  requestStop();
  console.log("Stop requested. If the bot is running, it will exit on next loop.");
  process.exit(0);
}

if (cmd === "start") {
  run({
    // BTC 5min + 98C 这种盘口变化很快：2s 轮询很容易错过瞬间的 0.98
    pollIntervalMs: 250,
    // 5min 轮次切换也更频繁，刷新市场列表加快一点
    marketRefreshMs: 1000,
  }).catch((e) => {
    console.error("Runner error:", e);
    process.exit(1);
  });
} else {
  console.log("Usage: node dist/index.js start | stop");
  process.exit(1);
}
