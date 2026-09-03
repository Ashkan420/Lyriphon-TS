import { Context } from "grammy";
import { getTrack, getAlbum } from "../../services/deezer";
import { getLyrics } from "../../services/lrclib";
import { createSongTelegraph } from "../../services/telegraph";
import { getCachedLyrics, cacheLyrics } from "../../db/lyrics";
import { safeAnswer, safeDelete, attachAudioAndPromptChannel } from "../../utils/telegram";
import { log, previewText, warn } from "../../utils/logger";
import {
  captureVersion,
  isStale,
} from "../../session/index";
import { clearAudioState } from "../../session/flows";
import { SessionData } from "../../session/types";
import { Env } from "../../env";
import { analyzeLanguages } from "../../services/translation/language-analyzer";
import { buildEditMenu, resetTranslationState } from "./index";
import { MESSAGE_EFFECT_CONFETTI, AUTOFETCH_MAX_PENDING_PER_USER } from "../../config";
import { isAutoFetchEnabled } from "../../db/settings";
import {
  countPendingByUser,
  createAudioRequest,
  setRequestTelegraphUrl,
  expireStalePending,
} from "../../db/audioRequests";

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

  log("track selected:", trackId);
  session.search.results = undefined;
  session.search.page = 0;

  try { await ctx.editMessageText("⏳ Fetching track info..."); } catch { return; }
  const trackData = await getTrack(trackId) as any;
  if (!trackData) {
    log("track pipeline: failed to fetch Deezer track", trackId);
    try { await ctx.editMessageText("❌ Failed to fetch track info. Try again later."); } catch {}
    return;
  }

  const trackName = trackData.title ?? "Unknown Track";
  const artistName = trackData.artist?.name ?? "Unknown Artist";
  const artistId = trackData.artist?.id;
  const albumName = trackData.album?.title ?? "Unknown Album";
  const albumId = trackData.album?.id;
  const albumCoverUrl = trackData.album?.cover_xl ?? trackData.album?.cover_big ?? "";
  log("track pipeline: resolved", JSON.stringify({ trackId, trackName, artistName, albumName }));

  // Auto-fetch via the deezload bridge — queued as soon as the song id is
  // known. Best-effort; failure just means the user fetches it themselves.
  const requesterId = String(ctx.from?.id ?? "");
  const requesterChatId = ctx.chat?.id;
  if (requesterChatId) {
    const token = await enqueueAutoFetch(
      env, requesterId, requesterChatId, trackId, trackName, artistName,
    );
    if (token) {
      session.telegraph.bridgeReqToken = token;
      try {
        await ctx.reply("🎧 Auto-fetch queued — the file will arrive here when ready.");
      } catch {}
    }
  }

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
    log(
      "track pipeline: lyrics cache HIT for track",
      trackId,
      `(${lyrics.length} chars) preview:`,
      previewText(lyrics),
    );
  } else {
    log(
      "track pipeline: lyrics cache MISS — fetching LRCLIB for",
      JSON.stringify({ trackName, artistName, albumName }),
    );

    try {
      await ctx.editMessageText("⏳ Fetching lyrics...");
    } catch {}

    lyrics = (await getLyrics(
      trackName,
      artistName,
      albumName,
    )) ?? "";
    if (lyrics) {
      await cacheLyrics(env.DB, trackId, lyrics);
      log("track pipeline: lyrics cached for track", trackId);
    } else {
      log(
        "track pipeline: NO LYRICS found for",
        JSON.stringify({ trackId, trackName, artistName, albumName }),
        "— continuing with empty lyrics page",
      );
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
    log("track pipeline: Telegraph created", telegraphResult.url, lyrics ? `(lyrics ${lyrics.length} chars)` : "(no lyrics)");
  } catch (error) {
    warn("Failed to create Telegraph page for track", trackName, error);
    await ctx.editMessageText("❌ Failed to create Telegraph page. Try again later.");
    return;
  }

  const myVersion = captureVersion(session);
  if (isStale(session, myVersion)) {
    log("track pipeline: stale session after Telegraph, discarding");
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
  session.telegraph.translationCooldownUntil = undefined;
  session.telegraph.pendingTranslationLang = undefined;
  resetTranslationState(session);

  // The bridge job now has a Lyrics link to attach to the delivered audio.
  if (session.telegraph.bridgeReqToken) {
    try {
      await setRequestTelegraphUrl(env.DB, session.telegraph.bridgeReqToken, telegraphResult.url);
    } catch (error) {
      warn("autofetch: failed to attach telegraph url", error);
    }
  }

  if (session.telegraph.languageAnalysis) {
    const la = session.telegraph.languageAnalysis;
    log(
      "track pipeline: language analysis",
      JSON.stringify({
        mode: la.mode,
        primary: la.primary,
        secondary: la.secondary ?? null,
      }),
    );
  }

  const pendingAudioFileId = session.audio.fileId;
  const hasAudio = Boolean(pendingAudioFileId);
  log("track pipeline: done", JSON.stringify({ trackName, artistName, hasAudio, hasLyrics: Boolean(lyrics) }));

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

// Enqueue a deezload auto-fetch job for this track, best-effort: any failure
// (toggle off, D1 error, bridge chat unconfigured, Telegram flood) must not
// break the normal track pipeline. Returns the request token on success.
async function enqueueAutoFetch(
  env: Env,
  userId: string,
  chatId: number,
  trackId: number,
  trackName: string,
  artistName: string,
): Promise<string | undefined> {
  try {
    if (!env.BRIDGE_CHAT_ID || !env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
      return undefined;
    }
    if (!(await isAutoFetchEnabled(env.DB))) {
      return undefined;
    }
    // Materialize TTL expiry first so stale rows (jobs whose delivery never
    // happened) don't pin the user at the pending cap for the full TTL.
    await expireStalePending(env.DB);
    const pending = await countPendingByUser(env.DB, userId);
    if (pending >= AUTOFETCH_MAX_PENDING_PER_USER) {
      log("autofetch: user at pending cap", userId, pending);
      return undefined;
    }

    const token = crypto.randomUUID();
    await createAudioRequest(env.DB, {
      reqToken: token,
      userId,
      chatId,
      trackId,
      trackTitle: trackName,
      artistName,
    });
    await sendBridgeJob(env, token, trackId, chatId);
    log("autofetch: job queued", JSON.stringify({ trackId, token }));
    return token;
  } catch (error) {
    warn("autofetch: enqueue failed", error);
    return undefined;
  }
}

// Hand the job to BridgeDO (teleproto userbot). Busy DO = reject; the D1 row
// stays pending until TTL expiry.
async function sendBridgeJob(env: Env, token: string, trackId: number, chatId: number): Promise<void> {
  const stub = env.BRIDGE_DO.get(env.BRIDGE_DO.idFromName("bridge"));
  const res = await stub.fetch("https://bridge/enqueue", {
    method: "POST",
    body: JSON.stringify({ token, trackId, chatId }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!body.ok) {
    throw new Error(`bridge rejected job: ${body.error ?? res.status}`);
  }
}
