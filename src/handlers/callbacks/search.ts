import { Context } from "grammy";
import { getTrack, getAlbum } from "../../services/deezer";
import { getLyrics } from "../../services/lrclib";
import { createSongTelegraph } from "../../services/telegraph";
import { getCachedLyrics, cacheLyrics } from "../../db/lyrics";
import { safeAnswer, safeDelete, attachAudioAndPromptChannel } from "../../utils/telegram";
import { warn } from "../../utils/logger";
import {
  captureVersion,
  isStale,
} from "../../session/index";
import { clearAudioState } from "../../session/flows";
import { SessionData } from "../../session/types";
import { Env } from "../../env";
import { analyzeLanguages } from "../../services/translation/language-analyzer";
import { buildEditMenu, resetTranslationState } from "./index";
import { MESSAGE_EFFECT_CONFETTI } from "../../config";

export async function handleTrackSelectionCallback(ctx: Context, session: SessionData, env: Env) {
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

  const cached = await getCachedLyrics(env.DB, trackId);
  let lyrics: string;
  if (cached !== null) {
    lyrics = cached;
  } else {
    try { await ctx.editMessageText("⏳ Fetching lyrics..."); } catch {}
    lyrics = (await getLyrics(trackName, artistName)) ?? "";
    if (lyrics) {
      await cacheLyrics(env.DB, trackId, lyrics);
    }
  }
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

  const status = hasAudio ? "Telegraph Created & Audio Attached" : "Telegraph Created";
  const extra = hasAudio ? "" : "Send a music file to attach the Lyrics button to it.\n\n";

  const replyText = `✅ <b>${status}</b>\n\n<blockquote>🎵 <b>${(trackName)}</b>\n👤 ${(artistName)}\n💽 ${(albumName)}\n📅 ${(releaseDate)}</blockquote>\n\n${extra}👇 Edit options below — or tap to open the page:\n<a href="${telegraphResult.url}">📖 Open Telegraph Page</a>`;

  const chatId = ctx.chat?.id;
  if (!chatId) {
    // Fallback to edit if no chat id
    try {
      await ctx.editMessageText(replyText, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buildEditMenu() },
      });
    } catch (error) {
      warn("Failed to edit message with final result", error);
    }
    return;
  }

  // Try to send new message with confetti effect
  try {
    await ctx.api.sendMessage(chatId, replyText, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildEditMenu() },
      message_effect_id: MESSAGE_EFFECT_CONFETTI,
    });
    // Delete the progress message on success
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (messageId) {
      await safeDelete(ctx.api, chatId, messageId);
    }
  } catch (error) {
    // Confetti effect might fail (non-private chat or API rejection)
    // Fall back to sending without effect
    try {
      await ctx.api.sendMessage(chatId, replyText, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buildEditMenu() },
      });
      const messageId = ctx.callbackQuery?.message?.message_id;
      if (messageId) {
        await safeDelete(ctx.api, chatId, messageId);
      }
    } catch (fallbackError) {
      // If send fails too, try to edit the existing message
      try {
        await ctx.editMessageText(replyText, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buildEditMenu() },
        });
      } catch (editError) {
        warn("Failed to send or edit final result", editError);
      }
    }
  }

  // Attach audio and prompt channel AFTER sending Telegraph result
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
      // Audio failed but Telegraph was already sent, don't error out
      session.audio.fileId = undefined;
      return;
    }

    if (ctx.chat?.id && session.audio.messageId) {
      await safeDelete(ctx.api as any, ctx.chat.id, session.audio.messageId);
    }

    clearAudioState(session);
    session.telegraph.url = undefined;
  }
}
