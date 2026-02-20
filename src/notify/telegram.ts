/**
 * Telegram Bot 推送：盈亏通知
 * 使用 Bot API sendMessage，不阻塞主流程，失败只打日志
 */

const TG_API = "https://api.telegram.org/bot";

export async function sendTelegramMessage(
  text: string,
  botToken: string,
  chatId: string
): Promise<void> {
  if (!botToken || !chatId) return;
  try {
    const url = `${TG_API}${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[TG] sendMessage failed:", res.status, err);
    }
  } catch (e) {
    console.error("[TG] sendMessage error:", e instanceof Error ? e.message : e);
  }
}

/**
 * 发送止盈/止损通知
 */
export function notifyPnL(params: {
  botToken?: string;
  chatId?: string;
  slug: string;
  side: string;
  reason: "止盈" | "止损";
  pnlUsd: number;
  buyPrice: number;
  sellPrice: number;
  size: number;
  coin?: string;
}): void {
  const { botToken, chatId, slug, side, reason, pnlUsd, buyPrice, sellPrice, size, coin } = params;
  if (!botToken || !chatId) return;
  const emoji = reason === "止盈" ? "✅" : "❌";
  const shortSlug = slug.length > 35 ? slug.slice(0, 32) + "…" : slug;
  const coinStr = coin ? ` ${coin.toUpperCase()}` : "";
  const text = [
    `${emoji} Polymarket${coinStr} ${reason}`,
    `方向: ${side.toUpperCase()} | 数量: ${size}`,
    `买 @${buyPrice.toFixed(2)} → 卖 @${sellPrice.toFixed(2)}`,
    `盈亏: ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)}`,
    `市场: ${shortSlug}`,
  ].join("\n");
  sendTelegramMessage(text, botToken, chatId);
}
