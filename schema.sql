CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_channel ON channels(user_id, channel_id);

-- Mirrors the lazy ensureTable DDL in src/db/lyrics.ts. Populated only when
-- lyrics are actually found (never "not found" results) — see cacheLyrics.
CREATE TABLE IF NOT EXISTS lyrics_cache (
  track_id INTEGER PRIMARY KEY,
  lyrics TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Mirrors the lazy ensureTable DDL in src/db/transliterations.ts.
CREATE TABLE IF NOT EXISTS transliterations (
  farsi TEXT PRIMARY KEY,
  finglish TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
