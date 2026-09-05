import { Context } from "grammy";
import { formatLogPage } from "../../utils/logger";
import { safeAnswer } from "../../utils/telegram";

type LogNavButton = {
  text: string;
  callback_data: string;
  style?: "primary" | "danger" | "success";
};

export function buildLogsNavRow(
  page: number,
  totalPages: number,
  prefix = "logs_page_",
): LogNavButton[][] {
  if (totalPages <= 1) {
    return [];
  }
  const row: LogNavButton[] = [];
  if (page > 0) {
    row.push({ text: "⬅️", callback_data: `${prefix}${page - 1}` });
  }
  row.push({ text: `${page + 1}/${totalPages}`, callback_data: `${prefix}${page}` });
  if (page < totalPages - 1) {
    row.push({ text: "➡️", callback_data: `${prefix}${page + 1}` });
  }
  return [row];
}

export function buildLogsKeyboard(page: number, totalPages: number): LogNavButton[][] {
  const rows: LogNavButton[][] = [];
  const nav = buildLogsNavRow(page, totalPages);
  if (nav.length) {
    rows.push(...nav);
  }
  rows.push([{ text: "Refresh", callback_data: `logs_page_${page}`, style: "primary" as const }]);
  rows.push([{ text: "Close", callback_data: "logs_close", style: "danger" as const }]);
  return rows;
}

export async function handleLogsPageCallback(ctx: Context) {
  await safeAnswer(ctx);
  const data = ctx.callbackQuery?.data ?? "";
  let page = 0;
  if (data.startsWith("logs_page_")) {
    const raw = data.slice("logs_page_".length);
    const n = Number(raw);
    if (!Number.isNaN(n)) {
      page = n;
    }
  } else if (data === "logs_refresh") {
    page = 0;
  }
  const pg = formatLogPage(page);
  try {
    await ctx.editMessageText(pg.text, {
      reply_markup: { inline_keyboard: buildLogsKeyboard(pg.page, pg.totalPages) },
    });
  } catch {
    // ignore "message is not modified" and edit races
  }
}

export async function handleLogsCloseCallback(ctx: Context) {
  await safeAnswer(ctx);
  await ctx.deleteMessage();
}
