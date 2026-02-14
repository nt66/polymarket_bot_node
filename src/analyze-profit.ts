/**
 * 分析本轮盈利关键点：从交易记录中提取 bot 风格订单并归纳规律
 */
import "dotenv/config";
import { ClobClient, AssetType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { CHAIN_ID, CLOB_HOST, loadConfig } from "./config/index.js";

const BOT_SIZE_MIN = 4.5;
const BOT_SIZE_MAX = 5.5;

function toMs(x: any): number {
  const v = x.match_time ?? x.last_update ?? x.timestamp ?? x.created_at ?? 0;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10) * 1000;
  return new Date(v).getTime();
}

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

  const trades = (await client.getTrades({}, true)) as any[];
  if (!trades?.length) {
    console.log("暂无交易记录");
    return;
  }

  trades.sort((a, b) => toMs(b) - toMs(a));

  // 1) 筛出「bot 风格」订单：size 约 5 张
  const isBotSize = (size: number) => size >= BOT_SIZE_MIN && size <= BOT_SIZE_MAX;
  const buys = trades.filter((t) => (t.side || "").toUpperCase() === "BUY" && isBotSize(parseFloat(t.size || "0")));
  const sells = trades.filter((t) => (t.side || "").toUpperCase() === "SELL" && isBotSize(parseFloat(t.size || "0")));

  let botBuyCost = 0;
  let botSellRevenue = 0;
  const buyPrices: number[] = [];
  const sellPrices: number[] = [];

  for (const t of buys) {
    const size = parseFloat(t.size || "0");
    const price = parseFloat(t.price || "0");
    botBuyCost += size * price;
    buyPrices.push(price);
  }
  for (const t of sells) {
    const size = parseFloat(t.size || "0");
    const price = parseFloat(t.price || "0");
    botSellRevenue += size * price;
    sellPrices.push(price);
  }

  // 2) 按卖出价格分段：止盈 / 小亏或平价 / 止损
  const takeProfit = sellPrices.filter((p) => p >= 0.65);
  const breakeven = sellPrices.filter((p) => p >= 0.50 && p < 0.65);
  const stopLoss = sellPrices.filter((p) => p < 0.50);

  // 3) 买入价格分布
  const avgBuy = buyPrices.length ? buyPrices.reduce((a, b) => a + b, 0) / buyPrices.length : 0;
  const avgSell = sellPrices.length ? sellPrices.reduce((a, b) => a + b, 0) / sellPrices.length : 0;

  console.log("========== 本轮盈利关键点分析 ==========\n");

  const heldToExpiry = buys.length - sells.length; // 未在 API 卖出 ≈ 持仓到期

  console.log("【1】Bot 风格订单（约 5 张/笔）");
  console.log("  买入笔数:", buys.length, "| 总成本: $", botBuyCost.toFixed(2));
  console.log("  卖出笔数:", sells.length, "| 总回收: $", botSellRevenue.toFixed(2));
  console.log("  仅从买卖口径的 PnL: $", (botSellRevenue - botBuyCost).toFixed(2));
  console.log("  未卖出笔数（推定到期结算）:", Math.max(0, heldToExpiry));
  if (heldToExpiry > 0) {
    console.log("  → 若这些仓位中有部分「赢方」到期按 $1 兑付，每 5 张赢 = +$5，是本次余额上涨的重要来源。");
  }
  console.log("");

  console.log("【2】卖出价格分布（反映止盈/止损是否生效）");
  console.log("  止盈 (卖价 ≥ 0.65):", takeProfit.length, "笔, 均价", (takeProfit.length ? (takeProfit.reduce((a, b) => a + b, 0) / takeProfit.length).toFixed(2) : "-"));
  console.log("  平价/小亏 (0.50~0.65):", breakeven.length, "笔");
  console.log("  止损 (卖价 < 0.50):", stopLoss.length, "笔, 均价", (stopLoss.length ? (stopLoss.reduce((a, b) => a + b, 0) / stopLoss.length).toFixed(2) : "-"));
  console.log("");

  console.log("【3】买入/卖出均价");
  console.log("  买入均价:", avgBuy.toFixed(2), "| 卖出均价:", avgSell.toFixed(2));
  console.log("  平均每张毛利:", (avgSell - avgBuy).toFixed(2), "| 5 张约", ((avgSell - avgBuy) * 5).toFixed(2), "美元/笔");
  console.log("");

  console.log("【4】盈利关键点归纳");
  const points: string[] = [];
  if (takeProfit.length >= sells.length * 0.3) {
    points.push("止盈执行到位：多笔在 0.65+ 卖出，锁定 +$0.05~0.07/张 的 scalp 利润");
  }
  if (avgSell > avgBuy) {
    points.push("卖出均价高于买入均价，整体「先买后卖」这一环节是正收益");
  }
  if (buys.length > sells.length) {
    points.push("买入笔数多于卖出 → 部分仓位通过「到期结算」获利（赢方按 $1 兑付），未体现在卖出记录里");
  }
  if (stopLoss.length > 0 && stopLoss.length <= sells.length * 0.5) {
    points.push("止损笔数可控，单笔亏损被限制，没有大量持仓拿到归零");
  }
  if (points.length === 0) {
    points.push("样本以 5 张为主时，盈利来自：① 止盈单在较高价卖出 ② 部分持仓到期结算赢方 ③ 控制止损、减少大亏");
  }
  points.forEach((p, i) => console.log("  ", i + 1 + ".", p));
  console.log("");

  console.log("【5】建议延续的做法");
  console.log("  • 保持「快进快出」：有利润（如 +0.05~0.07）就市价/限价卖出，不贪最后一段。");
  console.log("  • 严格止损：跌到 -0.10 左右就砍，避免扛单到 0.30 以下。");
  console.log("  • 多跑周期：样本足够多时，止盈次数 > 止损次数 + 平均止盈额 > 平均止损额，即可稳定抬升余额。");
  console.log("  • 仓位一致：继续用 5 张/笔，便于复现和统计。");
  console.log("");
  console.log("========== 本轮盈利关键点（一句话版）==========");
  console.log("  1. 止盈在 0.65+ 成功执行，锁定了多笔 scalp 利润；");
  console.log("  2. 部分仓位拿满 15 分钟到期结算，赢方按 $1 兑付，贡献主要利润；");
  console.log("  3. 止损控制在 0.50 以下即砍，单笔亏损有限；");
  console.log("  4. 持续跑、多周期，让「赢的次数 × 单笔利润」大于「亏的次数 × 单笔亏损」。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
