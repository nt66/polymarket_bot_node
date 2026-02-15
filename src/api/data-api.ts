/**
 * Polymarket Data API：查询任意用户的交易和持仓（公开 API，无需认证）
 */

const DATA_API_BASE = "https://data-api.polymarket.com";

export interface TargetTrade {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string;         // token_id
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;     // unix seconds
  title: string;
  slug: string;
  outcome: string;       // "Up" | "Down"
  outcomeIndex: number;
  eventSlug: string;
  transactionHash: string;
}

export interface TargetPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  curPrice: number;
  redeemable: boolean;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
}

const FETCH_TIMEOUT_MS = 12000;

/**
 * 拉取目标用户的最新交易（带超时，避免网络卡死导致 bot 停住）
 */
export async function fetchTargetTrades(
  userAddress: string,
  limit = 50
): Promise<TargetTrade[]> {
  const url = `${DATA_API_BASE}/trades?user=${encodeURIComponent(userAddress)}&limit=${limit}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    clearTimeout(to);
    throw e;
  }
  clearTimeout(to);
  if (!res.ok) {
    console.error(`[DataAPI] trades error: ${res.status} ${res.statusText}`);
    return [];
  }
  const data = await res.json() as any[];
  return data.map((t) => ({
    proxyWallet: t.proxyWallet,
    side: t.side,
    asset: t.asset,
    conditionId: t.conditionId,
    size: typeof t.size === "number" ? t.size : parseFloat(t.size),
    price: typeof t.price === "number" ? t.price : parseFloat(t.price),
    timestamp: typeof t.timestamp === "number" ? t.timestamp : parseInt(t.timestamp, 10),
    title: t.title || "",
    slug: t.slug || "",
    outcome: t.outcome || "",
    outcomeIndex: t.outcomeIndex ?? 0,
    eventSlug: t.eventSlug || "",
    transactionHash: t.transactionHash || "",
  }));
}

/**
 * 拉取目标用户的当前持仓
 */
export async function fetchTargetPositions(
  userAddress: string,
  limit = 50
): Promise<TargetPosition[]> {
  const url = `${DATA_API_BASE}/positions?user=${encodeURIComponent(userAddress)}&limit=${limit}&sortBy=CURRENT&sortDirection=DESC`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[DataAPI] positions error: ${res.status} ${res.statusText}`);
    return [];
  }
  const data = await res.json() as any[];
  return data.map((p) => ({
    proxyWallet: p.proxyWallet,
    asset: p.asset,
    conditionId: p.conditionId,
    size: p.size ?? 0,
    avgPrice: p.avgPrice ?? 0,
    initialValue: p.initialValue ?? 0,
    currentValue: p.currentValue ?? 0,
    cashPnl: p.cashPnl ?? 0,
    percentPnl: p.percentPnl ?? 0,
    curPrice: p.curPrice ?? 0,
    redeemable: p.redeemable ?? false,
    title: p.title || "",
    slug: p.slug || "",
    eventSlug: p.eventSlug || "",
    outcome: p.outcome || "",
    outcomeIndex: p.outcomeIndex ?? 0,
    oppositeOutcome: p.oppositeOutcome || "",
    oppositeAsset: p.oppositeAsset || "",
    endDate: p.endDate || "",
    negativeRisk: p.negativeRisk ?? false,
  }));
}
