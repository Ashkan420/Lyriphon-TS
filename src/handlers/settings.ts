// User-facing /settings panel. Plain language for average users; same
// green/red `style` toggle buttons as the admin panel.
//
// Auto-fetch semantics: effective = admin global switch AND user pref.
// The user toggle is opt-out (defaults on). When the admin switch is off,
// the feature is down for everyone — /settings says so and the button
// does nothing beyond an alert.

import { Context } from "grammy";
import { Env } from "../env";
import {
  isAutoFetchEnabled,
  isUserAutoFetchEnabled,
  getUserLinkPreviewEnabled,
  isUserRichButtonEnabled,
  setUserAutoFetchEnabled,
  setUserLinkPreviewEnabled,
  setUserRichButtonEnabled,
} from "../db/settings";
import { safeAnswer } from "../utils/telegram";
import { warn } from "../utils/logger";

// Telegram button `style` is newer than some @grammyjs/types pins; same
// loose shape as the admin panel.
type SettingsButton = {
  text: string;
  callback_data: string;
  style?: "success" | "danger" | "primary";
};

export function buildSettingsText(
  autoFetchOn: boolean,
  globalDisabled: boolean,
  previewsOn: boolean,
  richButtonOn: boolean,
): string {
  const lines = [
    "⚙️ <b>Your settings</b>",
    "",
    autoFetchOn
      ? "🎧 Auto-get music files: <b>on</b> — when you pick a song, I fetch the audio for you automatically."
      : "🎧 Auto-get music files: <b>off</b> — you'll get the download link instead, so you can grab the file yourself.",
    "",
    previewsOn
      ? "🔗 Link previews: <b>on</b> — I show a preview card when I post a lyrics page link."
      : "🔗 Link previews: <b>off</b> — lyrics page links are posted without a preview card.",
    "",
    richButtonOn
      ? "🧪 Fancy lyrics buttons: <b>on</b> — lyrics page links get a big styled button. Experimental: only the newest Telegram apps show it."
      : "🧪 Fancy lyrics buttons: <b>off</b> — lyrics page links use regular buttons that work everywhere.",
  ];

  if (globalDisabled) {
    lines.push(
      "",
      "⚠️ Auto-get is temporarily unavailable — it's turned off for everyone right now. Check back later.",
    );
  }

  lines.push("", "Tap a toggle to switch it.");
  return lines.join("\n");
}

export function buildSettingsKeyboard(
  autoFetchOn: boolean,
  globalDisabled: boolean,
  previewsOn: boolean,
  richButtonOn: boolean,
): SettingsButton[][] {
  const rows: SettingsButton[][] = [
    [
      {
        text: autoFetchOn ? "🎧 Auto-get music files: ON" : "🎧 Auto-get music files: OFF",
        callback_data: "settings_toggle_autofetch",
        style: autoFetchOn ? "success" : "danger",
      },
    ],
    [
      {
        text: previewsOn ? "🔗 Link previews: ON" : "🔗 Link previews: OFF",
        callback_data: "settings_toggle_preview",
        style: previewsOn ? "success" : "danger",
      },
    ],
    [
      {
        text: richButtonOn ? "🧪 Fancy lyrics buttons: ON" : "🧪 Fancy lyrics buttons: OFF",
        callback_data: "settings_toggle_rich_button",
        style: richButtonOn ? "success" : "danger",
      },
    ],
  ];
  void globalDisabled; // keyboard is the same either way; text carries the notice
  return rows;
}

async function readPrefs(env: Env, userId: string) {
  const [globalOn, userAuto, previews, richButton] = await Promise.all([
    isAutoFetchEnabled(env.DB).catch(() => false),
    isUserAutoFetchEnabled(env.DB, userId),
    getUserLinkPreviewEnabled(env.DB, userId),
    isUserRichButtonEnabled(env.DB, userId),
  ]);
  return { autoFetchOn: globalOn && userAuto, globalDisabled: !globalOn, previewsOn: previews, richButtonOn: richButton };
}

export async function handleSettingsCommand(ctx: Context, env: Env): Promise<void> {
  const userId = String(ctx.from?.id ?? "");
  if (!userId) return;
  try {
    const prefs = await readPrefs(env, userId);
    await ctx.reply(buildSettingsText(prefs.autoFetchOn, prefs.globalDisabled, prefs.previewsOn, prefs.richButtonOn), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildSettingsKeyboard(prefs.autoFetchOn, prefs.globalDisabled, prefs.previewsOn, prefs.richButtonOn) as any },
    });
  } catch (error) {
    warn("settings: command failed", error);
    await ctx.reply("❌ Couldn't load your settings. Try again later.");
  }
}

export async function handleSettingsCallback(ctx: Context, env: Env): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const userId = String(ctx.from?.id ?? "");
  if (!userId) return;

  try {
    if (data === "settings_toggle_autofetch") {
      const prefs = await readPrefs(env, userId);
      if (prefs.globalDisabled) {
        // Feature is down for everyone — the button does nothing.
        await safeAnswer(ctx, "Auto-get is temporarily unavailable.");
        return;
      }
      await setUserAutoFetchEnabled(env.DB, userId, !prefs.autoFetchOn);
    } else if (data === "settings_toggle_preview") {
      const previewsOn = await getUserLinkPreviewEnabled(env.DB, userId);
      await setUserLinkPreviewEnabled(env.DB, userId, !previewsOn);
    } else if (data === "settings_toggle_rich_button") {
      const richButtonOn = await isUserRichButtonEnabled(env.DB, userId);
      await setUserRichButtonEnabled(env.DB, userId, !richButtonOn);
    } else {
      return;
    }
  } catch (error) {
    warn("settings: toggle failed", error);
    await safeAnswer(ctx, "❌ Couldn't update the setting. Try again.");
    return;
  }

  await safeAnswer(ctx);

  // Re-render from fresh state.
  try {
    const prefs = await readPrefs(env, userId);
    await ctx.editMessageText(buildSettingsText(prefs.autoFetchOn, prefs.globalDisabled, prefs.previewsOn, prefs.richButtonOn), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildSettingsKeyboard(prefs.autoFetchOn, prefs.globalDisabled, prefs.previewsOn, prefs.richButtonOn) as any },
    });
  } catch {
    // Ignore "message is not modified" edit races.
  }
}
