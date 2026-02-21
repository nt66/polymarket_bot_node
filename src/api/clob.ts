/**
 * CLOB API：订单簿、下单（封装 @polymarket/clob-client + REST）
 */

import { ClobClient } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import type { EnvConfig } from "../config/index.js";
import { CHAIN_ID, CLOB_HOST } from "../config/index.js";

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBookSummary {
  market: string;
  asset_id: string;
  timestamp: string;
  hash: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  min_order_size?: string;
  tick_size?: string;
  neg_risk?: boolean;
}

const CLOB_BASE = CLOB_HOST;

export async function getOrderBook(tokenId: string): Promise<OrderBookSummary | null> {
  const res = await fetch(`${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`);
  if (res.status === 404 || !res.ok) return null;
  const book = (await res.json()) as OrderBookSummary;
  return normalizeBook(book);
}

/**
 * 规范化排序：
 * - bids 按价格**降序**（最高/最优 bid 在 [0]）
 * - asks 按价格**升序**（最低/最优 ask 在 [0]）
 */
function normalizeBook(book: OrderBookSummary): OrderBookSummary {
  book.bids.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
  book.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  return book;
}

export async function getOrderBooks(tokenIds: string[]): Promise<Map<string, OrderBookSummary>> {
  const out = new Map<string, OrderBookSummary>();
  if (tokenIds.length === 0) return out;
  const res = await fetch(`${CLOB_BASE}/books`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tokenIds.map((token_id) => ({ token_id }))),
  });
  if (!res.ok) return out;
  const arr = (await res.json()) as OrderBookSummary[];
  for (const b of arr) out.set(b.asset_id, normalizeBook(b));
  return out;
}

export interface CreateOrderParams {
  tokenID: string;
  price: number;
  size: number;
  side: "BUY" | "SELL";
}

export interface OrderOptions {
  tickSize?: string;
  negRisk?: boolean;
}

export type OrderType = "GTC" | "FOK" | "FAK" | "GTD";

export interface PolymarketClient {
  createAndPostOrder(
    params: CreateOrderParams,
    options: OrderOptions,
    orderType: OrderType
  ): Promise<{ success: boolean; orderId?: string; errorMsg?: string }>;

  /** 初始化授权（USDC + Outcome tokens） */
  initializeAllowances(): Promise<void>;

  /** 取消所有挂单 */
  cancelAll(): Promise<void>;

  /** 取消指定市场的挂单（用于卖出前清场，避免旧单干扰） */
  cancelMarketOrders(params: { market: string }): Promise<void>;

  /** 取消指定挂单（用于 98C 买不进则撤） */
  cancelOrder(orderId: string): Promise<boolean>;

  /** 查询订单状态（用于 98C 判断是否成交） */
  getOrder(orderId: string): Promise<{ status?: string; size_matched?: number; original_size?: number } | null>;

  /** 获取 USDC 余额 */
  getBalance(): Promise<{ balance: string; allowance: string }>;

  /** 同步指定 token 的余额/授权（买入后调用，确保卖出时有余额记录）；返回是否成功 */
  syncTokenBalance(tokenId: string): Promise<boolean>;

  /** 查询指定 outcome token 的实际余额（用于卖出前确认代币已到账） */
  getTokenBalance(tokenId: string): Promise<number>;
}

export async function createPolymarketClient(config: EnvConfig): Promise<PolymarketClient | null> {
  if (!config.privateKey || !config.funderAddress) return null;
  const pk = config.privateKey.startsWith("0x") ? config.privateKey : "0x" + config.privateKey;
  const signer = new Wallet(pk);
  let apiCreds: ApiKeyCreds;
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer);

  if (config.polyApiKey && config.polySecret && config.polyPassphrase) {
    apiCreds = {
      key: config.polyApiKey,
      secret: config.polySecret,
      passphrase: config.polyPassphrase,
    };
  } else {
    const nonce = 0;
    try {
      apiCreds = await client.deriveApiKey(nonce);
    } catch {
      try {
        apiCreds = await client.createApiKey(nonce);
      } catch (e) {
        console.error("Polymarket API key derive and create failed:", e);
        return null;
      }
    }
  }

  const tradingClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, apiCreds, config.signatureType, config.funderAddress);

  // 拦截 clob-client 库的 console 输出，捕获真正的 API 错误
  // 库在 400 等错误时会 console.log 但不抛异常
  let lastClobError = "";
  const origLog = console.log;
  const interceptClobError = (fn: () => Promise<any>): Promise<any> => {
    lastClobError = "";
    const hook = (...args: any[]) => {
      const msg = args.map(String).join(" ");
      if (msg.includes("[CLOB Client] request error")) {
        // 提取 error 字段
        const m = msg.match(/"error":"([^"]+)"/);
        if (m) lastClobError = m[1];
      }
      origLog.apply(console, args);
    };
    console.log = hook as any;
    return fn().finally(() => { console.log = origLog; });
  };

  return {
    async initializeAllowances(): Promise<void> {
      // USDC (COLLATERAL) 授权
      try {
        lastClobError = "";
        await interceptClobError(() => tradingClient.updateBalanceAllowance({ asset_type: "COLLATERAL" as any }));
        if (lastClobError) {
          console.log("[Auth] USDC 授权警告:", lastClobError);
        } else {
          console.log("[Auth] USDC (COLLATERAL) 授权 ✓");
        }
      } catch (e) {
        console.log("[Auth] USDC 授权跳过:", e instanceof Error ? e.message : String(e));
      }
      // CONDITIONAL 授权需要具体的 token_id，启动时没有 token，跳过
      // 具体 token 的授权在买入后通过 syncTokenBalance 完成
      console.log("[Auth] Outcome tokens 授权: 将在买入后按 token 单独授权");
    },

    async cancelAll(): Promise<void> {
      try {
        await tradingClient.cancelAll();
        console.log("[Orders] 所有挂单已取消");
      } catch (e) {
        console.log("[Orders] cancelAll:", e instanceof Error ? e.message : e);
      }
    },

    async cancelMarketOrders(params: { market: string }): Promise<void> {
      try {
        await tradingClient.cancelMarketOrders(params);
        console.log("[Orders] 该市场挂单已取消");
      } catch (e) {
        console.log("[Orders] cancelMarketOrders:", e instanceof Error ? e.message : e);
      }
    },

    async cancelOrder(orderId: string): Promise<boolean> {
      try {
        await (tradingClient as any).cancelOrder({ orderID: orderId });
        return true;
      } catch (e) {
        console.log("[Orders] cancelOrder:", e instanceof Error ? e.message : e);
        return false;
      }
    },

    async getOrder(orderId: string): Promise<{ status?: string; size_matched?: number; original_size?: number } | null> {
      try {
        const o = await (tradingClient as any).getOrder(orderId);
        if (!o) return null;
        return {
          status: o.status,
          size_matched: o.size_matched != null ? parseFloat(String(o.size_matched)) : undefined,
          original_size: o.original_size != null ? parseFloat(String(o.original_size)) : undefined,
        };
      } catch {
        return null;
      }
    },

    async getBalance(): Promise<{ balance: string; allowance: string }> {
      try {
        const bal = await tradingClient.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
        return { balance: bal.balance ?? "0", allowance: bal.allowance ?? "0" };
      } catch {
        return { balance: "0", allowance: "0" };
      }
    },

    async syncTokenBalance(tokenId: string): Promise<boolean> {
      try {
        lastClobError = "";
        await interceptClobError(() =>
          tradingClient.updateBalanceAllowance({ asset_type: "CONDITIONAL" as any, token_id: tokenId })
        );
        if (lastClobError) {
          console.log(`[Sync] token 授权失败: ${lastClobError}`);
          return false;
        }
        return true;
      } catch (e) {
        console.log(`[Sync] token 授权异常: ${e instanceof Error ? e.message : e}`);
        return false;
      }
    },

    async getTokenBalance(tokenId: string): Promise<number> {
      try {
        lastClobError = "";
        let result: any;
        await interceptClobError(async () => {
          result = await tradingClient.getBalanceAllowance({
            asset_type: "CONDITIONAL" as any,
            token_id: tokenId,
          });
        });
        if (lastClobError) return 0;
        // result 结构: { balance: string, allowance: string }
        const bal = parseFloat(result?.balance ?? "0");
        return bal;
      } catch {
        return 0;
      }
    },

    async createAndPostOrder(params, options, orderType) {
      try {
        const { OrderType, Side } = await import("@polymarket/clob-client");
        const orderTypeEnum = orderType === "GTD" ? OrderType.GTD : OrderType.GTC;
        const result = await tradingClient.createAndPostOrder(
          {
            tokenID: params.tokenID,
            price: params.price,
            size: params.size,
            side: params.side === "BUY" ? Side.BUY : Side.SELL,
          },
          {
            tickSize: (options.tickSize ?? "0.01") as "0.1" | "0.01" | "0.001" | "0.0001",
            negRisk: options.negRisk ?? false,
          },
          orderTypeEnum
        );
        const r = result as { success?: boolean; orderId?: string; errorMsg?: string; orderID?: string; error?: string; status?: string };
        const orderId = r.orderId || r.orderID; // 兼容不同返回字段名
        const success = r.success === true; // 严格判断，undefined/null/false 都算失败
        // clob-client 库在 API 400 时不抛异常，而是返回 { success: false }
        // 所以在 try 块里也要尝试提取错误信息
        const errorMsg = r.errorMsg || r.error || (!success ? `order rejected (success=${r.success})` : undefined);
        return { success, orderId, errorMsg };
      } catch (e: unknown) {
        const err = e as { message?: string; response?: { data?: { error?: string } } };
        const fromBody = err.response?.data?.error;
        const msg = err?.message ?? String(e);
        const match = msg.match(/"error":"([^"]+)"/);
        const errorDetail = fromBody ?? (match ? match[1] : msg);
        return { success: false, errorMsg: errorDetail };
      }
    },
  };
}
