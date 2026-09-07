import { Context } from "grammy";
import { getTrack, getAlbum } from "../../services/deezer";
import { getLyrics } from "../../services/lrclib";
import { createSongTelegraph } from "../../services/telegraph";
import { getTrackRecord, upsertTrack, setTrackFileId } from "../../db/tracks";
import { safeAnswer, safeDelete, attachAudioAndPromptChannel } from "../../utils/telegram";
import { normalizeLyrics } from "../../utils/lyrics";
import {
  TrackProgressReporter,
  buildTrackResultHtml,
  countLyricLines,
} from "../../utils/richMessages";
import { log, previewText, warn } from "../../utils/logger";
import {
  captureVersion,
  isStale,
} from "../../session/index";
import { clearAudioState } from "../../session/flows";
import { SessionData } from "../../session/types";
import { Env } from "../../env";
import { analyzeLanguages } from "../../services/translation/language-analyzer";
import { buildEditMenu, resetTranslationState, adminToolsOpts } from "./index";
import { isBotOwner } from "../admin";
import { MESSAGE_EFFECT_CONFETTI, AUTOFETCH_MAX_PENDING_PER_USER } from "../../config";
import { isAutoFetchEnabled, isUserAutoFetchEnabled, getUserLinkPreviewEnabled } from "../../db/settings";
import {
  countPendingByUser,
  createAudioRequest,
  getRequestByToken,
  setRequestTelegraphUrl,
  setRequestQueuedMsg,
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

  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }
  const baseMessageId = ctx.callbackQuery?.message?.message_id;
  const progress = new TrackProgressReporter(ctx.api, chatId, baseMessageId);
  await progress.start();
  if (progress.isDead) {
    return;
  }

  const trackData = await getTrack(trackId) as any;
  if (!trackData) {
    log("track pipeline: failed to fetch Deezer track", trackId);
    await progress.fail("❌ Failed to fetch track info. Try again later.");
    return;
  }


  const trackName = trackData.title ?? "Unknown Track";
  const artistName = trackData.artist?.name ?? "Unknown Artist";
  const artistId = trackData.artist?.id;
  const albumName = trackData.album?.title ?? "Unknown Album";
  const albumId = trackData.album?.id;
  const albumCoverUrl = trackData.album?.cover_xl ?? trackData.album?.cover_big ?? "";
  log("track pipeline: resolved", JSON.stringify({ trackId, trackName, artistName, albumName }));

  await progress.update({ stage: "metadata", trackName, artistName });

  // Track store record — known before anything else so lyrics come from the
  // store, and a stored file_id skips the bridge entirely.
  const trackRecord = await getTrackRecord(env.DB, trackId);

  // Auto-fetch via the deezload bridge — queued as soon as the song id is
  // known, but only when the user did NOT provide their own audio (that file
  // gets attached below; a bridge/cache file on top would double-attach) and
  // we don't already have the file stored. The 🎧 message is deferred until
  // after the Telegraph result.
  const requesterId = String(ctx.from?.id ?? "");
  const requesterChatId = ctx.chat?.id;
  const userProvidedAudio = Boolean(session.audio.fileId);
  // Effective auto-get = admin global switch AND the user's own preference
  // (/settings). Governs both the bridge AND the cache reuse below.
  const autoGetForUser = requesterChatId
    && (await isAutoFetchEnabled(env.DB).catch(() => false))
    && (await isUserAutoFetchEnabled(env.DB, requesterId));
  let queuedPosition: number | undefined;
  const shouldAutoFetch = autoGetForUser && !trackRecord?.file_id && !userProvidedAudio;
  if (shouldAutoFetch) {
    const queued = await enqueueAutoFetch(
      env, requesterId, requesterChatId, trackId, trackName, artistName,
    );
    if (queued) {
      session.telegraph.bridgeReqToken = queued.token;
      queuedPosition = queued.position;
    }
  }

  let releaseDate = "Unknown";
  if (albumId) {
    const albumInfo = await getAlbum(albumId);
    if (albumInfo) {
      releaseDate = (albumInfo as any).release_date ?? "Unknown";
    }
  }
  await progress.update({ stage: "lyrics", albumName, releaseDate });

  const cached = trackRecord?.lyrics ?? null;
  let lyrics: string;
  let lyricLineCount = 0;
  if (cached !== null) {
    lyrics = normalizeLyrics(cached);
    lyricLineCount = countLyricLines(lyrics);
    // Heal backfilled rows: fill metadata the legacy table never had.
    if (!trackRecord?.title || !trackRecord?.artist) {
      await upsertTrack(env.DB, { trackId, title: trackName, artist: artistName });
    }
    // Heal rows cached before edge-newline normalization: old LRCLIB data
    // carried trailing/leading newlines that broke translation line counts.
    if (lyrics !== cached) {
      try {
        await upsertTrack(env.DB, { trackId, lyrics });
        log("track pipeline: lyrics cache healed (edge newlines stripped) for track", trackId);
      } catch (error) {
        warn("track pipeline: lyrics cache heal failed", error);
      }
    }
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

    lyrics = (await getLyrics(
      trackName,
      artistName,
      albumName,
    )) ?? "";
    if (lyrics) {
      lyricLineCount = countLyricLines(lyrics);
      // Title/artist ride along so backfilled rows heal over time.
      await upsertTrack(env.DB, { trackId, title: trackName, artist: artistName, lyrics });
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

  await progress.update({
    stage: "telegraph",
    lyricsNote: lyrics
      ? `${lyricLineCount} line${lyricLineCount === 1 ? "" : "s"}${cached !== null ? " (cached)" : ""}`
      : "not found",
  });
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
    await progress.fail("❌ Failed to create Telegraph page. Try again later.");
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
  session.telegraph.summaryRefreshCount = undefined;
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

  // Result card: hyperlink + native link preview (the preview follows the
  // live page, so cover edits show through and the edit menu keeps its own
  // keyboard). Preview preference respected via /settings.
  const showPreviews = await getUserLinkPreviewEnabled(env.DB, requesterId).catch(() => true);

  const replyText = buildTrackResultHtml({
    trackName,
    artistName,
    albumName,
    releaseDate,
    telegraphUrl: telegraphResult.url,
    authorName,
    hasAudio,
  });

  // One message from selection to result: the final card is an edit of the
  // progress message. False → no edit target; fall back to the send chain.
  const menuOpts = adminToolsOpts(trackId, isBotOwner(ctx, env));
  const cardMenu = buildEditMenu(false, menuOpts);
  const finalized = await progress.finalizeText(replyText, { inline_keyboard: cardMenu }, !showPreviews);
  if (!finalized) {
    try {
      await ctx.api.sendMessage(chatId, replyText, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: cardMenu },
        message_effect_id: MESSAGE_EFFECT_CONFETTI,
        link_preview_options: { is_disabled: !showPreviews },
      });
      const messageId = progress.activeMessageId;
      if (messageId !== undefined) {
        await safeDelete(ctx.api, chatId, messageId);
      }
    } catch (fallbackError) {
      // Confetti effect might fail (non-private chat or API rejection)
      try {
        await ctx.api.sendMessage(chatId, replyText, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: cardMenu },
          link_preview_options: { is_disabled: !showPreviews },
        });
        const messageId = progress.activeMessageId;
        if (messageId !== undefined) {
          await safeDelete(ctx.api, chatId, messageId);
        }
      } catch (finalError) {
        try {
          await ctx.editMessageText(replyText, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: cardMenu },
            link_preview_options: { is_disabled: !showPreviews },
          });
        } catch (editError) {
          warn("Failed to send or edit final result", editError);
        }
      }
    }
  }

  // Deferred auto-fetch notice: after the result, so it sits below the
  // Telegraph card; its id is persisted for self-deletion on delivery. The
  // pre-send guard and post-persist re-check close the race where the bridge
  // delivers before this notice is even sent (fast bridge, slow pipeline) —
  // in that case the row is already terminal and the notice must not appear.
  if (session.telegraph.bridgeReqToken && queuedPosition) {
    const reqToken = session.telegraph.bridgeReqToken;
    try {
      const row = await getRequestByToken(env.DB, reqToken);
      if (!row || row.status !== "pending") {
        log("autofetch: job already terminal, skipping queued notice", reqToken);
      } else {
        const note = await ctx.api.sendMessage(
          chatId,
          `🎧 Auto-fetch queued${queuedPosition > 1 ? ` (position ${queuedPosition})` : ""} — the file will arrive here when ready.`,
        );
        try {
          await setRequestQueuedMsg(env.DB, reqToken, note.message_id);
          // If the job reached a terminal state while the notice was in
          // flight, the fresh-read delete raced us — clean up ourselves.
          const after = await getRequestByToken(env.DB, reqToken);
          if (after && after.status !== "pending") {
            await safeDelete(ctx.api as any, chatId, note.message_id);
          }
        } catch (persistError) {
          // Untracked notice can never be self-deleted — remove it.
          warn("autofetch: failed to persist queued notice", persistError);
          await safeDelete(ctx.api as any, chatId, note.message_id);
        }
      }
    } catch (error) {
      warn("autofetch: failed to send queued notice", error);
    }
  }

  // Already have this song's file (and the user didn't bring their own, and
  // auto-get is on for them)? Re-send it — no deezload round-trip. The
  // telegraph stays live so the user can still send another file to replace.
  if (autoGetForUser && !hasAudio && trackRecord?.file_id) {
    log("track pipeline: reusing stored audio for track", trackId);
    const caption = await attachAudioAndPromptChannel(
      ctx.api,
      env.DB,
      chatId,
      requesterId,
      session,
      trackRecord.file_id,
      telegraphResult.url,
      trackName,
      artistName,
    );
    if (caption) {
      clearAudioState(session);
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

    // The user's chosen file becomes the canonical one for this track.
    try {
      await setTrackFileId(env.DB, trackId, pendingAudioFileId);
    } catch (error) {
      warn("track pipeline: failed to store audio file_id", error);
    }

    if (ctx.chat?.id && session.audio.messageId) {
      await safeDelete(ctx.api as any, ctx.chat.id, session.audio.messageId);
    }

    clearAudioState(session);
  }
}

// Enqueue a deezload auto-fetch job for this track, best-effort: any failure
// (toggle off, D1 error, bridge unconfigured, queue full) must not break the
// normal track pipeline. Returns the request token and queue position.
async function enqueueAutoFetch(
  env: Env,
  userId: string,
  chatId: number,
  trackId: number,
  trackName: string,
  artistName: string,
): Promise<{ token: string; position: number } | undefined> {
  try {
    if (!env.BRIDGE_CHAT_ID || !env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
      return undefined;
    }
    if (!(await isAutoFetchEnabled(env.DB))) {
      return undefined;
    }
    // Per-user opt-out (via /settings) on top of the global admin switch.
    if (!(await isUserAutoFetchEnabled(env.DB, userId))) {
      log("autofetch: user has auto-fetch off", userId);
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
    const position = await sendBridgeJob(env, token, trackId, chatId);
    log("autofetch: job queued", JSON.stringify({ trackId, token, position }));
    return { token, position };
  } catch (error) {
    warn("autofetch: enqueue failed", error);
    return undefined;
  }
}

// Hand the job to BridgeDO. Returns the reported queue position (1 = next).
async function sendBridgeJob(env: Env, token: string, trackId: number, chatId: number): Promise<number> {
  const stub = env.BRIDGE_DO.get(env.BRIDGE_DO.idFromName("bridge"));
  const res = await stub.fetch("https://bridge/enqueue", {
    method: "POST",
    body: JSON.stringify({ token, trackId, chatId }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; position?: number };
  if (!body.ok) {
    throw new Error(`bridge rejected job: ${body.error ?? res.status}`);
  }
  return body.position ?? 1;
}
