-- Channel button backfill: the results of one admin's history scan of one
-- channel. BridgeDO reads a page of channel history, classifies each message,
-- and writes the qualifying ones here; the Worker then walks them one at a
-- time and records the admin's answers back onto the same rows.
--
-- The table IS the queue (pending rows first) and the authoritative record of
-- what was decided — session state holds only the current cursor. message_id
-- comes off the scan itself rather than being persisted at send time, because
-- the run reads a post before it ever edits it.
CREATE TABLE IF NOT EXISTS scan_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  -- pending | handled | failed | skipped
  status TEXT NOT NULL DEFAULT 'pending',
  -- added | declined | edited — filled as the admin answers
  outcome TEXT,
  -- 1 when the post already carries a Lyrics button: skipped at scan time,
  -- never offered, never counted as a candidate (FR-013).
  has_lyrics_button INTEGER NOT NULL DEFAULT 0,
  -- Lyrics link already on the post (inline keyboard OR message body), reused
  -- instead of creating a second page for the same song (FR-014c).
  existing_url TEXT,
  -- The post's current inline keyboard as JSON rows, captured at scan time so
  -- the button can be MERGED in rather than replacing what is already there
  -- (FR-013a). Null when the post has no keyboard (e.g. rich delivery, where
  -- the link lives in the body).
  existing_markup TEXT,
  title TEXT,
  artist TEXT,
  file_name TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  -- A post is never offered twice, so re-scanning a channel cannot duplicate
  -- it and a re-run offers nothing (FR-028).
  UNIQUE(channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_scan_queue_user_channel
  ON scan_queue(user_id, channel_id);
