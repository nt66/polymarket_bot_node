import "dotenv/config";
import { ClobClient, AssetType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

async function main() {
  const pk = process.env.PRIVATE_KEY!;
  const funder = process.env.POLYMARKET_FUNDER_ADDRESS!;
  const signer = new Wallet(pk.startsWith("0x") ? pk : "0x" + pk);

  console.log("Signer 地址 (私钥对应):", signer.address);
  console.log("Funder 地址 (.env 设置):", funder);
  console.log();

  const client = new ClobClient("https://clob.polymarket.com", 137, signer);
  const creds = await client.deriveApiKey(0);

  // Signature Type 2 (Gnosis Safe / Browser Wallet)
  console.log("=== Signature Type 2 (Gnosis Safe) ===");
  try {
    const c2 = new ClobClient("https://clob.polymarket.com", 137, signer, creds, 2, funder);
    const bal2 = await c2.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log("  USDC 余额:", bal2.balance, "| 授权:", bal2.allowance);
  } catch (e: any) {
    console.log("  查询失败:", e.message);
  }

  // Signature Type 1 (Magic/Email)
  console.log("=== Signature Type 1 (Magic/Email) ===");
  try {
    const c1 = new ClobClient("https://clob.polymarket.com", 137, signer, creds, 1, funder);
    const bal1 = await c1.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log("  USDC 余额:", bal1.balance, "| 授权:", bal1.allowance);
  } catch (e: any) {
    console.log("  查询失败:", e.message);
  }

  // Signature Type 0 (EOA, funder = signer address)
  console.log("=== Signature Type 0 (EOA, funder=signer) ===");
  try {
    const c0 = new ClobClient("https://clob.polymarket.com", 137, signer, creds, 0, signer.address);
    const bal0 = await c0.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log("  USDC 余额:", bal0.balance, "| 授权:", bal0.allowance);
  } catch (e: any) {
    console.log("  查询失败:", e.message);
  }
}

main().catch(console.error);
