/**
 * 币种价格：当前价 + 历史价（用于 Price to Beat）
 * 当前价走 OKX，历史价走 Binance Kline（公开接口）。
 */

import { fetchBtcPriceHttp, fetchSpotPriceHttp } from "./okx-ws.js";

const BINANCE_KLINE = "https://api.binance.com/api/v3/klines";

/** 当前价缓存 1 秒，避免轮询时每轮都打 OKX */
let cachedBtc: { price: number; at: number } | null = null;
let cachedEth: { price: number; at: number } | null = null;
let cachedSol: { price: number; at: number } | null = null;
const CACHE_MS = 1000;

/**
 * 当前 BTC 价格（美元）
 */
export async function getCurrentBtcPrice(): Promise<number | null> {
  const now = Date.now();
  if (cachedBtc && now - cachedBtc.at < CACHE_MS) return cachedBtc.price;
  const price = await fetchBtcPriceHttp();
  if (price != null) cachedBtc = { price, at: now };
  return price ?? null;
}

/**
 * 当前 ETH 价格（美元）
 */
export async function getCurrentEthPrice(): Promise<number | null> {
  const now = Date.now();
  if (cachedEth && now - cachedEth.at < CACHE_MS) return cachedEth.price;
  const price = await fetchSpotPriceHttp("ETH-USDT");
  if (price != null) cachedEth = { price, at: now };
  return price ?? null;
}

/**
 * 当前 SOL 价格（美元）
 */
export async function getCurrentSolPrice(): Promise<number | null> {
  const now = Date.now();
  if (cachedSol && now - cachedSol.at < CACHE_MS) return cachedSol.price;
  const price = await fetchSpotPriceHttp("SOL-USDT");
  if (price != null) cachedSol = { price, at: now };
  return price ?? null;
}

async function getPriceAtTimestamp(symbol: string, unixSec: number): Promise<number | null> {
  try {
    const candleStartMs = Math.floor(unixSec / 60) * 60 * 1000;
    const url = `${BINANCE_KLINE}?symbol=${symbol}&interval=1m&startTime=${candleStartMs}&limit=1`;
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

/**
 * 指定 Unix 秒时刻的 BTC 价格（用于 5min 市场的 Price to Beat）
 */
export async function getBtcPriceAtTimestamp(unixSec: number): Promise<number | null> {
  return getPriceAtTimestamp("BTCUSDT", unixSec);
}

/**
 * 指定 Unix 秒时刻的 ETH 价格（用于 5min 市场的 Price to Beat）
 */
export async function getEthPriceAtTimestamp(unixSec: number): Promise<number | null> {
  return getPriceAtTimestamp("ETHUSDT", unixSec);
}

/**
 * 指定 Unix 秒时刻的 SOL 价格（用于 5min 市场的 Price to Beat）
 */
export async function getSolPriceAtTimestamp(unixSec: number): Promise<number | null> {
  return getPriceAtTimestamp("SOLUSDT", unixSec);
}
