let tableReady = false;

async function ensureTable(db: D1Database) {
  if (tableReady) return;
  try {
    await db.prepare("SELECT 1 FROM lyrics_cache LIMIT 1").all();
    tableReady = true;
  } catch {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS lyrics_cache (
        track_id INTEGER PRIMARY KEY,
        lyrics TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `).run();
    tableReady = true;
  }
}

export async function getCachedLyrics(db: D1Database, trackId: number): Promise<string | null> {
  await ensureTable(db);
  const row = await db.prepare("SELECT lyrics FROM lyrics_cache WHERE track_id = ?")
    .bind(trackId)
    .first<{ lyrics: string }>();
  return row?.lyrics ?? null;
}

// Only cache when lyrics were actually found — empty results are skipped so a
// track that gains lyrics later isn't pinned to a "not found" forever.
export async function cacheLyrics(db: D1Database, trackId: number, lyrics: string): Promise<void> {
  if (!lyrics?.trim()) return;
  await ensureTable(db);
  await db.prepare("INSERT OR REPLACE INTO lyrics_cache (track_id, lyrics) VALUES (?, ?)")
    .bind(trackId, lyrics)
    .run();
}
