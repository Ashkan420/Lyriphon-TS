import { Context } from "grammy";
import { getTrack, getAlbum, searchTracks } from "../services/deezer";
import { getLyrics } from "../services/lrclib";
import { createSongTelegraph, editSongPage } from "../services/telegraph";
import { isValidUrl } from "../utils/urlValidation";
import {
  safeDelete,
  safeAnswer,
  safeEdit,
  safeEditMessage,
  searchAndShowResults,
  attachAudioAndPromptChannel,
  cancelEdit,
  escapeMd,
} from "../utils/telegram";
import { buildTrackButtons } from "./songSearch";
import { warn, debug } from "../utils/logger";
import {
  resetFlow,
  SessionMode,
  captureVersion,
  isStale,
} from "../session/index";
import { clearAudioState } from "../session/flows";
import { SessionData } from "../session/types";
import { transition } from "../session/transitions";
import { Env } from "../env";
import { translateLyrics, refineTranslation, scoreTranslation } from "../services/translation";
import { analyzeLanguages, isSourceLanguage, getLanguageUiLabel } from "../services/translation/language-analyzer";
import { combineLyricsWithTranslation } from "../services/translation/combine";
import { SUPPORTED_LANGUAGES, findLanguage, type LanguageCode } from "../services/translation/types";
import type { InlineKeyboardButton } from "@grammyjs/types";
import {
  getActiveTranslation,
  getHighScoreTranslation,
  insertTranslation,
  updateScore,
  deactivateOldVersions,
} from "../db/translations";

const urlFields = ["track_link", "artist_link", "album_link", "cover"];

// Wraps editSongPage so callers can branch on success without repeating the
// try/catch + warn at every site. Callers handle their own state cleanup and
// user-facing message based on the returned boolean.
async function tryEditSongPage(env: Env, lastData: unknown, lyrics: string, context: string): Promise<boolean> {
  try {
    await editSongPage(env, lastData as any, lyrics);
    return true;
  } catch (error) {
    warn(`Failed to update Telegraph page (${context})`, error);
    return false;
  }
}

export async function handleCallbackQuery(ctx: Context, session: SessionData, env: Env) {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    return;
  }

  if (data.startsWith("track_")) {
    await handleTrackSelectionCallback(ctx, session, env);
    return;
  }

  if (data.startsWith("audio_decision_")) {
    await handleAudioDecisionCallback(ctx, session, env);
    return;
  }

  if (data.startsWith("edit_field_")) {
    await handleEditFieldCallback(ctx, session);
    return;
  }

  if (data === "cancel_edit") {
    await handleCancelEditCallback(ctx, session);
    return;
  }

  if (data === "done_lyrics") {
    await handleDoneLyricsCallback(ctx, session, env);
    return;
  }

  if (data.startsWith("send_channel_")) {
    await handleSendToChannelCallback(ctx, session);
    return;
  }

  if (data.startsWith("translate:")) {
    await handleTranslateCallback(ctx, session, env);
    return;
  }
}

export async function processTextMessage(ctx: Context, session: SessionData, env: Env) {
  if (!session.edit.field || !(session.mode === SessionMode.EDIT_FIELD || session.mode === SessionMode.EDIT_LYRICS)) {
    return;
  }

  await handleNewFieldValue(ctx, session, env);
}

async function finalizeLyrics(ctx: Context, session: SessionData, env: Env) {
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

  const fullLyrics = session.lyrics.buffer.join("\n");
  const chatId = ctx.chat?.id;
  if (chatId) {
    for (const msgId of session.lyrics.messageIds) {
      await safeDelete(ctx.api as any, chatId, msgId);
    }
    if (session.edit.promptId) {
      await safeDelete(ctx.api as any, chatId, session.edit.promptId);
    }
  }

  if (!(await tryEditSongPage(env, lastData, fullLyrics, "lyrics finalization"))) {
    session.lyrics.locked = false;
    await transition(session, SessionMode.IDLE, ctx.api, chatId);
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
  await transition(session, SessionMode.IDLE, ctx.api, chatId);
  resetFlow(session.lyrics);
  resetFlow(session.edit);

  await safeEditMessage(ctx, "✅ Lyrics Updated");
  return true;
}

async function handleAudioDecisionCallback(ctx: Context, session: SessionData, env: Env) {
  const data = ctx.callbackQuery?.data;
  await safeAnswer(ctx);

  const decision = session.audio.pendingDecision as any;
  if (!decision) {
    await ctx.editMessageText("❌ This selection has expired.");
    return;
  }

  const { fileId, messageId, title, artist } = decision;
  session.audio.pendingDecision = undefined;
  const chatId = ctx.chat?.id;
  if (chatId) {
    await safeDelete(ctx.api as any, chatId, ctx.callbackQuery!.message!.message_id);
  }

  if (data === "audio_decision_attach") {
    const telegraphUrl = session.telegraph.url;
    const lastData = session.telegraph.data as Record<string, any>;
    if (!telegraphUrl || !lastData) {
      await ctx.reply("❌ Telegraph expired. Send /song to create a new one.");
      return;
    }

    const trackName = lastData.track ?? "Unknown Track";
    const artistName = lastData.artist ?? "Unknown Artist";

    const caption = await attachAudioAndPromptChannel(
      ctx.api,
      env.DB,
      chatId!,
      String(ctx.from?.id ?? ""),
      session,
      fileId,
      telegraphUrl,
      trackName,
      artistName,
    );
    if (!caption) {
      return;
    }

    session.telegraph.url = undefined;
    if (isStale(session, captureVersion(session))) {
      return;
    }
    await transition(session, SessionMode.IDLE, ctx.api, chatId);

  } else if (data === "audio_decision_search") {
    session.audio.fileId = fileId;
    session.audio.title = title;
    session.audio.artist = artist;
    session.audio.messageId = messageId;

    const searchQuery = `${artist} ${title}`.trim();
    const displayLabel = artist ? `${artist} - ${title}` : title;
    const myVersion = captureVersion(session);
    const ok = await searchAndShowResults(
      ctx.api,
      chatId!,
      session,
      searchQuery,
      displayLabel,
      buildTrackButtons,
      searchTracks,
      myVersion,
      isStale,
    );

    if (!ok && !isStale(session, myVersion)) {
      session.audio.fileId = undefined;
    }

  } else if (data === "audio_decision_cancel") {
    await transition(session, SessionMode.IDLE, ctx.api, chatId);
    await ctx.reply("❌ Cancelled.");
  }
}

async function handleEditFieldCallback(ctx: Context, session: SessionData) {
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

  const cancelButton = [[{ text: "❌ Cancel", callback_data: "cancel_edit" }]];
  const doneCancelButtons = [
    [{ text: "✅ Done", callback_data: "done_lyrics" }],
    [{ text: "❌ Cancel", callback_data: "cancel_edit" }],
  ];

  if (urlFields.includes(field)) {
    text = `✏️ Send new URL for: ${field}\n\n• Must start with http:// or https://\n• Type 'none' to remove it`;
    markup = { inline_keyboard: cancelButton };
    await transition(session, SessionMode.EDIT_FIELD, ctx.api, ctx.chat?.id);
  } else if (field === "lyrics") {
    text = `✏️ Send the new lyrics.\n\n• You can send multiple messages\n• Click Done when finished`;
    markup = { inline_keyboard: cancelButton };
    session.lyrics.buffer = [];
    session.lyrics.messageIds = [];
    await transition(session, SessionMode.EDIT_LYRICS, ctx.api, ctx.chat?.id);
  } else {
    text = `✏️ Send new value for: ${field}`;
    markup = { inline_keyboard: cancelButton };
    await transition(session, SessionMode.EDIT_FIELD, ctx.api, ctx.chat?.id);
  }

  const prompt = await ctx.reply(text, { reply_markup: markup as any });
  session.edit.promptId = prompt.message_id;
}

async function handleNewFieldValue(ctx: Context, session: SessionData, env: Env) {
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
      [{ text: "✅ Done", callback_data: "done_lyrics" }],
      [{ text: "❌ Cancel", callback_data: "cancel_edit" }],
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
        const msg = await ctx.reply("❌ Invalid URL format");
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
    await transition(session, SessionMode.IDLE, ctx.api, ctx.chat?.id);
    resetFlow(session.edit);
    try { await ctx.reply("❌ Failed to update Telegraph page"); } catch {}
    return;
  }

  await transition(session, SessionMode.IDLE, ctx.api, ctx.chat?.id);
  resetFlow(session.edit);
  try { await ctx.reply("✅ Updated"); } catch {}
}

async function handleCancelEditCallback(ctx: Context, session: SessionData) {
  if (session.mode !== SessionMode.EDIT_FIELD && session.mode !== SessionMode.EDIT_LYRICS) {
    await safeAnswer(ctx, "No active edit session");
    return;
  }

  await safeAnswer(ctx);
  await cancelEdit(ctx.api as any, ctx.chat?.id ?? 0, session);
  try { await ctx.editMessageText("❌ Edit cancelled"); } catch {}
}

async function handleDoneLyricsCallback(ctx: Context, session: SessionData, env: Env) {
  if (session.mode !== SessionMode.EDIT_LYRICS) {
    await safeAnswer(ctx, "No active edit session");
    return;
  }

  await finalizeLyrics(ctx, session, env);
}

async function handleSendToChannelCallback(ctx: Context, session: SessionData) {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("send_channel_")) {
    return;
  }

  await safeAnswer(ctx);
  const channelId = data.replace("send_channel_", "");
  const audioFileId = session.audio.pendingFileId;
  const caption = session.audio.pendingCaption;
  const telegraphUrl = session.audio.pendingTelegraphUrl;

  if (!audioFileId || !caption || !telegraphUrl) {
    await ctx.editMessageText("❌ Nothing to send.");
    session.audio.sendChannelPromptId = undefined;
    return;
  }

  try {
    const member = await ctx.api.getChatMember(Number(channelId), Number(ctx.from?.id ?? 0));
    if (member.status !== "administrator" && member.status !== "creator") {
      await safeAnswer(ctx, "❌ You are not an admin in this channel.");
      return;
    }
  } catch (error) {
    warn("Failed to verify admin status for channel", channelId, error);
    await safeAnswer(ctx, "❌ Can't access this channel.");
    return;
  }

  const button = { inline_keyboard: [[{ text: "Lyrics", url: telegraphUrl }]] };
  try {
    await ctx.api.sendAudio(channelId, audioFileId, {
      caption,
      parse_mode: "MarkdownV2",
      reply_markup: button,
    });
  } catch (error) {
    warn("Failed to send audio to channel", channelId, error);
    await ctx.editMessageText("❌ Failed to send to channel.");
    return;
  }

  await ctx.editMessageText("✅ Sent to channel!");
  session.audio.pendingFileId = undefined;
  session.audio.pendingCaption = undefined;
  session.audio.pendingTelegraphUrl = undefined;
  session.audio.sendChannelPromptId = undefined;
}

async function handleTrackSelectionCallback(ctx: Context, session: SessionData, env: Env) {
  await safeAnswer(ctx);
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("track_")) {
    return;
  }

  const trackId = Number(data.replace("track_", ""));
  if (Number.isNaN(trackId)) {
    await ctx.editMessageText("❌ Invalid track selection.");
    return;
  }

  session.search.results = undefined;
  session.search.page = 0;

  try { await ctx.editMessageText("⏳ Fetching track info..."); } catch { return; }
  const trackData = await getTrack(trackId) as any;
  if (!trackData) {
    try { await ctx.editMessageText("❌ Failed to fetch track info. Try again later."); } catch {}
    return;
  }

  const trackName = trackData.title ?? "Unknown Track";
  const artistName = trackData.artist?.name ?? "Unknown Artist";
  const artistId = trackData.artist?.id;
  const albumName = trackData.album?.title ?? "Unknown Album";
  const albumId = trackData.album?.id;
  const albumCoverUrl = trackData.album?.cover_xl ?? trackData.album?.cover_big ?? "";

  let releaseDate = "Unknown";
  if (albumId) {
    try { await ctx.editMessageText("⏳ Fetching metadata..."); } catch {}
    const albumInfo = await getAlbum(albumId);
    if (albumInfo) {
      releaseDate = (albumInfo as any).release_date ?? "Unknown";
    }
  }

  try { await ctx.editMessageText("⏳ Fetching lyrics..."); } catch {}
  const lyrics = await getLyrics(trackName, artistName);
  const authorName = ctx.from?.first_name ?? "Unknown User";

  try { await ctx.editMessageText("⏳ Creating Telegraph page..."); } catch {}

  let telegraphResult;
  try {
    telegraphResult = await createSongTelegraph(env, {
      authorName,
      track: trackName,
      trackId,
      artist: artistName,
      artistId,
      album: albumName,
      albumId,
      albumCoverUrl,
      releaseDate,
      lyrics,
    });
  } catch (error) {
    warn("Failed to create Telegraph page for track", trackName, error);
    await ctx.editMessageText("❌ Failed to create Telegraph page. Try again later.");
    return;
  }

  const myVersion = captureVersion(session);
  if (isStale(session, myVersion)) {
    return;
  }

  session.telegraph.originalLyrics = lyrics;
  session.telegraph.languageAnalysis = analyzeLanguages(lyrics);
  session.telegraph.url = telegraphResult.url;
  session.telegraph.path = telegraphResult.path;
  session.telegraph.data = telegraphResult.lastData;
  session.telegraph.translatedLyrics = undefined;
  session.telegraph.activeLang = undefined;
  session.telegraph.translationRequestId = undefined;
  resetTranslationState(session);

  const pendingAudioFileId = session.audio.fileId;
  const hasAudio = Boolean(pendingAudioFileId);
  if (hasAudio && pendingAudioFileId) {
    const caption = await attachAudioAndPromptChannel(
      ctx.api,
      env.DB,
      ctx.chat!.id,
      String(ctx.from?.id ?? ""),
      session,
      pendingAudioFileId,
      telegraphResult.url,
      trackName,
      artistName,
    );

    if (!caption) {
      await ctx.editMessageText("❌ Failed to attach audio. Try again.");
      session.audio.fileId = undefined;
      return;
    }

    if (ctx.chat?.id && session.audio.messageId) {
      await safeDelete(ctx.api as any, ctx.chat.id, session.audio.messageId);
    }

    clearAudioState(session);
    session.telegraph.url = undefined;
  }

  const status = hasAudio ? "Telegraph Created & Audio Attached" : "Telegraph Created";
  const extra = hasAudio ? "" : "Send a music file to attach the Lyrics button to it.\n\n";

  const replyText = `✅ <b>${status}</b>\n\n<blockquote>🎵 <b>${(trackName)}</b>\n👤 ${(artistName)}\n💽 ${(albumName)}\n📅 ${(releaseDate)}</blockquote>\n\n${extra}👇 Edit options below — or tap to open the page:\n<a href="${telegraphResult.url}">📖 Open Telegraph Page</a>`;

  try {
    await ctx.editMessageText(replyText, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildEditMenu() },
    });
  } catch (error) {
    warn("Failed to edit message with final result", error);
  }
}

function getDisplayLyrics(session: SessionData): string | null {
  const { originalLyrics, translatedLyrics, activeLang } = session.telegraph;

  if (!originalLyrics) {
    return null;
  }

  if (!activeLang || activeLang === "original") {
    return originalLyrics;
  }

  const cacheKey = `${activeLang}:${hashString(originalLyrics)}`;
  const entry = translatedLyrics?.[cacheKey];
  if (!entry) {
    return null;
  }

  return combineLyricsWithTranslation(originalLyrics, entry.text);
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

async function handleTranslateCallback(ctx: Context, session: SessionData, env: Env) {
  const data = ctx.callbackQuery?.data ?? "";

  if (data === "translate:open") {
    if (!session.telegraph.originalLyrics) {
      await safeAnswer(ctx, "No lyrics to translate");
      return;
    }
    if (session.telegraph.isTranslating) {
      await safeAnswer(ctx, "Translation in progress");
      return;
    }
    await safeAnswer(ctx);

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const buttons = buildLanguagePickerKeyboard(session);
    const msg = await ctx.reply("Select target language:", { reply_markup: { inline_keyboard: buttons } });
    session.telegraph.translateMessageId = msg.message_id;
    return;
  }

  if (data === "translate:cancel") {
    await safeAnswer(ctx);
    const msgId = session.telegraph.translateMessageId;
    if (msgId && chatId(ctx)) {
      await safeDelete(ctx.api as any, chatId(ctx)!, msgId);
    }
    session.telegraph.translateMessageId = undefined;
    session.telegraph.translationCooldownUntil = undefined;
    session.telegraph.pendingTranslationLang = undefined;
    session.telegraph.isTranslating = false;
    return;
  }

  if (data === "translate:retry") {
    const pendingLang = session.telegraph.pendingTranslationLang;
    if (!pendingLang) {
      await safeAnswer(ctx, "No pending translation");
      return;
    }

    await safeAnswer(ctx);

    const pickerMsgId = session.telegraph.translateMessageId;
    const cid = chatId(ctx);
    const cooldownUntil = session.telegraph.translationCooldownUntil ?? 0;

    if (Date.now() < cooldownUntil) {
      await showRateLimitCooldown(ctx, cid, pickerMsgId, cooldownUntil);
      return;
    }

    session.telegraph.translationCooldownUntil = undefined;
    await executeTranslation(ctx, session, env, pendingLang, pickerMsgId, cid);
    return;
  }

  if (data === "translate:refine") {
    await handleRefineCallback(ctx, session, env);
    return;
  }

  if (data === "translate:lang:original") {
    await safeAnswer(ctx);
    const lastData = session.telegraph.data as any;
    if (!lastData || !session.telegraph.originalLyrics) {
      const msgId = session.telegraph.translateMessageId;
      if (msgId && chatId(ctx)) {
        await safeEdit(ctx.api, chatId(ctx)!, msgId, "❌ No song data found.");
      }
      return;
    }
    if (!(await tryEditSongPage(env, lastData, session.telegraph.originalLyrics, "original lyrics"))) {
      const msgId = session.telegraph.translateMessageId;
      if (msgId && chatId(ctx)) {
        await safeEdit(ctx.api, chatId(ctx)!, msgId, "❌ Failed to update Telegraph page");
      }
      return;
    }
    session.telegraph.activeLang = "original";
    const msgId = session.telegraph.translateMessageId;
    if (msgId && chatId(ctx)) {
      await safeEdit(ctx.api, chatId(ctx)!, msgId, "✅ Restored original lyrics");
    }
    session.telegraph.translateMessageId = undefined;
    return;
  }

  if (data.startsWith("translate:lang:")) {
    const langCode = data.replace("translate:lang:", "");

    if (session.telegraph.isTranslating) {
      await safeAnswer(ctx, "Translation in progress");
      return;
    }

    if (session.telegraph.activeLang === langCode) {
      await safeAnswer(ctx, "Already showing this language");
      return;
    }

    const language = findLanguage(langCode);
    if (!language) {
      await safeAnswer(ctx, "Unsupported language");
      return;
    }

    if (isSourceLanguage(session.telegraph.languageAnalysis, langCode)) {
      await safeAnswer(ctx, "Lyrics already appear to be in this language.");
      return;
    }
    await safeAnswer(ctx);

    const originalLyrics = session.telegraph.originalLyrics;
    if (!originalLyrics) {
      const msgId = session.telegraph.translateMessageId;
      if (msgId && chatId(ctx)) {
        await safeEdit(ctx.api, chatId(ctx)!, msgId, "❌ No lyrics to translate.");
      }
      return;
    }

    const originalHash = hashString(originalLyrics);
    const cacheKey = `${langCode}:${originalHash}`;
    const cached = session.telegraph.translatedLyrics?.[cacheKey];
    const pickerMsgId = session.telegraph.translateMessageId;
    const cid = chatId(ctx);

    if (cached) {
      const combined = combineLyricsWithTranslation(originalLyrics, cached.text);
      if (combined) {
        const lastData = session.telegraph.data as any;
        if (lastData) {
          if (!(await tryEditSongPage(env, lastData, combined, "cached translation"))) {
            await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Failed to update Telegraph page");
            return;
          }
        }
        session.telegraph.activeLang = langCode;
        await safeEdit(ctx.api, cid!, pickerMsgId!, `✅ ${language.name} lyrics added. `);
        session.telegraph.translateMessageId = undefined;
        return;
      }
    }

    await executeTranslation(ctx, session, env, langCode, pickerMsgId, cid);
    return;
  }
}

function chatId(ctx: Context): number | undefined {
  return ctx.chat?.id;
}

function resetTranslationState(session: SessionData) {
  session.telegraph.isTranslating = false;
  session.telegraph.translateMessageId = undefined;
}

async function showRateLimitCooldown(
  ctx: Context,
  cid: number | undefined,
  pickerMsgId: number | undefined,
  cooldownUntil: number,
) {
  const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  if (pickerMsgId && cid) {
    await safeEdit(ctx.api, cid, pickerMsgId,
      `⏳ Gemini is rate-limited.\nPlease wait ${remaining}s and try again.`,
      { inline_keyboard: buildRateLimitKeyboard() });
  }
}

type TranslateAttempt =
  | { kind: "rate_limited"; cooldownUntil: number }
  | { kind: "text"; text: string }
  | { kind: "fail" };

// One translateLyrics call, normalized. Swallows unexpected throws (returns
// "fail") so the caller's control flow stays flat across initial + retry.
async function runTranslateAttempt(
  env: Env,
  lyrics: string,
  langCode: string,
  langAnalysis?: import("../services/translation/language-analyzer").LanguageAnalysis,
  multilingualEnabled = true,
): Promise<TranslateAttempt> {
  try {
    const result = await translateLyrics(env, lyrics, langCode as LanguageCode, langAnalysis, multilingualEnabled);
    if (result.type === "rate_limited") {
      return { kind: "rate_limited", cooldownUntil: Date.now() + result.retryAfterSeconds * 1000 };
    }
    if (result.type === "success") {
      return { kind: "text", text: result.text };
    }
  } catch (error) {
    warn("translateLyrics threw unexpectedly", error);
  }
  return { kind: "fail" };
}

async function executeTranslation(
  ctx: Context,
  session: SessionData,
  env: Env,
  langCode: string,
  pickerMsgId: number | undefined,
  cid: number | undefined,
) {
  const language = findLanguage(langCode);
  if (!language) return;

  const originalLyrics = session.telegraph.originalLyrics;
  if (!originalLyrics) {
    await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ No lyrics to translate.");
    return;
  }

  const cooldownUntil = session.telegraph.translationCooldownUntil ?? 0;
  if (Date.now() < cooldownUntil) {
    await showRateLimitCooldown(ctx, cid, pickerMsgId, cooldownUntil);
    return;
  }

  session.telegraph.pendingTranslationLang = langCode;
  session.telegraph.isTranslating = true;
  const requestId = crypto.randomUUID();
  session.telegraph.translationRequestId = requestId;
  const snapshotOriginal = originalLyrics;

  // Read detected source language for prompt composition
  const langAnalysis = session.telegraph.languageAnalysis;
  const multilingualEnabled = session.telegraph.multilingualEnabled ?? true;

  await safeEdit(ctx.api, cid!, pickerMsgId!, "🌐 Translating lyrics...\nPlease wait (~10–20s)");

  // Check D1 for high-score cached translation
  const songId = hashString(snapshotOriginal);
  debug("executeTranslation:checking_cache", { songId, langCode });
  const existing = await getHighScoreTranslation(env.DB, songId, langCode);
  if (existing) {
    debug("executeTranslation:cache_hit", { score: existing.score, translationLen: existing.translation.length });
  } else {
    debug("executeTranslation:cache_miss");
  }

  const attempt = existing
    ? { kind: "text" as const, text: existing.translation }
    : await runTranslateAttempt(env, snapshotOriginal, langCode, langAnalysis, multilingualEnabled);
  if (attempt.kind === "rate_limited") {
    session.telegraph.isTranslating = false;
    session.telegraph.translationCooldownUntil = attempt.cooldownUntil;
    await showRateLimitCooldown(ctx, cid, pickerMsgId, attempt.cooldownUntil);
    return;
  }
  const rawResult: string | null = attempt.kind === "text" ? attempt.text : null;

  if (session.telegraph.translationRequestId !== requestId) {
    resetTranslationState(session);
    return;
  }

  if (snapshotOriginal !== session.telegraph.originalLyrics) {
    resetTranslationState(session);
    await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Session changed during translation. Try again.");
    return;
  }

  if (!rawResult) {
    resetTranslationState(session);
    await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Translation failed. try again later.");
    return;
  }

  const originalHash = hashString(originalLyrics);
  const cacheKey = `${langCode}:${originalHash}`;

  if (!session.telegraph.translatedLyrics) {
    session.telegraph.translatedLyrics = {};
  }
  session.telegraph.translatedLyrics[cacheKey] = { originalHash, text: rawResult };

  let combined = combineLyricsWithTranslation(snapshotOriginal, rawResult);
  if (!combined) {
    warn("combineLyricsWithTranslation failed, retrying translation", {
      provider: env.TRANSLATION_PROVIDER ?? "gemini",
      lang: langCode,
    });

    await safeEdit(ctx.api, cid!, pickerMsgId!, "🔄 Retrying translation...");

    const retry = await runTranslateAttempt(env, snapshotOriginal, langCode, langAnalysis, multilingualEnabled);
    if (retry.kind === "rate_limited") {
      session.telegraph.isTranslating = false;
      session.telegraph.translationCooldownUntil = retry.cooldownUntil;
      await showRateLimitCooldown(ctx, cid, pickerMsgId, retry.cooldownUntil);
      return;
    }

    if (retry.kind === "text") {
      const retryCombined = combineLyricsWithTranslation(snapshotOriginal, retry.text);
      if (retryCombined) {
        session.telegraph.translatedLyrics[cacheKey] = { originalHash, text: retry.text };
        combined = retryCombined;
      }
    }

    if (!combined) {
      delete session.telegraph.translatedLyrics[cacheKey];
      resetTranslationState(session);
      warn("translation retry also failed to produce matching line count");
      await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Translation format error — try again");
      return;
    }
  }

  const lastData = session.telegraph.data as any;
  if (lastData) {
    if (!(await tryEditSongPage(env, lastData, combined, "after translation"))) {
      resetTranslationState(session);
      await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Failed to update Telegraph page");
      return;
    }
  }

  // Store in D1 with score=null (async scoring will update it)
  if (!existing) {
    try {
      debug("executeTranslation:d1_insert", { songId, langCode, version: 1 });
      const translationId = await insertTranslation(
        env.DB, songId, langCode, originalHash,
        snapshotOriginal, rawResult, null, 1
      );
      session.telegraph.activeTranslationId = translationId;
      debug("executeTranslation:d1_inserted", { translationId });

      // Background scoring (fire-and-forget, will complete after response)
      debug("executeTranslation:starting_async_scoring");
      scoreTranslation(env, snapshotOriginal, rawResult)
        .then(async (scoreResult) => {
          debug("executeTranslation:scoring_complete", { score: scoreResult.score });
          await updateScore(env.DB, translationId, scoreResult.score);
          debug("executeTranslation:score_updated_in_d1");
          // Best-effort message edit
          await safeEdit(ctx.api, cid!, pickerMsgId!,
            `✅ Translated to ${language.name} (score: ${scoreResult.score})`,
            { inline_keyboard: [[{ text: "✨ Refine", callback_data: "translate:refine" }]] }
          );
        })
        .catch((e) => {
          warn("async scoring failed", e);
        });
    } catch (e) {
      warn("D1 insert failed", e);
    }
  } else {
    debug("executeTranslation:using_cached_translation", { score: existing.score });
  }

  session.telegraph.activeLang = langCode;
  resetTranslationState(session);
  await safeEdit(ctx.api, cid!, pickerMsgId!,
    `✅ Lyrics translated to ${language.name}`,
    { inline_keyboard: [[{ text: "✨ Refine", callback_data: "translate:refine" }]] }
  );
}

async function handleRefineCallback(ctx: Context, session: SessionData, env: Env) {
  const activeLang = session.telegraph.activeLang;
  const activeTranslationId = session.telegraph.activeTranslationId;
  const pickerMsgId = session.telegraph.translateMessageId;
  const cid = chatId(ctx);

  debug("refine:callback", { activeLang, activeTranslationId, isRefining: session.telegraph.isRefining });

  if (!activeLang || activeLang === "original" || !activeTranslationId) {
    debug("refine:guard_no_active");
    await safeAnswer(ctx, "No active translation to refine");
    return;
  }

  if (session.telegraph.isRefining) {
    debug("refine:guard_already_refining");
    await safeAnswer(ctx, "Refinement in progress");
    return;
  }

  if (session.telegraph.isTranslating) {
    debug("refine:guard_translating");
    await safeAnswer(ctx, "Translation in progress");
    return;
  }

  session.telegraph.isRefining = true;
  await safeAnswer(ctx);

  if (pickerMsgId && cid) {
    await safeEdit(ctx.api, cid, pickerMsgId, "🔄 Refining translation...");
  }

  try {
    const songId = hashString(session.telegraph.originalLyrics!);
    debug("refine:fetch_active", { songId, activeLang });
    const activeRow = await getActiveTranslation(env.DB, songId, activeLang);
    if (!activeRow) {
      debug("refine:no_active_row");
      if (pickerMsgId && cid) {
        await safeEdit(ctx.api, cid, pickerMsgId, "❌ No active translation found in database.");
      }
      session.telegraph.isRefining = false;
      return;
    }

    const originalLyrics = activeRow.original_lyrics;
    const currentTranslation = activeRow.translation;
    const oldScore = activeRow.score ?? 50;
    debug("refine:active_row", {
      version: activeRow.version,
      oldScore,
      translationLen: currentTranslation.length,
    });

    const langAnalysis = session.telegraph.languageAnalysis;
    const multilingualEnabled = session.telegraph.multilingualEnabled ?? true;

    debug("refine:calling_refineTranslation");
    const refineResult = await refineTranslation(
      env, originalLyrics, currentTranslation, activeLang as LanguageCode,
      langAnalysis, multilingualEnabled
    );
    debug("refine:refineResult", { type: refineResult.type });

    if (refineResult.type === "rate_limited") {
      debug("refine:rate_limited");
      if (pickerMsgId && cid) {
        await safeEdit(ctx.api, cid, pickerMsgId, "⏳ Rate limited. Try again in a moment.");
      }
      session.telegraph.isRefining = false;
      return;
    }

    if (refineResult.type !== "success" || !refineResult.text) {
      debug("refine:refine_failed");
      if (pickerMsgId && cid) {
        await safeEdit(ctx.api, cid, pickerMsgId, "❌ Refinement failed. Try again later.");
      }
      session.telegraph.isRefining = false;
      return;
    }

    const refinedTranslation = refineResult.text;
    debug("refine:refined_text", { len: refinedTranslation.length, lines: refinedTranslation.split("\n").length });

    const originalLines = originalLyrics.replace(/\r\n/g, "\n").split("\n").map(l => l.trimEnd());
    const refinedLines = refinedTranslation.replace(/\r\n/g, "\n").split("\n").map(l => l.trimEnd());

    while (originalLines.length > 0 && originalLines[originalLines.length - 1].trim() === "") originalLines.pop();
    while (refinedLines.length > 0 && refinedLines[refinedLines.length - 1].trim() === "") refinedLines.pop();

    if (originalLines.length !== refinedLines.length) {
      warn("refine: line count mismatch", { original: originalLines.length, refined: refinedLines.length });
      if (pickerMsgId && cid) {
        await safeEdit(ctx.api, cid, pickerMsgId, "❌ Refinement format error — try again");
      }
      session.telegraph.isRefining = false;
      return;
    }
    debug("refine:line_count_ok", { lines: originalLines.length });

    debug("refine:scoring");
    const scoreResult = await scoreTranslation(env, originalLyrics, refinedTranslation);
    const newScore = scoreResult.score;
    debug("refine:scored", { newScore, oldScore, issues: scoreResult.issues });

    const isHighScoreAlready = oldScore >= 90;
    debug("refine:decision", { isHighScoreAlready, passesGate: newScore >= oldScore + 3 && newScore >= 85 });

    if (!isHighScoreAlready && newScore >= oldScore + 3 && newScore >= 85) {
      debug("refine:accepting_new_version");
      const version = activeRow.version + 1;
      const originalHash = activeRow.original_hash;

      const newId = await insertTranslation(env.DB, songId, activeLang, originalHash, originalLyrics, refinedTranslation, newScore, version);
      await deactivateOldVersions(env.DB, songId, activeLang, newId);

      session.telegraph.activeTranslationId = newId;

      const cacheKey = `${activeLang}:${originalHash}`;
      if (!session.telegraph.translatedLyrics) session.telegraph.translatedLyrics = {};
      session.telegraph.translatedLyrics[cacheKey] = { originalHash, text: refinedTranslation };

      const combined = combineLyricsWithTranslation(originalLyrics, refinedTranslation);
      if (combined) {
        const lastData = session.telegraph.data as any;
        if (lastData) {
          await tryEditSongPage(env, lastData, combined, "after refine");
        }
      }

      debug("refine:accepted", { version, newScore });
      if (pickerMsgId && cid) {
        await safeEdit(ctx.api, cid, pickerMsgId,
          `✅ Refined (score: ${oldScore} → ${newScore})`,
          { inline_keyboard: [[{ text: "✨ Refine", callback_data: "translate:refine" }]] }
        );
      }
    } else if (isHighScoreAlready) {
      debug("refine:personal_only");
      const combined = combineLyricsWithTranslation(originalLyrics, refinedTranslation);
      if (combined) {
        const lastData = session.telegraph.data as any;
        if (lastData) {
          await tryEditSongPage(env, lastData, combined, "after refine personal");
        }
      }

      if (pickerMsgId && cid) {
        await safeEdit(ctx.api, cid, pickerMsgId,
          `✅ Refined for you (${oldScore} → ${newScore})`,
          { inline_keyboard: [[{ text: "✨ Refine", callback_data: "translate:refine" }]] }
        );
      }
    } else {
      debug("refine:no_improvement", { newScore, oldScore });
      if (pickerMsgId && cid) {
        await safeEdit(ctx.api, cid, pickerMsgId,
          `✅ Already good (score: ${newScore})`,
          { inline_keyboard: [[{ text: "✨ Refine", callback_data: "translate:refine" }]] }
        );
      }
    }
  } catch (error) {
    warn("handleRefineCallback failed", error);
    if (pickerMsgId && cid) {
      await safeEdit(ctx.api, cid, pickerMsgId, "❌ Refinement failed. Try again later.");
    }
  } finally {
    debug("refine:done");
    session.telegraph.isRefining = false;
  }
}

function buildRateLimitKeyboard(): InlineKeyboardButton[][] {
  return [
    [
      { text: "🔄 Retry", callback_data: "translate:retry" },
      { text: "❌ Cancel", callback_data: "translate:cancel" },
    ],
  ];
}

function buildLanguagePickerKeyboard(session: SessionData): InlineKeyboardButton[][] {
  const analysis = session.telegraph.languageAnalysis;
  const buttons: InlineKeyboardButton[][] = [[]];

  for (const lang of SUPPORTED_LANGUAGES) {
    buttons[0].push({ text: lang.nativeName, callback_data: `translate:lang:${lang.code}` });
  }

  const hasCachedTranslation = session.telegraph.translatedLyrics &&
    Object.keys(session.telegraph.translatedLyrics).length > 0;
  if (hasCachedTranslation && session.telegraph.activeLang !== "original") {
    const label = getLanguageUiLabel(analysis);
    buttons.unshift([{ text: label, callback_data: "translate:lang:original" }]);
  }

  buttons.push([{ text: "❌ Cancel", callback_data: "translate:cancel" }]);
  return buttons;
}

function buildEditMenu() {
  return [
    [
      { text: "✏️ Lyrics", callback_data: "edit_field_lyrics" },
      { text: "👑 Author", callback_data: "edit_field_author" },
    ],
    [
      { text: "📝 Track", callback_data: "edit_field_track" },
      { text: "🔗 Track Link", callback_data: "edit_field_track_link" },
    ],
    [
      { text: "👤 Artist", callback_data: "edit_field_artist" },
      { text: "🔗 Artist Link", callback_data: "edit_field_artist_link" },
    ],
    [
      { text: "💽 Album", callback_data: "edit_field_album" },
      { text: "🔗 Album Link", callback_data: "edit_field_album_link" },
    ],
    [
      { text: "📅 Release Date", callback_data: "edit_field_date" },
      { text: "🖼 Cover URL", callback_data: "edit_field_cover" },
    ],
    [
      { text: "🌐 Translate Lyrics", callback_data: "translate:open" },
    ],
  ];
}
