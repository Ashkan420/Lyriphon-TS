import { Context } from "grammy";
import { safeAnswer, safeEditMessage, safeDelete, cancelEdit } from "../../utils/telegram";
import { isValidUrl } from "../../utils/urlValidation";
import { normalizeLyrics } from "../../utils/lyrics";
import { transition } from "../../session/transitions";
import { resetFlow, SessionMode, captureVersion, isStale } from "../../session/index";
import { SessionData } from "../../session/types";
import { Env } from "../../env";
import { analyzeLanguages } from "../../services/translation/language-analyzer";
import { setTrackLyrics } from "../../db/tracks";
import { isBotOwner } from "../admin";
import { warn } from "../../utils/logger";
import {
  urlFields,
  chatId,
  tryEditSongPage,
  resetTranslationState,
  getDisplayLyrics,
} from "./index";

export async function handleEditFieldCallback(ctx: Context, session: SessionData) {
  if (session.mode === SessionMode.EDIT_FIELD || session.mode === SessionMode.EDIT_LYRICS) {
    await safeAnswer(ctx, "❌ You already have an active edit session");
    return;
  }

  await safeAnswer(ctx);
  const data = ctx.callbackQuery?.data ?? "";
  const field = data.replace("edit_field_", "");
  session.edit.field = field;

  let text = "";
  let markup: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> };

  const cancelButton = [[{ text: "Cancel", callback_data: "cancel_edit", style: "danger" as const }]];

  if (urlFields.includes(field)) {
    text = `✏️ Send new URL for: ${field}\n\n• Must start with http:// or https://\n• Type 'none' to remove it`;
    markup = { inline_keyboard: cancelButton };
    await transition(session, SessionMode.EDIT_FIELD, ctx.api, chatId(ctx));
  } else if (field === "lyrics") {
    text = `✏️ Send the new lyrics.\n\n• You can send multiple messages\n• Click Done when finished`;
    markup = { inline_keyboard: cancelButton };
    session.lyrics.buffer = [];
    session.lyrics.messageIds = [];
    await transition(session, SessionMode.EDIT_LYRICS, ctx.api, chatId(ctx));
  } else {
    text = `✏️ Send new value for: ${field}`;
    markup = { inline_keyboard: cancelButton };
    await transition(session, SessionMode.EDIT_FIELD, ctx.api, chatId(ctx));
  }

  const prompt = await ctx.reply(text, { reply_markup: markup as any });
  session.edit.promptId = prompt.message_id;
}

export async function handleNewFieldValue(ctx: Context, session: SessionData, env: Env) {
  const field = session.edit.field;
  if (!field) {
    return;
  }

  if (field === "lyrics") {
    if (session.lyrics.locked) {
      return;
    }

    const text = ctx.message?.text;
    if (!text || text.startsWith("/")) {
      return;
    }

    session.lyrics.buffer.push(text);
    session.lyrics.messageIds.push(ctx.message!.message_id);

    if (session.edit.promptId && ctx.chat?.id) {
      await safeDelete(ctx.api as any, ctx.chat.id, session.edit.promptId);
    }

    const doneCancelButtons = [
      [{ text: "Done", callback_data: "done_lyrics", style: "success" as const }],
      [{ text: "Cancel", callback_data: "cancel_edit", style: "danger" as const }],
    ];

    const prompt = await ctx.reply("✏️ Send more lyrics, or click Done when finished", {
      reply_markup: { inline_keyboard: doneCancelButtons },
    });
    session.edit.promptId = prompt.message_id;
    return;
  }

  const newValue = ctx.message?.text?.trim();
  const lastData = session.telegraph.data as any;
  if (!newValue || !lastData) {
    return;
  }

  if (ctx.chat?.id) {
    await safeDelete(ctx.api as any, ctx.chat.id, ctx.message!.message_id);
  }
  if (session.edit.promptId && ctx.chat?.id) {
    await safeDelete(ctx.api as any, ctx.chat.id, session.edit.promptId);
  }

  if (urlFields.includes(field)) {
    if (newValue.toLowerCase() === "none") {
      if (field === "cover") {
        lastData.album_cover_url = "";
      } else {
        lastData[field] = "";
      }
    } else {
      if (!isValidUrl(newValue)) {
        await ctx.reply("❌ Invalid URL format");
        return;
      }
      if (field === "cover") {
        lastData.album_cover_url = newValue;
      } else {
        lastData[field] = newValue;
      }
    }
  } else {
    if (field === "track") {
      lastData.track = newValue;
    } else if (field === "artist") {
      lastData.artist = newValue;
    } else if (field === "album") {
      lastData.album = newValue;
    } else if (field === "date") {
      lastData.release_date = newValue;
    } else if (field === "author") {
      lastData.author_name = newValue;
    }
  }

  if (!(await tryEditSongPage(env, lastData, getDisplayLyrics(session) ?? "", `field ${field}`))) {
    await transition(session, SessionMode.IDLE, ctx.api, chatId(ctx));
    resetFlow(session.edit);
    try { await ctx.reply("❌ Failed to update Telegraph page"); } catch {}
    return;
  }

  await transition(session, SessionMode.IDLE, ctx.api, chatId(ctx));
  resetFlow(session.edit);
  try { await ctx.reply("✅ Updated"); } catch {}
}

export async function handleCancelEditCallback(ctx: Context, session: SessionData) {
  if (session.mode !== SessionMode.EDIT_FIELD && session.mode !== SessionMode.EDIT_LYRICS) {
    await safeAnswer(ctx, "No active edit session");
    return;
  }

  await safeAnswer(ctx);
  await cancelEdit(ctx.api as any, ctx.chat?.id ?? 0, session);
  try { await ctx.editMessageText("❌ Edit cancelled"); } catch {}
}

export async function handleDoneLyricsCallback(ctx: Context, session: SessionData, env: Env) {
  if (session.mode !== SessionMode.EDIT_LYRICS) {
    await safeAnswer(ctx, "No active edit session");
    return;
  }

  await finalizeLyrics(ctx, session, env);
}

async function finalizeLyrics(ctx: Context, session: SessionData, env: Env): Promise<boolean> {
  if (session.mode !== SessionMode.EDIT_LYRICS) {
    await safeAnswer(ctx, "Not in lyrics editing mode");
    return false;
  }

  const myVersion = captureVersion(session);
  if (session.lyrics.locked) {
    await safeAnswer(ctx, "Already finalizing...");
    return false;
  }

  session.lyrics.locked = true;
  const lastData = session.telegraph.data as any;
  if (!lastData) {
    session.lyrics.locked = false;
    await safeAnswer(ctx, "No song data found");
    return false;
  }

  if (!session.lyrics.buffer.length) {
    session.lyrics.locked = false;
    await safeAnswer(ctx, "No lyrics to save");
    return false;
  }

  await safeAnswer(ctx);

  const fullLyrics = normalizeLyrics(session.lyrics.buffer.join("\n"));
  const cid = chatId(ctx);
  if (cid) {
    for (const msgId of session.lyrics.messageIds) {
      await safeDelete(ctx.api as any, cid, msgId);
    }
    if (session.edit.promptId) {
      await safeDelete(ctx.api as any, cid, session.edit.promptId);
    }
  }

  if (!(await tryEditSongPage(env, lastData, fullLyrics, "lyrics finalization"))) {
    session.lyrics.locked = false;
    await transition(session, SessionMode.IDLE, ctx.api, cid);
    resetFlow(session.lyrics);
    resetFlow(session.edit);
    await safeEditMessage(ctx, "❌ Failed to update Telegraph page");
    return false;
  }

  if (isStale(session, myVersion)) {
    session.lyrics.locked = false;
    return false;
  }

  session.telegraph.originalLyrics = fullLyrics;
  session.telegraph.languageAnalysis = analyzeLanguages(fullLyrics);
  session.telegraph.translatedLyrics = undefined;
  session.telegraph.activeLang = "original";
  resetTranslationState(session);
  await transition(session, SessionMode.IDLE, ctx.api, cid);
  resetFlow(session.lyrics);
  resetFlow(session.edit);

  // Owner gets a one-click cache sync: manual fixes on the Telegraph page
  // would otherwise leave the D1 lyrics cache stale for everyone else.
  const trackId = (lastData as any)?.trackId;
  if (isBotOwner(ctx, env) && typeof trackId === "number" && fullLyrics) {
    try {
      await ctx.editMessageText("✅ Lyrics Updated", {
        reply_markup: { inline_keyboard: buildApplyD1Keyboard(trackId) },
      });
    } catch {
      // edit races — the owner still has the result card with the menu.
    }
  } else {
    await safeEditMessage(ctx, "✅ Lyrics Updated");
  }
  return true;
}

// Keyboard for the post-edit "Apply to D1" offer (owner-only, appended after
// a successful lyrics finalize). Pure so tests can pin the callback shape.
export function buildApplyD1Keyboard(trackId: number) {
  return [
    [{ text: "💾 Apply to D1", callback_data: `applyd1_${trackId}`, style: "success" as const }],
  ];
}

// Overwrite the cached lyrics for this track with what the Telegraph page
// now shows. The session-track guard keeps a stale card from writing one
// song's lyrics into another track's cache row.
export async function handleApplyToD1(ctx: Context, session: SessionData, env: Env): Promise<void> {
  if (!isBotOwner(ctx, env)) {
    return;
  }

  const data = ctx.callbackQuery?.data ?? "";
  // The spent button's token — nothing to do beyond acknowledging.
  if (data === "applyd1_done") {
    await safeAnswer(ctx);
    return;
  }

  const trackId = Number(data.replace("applyd1_", ""));
  const lastData = session.telegraph.data as { trackId?: number } | undefined;
  const lyrics = session.telegraph.originalLyrics;

  if (
    Number.isNaN(trackId)
    || lastData?.trackId !== trackId
    || !lyrics
  ) {
    await ctx.answerCallbackQuery({
      text: "Session moved on — edit the lyrics again, then apply.",
      show_alert: true,
    } as any).catch(() => {});
    return;
  }

  try {
    await setTrackLyrics(env.DB, trackId, lyrics);
  } catch (error) {
    warn("applyd1: failed to write cached lyrics", error);
    await ctx.answerCallbackQuery({ text: "❌ Database error", show_alert: true } as any).catch(() => {});
    return;
  }

  await ctx.answerCallbackQuery({ text: "✅ Cached lyrics updated" }).catch(() => {});
  try {
    await ctx.editMessageReplyMarkup({
      reply_markup: {
        inline_keyboard: [[{ text: "✅ Applied to D1", callback_data: "applyd1_done", style: "success" as const }]],
      } as any,
    });
  } catch {}
}
