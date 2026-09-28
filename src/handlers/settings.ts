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

import { Context, Api, RawApi } from "grammy";
import { Env } from "../env";
import {
  isAutoFetchEnabled,
  isUserAutoFetchEnabled,
  getUserLinkPreviewEnabled,
  setUserAutoFetchEnabled,
  setUserLinkPreviewEnabled,
  isRichDeliveryEnabled,
  isUserRichDeliveryEnabled,
  setUserRichDeliveryEnabled,
  getUserRichStyle,
  setUserRichStyle,
  getUserRichPosition,
  setUserRichPosition,
  getUserRichColor,
  setUserRichColor,
  getSetting,
  setSetting,
} from "../db/settings";
import { safeAnswer, safeDelete, fetchCoverUrl } from "../utils/telegram";
import {
  sendRichAudio,
  buildRichOptionDemo,
  RICH_LAYOUTS,
  RichPosition,
  RichColor,
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
  richGlobalDisabled: boolean,
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

  if (richGlobalDisabled) {
    lines.push(
      "",
      "⚠️ Rich music delivery is temporarily unavailable — it's turned off for everyone right now. Check back later.",
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
  const [globalOn, userAuto, previews, richGlobal, userRich] = await Promise.all([
    isAutoFetchEnabled(env.DB).catch(() => false),
    isUserAutoFetchEnabled(env.DB, userId),
    getUserLinkPreviewEnabled(env.DB, userId),
    isRichDeliveryEnabled(env.DB).catch(() => false),
    isUserRichDeliveryEnabled(env.DB, userId),
  ]);
  return {
    autoFetchOn: globalOn && userAuto,
    globalDisabled: !globalOn,
    previewsOn: previews,
    richOn: richGlobal && userRich,
    richGlobalDisabled: !richGlobal,
  };
}

export async function handleSettingsCommand(ctx: Context, env: Env): Promise<void> {
  const userId = String(ctx.from?.id ?? "");
  if (!userId) return;
  try {
    const prefs = await readPrefs(env, userId);
    await ctx.reply(
      buildSettingsText(prefs.autoFetchOn, prefs.globalDisabled, prefs.previewsOn, prefs.richOn, prefs.richGlobalDisabled),
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

// ── Rich-delivery customizer ────────────────────────────────────────────────
//
// One selector message lists the user's current layout/position/color with
// ✅. Layouts preview as live rich demos (Hello — Adele); position and color
// each open an interactive rich demo where the Lyrics button itself is
// rendered once per option as a clickable callback tg-button — tapping one
// saves it. Session-free: picker state is the per-user D1 KV blob.

type RichPrefs = {
  layout: 1 | 2;
  position: RichPosition;
  color: RichColor;
};

const POSITION_LABELS: Record<RichPosition, string> = {
  left: "Left",
  center: "Center",
  right: "Right",
};

const COLOR_LABELS: Record<RichColor, string> = {
  default: "Gray",
  primary: "Blue",
  success: "Green",
  danger: "Red",
};

async function readRichPrefs(env: Env, userId: string): Promise<RichPrefs> {
  try {
    const [layout, position, color] = await Promise.all([
      getUserRichStyle(env.DB, userId),
      getUserRichPosition(env.DB, userId),
      getUserRichColor(env.DB, userId),
    ]);
    return { layout, position, color };
  } catch {
    return { layout: 1, position: "center", color: "primary" };
  }
}

function buildPickerText(prefs: RichPrefs): string {
  return [
    "🎨 <b>Rich music delivery</b>",
    "",
    `Layout: <b>${prefs.layout} · ${RICH_LAYOUTS[prefs.layout].name}</b> ✅`,
    `Position: <b>${POSITION_LABELS[prefs.position]}</b> ✅`,
    `Color: <b>${COLOR_LABELS[prefs.color]}</b> ✅`,
    "",
    "Tap a layout to preview it (a live demo with Hello — Adele appears as its own message).",
    "Position and Color open an interactive demo — tap the Lyrics button rendered in the look you want.",
  ].join("\n");
}

function buildPickerKeyboard(prefs: RichPrefs, lastPreviewed?: 1 | 2): SettingsButton[][] {
  const layoutButtons = ([1, 2] as (1 | 2)[]).map((id) => ({
    text: `${id} · ${RICH_LAYOUTS[id].name}`,
    callback_data: `richstyle_demo_${id}`,
    style: id === prefs.layout ? ("success" as const) : id === lastPreviewed ? ("primary" as const) : undefined,
  }));
  return [
    layoutButtons,
    [
      {
        text: `✅ Use layout ${lastPreviewed ?? prefs.layout}`,
        callback_data: `richstyle_save_${lastPreviewed ?? prefs.layout}`,
        style: "success" as const,
      },
    ],
    [
      { text: "↔️ Position", callback_data: "richdemo_pos" },
      { text: "🎨 Color", callback_data: "richdemo_col" },
    ],
    [{ text: "⬅️ Settings", callback_data: "settings_back" }],
  ];
}

// Refresh the selector message from a state object (id from the KV blob).
async function editSelectorWithState(
  api: Api<RawApi>,
  chatId: number,
  selMsgId: number,
  prefs: RichPrefs,
  lastPreviewed?: 1 | 2,
): Promise<void> {
  try {
    await api.editMessageText(chatId, selMsgId, buildPickerText(prefs), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildPickerKeyboard(prefs, lastPreviewed) as any },
    });
  } catch {
    // "message is not modified" / deleted selector — nothing to do.
  }
}

// "Rich styles" entry from the main panel: replace any stale picker with a
// fresh one (self-healing instead of an "already open" alert).
async function openRichStylePicker(ctx: Context, env: Env, userId: string): Promise<void> {
  const richGlobal = await isRichDeliveryEnabled(env.DB).catch(() => false);
  if (!richGlobal) {
    await safeAnswer(ctx, "Rich music delivery is temporarily unavailable.");
    return;
  }
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

  // Clean up a previous picker's messages, then send fresh.
  const existing = await readDemoState(env.DB, userId);
  if (existing) {
    await safeDelete(ctx.api as any, chatId, existing.selMsgId);
    if (existing.lastDemoMsgId) {
      await safeDelete(ctx.api as any, chatId, existing.lastDemoMsgId);
    }
  }

  const prefs = await readRichPrefs(env, userId);
  const sel = await ctx.api.sendMessage(
    chatId,
    buildPickerText(prefs),
    { parse_mode: "HTML", reply_markup: { inline_keyboard: buildPickerKeyboard(prefs) as any } },
  );
  await writeDemoState(env.DB, userId, { selMsgId: sel.message_id, ts: Date.now() });
  await safeAnswer(ctx);
}

// Shared by every demo path: delete the previous demo, send the replacement,
// track its id.
async function sendDemo(
  ctx: Context,
  env: Env,
  userId: string,
  payload: { html: string; media: Array<{ id: string; media: { type: "audio"; media: string } }> },
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const state = await readDemoState(env.DB, userId);
  if (state?.lastDemoMsgId) {
    await safeDelete(ctx.api as any, chatId, state.lastDemoMsgId);
  }
  try {
    const msg = await (ctx.api as any).sendRichMessage(chatId, {
      html: payload.html,
      media: payload.media,
      skip_entity_detection: true,
    });
    await writeDemoState(env.DB, userId, {
      selMsgId: state?.selMsgId ?? 0,
      lastDemoMsgId: msg?.message_id,
      ts: Date.now(),
    });
  } catch (error) {
    warn("settings: rich demo send failed", error);
  }
}

// Layout preview click: a full rich demo of the layout with the demo track.
async function previewRichLayout(ctx: Context, env: Env, userId: string, layout: 1 | 2): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const prefs = await readRichPrefs(env, userId);
  let coverUrl: string | undefined;
  if (layout === 2) {
    coverUrl = await fetchCoverUrl(RICH_DEMO.trackId);
  }
  const msg = await sendRichAudio(
    ctx.api,
    chatId,
    RICH_DEMO.fileId,
    RICH_DEMO.telegraphUrl,
    { layout, position: prefs.position, color: prefs.color, coverUrl },
  );
  if (!msg) {
    warn("settings: rich layout demo failed", layout);
    await safeAnswer(ctx, "⚠️ Couldn't render this layout right now.");
    return;
  }
  const state = await readDemoState(env.DB, userId);
  await writeDemoState(env.DB, userId, {
    selMsgId: state?.selMsgId ?? (ctx.callbackQuery?.message as any)?.message_id ?? 0,
    lastDemoMsgId: msg.message_id,
    ts: Date.now(),
  });
  if (state?.selMsgId) {
    await editSelectorWithState(ctx.api, chatId, state.selMsgId, prefs, layout);
  }
  await safeAnswer(ctx);
}

// Save-layout click.
async function saveRichLayout(ctx: Context, env: Env, userId: string, layout: 1 | 2): Promise<void> {
  try {
    await setUserRichStyle(env.DB, userId, layout);
  } catch (error) {
    warn("settings: failed to save rich layout", error);
    await safeAnswer(ctx, "❌ Couldn't save the layout. Try again.");
    return;
  }
  await safeAnswer(ctx, `✅ Layout ${layout} saved`);
  const chatId = ctx.chat?.id;
  const state = await readDemoState(env.DB, userId);
  if (chatId && state?.selMsgId) {
    const prefs = await readRichPrefs(env, userId);
    await editSelectorWithState(ctx.api, chatId, state.selMsgId, prefs);
  }
}

// Position/color option-demo click: send the interactive demo (the Lyrics
// buttons inside it are callback tg-buttons that save on tap).
async function openOptionDemo(ctx: Context, env: Env, userId: string, kind: "position" | "color"): Promise<void> {
  await sendDemo(ctx, env, userId, buildRichOptionDemo(kind, RICH_DEMO.fileId));
  await safeAnswer(ctx);
}

// richpos_* / richcol_* click from inside an option demo: persist and
// confirm, then refresh the selector's ✅ lines.
async function saveOptionPick(ctx: Context, env: Env, userId: string, kind: "position" | "color", value: string): Promise<void> {
  const chatId = ctx.chat?.id;
  let saved = false;
  try {
    if (kind === "position" && (value === "left" || value === "center" || value === "right")) {
      await setUserRichPosition(env.DB, userId, value);
      saved = true;
    } else if (
      kind === "color" &&
      (value === "default" || value === "primary" || value === "success" || value === "danger")
    ) {
      await setUserRichColor(env.DB, userId, value);
      saved = true;
    }
  } catch (error) {
    warn("settings: failed to save rich option", error);
  }
  if (!saved) {
    await safeAnswer(ctx, "❌ Couldn't save. Try again.");
    return;
  }
  await safeAnswer(ctx, kind === "position" ? `✅ Saved: ${POSITION_LABELS[value as RichPosition]}` : `✅ Saved: ${COLOR_LABELS[value as RichColor]}`);
  if (chatId) {
    const state = await readDemoState(env.DB, userId);
    if (state?.selMsgId) {
      const prefs = await readRichPrefs(env, userId);
      await editSelectorWithState(ctx.api, chatId, state.selMsgId, prefs);
    }
  }
}

// Back: clean up picker + demo messages and end the flow.
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

// Router for the rich-delivery picker callbacks. Returns true when the data
// was handled.
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
    const layout = Number(data.replace("richstyle_demo_", ""));
    if (layout === 1 || layout === 2) {
      await previewRichLayout(ctx, env, userId, layout);
    } else {
      await safeAnswer(ctx, "Unknown layout.");
    }
    return true;
  }
  if (data.startsWith("richstyle_save_")) {
    const layout = Number(data.replace("richstyle_save_", ""));
    if (layout === 1 || layout === 2) {
      await saveRichLayout(ctx, env, userId, layout);
    } else {
      await safeAnswer(ctx, "Unknown layout.");
    }
    return true;
  }
  if (data === "richdemo_pos") {
    await openOptionDemo(ctx, env, userId, "position");
    return true;
  }
  if (data === "richdemo_col") {
    await openOptionDemo(ctx, env, userId, "color");
    return true;
  }
  if (data.startsWith("richpos_")) {
    await saveOptionPick(ctx, env, userId, "position", data.replace("richpos_", ""));
    return true;
  }
  if (data.startsWith("richcol_")) {
    await saveOptionPick(ctx, env, userId, "color", data.replace("richcol_", ""));
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
      const richGlobal = await isRichDeliveryEnabled(env.DB).catch(() => false);
      if (!richGlobal) {
        // Feature is down for everyone — the button does nothing.
        await safeAnswer(ctx, "Rich music delivery is temporarily unavailable.");
        return;
      }
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
      buildSettingsText(prefs.autoFetchOn, prefs.globalDisabled, prefs.previewsOn, prefs.richOn, prefs.richGlobalDisabled),
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
