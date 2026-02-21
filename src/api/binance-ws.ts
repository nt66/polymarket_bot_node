/**
 * Binance BTC 实时价格 WebSocket
 * 用于与 OKX 双交易所价格校准：价差过大时 Bot 进入静默，避免诱多/诱空陷阱。
 */

import WebSocket from "ws";

const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws/btcusdt@aggTrade";
const RECONNECT_MS = 3000;

let binanceBtcPrice: number | null = null;
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connect(): void {
  // 避免网络抖动或重连时产生多个连接：先终止并清空已有 socket
  const prev = ws;
  ws = null;
  if (prev) {
    try {
      prev.terminate();
    } catch {
      // ignore
    }
  }

  try {
    ws = new WebSocket(BINANCE_WS_URL);
  } catch (e) {
    console.error("[Binance WS] Connect error:", e);
    scheduleReconnect();
    return;
  }

  const socket = ws;

  ws.on("open", () => {
    console.log("[Binance WS] Connected (btcusdt@aggTrade)");
  });

  ws.on("message", (data: Buffer | string) => {
    try {
      const msg = JSON.parse(data.toString()) as { p?: string };
      const p = msg.p;
      if (typeof p === "string") {
        const price = parseFloat(p);
        if (Number.isFinite(price)) binanceBtcPrice = price;
      }
    } catch {
      // ignore parse error
    }
  });

  ws.on("error", (e: Error) => {
    console.error("[Binance WS] Error:", e.message);
  });

  ws.on("close", () => {
    // 仅当关闭的是当前连接时才清空并重连，避免被 terminate() 的旧 socket 误清掉新连接
    if (ws === socket) {
      ws = null;
      scheduleReconnect();
    }
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer != null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log("[Binance WS] Reconnecting...");
    connect();
  }, RECONNECT_MS);
}

/**
 * 启动 Binance BTC 价格 WebSocket，自动重连。
 */
export function initBinancePrice(): void {
  if (ws != null) return;
  connect();
}

/**
 * 获取当前 Binance BTC 价格（内存读取，零延迟）。
 */
export function getBinanceBtcPrice(): number | null {
  return binanceBtcPrice;
}

/**
 * 双交易所价差阈值（美元）：超过则进入静默，不新开单。
 */
export const DUAL_EXCHANGE_DIVERGENCE_THRESHOLD = 8;
