// Admin-only album search: selectable deezload-style album view → ONE rich
// album message.
//
// /album <deezload link | album id | query> → cover photo with one toggle
// row per song (tap to select, ✅ + primary style), GET ALL/GET SELECTED,
// and Back. Cache-first: selected tracks already holding a file_id in the
// tracks store are marked delivered on the spot. The bottom action enqueues
// only the MISSING tracks through the bridge, routed by the missing count:
// ≤ ALBUM_TRACK_THRESHOLD → one deezerttrack job per track (gentle on
// deezload); more → ONE deezertalbum job (deezload streams the whole album;
// unselected files are cached but excluded from the message); zero missing
// → no bridge job, assembly runs immediately from cache.
//
// Lyrics + Telegraph pages build lazily — one track per bridge-delivery
// webhook (the v1 upfront loop froze the bot); cached-only rows get their
// pages backfilled in small parallel chunks at assembly. When every
// selected track is terminal, the guarded batch flip assembles ONE rich
// message: cover + credit, then player + Lyrics button per track; failures
// render as deezload note lines.
//
// Never throws from the bridge-called paths (same 500-redelivery rule as
// handleBridgeUpdate).

import { Api, RawApi } from "grammy";
import { Context } from "grammy";
import { Env } from "../env";
import { log, warn } from "../utils/logger";
import { ALBUM_MAX_TRACKS, ALBUM_TRACK_THRESHOLD } from "../config";
import { safeAnswer, safeDelete } from "../utils/telegram";
import { isBotOwner } from "./admin";
import { searchAlbums, getAlbum } from "../services/deezer";
import { getLyrics } from "../services/lrclib";
import { createSongTelegraph } from "../services/telegraph";
import { normalizeLyrics } from "../utils/lyrics";
import { getTrackRecord, getTrackFileIds, setTrackFileId, upsertTrack } from "../db/tracks";
import {
  AudioRequestRow,
  createAudioRequest,
  getRequestsByAlbumToken,
  setRequestStatus,
  setRequestTelegraphUrl,
  expireBatchPending,
} from "../db/audioRequests";
import {
  createAlbumBatch,
  getAlbumBatch,
  hasPendingBatchForUser,
  markBatchComplete,
  setBatchAlbumMsg,
  setBatchFailureReason,
  setBatchSelected,
  setBatchStatusMsg,
} from "../db/albumBatches";
import { getSetting, setSetting, isAlbumSearchEnabled, getUserRichPosition, getUserRichColor } from "../db/settings";
import { buildAlbumRichMessage, RichPosition, RichColor } from "../utils/richMessages";

// Which deezload route a selection uses. Pure for tests.
export function routeForSelection(
  n: number,
  threshold = ALBUM_TRACK_THRESHOLD,
): "tracks" | "album" {
  return n <= threshold ? "tracks" : "album";
}

// Parse /album's argument: a deezload deep link, a bare `deezertalbum<id>`
// token, a bare album id, or a free-text query.
export function parseAlbumTarget(raw: string): { albumId: number } | { query: string } {
  const text = raw.trim();
  const match = text.match(/deezertalbum(\d+)/i);
  if (match) {
    return { albumId: Number(match[1]) };
  }
  if (/^\d+$/.test(text)) {
    return { albumId: Number(text) };
  }
  return { query: text };
}

// ── per-user selection/back state (session-free, like the rich picker) ─────

type AlbumPickState = { albumId: number; trackIds: number[]; ts: number };
type AlbumBackState = { query: string; ts: number };
const ALBUM_PICK_PREFIX = "pref_albumpick:";
const ALBUM_BACK_PREFIX = "pref_albumback:";
const ALBUM_STATE_FRESH_MS = 15 * 60_000;

async function readJsonState<T>(db: D1Database, key: string): Promise<T | null> {
  try {
    const raw = await getSetting(db, key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as T & { ts: number };
    if (!parsed || Date.now() - parsed.ts > ALBUM_STATE_FRESH_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readPickState(db: D1Database, userId: string): Promise<AlbumPickState | null> {
  return readJsonState<AlbumPickState>(db, `${ALBUM_PICK_PREFIX}${userId}`);
}

async function writePickState(db: D1Database, userId: string, state: AlbumPickState): Promise<void> {
  try {
    await setSetting(db, `${ALBUM_PICK_PREFIX}${userId}`, JSON.stringify(state));
  } catch (error) {
    warn("album: failed to persist pick state", error);
  }
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

  const arg = (ctx.message?.text ?? "").replace(/^\/album(@\S+)?\s*/i, "");
  const target = parseAlbumTarget(arg);
  if ("albumId" in target) {
    await openAlbumView(ctx, env, target.albumId);
    return;
  }
  if (!target.query) {
    await ctx.reply("Usage: <code>/album &lt;album name or deezload link&gt;</code>", { parse_mode: "HTML" });
    return;
  }

  // Remember the query so the view's Back can re-show this picker.
  const userId = String(ctx.from?.id ?? "");
  if (userId) {
    try {
      await setSetting(env.DB, `${ALBUM_BACK_PREFIX}${userId}`, JSON.stringify({ query: target.query, ts: Date.now() }));
    } catch (error) {
      warn("album: failed to persist back state", error);
    }
  }

  const results = await searchAlbums(target.query, 8);
  if (!results || !results.length) {
    await ctx.reply(`❌ No albums found for: ${target.query}`);
    return;
  }

  const rows = (results as any[]).slice(0, 8).map((a) => [
    {
      text: `${a.title} — ${a.artist?.name ?? "?"} (${a.nb_tracks ?? "?"})`,
      callback_data: `albumpick_${a.id}`,
    },
  ]);
  await ctx.reply(`💿 Albums matching “${target.query}” — pick one:`, {
    reply_markup: { inline_keyboard: rows },
  });
}

// ── album view (photo + selectable per-song rows) ──────────────────────────

type ViewButton = { text: string; callback_data?: string; url?: string; style?: string };

function buildViewKeyboard(albumId: number, tracks: any[], selected: Set<number>): ViewButton[][] {
  const keyboard = tracks.map((t) => {
    const isOn = selected.has(Number(t.id));
    const btn: ViewButton = {
      text: isOn ? `✅ ${t.title ?? "Unknown"}` : `🎵 ${t.title ?? "Unknown"}`,
      callback_data: `albumsong_${albumId}_${t.id}`,
    };
    if (isOn) {
      btn.style = "primary";
    }
    return [btn];
  });
  keyboard.push(
    selected.size
      ? [{ text: `⬇️ Get selected (${selected.size})`, callback_data: `album/${albumId}/down` }]
      : [{ text: "GET ALL⬇️", callback_data: `album/${albumId}/down` }],
  );
  keyboard.push([{ text: "⬅️ Back", callback_data: "albumview_back" }]);
  return keyboard;
}

function albumCaption(album: any, albumTitle: string, artistName: string, trackCount: number): string {
  return (
    `💿 <b>${escapeHtml(albumTitle)}</b>\n` +
    `👤 ${escapeHtml(artistName)}` +
    (album.release_date ? `\n📅 ${escapeHtml(String(album.release_date))}` : "") +
    `\n🎼 ${album.nb_tracks ?? trackCount} track(s)\n\n` +
    `<i>Tap songs to select, then Get selected — or GET ALL for everything.</i>`
  );
}

async function openAlbumView(ctx: Context, env: Env, albumId: number): Promise<void> {
  if (ctx.chat?.id === undefined) {
    return;
  }
  const chatId = ctx.chat.id;
  const album = (await getAlbum(albumId)) as any;
  if (!album) {
    await ctx.reply("❌ Couldn't load that album. Try again.");
    return;
  }

  const albumTitle = album.title ?? "Unknown Album";
  const artistName = album.artist?.name ?? "Unknown Artist";
  const coverUrl = album.cover_xl ?? album.cover_big ?? album.cover_medium ?? "";
  const tracks: any[] = (album.tracks?.data ?? []).slice(0, ALBUM_MAX_TRACKS);
  if (!tracks.length) {
    await ctx.reply("❌ That album has no tracks.");
    return;
  }

  const userId = String(ctx.from?.id ?? "");
  const pick = userId ? await readPickState(env.DB, userId) : null;
  const selected = new Set(pick && pick.albumId === albumId ? pick.trackIds : []);

  const caption = albumCaption(album, albumTitle, artistName, tracks.length);
  const keyboard = buildViewKeyboard(albumId, tracks, selected);
  try {
    if (coverUrl) {
      await ctx.api.sendPhoto(chatId, coverUrl, {
        caption,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard as any },
      });
    } else {
      await ctx.api.sendMessage(chatId, caption, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard as any },
      });
    }
  } catch (error) {
    warn("album: view send failed", error);
    await ctx.reply("❌ Couldn't render the album view. Try again.");
  }
}

// Callback entry for the picker.
export async function handleAlbumPickCallback(ctx: Context, env: Env): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const albumId = Number(data.replace("albumpick_", ""));
  if (!Number.isFinite(albumId)) {
    return;
  }
  if (!isBotOwner(ctx, env)) {
    await safeAnswer(ctx, "Admin only.");
    return;
  }
  await safeAnswer(ctx);
  await openAlbumView(ctx, env, albumId);
}

// Song-row toggle: flip the track in the per-user selection, re-render the
// view keyboard (the photo message stays; only reply_markup edits).
export async function handleAlbumSongToggle(ctx: Context, env: Env): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.replace("albumsong_", "").split("_");
  const albumId = Number(parts[0]);
  const trackId = Number(parts[1]);
  const userId = String(ctx.from?.id ?? "");
  const msgId = ctx.callbackQuery?.message?.message_id;
  const chatId = ctx.chat?.id;
  if (!Number.isFinite(albumId) || !Number.isFinite(trackId) || !userId || chatId === undefined) {
    return;
  }
  if (!isBotOwner(ctx, env)) {
    await safeAnswer(ctx, "Admin only.");
    return;
  }

  const pick = await readPickState(env.DB, userId);
  let trackIds: number[];
  if (!pick || pick.albumId !== albumId) {
    trackIds = [trackId];
  } else if (pick.trackIds.includes(trackId)) {
    trackIds = pick.trackIds.filter((id) => id !== trackId);
  } else {
    trackIds = [...pick.trackIds, trackId];
  }
  await writePickState(env.DB, userId, { albumId, trackIds, ts: Date.now() });
  await safeAnswer(ctx);

  // Re-render just the keyboard of the view message.
  const album = (await getAlbum(albumId)) as any;
  if (!album) {
    return;
  }
  const tracks: any[] = (album.tracks?.data ?? []).slice(0, ALBUM_MAX_TRACKS);
  try {
    await (ctx.api as any).editMessageReplyMarkup(chatId, msgId!, {
      reply_markup: { inline_keyboard: buildViewKeyboard(albumId, tracks, new Set(trackIds)) as any },
    });
  } catch {
    // "message is not modified" / stale view — fine.
  }
}

// Back on the album view: re-show the picker when the view came from a
// search; otherwise just delete the view.
export async function handleAlbumViewBack(ctx: Context, env: Env): Promise<void> {
  await safeAnswer(ctx);
  const msgId = ctx.callbackQuery?.message?.message_id;
  const chatId = ctx.chat?.id;
  const userId = String(ctx.from?.id ?? "");
  if (msgId !== undefined && chatId !== undefined) {
    await safeDelete(ctx.api as any, chatId, msgId);
  }

  const back = userId ? await readJsonState<AlbumBackState>(env.DB, `${ALBUM_BACK_PREFIX}${userId}`) : null;
  if (back?.query && chatId !== undefined) {
    try {
      const results = await searchAlbums(back.query, 8);
      if (results?.length) {
        const rows = (results as any[]).slice(0, 8).map((a) => [
          {
            text: `${a.title} — ${a.artist?.name ?? "?"} (${a.nb_tracks ?? "?"})`,
            callback_data: `albumpick_${a.id}`,
          },
        ]);
        await ctx.api.sendMessage(chatId, `💿 Albums matching “${back.query}” — pick one:`, {
          reply_markup: { inline_keyboard: rows },
        });
        return;
      }
    } catch (error) {
      warn("album: back re-search failed", error);
    }
  }
}

// ── GET ALL / GET SELECTED ─────────────────────────────────────────────────

export async function handleAlbumGetAll(ctx: Context, env: Env): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const albumId = Number(data.replace("album/", "").replace("/down", ""));
  const userId = String(ctx.from?.id ?? "");
  const chatId = ctx.chat?.id;
  log("album: getall click", JSON.stringify({ data, albumId, userId }));
  if (!Number.isFinite(albumId) || !userId || chatId === undefined) {
    return;
  }
  if (!isBotOwner(ctx, env)) {
    await safeAnswer(ctx, "Admin only.");
    return;
  }
  if (await hasPendingBatchForUser(env.DB, userId)) {
    await safeAnswer(ctx, "One album at a time — wait for the current run or cancel it.");
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
  const tracks: any[] = (album.tracks?.data ?? []).slice(0, ALBUM_MAX_TRACKS);
  if (!tracks.length) {
    await safeAnswer(ctx, "❌ That album has no tracks.");
    return;
  }

  // Selection: the user's picks for this album, or everything when empty.
  const pick = await readPickState(env.DB, userId);
  const selectedIds = pick && pick.albumId === albumId && pick.trackIds.length
    ? new Set(pick.trackIds)
    : new Set(tracks.map((t) => Number(t.id)));
  const selectedTracks = tracks.filter((t) => selectedIds.has(Number(t.id)));
  await safeAnswer(ctx);

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
      releaseDate: album.release_date ?? "Unknown",
      trackCount: tracks.length,
    });
    await setBatchSelected(env.DB, batchToken, [...selectedIds]);
  } catch (error) {
    warn("album: failed to create batch", error);
    await safeAnswer(ctx, "❌ Couldn't start the run (database error).");
    return;
  }

  // One status message with Cancel — no counters, no queue-position chrome
  // (that's deezload's own flow, not ours). Cache-first: tracks already in
  // the store need no fetch, so the message says what will actually happen.
  const total = tracks.length;
  const selectedCount = selectedTracks.length;
  const cachedFiles = await getTrackFileIds(env.DB, [...selectedIds]);
  const missingCount = selectedCount - cachedFiles.size;
  const status = await ctx.api.sendMessage(
    chatId,
    missingCount === 0
      ? `📦 ${selectedCount} of ${total} track(s) are already cached — assembling…`
      : `⏳ Fetching ${missingCount} of ${total} track(s) — the album message arrives when everything's ready.`,
    { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `albumcancel_${batchToken}` }]] } },
  );
  try {
    await setBatchStatusMsg(env.DB, batchToken, status.message_id);
  } catch (error) {
    warn("album: failed to persist status msg", error);
  }

  // One audio_requests row per album track (album order). Rows carry
  // album_token so the bridge handles them as batch files: no DM delivery,
  // no channel prompt — files only land in the final rich message (and the
  // tracks cache).
  const rowTokens: Array<{ trackId: number; token: string }> = [];
  for (const track of tracks) {
    const trackId = Number(track.id);
    if (!Number.isFinite(trackId)) continue;
    const token = crypto.randomUUID();
    rowTokens.push({ trackId, token });
    try {
      await createAudioRequest(env.DB, {
        reqToken: token,
        userId,
        chatId,
        trackId,
        trackTitle: track.title ?? "Unknown Track",
        artistName,
        albumToken: batchToken,
      });
    } catch (error) {
      warn("album: row creation failed", trackId, error);
      try {
        await setRequestStatus(env.DB, token, "failed");
      } catch {
        // ignore
      }
    }
  }

  const selectedRowTokens = rowTokens.filter((r) => selectedIds.has(r.trackId));

  // Cache-first: rows whose track already holds a file_id flip to delivered
  // immediately — no job, no forward, no re-download. Only the missing ones
  // enqueue, and the route threshold applies to the MISSING count.
  const cachedRowTokens: typeof selectedRowTokens = [];
  const missingRowTokens: typeof selectedRowTokens = [];
  for (const row of selectedRowTokens) {
    if (cachedFiles.has(row.trackId)) {
      try {
        await setRequestStatus(env.DB, row.token, "delivered");
        cachedRowTokens.push(row);
      } catch (error) {
        warn("album: cached-row flip failed", row.trackId, error);
        missingRowTokens.push(row); // fetch it the normal way instead
      }
    } else {
      missingRowTokens.push(row);
    }
  }
  if (cachedRowTokens.length) {
    log("album: cache hits", JSON.stringify({
      batchToken,
      cached: cachedRowTokens.length,
      missing: missingRowTokens.length,
    }));
  }

  let enqueueError: string | undefined;
  const route = routeForSelection(missingRowTokens.length);
  if (missingRowTokens.length === 0) {
    // Everything selected is already cached — no bridge job at all.
    log("album: all cached, assembling immediately", JSON.stringify({ batchToken, count: selectedCount }));
    await onAlbumProgress(env, batchToken);
    return;
  }
  if (route === "tracks") {
    // Gentle route: one deezerttrack job per MISSING track (≤ threshold).
    let enqueueFailures = 0;
    for (const row of missingRowTokens) {
      try {
        await enqueueBridgeJob(env, row.token, row.trackId, chatId);
      } catch (error) {
        warn("album: enqueue failed, marking track failed", row.trackId, error);
        try {
          await setRequestStatus(env.DB, row.token, "failed");
        } catch {
          // ignore
        }
        enqueueError = "some tracks couldn't be queued";
        enqueueFailures++;
      }
    }
    // If EVERY enqueue failed, no delivery will ever nudge assembly —
    // record why and call the guarded hook. It no-ops while any selected
    // row is still pending (partial failures keep flowing normally); when
    // it does assemble, the status message already carries the final
    // receipt and the "Started, but" edit below must not overwrite it.
    if (enqueueFailures > 0 && enqueueFailures === missingRowTokens.length) {
      try {
        await setBatchFailureReason(env.DB, batchToken, "the track jobs couldn't be queued");
      } catch {
        // ignore
      }
    }
    if (enqueueFailures > 0) {
      const finalized = await onAlbumProgress(env, batchToken);
      if (finalized) {
        log("album: track enqueues all failed, batch finalized", JSON.stringify({ batchToken }));
        return;
      }
    }
  } else {
    // Album route: ONE deezertalbum job; deezload streams the whole album
    // and files are paired by arrival order. Unselected tracks are cached
    // but excluded from the rich message. The expected stream count lets
    // the collector finish the moment the last ROW-covered audio arrives
    // instead of waiting out the quiet-period backstop (rows cover the
    // first ALBUM_MAX_TRACKS tracks; deezload's excess sends are simply
    // never forwarded).
    try {
      await enqueueBridgeAlbumJob(env, batchToken, albumId, chatId, tracks.length);
    } catch (error) {
      warn("album: album-route enqueue failed", albumId, error);
      // Fail every MISSING pending row — the assembly renders them as
      // deezload notes (cached rows stay delivered). Then nudge assembly so
      // the batch finalizes NOW instead of sitting pending until the guard
      // self-heals.
      for (const row of missingRowTokens) {
        try {
          await setRequestStatus(env.DB, row.token, "failed");
        } catch {
          // ignore
        }
      }
      try {
        await setBatchFailureReason(env.DB, batchToken, "the album job couldn't be queued");
      } catch {
        // ignore
      }
      const finalized = await onAlbumProgress(env, batchToken);
      if (finalized) {
        // The batch assembled and the status message already carries the
        // final failure receipt — don't overwrite it with the "Started, but"
        // edit below.
        log("album: album-route enqueue failed, batch finalized", JSON.stringify({ batchToken }));
        return;
      }
      enqueueError = "the album job couldn't be queued";
    }
  }

  if (enqueueError) {
    try {
      await ctx.api.editMessageText(
        chatId,
        status.message_id,
        `⚠️ Started, but ${enqueueError}. Failed tracks will show as deezload links.`,
        { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `albumcancel_${batchToken}` }]] } },
      );
    } catch {
      // edit races fine
    }
  }

  log("album: GET ALL enqueued", JSON.stringify({
    batchToken,
    albumId,
    route,
    selected: selectedTracks.length,
    cached: cachedRowTokens.length,
    missing: missingRowTokens.length,
    total,
  }));
}

// Hand a job to BridgeDO. Same contract as sendBridgeJob in
// callbacks/search.ts; the caller handles per-track failures inline.
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

// Album-route enqueue: one BridgeDO job carrying the album id. The job
// token = batch token, so lyq:albumfile tags resolve rows directly.
// expectedStreamCount = the album's track count — BridgeDO's collector
// finishes the stream as soon as that many audios arrived.
async function enqueueBridgeAlbumJob(
  env: Env,
  token: string,
  albumId: number,
  chatId: number,
  expectedStreamCount?: number,
): Promise<number> {
  const stub = env.BRIDGE_DO.get(env.BRIDGE_DO.idFromName("bridge"));
  const res = await stub.fetch("https://bridge/enqueue", {
    method: "POST",
    body: JSON.stringify({ token, trackId: 0, chatId, albumId, expectedCount: expectedStreamCount }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; position?: number };
  if (!body.ok) {
    throw new Error(`bridge rejected album job: ${body.error ?? res.status}`);
  }
  return body.position ?? 1;
}

// ── cancel ─────────────────────────────────────────────────────────────────

export async function handleAlbumCancel(ctx: Context, env: Env): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const batchToken = data.replace("albumcancel_", "");
  if (!batchToken) {
    return;
  }
  if (!isBotOwner(ctx, env)) {
    await safeAnswer(ctx, "Admin only.");
    return;
  }

  const batch = await getAlbumBatch(env.DB, batchToken);
  if (!batch || batch.status !== "pending") {
    await safeAnswer(ctx, "That run is already finished.");
    return;
  }

  await expireBatchPending(env.DB, batchToken);
  await safeAnswer(ctx, "Cancellation recorded — remaining files were skipped.");
  await onAlbumProgress(env, batchToken);
}

// ── lazy page build + assembly (called by the bridge) ──────────────────────

// Build lyrics + Telegraph for ONE delivered album track, inside its own
// delivery webhook. Failure → warn and return undefined (the player still
// renders, just without a Lyrics button).
async function buildTrackPageLazily(
  env: Env,
  row: AudioRequestRow,
  album: { title: string; coverUrl: string; releaseDate: string },
): Promise<string | undefined> {
  try {
    const trackName = row.track_title ?? "Unknown Track";
    const artistName = row.artist_name ?? "Unknown Artist";
    const record = await getTrackRecord(env.DB, row.track_id);
    let lyrics: string | null = record?.lyrics ?? null;
    if (lyrics !== null) {
      lyrics = normalizeLyrics(lyrics);
      // Heal backfilled rows like the single-track pipeline does.
      if (!record?.title || !record?.artist) {
        try {
          await upsertTrack(env.DB, { trackId: row.track_id, title: trackName, artist: artistName });
        } catch (error) {
          warn("album: lyrics heal write failed", error);
        }
      }
    } else {
      const fetched = (await getLyrics(trackName, artistName, album.title)) ?? "";
      if (fetched) {
        lyrics = fetched;
        try {
          await upsertTrack(env.DB, { trackId: row.track_id, title: trackName, artist: artistName, lyrics });
        } catch (error) {
          warn("album: lyrics cache write failed", error);
        }
      } else {
        lyrics = "";
      }
    }

    const buildPage = () => createSongTelegraph(env, {
      authorName: "Lyriphon",
      track: trackName,
      trackId: row.track_id,
      artist: artistName,
      artistId: 0,
      album: album.title,
      albumId: 0,
      albumCoverUrl: album.coverUrl,
      releaseDate: album.releaseDate,
      lyrics,
    });
    try {
      return (await buildPage()).url;
    } catch (error) {
      // Telegraph bursts fail occasionally (13 rapid builds in one album);
      // one retry after a short pause.
      warn("album: lazy page build failed, retrying once", row.track_id, error);
      await new Promise((r) => setTimeout(r, 1000));
      try {
        return (await buildPage()).url;
      } catch (retryError) {
        warn("album: lazy page build retry failed", row.track_id, retryError);
        return undefined;
      }
    }
  } catch (error) {
    warn("album: lazy page build failed", row.track_id, error);
    return undefined;
  }
}

// Selection helper: parse the batch's selected JSON (empty/garbage → all).
function parseSelected(batchSelected: string | null, rows: AudioRequestRow[]): Set<number> {
  try {
    const parsed = batchSelected ? (JSON.parse(batchSelected) as number[]) : null;
    if (parsed?.length) {
      return new Set(parsed);
    }
  } catch {
    // fall through
  }
  return new Set(rows.map((r) => r.track_id));
}

// Called by the bridge on an album-route file delivery (lyq:albumfile):
// pair the arrival index to the nth batch row, cache the file, build the
// page lazily for selected tracks, flip the row, nudge assembly.
export async function deliverAlbumFile(
  env: Env,
  batchToken: string,
  arrivalIndex: number,
  fileId: string,
): Promise<void> {
  try {
    const rows = await getRequestsByAlbumToken(env.DB, batchToken);
    const row = rows[arrivalIndex - 1];
    if (!row || row.status !== "pending") {
      warn("album: arrival has no pending row", batchToken, arrivalIndex);
      return;
    }
    const batch = await getAlbumBatch(env.DB, batchToken);
    if (!batch) {
      return;
    }

    // Cache the file for every track (selected or not — unselected files
    // from the album stream make future runs instant).
    try {
      await setTrackFileId(env.DB, row.track_id, fileId);
    } catch (error) {
      warn("album: file_id cache failed", row.track_id, error);
    }

    const selectedIds = parseSelected(batch.selected, rows);
    if (selectedIds.has(row.track_id)) {
      // Lazy page build: one track per webhook, so nothing freezes.
      const page = await buildTrackPageLazily(env, row, {
        title: batch.title,
        coverUrl: batch.cover_url,
        releaseDate: batch.release_date,
      });
      if (page) {
        await setRequestTelegraphUrl(env.DB, row.req_token, page);
      }
    }
    await setRequestStatus(env.DB, row.req_token, "delivered");
    await onAlbumProgress(env, batchToken);
  } catch (error) {
    warn("album: delivery handling failed", batchToken, arrivalIndex, error);
  }
}

// Per-track route (≤ threshold): the bridge's normal lyq:file delivery
// finds an album_token row — cache, lazy page, flip, nudge. (The album
// route uses deliverAlbumFile instead.)
export async function deliverSelectedTrackFile(env: Env, row: AudioRequestRow, fileId: string): Promise<void> {
  try {
    const batch = await getAlbumBatch(env.DB, row.album_token!);
    if (!batch) {
      return;
    }
    try {
      await setTrackFileId(env.DB, row.track_id, fileId);
    } catch (error) {
      warn("album: file_id cache failed", row.track_id, error);
    }
    const rows = await getRequestsByAlbumToken(env.DB, row.album_token!);
    const selectedIds = parseSelected(batch.selected, rows);
    if (selectedIds.has(row.track_id)) {
      const page = await buildTrackPageLazily(env, row, {
        title: batch.title,
        coverUrl: batch.cover_url,
        releaseDate: batch.release_date,
      });
      if (page) {
        await setRequestTelegraphUrl(env.DB, row.req_token, page);
      }
    }
    await setRequestStatus(env.DB, row.req_token, "delivered");
    await onAlbumProgress(env, row.album_token!);
  } catch (error) {
    warn("album: selected-track delivery failed", row?.track_id, error);
  }
}

// Called by the bridge when the album stream ends (lyq:albumdone): any
// selected row still pending never got a file — mark it failed so the
// batch can finalize.
export async function finishAlbumStream(env: Env, batchToken: string, count: number): Promise<void> {
  try {
    const batch = await getAlbumBatch(env.DB, batchToken);
    if (!batch || batch.status !== "pending") {
      return;
    }
    const rows = await getRequestsByAlbumToken(env.DB, batchToken);
    const selectedIds = parseSelected(batch.selected, rows);
    for (const row of rows) {
      if (row.status === "pending" && selectedIds.has(row.track_id)) {
        await setRequestStatus(env.DB, row.req_token, "failed");
      }
    }
    log("album: stream finished", JSON.stringify({ batchToken, count }));
    await onAlbumProgress(env, batchToken);
  } catch (error) {
    warn("album: stream finish failed", batchToken, error);
  }
}

// Called by the bridge when the album job fails outright (lyq:fail): every
// selected pending row failed.
export async function failAlbumBatch(env: Env, batchToken: string, reason?: string): Promise<void> {
  try {
    const batch = await getAlbumBatch(env.DB, batchToken);
    if (!batch || batch.status !== "pending") {
      return;
    }
    const rows = await getRequestsByAlbumToken(env.DB, batchToken);
    const selectedIds = parseSelected(batch.selected, rows);
    for (const row of rows) {
      if (row.status === "pending" && selectedIds.has(row.track_id)) {
        await setRequestStatus(env.DB, row.req_token, "failed");
      }
    }
    // Persist the reason: the zero-delivered assembly receipt shows WHY, not
    // just "0 of N" (onAlbumProgress would otherwise overwrite the edit
    // below with "Done — 0 of N").
    if (reason) {
      try {
        await setBatchFailureReason(env.DB, batchToken, reason);
      } catch {
        // best-effort
      }
    }
    // Put the reason on the status message too so the admin sees it
    // immediately (onAlbumProgress's final receipt repeats it).
    if (reason && batch.status_msg_id) {
      try {
        const api = new Api(env.BOT_TOKEN) as Api<RawApi>;
        await api.editMessageText(
          batch.chat_id,
          batch.status_msg_id,
          `❌ Album fetch failed: ${reason.slice(0, 300)}`,
        );
      } catch {
        // edit races fine
      }
    }
    await onAlbumProgress(env, batchToken);
  } catch (error) {
    warn("album: batch failure handling failed", batchToken, error);
  }
}

// Progress hook: called by the bridge after every album state change.
// Assembles when every selected row is terminal. Best-effort, never throws.
// Returns true when this caller flipped the batch and assembled (or at least
// consumed the flip) — callers use it to know the status receipt is final.
export async function onAlbumProgress(env: Env, albumToken: string): Promise<boolean> {
  try {
    const batch = await getAlbumBatch(env.DB, albumToken);
    if (!batch || batch.status !== "pending") {
      return false;
    }
    const rows = await getRequestsByAlbumToken(env.DB, albumToken);
    if (!rows.length) {
      return false;
    }

    const selectedIds = parseSelected(batch.selected, rows);
    const relevant = rows.filter((r) => selectedIds.has(r.track_id));
    if (!relevant.length) {
      return false;
    }
    if (!relevant.every((r) => r.status !== "pending")) {
      log("album: batch not yet complete", albumToken);
      return false;
    }

    // The guarded flip picks exactly one assembler.
    if (!(await markBatchComplete(env.DB, albumToken))) {
      return false;
    }

    // Backfill pages for cached-delivered rows: page builds normally happen
    // in the delivery webhook, but cache-first rows are flipped without one.
    // Parallel chunks of 4 keep the burst gentle on Telegraph (~5 waves for
    // a 20-track album).
    const albumForPages = {
      title: batch.title,
      coverUrl: batch.cover_url ?? "",
      releaseDate: batch.release_date ?? "Unknown",
    };
    const needPages = relevant.filter((r) => r.status === "delivered" && !r.telegraph_url);
    for (let i = 0; i < needPages.length; i += 4) {
      const chunk = needPages.slice(i, i + 4);
      await Promise.all(chunk.map(async (row) => {
        const page = await buildTrackPageLazily(env, row, albumForPages);
        if (page) {
          try {
            await setRequestTelegraphUrl(env.DB, row.req_token, page);
          } catch (error) {
            warn("album: page backfill persist failed", row.track_id, error);
          }
        }
      }));
    }
    // Fresh read: backfilled urls must be visible to the tracks[] assembly.
    const freshRows = needPages.length ? await getRequestsByAlbumToken(env.DB, albumToken) : rows;
    const relevantFresh = freshRows.filter((r) => selectedIds.has(r.track_id));

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

    const tracks: Array<{ trackName: string; trackId: number; telegraphUrl: string; fileId?: string }> = [];
    for (const row of relevantFresh) {
      let fileId: string | undefined;
      if (row.status === "delivered") {
        try {
          fileId = (await getTrackRecord(env.DB, row.track_id))?.file_id ?? undefined;
        } catch (error) {
          warn("album: file_id lookup failed", row.track_id, error);
        }
      }
      tracks.push({
        trackName: row.track_title ?? "Unknown Track",
        trackId: row.track_id,
        telegraphUrl: row.telegraph_url ?? "",
        fileId,
      });
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
    // Rich send with a hard fallback: a rejection here (e.g. one malformed
    // media entry) used to kill assembly AFTER the guarded flip — the batch
    // was complete in D1 but the status message stayed "⏳ Fetching"
    // forever, and Cancel correctly refused ("already finished"). The
    // fallback is a plain sendAudio per delivered track, which cannot be
    // poisoned by rich-html quirks.
    let sentMsgId: number | undefined;
    try {
      const msg = await (api as any).sendRichMessage(batch.chat_id, {
        html,
        media,
        skip_entity_detection: true,
      });
      sentMsgId = msg?.message_id;
    } catch (error) {
      warn("album: rich album send failed, falling back to plain audio sends", error);
    }
    if (sentMsgId) {
      await setBatchAlbumMsg(env.DB, albumToken, sentMsgId);
    } else {
      for (const track of tracks) {
        if (!track.fileId) continue;
        try {
          await api.sendAudio(batch.chat_id, track.fileId, {
            caption: `<b>${escapeHtml(track.trackName)}</b>`,
            parse_mode: "HTML",
          });
        } catch (error) {
          warn("album: plain fallback audio send failed", track.trackId, error);
        }
      }
    }

    const okCount = tracks.filter((t) => t.fileId).length;
    if (batch.status_msg_id) {
      try {
        const finalText = okCount === 0 && batch.failure_reason
          ? `❌ Album fetch failed: ${batch.failure_reason.slice(0, 300)}`
          : okCount === tracks.length
            ? `✅ Done — ${okCount} track(s) in the album message above.`
            : `⚠️ Done — ${okCount} of ${tracks.length} fetched; the rest are deezload links in the message above.`;
        await api.editMessageText(batch.chat_id, batch.status_msg_id, finalText);
      } catch {
        // edit races fine
      }
    }
    log("album: assembled", JSON.stringify({ albumToken, delivered: okCount, total: tracks.length }));
    return true;
  } catch (error) {
    warn("album: progress handling failed", albumToken, error);
    return false;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
