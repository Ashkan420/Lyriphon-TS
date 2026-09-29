import { Api, type RawApi } from "grammy";
import { D1Database } from "@cloudflare/workers-types";
import { Context } from "grammy";
import { getUserChannels } from "../db/channels";
import { SessionData, SessionMode } from "../session/types";
import { transition } from "../session/transitions";
import { resetFlow } from "../session/flows";
import { escapeMd as escapeMdUtil } from "./escapeMd";
import { log, warn } from "./logger";
import { isRichDeliveryActive, getUserRichStyle, getUserRichPosition, getUserRichColor } from "../db/settings";
import { sendRichAudio, RichAudioOpts, RichPosition, RichColor } from "./richMessages";
import { getTrack } from "../services/deezer";
import type { InlineKeyboardMarkup } from "@grammyjs/types";

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${minutes}:${sec.toString().padStart(2, "0")}`;
}

export async function safeDelete(bot: Api<RawApi>, chatId: number, messageId: number) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch {
    // ignore
  }
}

export async function safeAnswer(ctx: Context, text?: string): Promise<void> {
  try {
    if (text) {
      await ctx.answerCallbackQuery({ text, show_alert: true } as any);
    } else {
      await ctx.answerCallbackQuery();
    }
  } catch {}
}

export async function safeEdit(
  api: any,
  chatId: number,
  messageId: number,
  text: string,
  markup?: InlineKeyboardMarkup,
): Promise<void> {
  try {
    const opts: any = {};
    if (markup) opts.reply_markup = markup;
    await api.editMessageText(chatId, messageId, text, opts);
  } catch {}
}

// Edit the message that triggered the current update (ctx-based), ignoring
// failures. Replaces the many bare `try { await ctx.editMessageText(t) } catch {}`.
export async function safeEditMessage(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.editMessageText(text);
  } catch {}
}

// Add or replace the inline keyboard on a message that already exists.
//
// Its payload carries no media, no caption, no parse_mode and no entities — so
// the audio, the caption text, its entities (the hidden Telegraph link, the
// U+200E inside it) and the post's position are all preserved because the
// request never mentions them. Do NOT fall back to editMessageMedia on failure:
// that would re-supply the media, which is exactly what the feature forbids
// (FR-025/026). A failed attach is logged here and the post is left alone.
//
// The caption IS changed on purpose (FR-027a) — but by safeEditCaption below,
// as a separate call, so a caption problem can never cost the button.
export async function safeEditMarkup(
  api: any,
  chatId: number,
  messageId: number,
  markup: InlineKeyboardMarkup,
): Promise<boolean> {
  try {
    await api.editMessageReplyMarkup(chatId, messageId, { reply_markup: markup });
    return true;
  } catch (error) {
    // Swallowed like safeEdit — but the reason must be visible. Returning a
    // bare false leaves the caller with nothing to diagnose, which is exactly
    // the situation when real posts start refusing the edit.
    warn("safeEditMarkup failed", {
      chatId,
      messageId,
      error: String((error as any)?.message ?? error).slice(0, 300),
    });
    return false;
  }
}

// Replace the caption of a message that already exists, without touching the
// media. Used by /migrate to put a post into the bot's normal caption form
// (FR-027a) — a second call alongside safeEditMarkup, not a replacement for it.
//
// A caption that is already identical comes back as "message is not modified";
// that is the desired outcome here, not a failure, so it is treated as success.
export async function safeEditCaption(
  api: any,
  chatId: number,
  messageId: number,
  caption: string,
): Promise<boolean> {
  try {
    await api.editMessageCaption(chatId, messageId, {
      caption,
      parse_mode: "MarkdownV2",
    });
    return true;
  } catch (error) {
    const message = String((error as any)?.message ?? error);
    if (/not modified/i.test(message)) return true;
    warn("safeEditCaption failed", {
      chatId,
      messageId,
      error: message.slice(0, 300),
    });
    return false;
  }
}

// Delete the lingering "Send to which channel?" prompt, if any.
export async function clearSendChannelPrompt(
  api: Api<RawApi>,
  chatId: number,
  session: SessionData,
): Promise<void> {
  if (session.audio.sendChannelPromptId) {
    await safeDelete(api, chatId, session.audio.sendChannelPromptId);
    session.audio.sendChannelPromptId = undefined;
  }
}

export async function delayedDelete(
  bot: Api<RawApi>,
  chatId: number,
  messageId: number,
  delaySeconds: number,
  scheduleDelete?: (chatId: number, messageId: number, delayMs: number) => void,
) {
  if (scheduleDelete) {
    scheduleDelete(chatId, messageId, Math.round(delaySeconds * 1000));
    return;
  }

  // In Cloudflare Workers, setTimeout is not available.
  // scheduleDelete (DO alarm queue) must be provided.
  warn("delayedDelete called without scheduleDelete — message will not be deleted");}

export async function searchAndShowResults(
  bot: Api<RawApi>,
  chatId: number,
  session: SessionData,
  searchQuery: string,
  displayLabel: string,
  buildTrackButtons: (results: any[], page?: number) => any[][],
  searchTracks: (query: string, limit?: number) => Promise<any[] | null>,
  version?: number,
  isStale?: (session: SessionData, capturedVersion: number) => boolean,
  fallbackQuery?: string,
) {
  log("searchAndShowResults:", JSON.stringify({ searchQuery, displayLabel, fallbackQuery: fallbackQuery ?? null }));

  let results = await searchTracks(searchQuery);
  if (!results) {
    log("searchAndShowResults: search failed for", JSON.stringify(searchQuery));
    await bot.sendMessage(chatId, "❌ Search failed. Try again later.");
    return false;
  }

  // When the primary query (e.g. a Finglish transliteration) yields nothing,
  // retry once with the fallback (e.g. the original Farsi title).
  if (!results.length && fallbackQuery && fallbackQuery !== searchQuery) {
    log("searchAndShowResults: 0 hits, trying fallback", JSON.stringify(fallbackQuery));
    const fallbackResults = await searchTracks(fallbackQuery);
    if (fallbackResults?.length) {
      results = fallbackResults;
      log("searchAndShowResults: fallback succeeded with", results.length, "result(s)");
    } else {
      log("searchAndShowResults: fallback also empty for", JSON.stringify(fallbackQuery));
    }
  }

  if (version !== undefined && isStale && isStale(session, version)) {
    log("searchAndShowResults: stale session, discarding results");
    return false;
  }

  if (!results.length) {
    log("searchAndShowResults: no results for", JSON.stringify(displayLabel || searchQuery));
    await bot.sendMessage(chatId, `❌ No results found for: ${displayLabel}`);
    return false;
  }

  session.search.results = results;
  session.search.page = 0;
  log("searchAndShowResults: presenting", results.length, "track(s) to user for", JSON.stringify(displayLabel || searchQuery));

  const buttons = buildTrackButtons(results, 0);
  const text = displayLabel
    ? `🎵 Found matches for: ${displayLabel}\nSelect the track:`
    : "🎵 Select the track:";
  await bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: buttons },
  });
  return true;
}

// MarkdownV2 caption shared by the manual attach flow and the deezload
// bridge delivery: blockquote with `track — artist` in code + the Telegraph
// link hidden behind a zero-width character.
export function buildAudioCaption(trackName: string, artistName: string, telegraphUrl: string): string {
  const trackNameMd = escapeMdUtil(trackName);
  const artistNameMd = escapeMdUtil(artistName);
  const hiddenLink = `[‎](${telegraphUrl})`;
  return `>\`${trackNameMd} — ${artistNameMd}\`${hiddenLink}`;
}

// Fetch an album cover URL from Deezer for rich layout 2. Returns undefined
// on any failure — the style engine degrades to the no-cover body.
export async function fetchCoverUrl(trackId: number): Promise<string | undefined> {
  try {
    const t = (await getTrack(trackId)) as any;
    return t?.album?.cover_xl ?? t?.album?.cover_big ?? undefined;
  } catch {
    return undefined;
  }
}

// Resolve the user's rich-delivery options for a real delivery: read the
// layout/position/color prefs, and only fetch from Deezer when the chosen
// layout needs it (cover for layout 2). Everything degrades on failure — the
// style engine then renders the layout-1 body.
export async function resolveRichAudioOpts(
  db: D1Database,
  userId: string,
  trackId: number | undefined,
  coverUrl?: string,
): Promise<RichAudioOpts> {
  let layout: 1 | 2 = 1;
  let position: RichPosition = "center";
  let color: RichColor = "primary";
  try {
    [layout, position, color] = await Promise.all([
      getUserRichStyle(db, userId),
      getUserRichPosition(db, userId),
      getUserRichColor(db, userId),
    ]);
  } catch {
    // fail closed to defaults
  }
  const opts: RichAudioOpts = { layout, position, color };
  if (layout === 2) {
    if (coverUrl) {
      opts.coverUrl = coverUrl;
    } else if (trackId) {
      opts.coverUrl = await fetchCoverUrl(trackId);
    }
  }
  return opts;
}

export async function attachAudioAndPromptChannel(
  bot: Api<RawApi>,
  db: D1Database,
  chatId: number,
  userId: string,
  session: SessionData,
  fileId: string,
  telegraphUrl: string,
  trackName: string,
  artistName: string,
  richOpts?: RichAudioOpts,
) {
  const caption = buildAudioCaption(trackName, artistName, telegraphUrl);

  // Experimental rich delivery: one rich message (audio + Lyrics tg-button in
  // the body, no reply_markup). Falls back to the plain sendAudio below when
  // the toggle is off or the rich send fails.
  if (await isRichDeliveryActive(db, userId)) {
    const opts = richOpts ?? (await resolveRichAudioOpts(db, userId, undefined, undefined));
    const richOk = await sendRichAudio(bot, chatId, fileId, telegraphUrl, opts);
    if (richOk) {
      session.audio.pendingFileId = fileId;
      session.audio.pendingCaption = caption;
      session.audio.pendingTelegraphUrl = telegraphUrl;
      session.audio.pendingTrackName = trackName;
      session.audio.pendingArtistName = artistName;
      await promptUserChannels(bot, db, chatId, userId, session);
      return caption;
    }
  }

  try {
    await bot.sendAudio(chatId, fileId, {
      caption,
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: [[{ text: "Lyrics", url: telegraphUrl }]] },
    });
  } catch {
    await bot.sendMessage(chatId, "❌ Failed to attach audio.");
    return null;
  }

  session.audio.pendingFileId = fileId;
  session.audio.pendingCaption = caption;
  session.audio.pendingTelegraphUrl = telegraphUrl;
  session.audio.pendingTrackName = trackName;
  session.audio.pendingArtistName = artistName;

  await promptUserChannels(bot, db, chatId, userId, session);

  return caption;
}

// The "Send to which channel?" prompt after a DM audio delivery. Shared by
// the rich and plain paths; never breaks delivery on failure.
async function promptUserChannels(
  bot: Api<RawApi>,
  db: D1Database,
  chatId: number,
  userId: string,
  session: SessionData,
): Promise<void> {
  try {
    const channels = await getUserChannels(db, userId);
    if (channels.length) {
      const channelButtons = channels.map((row) => [
        { text: row.title ?? row.channel_id, callback_data: `send_channel_${row.channel_id}` },
      ]);
      const prompt = await bot.sendMessage(chatId, "Send to which channel?", {
        reply_markup: { inline_keyboard: channelButtons },
      });
      session.audio.sendChannelPromptId = prompt.message_id;
    }
  } catch (error) {
    warn("Failed to fetch user channels (table may not exist)", error);
  }
}

export async function cancelEdit(bot: Api<RawApi>, chatId: number, session: SessionData) {
  await transition(session, SessionMode.IDLE, bot, chatId);
  resetFlow(session.edit);
  resetFlow(session.lyrics);
}

export { escapeMdUtil as escapeMd };
