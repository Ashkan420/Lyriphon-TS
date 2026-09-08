// Admin-only album search: /album <query> → picker → per-track lyrics +
// Telegraph + bridge fetch → ONE assembled rich message with every player.
//
// Flow: the command enqueues all tracks into the normal audio_requests queue
// (album_token links each row to its album_batches run), then the bridge's
// delivery/failure handlers call assembleAlbumIfComplete — the batch row's
// guarded pending→complete flip picks exactly one assembler. Album rows skip
// the normal DM delivery: the fetched file only lands in the final message.
//
// Never throws from the bridge-called assembly path (same 500-redelivery
// rule as handleBridgeUpdate).

import { Api, RawApi } from "grammy";
import { Context } from "grammy";
import { Env } from "../env";
import { log, warn } from "../utils/logger";
import { DEEZLOAD_BOT, ALBUM_MAX_TRACKS } from "../config";
import { safeAnswer } from "../utils/telegram";
import { isBotOwner } from "./admin";
import { searchAlbums, getAlbum, getTrack } from "../services/deezer";
import { getLyrics } from "../services/lrclib";
import { createSongTelegraph } from "../services/telegraph";
import { normalizeLyrics } from "../utils/lyrics";
import { getTrackRecord, upsertTrack } from "../db/tracks";
import {
  createAudioRequest,
  getRequestsByAlbumToken,
  setRequestStatus,
  setRequestTelegraphUrl,
} from "../db/audioRequests";
import {
  createAlbumBatch,
  getAlbumBatch,
  hasPendingBatchForUser,
  markBatchComplete,
  setBatchAlbumMsg,
} from "../db/albumBatches";
import { isAlbumSearchEnabled, getUserRichPosition, getUserRichColor } from "../db/settings";
import { buildAlbumRichMessage, RichPosition, RichColor } from "../utils/richMessages";

// Hand a job to BridgeDO. Same contract as sendBridgeJob in
// callbacks/search.ts (kept separate: that one throws to its own pipeline's
// catch; here the caller handles per-track failures inline).
async function enqueueBridgeJob(env: Env, token: string, trackId: number, chatId: number): Promise<number> {
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

// ── /album command ──────────────────────────────────────────────────────────

export async function albumCommand(ctx: Context, env: Env): Promise<void> {
  if (!isBotOwner(ctx, env)) {
    return;
  }
  if (!(await isAlbumSearchEnabled(env.DB).catch(() => false))) {
    await ctx.reply("🎛 Album search is off — enable it in /admin.");
    return;
  }

  const query = (ctx.message?.text ?? "").replace(/^\/album(@\S+)?\s*/i, "").trim();
  if (!query) {
    await ctx.reply("Usage: <code>/album &lt;album name&gt;</code>", { parse_mode: "HTML" });
    return;
  }

  const results = await searchAlbums(query, 8);
  if (!results || !results.length) {
    await ctx.reply(`❌ No albums found for: ${query}`);
    return;
  }

  const rows = (results as any[]).slice(0, 8).map((a) => [
    {
      text: `${a.title} — ${a.artist?.name ?? "?"} (${a.nb_tracks ?? "?"})`,
      callback_data: `albumpick_${a.id}`,
    },
  ]);
  await ctx.reply(`💿 Albums matching “${query}” — pick one:`, {
    reply_markup: { inline_keyboard: rows },
  });
}

// ── album pick callback ─────────────────────────────────────────────────────

export async function handleAlbumPickCallback(ctx: Context, env: Env): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const albumId = Number(data.replace("albumpick_", ""));
  const userId = String(ctx.from?.id ?? "");
  const chatId = ctx.chat?.id;
  if (!Number.isFinite(albumId) || !userId || !chatId) {
    return;
  }
  await safeAnswer(ctx);

  if (!isBotOwner(ctx, env)) {
    await safeAnswer(ctx, "Admin only.");
    return;
  }
  if (await hasPendingBatchForUser(env.DB, userId)) {
    await safeAnswer(ctx, "One album at a time — wait for the current run to finish.");
    return;
  }

  const album = (await getAlbum(albumId)) as any;
  if (!album) {
    await safeAnswer(ctx, "❌ Couldn't load that album. Try again.");
    return;
  }

  const albumTitle = album.title ?? "Unknown Album";
  const artistName = album.artist?.name ?? "Unknown Artist";
  const coverUrl = album.cover_xl ?? album.cover_big ?? album.cover_medium ?? "";
  const releaseDate = album.release_date ?? "Unknown";
  const tracks: any[] = (album.tracks?.data ?? []).slice(0, ALBUM_MAX_TRACKS);
  if (!tracks.length) {
    await safeAnswer(ctx, "❌ That album has no tracks.");
    return;
  }

  const notice = await ctx.api.sendMessage(chatId, `⏳ Building “${albumTitle}” — ${tracks.length} track(s). This can take a while…`);
  const batchToken = crypto.randomUUID();

  try {
    await createAlbumBatch(env.DB, {
      batchToken,
      userId,
      chatId,
      albumId,
      title: albumTitle,
      artist: artistName,
      coverUrl,
      releaseDate,
      trackCount: tracks.length,
    });
  } catch (error) {
    warn("album: failed to create batch", error);
    await ctx.api.editMessageText(chatId, notice.message_id, "❌ Couldn't start the album run (database error).");
    return;
  }

  // Per track: lyrics (cache → LRCLIB) → Telegraph → queue row → bridge job.
  // Any per-track failure marks that track failed and moves on; the batch
  // assembles with a deezload note for it later.
  const authorName = ctx.from?.first_name ?? "Unknown User";
  const artistId = album.artist?.id;
  let queued = 0;
  for (const track of tracks) {
    const trackId = Number(track.id);
    const trackName = track.title ?? "Unknown Track";
    if (!Number.isFinite(trackId)) {
      continue;
    }

    let telegraphUrl: string | undefined;
    try {
      // Lyrics: cached-or-fetch, cache only when found (tracks-store rule).
      const record = await getTrackRecord(env.DB, trackId);
      let lyrics = record?.lyrics ?? null;
      if (lyrics !== null) {
        lyrics = normalizeLyrics(lyrics);
      } else {
        const fetched = (await getLyrics(trackName, artistName, albumTitle)) ?? "";
        if (fetched) {
          lyrics = fetched;
          try {
            await upsertTrack(env.DB, { trackId, title: trackName, artist: artistName, lyrics });
          } catch (error) {
            warn("album: lyrics cache write failed", error);
          }
        } else {
          lyrics = "";
        }
      }

      const page = await createSongTelegraph(env, {
        authorName,
        track: trackName,
        trackId,
        artist: artistName,
        artistId,
        album: albumTitle,
        albumId,
        albumCoverUrl: coverUrl,
        releaseDate,
        lyrics,
      });
      telegraphUrl = page.url;
    } catch (error) {
      warn("album: track page failed, queuing without telegraph", trackId, error);
    }

    const token = crypto.randomUUID();
    try {
      await createAudioRequest(env.DB, {
        reqToken: token,
        userId,
        chatId,
        trackId,
        trackTitle: trackName,
        artistName,
        albumToken: batchToken,
      });
      if (telegraphUrl) {
        await setRequestTelegraphUrl(env.DB, token, telegraphUrl);
      }
      await enqueueBridgeJob(env, token, trackId, chatId);
      queued++;
    } catch (error) {
      warn("album: enqueue failed, marking track failed", trackId, error);
      try {
        await setRequestStatus(env.DB, token, "failed");
      } catch (statusError) {
        warn("album: failed to mark enqueue failure", statusError);
      }
    }
  }

  const failedCount = tracks.length - queued;
  const summary = failedCount
    ? `✅ Queued ${queued}/${tracks.length} tracks (${failedCount} couldn't be queued — they'll show as deezload links).`
    : `✅ Queued all ${queued} tracks. The album message arrives here when every file is ready.`;
  try {
    await ctx.api.editMessageText(chatId, notice.message_id, summary);
  } catch (error) {
    warn("album: failed to edit queued notice", error);
  }
  log("album: batch enqueued", JSON.stringify({ batchToken, albumId, queued, total: tracks.length }));
}

// ── assembly (called from the bridge delivery/failure paths) ───────────────

// When every row of the batch is terminal, flip pending → complete (one
// winner) and send the assembled album rich message. Best-effort: any
// failure is logged, never thrown (bridge context).
export async function assembleAlbumIfComplete(env: Env, albumToken: string): Promise<void> {
  try {
    const batch = await getAlbumBatch(env.DB, albumToken);
    if (!batch || batch.status !== "pending") {
      return;
    }
    const rows = await getRequestsByAlbumToken(env.DB, albumToken);
    if (!rows.length) {
      return;
    }
    const terminal = (status: string) => status !== "pending";
    if (!rows.every((row) => terminal(row.status))) {
      log("album: batch not yet complete", albumToken);
      return;
    }

    // The guarded flip picks exactly one assembler.
    if (!(await markBatchComplete(env.DB, albumToken))) {
      return;
    }

    // Delivered rows read their file_id from the tracks store (the bridge
    // delivery wrote it before calling us). Missing file_id → deezload note.
    const tracks: Array<{ trackName: string; trackId: number; telegraphUrl: string; fileId?: string }> = [];
    for (const row of rows) {
      let fileId: string | undefined;
      if (row.status === "delivered") {
        try {
          fileId = (await getTrackRecord(env.DB, row.track_id))?.file_id ?? undefined;
        } catch (error) {
          warn("album: file_id lookup failed", row.track_id, error);
        }
      }
      if (fileId && row.telegraph_url) {
        tracks.push({
          trackName: row.track_title ?? "Unknown Track",
          trackId: row.track_id,
          telegraphUrl: row.telegraph_url,
          fileId,
        });
      } else {
        // No file (failed/expired) or no page — render the note line either
        // way; the deezload link covers both.
        tracks.push({
          trackName: row.track_title ?? "Unknown Track",
          trackId: row.track_id,
          telegraphUrl: row.telegraph_url ?? "",
        });
      }
    }

    let position: RichPosition = "center";
    let color: RichColor = "primary";
    try {
      [position, color] = await Promise.all([
        getUserRichPosition(env.DB, batch.user_id),
        getUserRichColor(env.DB, batch.user_id),
      ]);
    } catch {
      // defaults stand
    }

    const { html, media } = buildAlbumRichMessage({
      albumTitle: batch.title,
      artistName: batch.artist,
      coverUrl: batch.cover_url,
      tracks,
      position,
      color,
    });

    const api = new Api(env.BOT_TOKEN) as Api<RawApi>;
    const msg = await (api as any).sendRichMessage(batch.chat_id, {
      html,
      media,
      skip_entity_detection: true,
    });
    if (msg?.message_id) {
      await setBatchAlbumMsg(env.DB, albumToken, msg.message_id);
    }
    log("album: assembled", JSON.stringify({ albumToken, delivered: tracks.filter((t) => t.fileId).length, total: tracks.length }));
  } catch (error) {
    warn("album: assembly failed", albumToken, error);
  }
}
