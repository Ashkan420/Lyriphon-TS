CREATE TABLE IF NOT EXISTS translations (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL,
  language TEXT NOT NULL,
  original_hash TEXT NOT NULL,
  original_lyrics TEXT NOT NULL,
  translation TEXT NOT NULL,
  score INTEGER,
  version INTEGER NOT NULL,
  is_active INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_trans_song_lang ON translations(song_id, language);
CREATE INDEX IF NOT EXISTS idx_trans_active ON translations(song_id, language, is_active);