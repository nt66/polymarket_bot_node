/**
 * 入口：加载 .env，解析 start/stop/copy 命令
 */

import "dotenv/config";
import { run, requestStop } from "./runner.js";
import { runCopy } from "./copy-runner.js";
import { loadConfig } from "./config/index.js";

const cmd = process.argv[2] ?? "start";

if (cmd === "stop") {
  requestStop();
  console.log("Stop requested. If the bot is running, it will exit on next loop.");
  process.exit(0);
}

if (cmd === "start") {
  const config = loadConfig();

  if (config.botMode === "copy") {
    // 跟单模式
    runCopy({ pollIntervalMs: 5000 }).catch((e) => {
      console.error("Copy runner error:", e);
      process.exit(1);
    });
  } else {
    // 原策略模式
    run({
      pollIntervalMs: 2000,
      marketRefreshMs: 60000,
    }).catch((e) => {
      console.error("Runner error:", e);
      process.exit(1);
    });
  }
} else {
  console.log("Usage: node dist/index.js start | stop");
  process.exit(1);
}
