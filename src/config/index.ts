/**
 * 配置模块：从环境变量加载，集中管理
 */

export interface EnvConfig {
  // Polymarket
  privateKey: string;
  funderAddress: string;
  signatureType: 0 | 1 | 2;
  polyApiKey?: string;
  polySecret?: string;
  polyPassphrase?: string;

  // 策略开关
  strategyLatencyArb: boolean;
  strategyNegRiskArb: boolean;
  strategyEvArb: boolean;

  // 延迟套利
  latencyPriceJumpThreshold: number;

  // 负风险套利
  negRiskMaxSum: number;

  // 末日轮
  evArbLastSeconds: number;

  // 下单金额控制（USDC 计）
  orderSizeMin: number;   // 单笔最小（低于此不下单）
  orderSizeMax: number;   // 单笔最大（超出按此截断）

  // EV arb 最低安全垫 (BTC 距起点至少偏离多少美元)
  evMinDiffUsd: number;
  // EV arb 最低边际 (理论概率 - 市场价 至少差多少)
  evMinEdge: number;
  // Latency arb 最低价格跳动 (美元)
  latencyMinJumpUsd: number;

  // 市场筛选：15m 或 5m
  btcMarketMode: "15m" | "5m";
  btc15MinTagId: string;
  btc15MinSlug: string;

  // 巩固/加强：入场与仓位（可 .env 覆盖）
  trendMinBid: number;        // TREND 入场：赢方 bid 至少多少（提高=少而准）
  endgameMaxAsk: number;      // ENDGAME 入场：ask 不超过多少（降低=只接高置信度）
  endgameStopLoss: number;    // ENDGAME 止损：bid 跌超此阈值就砍（v5 新增，不再死扛）
  maxPositionPerMarket: number;  // 单市场最大占用 USDC
  maxTradesPerWindow: number;    // 单窗口最多几笔

  // 跟单模式
  botMode: "scalp" | "copy";            // 运行模式：scalp=原策略, copy=跟单
  copyTargetAddress: string;             // 跟单目标的钱包地址
  copySize: number;                      // 每笔跟单最大股数（实际按预算换算可能更小）
  copyMinPrice: number;                  // 只跟价格 >= 此值的交易
  copyMaxPrice: number;                  // 只跟价格 <= 此值的交易
  copyMaxPendingCost: number;            // 未结算持仓总成本上限 (USDC)
  copyMaxBudget: number;                 // 跟单总预算 (USDC)，不超过此金额在仓
  copyMaxAgeSeconds: number;             // 超过此秒数的交易视为太旧不跟（Data API 有延迟，建议 300）
}

const defaultConfig: EnvConfig = {
  privateKey: "",
  funderAddress: "",
  signatureType: 2,
  strategyLatencyArb: true,
  strategyNegRiskArb: true,
  strategyEvArb: true,
  latencyPriceJumpThreshold: 30,
  negRiskMaxSum: 0.98,
  evArbLastSeconds: 120,
  orderSizeMin: 5,
  orderSizeMax: 50,
  evMinDiffUsd: 80,
  evMinEdge: 0.10,
  latencyMinJumpUsd: 80,
  btcMarketMode: "15m",
  btc15MinTagId: "",
  btc15MinSlug: "",

  trendMinBid: 0.65,
  endgameMaxAsk: 0.88,
  endgameStopLoss: 0.20,
  maxPositionPerMarket: 8,
  maxTradesPerWindow: 2,

  botMode: "scalp",
  copyTargetAddress: "",
  copySize: 5,
  copyMinPrice: 0.15,
  copyMaxPrice: 0.95,
  copyMaxPendingCost: 20,
  copyMaxBudget: 50,
  copyMaxAgeSeconds: 300,
};

function parseBool(val: string | undefined, def: boolean): boolean {
  if (val === undefined || val === "") return def;
  return /^(1|true|yes)$/i.test(val.trim());
}

function parseNum(val: string | undefined, def: number): number {
  if (val === undefined || val === "") return def;
  const n = Number(val);
  return Number.isFinite(n) ? n : def;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  return {
    privateKey: env.PRIVATE_KEY ?? defaultConfig.privateKey,
    funderAddress: env.POLYMARKET_FUNDER_ADDRESS ?? defaultConfig.funderAddress,
    signatureType: (parseNum(env.SIGNATURE_TYPE, 2) as 0 | 1 | 2) || 2,
    polyApiKey: env.POLY_API_KEY,
    polySecret: env.POLY_SECRET,
    polyPassphrase: env.POLY_PASSPHRASE,

    strategyLatencyArb: parseBool(env.STRATEGY_LATENCY_ARB, defaultConfig.strategyLatencyArb),
    strategyNegRiskArb: parseBool(env.STRATEGY_NEG_RISK_ARB, defaultConfig.strategyNegRiskArb),
    strategyEvArb: parseBool(env.STRATEGY_EV_ARB, defaultConfig.strategyEvArb),

    latencyPriceJumpThreshold: parseNum(env.LATENCY_PRICE_JUMP_THRESHOLD, defaultConfig.latencyPriceJumpThreshold),
    negRiskMaxSum: parseNum(env.NEG_RISK_MAX_SUM, defaultConfig.negRiskMaxSum),
    evArbLastSeconds: parseNum(env.EV_ARB_LAST_SECONDS, defaultConfig.evArbLastSeconds),

    orderSizeMin: parseNum(env.ORDER_SIZE_MIN, defaultConfig.orderSizeMin),
    orderSizeMax: parseNum(env.ORDER_SIZE_MAX, defaultConfig.orderSizeMax),

    evMinDiffUsd: parseNum(env.EV_MIN_DIFF_USD, defaultConfig.evMinDiffUsd),
    evMinEdge: parseNum(env.EV_MIN_EDGE, defaultConfig.evMinEdge),
    // 延迟套利：优先 LATENCY_MIN_JUMP_USD，否则用 LATENCY_PRICE_JUMP_THRESHOLD
    latencyMinJumpUsd: parseNum(env.LATENCY_MIN_JUMP_USD ?? env.LATENCY_PRICE_JUMP_THRESHOLD, defaultConfig.latencyMinJumpUsd),

    btcMarketMode: (env.BTC_MARKET_MODE === "5m" ? "5m" : "15m") as "15m" | "5m",
    btc15MinTagId: env.BTC_15MIN_TAG_ID ?? defaultConfig.btc15MinTagId,
    btc15MinSlug: env.BTC_15MIN_SLUG ?? defaultConfig.btc15MinSlug,

    trendMinBid: parseNum(env.TREND_MIN_BID, defaultConfig.trendMinBid),
    endgameMaxAsk: parseNum(env.ENDGAME_MAX_ASK, defaultConfig.endgameMaxAsk),
    endgameStopLoss: parseNum(env.ENDGAME_STOP_LOSS, defaultConfig.endgameStopLoss),
    maxPositionPerMarket: parseNum(env.MAX_POSITION_PER_MARKET, defaultConfig.maxPositionPerMarket),
    maxTradesPerWindow: parseNum(env.MAX_TRADES_PER_WINDOW, defaultConfig.maxTradesPerWindow),

    botMode: (env.BOT_MODE === "copy" ? "copy" : "scalp") as "scalp" | "copy",
    copyTargetAddress: env.COPY_TARGET_ADDRESS ?? defaultConfig.copyTargetAddress,
    copySize: parseNum(env.COPY_SIZE, defaultConfig.copySize),
    copyMinPrice: parseNum(env.COPY_MIN_PRICE, defaultConfig.copyMinPrice),
    copyMaxPrice: parseNum(env.COPY_MAX_PRICE, defaultConfig.copyMaxPrice),
    copyMaxPendingCost: parseNum(env.COPY_MAX_PENDING_COST, defaultConfig.copyMaxPendingCost),
    copyMaxBudget: parseNum(env.COPY_MAX_BUDGET, defaultConfig.copyMaxBudget),
    copyMaxAgeSeconds: parseNum(env.COPY_MAX_AGE_SECONDS, defaultConfig.copyMaxAgeSeconds),
  };
}

export const CLOB_HOST = "https://clob.polymarket.com";
export const GAMMA_HOST = "https://gamma-api.polymarket.com";
export const CHAIN_ID = 137;
