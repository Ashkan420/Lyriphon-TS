import { type MigrationState } from "../session/types";
import {
  setOutcome,
  listPending,
  setStatus,
  type ScanQueueRow,
} from "../db/scanQueue";
import { safeEditMarkup } from "../utils/telegram";
import { log, warn } from "../utils/logger";
import { Env } from "../env";
import { searchTracks, getTrack, getAlbum } from "../services/deezer";
import { getLyrics } from "../services/lrclib";
import { getTrackRecord, upsertTrack } from "../db/tracks";
import { createSongTelegraph } from "../services/telegraph";
import { normalizeLyrics } from "../utils/lyrics";

// The /migrate run: everything that decides WHICH post is next, WHAT it links
// to, and HOW the button gets attached.
//
// Deliberately free of Telegram I/O in its classification half so it can be
// tested without a network; the only call that ever reaches the channel is
// attachLyricsButton(), which uses editMessageReplyMarkup and nothing else.

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type ScanButton = { text: string; url?: string };

// What the bridge normalized out of one MTProto message before handing it to
// the classifier. Kept free of teleproto types so this file stays testable.
export type ScannedMessage = {
  messageId: number;
  kind: "audio" | "other";
  // Media-group id. Non-null means the post is part of an album — not a single
  // music file, so it is never offered (FR-012).
  groupId?: number | null;
  // False for a post the run's own admin did not make (FR-011).
  fromSelf?: boolean;
  // True when the post is a forward — never editable, never offered.
  forwarded?: boolean;
  // Caption or body text. Carries the Telegraph link on rich-delivery posts,
  // which have no inline keyboard at all (research S3).
  caption?: string;
  // Flattened inline-keyboard buttons, if any.
  buttons?: ScanButton[];
  audio?: { title?: string; performer?: string; fileName?: string } | null;
};

export type ClassifyResult =
  // Not a candidate at all: no row is written (FR-012, FR-011).
  | { kind: "ignore"; reason: "not_own_post" | "not_audio" | "media_group" | "forwarded" }
  // A row is written. 'skipped' for a post that already has the button, so it
  // is visible in the data but can never be offered (FR-013, SC-004).
  | {
      kind: "record";
      status: "pending" | "skipped";
      hasLyricsButton: boolean;
      existingUrl: string | null;
      existingMarkup: string | null;
      title: string | null;
      artist: string | null;
      fileName: string | null;
    };

// ---------------------------------------------------------------------------
// Classification (FR-011 – FR-014c)
// ---------------------------------------------------------------------------

function isHttpUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// A button is "the Lyrics button" when it says so. The check is on the inline
// keyboard only: a rich-delivery post carries its link in the body as a
// <tg-button>, which is a link, not a keyboard — such a post still qualifies
// and reuses its link rather than being skipped (research S3, FR-014c).
function isLyricsLabel(text?: string): boolean {
  return /\blyrics\b/i.test(text ?? "");
}

// Pull a telegra.ph (or any http) URL out of message text. Rich delivery
// embeds the link both as an anchor and as a <tg-button>, so either form
// resolves.
function findUrlInText(text?: string): string | null {
  if (!text) return null;
  const match = /https?:\/\/[^\s<>"')\]]+/i.exec(text);
  return match ? match[0] : null;
}

// The link a new button should point at (FR-014c): whatever link the post
// already carries, so no second page is ever created for the same song.
//
// Order: an explicitly-labelled Lyrics button, then a URL in the body (the
// rich case), then a lone URL button — a single link on a song post is the
// lyrics link by every convention this bot uses. Ambiguous multi-link posts
// return null, which routes the candidate to page creation instead of guessing.
export function extractLyricsUrl(
  buttons: ScanButton[] | undefined,
  caption?: string,
): string | null {
  const list = buttons ?? [];

  const labelled = list.find((b) => isLyricsLabel(b.text) && isHttpUrl(b.url));
  if (labelled?.url) return labelled.url;

  const fromText = findUrlInText(caption);
  if (fromText) return fromText;

  const urlButtons = list.filter((b) => isHttpUrl(b.url));
  if (urlButtons.length === 1 && urlButtons[0].url) return urlButtons[0].url;

  return null;
}

// Decide what a message means for the run. Pure: no I/O, no session, no API.
export function classifyScannedMessage(m: ScannedMessage): ClassifyResult {
  // A FORWARD is uneditable — Telegram answers "message can't be edited"
  // regardless of admin rights or age. Offering one would only burn a Yes and
  // report a failure the admin could never fix, so it never becomes a row.
  if (m.forwarded) return { kind: "ignore", reason: "forwarded" };

  // Only this admin's own posts (FR-011). Channel song posts are sent by the
  // bot account, so the bridge reports fromSelf for those.
  if (m.fromSelf === false) return { kind: "ignore", reason: "not_own_post" };

  // A single music file only (FR-012): an album is a media group, and anything
  // that is not an audio attachment is out.
  if (m.kind !== "audio" || !m.audio) return { kind: "ignore", reason: "not_audio" };
  if (m.groupId !== null && m.groupId !== undefined) {
    return { kind: "ignore", reason: "media_group" };
  }

  const buttons = m.buttons ?? [];
  const hasLyricsButton = buttons.some((b) => isLyricsLabel(b.text));
  const existingUrl = extractLyricsUrl(buttons, m.caption);

  // Capture the keyboard as JSON rows so the attach can MERGE into it rather
  // than replace it (FR-013a). Stored per row, flattened in extraction above.
  const existingMarkup = buttons.length
    ? JSON.stringify(buttons.map((b) => [b]))
    : null;

  return {
    kind: "record",
    status: hasLyricsButton ? "skipped" : "pending",
    hasLyricsButton,
    existingUrl,
    existingMarkup,
    title: m.audio.title ?? null,
    artist: m.audio.performer ?? null,
    fileName: m.audio.fileName ?? null,
  };
}

// ---------------------------------------------------------------------------
// The only channel write in this feature (FR-020, FR-025 – FR-027)
// ---------------------------------------------------------------------------

// Add the Lyrics row to the post's existing keyboard, in place.
//
// editMessageReplyMarkup's payload has no media, caption, parse_mode or
// entities field, so the audio, the caption (including the hidden Telegraph
// link and the U+200E inside it) and the post's position are untouched because
// the request never mentions them. There is deliberately no fallback here:
// editMessageMedia would have to re-supply media and caption, which is exactly
// what FR-026 forbids. On failure the caller records the candidate as failed
// (FR-029) and the post is left exactly as it was.
export async function attachLyricsButton(
  api: any,
  channelId: number,
  messageId: number,
  telegraphUrl: string,
  existingRows: ScanButton[][] = [],
): Promise<boolean> {
  const rows: ScanButton[][] = existingRows.map((row) => [...row]);
  rows.push([{ text: "Lyrics", url: telegraphUrl }]);

  const ok = await safeEditMarkup(api, channelId, messageId, { inline_keyboard: rows } as any);
  if (!ok) {
    warn("migrate: failed to attach Lyrics button", { channelId, messageId });
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Run transitions (data-model §5)
// ---------------------------------------------------------------------------

// Record the admin's answer. Returns false when the row was no longer pending
// — a stale tap or a double tap, which must neither change anything nor
// double-count the outcome.
export async function applyOutcome(
  db: D1Database,
  id: number,
  outcome: "added" | "declined" | "edited",
): Promise<boolean> {
  return setOutcome(db, id, outcome);
}

// Load the next pending candidate onto the run's cursor. Null means the queue
// is exhausted and the run is over.
export async function nextCandidate(
  db: D1Database,
  userId: string,
  channelId: string,
  migration: MigrationState,
): Promise<ScanQueueRow | null> {
  const pending = await listPending(db, userId, channelId);
  const next = pending[0] ?? null;
  migration.cursorId = next?.id;
  if (next) migration.phase = "pending";
  return next;
}

// Resolve a candidate that failed to attach: mark it failed so it is reported
// (FR-029) and excluded from re-offering, then keep going.
export async function markFailed(db: D1Database, id: number): Promise<void> {
  await setStatus(db, id, "failed");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// The confirmation keyboard (FR-017): exactly three choices.
//
// Each carries the scan_queue id of the candidate it belongs to. Without that,
// a stale double-tap arriving after the run advanced would resolve against
// whatever cursorId happens to be at that moment — the NEXT candidate — and
// silently change the wrong post. Carrying the id makes a stale tap checkable:
// it either matches the row still on screen or it is rejected as expired.
export function confirmationKeyboard(
  candidateId?: number,
): Array<Array<{ text: string; callback_data: string }>> {
  const suffix = candidateId === undefined ? "" : `_${candidateId}`;
  return [
    [
      { text: "✅ Yes", callback_data: `mig_yes${suffix}` },
      { text: "❌ No", callback_data: `mig_no${suffix}` },
    ],
    [
      { text: "✏️ Edit", callback_data: `mig_edit${suffix}` },
      // The automatic pick was the file's own tags guessed at — Research is
      // the escape when it guessed wrong: type a query, choose the track,
      // rebuild the page for THIS candidate. It never advances the run.
      { text: "🔎 Research", callback_data: `mig_research${suffix}` },
    ],
  ];
}

// Caption for the confirmation — the same quoted mono `track — artist` the
// channel post carries, so what the admin approves is what will be linked.
export function confirmationText(row: ScanQueueRow, index: number, total: number): string {
  const track = row.title ?? "Unknown track";
  const artist = row.artist ?? "Unknown artist";
  return [
    `*Post ${index} of ${total}* — add the Lyrics button?`,
    "",
    `\`${track} — ${artist}\``,
  ].join("\n");
}

// End-of-run summary (FR-031, FR-032).
export function summaryText(
  channelId: string,
  counts: { offered: number; added: number; declined: number; edited: number; failed: number },
): string {
  if (!counts.offered) {
    return [
      `Done — nothing to do.`,
      "",
      "Every music post in that channel already carries a Lyrics button, so there was nothing to change.",
    ].join("\n");
  }

  return [
    `*Done* — ${channelId}`,
    "",
    `${counts.offered} offered`,
    `${counts.added} given the button`,
    `${counts.declined} declined`,
    `${counts.edited} edited`,
    `${counts.failed} failed`,
    "",
    "Nothing was deleted or re-sent.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Building a page when the post has no link (US3 — FR-014, FR-014a–c)
// ---------------------------------------------------------------------------

// Title/artist straight off the file's own tags, with the same fallbacks the
// upload path uses (handlers/musicFile.ts): a filename becomes the title, and
// an "Artist - Title" filename is split so the artist is not lost.
//
// Exported because this is the part that decides WHAT gets searched — the rest
// of the chain is ordinary service calls.
export function deriveTitleArtist(input: {
  title?: string | null;
  artist?: string | null;
  fileName?: string | null;
}): { title: string; artist: string } {
  const filename = (input.fileName ?? "").trim();
  const base = filename.includes(".")
    ? filename.slice(0, filename.lastIndexOf("."))
    : filename;

  let title = (input.title ?? "").trim() || base || "";
  let artist = (input.artist ?? "").trim();

  if (!artist && title) {
    for (const sep of [" - ", " – ", "_-_"]) {
      if (title.includes(sep)) {
        const [maybeArtist, maybeTitle] = title.split(sep, 2);
        artist = maybeArtist.trim();
        title = maybeTitle.trim();
        break;
      }
    }
  }

  return { title, artist };
}

// ── Building a page when the post has no link (US3 — FR-014, FR-014a–c) ─────

// Resolve an already-chosen Deezer track into a Telegraph page.
//
// Shared by the automatic path (buildPageForAudio) and by the confirmation's
// Research button, where the admin picks the track themselves — same cache
// discipline, same page writer, same attribution.
export async function buildPageForTrack(
  env: Env,
  trackId: number,
  authorName = "Lyriphon",
  fallback: { title?: string; artist?: string } = {},
): Promise<{ url: string; trackId: number } | null> {
  const raw = (await getTrack(trackId)) as any;
  const trackName: string = raw?.title ?? fallback.title ?? "";
  const artistName: string = raw?.artist?.name ?? fallback.artist ?? "";
  const artistId: number = Number(raw?.artist?.id ?? 0);
  const albumName: string = raw?.album?.title ?? "";
  const albumId: number = Number(raw?.album?.id ?? 0);
  const albumCoverUrl: string = raw?.album?.cover_xl ?? raw?.album?.cover_big ?? "";

  let releaseDate = "Unknown";
  if (albumId) {
    try {
      const album = (await getAlbum(albumId)) as any;
      releaseDate = album?.release_date ?? "Unknown";
    } catch {
      // release date is cosmetic — a missing one must not fail the page
    }
  }

  // Cache first, exactly like the normal path: lyrics are stored ONLY when
  // found (constitution V / AGENTS.md rule 6).
  const record = await getTrackRecord(env.DB, trackId);
  let lyrics = "";
  if (record?.lyrics !== null && record?.lyrics !== undefined) {
    lyrics = normalizeLyrics(record.lyrics);
  } else {
    lyrics = (await getLyrics(trackName, artistName, albumName)) ?? "";
    if (lyrics) {
      await upsertTrack(env.DB, { trackId, title: trackName, artist: artistName, lyrics });
    } else {
      log("migrate: no lyrics for", JSON.stringify({ trackId, trackName, artistName }));
      // Not cached: a miss must never be remembered as "none" (rule 6).
    }
  }

  try {
    const created = await createSongTelegraph(env, {
      // Credited to whoever is running the migration — their page, their name.
      // The owner URL stays unset so /edit keeps treating it like any other
      // page of theirs (src/handlers/callbacks/search.ts does the same for the
      // owner's own pages).
      authorName,
      authorUrl: undefined,
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
    return { url: created.url, trackId };
  } catch (error) {
    warn("migrate: Telegraph page creation failed", error);
    return null;
  }
}

// Build a page straight from a file's own tags: search Deezer for the best
// match, then hand that track to buildPageForTrack. The run never asks anyone
// to pick — Research is what the confirmation offers when the pick is wrong.
//
// FR-014a: no audio is downloaded, uploaded or transferred — the file is never
// touched at any point. No file_id write, no bridge enqueue, no channel prompt,
// no "send a music file to attach the button" nudge.
export async function buildPageForAudio(
  env: Env,
  input: { title?: string | null; artist?: string | null; fileName?: string | null },
  // The admin's own name, not the bot's. Falls back to the bot when there is
  // nobody to credit.
  authorName = "Lyriphon",
): Promise<{ url: string; trackId?: number } | null> {
  const { title, artist } = deriveTitleArtist(input);
  if (!title) return null;

  const query = artist ? `${artist} ${title}`.trim() : title;
  const results = await searchTracks(query);
  if (!results?.length) {
    warn("migrate: no track found for", JSON.stringify({ query }));
    return null;
  }

  const first = results[0] as any;
  const trackId = Number(first?.id);
  if (!Number.isFinite(trackId)) return null;

  return buildPageForTrack(env, trackId, authorName, { title, artist });
}
