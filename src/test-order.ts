import "dotenv/config";
import { ClobClient, AssetType, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { getBtc15MinMarkets } from "./api/gamma.js";
import { loadConfig } from "./config/index.js";

async function main() {
  const config = loadConfig();
  const pk = config.privateKey.startsWith("0x") ? config.privateKey : "0x" + config.privateKey;
  const signer = new Wallet(pk);

  const baseClient = new ClobClient("https://clob.polymarket.com", 137, signer);
  const creds = await baseClient.deriveApiKey(0);
  const client = new ClobClient(
    "https://clob.polymarket.com", 137, signer, creds,
    config.signatureType, config.funderAddress
  );

  // 1. 拿到市场
  const result = await getBtc15MinMarkets(config.btc15MinTagId || undefined, config.btc15MinSlug || undefined);
  const markets = result.inWindow.length > 0 ? result.inWindow : result.allMarkets;
  if (!markets.length) { console.log("无市场"); return; }
  const m = markets[0];
  const token = m.tokens?.[0]; // Up token
  if (!token) { console.log("无 token"); return; }

  console.log("市场:", m.question);
  console.log("negRisk:", m.negRisk, "| typeof:", typeof m.negRisk);
  console.log("Token:", token.outcome, token.token_id.slice(0, 30) + "...");

  // 2. 查 tick size 和 negRisk from CLOB
  try {
    const tickSize = await client.getTickSize(token.token_id);
    const negRisk = await client.getNegRisk(token.token_id);
    console.log("CLOB tickSize:", tickSize, "| negRisk:", negRisk);
  } catch (e: any) {
    console.log("CLOB 查询失败:", e.message);
  }

  // 3. 尝试下单 - negRisk = true
  console.log("\n--- 尝试1: negRisk=true ---");
  try {
    const res = await client.createAndPostOrder(
      { tokenID: token.token_id, price: 0.01, size: 5, side: Side.BUY },
      { tickSize: "0.01", negRisk: true },
      OrderType.GTC
    );
    console.log("结果:", JSON.stringify(res));
    // 取消
    if (res?.orderID) {
      await client.cancelOrder({ id: res.orderID } as any);
      console.log("已取消");
    }
  } catch (e: any) {
    console.log("失败:", e.message?.slice(0, 200));
  }

  // 4. 尝试下单 - negRisk = false
  console.log("\n--- 尝试2: negRisk=false ---");
  try {
    const res = await client.createAndPostOrder(
      { tokenID: token.token_id, price: 0.01, size: 5, side: Side.BUY },
      { tickSize: "0.01", negRisk: false },
      OrderType.GTC
    );
    console.log("结果:", JSON.stringify(res));
    if (res?.orderID) {
      await client.cancelOrder({ id: res.orderID } as any);
      console.log("已取消");
    }
  } catch (e: any) {
    console.log("失败:", e.message?.slice(0, 200));
  }
}

main().catch(console.error);
