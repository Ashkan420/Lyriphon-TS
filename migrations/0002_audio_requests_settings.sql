-- Queue for deezload auto-fetch jobs (see src/db/audioRequests.ts and
-- bridge/telethon_bridge.py). Pending rows, FIFO by id, are the queue.
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

-- Generic KV for globally-scoped feature flags (see src/db/settings.ts).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
