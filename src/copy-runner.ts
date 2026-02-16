/**
 * 跟单运行器 v1：监控目标大佬的交易，自动跟单
 *
 * 工作原理：
 * 1. 每 5 秒拉取目标用户最新交易（Data API，公开无需认证）
 * 2. 检测新交易（通过 transactionHash 去重）
 * 3. 对每笔新 BUY 交易，按比例缩小后下单
 * 4. 对每笔新 SELL 交易，同样跟着卖出
 * 5. 持有到结算（赢方 $1 兑付）
 *
 * 过滤逻辑：
 * - 只跟价格 >= COPY_MIN_PRICE 的交易（过滤掉 $0.02~$0.05 的低价对冲单）
 * - 余额不足时自动暂停
 */

import * as fs from "fs";
import * as path from "path";
import { fetchTargetTrades, type TargetTrade } from "./api/data-api.js";
import { getOrderBook, createPolymarketClient, type PolymarketClient } from "./api/clob.js";
import { executeSignal } from "./execution/executor.js";
import { loadConfig } from "./config/index.js";

const STOP_FILE = path.join(process.cwd(), ".polymarket-bot-stop");
const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "copy-trade.log");

function logToFile(msg: string) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
    fs.appendFileSync(LOG_FILE, msg + "\n");
  } catch (e) {
    // 忽略日志写入异常
  }
}

function isStopRequested(): boolean {
  try { return fs.existsSync(STOP_FILE); } catch { return false; }
}
function clearStopFile(): void {
  try { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); } catch {}
}

export interface CopyRunnerOptions {
  pollIntervalMs?: number;
}

export async function runCopy(options: CopyRunnerOptions = {}): Promise<void> {
  const config = loadConfig();
  const POLL_MS = options.pollIntervalMs ?? 5000;

  // === 跟单参数 ===
  const TARGET_ADDRESS = config.copyTargetAddress;
  const COPY_SIZE_MAX = config.copySize;          // 每笔跟单最大股数（实际按预算换算）
  const MIN_PRICE = config.copyMinPrice;         // 只跟价格 >= 此值的交易
  const MAX_PRICE = config.copyMaxPrice;         // 只跟价格 <= 此值的交易
  const MAX_PENDING_COST = Math.min(config.copyMaxPendingCost, config.copyMaxBudget);
  const MAX_BUDGET = config.copyMaxBudget;       // 总预算，仓位+可用不超过此
  const MAX_AGE_SECONDS = config.copyMaxAgeSeconds; // Data API 有延迟，放宽到 300s
  const MIN_COPY_SHARES = 2;                     // 最少 1 股，平台允许最小1股
  const FETCH_TRADES_LIMIT = 50;                 // 每轮多拉一些，减少漏单

  if (!TARGET_ADDRESS) {
    console.error("Missing COPY_TARGET_ADDRESS in .env");
    process.exit(1);
  }
  if (!config.privateKey || !config.funderAddress) {
    console.error("Missing PRIVATE_KEY or POLYMARKET_FUNDER_ADDRESS.");
    process.exit(1);
  }

  const client = await createPolymarketClient(config);
  if (!client) {
    console.error("Failed to create Polymarket client.");
    process.exit(1);
  }

  clearStopFile();
  console.log("=== Polymarket 跟单 Bot v1 ===");
  console.log(`目标: ${TARGET_ADDRESS.slice(0, 10)}...`);
  console.log(`预算: $${MAX_BUDGET} | 单笔最多 ${COPY_SIZE_MAX} 股 | 价格 $${MIN_PRICE}~$${MAX_PRICE} | 交易年龄 <${MAX_AGE_SECONDS}s`);
  console.log("---");

  // 初始化
  console.log("[Init] 初始化交易授权...");
  await client.initializeAllowances();
  await client.cancelAll();

  let usdcBalance = 0;
  try {
    const bal = await client.getBalance();
    usdcBalance = parseFloat(bal.balance) || 0;
    console.log(`[Init] USDC 余额: $${usdcBalance.toFixed(2)}`);
  } catch {}

  // 已处理的交易哈希集合（防重复）
  const processedTxHashes = new Set<string>();
  // 跟单持仓追踪
  const copiedPositions = new Map<string, { tokenId: string; side: string; price: number; size: number; slug: string; ts: number }>();
  let totalPendingCost = 0;

  // 首次拉取 — 标记已有交易为"已处理"，不回溯跟单
  console.log("[Init] 加载目标用户历史交易...");
  const initialTrades = await fetchTargetTrades(TARGET_ADDRESS, 50);
  for (const t of initialTrades) {
    processedTxHashes.add(t.transactionHash);
  }
  console.log(`[Init] 已标记 ${processedTxHashes.size} 笔历史交易（不回溯跟单）`);
  console.log("---");
  console.log("[Running] 开始监控新交易...\n");

  let lastStatusLog = 0;
  const STATUS_LOG_MS = 30000;

  // === 主循环 ===
  const runOnce = async (): Promise<void> => {
    // === 自动清理已结算/无余额持仓，释放预算 ===
    for (const [tokenId, pos] of copiedPositions.entries()) {
      try {
        const bal = await client.getTokenBalance(tokenId);
        if (!bal || bal < 0.0001) {
          totalPendingCost -= pos.price * pos.size;
          copiedPositions.delete(tokenId);
          console.log(`[Clean] 已结算/无余额，释放持仓: ${tokenId} x${pos.size} $${(pos.price * pos.size).toFixed(2)}`);
        }
      } catch (e) {
        // 忽略单个异常
      }
    }
    if (isStopRequested()) {
      console.log("Stop requested. Exiting.");
      process.exit(0);
    }

    const nowMs = Date.now();

    // 状态日志
    if (nowMs - lastStatusLog >= STATUS_LOG_MS) {
      lastStatusLog = nowMs;
      console.log(`[Tick] USDC: $${usdcBalance.toFixed(2)} | 持仓: ${copiedPositions.size} 笔 $${totalPendingCost.toFixed(2)} | 已处理: ${processedTxHashes.size} 笔`);
    }

    // 拉取最新交易（多拉一些 + 超时，避免漏单或卡死）
    let trades: TargetTrade[];
    try {
      trades = await Promise.race([
        fetchTargetTrades(TARGET_ADDRESS, FETCH_TRADES_LIMIT),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fetch timeout 15s")), 15000)),
      ]);
    } catch (e) {
      console.error("[Copy] 拉取交易失败:", e instanceof Error ? e.message : e);
      return;
    }


    // 筛选新交易，并只保留BTC 15min/5min盘口
    const newTrades = trades.filter((t) => !processedTxHashes.has(t.transactionHash));
    if (newTrades.length === 0) return;

    // 按时间排序（旧 → 新）
    newTrades.sort((a, b) => a.timestamp - b.timestamp);

    for (const trade of newTrades) {
            // ...完全跟单逻辑，无特殊自动平仓处理...
      processedTxHashes.add(trade.transactionHash);

      const ageSeconds = Math.round(Date.now() / 1000 - trade.timestamp);
      const tradeInfo = `${trade.side} ${trade.outcome} @${trade.price.toFixed(2)} x${trade.size.toFixed(1)} | ${trade.slug?.slice(0, 35)} (${ageSeconds}s ago)`;

      // 记录大佬交易日志
      logToFile(`[LEADER] ${new Date(trade.timestamp * 1000).toISOString()} | ${tradeInfo} | tx: ${trade.transactionHash}`);

      // === 过滤条件 ===
      // 1. 太老的交易不跟（Data API 常有 1～3 分钟延迟，用 COPY_MAX_AGE_SECONDS 放宽）
      if (ageSeconds > MAX_AGE_SECONDS) {
        if (newTrades.indexOf(trade) <= 1) {
          console.log(`[Skip] 太旧 (${ageSeconds}s > ${MAX_AGE_SECONDS}s): ${tradeInfo}`);
        }
        continue;
      }

      // 2. 价格过滤
      if (trade.price < MIN_PRICE) {
        console.log(`[Skip] 价格太低 $${trade.price.toFixed(2)}: ${tradeInfo}`);
        continue;
      }
      if (trade.price > MAX_PRICE) {
        console.log(`[Skip] 价格太高 $${trade.price.toFixed(2)}: ${tradeInfo}`);
        continue;
      }

      // === 跟单执行 ===
      if (trade.side === "BUY") {
        // 3. 按预算换算股数：可用 = min(余额, 总预算-已用)
        const availableUsd = Math.min(usdcBalance, Math.max(0, MAX_BUDGET - totalPendingCost));
        const sizeByBudget = availableUsd / trade.price;
        const copySize = Math.max(MIN_COPY_SHARES, Math.min(COPY_SIZE_MAX, Math.floor(sizeByBudget)));
        const cost = trade.price * copySize;

        if (copySize < MIN_COPY_SHARES || cost < 0.5) {
          console.log(`[Skip] 预算不足 (可用$${availableUsd.toFixed(2)}): ${tradeInfo}`);
          continue;
        }

        if (usdcBalance < cost) {
          console.log(`[Skip] 余额不足 $${usdcBalance.toFixed(2)} < $${cost.toFixed(2)}: ${tradeInfo}`);
          continue;
        }

        if (totalPendingCost + cost > MAX_BUDGET) {
          console.log(`[Skip] 已达预算 $${totalPendingCost.toFixed(2)}+$${cost.toFixed(2)} > $${MAX_BUDGET}: ${tradeInfo}`);
          continue;
        }

        const sizeNote = copySize < COPY_SIZE_MAX ? ` (预算换算 ${copySize} 股)` : "";
        if (copySize === 1) {
          console.log(`[COPY BUY] ${tradeInfo}`);
          console.log(`  → 跟单: @${trade.price.toFixed(2)} x1 = $${cost.toFixed(2)} (预算仅够1股)`);
        } else {
          console.log(`[COPY BUY] ${tradeInfo}`);
          console.log(`  → 跟单: @${trade.price.toFixed(2)} x${copySize} = $${cost.toFixed(2)}${sizeNote}`);
        }

        try {
          // 先获取订单簿确认价格合理
          const book = await getOrderBook(trade.asset);
          const bestAsk = book?.asks?.[0];
          const tickSize = book?.tick_size || "0.01";
          const negRisk = book?.neg_risk || false;

          // 用目标的实际成交价或当前 ask（取较高者，确保能成交）
          let buyPrice = trade.price;
          if (bestAsk) {
            const currentAsk = parseFloat(bestAsk.price);
            buyPrice = Math.max(buyPrice, currentAsk); // 用更高价确保成交
          }
          // 价格修正到 tick
          const tick = parseFloat(tickSize);
          buyPrice = Math.round(buyPrice / tick) * tick;
          buyPrice = Math.round(buyPrice * 1e6) / 1e6;

          const signal = {
            type: "ev_arb" as const,
            tokenId: trade.asset,
            side: "BUY" as const,
            price: buyPrice,
            size: copySize,
            theoreticalProb: 0,
            marketPrice: buyPrice,
            secondsLeft: 0,
          };

          const r = await executeSignal(client, signal, tickSize, negRisk);
          // 记录自己下单日志
          logToFile(`[BOT BUY] ${new Date().toISOString()} | ${tradeInfo} | price: ${buyPrice} x${copySize} | cost: $${cost.toFixed(2)} | result: ${r.ok ? "OK" : r.error}`);
          if (r.ok) {
            console.log(`  ✅ 买入成功:`, r.orderIds);
            usdcBalance -= cost;
            totalPendingCost += cost;
            copiedPositions.set(trade.asset, {
              tokenId: trade.asset,
              side: trade.outcome,
              price: buyPrice,
              size: copySize,
              slug: trade.slug,
              ts: Date.now(),
            });
            // sync token 授权
            await client.syncTokenBalance(trade.asset);
          } else {
            console.error(`  ❌ 买入失败:`, r.error);
            // 余额不足时更新
            if (r.error?.includes("balance")) {
              const bal = await client.getBalance();
              usdcBalance = parseFloat(bal.balance) || 0;
              console.log(`  [Balance] 实际余额: $${usdcBalance.toFixed(2)}`);
            }
          }
        } catch (e) {
          console.error(`  [Error]`, e instanceof Error ? e.message : e);
        }
      }

      if (trade.side === "SELL") {
        // 检查是否有跟单持仓可以卖
        const pos = copiedPositions.get(trade.asset);
        if (!pos) {
          console.log(`[Skip] 无持仓可卖: ${tradeInfo}`);
          continue;
        }

        console.log(`[COPY SELL] ${tradeInfo}`);
        console.log(`  → 跟卖: @${trade.price.toFixed(2)} x${pos.size}`);

        try {
          await client.syncTokenBalance(trade.asset);
          await new Promise((r) => setTimeout(r, 2000));

          const book = await getOrderBook(trade.asset);
          const tickSize = book?.tick_size || "0.01";
          const negRisk = book?.neg_risk || false;
          const bestBid = book?.bids?.[0];

          let sellPrice = trade.price;
          if (bestBid) {
            const currentBid = parseFloat(bestBid.price);
            sellPrice = Math.min(sellPrice, currentBid); // 用更低价确保成交
          }
          const tick = parseFloat(tickSize);
          sellPrice = Math.round(sellPrice / tick) * tick;
          sellPrice = Math.round(sellPrice * 1e6) / 1e6;
          sellPrice = Math.max(0.01, sellPrice);

          const signal = {
            type: "stop_loss" as const,
            tokenId: trade.asset,
            side: "SELL" as const,
            price: sellPrice,
            size: pos.size,
            reason: "copy sell",
          };

          const r = await executeSignal(client, signal, tickSize, negRisk);
          // 记录自己卖出日志
          logToFile(`[BOT SELL] ${new Date().toISOString()} | ${tradeInfo} | price: ${sellPrice} x${pos.size} | result: ${r.ok ? "OK" : r.error}`);
          if (r.ok) {
            console.log(`  ✅ 卖出成功:`, r.orderIds);
            usdcBalance += sellPrice * pos.size;
            totalPendingCost -= pos.price * pos.size;
            copiedPositions.delete(trade.asset);
          } else {
            console.error(`  ❌ 卖出失败:`, r.error);
          }
        } catch (e) {
          console.error(`  [Error]`, e instanceof Error ? e.message : e);
        }
      }
    }
  };

  // 全局错误处理
  process.on("unhandledRejection", (err) => {
    console.error("[WARN] Unhandled:", err instanceof Error ? err.message : err);
  });
  process.on("uncaughtException", (err) => {
    console.error("[WARN] Uncaught:", err.message);
  });

  // 轮询
  const poll = async () => {
    try {
      await runOnce();
    } catch (e) {
      console.error("[WARN] runOnce err:", e instanceof Error ? e.message : e);
    }
    setTimeout(poll, POLL_MS);
  };

  poll();

  process.on("SIGINT", () => { process.exit(0); });
  process.on("SIGTERM", () => { process.exit(0); });
}
