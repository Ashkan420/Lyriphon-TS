import { Context } from "grammy";
import { Env } from "../env";
import { SessionDO } from "../do";
import { SessionData } from "../session/types";
import { formatLogsForTelegram } from "../utils/logger";
import { safeAnswer } from "../utils/telegram";

// Telegram button `style` is newer than some @grammyjs/types pins; match
// the loose shape used by /logs and edit menus.
type AdminButton = {
  text: string;
  callback_data: string;
  style?: "success" | "danger" | "primary";
};

export function isBotOwner(ctx: Context, env: Env): boolean {
  if (!env.BOT_OWNER_ID) {
    return true;
  }
  return String(ctx.from?.id) === env.BOT_OWNER_ID;
}

export function adminSettingsText(debugOn: boolean, multilingualOn: boolean): string {
  return [
    "⚙️ <b>Admin settings</b>",
    "",
    `Debug: <b>${debugOn ? "on" : "off"}</b>`,
    `Multilingual: <b>${multilingualOn ? "on" : "off"}</b>`,
    "",
    "Tap a toggle to switch it. Logs is available while debug is on.",
  ].join("\n");
}

export function buildAdminKeyboard(
  debugOn: boolean,
  multilingualOn: boolean,
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
): Promise<void> {
  const debugOn = sessionDo.debugEnabled;
  const multiOn = multilingualEnabled(session);
  try {
    await ctx.editMessageText(adminSettingsText(debugOn, multiOn), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildAdminKeyboard(debugOn, multiOn) },
    });
  } catch {
    // Ignore "message is not modified" and similar edit races.
  }
}

async function renderAdminLogs(ctx: Context): Promise<void> {
  const text = formatLogsForTelegram();
  try {
    await ctx.editMessageText(text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Refresh", callback_data: "admin_logs_refresh" }],
          [{ text: "⬅️ Back", callback_data: "admin_back" }],
        ],
      },
    });
  } catch {
    // ignore
  }
}

export async function adminCommand(
  ctx: Context,
  session: SessionData,
  sessionDo: SessionDO,
): Promise<void> {
  const debugOn = sessionDo.debugEnabled;
  const multiOn = multilingualEnabled(session);
  await ctx.reply(adminSettingsText(debugOn, multiOn), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buildAdminKeyboard(debugOn, multiOn) },
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
    await renderAdminSettings(ctx, session, sessionDo);
    return;
  }

  if (data === "admin_toggle_multilingual") {
    session.telegraph.multilingualEnabled = !multilingualEnabled(session);
    await renderAdminSettings(ctx, session, sessionDo);
    return;
  }

  if (data === "admin_logs" || data === "admin_logs_refresh") {
    if (!sessionDo.debugEnabled) {
      // Debug was turned off elsewhere — bounce back to settings.
      await renderAdminSettings(ctx, session, sessionDo);
      return;
    }
    await renderAdminLogs(ctx);
    return;
  }

  if (data === "admin_back") {
    await renderAdminSettings(ctx, session, sessionDo);
  }
}
