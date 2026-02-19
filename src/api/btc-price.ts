/**
 * 币种价格：当前价 + 历史价（用于 Price to Beat）
 * 当前价与历史价均走 OKX，数据源一致，避免 Binance/OKX 价差带来的“时间差”风险。
 */

import { fetchBtcPriceHttp, fetchSpotPriceHttp, fetchOkxCandleOpenHttp } from "./okx-ws.js";

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

/**
 * 指定 Unix 秒时刻的 BTC 价格（用于 5min 市场的 Price to Beat，OKX 1m K 线开盘价）
 */
export async function getBtcPriceAtTimestamp(unixSec: number): Promise<number | null> {
  return fetchOkxCandleOpenHttp("BTC-USDT", unixSec);
}

/**
 * 指定 Unix 秒时刻的 ETH 价格（用于 5min 市场的 Price to Beat，OKX 1m K 线开盘价）
 */
export async function getEthPriceAtTimestamp(unixSec: number): Promise<number | null> {
  return fetchOkxCandleOpenHttp("ETH-USDT", unixSec);
}

/**
 * 指定 Unix 秒时刻的 SOL 价格（用于 5min 市场的 Price to Beat，OKX 1m K 线开盘价）
 */
export async function getSolPriceAtTimestamp(unixSec: number): Promise<number | null> {
  return fetchOkxCandleOpenHttp("SOL-USDT", unixSec);
}
