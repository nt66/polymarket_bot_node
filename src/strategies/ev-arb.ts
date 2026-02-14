/**
 * 策略3：末日轮概率博弈 (Expected Value Arb)
 * v3: 最后45秒高置信度入场 + 对冲计算 + 止盈挂单
 *
 * 核心改进：
 * 1. 缩短到最后 45 秒，减少反转风险
 * 2. 对冲模式：如果买一边后，另一边的 ask 加上已买的价格 < $1，则同时买另一边锁定利润
 * 3. 止盈模式：买入后立即挂 +0.05 的卖单，做快速 scalp
 */

import type { MarketContext } from "./types.js";
import type { EvArbSignal } from "./types.js";

export interface EvArbConfig {
  lastSeconds: number;
  minEdge: number;
  orderSizeMin: number;
  orderSizeMax: number;
  minDiffUsd: number;
}

export interface EvArbResult {
  signal: EvArbSignal;
  /** 是否存在对冲机会（买对面也能锁定利润） */
  hedge: {
    available: boolean;
    oppositeTokenId: string;
    oppositePrice: number;
    oppositeSize: number;
    totalCost: number;       // 两边总成本
    guaranteedPayout: number; // $1 * min(两边数量)
    netProfit: number;       // 扣除成本后的保底利润
  } | null;
  /** 止盈卖出的建议价格 */
  profitTargetPrice: number;
}

export function checkEvArb(
  ctx: MarketContext,
  config: EvArbConfig,
  nowMs: number,
  btcPriceNow: number,
  btcStartPrice: number
): EvArbResult | null {
  const endDate = ctx.market.endDate;
  const endMs = typeof endDate === "string" ? new Date(endDate).getTime() : endDate;
  const secondsLeft = (endMs - nowMs) / 1000;
  if (secondsLeft > config.lastSeconds || secondsLeft <= 5) return null;

  const diff = btcPriceNow - btcStartPrice;
  const absDiff = Math.abs(diff);
  if (absDiff < config.minDiffUsd) return null;

  // 波动率模型
  const dailyVol = 0.02;
  const sigmaRemaining = dailyVol * btcPriceNow * Math.sqrt(secondsLeft / 86400);
  const zScore = absDiff / sigmaRemaining;
  const theoreticalProb = normCDF(zScore);
  const probClamped = Math.min(0.95, Math.max(0.05, theoreticalProb));

  const isUpFavored = diff > 0;

  // 我方订单簿
  const myBook = isUpFavored ? ctx.yesBook : ctx.noBook;
  const myTokenId = isUpFavored ? ctx.yesTokenId : ctx.noTokenId;
  const bestAsk = myBook?.asks?.[0];
  if (!bestAsk) return null;

  const marketPrice = parseFloat(bestAsk.price);
  let size = Math.min(parseFloat(bestAsk.size), config.orderSizeMax);
  if (!Number.isFinite(marketPrice) || size < config.orderSizeMin) return null;

  // 不买太贵的票（>0.90 利润空间太少）
  if (marketPrice > 0.90) return null;

  const edge = probClamped - marketPrice;
  if (edge < config.minEdge) return null;

  const tickSize = parseFloat(ctx.tickSize || "0.01");
  const price = roundToTick(marketPrice, tickSize);

  const signal: EvArbSignal = {
    type: "ev_arb",
    tokenId: myTokenId,
    side: "BUY",
    price,
    size,
    theoreticalProb: probClamped,
    marketPrice,
    secondsLeft,
  };

  // === 对冲计算 ===
  // 检查对面的 ask 价格，如果 myPrice + oppositePrice < $1，则两边都买，锁定利润
  const oppBook = isUpFavored ? ctx.noBook : ctx.yesBook;
  const oppTokenId = isUpFavored ? ctx.noTokenId : ctx.yesTokenId;
  const oppBestAsk = oppBook?.asks?.[0];

  let hedge: EvArbResult["hedge"] = null;
  if (oppBestAsk) {
    const oppPrice = parseFloat(oppBestAsk.price);
    const oppSize = parseFloat(oppBestAsk.size);
    if (Number.isFinite(oppPrice) && oppSize > 0) {
      const pairSize = Math.min(size, oppSize);
      const totalCost = price * pairSize + oppPrice * pairSize;
      const guaranteedPayout = pairSize * 1.0; // 一边必赢，赢家 $1/share
      const netProfit = guaranteedPayout - totalCost;

      hedge = {
        available: netProfit > 0,
        oppositeTokenId: oppTokenId,
        oppositePrice: roundToTick(oppPrice, tickSize),
        oppositeSize: pairSize,
        totalCost,
        guaranteedPayout,
        netProfit,
      };
    }
  }

  // 止盈目标：买入价 + 0.05
  const profitTargetPrice = roundToTick(Math.min(price + 0.05, 0.99), tickSize);

  return { signal, hedge, profitTargetPrice };
}

function normCDF(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1.0 + sign * y);
}

function roundToTick(price: number, tickSize: number): number {
  const n = Math.round(price / tickSize) * tickSize;
  return Math.round(n * 1e6) / 1e6;
}
