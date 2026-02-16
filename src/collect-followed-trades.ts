// 跟单数据收集脚本
// 收集目标账户的所有下单记录，保存为本地 JSON 文件，便于后续分析

import { fetchTargetTrades } from "./api/data-api.js";
import * as fs from "fs";

const TARGET_ADDRESS = process.env.TARGET_ADDRESS || "";
const OUTPUT_FILE = "followed_trades.json";
const FETCH_LIMIT = 50; // 可调整为更大

async function collectTrades() {
  if (!TARGET_ADDRESS) {
    console.error("请设置 TARGET_ADDRESS 环境变量");
    process.exit(1);
  }
  let allTrades: any[] = [];
  let page = 0;
  let hasMore = true;
  while (hasMore) {
    const trades = await fetchTargetTrades(TARGET_ADDRESS, FETCH_LIMIT);
    if (!trades.length) break;
    allTrades = allTrades.concat(trades);
    if (trades.length < FETCH_LIMIT) {
      hasMore = false;
    } else {
      // Data API 没有分页参数，默认只拉最新 N 笔
      hasMore = false;
    }
    page++;
  }
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allTrades, null, 2), "utf-8");
  console.log(`已收集 ${allTrades.length} 笔交易，保存至 ${OUTPUT_FILE}`);
}

collectTrades().catch(console.error);
