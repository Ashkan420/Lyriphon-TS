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

-- Mirrors the lazy ensureTable DDL in src/db/audioRequests.ts. Pending rows
-- (FIFO by id) are the deezload auto-fetch queue; the Telethon bridge is the
-- serial consumer and reports back by req_token.
CREATE TABLE IF NOT EXISTS audio_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  req_token TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  track_id INTEGER NOT NULL,
  track_title TEXT,
  artist_name TEXT,
  telegraph_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_audio_requests_user ON audio_requests(user_id, status);

-- Mirrors the lazy ensureTable DDL in src/db/settings.ts. Generic KV for
-- globally-scoped feature flags (autofetch_enabled).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Unified per-song store (see src/db/tracks.ts): metadata + canonical
-- Telegram file_id + lyrics. Backfilled one-time from lyrics_cache, which
-- is LEGACY — kept in D1 as backup; new writes go to tracks only.
CREATE TABLE IF NOT EXISTS tracks (
  track_id INTEGER PRIMARY KEY,
  title TEXT,
  artist TEXT,
  file_id TEXT,
  lyrics TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tracks_title_artist ON tracks(artist, title);
