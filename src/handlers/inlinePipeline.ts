// Inline-mode track pipeline: runs the lyrics + music checklist on a message
// sent via inline mode. Triggered two ways, deduped by the in-flight map:
//   1. chosen_inline_result — the user just sent the result (auto-start).
//   2. the 📄 Get Lyrics button — a chatless callback, for when Telegram
//     drops/omits the chosen-result feedback or the user re-taps.
//
// Chatless sibling of callbacks/search.ts — the callback carries an
// inline_message_id and NO chat/session context, so this pipeline must
// never touch session.telegraph/session.audio (clobbering the sender's DM
// flow state is a bug, and in groups the "session" isn't even the sender's).
//
// Everything renders ON the inline message via the *Inline edit methods:
// the same rich checklist as the DM flow. End states:
//   - stored/cached audio → message morphs into the song (caption + Lyrics
//     button), exactly like the DM flow's card;
//   - auto-fetch on → Music file item queues a bridge job; the checklist
//     stays up and the bridge delivery morphs the message later;
//   - auto-fetch off / capped / bridge down → compact Telegraph card.
//
// Never throws (a rejection would 500 and make Telegram redeliver).

import { Context, Api } from "grammy";
import type { InlineKeyboardMarkup } from "@grammyjs/types";
import { Env } from "../env";
import { getTrack, getAlbum } from "../services/deezer";
import { getLyrics } from "../services/lrclib";
import { createSongTelegraph } from "../services/telegraph";
import { getTrackRecord, upsertTrack } from "../db/tracks";
import {
  countPendingByUser,
  createAudioRequest,
  expireStalePending,
  setRequestTelegraphUrl,
} from "../db/audioRequests";
import { isAutoFetchEnabled, isUserAutoFetchEnabled } from "../db/settings";
import { normalizeLyrics } from "../utils/lyrics";
import { buildAudioCaption, safeAnswer } from "../utils/telegram";
import {
  InlineTrackProgress,
  buildInlineResultHtml,
  countLyricLines,
} from "../utils/richMessages";
import { AUTOFETCH_MAX_PENDING_PER_USER } from "../config";
import { log, warn } from "../utils/logger";

// In-flight dedup: one pipeline run per inline message (per isolate). A
// second tap while a run is pending gets "Already working on it!" instead of
// racing the first run's edits.
const inFlight = new Map<string, Promise<void>>();

export async function handleInlineTrackButton(ctx: Context, env: Env) {
  const data = ctx.callbackQuery?.data ?? "";
  const inlineMessageId = ctx.callbackQuery?.inline_message_id;
  if (!inlineMessageId || !data.startsWith("track_")) {
    return;
  }

  const trackId = Number(data.replace("track_", ""));
  if (Number.isNaN(trackId)) {
    await safeAnswer(ctx);
    return;
  }

  log("inline pipeline: button tap", JSON.stringify({ trackId, inlineMessageId }));

  if (inFlight.has(inlineMessageId)) {
    await safeAnswer(ctx, "Already working on it!");
    return;
  }
  await safeAnswer(ctx);
  await startPipelineRun(env, {
    inlineMessageId,
    trackId,
    userId: String(ctx.from?.id ?? ""),
  });
}

// chosen_inline_result: the user just sent an inline result — auto-start the
// pipeline on the sent message. Only arrives when BotFather Inline Feedback
// is enabled (100%), and inline_message_id is only present because every
// result carries an inline keyboard. Best-effort: when the id is missing
// (clients vary), nothing happens and the Get Lyrics button stays as the
// manual fallback.
export async function handleChosenInlineResult(env: Env, chosen: any): Promise<void> {
  const inlineMessageId = chosen?.inline_message_id as string | undefined;
  if (!inlineMessageId) {
    return;
  }
  const trackId = Number(String(chosen?.result_id ?? "").replace("track_", ""));
  if (Number.isNaN(trackId)) {
    return;
  }

  log("inline pipeline: chosen result", JSON.stringify({ trackId, inlineMessageId }));
  // No answer to send here; if a run is already in flight (double fire with
  // an early button tap) the dedup below skips the duplicate.
  if (inFlight.has(inlineMessageId)) {
    return;
  }
  await startPipelineRun(env, {
    inlineMessageId,
    trackId,
    userId: String(chosen?.from?.id ?? ""),
  });
}

// Register and await a pipeline run, deduped per inline message (per
// isolate). Callers check inFlight for their own user-facing busy feedback.
async function startPipelineRun(
  env: Env,
  args: { inlineMessageId: string; trackId: number; userId: string },
): Promise<void> {
  const { inlineMessageId, trackId, userId } = args;

  const run = runInlineTrackPipeline(env, { inlineMessageId, trackId, userId })
    .catch((error) => warn("inline pipeline: run failed", error))
    .finally(() => inFlight.delete(inlineMessageId));
  inFlight.set(inlineMessageId, run);
  await run;
}

async function runInlineTrackPipeline(
  env: Env,
  args: { inlineMessageId: string; trackId: number; userId: string },
): Promise<void> {
  const { inlineMessageId, trackId, userId } = args;
  const api = new Api(env.BOT_TOKEN);

  const progress = new InlineTrackProgress(api, inlineMessageId);
  await progress.start();
  if (progress.isDead) {
    return;
  }

  const trackData = await getTrack(trackId) as any;
  if (!trackData) {
    log("inline pipeline: failed to fetch Deezer track", trackId);
    await progress.fail("❌ Failed to fetch track info. Try again later.");
    return;
  }

  const trackName = trackData.title ?? "Unknown Track";
  const artistName = trackData.artist?.name ?? "Unknown Artist";
  const artistId = trackData.artist?.id;
  const albumName = trackData.album?.title ?? "Unknown Album";
  const albumId = trackData.album?.id;
  log("inline pipeline: resolved", JSON.stringify({ trackId, trackName, artistName, albumName }));

  await progress.update({ stage: "metadata", trackName, artistName });

  let releaseDate = "Unknown";
  if (albumId) {
    const albumInfo = await getAlbum(albumId).catch(() => null);
    if (albumInfo) {
      releaseDate = (albumInfo as any).release_date ?? "Unknown";
    }
  }
  await progress.update({ stage: "lyrics", albumName, releaseDate });

  // Lyrics — same cache discipline as the DM flow: cache only when found,
  // heal rows missing title/artist.
  const trackRecord = await getTrackRecord(env.DB, trackId).catch(() => null);
  const cached = trackRecord?.lyrics ?? null;
  let lyrics: string;
  let lyricLineCount = 0;
  if (cached !== null) {
    lyrics = normalizeLyrics(cached);
    lyricLineCount = countLyricLines(lyrics);
    if (!trackRecord?.title || !trackRecord?.artist) {
      await upsertTrack(env.DB, { trackId, title: trackName, artist: artistName }).catch((error) =>
        warn("inline pipeline: metadata heal failed", error),
      );
    }
    log("inline pipeline: lyrics cache HIT for track", trackId);
  } else {
    lyrics = (await getLyrics(trackName, artistName, albumName).catch(() => "")) ?? "";
    if (lyrics) {
      lyricLineCount = countLyricLines(lyrics);
      await upsertTrack(env.DB, { trackId, title: trackName, artist: artistName, lyrics }).catch((error) =>
        warn("inline pipeline: lyrics cache write failed", error),
      );
      log("inline pipeline: lyrics cached for track", trackId);
    } else {
      log("inline pipeline: NO LYRICS found for", JSON.stringify({ trackId, trackName, artistName, albumName }));
    }
  }

  await progress.update({
    stage: "telegraph",
    lyricsNote: lyrics
      ? `${lyricLineCount} line${lyricLineCount === 1 ? "" : "s"}${cached !== null ? " (cached)" : ""}`
      : "not found",
  });

  let telegraphUrl: string | undefined;
  try {
    const telegraphResult = await createSongTelegraph(env, {
      authorName: "Lyriphon",
      track: trackName,
      trackId,
      artist: artistName,
      artistId,
      album: albumName,
      albumId,
      albumCoverUrl: trackData.album?.cover_xl ?? trackData.album?.cover_big ?? "",
      releaseDate,
      lyrics,
    });
    telegraphUrl = telegraphResult.url;
    log("inline pipeline: Telegraph created", telegraphUrl);
  } catch (error) {
    warn("inline pipeline: Telegraph creation failed", error);
  }

  if (!telegraphUrl) {
    await progress.fail("❌ Failed to create Telegraph page. Try again later.");
    return;
  }

  const lyricsKeyboard: InlineKeyboardMarkup = {
    inline_keyboard: [[{ text: "Lyrics", url: telegraphUrl }]],
  };

  // ── Music: cached file → auto-fetch → telegraph card ─────────────────────
  // Same gate order as the DM flow (callbacks/search.ts): bridge configured,
  // admin global switch, user preference. Shared pending cap.

  // Cache reuse: a stored file_id morphs the message into the song directly
  // (inline media edits accept previously-uploaded file_ids only).
  if (trackRecord?.file_id) {
    const caption = buildAudioCaption(trackName, artistName, telegraphUrl);
    const ok = await progress.finalizeAsAudio(trackRecord.file_id, caption, lyricsKeyboard);
    log("inline pipeline: reused stored audio", JSON.stringify({ trackId, ok }));
    return;
  }

  const bridgeConfigured = Boolean(env.BRIDGE_CHAT_ID && env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH);
  const autoGetForUser = bridgeConfigured
    && await isAutoFetchEnabled(env.DB).catch(() => false)
    && await isUserAutoFetchEnabled(env.DB, userId).catch(() => false);

  if (!autoGetForUser) {
    const ok = await progress.finalizeText(
      buildInlineResultHtml({ trackName, artistName, albumName, releaseDate, telegraphUrl }),
      lyricsKeyboard,
    );
    log("inline pipeline: done (telegraph card)", JSON.stringify({ trackId, finalized: ok }));
    return;
  }

  // Auto-fetch: claim a queue row for the bridge and leave the checklist up —
  // the bridge delivery morphs the message into the audio later.
  const queued = await enqueueInlineBridgeJob(env, {
    userId,
    trackId,
    trackName,
    artistName,
    inlineMessageId,
    telegraphUrl,
  }).catch((error) => {
    warn("inline pipeline: enqueue failed", error);
    return false;
  });

  if (!queued) {
    // Cap / queue full / bridge down: honest note + degrade to the card.
    await progress.update({ stage: "music", musicNote: "failed" });
    await progress.finalizeText(
      buildInlineResultHtml({ trackName, artistName, albumName, releaseDate, telegraphUrl }),
      lyricsKeyboard,
    );
    log("inline pipeline: done (card after queue failure)", JSON.stringify({ trackId }));
    return;
  }

  await progress.update({ stage: "music", musicNote: "queued" });
  log("inline pipeline: waiting for bridge delivery", JSON.stringify({ trackId, inlineMessageId }));
}

// Enqueue a deezload auto-fetch job for an inline send — inline variant of
// enqueueAutoFetch in callbacks/search.ts. chatId 0 marks a chatless (inline)
// row; delivery edits inline_message_id instead of DM-sending. Best-effort:
// any failure resolves false and the caller degrades to the telegraph card.
async function enqueueInlineBridgeJob(
  env: Env,
  data: {
    userId: string;
    trackId: number;
    trackName: string;
    artistName: string;
    inlineMessageId: string;
    telegraphUrl: string;
  },
): Promise<boolean> {
  // Materialize TTL expiry first so stale rows don't pin the user at the cap.
  await expireStalePending(env.DB);
  const pending = await countPendingByUser(env.DB, data.userId);
  if (pending >= AUTOFETCH_MAX_PENDING_PER_USER) {
    log("autofetch: user at pending cap", data.userId, pending);
    return false;
  }

  const token = crypto.randomUUID();
  await createAudioRequest(env.DB, {
    reqToken: token,
    userId: data.userId,
    chatId: 0,
    trackId: data.trackId,
    trackTitle: data.trackName,
    artistName: data.artistName,
    inlineMessageId: data.inlineMessageId,
  });
  // Bridge delivery builds its Lyrics button from the row.
  await setRequestTelegraphUrl(env.DB, token, data.telegraphUrl);

  const stub = env.BRIDGE_DO.get(env.BRIDGE_DO.idFromName("bridge"));
  const res = await stub.fetch("https://bridge/enqueue", {
    method: "POST",
    body: JSON.stringify({ token, trackId: data.trackId, chatId: 0 }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; position?: number };
  if (!body.ok) {
    throw new Error(`bridge rejected job: ${body.error ?? res.status}`);
  }
  log("autofetch: inline job queued", JSON.stringify({ trackId: data.trackId, token, position: body.position ?? 1 }));
  return true;
}
