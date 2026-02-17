/**
 * 按天写入日志文件：logs/YYYY-MM-DD.log
 */

import * as fs from "fs";
import * as path from "path";

const LOG_DIR = path.join(process.cwd(), "logs");

function dateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function timeStr(d: Date = new Date()): string {
  return d.toISOString();
}

function logFilePath(datePrefix: string): string {
  return path.join(LOG_DIR, `${datePrefix}.log`);
}

function ensureLogDir(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * 追加一行到当日日志文件
 */
export function logDaily(line: string): void {
  try {
    ensureLogDir();
    const file = logFilePath(dateStr());
    const ts = timeStr();
    fs.appendFileSync(file, `${ts} ${line}\n`, "utf8");
  } catch (e) {
    console.error("[daily-log]", e instanceof Error ? e.message : e);
  }
}

/**
 * 写入一条交易记录（买入/卖出）
 */
export function logTrade(params: {
  slug: string;
  side: "up" | "down";
  action: "BUY" | "SELL";
  price: number;
  size: number;
  reason?: string;
}): void {
  const { slug, side, action, price, size, reason = "" } = params;
  logDaily(`TRADE ${action} slug=${slug} side=${side.toUpperCase()} price=${price} size=${size}${reason ? ` reason=${reason}` : ""}`);
}

/**
 * 写入一轮结束：市场结束时的 Up/Down 盘口（最后一笔 snapshot）
 */
export function logRoundEnd(params: {
  slug: string;
  endTime: string;
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
}): void {
  const { slug, endTime, upBid, upAsk, downBid, downAsk } = params;
  logDaily(`ROUND_END slug=${slug} endTime=${endTime} Up_bid=${upBid} Up_ask=${upAsk} Down_bid=${downBid} Down_ask=${downAsk}`);
}
