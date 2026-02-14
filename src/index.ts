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
    pollIntervalMs: 2000,
    marketRefreshMs: 60000,
  }).catch((e) => {
    console.error("Runner error:", e);
    process.exit(1);
  });
} else {
  console.log("Usage: node dist/index.js start | stop");
  process.exit(1);
}
