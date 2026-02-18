/**
 * BTC 价格：当前价 + 历史价（用于 Price to Beat）
 * 当前价走 OKX，历史价走 Binance Kline（公开接口）。
 */

import { fetchBtcPriceHttp } from "./okx-ws.js";

const BINANCE_KLINE = "https://api.binance.com/api/v3/klines";

/** 当前价缓存 1 秒，避免轮询时每轮都打 OKX */
let cachedCurrent: { price: number; at: number } | null = null;
const CACHE_MS = 1000;

/**
 * 当前 BTC 价格（美元）
 */
export async function getCurrentBtcPrice(): Promise<number | null> {
  const now = Date.now();
  if (cachedCurrent && now - cachedCurrent.at < CACHE_MS) return cachedCurrent.price;
  const price = await fetchBtcPriceHttp();
  if (price != null) cachedCurrent = { price, at: now };
  return price ?? null;
}

/**
 * 指定 Unix 秒时刻的 BTC 价格（用于 5min 市场的 Price to Beat）
 * 用 Binance 1m Kline 的 open 近似该分钟开始时的价格。
 */
export async function getBtcPriceAtTimestamp(unixSec: number): Promise<number | null> {
  try {
    const candleStartMs = Math.floor(unixSec / 60) * 60 * 1000;
    const url = `${BINANCE_KLINE}?symbol=BTCUSDT&interval=1m&startTime=${candleStartMs}&limit=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const arr = (await res.json()) as unknown[];
    const candle = arr[0] as [number, string, string, string, string, ...unknown[]] | undefined;
    if (!candle || !candle[1]) return null;
    const open = parseFloat(candle[1]);
    return Number.isFinite(open) ? open : null;
  } catch {
    return null;
  }
}
