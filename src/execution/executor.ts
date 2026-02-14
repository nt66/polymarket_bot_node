/**
 * 执行层：将策略信号转为 Polymarket 下单
 */

import type { PolymarketClient } from "../api/clob.js";
import type { ArbSignal } from "../strategies/types.js";

export interface ExecutionResult {
  ok: boolean;
  orderIds: string[];
  error?: string;
}

export async function executeSignal(
  client: PolymarketClient | null,
  signal: ArbSignal,
  tickSize: string,
  negRisk: boolean
): Promise<ExecutionResult> {
  if (!client) {
    return { ok: false, orderIds: [], error: "No Polymarket client" };
  }

  const options = { tickSize, negRisk };

  const toResult = (res: { success: boolean; orderId?: string; errorMsg?: string }): ExecutionResult => ({
    ok: res.success === true,  // 严格判断
    orderIds: res.orderId ? [res.orderId] : [],
    error: res.errorMsg,
  });

  if (signal.type === "latency") {
    const res = await client.createAndPostOrder(
      { tokenID: signal.tokenId, price: signal.price, size: signal.size, side: "BUY" },
      options,
      "GTC"
    );
    return toResult(res);
  }

  if (signal.type === "neg_risk") {
    const [yesRes, noRes] = await Promise.all([
      client.createAndPostOrder(
        { tokenID: signal.yesTokenId, price: signal.askYes, size: signal.size, side: "BUY" },
        options,
        "GTC"
      ),
      client.createAndPostOrder(
        { tokenID: signal.noTokenId, price: signal.askNo, size: signal.size, side: "BUY" },
        options,
        "GTC"
      ),
    ]);
    const orderIds: string[] = [];
    if (yesRes.orderId) orderIds.push(yesRes.orderId);
    if (noRes.orderId) orderIds.push(noRes.orderId);
    const ok = yesRes.success === true && noRes.success === true;
    return {
      ok,
      orderIds,
      error: !ok ? [yesRes.errorMsg, noRes.errorMsg].filter(Boolean).join("; ") : undefined,
    };
  }

  if (signal.type === "ev_arb") {
    const res = await client.createAndPostOrder(
      { tokenID: signal.tokenId, price: signal.price, size: signal.size, side: signal.side },
      options,
      "GTC"
    );
    return toResult(res);
  }

  if (signal.type === "stop_loss") {
    const res = await client.createAndPostOrder(
      { tokenID: signal.tokenId, price: signal.price, size: signal.size, side: "SELL" },
      options,
      "GTC"
    );
    return toResult(res);
  }

  return { ok: false, orderIds: [], error: "Unknown signal type" };
}
