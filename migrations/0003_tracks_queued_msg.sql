-- Unified per-song store (see src/db/tracks.ts): metadata + canonical
-- Telegram file_id + lyrics. One-time backfill from the legacy lyrics_cache
-- table (which stays in D1 as backup).
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

INSERT OR IGNORE INTO tracks (track_id, lyrics)
SELECT track_id, lyrics FROM lyrics_cache;

-- Bridge status message that self-deletes on delivery/failure.
ALTER TABLE audio_requests ADD COLUMN queued_msg_id INTEGER;
