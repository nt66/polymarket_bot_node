/**
 * 主运行器 v4：强化版 Scalp 模式
 *
 * v3 → v4 改进（基于交易复盘）：
 * 1. 卖出前检查实际代币余额（getTokenBalance），避免 "not enough balance"
 * 2. 最小持仓时间从 10s → 30s，给 Polymarket 后端足够时间结算代币
 * 3. BTC 震荡检测：如果 BTC 60秒内波幅 > $80 但方向不明，不入场
 * 4. 要求 BTC 偏离起点 > $40 才允许 TREND 入场
 * 5. 止损后 90 秒冷却期，不在同一市场立即重入
 * 6. 止损收紧到 $0.08/share（从 $0.10），止盈保持 $0.07/share
 * 7. TREND_MIN_BID 默认提高到 0.70（少而准）
 */

import * as fs from "fs";
import * as path from "path";
import { getBtc15MinMarkets, getBtc5MinMarkets } from "./api/gamma.js";
import { getOrderBooks, createPolymarketClient } from "./api/clob.js";
import { connectOkxBtcSpot, closeOkxWs, fetchBtcPriceHttp } from "./api/okx-ws.js";
import type WebSocket from "ws";
import type { GammaMarket, Btc15mResult } from "./api/gamma.js";
import type { MarketContext } from "./strategies/types.js";
import { checkNegRiskArb } from "./strategies/neg-risk-arb.js";
import { executeSignal } from "./execution/executor.js";
import { loadConfig } from "./config/index.js";
import { PositionTracker } from "./risk/position-tracker.js";

const STOP_FILE = path.join(process.cwd(), ".polymarket-bot-stop");

export function isStopRequested(): boolean {
  try { return fs.existsSync(STOP_FILE); } catch { return false; }
}
export function requestStop(): void {
  try { fs.writeFileSync(STOP_FILE, String(Date.now()), "utf8"); } catch (e) { console.error("stop err:", e); }
}
function clearStopFile(): void {
  try { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); } catch {}
}

function findYesToken(market: GammaMarket) {
  return market.tokens?.find((t) => /^(yes|up)$/i.test(t.outcome)) ?? market.tokens?.[0];
}
function findNoToken(market: GammaMarket) {
  return market.tokens?.find((t) => /^(no|down)$/i.test(t.outcome)) ?? market.tokens?.[1];
}

function buildMarketContext(market: GammaMarket, yesBook: any, noBook: any): MarketContext {
  const yesToken = findYesToken(market);
  const noToken = findNoToken(market);
  return {
    market,
    yesTokenId: yesToken?.token_id ?? "",
    noTokenId: noToken?.token_id ?? "",
    yesBook: yesBook ?? null,
    noBook: noBook ?? null,
    tickSize: "0.01",
    negRisk: !!market.negRisk,
  };
}

function formatSeconds(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

export interface RunnerOptions {
  pollIntervalMs?: number;
  marketRefreshMs?: number;
}

export async function run(options: RunnerOptions = {}): Promise<void> {
  const config = loadConfig();
  const FAST_POLL_MS = options.pollIntervalMs ?? 2000;
  const IDLE_POLL_MS = 30000;
  const marketRefreshMs = options.marketRefreshMs ?? 30000;

  // ============ 核心参数 ============
  const PROFIT_TARGET = 0.07;      // 止盈 +$0.07/share
  const STOP_LOSS = 0.08;          // 止损 -$0.08/share（收紧，减少损失）
  const MAX_HOLD_MS = 120_000;     // 最长持有 120 秒
  const MIN_HOLD_BEFORE_SELL_MS = 30_000;  // 卖出前至少持有 30 秒（代币结算时间）
  const MIN_BTC_DEVIATION = 40;    // BTC 至少偏离起点 $40 才入场
  const LOSS_COOLDOWN_MS = 90_000; // 止损后 90 秒冷却期
  const CHOPPY_THRESHOLD = 80;     // BTC 60秒内波幅 > $80 视为震荡
  // ==================================

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
  console.log("=== Polymarket Scalp Bot v4 ===");
  console.log(`止盈+$${PROFIT_TARGET} | 止损-$${STOP_LOSS} | 持有30-${MAX_HOLD_MS / 1000}s | BTC偏离>$${MIN_BTC_DEVIATION} | 止损冷却${LOSS_COOLDOWN_MS / 1000}s`);
  console.log("---");

  // === 初始化授权（USDC + Outcome tokens） ===
  console.log("[Init] 初始化交易授权...");
  await client.initializeAllowances();

  // 取消所有之前的挂单
  await client.cancelAll();

  // 打印余额
  try {
    const bal = await client.getBalance();
    console.log(`[Init] USDC 余额: $${bal.balance} | 授权: $${bal.allowance}`);
  } catch {}
  console.log("---");

  let marketResult: Btc15mResult = { allMarkets: [], inWindow: [], upcoming: [], nextStartsInSec: -1 };
  let lastBtcPrice = 0;
  let okxWs: WebSocket | null = null;
  const marketStartPrices = new Map<string, number>();

  // === BTC 价格历史（用于震荡检测）===
  const btcPriceHistory: Array<{ price: number; ts: number }> = [];
  const BTC_HISTORY_WINDOW_MS = 60_000; // 60 秒窗口

  // === 止损冷却追踪 ===
  const lossCooldownUntil = new Map<string, number>(); // market slug → cooldown expires timestamp

  // === Scalp 风控 ===
  const tracker = new PositionTracker({
    profitTarget: PROFIT_TARGET,
    stopLoss: STOP_LOSS,
    maxHoldMs: MAX_HOLD_MS,
    maxPositionPerMarket: config.maxPositionPerMarket,
    maxTradesPerWindow: config.maxTradesPerWindow,
  });

  // === 市场刷新 ===
  async function refreshMarkets(): Promise<void> {
    try {
      const result = config.btcMarketMode === "5m"
        ? await getBtc5MinMarkets()
        : await getBtc15MinMarkets(config.btc15MinTagId || undefined, config.btc15MinSlug || undefined);
      marketResult = result;
      if (result.inWindow.length > 0) {
        const info = result.inWindow.map((m) => {
          const endMs = m.endDate ? new Date(m.endDate).getTime() : 0;
          return `${m.slug?.slice(0, 35)}(${formatSeconds(Math.round((endMs - Date.now()) / 1000))} left)`;
        }).join(" | ");
        console.log(`[Markets] ${result.inWindow.length} active: ${info}`);
      } else {
        const nextInfo = result.nextStartsInSec >= 0 ? `next in ${formatSeconds(result.nextStartsInSec)}` : "none";
        console.log(`[Markets] No active market. ${nextInfo}`);
      }
    } catch (e) {
      console.error("Market refresh err:", e);
    }
  }

  await refreshMarkets();

  // === BTC 震荡检测 ===
  function isBtcChoppy(): boolean {
    const now = Date.now();
    const recent = btcPriceHistory.filter((p) => p.ts > now - BTC_HISTORY_WINDOW_MS);
    if (recent.length < 5) return false;
    const prices = recent.map((p) => p.price);
    const range = Math.max(...prices) - Math.min(...prices);
    if (range < CHOPPY_THRESHOLD) return false;

    // 判断是否有明确方向：如果最新价接近区间一端（>70%位置），认为有方向性
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const latest = prices[prices.length - 1];
    const position = (latest - min) / (max - min); // 0=最低 1=最高
    const hasDirection = position > 0.75 || position < 0.25;

    if (!hasDirection) {
      return true; // 震荡：大波幅但无方向
    }
    return false;
  }

  function recordBtcPrice(price: number): void {
    const now = Date.now();
    btcPriceHistory.push({ price, ts: now });
    // 清理超过 120 秒的老数据
    while (btcPriceHistory.length > 0 && btcPriceHistory[0].ts < now - 120_000) {
      btcPriceHistory.shift();
    }
  }

  // === OKX WebSocket + 延迟套利入场信号 ===
  let latencySignalDirection: "up" | "down" | null = null;
  let latencySignalTime = 0;

  if (config.strategyLatencyArb) {
    const WINDOW_MS = 10_000;
    const COOLDOWN_MS = 15_000;
    const priceWindow: Array<{ price: number; ts: number }> = [];
    let lastSignalMs = 0;

    console.log(`[Latency] 10s 窗口 >= $${config.latencyMinJumpUsd} 触发，cooldown 15s`);

    okxWs = connectOkxBtcSpot((price) => {
      lastBtcPrice = price;
      recordBtcPrice(price);
      const now = Date.now();

      priceWindow.push({ price, ts: now });
      while (priceWindow.length > 0 && priceWindow[0].ts < now - WINDOW_MS) {
        priceWindow.shift();
      }
      if (priceWindow.length < 3) return;

      const prices = priceWindow.map((p) => p.price);
      const range = Math.max(...prices) - Math.min(...prices);
      if (range < config.latencyMinJumpUsd) return;
      if (now - lastSignalMs < COOLDOWN_MS) return;
      if (marketResult.inWindow.length === 0) return;

      const activeKey = marketResult.inWindow[0]?.conditionId || marketResult.inWindow[0]?.slug || "";
      const startPrice = marketStartPrices.get(activeKey);
      const dir = startPrice ? (price > startPrice ? "up" : "down") : (price > priceWindow[0].price ? "up" : "down");

      lastSignalMs = now;
      latencySignalDirection = dir as "up" | "down";
      latencySignalTime = now;
      console.log(`[Latency] 信号: BTC 10s波幅$${range.toFixed(0)} → ${dir === "up" ? "↑Up" : "↓Down"}`);
    });
  }

  let lastMarketRefresh = Date.now();
  let lastStatusLog = 0;
  const STATUS_LOG_MS = 30000;

  // === 卖出辅助函数：检查余额 + sync + 卖出，带完整重试 ===
  async function attemptSell(
    tokenId: string,
    sig: { tokenId: string; side: "SELL"; price: number; size: number; reason: string; type: string },
    ctx: MarketContext
  ): Promise<boolean> {
    // Step 1: 检查实际代币余额
    let tokenBal = await client!.getTokenBalance(tokenId);
    if (tokenBal <= 0) {
      console.log(`[EXIT] 代币余额=0，等待结算... (sync + 5s)`);
      await client!.syncTokenBalance(tokenId);
      await new Promise((r) => setTimeout(r, 5000));
      tokenBal = await client!.getTokenBalance(tokenId);
      if (tokenBal <= 0) {
        console.log(`[EXIT] 代币仍未到账(bal=${tokenBal})，再等 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
        tokenBal = await client!.getTokenBalance(tokenId);
      }
      if (tokenBal <= 0) {
        console.error(`[EXIT] 代币未到账(bal=${tokenBal})，无法卖出`);
        return false;
      }
    }
    console.log(`[EXIT] 代币余额=${tokenBal}，开始卖出`);

    // Step 2: sync token allowance
    await client!.syncTokenBalance(tokenId);
    await new Promise((r) => setTimeout(r, 1500));

    // Step 3: 卖出，最多重试 3 次
    let sold = false;
    let sellPrice = sig.price;
    const sellSizeRounded = Math.floor(sig.size * 100) / 100;
    const sellSigBase = { ...sig, size: Math.max(0.01, sellSizeRounded) };

    for (let attempt = 0; attempt < 3 && !sold; attempt++) {
      try {
        const sellSig = { ...sellSigBase, price: sellPrice };
        const r = await executeSignal(client, sellSig as any, ctx.tickSize, ctx.negRisk);
        if (r.ok) {
          console.log(`[EXIT] 卖出成功:`, r.orderIds, `@${sellPrice} x${sellSig.size}`);
          sold = true;
        } else {
          console.error(`[EXIT] 卖出失败(${attempt + 1}/3):`, r.error || "unknown");
          if (r.error && r.error.includes("balance")) {
            // 余额问题 → 再次 sync + 等待
            await client!.syncTokenBalance(tokenId);
            await new Promise((r) => setTimeout(r, 4000));
          } else {
            sellPrice = Math.max(0.01, sellPrice - 0.01);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      } catch (e) {
        console.error("[EXIT] err:", e instanceof Error ? e.message : e);
        sellPrice = Math.max(0.01, sellPrice - 0.01);
      }
    }
    return sold;
  }

  // === 主循环 ===
  const runOnce = async (): Promise<void> => {
    if (isStopRequested()) {
      if (okxWs) closeOkxWs(okxWs);
      console.log("Stop. Exiting.");
      process.exit(0);
    }

    if (Date.now() - lastMarketRefresh > marketRefreshMs) {
      await refreshMarkets();
      lastMarketRefresh = Date.now();
    }

    const nowMs = Date.now();
    const activeMarkets = marketResult.inWindow;

    // HTTP 备用 BTC 价格
    if (lastBtcPrice <= 0) {
      const p = await fetchBtcPriceHttp();
      if (p) {
        lastBtcPrice = p;
        recordBtcPrice(p);
        console.log(`[BTC] HTTP: $${p.toFixed(2)}`);
      }
    }

    // 状态日志
    if (nowMs - lastStatusLog >= STATUS_LOG_MS) {
      lastStatusLog = nowMs;
      const btcStr = lastBtcPrice > 0 ? `$${lastBtcPrice.toFixed(0)}` : "—";
      const posStr = tracker.getSummary();
      const choppyStr = isBtcChoppy() ? " ⚠CHOPPY" : "";
      if (activeMarkets.length > 0) {
        const info = activeMarkets.map((m) => {
          const endMs = m.endDate ? new Date(m.endDate).getTime() : 0;
          return `${m.slug?.slice(0, 28)}(${Math.round((endMs - nowMs) / 1000)}s)`;
        }).join(", ");
        console.log(`[Tick] BTC ${btcStr}${choppyStr} | ${info}${posStr ? " | " + posStr : ""}`);
      } else {
        console.log(`[Tick] BTC ${btcStr}${choppyStr} | idle${posStr ? " | " + posStr : ""}`);
      }
    }

    if (activeMarkets.length === 0) return;

    // 获取订单簿
    const tokenIds = activeMarkets.flatMap((m) => m.tokens?.map((t) => t.token_id) ?? []).filter(Boolean);
    let books: Map<string, any>;
    try {
      books = await getOrderBooks(tokenIds);
    } catch (e) {
      return;
    }

    const activeSlugs = new Set(activeMarkets.map((m) => m.slug || "").filter(Boolean));
    tracker.cleanupExpiredMarkets(activeSlugs);

    for (const market of activeMarkets) {
      const yesToken = findYesToken(market);
      const noToken = findNoToken(market);
      if (!yesToken || !noToken) continue;

      const ctx = buildMarketContext(
        market,
        books.get(yesToken.token_id) ?? null,
        books.get(noToken.token_id) ?? null
      );
      const slug = market.slug || "";
      const mKey = market.conditionId || slug || market.id;

      // 记录起点价
      if (!marketStartPrices.has(mKey) && lastBtcPrice > 0) {
        marketStartPrices.set(mKey, lastBtcPrice);
        console.log(`[Start] ${slug?.slice(0, 30)}: BTC $${lastBtcPrice.toFixed(0)}`);
      }

      // 构建 bids map
      const currentBids = new Map<string, { price: number; size: number }>();
      if (ctx.yesBook?.bids?.[0]) {
        currentBids.set(ctx.yesTokenId, {
          price: parseFloat(ctx.yesBook.bids[0].price),
          size: parseFloat(ctx.yesBook.bids[0].size),
        });
      }
      if (ctx.noBook?.bids?.[0]) {
        currentBids.set(ctx.noTokenId, {
          price: parseFloat(ctx.noBook.bids[0].price),
          size: parseFloat(ctx.noBook.bids[0].size),
        });
      }

      // ========== 第一优先：检查出场 ==========
      const exitSignals = tracker.checkScalpExit(currentBids);
      for (const sig of exitSignals) {
        const pos = tracker.getPosition(sig.tokenId);
        const endMsForCheck = market.endDate ? new Date(market.endDate).getTime() : 0;
        const entrySecsBeforeEnd = (endMsForCheck - (pos?.entryTime || 0)) / 1000;
        const isEndgamePos = pos && entrySecsBeforeEnd <= 130;

        if (isEndgamePos) {
          const holdSec = Math.round((nowMs - pos!.entryTime) / 1000);
          if (nowMs - lastStatusLog < 200) {
            console.log(`  [HOLD] ENDGAME 持仓 ${pos!.side.toUpperCase()} @${pos!.avgPrice} (${holdSec}s) → 等结算`);
          }
          continue;
        }

        // === 最小持仓时间检查（30秒）===
        const holdMs = nowMs - (pos?.entryTime || 0);
        if (holdMs < MIN_HOLD_BEFORE_SELL_MS) {
          const waitSec = Math.round((MIN_HOLD_BEFORE_SELL_MS - holdMs) / 1000);
          // 只在首次打印，避免刷屏
          if (holdMs > MIN_HOLD_BEFORE_SELL_MS - 3000) {
            console.log(`[EXIT] 持仓 ${Math.round(holdMs / 1000)}s，还需等 ${waitSec}s 让代币结算`);
          }
          continue;
        }

        console.log(`[EXIT] ${sig.reason}`);

        // 使用增强版卖出函数（检查余额 + sync + 重试）
        const sold = await attemptSell(sig.tokenId, sig, ctx);
        if (sold) {
          tracker.recordSell(sig.tokenId, sig.size);
          // 如果是止损，设置冷却期
          if (sig.reason.includes("止损")) {
            lossCooldownUntil.set(slug, nowMs + LOSS_COOLDOWN_MS);
            console.log(`[COOL] ${slug.slice(0, 20)} 止损冷却 ${LOSS_COOLDOWN_MS / 1000}s，不再入场`);
          }
        } else {
          console.error("[EXIT] 3次卖出均失败，强制清仓标记");
          tracker.recordSell(sig.tokenId, sig.size);
          // 卖出失败也设置冷却
          lossCooldownUntil.set(slug, nowMs + LOSS_COOLDOWN_MS);
        }
      }

      // ========== 第二优先：如果有持仓，不开新单 ==========
      if (tracker.hasOpenPosition()) continue;

      // ========== 第三优先：检查入场 ==========
      const endMs = market.endDate ? new Date(market.endDate).getTime() : 0;
      const secsLeft = (endMs - nowMs) / 1000;

      // 不在最后 15 秒入场
      if (secsLeft <= 15) continue;

      // 冷却期检查
      const cooldownExpiry = lossCooldownUntil.get(slug);
      if (cooldownExpiry && nowMs < cooldownExpiry) {
        if (nowMs - lastStatusLog < 200) {
          console.log(`  [COOL] 冷却中，还剩 ${Math.round((cooldownExpiry - nowMs) / 1000)}s`);
        }
        continue;
      }

      // 消费延迟信号
      if (latencySignalDirection) latencySignalDirection = null;

      // 用市场概率验证方向
      const upAsk = ctx.yesBook?.asks?.[0] ? parseFloat(ctx.yesBook.asks[0].price) : 0.5;
      const downAsk = ctx.noBook?.asks?.[0] ? parseFloat(ctx.noBook.asks[0].price) : 0.5;
      const upBid = ctx.yesBook?.bids?.[0] ? parseFloat(ctx.yesBook.bids[0].price) : 0.5;
      const downBid = ctx.noBook?.bids?.[0] ? parseFloat(ctx.noBook.bids[0].price) : 0.5;

      const marketDir = upBid > downBid ? "up" : "down";

      const startPrice = marketStartPrices.get(mKey);
      if (lastBtcPrice > 0) {
        const diff = startPrice ? lastBtcPrice - startPrice : 0;
        const absDiff = startPrice ? Math.abs(diff) : 0;
        const btcDir = diff > 0 ? "up" : "down";

        const dir = marketDir;

        // 安全检查1：BTC 方向与市场方向需一致
        const btcAgrees = !startPrice || btcDir === dir || absDiff < 20;

        // 安全检查2：BTC 震荡时不入场
        if (isBtcChoppy()) {
          if (nowMs - lastStatusLog < 200) {
            console.log(`  [⚠CHOPPY] BTC 震荡，跳过入场`);
          }
          continue;
        }

        const book = dir === "up" ? ctx.yesBook : ctx.noBook;
        const tokenId = dir === "up" ? ctx.yesTokenId : ctx.noTokenId;
        const bestAsk = book?.asks?.[0];

        const ensureMinCost = (price: number, minSize: number): number => {
          if (price * minSize < 1.0) return Math.ceil(1.0 / price);
          return minSize;
        };

        const winnerBid = dir === "up" ? upBid : downBid;

        // === 策略1: TREND（要求 BTC 偏离 > $40 + bid >= 0.70 + BTC 方向一致）===
        if (secsLeft > 120 && winnerBid >= config.trendMinBid && btcAgrees && bestAsk && absDiff >= MIN_BTC_DEVIATION) {
          const askPrice = parseFloat(bestAsk.price);
          const askSize = parseFloat(bestAsk.size);
          const minSize = ensureMinCost(askPrice, 5);
          const size = Math.max(minSize, Math.min(askSize, config.orderSizeMax));

          if (askPrice >= 0.50 && askPrice <= 0.75 && size >= 5) {
            const cost = askPrice * size;
            if (tracker.canBuy(slug, cost) && cost >= 1.0) {
              console.log(`[TREND] ${dir === "up" ? "Up" : "Down"} bid=${winnerBid} ask=${askPrice} BTC${diff >= 0 ? "+" : ""}$${diff.toFixed(0)} | @${askPrice} x${size}=$${cost.toFixed(2)} | ${Math.round(secsLeft)}s`);
              try {
                const signal = {
                  type: "ev_arb" as const,
                  tokenId,
                  side: "BUY" as const,
                  price: askPrice,
                  size,
                  theoreticalProb: 0,
                  marketPrice: askPrice,
                  secondsLeft: secsLeft,
                };
                const r = await executeSignal(client, signal, ctx.tickSize, ctx.negRisk);
                if (r.ok) {
                  console.log(`[TREND] 买入成功:`, r.orderIds);
                  tracker.recordBuy(tokenId, dir as "up" | "down", askPrice, size, slug);
                  // 买入后 sync token 授权（重试 3 次）
                  for (let si = 0; si < 3; si++) {
                    const ok = await client.syncTokenBalance(tokenId);
                    if (ok) break;
                    await new Promise((r) => setTimeout(r, 2000));
                  }
                } else {
                  console.error(`[TREND] 买入失败:`, r.error);
                }
              } catch (e) {
                console.error("[TREND] err:", e);
              }
              continue;
            }
          }
        }

        // === 策略2: ENDGAME（末日轮，持有到结算）===
        if (secsLeft <= 120 && secsLeft >= 15 && winnerBid >= 0.80 && bestAsk) {
          const askPrice = parseFloat(bestAsk.price);
          const askSize = parseFloat(bestAsk.size);
          const minSize = ensureMinCost(askPrice, 5);
          const size = Math.max(minSize, Math.min(askSize, config.orderSizeMax));

          if (askPrice <= config.endgameMaxAsk && size >= 5) {
            const cost = askPrice * size;
            const expectedProfit = (1.0 - askPrice) * size;
            if (tracker.canBuy(slug, cost) && cost >= 1.0) {
              console.log(`[ENDGAME] ${dir === "up" ? "Up" : "Down"} bid=${winnerBid} @${askPrice} x${size} | cost=$${cost.toFixed(2)} 利润=$${expectedProfit.toFixed(2)} | ${Math.round(secsLeft)}s left`);
              try {
                const signal = {
                  type: "ev_arb" as const,
                  tokenId,
                  side: "BUY" as const,
                  price: askPrice,
                  size,
                  theoreticalProb: 0,
                  marketPrice: askPrice,
                  secondsLeft: secsLeft,
                };
                const r = await executeSignal(client, signal, ctx.tickSize, ctx.negRisk);
                if (r.ok) {
                  console.log(`[ENDGAME] 买入成功:`, r.orderIds, `→ 等结算 (~${Math.round(secsLeft)}s)`);
                  tracker.recordBuy(tokenId, dir as "up" | "down", askPrice, size, slug);
                  for (let si = 0; si < 3; si++) {
                    const ok = await client.syncTokenBalance(tokenId);
                    if (ok) break;
                    await new Promise((r) => setTimeout(r, 2000));
                  }
                } else {
                  console.error(`[ENDGAME] 买入失败:`, r.error);
                }
              } catch (e) {
                console.error("[ENDGAME] err:", e);
              }
              continue;
            }
          }
        }

        // 状态日志
        if (nowMs - lastStatusLog < 200 && bestAsk) {
          const askP = parseFloat(bestAsk.price);
          const zone = secsLeft <= 120 ? "🔴末日轮" : secsLeft <= 300 ? "🟡末5min" : "⚪监控中";
          const dirStr = dir === "up" ? "Up" : "Down";
          const deviationStr = absDiff >= MIN_BTC_DEVIATION ? "" : ` (BTC偏离$${absDiff.toFixed(0)}<$${MIN_BTC_DEVIATION})`;
          console.log(`  [${zone}] BTC${diff > 0 ? "+" : ""}$${diff.toFixed(0)} | ${dirStr} ask=${askP} | ${Math.round(secsLeft)}s${deviationStr}`);
        }
      } else if (latencySignalDirection) {
        latencySignalDirection = null;
      }

      // --- NegRisk（保留） ---
      if (config.strategyNegRiskArb && ctx.yesBook?.asks?.[0] && ctx.noBook?.asks?.[0]) {
        const askYes = parseFloat(ctx.yesBook.asks[0].price);
        const askNo = parseFloat(ctx.noBook.asks[0].price);
        const sum = askYes + askNo;

        if (nowMs - lastStatusLog < 200) {
          console.log(`  [NegRisk] Up=${askYes} Down=${askNo} sum=${sum.toFixed(3)} (need <${config.negRiskMaxSum})`);
        }

        const negSignal = checkNegRiskArb(ctx, { maxSum: config.negRiskMaxSum, orderSizeMin: config.orderSizeMin, orderSizeMax: config.orderSizeMax });
        if (negSignal) {
          const cost = negSignal.askYes * negSignal.size + negSignal.askNo * negSignal.size;
          if (tracker.canBuy(slug, cost)) {
            console.log(`[ENTER] NegRisk: sum=${negSignal.sum.toFixed(3)} 保底利润!`);
            const r = await executeSignal(client, negSignal, ctx.tickSize, ctx.negRisk);
            if (r.ok) {
              console.log("[ENTER] NegRisk 成功:", r.orderIds);
              tracker.recordBuy(negSignal.yesTokenId, "up", negSignal.askYes, negSignal.size, slug);
              tracker.recordBuy(negSignal.noTokenId, "down", negSignal.askNo, negSignal.size, slug);
            }
          }
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

  // 智能轮询
  const smartPoll = async () => {
    try {
      await runOnce();
    } catch (e) {
      console.error("[WARN] runOnce err:", e instanceof Error ? e.message : e);
    }
    const pollMs = tracker.hasOpenPosition() ? 1000
      : marketResult.inWindow.length > 0 ? FAST_POLL_MS
      : IDLE_POLL_MS;
    setTimeout(smartPoll, pollMs);
  };

  smartPoll();

  process.on("SIGINT", () => { if (okxWs) closeOkxWs(okxWs); requestStop(); process.exit(0); });
  process.on("SIGTERM", () => { if (okxWs) closeOkxWs(okxWs); requestStop(); process.exit(0); });
}
