/**
 * 策略1：跨平台信息差套利 (Latency Arbitrage)
 * 监控 OKX BTC 价格跳动，当超过阈值时在 Polymarket 吃单（买 Up 或买 Down）
 */

import type { MarketContext } from "./types.js";
import type { LatencyArbSignal } from "./types.js";

export interface LatencyArbConfig {
  priceJumpThresholdUsd: number;
  orderSizeMin: number;
  orderSizeMax: number;
}

/**
 * 给定 OKX 价格变动（当前价、上一价）与市场上下文，判断是否产生延迟套利信号
 * 简化：用 Polymarket 的 Up 对应 BTC 涨、Down 对应 BTC 跌；OKX 涨则买 Up（YES），跌则买 Down（NO 或对侧市场）
 */
export function checkLatencyArb(
  prevBtcPrice: number,
  currentBtcPrice: number,
  ctx: MarketContext,
  config: LatencyArbConfig
): LatencyArbSignal | null {
  const jump = currentBtcPrice - prevBtcPrice;
  const absJump = Math.abs(jump);
  if (absJump < config.priceJumpThresholdUsd) return null;

  const tickSize = parseFloat(ctx.tickSize || "0.01");
  const direction = jump > 0 ? "up" : "down";

  if (direction === "up") {
    // BTC 暴涨 → 买 YES (Up)
    const bestAsk = ctx.yesBook?.asks?.[0];
    if (!bestAsk) return null;
    const price = parseFloat(bestAsk.price);
    let size = parseFloat(bestAsk.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) return null;
    size = Math.min(size, config.orderSizeMax);
    if (size < config.orderSizeMin) return null;
    return {
      type: "latency",
      direction: "up",
      tokenId: ctx.yesTokenId,
      price: roundToTick(price, tickSize),
      size,
      reason: `OKX BTC +$${jump.toFixed(2)} -> buy Up YES @ ${price} x${size}`,
    };
  } else {
    // BTC 暴跌 → 买 NO (Down 等价于买当前市场的 NO)
    const bestAsk = ctx.noBook?.asks?.[0];
    if (!bestAsk) return null;
    const price = parseFloat(bestAsk.price);
    let size = parseFloat(bestAsk.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) return null;
    size = Math.min(size, config.orderSizeMax);
    if (size < config.orderSizeMin) return null;
    return {
      type: "latency",
      direction: "down",
      tokenId: ctx.noTokenId,
      price: roundToTick(price, tickSize),
      size,
      reason: `OKX BTC $${jump.toFixed(2)} -> buy Down NO @ ${price} x${size}`,
    };
  }
}

function roundToTick(price: number, tickSize: number): number {
  const n = Math.round(price / tickSize) * tickSize;
  return Math.round(n * 1e6) / 1e6;
}
