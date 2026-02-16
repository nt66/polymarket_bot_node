/**
 * 主运行器 v5：盈亏优化版 Scalp 模式
 *
 * v4 → v5 改进（基于 12h 亏损 $16 复盘）：
 * 1. ENDGAME 加止损保护：不再死扛到结算，bid 跌超阈值就砍仓（-$0.20/share 默认）
 * 2. 止盈/止损比优化：止盈 +$0.10 / 止损 -$0.06，赢亏比 1.67（原 0.07/0.08=0.875）
 * 3. 最小持仓时间缩短：30s → 15s，减少"锁死亏损"时间
 * 4. 卖出失败 FOK 兜底：GTC 失败后用 FOK 市价单+降价确保成交
 * 5. ENDGAME 入场门槛降低：endgameMaxAsk 默认 0.95 → 0.88，只接高置信度
 *
 * 保留 v4 的改进：
 * - 卖出前检查代币余额 / BTC 震荡检测 / 止损冷却期 / BTC 偏离要求
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

  // ============ 核心参数（v5 优化） ============
  const PROFIT_TARGET = 0.10;      // 止盈 +$0.10/share（↑ 从 0.07，拉大盈利空间）
  const STOP_LOSS = 0.06;          // 止损 -$0.06/share（↓ 从 0.08，快速止损）
  const ENDGAME_STOP_LOSS = config.endgameStopLoss;  // ENDGAME 止损（v5 新增，默认 0.20）
  const MAX_HOLD_MS = 120_000;     // 最长持有 120 秒
  const MIN_HOLD_BEFORE_SELL_MS = 15_000;  // 卖出前至少持有 15 秒（↓ 从 30s，减少锁死亏损）
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
  console.log("=== Polymarket Scalp Bot v5（盈亏优化版） ===");
  console.log(`TREND  止盈+$${PROFIT_TARGET} | 止损-$${STOP_LOSS} | 赢亏比=${(PROFIT_TARGET / STOP_LOSS).toFixed(1)}`);
  console.log(`ENDGAME 止损-$${ENDGAME_STOP_LOSS} | maxAsk=${config.endgameMaxAsk} | 不再死扛到结算`);
  console.log(`持有${MIN_HOLD_BEFORE_SELL_MS / 1000}-${MAX_HOLD_MS / 1000}s | BTC偏离>$${MIN_BTC_DEVIATION} | 冷却${LOSS_COOLDOWN_MS / 1000}s`);
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

  // === v5: USDC 余额追踪（避免余额不足时狂刷 API）===
  let cachedUsdcBalance = 0;
  let lastBalanceCheckMs = 0;
  const BALANCE_CHECK_INTERVAL_MS = 60_000; // 每 60 秒刷新一次余额
  const BALANCE_INSUFFICIENT_COOLDOWN_MS = 120_000; // 余额不足时 120 秒后再检查
  let balanceInsufficientUntil = 0; // 余额不足冷却到期时间

  async function refreshUsdcBalance(): Promise<number> {
    try {
      const bal = await client!.getBalance();
      cachedUsdcBalance = parseFloat(bal.balance) || 0;
      lastBalanceCheckMs = Date.now();
      return cachedUsdcBalance;
    } catch {
      return cachedUsdcBalance;
    }
  }

  // 初始化余额
  cachedUsdcBalance = await refreshUsdcBalance();
  console.log(`[Balance] USDC 可用: $${cachedUsdcBalance.toFixed(2)}`);

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
    // Step 1: 强制 sync 授权（无论余额如何，先确保授权到位）
    console.log(`[EXIT] 同步 token 授权...`);
    await client!.syncTokenBalance(tokenId);
    await new Promise((r) => setTimeout(r, 2000));

    // Step 2: 检查实际代币余额，最多等待 20 秒
    let tokenBal = await client!.getTokenBalance(tokenId);
    const wantedSize = sig.size;
    let waitAttempts = 0;
    const MAX_WAIT_ATTEMPTS = 4; // 4次 × 5秒 = 20秒上限

    while (tokenBal < wantedSize && waitAttempts < MAX_WAIT_ATTEMPTS) {
      waitAttempts++;
      console.log(`[EXIT] 代币余额=${tokenBal}，需要${wantedSize}，等待结算(${waitAttempts}/${MAX_WAIT_ATTEMPTS})...`);
      await client!.syncTokenBalance(tokenId);
      await new Promise((r) => setTimeout(r, 5000));
      tokenBal = await client!.getTokenBalance(tokenId);
    }

    if (tokenBal < wantedSize) {
      console.error(`[EXIT] 代币不足(bal=${tokenBal}, need=${wantedSize})，无法卖出`);
      // 如果有部分余额，尝试卖部分
      if (tokenBal >= 5) {
        console.log(`[EXIT] 尝试卖出可用余额 ${tokenBal}...`);
        sig = { ...sig, size: Math.floor(tokenBal) };
      } else {
        return false;
      }
    }
    console.log(`[EXIT] 代币余额=${tokenBal}，开始卖出 ${sig.size}`);

    // Step 3: 再次 sync 确保授权包含最新余额
    await client!.syncTokenBalance(tokenId);
    await new Promise((r) => setTimeout(r, 2000));

    // Step 4: 卖出，最多重试 3 次（v5: 最后一次用 FOK 兜底）
    let sold = false;
    let sellPrice = sig.price;
    const sellSizeRounded = Math.floor(sig.size * 100) / 100;
    const sellSigBase = { ...sig, size: Math.max(0.01, sellSizeRounded) };
    const MAX_SELL_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_SELL_RETRIES && !sold; attempt++) {
      try {
        // 每次重试前都 sync 一次
        if (attempt > 0) {
          console.log(`[EXIT] 重试前再次 sync...`);
          await client!.syncTokenBalance(tokenId);
          await new Promise((r) => setTimeout(r, 3000));
        }

        // v5: 最后一次重试用 FOK（Fill or Kill）+ 大幅降价，确保成交
        const isLastAttempt = attempt === MAX_SELL_RETRIES - 1;
        const useOrderType: "GTC" | "FOK" = isLastAttempt ? "FOK" : "GTC";
        const finalPrice = isLastAttempt ? Math.max(0.01, sellPrice - 0.03) : sellPrice;

        if (isLastAttempt) {
          console.log(`[EXIT] 最后一次尝试：FOK @${finalPrice} (降价兜底)`);
        }

        const sellSig = { ...sellSigBase, price: finalPrice };
        const r = await executeSignal(client, sellSig as any, ctx.tickSize, ctx.negRisk, useOrderType);
        if (r.ok) {
          console.log(`[EXIT] 卖出成功(${useOrderType}):`, r.orderIds, `@${finalPrice} x${sellSig.size}`);
          sold = true;
        } else {
          console.error(`[EXIT] 卖出失败(${attempt + 1}/${MAX_SELL_RETRIES} ${useOrderType}):`, r.error || "unknown");
          if (r.error && r.error.includes("balance")) {
            // 余额/授权问题 → 再次 sync + 等待更长时间
            await client!.syncTokenBalance(tokenId);
            await new Promise((r) => setTimeout(r, 6000));
          } else {
            // 其他错误（价格问题等）→ 降价重试
            sellPrice = Math.max(0.01, sellPrice - 0.01);
            await new Promise((r) => setTimeout(r, 2000));
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
          // v5: ENDGAME 也有止损保护，不再无脑死扛
          const currentBid = currentBids.get(sig.tokenId);
          const endgamePnl = currentBid ? currentBid.price - pos!.avgPrice : 0;

          if (endgamePnl <= -ENDGAME_STOP_LOSS) {
            // ENDGAME 止损触发：bid 跌太多，大概率方向判错，砍仓止血
            const holdSec = Math.round((nowMs - pos!.entryTime) / 1000);
            const lossAmt = Math.abs(endgamePnl) * pos!.size;
            console.log(`[EXIT] ❌ENDGAME止损: ${pos!.side.toUpperCase()} 买@${pos!.avgPrice.toFixed(2)} 现@${currentBid?.price.toFixed(2)} -$${lossAmt.toFixed(2)} (${holdSec}s)`);
            // 不 continue，让下面的卖出逻辑执行
          } else {
            // ENDGAME 未触发止损，继续持有等结算
            const holdSec = Math.round((nowMs - pos!.entryTime) / 1000);
            if (nowMs - lastStatusLog < 200) {
              const pnlStr = endgamePnl >= 0 ? `+$${(endgamePnl * pos!.size).toFixed(2)}` : `-$${(Math.abs(endgamePnl) * pos!.size).toFixed(2)}`;
              console.log(`  [HOLD] ENDGAME ${pos!.side.toUpperCase()} @${pos!.avgPrice.toFixed(2)} ${pnlStr} (${holdSec}s) | 止损线-$${ENDGAME_STOP_LOSS}`);
            }
            continue;
          }
        }

        // === 最小持仓时间检查 ===
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
          // v5: 卖出后回收 USDC，刷新余额缓存
          cachedUsdcBalance += sig.price * sig.size;
          await refreshUsdcBalance();
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

      // v5: 余额不足保护（不狂刷 API）
      if (nowMs < balanceInsufficientUntil) {
        if (nowMs - lastStatusLog < 200) {
          console.log(`  [💰] 余额不足冷却中，${Math.round((balanceInsufficientUntil - nowMs) / 1000)}s 后重试`);
        }
        continue;
      }
      // 定期刷新余额
      if (nowMs - lastBalanceCheckMs > BALANCE_CHECK_INTERVAL_MS) {
        await refreshUsdcBalance();
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
            // v5: 买入前检查 USDC 余额
            if (cachedUsdcBalance < cost) {
              if (nowMs - lastStatusLog < 200) {
                console.log(`  [💰] USDC 余额 $${cachedUsdcBalance.toFixed(2)} < 需要 $${cost.toFixed(2)}，跳过`);
              }
              // 刷新一次确认真的不够
              await refreshUsdcBalance();
              if (cachedUsdcBalance < cost) {
                balanceInsufficientUntil = nowMs + BALANCE_INSUFFICIENT_COOLDOWN_MS;
                console.log(`[💰] 余额确认不足 $${cachedUsdcBalance.toFixed(2)}，冷却 ${BALANCE_INSUFFICIENT_COOLDOWN_MS / 1000}s 不再尝试买入`);
              }
              continue;
            }
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
                  cachedUsdcBalance -= cost; // 更新本地余额缓存
                  await refreshUsdcBalance(); // 买入后强制刷新余额
                  // 买入后 sync token 授权（重试 3 次）
                  for (let si = 0; si < 3; si++) {
                    const ok = await client.syncTokenBalance(tokenId);
                    if (ok) break;
                    await new Promise((r) => setTimeout(r, 2000));
                  }
                } else {
                  console.error(`[TREND] 买入失败:`, r.error);
                  // v5: 检测余额不足错误，进入冷却
                  if (r.error && r.error.includes("balance")) {
                    await refreshUsdcBalance();
                    balanceInsufficientUntil = nowMs + BALANCE_INSUFFICIENT_COOLDOWN_MS;
                    console.log(`[💰] API 报余额不足，实际 $${cachedUsdcBalance.toFixed(2)}，冷却 ${BALANCE_INSUFFICIENT_COOLDOWN_MS / 1000}s`);
                  }
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
            // v5: 余额检查
            if (cachedUsdcBalance < cost) {
              continue; // 静默跳过（TREND 区已打印过余额警告）
            }
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
                  cachedUsdcBalance -= cost; // 更新本地余额缓存
                  await refreshUsdcBalance(); // 买入后强制刷新余额
                  for (let si = 0; si < 3; si++) {
                    const ok = await client.syncTokenBalance(tokenId);
                    if (ok) break;
                    await new Promise((r) => setTimeout(r, 2000));
                  }
                } else {
                  console.error(`[ENDGAME] 买入失败:`, r.error);
                  if (r.error && r.error.includes("balance")) {
                    await refreshUsdcBalance();
                    balanceInsufficientUntil = nowMs + BALANCE_INSUFFICIENT_COOLDOWN_MS;
                  }
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
              await refreshUsdcBalance(); // NegRisk 买入后强制刷新余额
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
