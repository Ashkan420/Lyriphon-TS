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
// the column via a partial write); pass null explicitly to forget.
export async function setTrackFileId(db: D1Database, trackId: number, fileId: string | null): Promise<void> {
  await upsertTrack(db, { trackId, fileId: fileId ?? undefined });
}

// Cheap existence probe for the Attach ↔ Replace label decision.
export async function hasTrackFile(db: D1Database, trackId: number): Promise<boolean> {
  const record = await getTrackRecord(db, trackId);
  return Boolean(record?.file_id);
}
