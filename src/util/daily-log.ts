/**
 * 按天写入日志文件：logs/YYYY-MM-DD.log
 * 时间用 ET 显示，格式与网站一致：February 18, 1:35AM ET
 */

import * as fs from "fs";
import * as path from "path";

const LOG_DIR = path.join(process.cwd(), "logs");
const TZ_ET = "America/New_York";

function dateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 单时刻：February 18, 1:35AM ET */
function formatEt(d: Date): string {
  const month = d.toLocaleString("en-US", { timeZone: TZ_ET, month: "long" });
  const day = d.toLocaleString("en-US", { timeZone: TZ_ET, day: "numeric" });
  const time = d
    .toLocaleString("en-US", { timeZone: TZ_ET, hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s+/g, "");
  return `${month} ${day}, ${time} ET`;
}

/** 5 分钟窗口：February 18, 1:35-1:40AM ET（endTime 为窗口结束时刻） */
export function formatEtWindow(endTimeIso: string): string {
  const end = new Date(endTimeIso);
  const start = new Date(end.getTime() - 5 * 60 * 1000);
  const month = end.toLocaleString("en-US", { timeZone: TZ_ET, month: "long" });
  const day = end.toLocaleString("en-US", { timeZone: TZ_ET, day: "numeric" });
  const startTime = start
    .toLocaleString("en-US", { timeZone: TZ_ET, hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s+/g, "");
  const endTime = end
    .toLocaleString("en-US", { timeZone: TZ_ET, hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s+/g, "");
  return `${month} ${day}, ${startTime}-${endTime} ET`;
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
    const ts = formatEt(new Date());
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
  const windowEt = formatEtWindow(endTime);
  logDaily(`ROUND_END slug=${slug} window=${windowEt} Up_bid=${upBid} Up_ask=${upAsk} Down_bid=${downBid} Down_ask=${downAsk}`);
}
