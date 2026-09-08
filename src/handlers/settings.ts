// User-facing /settings panel. Plain language for average users; same
// green/red `style` toggle buttons as the admin panel.
//
// Auto-fetch semantics: effective = admin global switch AND user pref.
// The user toggle is opt-out (defaults on). When the admin switch is off,
// the feature is down for everyone — /settings says so and the button
// does nothing beyond an alert.
//
// Rich-style picker: session-free like the rest of /settings (handlers take
// (ctx, env)). Picker state lives in a per-user D1 KV blob — same pattern as
// the bridge's pending-send stash — so a refresh mid-picker just starts over.

import { Context } from "grammy";
import { Env } from "../env";
import {
  isAutoFetchEnabled,
  isUserAutoFetchEnabled,
  getUserLinkPreviewEnabled,
  setUserAutoFetchEnabled,
  setUserLinkPreviewEnabled,
  isUserRichDeliveryEnabled,
  setUserRichDeliveryEnabled,
  getUserRichStyle,
  setUserRichStyle,
  getSetting,
  setSetting,
} from "../db/settings";
import { safeAnswer, safeDelete, fetchCoverUrl, fetchAlbumDeezerUrl } from "../utils/telegram";
import {
  sendRichAudio,
  RICH_STYLES,
  RichStyleId,
} from "../utils/richMessages";
import { warn } from "../utils/logger";

// Telegram button `style` is newer than some @grammyjs/types pins; same
// loose shape as the admin panel.
type SettingsButton = {
  text: string;
  callback_data: string;
  style?: "success" | "danger" | "primary";
};

// Live-demo fixture for the rich-style picker: real data for "Hello — Adele"
// from .claude/database.sql (tracks row 138545995). file_id was delivered by
// the bridge and stays valid for this bot; the Telegraph page is an archived
// delivery link (a dead one only makes the demo button 404).
const RICH_DEMO = {
  trackId: 138545995,
  trackName: "Hello",
  artistName: "Adele",
  fileId: "CQACAgIAAxkBAAISRWqYpkdTufJ5erA7PptuS4SylxQYAAKpSAACO1zZS8Rhi3nS5y18PQQ",
  telegraphUrl: "https://telegra.ph/Hello-09-02-243",
} as const;

// Picker state KV: selector message id + last demo id, 15-min freshness.
type RichDemoState = { selMsgId: number; lastDemoMsgId?: number; ts: number };
const RICH_DEMO_PREFIX = "pref_richdemo:";
const RICH_DEMO_FRESH_MS = 15 * 60_000;

async function readDemoState(db: Env["DB"], userId: string): Promise<RichDemoState | null> {
  try {
    const raw = await getSetting(db, `${RICH_DEMO_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RichDemoState;
    if (!parsed.selMsgId || Date.now() - parsed.ts > RICH_DEMO_FRESH_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDemoState(db: Env["DB"], userId: string, state: RichDemoState): Promise<void> {
  try {
    await setSetting(db, `${RICH_DEMO_PREFIX}${userId}`, JSON.stringify(state));
  } catch (error) {
    warn("settings: failed to persist demo state", error);
  }
}

export function buildSettingsText(
  autoFetchOn: boolean,
  globalDisabled: boolean,
  previewsOn: boolean,
  richOn: boolean,
): string {
  const lines = [
    "⚙️ <b>Your settings</b>",
    "",
    autoFetchOn
      ? "🎧 Auto-get music files: <b>on</b> — when you pick a song, I fetch the audio for you automatically."
      : "🎧 Auto-get music files: <b>off</b> — you'll get the download link instead, so you can grab the file yourself.",
    "",
    richOn
      ? "🎨 Rich music delivery: <b>on</b> — I send the music file as one rich message with the Lyrics button inside it (experimental)."
      : "🎨 Rich music delivery: <b>off</b> — the music file arrives as a regular audio message with the Lyrics button under it.",
    "",
    previewsOn
      ? "🔗 Link previews: <b>on</b> — I show a preview card when I post a lyrics page link."
      : "🔗 Link previews: <b>off</b> — lyrics page links are posted without a preview card.",
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
  richOn: boolean,
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
        text: richOn ? "🎨 Rich music delivery: ON" : "🎨 Rich music delivery: OFF",
        callback_data: "settings_toggle_rich",
        style: richOn ? "success" : "danger",
      },
    ],
    [
      {
        text: "🖼 Rich styles",
        callback_data: "settings_richstyles",
      },
    ],
    [
      {
        text: previewsOn ? "🔗 Link previews: ON" : "🔗 Link previews: OFF",
        callback_data: "settings_toggle_preview",
        style: previewsOn ? "success" : "danger",
      },
    ],
  ];
  void globalDisabled; // keyboard is the same either way; text carries the notice
  return rows;
}

async function readPrefs(env: Env, userId: string) {
  const [globalOn, userAuto, previews, userRich] = await Promise.all([
    isAutoFetchEnabled(env.DB).catch(() => false),
    isUserAutoFetchEnabled(env.DB, userId),
    getUserLinkPreviewEnabled(env.DB, userId),
    isUserRichDeliveryEnabled(env.DB, userId),
  ]);
  return {
    autoFetchOn: globalOn && userAuto,
    globalDisabled: !globalOn,
    previewsOn: previews,
    richOn: userRich,
  };
}

export async function handleSettingsCommand(ctx: Context, env: Env): Promise<void> {
  const userId = String(ctx.from?.id ?? "");
  if (!userId) return;
  try {
    const prefs = await readPrefs(env, userId);
    await ctx.reply(
      buildSettingsText(prefs.autoFetchOn, prefs.globalDisabled, prefs.previewsOn, prefs.richOn),
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: buildSettingsKeyboard(
            prefs.autoFetchOn,
            prefs.globalDisabled,
            prefs.previewsOn,
            prefs.richOn,
          ) as any,
        },
      },
    );
  } catch (error) {
    warn("settings: command failed", error);
    await ctx.reply("❌ Couldn't load your settings. Try again later.");
  }
}

// ── Rich-style picker ───────────────────────────────────────────────────────

function buildPickerText(saved: RichStyleId, lastPreviewed?: RichStyleId): string {
  const lines = [
    "🎨 <b>Rich music delivery styles</b>",
    "",
    "Preview a style below (a live demo with Hello — Adele appears as its own message), then tap <b>Use style</b> to save it.",
    "",
  ];
  for (const id of [1, 2, 3, 4] as RichStyleId[]) {
    const mark = id === saved ? " ✅" : id === lastPreviewed ? " 👀" : "";
    lines.push(`<b>${id} · ${RICH_STYLES[id].name}</b> — ${RICH_STYLES[id].description}${mark}`);
  }
  return lines.join("\n");
}

function buildPickerKeyboard(saved: RichStyleId, lastPreviewed?: RichStyleId): SettingsButton[][] {
  const styleButtons = ([1, 2, 3, 4] as RichStyleId[]).map((id) => ({
    text: `${id}`,
    callback_data: `richstyle_demo_${id}`,
    style: id === saved ? ("success" as const) : id === lastPreviewed ? ("primary" as const) : undefined,
  }));
  return [
    styleButtons,
    [
      {
        text: lastPreviewed && lastPreviewed !== saved ? `✅ Use style ${lastPreviewed}` : `✅ Use style ${saved}`,
        callback_data: `richstyle_save_${lastPreviewed && lastPreviewed !== saved ? lastPreviewed : saved}`,
        style: "success" as const,
      },
    ],
    [{ text: "⬅️ Settings", callback_data: "settings_back" }],
  ];
}

async function editPicker(ctx: Context, saved: RichStyleId, lastPreviewed?: RichStyleId): Promise<void> {
  try {
    await ctx.editMessageText(buildPickerText(saved, lastPreviewed), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildPickerKeyboard(saved, lastPreviewed) as any },
    });
  } catch {
    // "message is not modified" races are fine.
  }
}

// "Rich styles" entry from the main panel: reuse a fresh picker if one is
// still open, otherwise send a new selector message.
async function openRichStylePicker(ctx: Context, env: Env, userId: string): Promise<void> {
  const richOn = await isUserRichDeliveryEnabled(env.DB, userId);
  if (!richOn) {
    await safeAnswer(ctx, "Turn on Rich music delivery first.");
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    await safeAnswer(ctx, "Open this in a private chat with me.");
    return;
  }

  const saved = await getUserRichStyle(env.DB, userId);
  const existing = await readDemoState(env.DB, userId);
  if (existing) {
    // Selector still alive — point the user back at it instead of stacking
    // a second picker.
    await safeAnswer(ctx, "The style picker is already open — it's the message right above.");
    return;
  }
  const sel = await ctx.api.sendMessage(
    chatId,
    buildPickerText(saved),
    { parse_mode: "HTML", reply_markup: { inline_keyboard: buildPickerKeyboard(saved) as any } },
  );
  await writeDemoState(env.DB, userId, { selMsgId: sel.message_id, ts: Date.now() });
  await safeAnswer(ctx);
}

// Preview click: delete the previous demo, send the new one, move the ✅.
async function previewRichStyle(ctx: Context, env: Env, userId: string, style: RichStyleId): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const state = await readDemoState(env.DB, userId);
  const saved = await getUserRichStyle(env.DB, userId);

  if (state?.lastDemoMsgId) {
    await safeDelete(ctx.api as any, chatId, state.lastDemoMsgId);
  }

  // Styles 2/3 need the album cover; 4 needs the deezload album link. Demo
  // data is fixed, so resolve directly instead of resolveRichAudioOpts's
  // per-user path.
  let coverUrl: string | undefined;
  let deezerUrl: string | undefined;
  if (style === 2 || style === 3) {
    coverUrl = await fetchCoverUrl(RICH_DEMO.trackId);
  } else if (style === 4) {
    deezerUrl = await fetchAlbumDeezerUrl(RICH_DEMO.trackId);
  }

  const msg = await sendRichAudio(
    ctx.api,
    chatId,
    RICH_DEMO.fileId,
    RICH_DEMO.trackName,
    RICH_DEMO.artistName,
    RICH_DEMO.telegraphUrl,
    { style, coverUrl, deezerUrl },
  );

  if (!msg) {
    warn("settings: rich style demo failed", style);
    await editPicker(ctx, saved);
    return;
  }

  await writeDemoState(env.DB, userId, {
    selMsgId: state?.selMsgId ?? (ctx.callbackQuery?.message as any)?.message_id ?? 0,
    lastDemoMsgId: msg.message_id,
    ts: Date.now(),
  });
  await editPicker(ctx, saved, style);
}

// Save click: persist the style and confirm on the selector.
async function saveRichStyle(ctx: Context, env: Env, userId: string, style: RichStyleId): Promise<void> {
  try {
    await setUserRichStyle(env.DB, userId, style);
  } catch (error) {
    warn("settings: failed to save rich style", error);
    await safeAnswer(ctx, "❌ Couldn't save the style. Try again.");
    return;
  }
  try {
    await ctx.editMessageText(
      `${buildPickerText(style)}\n\n<b>Saved — new deliveries use style ${style}.</b>`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buildPickerKeyboard(style, style) as any },
      },
    );
  } catch {
    // edit races fine
  }
}

// Back: clean up picker messages and end the flow (user re-runs /settings).
async function closeRichStylePicker(ctx: Context, env: Env, userId: string): Promise<void> {
  const chatId = ctx.chat?.id;
  const state = await readDemoState(env.DB, userId);
  if (chatId && state) {
    await safeDelete(ctx.api as any, chatId, state.selMsgId);
    if (state.lastDemoMsgId) {
      await safeDelete(ctx.api as any, chatId, state.lastDemoMsgId);
    }
  }
  try {
    await setSetting(env.DB, `${RICH_DEMO_PREFIX}${userId}`, "");
  } catch (error) {
    warn("settings: failed to clear demo state", error);
  }
}

// Router for the picker callbacks. Returns true when the data was handled.
export async function handleRichStyleCallback(ctx: Context, env: Env): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  const userId = String(ctx.from?.id ?? "");
  if (!userId) return false;

  if (data === "settings_richstyles") {
    await openRichStylePicker(ctx, env, userId);
    return true;
  }
  if (data === "settings_back") {
    await safeAnswer(ctx);
    await closeRichStylePicker(ctx, env, userId);
    return true;
  }
  if (data.startsWith("richstyle_demo_")) {
    const style = Number(data.replace("richstyle_demo_", "")) as RichStyleId;
    if (style === 1 || style === 2 || style === 3 || style === 4) {
      await safeAnswer(ctx);
      await previewRichStyle(ctx, env, userId, style);
    } else {
      await safeAnswer(ctx, "Unknown style.");
    }
    return true;
  }
  if (data.startsWith("richstyle_save_")) {
    const style = Number(data.replace("richstyle_save_", "")) as RichStyleId;
    if (style === 1 || style === 2 || style === 3 || style === 4) {
      await safeAnswer(ctx);
      await saveRichStyle(ctx, env, userId, style);
    } else {
      await safeAnswer(ctx, "Unknown style.");
    }
    return true;
  }
  return false;
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
    } else if (data === "settings_toggle_rich") {
      const richOn = await isUserRichDeliveryEnabled(env.DB, userId);
      await setUserRichDeliveryEnabled(env.DB, userId, !richOn);
    } else if (data === "settings_toggle_preview") {
      const previewsOn = await getUserLinkPreviewEnabled(env.DB, userId);
      await setUserLinkPreviewEnabled(env.DB, userId, !previewsOn);
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
    await ctx.editMessageText(
      buildSettingsText(prefs.autoFetchOn, prefs.globalDisabled, prefs.previewsOn, prefs.richOn),
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: buildSettingsKeyboard(
            prefs.autoFetchOn,
            prefs.globalDisabled,
            prefs.previewsOn,
            prefs.richOn,
          ) as any,
        },
      },
    );
  } catch {
    // Ignore "message is not modified" edit races.
  }
}
