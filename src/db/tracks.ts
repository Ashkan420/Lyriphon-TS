// Unified per-song store: one row per Deezer track holding everything the
// bot learns about it — metadata, the canonical Telegram file_id of the
// fetched audio, and lyrics. Replaces lyrics_cache (kept in D1 as legacy
// backup; backfilled into this table by migration 0003).
//
// Reuse rule: when a picked track already has a file_id, the bot re-sends
// the stored audio instead of fetching from deezload again.

export type TrackRecord = {
  track_id: number;
  title: string | null;
  artist: string | null;
  file_id: string | null;
  lyrics: string | null;
  created_at: number;
  updated_at: number;
};

let tableReady = false;

async function ensureTable(db: D1Database) {
  if (tableReady) return;
  try {
    await db.prepare("SELECT 1 FROM tracks LIMIT 1").all();
    tableReady = true;
  } catch {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS tracks (
        track_id INTEGER PRIMARY KEY,
        title TEXT,
        artist TEXT,
        file_id TEXT,
        lyrics TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_tracks_title_artist ON tracks(artist, title)").run();
    tableReady = true;
  }
}

export async function getTrackRecord(db: D1Database, trackId: number): Promise<TrackRecord | null> {
  await ensureTable(db);
  const row = await db.prepare(`
    SELECT track_id, title, artist, file_id, lyrics, created_at, updated_at
    FROM tracks WHERE track_id = ?
  `)
    .bind(trackId)
    .first<TrackRecord>();
  return row ?? null;
}

// Partial-safe upsert: COALESCE keeps existing values when a write doesn't
// carry a field (e.g. filling file_id never blanks lyrics).
export async function upsertTrack(
  db: D1Database,
  data: {
    trackId: number;
    title?: string;
    artist?: string;
    fileId?: string;
    lyrics?: string;
  },
): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    INSERT INTO tracks (track_id, title, artist, file_id, lyrics)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(track_id) DO UPDATE SET
      title = COALESCE(excluded.title, tracks.title),
      artist = COALESCE(excluded.artist, tracks.artist),
      file_id = COALESCE(excluded.file_id, tracks.file_id),
      lyrics = COALESCE(excluded.lyrics, tracks.lyrics),
      updated_at = unixepoch()
  `)
    .bind(
      data.trackId,
      data.title ?? null,
      data.artist ?? null,
      data.fileId ?? null,
      data.lyrics ?? null,
    )
    .run();
}

// Canonical file_id update — empty/undefined clears to existing (never NULLs
// the column via a partial write); pass null explicitly to forget. For a real
// clear use clearTrackFileId below (upsert's COALESCE can never NULL a column).
export async function setTrackFileId(db: D1Database, trackId: number, fileId: string | null): Promise<void> {
  await upsertTrack(db, { trackId, fileId: fileId ?? undefined });
}

// Explicit overwrite — COALESCE replaces the value when one is carried,
// leaving title/artist/file_id untouched. Undefined lyrics would be a no-op,
// so callers wanting to erase must use clearTrackLyrics.
export async function setTrackLyrics(db: D1Database, trackId: number, lyrics: string): Promise<void> {
  await upsertTrack(db, { trackId, lyrics });
}

// Admin cache management: direct writes that bypass upsert's COALESCE (it can
// never NULL a column) plus browse/search for the owner's DB browser.
export async function clearTrackFileId(db: D1Database, trackId: number): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    UPDATE tracks SET file_id = NULL, updated_at = unixepoch() WHERE track_id = ?
  `)
    .bind(trackId)
    .run();
}

export async function clearTrackLyrics(db: D1Database, trackId: number): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    UPDATE tracks SET lyrics = NULL, updated_at = unixepoch() WHERE track_id = ?
  `)
    .bind(trackId)
    .run();
}

export async function deleteTrackRow(db: D1Database, trackId: number): Promise<void> {
  await ensureTable(db);
  await db.prepare("DELETE FROM tracks WHERE track_id = ?")
    .bind(trackId)
    .run();
}

// Cheap existence probe for the Attach ↔ Replace label decision.
export async function hasTrackFile(db: D1Database, trackId: number): Promise<boolean> {
  const record = await getTrackRecord(db, trackId);
  return Boolean(record?.file_id);
}

// Escape LIKE wildcards so a literal "%"/"_" in a title doesn't widen the match.
function likeEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function buildTrackWhere(query?: string): { clause: string; binds: string[] } {
  if (!query || !query.trim()) {
    return { clause: "", binds: [] };
  }
  const q = query.trim();
  const pattern = `%${likeEscape(q)}%`;
  if (/^\d+$/.test(q)) {
    // All digits: also match the exact track id (as text, so one LIKE covers it).
    return {
      clause: "WHERE (title LIKE ?1 ESCAPE '\\' OR artist LIKE ?1 ESCAPE '\\' OR CAST(track_id AS TEXT) = ?2)",
      binds: [pattern, q],
    };
  }
  return {
    clause: "WHERE (title LIKE ?1 ESCAPE '\\' OR artist LIKE ?1 ESCAPE '\\')",
    binds: [pattern],
  };
}

const TRACK_LIST_COLS = "track_id, title, artist, file_id, lyrics, created_at, updated_at";

export type TrackListRow = TrackRecord;

export type ListFilter = { missingLyrics?: boolean };

// Recent-first browse page for the admin DB browser. missingLyrics narrows to
// rows whose lyrics column is NULL (the admin "fill the gaps" view).
export async function listTrackRows(
  db: D1Database,
  limit: number,
  offset: number,
  opts?: ListFilter,
): Promise<TrackListRow[]> {
  await ensureTable(db);
  const where = opts?.missingLyrics ? "WHERE lyrics IS NULL" : "";
  const { results } = await db.prepare(`
    SELECT ${TRACK_LIST_COLS} FROM tracks ${where} ORDER BY updated_at DESC, track_id DESC LIMIT ?1 OFFSET ?2
  `)
    .bind(limit, offset)
    .all<TrackListRow>();
  return results ?? [];
}

// Title/artist substring search (plus exact track id for all-digit queries),
// same ordering as the recent browse. LIMIT/OFFSET placeholders follow the
// WHERE bind count — hardcoded indices went out of range for text queries
// (only 1 pattern bind) and D1 rejected the statement outright.
export async function searchTrackRows(
  db: D1Database,
  query: string,
  limit: number,
  offset: number,
): Promise<TrackListRow[]> {
  await ensureTable(db);
  const { clause, binds } = buildTrackWhere(query);
  const limitIdx = binds.length + 1;
  const offsetIdx = binds.length + 2;
  const { results } = await db.prepare(`
    SELECT ${TRACK_LIST_COLS} FROM tracks ${clause} ORDER BY updated_at DESC, track_id DESC LIMIT ?${limitIdx} OFFSET ?${offsetIdx}
  `)
    .bind(...binds, limit, offset)
    .all<TrackListRow>();
  return results ?? [];
}

// Total row count for pagination; same WHERE as searchTrackRows / listTrackRows.
export async function countTrackRows(db: D1Database, query?: string, opts?: ListFilter): Promise<number> {
  await ensureTable(db);
  if (query?.trim()) {
    const { clause, binds } = buildTrackWhere(query);
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM tracks ${clause}`)
      .bind(...binds)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
  const where = opts?.missingLyrics ? "WHERE lyrics IS NULL" : "";
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM tracks ${where}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Home-screen stats: totals plus how many rows actually hold cached data.
export async function countTrackStats(db: D1Database): Promise<{
  total: number;
  withFileId: number;
  withLyrics: number;
}> {
  await ensureTable(db);
  const row = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN file_id IS NOT NULL THEN 1 ELSE 0 END) AS with_file_id,
      SUM(CASE WHEN lyrics IS NOT NULL THEN 1 ELSE 0 END) AS with_lyrics
    FROM tracks
  `)
    .first<{ total: number; with_file_id: number | null; with_lyrics: number | null }>();
  return {
    total: row?.total ?? 0,
    withFileId: row?.with_file_id ?? 0,
    withLyrics: row?.with_lyrics ?? 0,
  };
}
