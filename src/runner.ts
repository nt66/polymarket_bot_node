/**
 * 98 概率买入、盈利及时卖出（仅 BTC 5min）
 * 挂单价从 .env 的 BUY98_ORDER_PRICE 读取。
 */

import * as fs from "fs";
import * as path from "path";
import { getBtc5MinMarketsFast } from "./api/gamma.js";
import { getOrderBooks, createPolymarketClient } from "./api/clob.js";
import type { GammaMarket, Btc15mResult } from "./api/gamma.js";
import type { MarketContext } from "./strategies/types.js";
import { executeSignal } from "./execution/executor.js";
import { loadConfig } from "./config/index.js";
import { PositionTracker } from "./risk/position-tracker.js";
import { logTrade, logRoundEnd } from "./util/daily-log.js";

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
  // 盘口在 5min 末期可能“闪现”0.98，轮询过慢会错过
  const FAST_POLL_MS = options.pollIntervalMs ?? 250;
  // 即使“当前无 inWindow 市场”，也要高频刷新以免错过开盘瞬间
  const IDLE_POLL_MS = FAST_POLL_MS;
  const marketRefreshMs = options.marketRefreshMs ?? 30000;

  // 98 策略要求「有盈利立刻卖出」：不做最小持仓时间限制
  // 代币未结算的情况由 attemptSell 内部的余额检查 + sync + 等待兜底
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

  console.log("=== 98概率买入 盈利及时卖出 (仅 BTC 5min) ===");
  console.log(`挂单价=${config.buy98OrderPrices.join(",")} | 每次 ${config.buy98OrderSizeShares} shares | 盈利即卖`);
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

  // === 未成交挂单：本轮挂着，下一轮 5min 再取消（支持同轮 0.98 + 0.99 两档同时挂）===
  // key: `${slug}:${side}:${price}`
  const pendingByKey = new Map<
    string,
    { orderId: string; tokenId: string; side: "up" | "down"; size: number; price: number; slug: string; placedAt: number; marketEndMs: number }
  >();

  // 98 策略：只止盈卖出，不设价格/时间止损（跌了或拿久了都不主动卖，只等止盈或到期结算）
  const tracker = new PositionTracker({
    profitTarget: 0.01,
    stopLoss: 999,   // 不止损
    maxHoldMs: Number.MAX_SAFE_INTEGER, // 不时间止损，只靠止盈或市场到期
    maxPositionPerMarket: config.buy98OrderMaxPositionPerMarket,
    maxTradesPerWindow: 10,
  });

  async function refreshMarkets(): Promise<void> {
    try {
      const result = await getBtc5MinMarketsFast();
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
    // 注意：CLOB 返回的 balance 通常是 1e6 精度（例如 19998000 = 19.998 shares）
    const availableShares = Math.max(0, tokenBal / 1_000_000);
    const requested = sig.size;
    const capped = Math.min(requested, availableShares);
    const cappedRounded = Math.floor(capped * 100) / 100; // 向下取 0.01，避免“余额略小于 20”导致卖出失败
    const finalSize = Math.max(0.01, cappedRounded);

    console.log(
      `[EXIT] 代币余额=${tokenBal} (~${availableShares.toFixed(3)} shares)，尝试卖出 size=${requested} -> ${finalSize}`
    );

    // Step 2: sync token allowance
    await client!.syncTokenBalance(tokenId);
    await new Promise((r) => setTimeout(r, 1500));

    // Step 3: 卖出，最多重试 3 次
    let sold = false;
    let sellPrice = sig.price;
    const sellSigBase = { ...sig, size: finalSize };

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

    const roundEndLogged = new Set<string>();
    for (const [k, p] of pendingByKey.entries()) {
      if (!activeSlugs.has(p.slug)) {
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
            });
            lastSnapshotBySlug.delete(p.slug);
          }
          roundEndLogged.add(p.slug);
        }
        await client.cancelOrder(p.orderId);
        pendingByKey.delete(k);
        console.log(`[98C] 轮结束，取消挂单 ${p.side.toUpperCase()} @${p.price} ${p.slug.slice(0, 20)}…`);
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

        if (pos) {
          const shortReason = sig.reason.includes("止盈") ? "止盈" : sig.reason.includes("止损") ? "止损" : "EXIT";
          logTrade({ slug: pos.marketSlug, side: pos.side, action: "SELL", price: sig.price, size: sig.size, reason: shortReason });
        }

        // 使用增强版卖出函数（检查余额 + sync + 重试）
        const sold = await attemptSell(sig.tokenId, sig, ctx);
        if (sold) {
          tracker.recordSell(sig.tokenId, sig.size);
        } else {
          console.error("[EXIT] 3次卖出均失败，强制清仓标记");
          tracker.recordSell(sig.tokenId, sig.size);
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

      // 价格差过滤：若市价与目标价相差不足 15 美元（按本次下单张数算），不下单保平安
      const ORDER_SIZE_FOR_RISK = Math.max(15, Math.floor(config.buy98OrderSizeShares));
      const DOLLAR_DIFF_RISK = 15;
      const nearTarget = (ask: number) => orderPrices.some((tp) => Number.isFinite(ask) && Math.abs(ask - tp) * ORDER_SIZE_FOR_RISK < DOLLAR_DIFF_RISK);
      if (nearTarget(upAsk) || nearTarget(downAsk)) {
        console.log("[98C] 继续等待、本拍不下单（剩余 " + Math.round(secsLeft) + "s，价差不足 15 美元）");
        continue;
      }
      // 只做 98/99 两档，97 不买
      const orderPrices = config.buy98OrderPrices.filter((p) => p >= 0.98);
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
        logTrade({ slug, side: p.side, action: "BUY", price: p.price, size: buySize });
        console.log(`[98C] ${p.side.toUpperCase()} 成交 ${fullyFilled ? "✓" : "(部分)"} @${p.price} x${buySize}`);
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

      const size = orderShares;
      const upPr = pickPrice(upAsk, upBid);
      const downPr = pickPrice(downAsk, downBid);

      // 每轮有盘口在 0.96+ 就打一行，方便看为什么没触发
      if (upAsk >= 0.96 || upBid >= 0.96 || downAsk >= 0.96 || downBid >= 0.96) {
        const u = upPr != null ? `Up→挂@${upPr}` : `Up 卖一=${upAsk.toFixed(2)} 买一=${upBid.toFixed(2)}`;
        const d = downPr != null ? `Down→挂@${downPr}` : `Down 卖一=${downAsk.toFixed(2)} 买一=${downBid.toFixed(2)}`;
        console.log(`[98C] ${u} | ${d}`);
      }

      // 98c 或 99c：满足价格带即挂单
      if (upPr != null) {
        const cost = upPr * size;
        const key = `${slug}:up:${upPr}`;
        if (pendingByKey.has(key)) continue;
        if (cost < 1) continue;
        if (!tracker.canBuy(slug, cost)) {
          if (nowMs - lastStatusLog < 1000) console.log(`[98C] Up@${upPr} 跳过: canBuy=false (额度/笔数限制)`);
          continue;
        }
        const signal = { type: "latency" as const, direction: "up" as const, tokenId: ctx.yesTokenId, price: upPr, size, reason: `98/99C Up 挂单` };
        const r = await executeSignal(client, signal, ctx.tickSize, ctx.negRisk);
        if (r.ok && r.orderIds[0]) {
          pendingByKey.set(key, { orderId: r.orderIds[0], tokenId: ctx.yesTokenId, side: "up", size, price: upPr, slug, placedAt: nowMs, marketEndMs: endMs });
          console.log(`[98C] Up 挂单成功 @${upPr} x${size} orderId=${r.orderIds[0].slice(0, 10)}…`);
        } else {
          console.error("[98C] Up 挂单失败:", r.error || "无 orderId");
        }
        continue;
      }
      if (downPr != null) {
        const cost = downPr * size;
        const key = `${slug}:down:${downPr}`;
        if (pendingByKey.has(key)) continue;
        if (cost < 1) continue;
        if (!tracker.canBuy(slug, cost)) {
          if (nowMs - lastStatusLog < 1000) console.log(`[98C] Down@${downPr} 跳过: canBuy=false (额度/笔数限制)`);
          continue;
        }
        const signal = { type: "latency" as const, direction: "down" as const, tokenId: ctx.noTokenId, price: downPr, size, reason: `98/99C Down 挂单` };
        const r = await executeSignal(client, signal, ctx.tickSize, ctx.negRisk);
        if (r.ok && r.orderIds[0]) {
          pendingByKey.set(key, { orderId: r.orderIds[0], tokenId: ctx.noTokenId, side: "down", size, price: downPr, slug, placedAt: nowMs, marketEndMs: endMs });
          console.log(`[98C] Down 挂单成功 @${downPr} x${size} orderId=${r.orderIds[0].slice(0, 10)}…`);
        } else {
          console.error("[98C] Down 挂单失败:", r.error || "无 orderId");
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
