/**
 * 策略2：负风险组合套利 (Negative Risk Arb)
 * YES 卖一 + NO 卖一 < 1 - 手续费 时同时买入两边
 */

import type { MarketContext } from "./types.js";
import type { NegRiskArbSignal } from "./types.js";

export interface NegRiskArbConfig {
  maxSum: number; // 例如 0.98，即 YES_ask + NO_ask <= 0.98 才做
  feeBps?: number;
  orderSizeMin: number;
  orderSizeMax: number;
}

const DEFAULT_FEE_BPS = 0;

export function checkNegRiskArb(
  ctx: MarketContext,
  config: NegRiskArbConfig
): NegRiskArbSignal | null {
  if (!ctx.yesBook?.asks?.[0] || !ctx.noBook?.asks?.[0]) return null;

  const askYes = parseFloat(ctx.yesBook.asks[0].price);
  const askNo = parseFloat(ctx.noBook.asks[0].price);
  const sizeYes = parseFloat(ctx.yesBook.asks[0].size);
  const sizeNo = parseFloat(ctx.noBook.asks[0].size);

  if (!Number.isFinite(askYes) || !Number.isFinite(askNo)) return null;

  const sum = askYes + askNo;
  const feeBps = config.feeBps ?? DEFAULT_FEE_BPS;
  const feeFactor = 1 - feeBps / 10000;
  if (sum >= config.maxSum * feeFactor) return null;

  let size = Math.min(sizeYes, sizeNo, config.orderSizeMax);
  if (size < config.orderSizeMin) return null;

  return {
    type: "neg_risk",
    yesTokenId: ctx.yesTokenId,
    noTokenId: ctx.noTokenId,
    askYes,
    askNo,
    sum,
    size,
  };
}
