/**
 * Gamma API：获取市场/事件列表，用于筛选 BTC 15min 市场
 *
 * 核心思路：BTC 15min 市场的 slug 格式为 btc-updown-15m-{START_TIMESTAMP}
 * 其中 START_TIMESTAMP 是 15 分钟窗口开始的 Unix 秒数。
 * endDate = start + 900s (15 分钟)。
 * 通过当前时间计算当前和即将到来的 slot，直接按 slug 精确查询。
 */

const GAMMA_BASE = "https://gamma-api.polymarket.com";

export interface GammaMarketToken {
  token_id: string;
  outcome: string;
}

export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  resolutionSource: string;
  endDate: string;
  liquidity: string;
  volume: string;
  closed: boolean;
  negRisk: boolean;
  tokens: GammaMarketToken[];
  startDate?: string;
  acceptingOrders?: boolean;
  marketSlug?: string;
  groupItemTitle?: string;
  clobTokenIds?: string;
  outcomes?: string;
  [key: string]: unknown;
}

export interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  markets: GammaMarket[];
  endDate: string;
  closed: boolean;
  [key: string]: unknown;
}

/**
 * 将 Gamma 原始市场转为统一结构：保证 tokens 为 { token_id, outcome }[]
 */
export function normalizeMarket(m: Record<string, unknown>): GammaMarket {
  const base = m as GammaMarket;
  if (Array.isArray(base.tokens) && base.tokens.length >= 2) {
    return base;
  }
  const tokens: GammaMarketToken[] = [];
  try {
    const ids: string[] = typeof base.clobTokenIds === "string" ? JSON.parse(base.clobTokenIds) : [];
    const outcomes: string[] = typeof base.outcomes === "string" ? JSON.parse(base.outcomes) : ["Yes", "No"];
    for (let i = 0; i < ids.length; i++) {
      tokens.push({ token_id: ids[i], outcome: outcomes[i] ?? (i === 0 ? "Yes" : "No") });
    }
  } catch {
    // ignore
  }
  return { ...base, tokens };
}

/**
 * 按 slug 获取单个事件
 */
export async function getEventBySlug(slug: string): Promise<GammaEvent | null> {
  try {
    const res = await fetch(`${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return res.json() as Promise<GammaEvent>;
  } catch {
    return null;
  }
}

/**
 * 计算当前和未来 N 个 15 分钟 slot 的 start timestamp
 * slot 对齐到 900 秒（15 分钟）边界
 */
function generate15mSlots(nowSec: number, count: number): number[] {
  const currentSlotStart = Math.floor(nowSec / 900) * 900;
  const slots: number[] = [];
  for (let i = 0; i < count; i++) {
    slots.push(currentSlotStart + i * 900);
  }
  return slots;
}

/** 5 分钟 slot：对齐到 300 秒边界 */
function generate5mSlots(nowSec: number, count: number): number[] {
  const currentSlotStart = Math.floor(nowSec / 300) * 300;
  const slots: number[] = [];
  for (let i = 0; i < count; i++) {
    slots.push(currentSlotStart + i * 300);
  }
  return slots;
}

const FIVE_MIN_SEC = 300;

export interface Btc15mResult {
  allMarkets: GammaMarket[];
  inWindow: GammaMarket[];
  upcoming: GammaMarket[];
  nextStartsInSec: number;
}

/**
 * 获取 BTC 15min 市场。
 * 策略：根据当前时间计算 slug，直接精确查询当前 + 未来 N 个 slot。
 * 同时查前一个 slot（可能还有几秒没结算）。
 */
export async function getBtc15MinMarkets(
  _tagId?: string,
  _slug?: string
): Promise<Btc15mResult> {
  const nowSec = Date.now() / 1000;

  // 生成 slot：前 1 个 + 当前 + 未来 8 个 = 10 个
  const currentSlotStart = Math.floor(nowSec / 900) * 900;
  const prevSlot = currentSlotStart - 900;
  const slots = [prevSlot, ...generate15mSlots(nowSec, 9)];

  // 并发查询所有 slot
  const slugs = slots.map((ts) => `btc-updown-15m-${ts}`);
  const results = await Promise.allSettled(
    slugs.map((slug) => getEventBySlug(slug))
  );

  const allMarkets: GammaMarket[] = [];
  const inWindow: GammaMarket[] = [];
  const upcoming: GammaMarket[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== "fulfilled" || !r.value) continue;
    const event = r.value;
    if (event.closed) continue;
    if (!event.markets?.length) continue;

    for (const m of event.markets) {
      if ((m as GammaMarket).closed) continue;
      const market = normalizeMarket(m as Record<string, unknown>);
      if (market.tokens.length < 2) continue;

      allMarkets.push(market);

      const slotStart = slots[i];
      const slotEnd = slotStart + 900;

      if (nowSec >= slotStart && nowSec < slotEnd) {
        inWindow.push(market);
      } else if (nowSec < slotStart) {
        upcoming.push(market);
      }
      // 已过期的 slot (nowSec >= slotEnd) → 跳过
    }
  }

  // 排序 upcoming 按时间先后
  upcoming.sort((a, b) => {
    const ea = a.endDate ? new Date(a.endDate).getTime() : 0;
    const eb = b.endDate ? new Date(b.endDate).getTime() : 0;
    return ea - eb;
  });

  let nextStartsInSec = -1;
  if (upcoming.length > 0) {
    // 下一个 upcoming 的 start = endDate - 900
    const nextEnd = upcoming[0].endDate ? new Date(upcoming[0].endDate).getTime() / 1000 : 0;
    const nextStart = nextEnd - 900;
    nextStartsInSec = Math.max(0, nextStart - nowSec);
  }

  return { allMarkets, inWindow, upcoming, nextStartsInSec };
}

/**
 * 获取 BTC 5min 市场。
 * slug 格式：btc-updown-5m-{START_TIMESTAMP}，窗口 300 秒。
 */
export async function getBtc5MinMarkets(): Promise<Btc15mResult> {
  const nowSec = Date.now() / 1000;
  const currentSlotStart = Math.floor(nowSec / FIVE_MIN_SEC) * FIVE_MIN_SEC;
  const prevSlot = currentSlotStart - FIVE_MIN_SEC;
  const slots = [prevSlot, ...generate5mSlots(nowSec, 9)];
  const slugs = slots.map((ts) => `btc-updown-5m-${ts}`);

  const results = await Promise.allSettled(
    slugs.map((slug) => getEventBySlug(slug))
  );

  const allMarkets: GammaMarket[] = [];
  const inWindow: GammaMarket[] = [];
  const upcoming: GammaMarket[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== "fulfilled" || !r.value) continue;
    const event = r.value;
    if (event.closed) continue;
    if (!event.markets?.length) continue;

    for (const m of event.markets) {
      if ((m as GammaMarket).closed) continue;
      const market = normalizeMarket(m as Record<string, unknown>);
      if (market.tokens.length < 2) continue;

      allMarkets.push(market);
      const slotStart = slots[i];
      const slotEnd = slotStart + FIVE_MIN_SEC;

      if (nowSec >= slotStart && nowSec < slotEnd) {
        inWindow.push(market);
      } else if (nowSec < slotStart) {
        upcoming.push(market);
      }
    }
  }

  upcoming.sort((a, b) => {
    const ea = a.endDate ? new Date(a.endDate).getTime() : 0;
    const eb = b.endDate ? new Date(b.endDate).getTime() : 0;
    return ea - eb;
  });

  let nextStartsInSec = -1;
  if (upcoming.length > 0) {
    const nextEnd = upcoming[0].endDate ? new Date(upcoming[0].endDate).getTime() / 1000 : 0;
    nextStartsInSec = Math.max(0, nextEnd - FIVE_MIN_SEC - nowSec);
  }

  return { allMarkets, inWindow, upcoming, nextStartsInSec };
}
