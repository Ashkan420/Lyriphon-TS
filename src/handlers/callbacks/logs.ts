import { Context } from "grammy";
import { formatLogsForTelegram } from "../../utils/logger";
import { safeAnswer } from "../../utils/telegram";

export async function handleLogsRefreshCallback(ctx: Context) {
  await safeAnswer(ctx);
  const text = formatLogsForTelegram();
  await ctx.editMessageText(text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Refresh", callback_data: "logs_refresh", style: "primary" as const }],
        [{ text: "Close", callback_data: "logs_close", style: "danger" as const }],
      ],
    },
  });
}

export async function handleLogsCloseCallback(ctx: Context) {
  await safeAnswer(ctx);
  await ctx.deleteMessage();
}