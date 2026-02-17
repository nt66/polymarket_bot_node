/**
 * 配置模块：从环境变量加载（98 概率买入 Bot 仅需以下项）
 */

export interface EnvConfig {
  // Polymarket 必填
  privateKey: string;
  funderAddress: string;
  signatureType: 0 | 1 | 2;
  polyApiKey?: string;
  polySecret?: string;
  polyPassphrase?: string;
  // 98 概率买入（BTC 5min）
  /** 每次买入多少 shares（固定张数） */
  buy98OrderSizeShares: number;
  /** 单市场最大持仓金额（美元），需 ≥ 单笔成本（如 100 shares @ 0.99 = $99） */
  buy98OrderMaxPositionPerMarket: number;
  /** 允许挂单的价格列表（如 [0.99, 0.98]） */
  buy98OrderPrices: number[];
}

const defaultConfig: EnvConfig = {
  privateKey: "",
  funderAddress: "",
  signatureType: 2,
  buy98OrderSizeShares: 20,
  buy98OrderMaxPositionPerMarket: 150,
  buy98OrderPrices: [0.99, 0.98],
};

function parseNum(val: string | undefined, def: number): number {
  if (val === undefined || val === "") return def;
  const n = Number(val);
  return Number.isFinite(n) ? n : def;
}

function parseNumList(val: string | undefined, def: number[]): number[] {
  if (!val) return def;
  const out = val
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 1.01);
  if (out.length === 0) return def;
  // 去重 + 按高到低排序（先看 0.99 再看 0.98）
  return Array.from(new Set(out)).sort((a, b) => b - a);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  return {
    privateKey: env.PRIVATE_KEY ?? defaultConfig.privateKey,
    funderAddress: env.POLYMARKET_FUNDER_ADDRESS ?? defaultConfig.funderAddress,
    signatureType: (parseNum(env.SIGNATURE_TYPE, 2) as 0 | 1 | 2) || 2,
    polyApiKey: env.POLY_API_KEY,
    polySecret: env.POLY_SECRET,
    polyPassphrase: env.POLY_PASSPHRASE,

    buy98OrderSizeShares: parseNum(env.BUY98_ORDER_SIZE_SHARES, defaultConfig.buy98OrderSizeShares),
    buy98OrderMaxPositionPerMarket: parseNum(env.BUY98_MAX_POSITION_PER_MARKET, defaultConfig.buy98OrderMaxPositionPerMarket),
    // 新：逗号分隔，如 "0.98,0.99"；兼容旧 BUY98_ORDER_PRICE
    buy98OrderPrices: parseNumList(env.BUY98_ORDER_PRICES ?? env.BUY98_ORDER_PRICE, defaultConfig.buy98OrderPrices),
  };
}

export const CLOB_HOST = "https://clob.polymarket.com";
export const GAMMA_HOST = "https://gamma-api.polymarket.com";
export const CHAIN_ID = 137;
