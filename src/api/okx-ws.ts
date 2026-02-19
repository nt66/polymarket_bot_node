/**
 * OKX BTC 价格源：WebSocket + HTTP 备用
 */

import WebSocket from "ws";

const OKX_WS_PUBLIC = "wss://ws.okx.com:8443/ws/v5/public";
const OKX_REST_TICKER = "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT";

const OKX_REST_BASE = "https://www.okx.com";

/** 通用 REST 拉取现货价格（BTC/ETH/SOL 等） */
export async function fetchSpotPriceHttp(instId: string): Promise<number | null> {
  try {
    const res = await fetch(`${OKX_REST_BASE}/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ last?: string }> };
    const last = parseFloat(json.data?.[0]?.last ?? "");
    return Number.isFinite(last) ? last : null;
  } catch {
    return null;
  }
}

/**
 * OKX 历史 K 线开盘价（与当前价同源，避免 Binance/OKX 价差导致 Price to Beat 偏差）
 * instId 如 BTC-USDT；unixSec 为窗口开始的 Unix 秒。
 */
export async function fetchOkxCandleOpenHttp(instId: string, unixSec: number): Promise<number | null> {
  try {
    const candleStartMs = Math.floor(unixSec / 60) * 60 * 1000;
    const after = candleStartMs + 60000; // 取 ts < after 的 K 线，即该分钟那根
    const url = `${OKX_REST_BASE}/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}&bar=1m&after=${after}&limit=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: string[][] };
    const row = json.data?.[0];
    if (!row || row.length < 2) return null;
    const open = parseFloat(row[1]);
    return Number.isFinite(open) ? open : null;
  } catch {
    return null;
  }
}

export type BtcPriceHandler = (price: number, ts: number) => void;

/**
 * 通过 OKX WebSocket 订阅 BTC-USDT 实时价
 * 加了 open/error/close 日志和自动重连
 */
export function connectOkxBtcSpot(onPrice: BtcPriceHandler): WebSocket {
  let ws: WebSocket;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect(): WebSocket {
    const socket = new WebSocket(OKX_WS_PUBLIC);

    socket.on("open", () => {
      console.log("[OKX-WS] Connected. Subscribing to BTC-USDT ticker...");
      socket.send(
        JSON.stringify({
          op: "subscribe",
          args: [{ channel: "tickers", instId: "BTC-USDT" }],
        })
      );
    });

    socket.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.arg?.channel === "tickers" && msg.data?.[0]) {
          const last = parseFloat(msg.data[0].last);
          const ts = parseInt(msg.data[0].ts ?? String(Date.now()), 10);
          if (Number.isFinite(last)) onPrice(last, ts);
        }
      } catch {
        // ignore
      }
    });

    socket.on("error", (err: Error) => {
      console.error("[OKX-WS] Error:", err.message);
    });

    socket.on("close", (code: number, reason: Buffer) => {
      console.warn("[OKX-WS] Closed. code=", code, "reason=", reason.toString().slice(0, 80));
      scheduleReconnect();
    });

    return socket;
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      console.log("[OKX-WS] Reconnecting...");
      ws = connect();
    }, 5000);
  }

  ws = connect();
  return ws;
}

/**
 * HTTP 备用：轮询 OKX REST 拿 BTC 价格（每 N 秒调一次）
 */
export async function fetchBtcPriceHttp(): Promise<number | null> {
  try {
    const res = await fetch(OKX_REST_TICKER);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ last?: string }> };
    const last = parseFloat(json.data?.[0]?.last ?? "");
    return Number.isFinite(last) ? last : null;
  } catch {
    return null;
  }
}

export function closeOkxWs(ws: WebSocket): void {
  try {
    ws.close();
  } catch {
    // ignore
  }
}
