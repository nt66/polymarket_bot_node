/**
 * 拉取账户交易记录（用于核对余额变化与 PnL）
 */
import "dotenv/config";
import { ClobClient, AssetType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { CHAIN_ID, CLOB_HOST, loadConfig } from "./config/index.js";

async function main() {
  const config = loadConfig();
  if (!config.privateKey || !config.funderAddress) {
    console.error("需要 PRIVATE_KEY 和 POLYMARKET_FUNDER_ADDRESS");
    process.exit(1);
  }

  const pk = config.privateKey.startsWith("0x") ? config.privateKey : "0x" + config.privateKey;
  const signer = new Wallet(pk);
  const baseClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  let apiCreds;
  try {
    apiCreds = await baseClient.deriveApiKey(0);
  } catch {
    apiCreds = await baseClient.createApiKey(0);
  }

  const client = new ClobClient(
    CLOB_HOST, CHAIN_ID, signer, apiCreds,
    config.signatureType, config.funderAddress
  );

  // 当前余额
  const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const balanceUsd = (Number(bal.balance) / 1e6).toFixed(2);
  console.log("=== 交易记录与余额 ===\n");
  console.log("当前 USDC 余额: $", balanceUsd);
  console.log("");

  // 拉取交易（默认返回当前账号的 trades）
  const trades = await client.getTrades({}, true) as any[];
  if (!trades || trades.length === 0) {
    console.log("暂无交易记录（或 API 未返回本账号记录）");
    return;
  }

  // API 返回的时间是秒（Unix timestamp），可能是 number 或 string
  const toMs = (x: any): number => {
    const v = x.match_time ?? x.last_update ?? x.timestamp ?? x.created_at ?? 0;
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
    if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10) * 1000;
    return new Date(v).getTime();
  };

  // 按时间倒序（最新的在前）
  trades.sort((a, b) => toMs(b) - toMs(a));

  const newestMs = toMs(trades[0]);
  const oldestMs = toMs(trades[trades.length - 1]);
  console.log("记录时间范围:", new Date(oldestMs).toLocaleString("zh-CN"), "~", new Date(newestMs).toLocaleString("zh-CN"));
  console.log(`共 ${trades.length} 笔成交，最近 50 笔：\n`);
  let totalBuyUsd = 0;
  let totalSellUsd = 0;

  for (const t of trades.slice(0, 50)) {
    const timeMs = toMs(t);
    const side = (t.side || "").toUpperCase();
    const size = parseFloat(t.size || "0");
    const price = parseFloat(t.price || "0");
    const notional = size * price;
    const market = (t.market || "").slice(0, 12);
    const outcome = t.outcome || "";

    if (side === "BUY") totalBuyUsd += notional;
    else totalSellUsd += notional;

    const date = Number.isFinite(timeMs) ? new Date(timeMs).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" }) : "";
    console.log(`${date} | ${side.padEnd(4)} | ${size} @ ${price.toFixed(2)} = $${notional.toFixed(2)} | ${market}... ${outcome}`);
  }

  for (const t of trades.slice(50)) {
    const side = (t.side || "").toUpperCase();
    const size = parseFloat(t.size || "0");
    const price = parseFloat(t.price || "0");
    const notional = size * price;
    if (side === "BUY") totalBuyUsd += notional;
    else totalSellUsd += notional;
  }

  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const twoDayMs = 2 * oneDayMs;
  let buy24h = 0, sell24h = 0, count24h = 0;
  let buy48h = 0, sell48h = 0, count48h = 0;
  for (const t of trades) {
    const timeMs = toMs(t);
    if (!Number.isFinite(timeMs)) continue;
    const age = now - timeMs;
    const side = (t.side || "").toUpperCase();
    const notional = parseFloat(t.size || "0") * parseFloat(t.price || "0");
    if (age <= oneDayMs) {
      count24h++;
      if (side === "BUY") buy24h += notional;
      else sell24h += notional;
    }
    if (age <= twoDayMs) {
      count48h++;
      if (side === "BUY") buy48h += notional;
      else sell48h += notional;
    }
  }

  console.log("\n--- 汇总（全部 " + trades.length + " 笔）---");
  console.log("买入合计(约): $", totalBuyUsd.toFixed(2));
  console.log("卖出合计(约): $", totalSellUsd.toFixed(2));
  console.log("净流出(买入-卖出): $", (totalBuyUsd - totalSellUsd).toFixed(2));
  console.log("\n--- 最近 24 小时内 " + count24h + " 笔 ---");
  console.log("买入: $", buy24h.toFixed(2), "| 卖出: $", sell24h.toFixed(2), "| 净流入: $", (sell24h - buy24h).toFixed(2));
  console.log("\n--- 最近 48 小时内 " + count48h + " 笔 ---");
  console.log("买入: $", buy48h.toFixed(2), "| 卖出: $", sell48h.toFixed(2), "| 净流入: $", (sell48h - buy48h).toFixed(2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
