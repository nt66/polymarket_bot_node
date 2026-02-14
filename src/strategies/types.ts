/**
 * 策略通用类型与市场上下文
 */

import type { GammaMarket } from "../api/gamma.js";
import type { OrderBookSummary } from "../api/clob.js";

export interface MarketContext {
  market: GammaMarket;
  yesTokenId: string;
  noTokenId: string;
  yesBook: OrderBookSummary | null;
  noBook: OrderBookSummary | null;
  tickSize: string;
  negRisk: boolean;
}

export interface LatencyArbSignal {
  type: "latency";
  direction: "up" | "down";
  tokenId: string;
  price: number;
  size: number;
  reason: string;
}

export interface NegRiskArbSignal {
  type: "neg_risk";
  yesTokenId: string;
  noTokenId: string;
  askYes: number;
  askNo: number;
  sum: number;
  size: number;
}

export interface EvArbSignal {
  type: "ev_arb";
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  theoreticalProb: number;
  marketPrice: number;
  secondsLeft: number;
}

export interface StopLossSignal {
  type: "stop_loss";
  tokenId: string;
  side: "SELL";
  price: number;
  size: number;
  reason: string;
}

export type ArbSignal = LatencyArbSignal | NegRiskArbSignal | EvArbSignal | StopLossSignal;
