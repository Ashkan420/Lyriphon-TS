// Owner-only DB browser: search/browse the D1 `tracks` cache, view a record,
// clear its file_id / lyrics (with confirmation), set lyrics manually, delete
// the row, and re-fetch lyrics from LRCLIB with a top-results picker.
//
// Deliberately NOT a SessionMode: the browser overlays any session state and
// must never clobber an active edit/search flow. All state lives in
// session.dbBrowser (always via dbBrowserOf — persisted sessions predate it).
// Callback prefix `dbview_` is routed in bot.ts next to the `admin_` branch.
//
// Rendering model: callback-driven screens edit the message the button lives
// on (viaEdit), so the browser walks one message through its views. Only the
// /db entry and a fresh search reply send a new message.

import { Context } from "grammy";
import { Env } from "../env";
import { SessionData, SessionMode } from "../session/types";
import {
  countTrackRows,
  countTrackStats,
  clearTrackFileId,
  clearTrackLyrics,
  deleteTrackRow,
  getTrackRecord,
  listTrackRows,
  searchTrackRows,
  setTrackLyrics,
  upsertTrack,
} from "../db/tracks";
import { getTrack } from "../services/deezer";
import { searchLyricsCandidates, searchLyricsCandidatesQuery } from "../services/lrclib";
import { normalizeLyrics } from "../utils/lyrics";
import { safeAnswer, safeDelete } from "../utils/telegram";
import { warn } from "../utils/logger";
import { escapeRichHtml } from "../utils/richMessages";
import { dbBrowserOf, resetDbBrowserInput } from "../session/flows";
import { isBotOwner } from "./admin";

const PAGE_SIZE = 5;
const LIST_TEXT_LIMIT = 60;
const LYRICS_PREVIEW_LINES = 6;
const LYRICS_PREVIEW_CHARS = 500;
const CANDIDATE_PREVIEW_LINES = 8;
const CANDIDATE_PREVIEW_CHARS = 400;

type BrowserButton = {
  text: string;
  callback_data: string;
  style?: "success" | "danger" | "primary";
};

function trunc(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function truncateLyricsPreview(lyrics: string, maxLines: number, maxChars: number): string {
  const lines = lyrics.replace(/\r\n/g, "\n").split("\n");
  const head = lines.slice(0, maxLines).join("\n");
  return trunc(head, maxChars);
}

function formatDate(unix: number | null | undefined): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ");
}

// ── Pure renderers (unit-tested) ────────────────────────────────────────────

export function buildBrowserHomeKeyboard(fromAdmin: boolean): BrowserButton[][] {
  const rows: BrowserButton[][] = [
    [
      { text: "🔍 Search", callback_data: "dbview_search" },
      { text: "🕒 Recent", callback_data: "dbview_list_p0" },
    ],
    [{ text: "🕳 Missing lyrics", callback_data: "dbview_missing_p0" }],
  ];
  if (fromAdmin) {
    rows.push([{ text: "⬅️ Back", callback_data: "admin_back" }]);
  } else {
    rows.push([{ text: "Close", callback_data: "dbview_close", style: "danger" }]);
  }
  return rows;
}

export function formatBrowserHomeText(stats: {
  total: number;
  withFileId: number;
  withLyrics: number;
}): string {
  return [
    "🗄 <b>Track cache</b>",
    "",
    `Rows: <b>${stats.total}</b>`,
    `🎧 With file_id: <b>${stats.withFileId}</b>`,
    `📝 With lyrics: <b>${stats.withLyrics}</b>`,
    "",
    "Search by title/artist (or a track id), or browse recently updated rows.",
  ].join("\n");
}

export function buildRowButton(row: {
  track_id: number;
  title: string | null;
  artist: string | null;
  file_id: string | null;
  lyrics: string | null;
}): BrowserButton {
  const title = row.title ?? "—";
  const artist = row.artist ?? "—";
  const marks = `${row.file_id ? "🎧" : ""}${row.lyrics ? "📝" : ""}`;
  return {
    text: trunc(`${title} — ${artist}${marks ? ` (${marks})` : ""}`, LIST_TEXT_LIMIT),
    callback_data: `dbview_t_${row.track_id}`,
  };
}

export function buildListNavRow(page: number, totalPages: number): BrowserButton[] {
  const row: BrowserButton[] = [];
  if (totalPages <= 1) {
    return row;
  }
  if (page > 0) {
    row.push({ text: "⬅️", callback_data: `dbview_p_${page - 1}` });
  }
  row.push({ text: `${page + 1}/${totalPages}`, callback_data: `dbview_p_${page}` });
  if (page < totalPages - 1) {
    row.push({ text: "➡️", callback_data: `dbview_p_${page + 1}` });
  }
  return row;
}

export function buildRecordKeyboard(row: {
  track_id: number;
  file_id: string | null;
  lyrics: string | null;
}): BrowserButton[][] {
  return [
    [
      { text: "🎧 Clear file_id", callback_data: `dbview_cf_${row.track_id}` },
      { text: "📝 Clear lyrics", callback_data: `dbview_cl_${row.track_id}` },
    ],
    [
      { text: "🔄 Re-fetch (LRCLIB)", callback_data: `dbview_rf_${row.track_id}` },
      { text: "✍️ Set lyrics", callback_data: `dbview_set_${row.track_id}` },
    ],
    [{ text: "🔍 Search LRCLIB (custom)", callback_data: `dbview_qs_${row.track_id}` }],
    [{ text: "🗑 Delete row", callback_data: `dbview_del_${row.track_id}`, style: "danger" as const }],
    [{ text: "⬅️ Back", callback_data: "dbview_back" }],
  ];
}

export function formatRecordText(row: {
  track_id: number;
  title: string | null;
  artist: string | null;
  file_id: string | null;
  lyrics: string | null;
  updated_at: number;
}): string {
  const title = escapeRichHtml(row.title ?? "—");
  const artist = escapeRichHtml(row.artist ?? "—");
  const lines: string[] = [
    `<b>${title}</b> — ${artist}`,
    `ID: <code>${row.track_id}</code>`,
    "",
    row.file_id
      ? `🎧 file_id: <b>cached</b> (<code>${escapeRichHtml(trunc(row.file_id, 16))}…</code>)`
      : "🎧 file_id: <i>none</i>",
  ];

  if (row.lyrics) {
    const lineCount = row.lyrics.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim()).length;
    lines.push(
      `📝 lyrics: <b>${lineCount} line${lineCount === 1 ? "" : "s"}</b>`,
      "",
      `<blockquote>${escapeRichHtml(truncateLyricsPreview(row.lyrics, LYRICS_PREVIEW_LINES, LYRICS_PREVIEW_CHARS))}</blockquote>`,
    );
  } else {
    lines.push("📝 lyrics: <i>none</i>");
  }

  lines.push("", `Updated: ${formatDate(row.updated_at)}`);
  return lines.join("\n");
}

export function buildConfirmKeyboard(kind: "fileid" | "lyrics" | "delete", trackId: number): BrowserButton[][] {
  const action = kind === "fileid" ? "cfy" : kind === "lyrics" ? "cly" : "dely";
  return [
    [
      { text: "✅ Confirm", callback_data: `dbview_${action}_${trackId}`, style: "danger" as const },
      { text: "⬅️ Cancel", callback_data: `dbview_t_${trackId}` },
    ],
  ];
}

export function formatConfirmText(
  kind: "fileid" | "lyrics" | "delete",
  row: { title: string | null; artist: string | null; track_id: number },
): string {
  const name = `${row.title ?? "—"} — ${row.artist ?? "—"}`;
  const what =
    kind === "fileid"
      ? "clear the cached file_id for"
      : kind === "lyrics"
        ? "clear the cached lyrics for"
        : "DELETE the whole row for";
  return [
    `⚠️ ${what}`,
    `<b>${escapeRichHtml(name)}</b>`,
    `ID: <code>${row.track_id}</code>`,
    "",
    "This cannot be undone.",
  ].join("\n");
}

export function buildCandidateButton(
  candidate: { trackName: string; albumName: string; source: string },
  index: number,
): BrowserButton {
  const album = candidate.albumName ? ` — ${candidate.albumName}` : "";
  const badge = candidate.source === "synced" ? " 🔁" : "";
  return {
    text: trunc(`${candidate.trackName}${album}${badge}`, LIST_TEXT_LIMIT),
    callback_data: `dbview_rc_${index}`,
  };
}

export function formatCandidatePreviewText(candidate: {
  trackName: string;
  artistName: string;
  albumName: string;
  source: string;
  lyrics: string;
}): string {
  return [
    `<b>${escapeRichHtml(candidate.trackName)}</b> — ${escapeRichHtml(candidate.artistName)}`,
    candidate.albumName ? `💽 ${escapeRichHtml(candidate.albumName)}` : null,
    candidate.source === "synced" ? "🔁 synced (timestamps stripped)" : "📝 plain",
    "",
    `<blockquote>${escapeRichHtml(truncateLyricsPreview(candidate.lyrics, CANDIDATE_PREVIEW_LINES, CANDIDATE_PREVIEW_CHARS))}</blockquote>`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// Custom-search mode list: same candidate buttons, but no album toggle
// (album scope doesn't apply to q= free-text searches); Back returns to the
// record the search was opened from.
function buildCustomCandidateKeyboard(db: { trackId?: number; candidates?: Array<{ trackName: string; albumName: string; source: string }> }): BrowserButton[][] {
  const keyboard: BrowserButton[][] = (db.candidates ?? []).map((candidate, idx) => [
    buildCandidateButton(candidate, idx),
  ]);
  keyboard.push([{ text: "⬅️ Back", callback_data: `dbview_t_${db.trackId ?? 0}` }]);
  return keyboard;
}

export async function dbCommand(ctx: Context, session: SessionData, env: Env): Promise<void> {
  if (!isBotOwner(ctx, env)) {
    return;
  }
  const db = dbBrowserOf(session);
  db.fromAdmin = false;
  db.fromCard = false;
  resetDbBrowserInput(db);
  db.query = undefined;
  db.trackId = undefined;
  await renderBrowserHome(ctx, session, env, false);
}

// admin_db case in handlers/admin.ts: browser home edits the admin message.
export async function openBrowserHomeFromAdmin(ctx: Context, session: SessionData, env: Env): Promise<void> {
  const db = dbBrowserOf(session);
  db.fromAdmin = true;
  db.fromCard = false;
  resetDbBrowserInput(db);
  db.query = undefined;
  db.trackId = undefined;
  await renderBrowserHome(ctx, session, env, true);
}

// ── Callback dispatch ───────────────────────────────────────────────────────

export async function handleDbViewCallback(ctx: Context, session: SessionData, env: Env): Promise<void> {
  if (!isBotOwner(ctx, env)) {
    return;
  }

  const data = ctx.callbackQuery?.data ?? "";
  const db = dbBrowserOf(session);

  if (data === "dbview_close") {
    await safeAnswer(ctx);
    await ctx.deleteMessage().catch(() => {});
    return;
  }

  if (data === "dbview_home") {
    await safeAnswer(ctx);
    db.query = undefined;
    db.fromCard = false;
    await renderBrowserHome(ctx, session, env, true);
    return;
  }

  if (data === "dbview_search") {
    await safeAnswer(ctx);
    db.awaitingQuery = true;
    const prompt = await ctx.reply("🔍 Send a title, artist, or track id to search the cache.", {
      reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: "dbview_qcancel", style: "danger" as const }]] },
    });
    db.promptId = prompt.message_id;
    return;
  }

  if (data === "dbview_qcancel") {
    db.awaitingQuery = false;
    db.awaitingCustomSearch = false;
    db.promptId = undefined;
    await ctx.answerCallbackQuery({ text: "Search cancelled" }).catch(() => {});
    try {
      await ctx.editMessageText("Search cancelled.");
    } catch {}
    return;
  }

  if (data.startsWith("dbview_list_p")) {
    // Recent-browse entry point: any prior search is abandoned.
    await safeAnswer(ctx);
    db.query = undefined;
    db.listFilter = "all";
    db.fromCard = false;
    await renderList(ctx, session, env, Number(data.slice("dbview_list_p".length)) || 0, true);
    return;
  }

  if (data.startsWith("dbview_missing_p")) {
    // Fill-the-gaps browse: rows whose lyrics column is NULL.
    await safeAnswer(ctx);
    db.query = undefined;
    db.listFilter = "missing";
    db.fromCard = false;
    await renderList(ctx, session, env, Number(data.slice("dbview_missing_p".length)) || 0, true);
    return;
  }

  if (data.startsWith("dbview_p_")) {
    await safeAnswer(ctx);
    await renderList(ctx, session, env, Number(data.slice("dbview_p_".length)) || 0, true);
    return;
  }

  if (data.startsWith("dbview_t_")) {
    await safeAnswer(ctx);
    db.trackId = Number(data.slice("dbview_t_".length));
    await renderRecord(ctx, session, env, db.trackId, true);
    return;
  }

  if (data.startsWith("dbview_card_")) {
    // 🛠 Cache tools from a Telegraph card: open the record tools for that
    // track in a NEW message — the card and its edit menu stay untouched.
    await safeAnswer(ctx);
    const trackId = Number(data.slice("dbview_card_".length));
    db.trackId = trackId;
    db.fromCard = true;
    db.fromAdmin = false;
    db.query = undefined;
    db.listFilter = undefined;
    resetDbBrowserInput(db);
    await renderRecord(ctx, session, env, trackId, false);
    return;
  }

  if (data === "dbview_back") {
    await safeAnswer(ctx);
    if (db.fromCard) {
      // Card mode has no list to go back to — close the tools message.
      db.fromCard = false;
      db.trackId = undefined;
      await ctx.deleteMessage().catch(() => {});
      return;
    }
    if (db.query) {
      await renderList(ctx, session, env, db.page ?? 0, true);
    } else {
      await renderBrowserHome(ctx, session, env, true);
    }
    return;
  }

  if (data.startsWith("dbview_cf_")) {
    await safeAnswer(ctx);
    await renderConfirm(ctx, session, env, "fileid", Number(data.slice("dbview_cf_".length)));
    return;
  }

  if (data.startsWith("dbview_cfy_")) {
    const trackId = Number(data.slice("dbview_cfy_".length));
    try {
      await clearTrackFileId(env.DB, trackId);
    } catch (error) {
      warn("dbview: clear file_id failed", error);
      await safeAnswer(ctx, "❌ Database error.");
      return;
    }
    await ctx.answerCallbackQuery({ text: "🎧 file_id cleared" }).catch(() => {});
    await renderRecord(ctx, session, env, trackId, true);
    return;
  }

  if (data.startsWith("dbview_cl_")) {
    await safeAnswer(ctx);
    await renderConfirm(ctx, session, env, "lyrics", Number(data.slice("dbview_cl_".length)));
    return;
  }

  if (data.startsWith("dbview_cly_")) {
    const trackId = Number(data.slice("dbview_cly_".length));
    try {
      await clearTrackLyrics(env.DB, trackId);
    } catch (error) {
      warn("dbview: clear lyrics failed", error);
      await safeAnswer(ctx, "❌ Database error.");
      return;
    }
    // Clearing the cache under a live Telegraph page: drop the session-side
    // lyrics/translation state so the edit menu doesn't resurrect them.
    const lastData = session.telegraph.data as { trackId?: number } | undefined;
    if (lastData?.trackId === trackId) {
      session.telegraph.originalLyrics = undefined;
      session.telegraph.translatedLyrics = undefined;
      session.telegraph.activeLang = undefined;
      session.telegraph.languageAnalysis = undefined;
    }
    await ctx.answerCallbackQuery({ text: "📝 lyrics cleared" }).catch(() => {});
    await renderRecord(ctx, session, env, trackId, true);
    return;
  }

  if (data.startsWith("dbview_del_")) {
    await safeAnswer(ctx);
    await renderConfirm(ctx, session, env, "delete", Number(data.slice("dbview_del_".length)));
    return;
  }

  if (data.startsWith("dbview_dely_")) {
    const trackId = Number(data.slice("dbview_dely_".length));
    try {
      await deleteTrackRow(env.DB, trackId);
    } catch (error) {
      warn("dbview: delete row failed", error);
      await safeAnswer(ctx, "❌ Database error.");
      return;
    }
    await ctx.answerCallbackQuery({ text: "🗑 Row deleted" }).catch(() => {});
    db.query = undefined;
    db.trackId = undefined;
    await renderBrowserHome(ctx, session, env, true);
    return;
  }

  if (data.startsWith("dbview_set_")) {
    const trackId = Number(data.slice("dbview_set_".length));
    if (session.mode === SessionMode.EDIT_FIELD || session.mode === SessionMode.EDIT_LYRICS) {
      await safeAnswer(ctx, "Finish the active edit session first.");
      return;
    }
    await safeAnswer(ctx);
    db.trackId = trackId;
    db.collectingLyrics = true;
    db.awaitingQuery = false;
    db.buffer = [];
    db.messageIds = [];
    const prompt = await ctx.reply(
      `✍️ Send the new lyrics for track <code>${trackId}</code>.\n\n• You can send multiple messages\n• Click Done when finished`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Done", callback_data: "dbview_ldone", style: "success" as const }],
            [{ text: "Cancel", callback_data: "dbview_lcancel", style: "danger" as const }],
          ],
        },
      },
    );
    db.promptId = prompt.message_id;
    return;
  }

  if (data.startsWith("dbview_qs_")) {
    // Custom LRCLIB search: free-text q= lookup, then pick from candidates.
    const trackId = Number(data.slice("dbview_qs_".length));
    if (session.mode === SessionMode.EDIT_FIELD || session.mode === SessionMode.EDIT_LYRICS) {
      await safeAnswer(ctx, "Finish the active edit session first.");
      return;
    }
    await safeAnswer(ctx);
    db.trackId = trackId;
    db.awaitingCustomSearch = true;
    db.awaitingQuery = false;
    const prompt = await ctx.reply(
      `🔍 Send any text to search LRCLIB for track <code>${trackId}</code> (title, artist, or a lyric line):`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: "dbview_qcancel", style: "danger" as const }]] },
      },
    );
    db.promptId = prompt.message_id;
    return;
  }

  if (data === "dbview_ldone") {
    await finishManualLyrics(ctx, session, env);
    return;
  }

  if (data === "dbview_lcancel") {
    if (!db.collectingLyrics) {
      await safeAnswer(ctx);
      return;
    }
    const { messageIds } = db;
    resetDbBrowserInput(db);
    const cid = ctx.chat?.id;
    if (cid) {
      for (const msgId of messageIds) {
        await safeDelete(ctx.api as any, cid, msgId);
      }
    }
    await ctx.answerCallbackQuery({ text: "Cancelled" }).catch(() => {});
    // The cancel button lives on the latest prompt — turn it into the record.
    if (db.trackId !== undefined) {
      await renderRecord(ctx, session, env, db.trackId, true);
    }
    return;
  }

  if (data.startsWith("dbview_rf_")) {
    await safeAnswer(ctx);
    await renderCandidates(ctx, session, env, Number(data.slice("dbview_rf_".length)), false);
    return;
  }

  if (data.startsWith("dbview_rfa_")) {
    await safeAnswer(ctx);
    await renderCandidates(ctx, session, env, Number(data.slice("dbview_rfa_".length)), true);
    return;
  }

  if (data === "dbview_rlist") {
    // Back to results from a preview — re-render from session, no re-search.
    if (!db.candidates?.length) {
      await safeAnswer(ctx, "Results expired — re-fetch first.");
      return;
    }
    await safeAnswer(ctx);
    await renderCandidateList(ctx, session, true);
    return;
  }

  if (data.startsWith("dbview_rc_")) {
    await safeAnswer(ctx);
    await renderCandidatePreview(ctx, session, Number(data.slice("dbview_rc_".length)));
    return;
  }

  if (data.startsWith("dbview_ru_")) {
    await applyCandidate(ctx, session, env, Number(data.slice("dbview_ru_".length)));
    return;
  }
}

// ── Render helpers ──────────────────────────────────────────────────────────

async function renderBrowserHome(ctx: Context, session: SessionData, env: Env, viaEdit: boolean): Promise<void> {
  const db = dbBrowserOf(session);
  let stats = { total: 0, withFileId: 0, withLyrics: 0 };
  try {
    stats = await countTrackStats(env.DB);
  } catch (error) {
    warn("dbview: stats failed", error);
  }
  const markup = { inline_keyboard: buildBrowserHomeKeyboard(db.fromAdmin ?? false) };
  try {
    if (viaEdit) {
      await ctx.editMessageText(formatBrowserHomeText(stats), { parse_mode: "HTML", reply_markup: markup });
    } else {
      await ctx.reply(formatBrowserHomeText(stats), { parse_mode: "HTML", reply_markup: markup });
    }
  } catch {
    // "message is not modified" and edit races — same as admin panel.
  }
}

async function renderList(ctx: Context, session: SessionData, env: Env, page: number, viaEdit: boolean): Promise<void> {
  const db = dbBrowserOf(session);
  db.page = page;
  const query = db.query;
  const filter = query ? undefined : { missingLyrics: db.listFilter === "missing" };

  let rows: Awaited<ReturnType<typeof listTrackRows>> = [];
  let total = 0;
  try {
    [rows, total] = await Promise.all([
      query
        ? searchTrackRows(env.DB, query, PAGE_SIZE, page * PAGE_SIZE)
        : listTrackRows(env.DB, PAGE_SIZE, page * PAGE_SIZE, filter),
      countTrackRows(env.DB, query, filter),
    ]);
  } catch (error) {
    warn("dbview: list failed", error);
    // Message contexts have no callback to answer — surface visibly.
    if (viaEdit) {
      await safeAnswer(ctx, "❌ Database error.");
    } else {
      try { await ctx.reply("❌ Database error."); } catch {}
    }
    return;
  }

  if (!rows.length) {
    const text = query
      ? `No cache rows match <code>${escapeRichHtml(query)}</code>.`
      : filter?.missingLyrics
        ? "Every cached row has lyrics 🎉"
        : "The track cache is empty.";
    const markup = { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "dbview_home" }]] };
    try {
      if (viaEdit) {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: markup });
      } else {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: markup });
      }
    } catch {}
    return;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const keyboard: BrowserButton[][] = rows.map((row) => [buildRowButton(row)]);
  const nav = buildListNavRow(page, totalPages);
  if (nav.length) {
    keyboard.push(nav);
  }
  keyboard.push([
    { text: "🔍 Search", callback_data: "dbview_search" },
    { text: "⬅️ Home", callback_data: "dbview_home" },
  ]);

  const header = query
    ? `🗄 Results for <code>${escapeRichHtml(query)}</code> (${total} row${total === 1 ? "" : "s"}):`
    : filter?.missingLyrics
      ? `🕳 Rows without lyrics (${total}):`
      : `🗄 Recent rows (${total} total):`;
  const markup = { inline_keyboard: keyboard };
  try {
    if (viaEdit) {
      await ctx.editMessageText(header, { parse_mode: "HTML", reply_markup: markup });
    } else {
      await ctx.reply(header, { parse_mode: "HTML", reply_markup: markup });
    }
  } catch {
    // edit races
  }
}

async function renderRecord(ctx: Context, session: SessionData, env: Env, trackId: number, viaEdit: boolean): Promise<void> {
  let row = null;
  try {
    row = await getTrackRecord(env.DB, trackId);
  } catch (error) {
    warn("dbview: record read failed", error);
  }
  if (!row) {
    await safeRenderNotFound(ctx, viaEdit);
    return;
  }
  try {
    if (viaEdit) {
      await ctx.editMessageText(formatRecordText(row), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buildRecordKeyboard(row) },
      });
    } else {
      await ctx.reply(formatRecordText(row), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buildRecordKeyboard(row) },
      });
    }
  } catch {
    // edit races
  }
}

async function safeRenderNotFound(ctx: Context, viaEdit: boolean): Promise<void> {
  const markup = { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "dbview_home" }]] };
  try {
    if (viaEdit) {
      await ctx.editMessageText("❌ Row not found (already deleted?)", { reply_markup: markup });
    } else {
      await ctx.reply("❌ Row not found (already deleted?)", { reply_markup: markup });
    }
  } catch {}
}

async function renderConfirm(
  ctx: Context,
  session: SessionData,
  env: Env,
  kind: "fileid" | "lyrics" | "delete",
  trackId: number,
): Promise<void> {
  let row = null;
  try {
    row = await getTrackRecord(env.DB, trackId);
  } catch (error) {
    warn("dbview: confirm read failed", error);
  }
  if (!row) {
    await safeRenderNotFound(ctx, true);
    return;
  }
  try {
    await ctx.editMessageText(formatConfirmText(kind, row), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildConfirmKeyboard(kind, trackId) },
    });
  } catch {
    // edit races
  }
}

async function renderCandidates(
  ctx: Context,
  session: SessionData,
  env: Env,
  trackId: number,
  toggleAlbumMode: boolean,
): Promise<void> {
  const db = dbBrowserOf(session);
  db.trackId = trackId;
  const albumMode = toggleAlbumMode ? !(db.albumMode ?? true) : (db.albumMode ?? true);
  db.albumMode = albumMode;

  let row = null;
  try {
    row = await getTrackRecord(env.DB, trackId);
  } catch (error) {
    warn("dbview: refetch read failed", error);
  }
  if (!row) {
    await safeRenderNotFound(ctx, true);
    return;
  }

  let trackName = row.title ?? "";
  let artistName = row.artist ?? "";
  let albumName: string | undefined;

  // One Deezer lookup covers both needs: missing metadata (healed below) and
  // the album title for the album-scoped search.
  const needsTrackData = !trackName || !artistName || albumMode;
  let trackData: any = null;
  if (needsTrackData) {
    try {
      trackData = await getTrack(trackId);
    } catch (error) {
      warn("dbview: Deezer lookup failed", error);
    }
  }

  if (!trackName || !artistName) {
    if (!trackData?.title || !trackData?.artist?.name) {
      await safeAnswer(ctx, "❌ No title/artist for this track — request the song once so the cache fills.");
      return;
    }
    trackName = trackData.title;
    artistName = trackData.artist.name;
    // Metadata heal — lyrics intentionally untouched.
    try {
      await upsertTrack(env.DB, { trackId, title: trackName, artist: artistName });
    } catch (error) {
      warn("dbview: metadata heal failed", error);
    }
  }
  if (albumMode) {
    albumName = trackData?.album?.title;
  }

  let candidates;
  try {
    // LRCLIB can take seconds; flip the screen to a spinner first.
    try {
      await ctx.editMessageText(
        `🔄 Searching LRCLIB for <b>${escapeRichHtml(trackName)}</b> — ${escapeRichHtml(artistName)}…`,
        { parse_mode: "HTML" },
      );
    } catch {}
    candidates = await searchLyricsCandidates(trackName, artistName, albumName);
  } catch (error) {
    warn("dbview: LRCLIB search failed", error);
    await safeAnswer(ctx, "❌ Lyrics lookup failed (rate limit?). Try again.");
    return;
  }

  db.candidates = candidates;

  const scopeNote = albumMode ? " (album filter on)" : "";
  if (!candidates.length) {
    try {
      await ctx.editMessageText(
        `No LRCLIB results for <b>${escapeRichHtml(trackName)}</b> — ${escapeRichHtml(artistName)}${scopeNote}.`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "💽 Toggle album filter", callback_data: `dbview_rfa_${trackId}` }],
              [{ text: "⬅️ Back", callback_data: `dbview_t_${trackId}` }],
            ],
          },
        },
      );
    } catch {}
    return;
  }

  await renderCandidateList(ctx, session, true);
}

// Candidates list from session state (used by fresh search and Back-to-results).
async function renderCandidateList(ctx: Context, session: SessionData, viaEdit: boolean): Promise<void> {
  const db = dbBrowserOf(session);
  const candidates = db.candidates ?? [];
  const trackId = db.trackId;
  if (!candidates.length || trackId === undefined) {
    await safeAnswer(ctx, "Results expired — re-fetch first.");
    return;
  }

  const keyboard: BrowserButton[][] = candidates.map((candidate, idx) => [buildCandidateButton(candidate, idx)]);
  if (db.customQuery) {
    // Free-text mode: album scope doesn't apply to q= searches.
    keyboard.push([{ text: "⬅️ Back", callback_data: `dbview_t_${trackId}` }]);
  } else {
    keyboard.push([
      {
        text: (db.albumMode ?? true) ? "💽 Album filter: ON" : "💽 Album filter: OFF",
        callback_data: `dbview_rfa_${trackId}`,
      },
      { text: "⬅️ Back", callback_data: `dbview_t_${trackId}` },
    ]);
  }

  const markup = { inline_keyboard: keyboard };
  try {
    if (viaEdit) {
      await ctx.editMessageText("🔄 LRCLIB results — pick one:", { reply_markup: markup });
    } else {
      await ctx.reply("🔄 LRCLIB results — pick one:", { reply_markup: markup });
    }
  } catch {
    // edit races
  }
}

async function renderCandidatePreview(ctx: Context, session: SessionData, idx: number): Promise<void> {
  const db = dbBrowserOf(session);
  const candidate = db.candidates?.[idx];
  if (!candidate) {
    await safeAnswer(ctx, "Results expired — re-fetch first.");
    return;
  }
  const trackId = db.trackId ?? 0;
  try {
    await ctx.editMessageText(formatCandidatePreviewText(candidate), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Use this", callback_data: `dbview_ru_${idx}`, style: "success" as const }],
          [{ text: "⬅️ Back to results", callback_data: "dbview_rlist" }],
          [{ text: "⬅️ Back to record", callback_data: `dbview_t_${trackId}` }],
        ],
      },
    });
  } catch {
    // edit races
  }
}

async function applyCandidate(ctx: Context, session: SessionData, env: Env, idx: number): Promise<void> {
  const db = dbBrowserOf(session);
  const candidate = db.candidates?.[idx];
  const trackId = db.trackId;
  if (!candidate || trackId === undefined) {
    await safeAnswer(ctx, "Results expired — re-fetch first.");
    return;
  }

  try {
    await setTrackLyrics(env.DB, trackId, candidate.lyrics);
  } catch (error) {
    warn("dbview: apply candidate failed", error);
    await safeAnswer(ctx, "❌ Database error.");
    return;
  }

  resetDbBrowserInput(db);
  await ctx.answerCallbackQuery({ text: "✅ Cached lyrics updated" }).catch(() => {});
  await renderRecord(ctx, session, env, trackId, true);
}

async function finishManualLyrics(ctx: Context, session: SessionData, env: Env): Promise<void> {
  const db = dbBrowserOf(session);
  const trackId = db.trackId;
  if (!db.collectingLyrics || trackId === undefined) {
    await ctx.answerCallbackQuery({ text: "No lyrics collection in progress" }).catch(() => {});
    return;
  }
  if (!db.buffer.length) {
    await ctx.answerCallbackQuery({ text: "No lyrics to save" }).catch(() => {});
    return;
  }

  const lyrics = normalizeLyrics(db.buffer.join("\n"));
  try {
    await setTrackLyrics(env.DB, trackId, lyrics);
  } catch (error) {
    warn("dbview: manual lyrics save failed", error);
    await safeAnswer(ctx, "❌ Database error.");
    return;
  }

  const { messageIds } = db;
  resetDbBrowserInput(db);
  const cid = ctx.chat?.id;
  if (cid) {
    for (const msgId of messageIds) {
      await safeDelete(ctx.api as any, cid, msgId);
    }
  }
  await ctx.answerCallbackQuery({ text: "✅ Cached lyrics updated" }).catch(() => {});
  // The Done button lives on the latest prompt — turn it into the record.
  await renderRecord(ctx, session, env, trackId, true);
}

// ── Text input (routed from bot.ts BEFORE edit-mode / song-search handling) ─

export async function handleDbTextInput(ctx: Context, session: SessionData, env: Env): Promise<boolean> {
  if (!isBotOwner(ctx, env)) {
    return false;
  }
  const db = dbBrowserOf(session);
  const text = ctx.message?.text;

  if (db.collectingLyrics) {
    if (!text || text.startsWith("/")) {
      return true; // collecting — swallow non-text noise, don't fall through
    }
    db.buffer.push(text);
    db.messageIds.push(ctx.message!.message_id);
    const cid = ctx.chat?.id;
    if (cid) {
      await safeDelete(ctx.api as any, cid, ctx.message!.message_id);
      if (db.promptId) {
        await safeDelete(ctx.api as any, cid, db.promptId);
      }
    }
    const prompt = await ctx.reply(
      `✍️ Track <code>${db.trackId ?? "?"}</code> — send more lyrics, or click Done (${db.buffer.length} message${db.buffer.length === 1 ? "" : "s"} buffered)`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Done", callback_data: "dbview_ldone", style: "success" as const }],
            [{ text: "Cancel", callback_data: "dbview_lcancel", style: "danger" as const }],
          ],
        },
      },
    );
    db.promptId = prompt.message_id;
    return true;
  }

  if (db.awaitingQuery) {
    db.awaitingQuery = false;
    if (!text || text.startsWith("/")) {
      return false; // let commands behave normally
    }
    const cid = ctx.chat?.id;
    if (cid) {
      await safeDelete(ctx.api as any, cid, ctx.message!.message_id);
      if (db.promptId) {
        await safeDelete(ctx.api as any, cid, db.promptId);
        db.promptId = undefined;
      }
    }
    db.query = text.trim();
    db.page = 0;
    // Fresh results go out as a new message (the browser home is far up).
    await renderList(ctx, session, env, 0, false);
    return true;
  }

  if (db.awaitingCustomSearch) {
    db.awaitingCustomSearch = false;
    if (!text || text.startsWith("/")) {
      return false; // let commands behave normally
    }
    const cid = ctx.chat?.id;
    const promptId = db.promptId;
    if (cid) {
      await safeDelete(ctx.api as any, cid, ctx.message!.message_id);
    }
    db.promptId = undefined;
    const q = text.trim();
    db.customQuery = q;
    db.trackId = db.trackId ?? 0;

    let candidates;
    try {
      // LRCLIB can take seconds — flip the prompt into a spinner first.
      if (cid && promptId) {
        try {
          await ctx.api.editMessageText(cid, promptId, `🔄 Searching LRCLIB for <code>${escapeRichHtml(q)}</code>…`, { parse_mode: "HTML" });
        } catch {}
      }
      candidates = await searchLyricsCandidatesQuery(q);
    } catch (error) {
      warn("dbview: custom LRCLIB search failed", error);
      try { await ctx.reply("❌ Lyrics lookup failed (rate limit?). Try again."); } catch {}
      return true;
    }

    db.candidates = candidates;
    if (cid && promptId) {
      try {
        await ctx.api.editMessageText(cid, promptId, "🔄 LRCLIB results — pick one:", {
          reply_markup: { inline_keyboard: buildCustomCandidateKeyboard(db) },
        });
      } catch {}
    }
    return true;
  }

  return false;
}
