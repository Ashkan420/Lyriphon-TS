// Inline-mode track pipeline: the 📄 Get Lyrics button on a message sent via
// inline mode. Chatless sibling of callbacks/search.ts — the callback carries
// an inline_message_id and NO chat/session context, so this pipeline must
// never touch session.telegraph/session.audio (clobbering the sender's DM
// flow state is a bug, and in groups the "session" isn't even the sender's).
//
// Everything renders ON the inline message via the *Inline edit methods:
// the same rich checklist as the DM flow, finalized into a compact Telegraph
// card with a Lyrics URL button. Music file support is deliberately absent
// (next step) — no bridge, no audio_requests, no DB schema changes.
//
// Never throws (a rejection would 500 and make Telegram redeliver).

import { Context, Api } from "grammy";
import type { InlineKeyboardMarkup } from "@grammyjs/types";
import { Env } from "../env";
import { getTrack, getAlbum } from "../services/deezer";
import { getLyrics } from "../services/lrclib";
import { createSongTelegraph } from "../services/telegraph";
import { getTrackRecord, upsertTrack } from "../db/tracks";
import { normalizeLyrics } from "../utils/lyrics";
import { safeAnswer } from "../utils/telegram";
import {
  InlineTrackProgress,
  buildInlineResultHtml,
  countLyricLines,
} from "../utils/richMessages";
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

  const existing = inFlight.get(inlineMessageId);
  if (existing) {
    await safeAnswer(ctx, "Already working on it!");
    return;
  }

  await safeAnswer(ctx);
  log("inline pipeline: button tap", JSON.stringify({ trackId, inlineMessageId }));

  const run = runInlineTrackPipeline(env, { inlineMessageId, trackId })
    .catch((error) => warn("inline pipeline: run failed", error))
    .finally(() => inFlight.delete(inlineMessageId));
  inFlight.set(inlineMessageId, run);
  await run;
}

async function runInlineTrackPipeline(
  env: Env,
  args: { inlineMessageId: string; trackId: number },
): Promise<void> {
  const { inlineMessageId, trackId } = args;
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

  const markup: InlineKeyboardMarkup = {
    inline_keyboard: [[{ text: "Lyrics", url: telegraphUrl }]],
  };
  const ok = await progress.finalizeText(
    buildInlineResultHtml({ trackName, artistName, albumName, releaseDate, telegraphUrl }),
    markup,
  );
  log("inline pipeline: done", JSON.stringify({ trackId, finalized: ok }));
}
