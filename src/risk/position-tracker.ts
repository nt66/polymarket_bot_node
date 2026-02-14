/**
 * Scalp 模式持仓管理器
 *
 * 核心原则：快进快出
 * 1. 买入后立即开始监控 → 涨 $0.03 就卖（止盈）
 * 2. 跌 $0.05 就砍（止损）
 * 3. 持有超过 60 秒无论盈亏都卖（时间止损）
 * 4. 每个市场同时只持有 1 个方向
 */

export interface Position {
  tokenId: string;
  side: "up" | "down";
  avgPrice: number;
  size: number;
  costBasis: number;
  marketSlug: string;
  entryTime: number; // ms timestamp
}

export interface SellSignal {
  type: "stop_loss";
  tokenId: string;
  side: "SELL";
  price: number;
  size: number;
  reason: string;
}

export interface ScalpConfig {
  profitTarget: number;      // 止盈：+$0.03/share
  stopLoss: number;          // 止损：-$0.05/share
  maxHoldMs: number;         // 最长持有时间 60s
  maxPositionPerMarket: number;
  maxTradesPerWindow: number;
}

export class PositionTracker {
  private positions: Map<string, Position> = new Map();
  private marketSpend: Map<string, number> = new Map();
  private windowTradeCount: Map<string, number> = new Map();

  constructor(private config: ScalpConfig) {}

  recordBuy(
    tokenId: string,
    side: "up" | "down",
    price: number,
    size: number,
    marketSlug: string
  ): void {
    const cost = price * size;
    const existing = this.positions.get(tokenId);

    if (existing) {
      const totalSize = existing.size + size;
      const totalCost = existing.costBasis + cost;
      existing.avgPrice = totalCost / totalSize;
      existing.size = totalSize;
      existing.costBasis = totalCost;
    } else {
      this.positions.set(tokenId, {
        tokenId,
        side,
        avgPrice: price,
        size,
        costBasis: cost,
        marketSlug,
        entryTime: Date.now(),
      });
    }

    const currentSpend = this.marketSpend.get(marketSlug) || 0;
    this.marketSpend.set(marketSlug, currentSpend + cost);

    const currentCount = this.windowTradeCount.get(marketSlug) || 0;
    this.windowTradeCount.set(marketSlug, currentCount + 1);
  }

  canBuy(marketSlug: string, additionalCostUsd: number): boolean {
    const currentSpend = this.marketSpend.get(marketSlug) || 0;
    if (currentSpend + additionalCostUsd > this.config.maxPositionPerMarket) {
      return false;
    }
    const tradeCount = this.windowTradeCount.get(marketSlug) || 0;
    if (tradeCount >= this.config.maxTradesPerWindow) {
      return false;
    }
    return true;
  }

  getMarketSpend(marketSlug: string): number {
    return this.marketSpend.get(marketSlug) || 0;
  }

  hasOpenPosition(): boolean {
    return this.positions.size > 0;
  }

  /**
   * Scalp 退出检查 — 每个 poll 都调用
   *
   * 三种退出条件（满足任一即卖）：
   * 1. 止盈：bid >= 买入价 + profitTarget
   * 2. 止损：bid <= 买入价 - stopLoss
   * 3. 时间止损：持有时间 > maxHoldMs → 以当前 bid 卖出
   */
  checkScalpExit(
    currentBids: Map<string, { price: number; size: number }>
  ): SellSignal[] {
    const signals: SellSignal[] = [];
    const now = Date.now();

    for (const [tokenId, pos] of this.positions.entries()) {
      const bestBid = currentBids.get(tokenId);
      if (!bestBid || bestBid.price <= 0.01) continue;

      const holdMs = now - pos.entryTime;
      const holdSec = Math.round(holdMs / 1000);
      const pnlPerShare = bestBid.price - pos.avgPrice;
      // 按整张卖出，避免 API 因小数或精度拒单（最小 5 张）
      const rawSize = Math.min(pos.size, bestBid.size);
      const sellSize = rawSize >= 5 ? Math.floor(rawSize) : 0;
      if (sellSize < 5) continue;

      // 1. 止盈
      if (pnlPerShare >= this.config.profitTarget) {
        signals.push({
          type: "stop_loss",
          tokenId,
          side: "SELL",
          price: bestBid.price,
          size: sellSize,
          reason: `✅止盈: ${pos.side.toUpperCase()} 买@${pos.avgPrice.toFixed(2)} 卖@${bestBid.price.toFixed(2)} +$${(pnlPerShare * sellSize).toFixed(2)} (${holdSec}s)`,
        });
        continue;
      }

      // 2. 止损
      if (pnlPerShare <= -this.config.stopLoss) {
        signals.push({
          type: "stop_loss",
          tokenId,
          side: "SELL",
          price: bestBid.price,
          size: sellSize,
          reason: `❌止损: ${pos.side.toUpperCase()} 买@${pos.avgPrice.toFixed(2)} 卖@${bestBid.price.toFixed(2)} -$${(Math.abs(pnlPerShare) * sellSize).toFixed(2)} (${holdSec}s)`,
        });
        continue;
      }

      // 3. 时间止损
      if (holdMs >= this.config.maxHoldMs) {
        const marker = pnlPerShare >= 0 ? "⏰止盈" : "⏰止损";
        signals.push({
          type: "stop_loss",
          tokenId,
          side: "SELL",
          price: bestBid.price,
          size: sellSize,
          reason: `${marker}: ${pos.side.toUpperCase()} 买@${pos.avgPrice.toFixed(2)} 卖@${bestBid.price.toFixed(2)} ${pnlPerShare >= 0 ? "+" : ""}$${(pnlPerShare * sellSize).toFixed(2)} (超${holdSec}s)`,
        });
        continue;
      }
    }

    return signals;
  }

  getPositionByMarketAndSide(marketSlug: string, side: "up" | "down"): Position | undefined {
    for (const pos of this.positions.values()) {
      if (pos.marketSlug === marketSlug && pos.side === side) return pos;
    }
    return undefined;
  }

  recordSell(tokenId: string, size: number): void {
    const pos = this.positions.get(tokenId);
    if (!pos) return;
    pos.size -= size;
    if (pos.size <= 0.01) {
      this.positions.delete(tokenId);
    }
  }

  getPosition(tokenId: string): Position | undefined {
    return this.positions.get(tokenId);
  }

  cleanupExpiredMarkets(activeMarketSlugs: Set<string>): void {
    for (const [tokenId, pos] of this.positions.entries()) {
      if (!activeMarketSlugs.has(pos.marketSlug)) {
        this.positions.delete(tokenId);
      }
    }
    for (const slug of this.marketSpend.keys()) {
      if (!activeMarketSlugs.has(slug)) {
        this.marketSpend.delete(slug);
        this.windowTradeCount.delete(slug);
      }
    }
  }

  getSummary(): string {
    if (this.positions.size === 0) return "";
    const parts: string[] = [];
    const now = Date.now();
    for (const pos of this.positions.values()) {
      const holdSec = Math.round((now - pos.entryTime) / 1000);
      parts.push(`${pos.side.toUpperCase()} ${pos.size}@${pos.avgPrice.toFixed(2)} (${holdSec}s)`);
    }
    return parts.join(" | ");
  }
}
