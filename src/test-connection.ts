/**
 * 测试脚本：连接账号、查余额、查 open orders、尝试一笔极小限价单（不会成交）
 */
import "dotenv/config";
import { ClobClient, AssetType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { getBtc5MinMarkets, normalizeMarket } from "./api/gamma.js";
import { CHAIN_ID, CLOB_HOST, loadConfig } from "./config/index.js";

async function main() {
  const config = loadConfig();
  console.log("=== Polymarket 连接测试 ===\n");

  if (!config.privateKey) {
    console.error("PRIVATE_KEY 未设置");
    process.exit(1);
  }

  const pk = config.privateKey.startsWith("0x") ? config.privateKey : "0x" + config.privateKey;
  const signer = new Wallet(pk);
  console.log("钱包地址:", signer.address);
  console.log("Funder 地址:", config.funderAddress || "(未设置)");
  console.log();

  // 1. 连接 CLOB，derive API key
  console.log("1. 连接 CLOB 并获取 API key...");
  const baseClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  let apiCreds;
  try {
    apiCreds = await baseClient.deriveApiKey(0);
    console.log("   API key 获取成功 ✓");
  } catch {
    try {
      apiCreds = await baseClient.createApiKey(0);
      console.log("   API key 创建成功 ✓");
    } catch (e: any) {
      console.error("   API key 失败 ✗:", e?.message || e);
      process.exit(1);
    }
  }

  const client = new ClobClient(
    CLOB_HOST, CHAIN_ID, signer, apiCreds,
    config.signatureType, config.funderAddress
  );

  // 2. 查 USDC 余额
  console.log("\n2. 查询 USDC 余额...");
  try {
    const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log(`   USDC 余额: $${bal.balance}`);
    console.log(`   USDC 授权额度: $${bal.allowance}`);
  } catch (e: any) {
    console.error("   查余额失败:", e?.message || e);
  }

  // 3. 查 open orders
  console.log("\n3. 查询当前挂单...");
  try {
    const orders = await client.getOpenOrders();
    const list = Array.isArray(orders) ? orders : (orders as any)?.data ?? [];
    console.log(`   当前挂单数: ${list.length}`);
    if (list.length > 0) {
      for (const o of list.slice(0, 3)) {
        console.log(`   - ${o.side} ${o.size} @ ${o.price} | ${o.asset_id?.slice(0, 20)}...`);
      }
      if (list.length > 3) console.log(`   ... 还有 ${list.length - 3} 笔`);
    }
  } catch (e: any) {
    console.error("   查挂单失败:", e?.message || e);
  }

  // 4. 拉取 BTC 5min 市场来测试
  console.log("\n4. 拉取 BTC 5min 市场...");
  let testMarket: any = null;
  try {
    const result = await getBtc5MinMarkets();
    const markets = result.inWindow.length > 0 ? result.inWindow : result.allMarkets;
    console.log(`   找到 ${markets.length} 个市场 (inWindow=${result.inWindow.length}, upcoming=${result.upcoming.length}, total=${result.allMarkets.length})`);
    if (markets.length > 0) {
      testMarket = markets[0];
      console.log(`   测试市场: ${testMarket.question?.slice(0, 60)}`);
      console.log(`   Slug: ${testMarket.slug}`);
      console.log(`   tokens 数量: ${testMarket.tokens?.length ?? 0}`);
      if (testMarket.tokens?.length) {
        for (const t of testMarket.tokens) {
          console.log(`   token: outcome="${t.outcome}" id=${t.token_id?.slice(0, 30)}...`);
        }
      }
      console.log(`   clobTokenIds (raw): ${String(testMarket.clobTokenIds)?.slice(0, 80)}`);
      console.log(`   outcomes (raw): ${String(testMarket.outcomes)?.slice(0, 80)}`);
      const yesToken = testMarket.tokens?.find((t: any) => t.outcome === "Yes");
      const noToken = testMarket.tokens?.find((t: any) => t.outcome === "No");
      console.log(`   YES token: ${yesToken?.token_id?.slice(0, 30) ?? "未找到"}`);
      console.log(`   NO  token: ${noToken?.token_id?.slice(0, 30) ?? "未找到"}`);
      // 如果 Yes/No 没有，试 Up/Down
      const upToken = testMarket.tokens?.find((t: any) => /yes|up/i.test(t.outcome));
      const downToken = testMarket.tokens?.find((t: any) => /no|down/i.test(t.outcome));
      console.log(`   Up/Yes token: ${upToken?.token_id?.slice(0, 30) ?? "未找到"}`);
      console.log(`   Down/No token: ${downToken?.token_id?.slice(0, 30) ?? "未找到"}`);

      // 查订单簿
      const activeToken = upToken || yesToken;
      if (activeToken?.token_id) {
        console.log("\n5. 查询订单簿...");
        const book = await client.getOrderBook(activeToken.token_id);
        const bestBid = book?.bids?.[0];
        const bestAsk = book?.asks?.[0];
        console.log(`   YES 买一: ${bestBid ? `${bestBid.price} x ${bestBid.size}` : "无"}`);
        console.log(`   YES 卖一: ${bestAsk ? `${bestAsk.price} x ${bestAsk.size}` : "无"}`);

        // 6. 尝试下一笔极低价买单（0.01 x 5），基本不会成交，立即取消
        console.log("\n6. 测试下单（极低价 $0.01 x 5 shares Up，会立刻取消）...");
        try {
          const { OrderType, Side } = await import("@polymarket/clob-client");
          const result = await client.createAndPostOrder(
            {
              tokenID: activeToken.token_id,
              price: 0.01,
              size: 5,
              side: Side.BUY,
            },
            { tickSize: "0.01", negRisk: !!testMarket.negRisk },
            OrderType.GTC
          );
          console.log("   下单结果:", JSON.stringify(result, null, 2));
          
          // 立刻取消
          if (result?.orderID || result?.orderId) {
            const oid = result.orderID || result.orderId;
            console.log("   取消订单:", oid);
            const cancelRes = await client.cancelOrder({ id: oid } as any);
            console.log("   取消结果:", JSON.stringify(cancelRes));
          }
        } catch (e: any) {
          console.error("   下单测试失败:", e?.message || e);
        }
      }
    }
  } catch (e: any) {
    console.error("   拉取市场失败:", e?.message || e);
  }

  console.log("\n=== 测试完成 ===");
}

main().catch(console.error);
