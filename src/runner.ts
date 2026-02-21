import * as fs from "fs";
import * as path from "path";
import { getAll5MinMarketsFast } from "./api/gamma.js";
import { getOrderBooks, createPolymarketClient } from "./api/clob.js";
import {
  getCurrentBtcPrice,
  getCurrentEthPrice,
  getCurrentSolPrice,
  getCurrentXrpPrice,
  getBtcPriceAtTimestamp,
  getEthPriceAtTimestamp,
  getSolPriceAtTimestamp,
  getXrpPriceAtTimestamp,
} from "./api/btc-price.js";
import {
  initBinancePrice,
  getBinanceBtcPrice,
  DUAL_EXCHANGE_DIVERGENCE_THRESHOLD,
} from "./api/binance-ws.js";
import type { GammaMarket, Btc15mResult } from "./api/gamma.js";
import type { MarketContext } from "./strategies/types.js";
import { executeSignal } from "./execution/executor.js";
import { loadConfig } from "./config/index.js";
import { PositionTracker } from "./risk/position-tracker.js";
import { logTrade, logRoundEnd } from "./util/daily-log.js";
import { notifyPnL } from "./notify/telegram.js";

// === 四盘（BTC / ETH / SOL / XRP）动态风险配置 ===
type Coin = "btc" | "eth" | "sol" | "xrp";
const VOLATILITY_WINDOW_SIZE = 40;

// 按币种：基础安全价差 + 动量拦截门槛 + 盘口深度限制
const COIN_CONFIG: Record<Coin, { baseSafeGap: number; momentumThreshold: number; maxAskDepthUsd: number }> = {
  btc: { baseSafeGap: 15, momentumThreshold: 4.5, maxAskDepthUsd: 4000 },
  eth: { baseSafeGap: 1.2, momentumThreshold: 0.4, maxAskDepthUsd: 1500 },
  sol: { baseSafeGap: 0.22, momentumThreshold: 0.04, maxAskDepthUsd: 600 },
  xrp: { baseSafeGap: 0.012, momentumThreshold: 0.005, maxAskDepthUsd: 800 },
};

const btcPriceHistory: number[] = [];
const ethPriceHistory: number[] = [];
const solPriceHistory: number[] = [];
const xrpPriceHistory: number[] = [];

// 从 slug 中提取币种
function getCoinFromSlug(slug: string): Coin | null {
  if (/^btc-updown-5m-/.test(slug)) return "btc";
  if (/^eth-updown-5m-/.test(slug)) return "eth";
  if (/^sol-updown-5m-/.test(slug)) return "sol";
  if (/^xrp-updown-5m-/.test(slug)) return "xrp";
  return null;
}

// 获取币种的价格历史
function getPriceHistory(coin: Coin): number[] {
  switch (coin) {
    case "btc": return btcPriceHistory;
    case "eth": return ethPriceHistory;
    case "sol": return solPriceHistory;
    case "xrp": return xrpPriceHistory;
  }
}

/** V 字防护：百分比乖离率，适应不同币种价格基数（BTC 更严苛，ETH/SOL 略宽） */
const V_GUARD_LONG_LEN = 20;

function isPriceOverextended(currentPrice: number, history: number[], coin: Coin): boolean {
  if (history.length < V_GUARD_LONG_LEN) return false;
  const longAvg = history.slice(-V_GUARD_LONG_LEN).reduce((a, b) => a + b, 0) / V_GUARD_LONG_LEN;
  const deviationPercent = Math.abs(currentPrice - longAvg) / longAvg;
  const threshold = coin === "btc" ? 0.0006 : 0.0012; // BTC 0.06%，ETH/SOL/XRP 0.12%
  return deviationPercent > threshold;
}

async function getCurrentPriceByCoin(coin: Coin): Promise<number | null> {
  switch (coin) {
    case "btc": return getCurrentBtcPrice();
    case "eth": return getCurrentEthPrice();
    case "sol": return getCurrentSolPrice();
    case "xrp": return getCurrentXrpPrice();
  }
}

async function getPriceAtTimestampForCoin(coin: Coin, unixSec: number): Promise<number | null> {
  let price: number | null = null;
  switch (coin) {
    case "btc": price = await getBtcPriceAtTimestamp(unixSec); break;
    case "eth": price = await getEthPriceAtTimestamp(unixSec); break;
    case "sol": price = await getSolPriceAtTimestamp(unixSec); break;
    case "xrp": price = await getXrpPriceAtTimestamp(unixSec); break;
  }
  // 兜底：K 线缺失（如 XRP 流动性断层）时用当前现货价，防止 Bot 因拿不到历史价而罢工
  return price ?? (await getCurrentPriceByCoin(coin));
}

const STOP_FILE = path.join(process.cwd(), ".polymarket-bot-stop");

export function isStopRequested(): boolean {
  try { return fs.existsSync(STOP_FILE); } catch { return false; }
}
export function requestStop(): void {
  try { fs.writeFileSync(STOP_FILE, String(Date.now()), "utf8"); } catch (e) { console.error("stop err:", e); }
}
function clearStopFile(): void {
  try { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); } catch { }
}

/**
 * 按币种计算动态缓冲区（基础价差 + 近期振幅 60%）
 */
function getDynamicBuffer(coin: Coin): number {
  const hist = getPriceHistory(coin);
  const base = COIN_CONFIG[coin].baseSafeGap;
  if (hist.length < 10) return base;
  const max = Math.max(...hist);
  const min = Math.min(...hist);
  return base + (max - min) * 0.6;
}

/**
 * 按币种的动态时间风险：剩余时间越短要求价差不同；SOL/XRP 增加硬性绝对值底线，防止一分钱绝杀
 */
function getRequiredGapByTime(secsLeft: number, vBuffer: number, coin: Coin): number {
  const base = COIN_CONFIG[coin].baseSafeGap;
  const scale = base / 15;

  // === 针对 XRP 的硬性补丁（价格基数低，用绝对值底线）===
  if (coin === "xrp") {
    if (secsLeft > 180) return 0.04;
    if (secsLeft > 60) return 0.025;
    return Math.max(0.018, vBuffer + 0.005);
  }

  // === 针对 SOL 的硬性补丁 ===
  if (coin === "sol") {
    if (secsLeft > 180) return 0.65;
    if (secsLeft > 60) return 0.35;
    return Math.max(0.35, vBuffer + 0.1);
  }

  // === BTC / ETH 保持原逻辑 ===
  const tier3m = 110 * scale;
  const tier2m = 80 * scale;
  const tier1m = 45 * scale;
  const minFloor = base * (25 / 15);

  if (secsLeft > 180) return tier3m;
  if (secsLeft > 120) return tier2m;
  if (secsLeft > 60) return tier1m;
  return Math.max(minFloor, vBuffer);
}

/**
 * 按币种趋势拦截：防止暴跌时买 UP、暴涨时买 DOWN
 */
function isMomentumDangerous(side: "up" | "down", coin: Coin): boolean {
  const hist = getPriceHistory(coin);
  const threshold = COIN_CONFIG[coin].momentumThreshold;
  if (hist.length < 10) return false;
  const recent = hist.slice(-8);
  const delta = recent[recent.length - 1] - recent[0];
  if (side === "up" && delta < -threshold) return true;
  if (side === "down" && delta > threshold) return true;
  return false;
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
  const FAST_POLL_MS = options.pollIntervalMs ?? 250;
  const IDLE_POLL_MS = FAST_POLL_MS;
  const marketRefreshMs = options.marketRefreshMs ?? 30000;

  // 98 策略要求「有盈利立刻卖出」：不做最小持仓时间限制
  const MIN_HOLD_BEFORE_SELL_MS = 0;
  const LOSS_COOLDOWN_MS = 90_000;         // 止损后冷却期

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

  initBinancePrice();

  console.log("=== 98概率买入 盈利及时卖出 (5min) ===");
  console.log(`启用盘: ${config.enabledCoins.join(", ").toUpperCase()} | 挂单价=${config.buy98OrderPrices.join(",")} | 每次 ${config.buy98OrderSizeShares} shares | 盈利即卖`);
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
  } catch { }
  console.log("---");

  let marketResult: Btc15mResult = { allMarkets: [], inWindow: [], upcoming: [], nextStartsInSec: -1 };

  // 98/99 策略：不做止损冷却，否则会大量错过入场窗口

  // 每轮结束时的盘口快照，用于按天日志 ROUND_END（slug -> 最后一笔 Up/Down 价格）
  const lastSnapshotBySlug = new Map<string, { upBid: number; upAsk: number; downBid: number; downAsk: number; endTime: string }>();
  // Price to beat 缓存（slug -> 该轮开始时 BTC 价格，美元），用于最后 10 秒价差过滤
  const priceToBeatBySlug = new Map<string, number>();
  const pendingByKey = new Map<
    string,
    { orderId: string; tokenId: string; side: "up" | "down"; size: number; price: number; slug: string; placedAt: number; marketEndMs: number }
  >();
  /** 入场原子锁：同一 slug 同时只允许一笔挂单指令，防止重复入场 */
  const entryLockBySlug = new Set<string>();

  const tracker = new PositionTracker({
    profitTarget: 0.01,
    stopLoss: 999,   // 不止损
    maxHoldMs: Number.MAX_SAFE_INTEGER, // 不时间止损，只靠止盈或市场到期
    maxPositionPerMarket: config.buy98OrderMaxPositionPerMarket,
    maxTradesPerWindow: 10,
  });

  async function refreshMarkets(): Promise<void> {
    try {
      // 必须显式传入启用盘，避免在只开 btc/eth 时仍拉取全部四盘造成带宽与内存压力
      const enabledPrefixes = config.enabledCoins.map((c) => `${c}-updown-5m`);
      const result = await getAll5MinMarketsFast(enabledPrefixes);
      marketResult = result;

      const activeSlugs = new Set(result.inWindow.map((m) => m.slug).filter(Boolean));
      for (const slug of lastSnapshotBySlug.keys()) if (!activeSlugs.has(slug)) lastSnapshotBySlug.delete(slug);
      for (const slug of priceToBeatBySlug.keys()) if (!activeSlugs.has(slug)) priceToBeatBySlug.delete(slug);

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

  let lastMarketRefresh = Date.now();
  let lastStatusLog = 0;
  const STATUS_LOG_MS = 30000;

  // === 卖出辅助：虚拟余额抢跑 + 以 Best Bid 减一 tick 挂卖确保抢跑（低币价品种不用固定 0.01 步长）===
  async function attemptSell(
    tokenId: string,
    sig: { tokenId: string; side: "SELL"; price: number; size: number; reason: string; type: string },
    ctx: MarketContext
  ): Promise<boolean> {
    const pos = tracker.getPosition(tokenId);
    if (!pos) return false;

    const virtualSize = pos.size;
    const tickSize = parseFloat(ctx.tickSize || "0.01");
    const currentBid = sig.price;
    let sellPrice = Math.max(0.01, currentBid - tickSize);
    console.log(`[EXIT-Fast] 触发虚拟止盈: ${sig.reason} | 预估数量: ${virtualSize} | 卖价: ${sellPrice} (bid - 1tick)`);

    let sold = false;

    for (let attempt = 0; attempt < 3 && !sold; attempt++) {
      try {
        const r = await executeSignal(
          client,
          { ...sig, size: virtualSize, price: sellPrice } as any,
          ctx.tickSize,
          ctx.negRisk
        );
        if (r.ok) {
          console.log(`[EXIT-Success] 卖单已挂出: ${r.orderIds} @${sellPrice} x${virtualSize}`);
          sold = true;
        } else {
          if (r.error?.includes("balance")) {
            await client!.syncTokenBalance(tokenId);
          }
          sellPrice = Math.max(0.01, sellPrice - tickSize);
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (e) {
        console.error("[EXIT] err:", e instanceof Error ? e.message : e);
        sellPrice = Math.max(0.01, sellPrice - tickSize);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return sold;
  }

  // === 主循环 ===
  const runOnce = async (): Promise<void> => {
    if (isStopRequested()) {
      console.log("Stop. Exiting.");
      process.exit(0);
    }

    if (Date.now() - lastMarketRefresh > marketRefreshMs) {
      await refreshMarkets();
      lastMarketRefresh = Date.now();
    }

    const nowMs = Date.now();
    const activeMarkets = marketResult.inWindow;

    // 状态日志（仅 Polymarket 盘口）
    if (nowMs - lastStatusLog >= STATUS_LOG_MS) {
      lastStatusLog = nowMs;
      const posStr = tracker.getSummary();
      if (activeMarkets.length > 0) {
        const info = activeMarkets.map((m) => {
          const endMs = m.endDate ? new Date(m.endDate).getTime() : 0;
          return `${m.slug?.slice(0, 28)}(${Math.round((endMs - nowMs) / 1000)}s)`;
        }).join(", ");
        console.log(`[Tick] ${info}${posStr ? " | " + posStr : ""}`);
      } else {
        console.log(`[Tick] idle${posStr ? " | " + posStr : ""}`);
      }
    }

    if (activeMarkets.length === 0) return;

    // --- 仅对启用的盘拉价并更新价格历史（用于动态价差与动量拦截）---
    const enabledSet = new Set(config.enabledCoins);
    const pricePromises: Promise<number | null>[] = [
      enabledSet.has("btc") ? getCurrentBtcPrice() : Promise.resolve(null),
      enabledSet.has("eth") ? getCurrentEthPrice() : Promise.resolve(null),
      enabledSet.has("sol") ? getCurrentSolPrice() : Promise.resolve(null),
      enabledSet.has("xrp") ? getCurrentXrpPrice() : Promise.resolve(null),
    ];
    const [currentBtc, currentEth, currentSol, currentXrp] = await Promise.all(pricePromises);
    if (currentBtc != null) {
      btcPriceHistory.push(currentBtc);
      if (btcPriceHistory.length > VOLATILITY_WINDOW_SIZE) btcPriceHistory.shift();
    }
    if (currentEth != null) {
      ethPriceHistory.push(currentEth);
      if (ethPriceHistory.length > VOLATILITY_WINDOW_SIZE) ethPriceHistory.shift();
    }
    if (currentSol != null) {
      solPriceHistory.push(currentSol);
      if (solPriceHistory.length > VOLATILITY_WINDOW_SIZE) solPriceHistory.shift();
    }
    if (currentXrp != null) {
      xrpPriceHistory.push(currentXrp);
      if (xrpPriceHistory.length > VOLATILITY_WINDOW_SIZE) xrpPriceHistory.shift();
    }

    // 双交易所静默：OKX 与 Binance 价差过大则本 tick 不新开单
    const binanceBtc = getBinanceBtcPrice();
    const dualExchangeSilent =
      currentBtc != null &&
      binanceBtc != null &&
      Math.abs(currentBtc - binanceBtc) > DUAL_EXCHANGE_DIVERGENCE_THRESHOLD;
    if (dualExchangeSilent && nowMs % 5000 < 300) {
      console.log(`[Risk-Dual] 两大所分歧 $${Math.abs(currentBtc! - binanceBtc!).toFixed(2)}，拦截交易`);
    }

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
    // 轮结束日志需要用到 priceToBeat，先保存再删
    const roundEndBtcPriceToBeat = new Map<string, number>();
    for (const [_, p] of pendingByKey.entries()) {
      if (!activeSlugs.has(p.slug)) {
        const pt = priceToBeatBySlug.get(p.slug);
        if (pt != null) roundEndBtcPriceToBeat.set(p.slug, pt);
      }
    }
    for (const k of priceToBeatBySlug.keys()) if (!activeSlugs.has(k)) priceToBeatBySlug.delete(k);

    const roundEndLogged = new Set<string>();
    for (const [k, p] of pendingByKey.entries()) {
      // 超时撤单
      // 如果挂单超过 10 秒没成交，或者离结束只剩 8 秒了，强制撤单保平安
      const currentSecsLeft = (p.marketEndMs - Date.now()) / 1000;
      if (currentSecsLeft < 8) {
        await client.cancelOrder(p.orderId);
        pendingByKey.delete(k);
        console.log(`[Safety] 距离结束太近，撤销未成交挂单: ${p.slug}`);
        continue;
      }
      if (!activeSlugs.has(p.slug)) {
        const roundTarget = roundEndBtcPriceToBeat.get(p.slug);
        const roundCoin = getCoinFromSlug(p.slug);
        const roundCur =
          roundCoin === "btc" ? currentBtc : roundCoin === "eth" ? currentEth : roundCoin === "sol" ? currentSol : currentXrp;
        const roundPriceStr =
          roundTarget != null && roundCur != null && roundCoin != null
            ? ` | ${roundCoin.toUpperCase()} 目标=${roundTarget.toFixed(2)} 当前=${roundCur.toFixed(2)}`
            : "";
        if (!roundEndLogged.has(p.slug)) {
          const snap = lastSnapshotBySlug.get(p.slug);
          if (snap) {
            logRoundEnd({
              slug: p.slug,
              endTime: new Date().toISOString(),
              upBid: snap.upBid,
              upAsk: snap.upAsk,
              downBid: snap.downBid,
              downAsk: snap.downAsk,
              coin: getCoinFromSlug(p.slug) ?? undefined,
              priceToBeat: roundTarget ?? undefined,
              priceNow: roundCur ?? undefined,
            });
            lastSnapshotBySlug.delete(p.slug);
          }
          roundEndLogged.add(p.slug);
        }
        await client.cancelOrder(p.orderId);
        pendingByKey.delete(k);
        console.log(`[98C] 轮结束，取消挂单 ${p.side.toUpperCase()} @${p.price} ${p.slug.slice(0, 20)}…${roundPriceStr}`);
      }
    }

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
      const coin = getCoinFromSlug(slug);
      const currentPrice =
        coin != null
          ? (coin === "btc" ? currentBtc : coin === "eth" ? currentEth : coin === "sol" ? currentSol : currentXrp)
          : null;
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

        // 强制止盈：98c 买入后盘口插针到 0.995 时立刻卖出，不承担反杀风险
        const isSuperProfit = sig.price >= 0.995;
        if (isSuperProfit) sig.reason = "[Profit-Protect] 触及 0.995 高位，强制落袋";

        const priceTarget = priceToBeatBySlug.get(slug);
        const priceStr =
          priceTarget != null && currentPrice != null && coin != null
            ? ` | ${coin.toUpperCase()} 目标=${priceTarget.toFixed(2)} 当前=${currentPrice.toFixed(2)}`
            : "";
        console.log(`[EXIT] ${sig.reason}${priceStr}`);

        if (pos) {
          const shortReason = sig.reason.includes("止盈") ? "止盈" : sig.reason.includes("止损") ? "止损" : "EXIT";
          logTrade({
            slug: pos.marketSlug,
            side: pos.side,
            action: "SELL",
            price: sig.price,
            size: sig.size,
            reason: shortReason,
            coin: coin ?? undefined,
            priceToBeat: priceTarget ?? undefined,
            priceNow: currentPrice ?? undefined,
          });
          if (shortReason === "止盈" || shortReason === "止损") {
            const pnlUsd = (sig.price - pos.avgPrice) * sig.size;
            notifyPnL({
              botToken: config.tgBotToken,
              chatId: config.tgChatId,
              slug: pos.marketSlug,
              side: pos.side,
              reason: shortReason,
              pnlUsd,
              buyPrice: pos.avgPrice,
              sellPrice: sig.price,
              size: sig.size,
              coin: coin ?? undefined,
            });
          }
        }

        // 使用增强版卖出函数（检查余额 + sync + 重试）
        const sold = await attemptSell(sig.tokenId, sig, ctx);
        const sizeToClear = pos?.size ?? sig.size;
        if (sold) {
          tracker.recordSell(sig.tokenId, sizeToClear);
        } else {
          console.error("[EXIT] 3次卖出均失败，强制清仓标记");
          tracker.recordSell(sig.tokenId, sizeToClear);
        }
      }

      // ========== 第二优先：如果有持仓，不开新单 ==========
      if (tracker.hasOpenPosition()) continue;

      const endMs = market.endDate ? new Date(market.endDate).getTime() : 0;
      const secsLeft = (endMs - nowMs) / 1000;

      const upBid = ctx.yesBook?.bids?.[0] ? parseFloat(ctx.yesBook.bids[0].price) : 0;
      const downBid = ctx.noBook?.bids?.[0] ? parseFloat(ctx.noBook.bids[0].price) : 0;
      const upAsk = ctx.yesBook?.asks?.[0] ? parseFloat(ctx.yesBook.asks[0].price) : 1;
      const downAsk = ctx.noBook?.asks?.[0] ? parseFloat(ctx.noBook.asks[0].price) : 1;
      lastSnapshotBySlug.set(slug, { upBid, upAsk, downBid, downAsk, endTime: market.endDate || "" });

      // 最后 15 秒不挂单
      if (secsLeft <= 15) continue;

      // 只做 98/99 两档，97 不买
      const orderPrices = config.buy98OrderPrices.filter((p) => p >= 0.98);

      // 按币种：时间加权价差门槛 + Price to Beat
      if (coin == null) continue;
      const vBuffer = getDynamicBuffer(coin);
      const requiredGap = getRequiredGapByTime(secsLeft, vBuffer, coin);
      const slotStartMatch = slug.match(/(?:btc|eth|sol)-updown-5m-(\d+)/);
      const slotStart = slotStartMatch ? parseInt(slotStartMatch[1], 10) : 0;
      let priceToBeat = slotStart ? priceToBeatBySlug.get(slug) : undefined;
      if (slotStart && priceToBeat == null) {
        const p = await getPriceAtTimestampForCoin(coin, slotStart);
        if (p != null) {
          priceToBeatBySlug.set(slug, p);
          priceToBeat = p;
        }
      }
      // 价差门槛：BTC 且有两所价格时在 UP/DOWN 分支里用保守价判断，此处不拦
      const btcDualSource = coin === "btc" && getBinanceBtcPrice() != null;
      if (!btcDualSource && priceToBeat != null && currentPrice != null) {
        const actualGap = Math.abs(currentPrice - priceToBeat);
        if (actualGap < requiredGap) {
          if (nowMs % 4000 < 300) {
            console.log(`[Time-Guard] ${coin.toUpperCase()} 拦截: 剩余${Math.round(secsLeft)}s 要求价差>${requiredGap.toFixed(2)}u, 当前${actualGap.toFixed(2)}u`);
          }
          continue;
        }
      }

      // 订单簿深度过滤（防巨单诱多）：按币种设限，SOL/ETH 盘口通常更薄
      const isTooDeep = (askSizeDollars: number) => askSizeDollars > COIN_CONFIG[coin].maxAskDepthUsd;
      const upAskSize =
        ctx.yesBook?.asks?.[0]
          ? parseFloat(ctx.yesBook.asks[0].size) * parseFloat(ctx.yesBook.asks[0].price)
          : 0;
      const downAskSize =
        ctx.noBook?.asks?.[0]
          ? parseFloat(ctx.noBook.asks[0].size) * parseFloat(ctx.noBook.asks[0].price)
          : 0;
      const orderShares = Math.max(5, Math.floor(config.buy98OrderSizeShares));
      const tickSize = parseFloat(ctx.tickSize || "0.01");
      const roundToTick = (n: number) => Number((Math.floor(n / tickSize) * tickSize).toFixed(4));
      const roundSize = (s: number) => Math.max(0.01, roundToTick(s));

      // 用“价格带”触发，避免浮点或四舍五入漏掉 98/99（两把都没触发多半是这里太严）
      const inBand = (p: number, low: number, high: number) => Number.isFinite(p) && p >= low && p <= high;
      const pickPrice = (ask: number, bid: number): number | null => {
        for (const pr of orderPrices) {
          if (pr >= 0.99) {
            if (inBand(ask, 0.985, 0.9999) || inBand(bid, 0.985, 0.9999)) return pr;
          } else {
            if (inBand(ask, 0.978, 0.984) || inBand(bid, 0.978, 0.984)) return pr;
          }
        }
        return null;
      };

      // 1) 已有该市场的 98C 挂单：检查是否成交，未成交且到点则撤单
      // 1) 处理该市场所有未成交挂单：若任一档位成交到可卖(>=5)，记仓位并撤掉其它挂单
      for (const [k, p] of pendingByKey.entries()) {
        if (p.slug !== slug) continue;
        const order = await client.getOrder(p.orderId);
        const matched = order?.size_matched ?? 0;
        const fullyFilled = matched >= p.size * 0.99;
        const partiallyTradable = matched >= 5;
        if (!partiallyTradable) continue;

        const buySize = fullyFilled ? p.size : Math.floor(matched);
        // 撤掉当前单剩余未成交（以及同轮其它档位挂单），避免重复买
        await client.cancelOrder(p.orderId);
        for (const [k2, p2] of pendingByKey.entries()) {
          if (p2.slug === slug) {
            if (k2 !== k) await client.cancelOrder(p2.orderId);
            pendingByKey.delete(k2);
          }
        }

        tracker.recordBuy(p.tokenId, p.side, p.price, buySize, slug);
        const buyPriceStr =
          priceToBeat != null && currentPrice != null
            ? ` | ${coin.toUpperCase()} 目标=${priceToBeat.toFixed(2)} 当前=${currentPrice.toFixed(2)}`
            : "";
        logTrade({
          slug,
          side: p.side,
          action: "BUY",
          price: p.price,
          size: buySize,
          coin: coin ?? undefined,
          priceToBeat: priceToBeat ?? undefined,
          priceNow: currentPrice ?? undefined,
        });
        console.log(`[98C] ${p.side.toUpperCase()} 成交 ${fullyFilled ? "✓" : "(部分)"} @${p.price} x${buySize}${buyPriceStr}`);
        for (let si = 0; si < 3; si++) {
          const ok = await client.syncTokenBalance(p.tokenId);
          if (ok) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        // 已有仓位，本轮不再继续下单
        break;
      }

      if (tracker.hasOpenPosition()) continue;

      // 每次只做一单：该市场已有任意挂单则不再挂
      const hasPendingForSlug = Array.from(pendingByKey.keys()).some((k) => k.startsWith(`${slug}:`));
      if (hasPendingForSlug) continue;

      if (dualExchangeSilent) continue;

      const size = orderShares;
      const upPr = pickPrice(upAsk, upBid);
      const downPr = pickPrice(downAsk, downBid);

      // 每轮有盘口在 0.96+ 就打一行，方便看为什么没触发
      if (upAsk >= 0.96 || upBid >= 0.96 || downAsk >= 0.96 || downBid >= 0.96) {
        const u = upPr != null ? `Up→挂@${upPr}` : `Up 卖一=${upAsk.toFixed(2)} 买一=${upBid.toFixed(2)}`;
        const d = downPr != null ? `Down→挂@${downPr}` : `Down 卖一=${downAsk.toFixed(2)} 买一=${downBid.toFixed(2)}`;
        console.log(`[98C] ${u} | ${d}`);
      }

      // 98c 或 99c：满足价格带即挂单（含趋势拦截 + 深度过滤 + 入场原子锁）
      if (upPr != null) {
        if (entryLockBySlug.has(slug)) continue;
        if (coin === "btc" && currentBtc != null && getBinanceBtcPrice() != null) {
          const conservativeUp = Math.min(currentBtc, getBinanceBtcPrice()!);
          const actualGapUp = priceToBeat != null ? Math.abs(conservativeUp - priceToBeat) : 0;
          if (priceToBeat != null && actualGapUp < requiredGap) continue;
          if (isPriceOverextended(conservativeUp, getPriceHistory(coin), coin)) {
            if (nowMs % 5000 < 300) console.log("[Anti-V] 侦测到脉冲过载，防止 V 字反杀，拦截 UP 下单");
            continue;
          }
        }
        if (isMomentumDangerous("up", coin) || isTooDeep(upAskSize)) {
          console.log(`[Risk] ${coin.toUpperCase()} 趋势下杀或深度过大，取消 UP 挂单`);
          continue;
        }
        const cost = upPr * size;
        const key = `${slug}:up:${upPr}`;
        if (pendingByKey.has(key)) continue;
        if (cost < 1) continue;
        if (!tracker.canBuy(slug, cost)) {
          if (nowMs - lastStatusLog < 1000) console.log(`[98C] Up@${upPr} 跳过: canBuy=false (额度/笔数限制)`);
          continue;
        }
        entryLockBySlug.add(slug);
        try {
          const signal = { type: "latency" as const, direction: "up" as const, tokenId: ctx.yesTokenId, price: upPr, size, reason: `98/99C Up 挂单` };
          const r = await executeSignal(client, signal, ctx.tickSize, ctx.negRisk);
          if (r.ok && r.orderIds[0]) {
            pendingByKey.set(key, { orderId: r.orderIds[0], tokenId: ctx.yesTokenId, side: "up", size, price: upPr, slug, placedAt: nowMs, marketEndMs: endMs });
            console.log(`[98C] Up 挂单成功 @${upPr} x${size} orderId=${r.orderIds[0].slice(0, 10)}…`);
            entryLockBySlug.delete(slug);
          } else {
            console.error("[98C] Up 挂单失败:", r.error || "无 orderId");
            entryLockBySlug.delete(slug);
          }
        } catch (e) {
          entryLockBySlug.delete(slug);
          console.error("[98C] Up 挂单异常:", e instanceof Error ? e.message : e);
        }
        continue;
      }
      if (downPr != null) {
        if (entryLockBySlug.has(slug)) continue;
        if (coin === "btc" && currentBtc != null && getBinanceBtcPrice() != null) {
          const conservativeDown = Math.max(currentBtc, getBinanceBtcPrice()!);
          const actualGapDown = priceToBeat != null ? Math.abs(conservativeDown - priceToBeat) : 0;
          if (priceToBeat != null && actualGapDown < requiredGap) continue;
          if (isPriceOverextended(conservativeDown, getPriceHistory(coin), coin)) {
            if (nowMs % 5000 < 300) console.log("[Anti-V] 侦测到脉冲过载，防止 V 字反杀，拦截 DOWN 下单");
            continue;
          }
        }
        if (isMomentumDangerous("down", coin) || isTooDeep(downAskSize)) {
          console.log(`[Risk] ${coin.toUpperCase()} 趋势上涨或深度过大，取消 DOWN 挂单`);
          continue;
        }
        const cost = downPr * size;
        const key = `${slug}:down:${downPr}`;
        if (pendingByKey.has(key)) continue;
        if (cost < 1) continue;
        if (!tracker.canBuy(slug, cost)) {
          if (nowMs - lastStatusLog < 1000) console.log(`[98C] Down@${downPr} 跳过: canBuy=false (额度/笔数限制)`);
          continue;
        }
        entryLockBySlug.add(slug);
        try {
          const signal = { type: "latency" as const, direction: "down" as const, tokenId: ctx.noTokenId, price: downPr, size, reason: `98/99C Down 挂单` };
          const r = await executeSignal(client, signal, ctx.tickSize, ctx.negRisk);
          if (r.ok && r.orderIds[0]) {
            pendingByKey.set(key, { orderId: r.orderIds[0], tokenId: ctx.noTokenId, side: "down", size, price: downPr, slug, placedAt: nowMs, marketEndMs: endMs });
            console.log(`[98C] Down 挂单成功 @${downPr} x${size} orderId=${r.orderIds[0].slice(0, 10)}…`);
            entryLockBySlug.delete(slug);
          } else {
            console.error("[98C] Down 挂单失败:", r.error || "无 orderId");
            entryLockBySlug.delete(slug);
          }
        } catch (e) {
          entryLockBySlug.delete(slug);
          console.error("[98C] Down 挂单异常:", e instanceof Error ? e.message : e);
        }
        continue;
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
    const pollMs = tracker.hasOpenPosition()
      ? FAST_POLL_MS
      : marketResult.inWindow.length > 0
        ? FAST_POLL_MS
        : IDLE_POLL_MS;
    setTimeout(smartPoll, pollMs);
  };

  smartPoll();

  process.on("SIGINT", () => { requestStop(); process.exit(0); });
  process.on("SIGTERM", () => { requestStop(); process.exit(0); });
}
