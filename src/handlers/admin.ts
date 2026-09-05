import { Context } from "grammy";
import { Env } from "../env";
import { SessionDO } from "../do";
import { SessionData } from "../session/types";
import { formatLogPage, warn } from "../utils/logger";
import { safeAnswer } from "../utils/telegram";
import { isAutoFetchEnabled, setAutoFetchEnabled } from "../db/settings";
import { buildLogsNavRow } from "./callbacks/logs";

// Telegram button `style` is newer than some @grammyjs/types pins; match
// the loose shape used by /logs and edit menus.
type AdminButton = {
  text: string;
  callback_data: string;
  style?: "success" | "danger" | "primary";
};

let warnedMissingOwner = false;

export function isBotOwner(ctx: Context, env: Env): boolean {
  if (!env.BOT_OWNER_ID) {
    if (!warnedMissingOwner) {
      warn("BOT_OWNER_ID is not set — owner commands are disabled for everyone.");
      warnedMissingOwner = true;
    }
    return false;
  }
  return String(ctx.from?.id) === env.BOT_OWNER_ID;
}

export function adminSettingsText(debugOn: boolean, multilingualOn: boolean, autofetchOn: boolean): string {
  return [
    "⚙️ <b>Admin settings</b>",
    "",
    `Debug: <b>${debugOn ? "on" : "off"}</b>`,
    `Multilingual: <b>${multilingualOn ? "on" : "off"}</b>`,
    `Auto-fetch: <b>${autofetchOn ? "on" : "off"}</b>`,
    "",
    "Tap a toggle to switch it. Logs is available while debug is on.",
  ].join("\n");
}

export function buildAdminKeyboard(
  debugOn: boolean,
  multilingualOn: boolean,
  autofetchOn: boolean,
): AdminButton[][] {
  const rows: AdminButton[][] = [
    [
      {
        text: debugOn ? "🐛 Debugging: ON" : "🐛 Debugging: OFF",
        callback_data: "admin_toggle_debug",
        style: debugOn ? "success" : "danger",
      },
    ],
    [
      {
        text: multilingualOn ? "🌐 Multilingual: ON" : "🌐 Multilingual: OFF",
        callback_data: "admin_toggle_multilingual",
        style: multilingualOn ? "success" : "danger",
      },
    ],
    [
      {
        text: autofetchOn ? "🎧 Auto-fetch: ON" : "🎧 Auto-fetch: OFF",
        callback_data: "admin_toggle_autofetch",
        style: autofetchOn ? "success" : "danger",
      },
    ],
  ];

  if (debugOn) {
    rows.push([{ text: "📋 Logs", callback_data: "admin_logs" }]);
  }

  return rows;
}

function multilingualEnabled(session: SessionData): boolean {
  return session.telegraph.multilingualEnabled ?? true;
}

async function renderAdminSettings(
  ctx: Context,
  session: SessionData,
  sessionDo: SessionDO,
  env: Env,
): Promise<void> {
  const debugOn = sessionDo.debugEnabled;
  const multiOn = multilingualEnabled(session);
  const autoOn = await readAutoFetchEnabled(env);
  try {
    await ctx.editMessageText(adminSettingsText(debugOn, multiOn, autoOn), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildAdminKeyboard(debugOn, multiOn, autoOn) },
    });
  } catch {
    // Ignore "message is not modified" and similar edit races.
  }
}

async function renderAdminLogs(ctx: Context, page = 0): Promise<void> {
  const pg = formatLogPage(page);
  const rows: AdminButton[][] = [];
  const nav = buildLogsNavRow(pg.page, pg.totalPages, "admin_logs_page_");
  if (nav.length) {
    rows.push(...(nav as AdminButton[][]));
  }
  rows.push([{ text: "Refresh", callback_data: `admin_logs_page_${pg.page}` }]);
  rows.push([{ text: "⬅️ Back", callback_data: "admin_back" }]);
  try {
    await ctx.editMessageText(pg.text, {
      reply_markup: { inline_keyboard: rows },
    });
  } catch {
    // ignore
  }
}

// D1 read failure degrades to OFF (fail closed) rather than crashing /admin.
async function readAutoFetchEnabled(env: Env): Promise<boolean> {
  try {
    return await isAutoFetchEnabled(env.DB);
  } catch (error) {
    warn("admin: failed to read autofetch setting", error);
    return false;
  }
}

export async function adminCommand(
  ctx: Context,
  session: SessionData,
  sessionDo: SessionDO,
  env: Env,
): Promise<void> {
  const debugOn = sessionDo.debugEnabled;
  const multiOn = multilingualEnabled(session);
  const autoOn = await readAutoFetchEnabled(env);
  await ctx.reply(adminSettingsText(debugOn, multiOn, autoOn), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buildAdminKeyboard(debugOn, multiOn, autoOn) },
  });
}

export async function handleAdminCallback(
  ctx: Context,
  session: SessionData,
  sessionDo: SessionDO,
  env: Env,
): Promise<void> {
  if (!isBotOwner(ctx, env)) {
    return;
  }

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("admin_")) {
    return;
  }

  await safeAnswer(ctx);

  if (data === "admin_toggle_debug") {
    await sessionDo.setDebugEnabled(!sessionDo.debugEnabled);
    await renderAdminSettings(ctx, session, sessionDo, env);
    return;
  }

  if (data === "admin_toggle_multilingual") {
    session.telegraph.multilingualEnabled = !multilingualEnabled(session);
    await renderAdminSettings(ctx, session, sessionDo, env);
    return;
  }

  if (data === "admin_toggle_autofetch") {
    if (!env.BRIDGE_CHAT_ID || !env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
      await safeAnswer(ctx, "Bridge is not configured (BRIDGE_CHAT_ID / TELEGRAM_API_ID / TELEGRAM_API_HASH).");
      return;
    }
    try {
      const current = await isAutoFetchEnabled(env.DB);
      await setAutoFetchEnabled(env.DB, !current);
    } catch (error) {
      warn("admin: failed to toggle autofetch", error);
      await safeAnswer(ctx, "❌ Couldn't update the setting (database error).");
      return;
    }
    await renderAdminSettings(ctx, session, sessionDo, env);
    return;
  }

  if (data.startsWith("admin_logs_page_")) {
    if (!sessionDo.debugEnabled) {
      await renderAdminSettings(ctx, session, sessionDo, env);
      return;
    }
    const raw = data.slice("admin_logs_page_".length);
    const n = Number(raw);
    await renderAdminLogs(ctx, Number.isNaN(n) ? 0 : n);
    return;
  }

  if (data === "admin_logs" || data === "admin_logs_refresh") {
    if (!sessionDo.debugEnabled) {
      // Debug was turned off elsewhere — bounce back to settings.
      await renderAdminSettings(ctx, session, sessionDo, env);
      return;
    }
    await renderAdminLogs(ctx, 0);
    return;
  }

  if (data === "admin_back") {
    await renderAdminSettings(ctx, session, sessionDo, env);
  }
}
