// Channel button backfill queue (see migrations/0006_scan_queue.sql): one row
// per channel message the bridge scan classified. BridgeDO writes the scan
// results; the /migrate run reads pending rows, presents one at a time, and
// writes the admin's answer back. Pending rows in id order are the queue, so
// there is no separate queue infrastructure to operate.

export type ScanQueueStatus = "pending" | "handled" | "failed" | "skipped";
export type ScanQueueOutcome = "added" | "declined" | "edited";

export type ScanQueueRow = {
  id: number;
  channel_id: string;
  user_id: string;
  message_id: number;
  status: ScanQueueStatus;
  outcome: ScanQueueOutcome | null;
  has_lyrics_button: number;
  existing_url: string | null;
  // JSON rows of the post's current keyboard, captured at scan time so the
  // Lyrics button can be merged with them instead of replacing them (FR-013a).
  existing_markup: string | null;
  title: string | null;
  artist: string | null;
  file_name: string | null;
  created_at: number;
};

// What the scanner learned about one message, before it becomes a row.
export type ScanCandidateInput = {
  channel_id: string;
  user_id: string;
  message_id: number;
  has_lyrics_button: boolean;
  existing_url: string | null;
  // JSON rows of the post's current keyboard (null when it has none).
  existing_markup: string | null;
  title: string | null;
  artist: string | null;
  file_name: string | null;
};

let tableReady = false;

async function ensureTable(db: D1Database) {
  if (tableReady) return;
  try {
    await db.prepare("SELECT 1 FROM scan_queue LIMIT 1").all();
    tableReady = true;
  } catch {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS scan_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        outcome TEXT,
        has_lyrics_button INTEGER NOT NULL DEFAULT 0,
        existing_url TEXT,
        existing_markup TEXT,
        title TEXT,
        artist TEXT,
        file_name TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(channel_id, message_id)
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_scan_queue_user_channel
        ON scan_queue(user_id, channel_id)
    `).run();
    tableReady = true;
  }
}

// Insert the scan results for one page. Idempotent on (channel_id, message_id)
// so re-reading a page cannot duplicate a candidate, and a re-run of a channel
// that is already handled finds nothing new to offer (FR-028).
//
// Rows are only ever created for qualifying posts. A post that already carries
// a Lyrics button is recorded with status 'skipped' so the distinction is
// visible, but listPending never returns it — it is not a candidate (FR-013).
export async function insertScanCandidates(
  db: D1Database,
  candidates: ScanCandidateInput[],
): Promise<void> {
  if (!candidates.length) return;
  await ensureTable(db);

  for (const c of candidates) {
    await db.prepare(`
      INSERT OR IGNORE INTO scan_queue
        (channel_id, user_id, message_id, status, has_lyrics_button, existing_url, existing_markup, title, artist, file_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      c.channel_id,
      c.user_id,
      c.message_id,
      c.has_lyrics_button ? "skipped" : "pending",
      c.has_lyrics_button ? 1 : 0,
      c.existing_url,
      c.existing_markup,
      c.title,
      c.artist,
      c.file_name,
    ).run();
  }
}

// The next candidate for this run: oldest pending row first. Anything with a
// Lyrics button is stored 'skipped' and can never appear here (FR-013).
export async function listPending(
  db: D1Database,
  userId: string,
  channelId: string,
): Promise<ScanQueueRow[]> {
  await ensureTable(db);
  const result = await db.prepare(`
    SELECT id, channel_id, user_id, message_id, status, outcome, has_lyrics_button,
           existing_url, existing_markup, title, artist, file_name, created_at
      FROM scan_queue
     WHERE user_id = ? AND channel_id = ? AND status = 'pending'
     -- New posts are appended (highest message_id) and are the ones the admin
     -- most wants to see. Ordering by insertion id would put a post added
     -- after the first scan at the END of the queue; ordering by message_id
     -- gives newest-first regardless of when the row was written.
     ORDER BY message_id DESC
  `).bind(userId, channelId).all<ScanQueueRow>();
  return result.results ?? [];
}

export async function getScanRow(db: D1Database, id: number): Promise<ScanQueueRow | null> {
  await ensureTable(db);
  const result = await db.prepare(`
    SELECT id, channel_id, user_id, message_id, status, outcome, has_lyrics_button,
           existing_url, existing_markup, title, artist, file_name, created_at
      FROM scan_queue WHERE id = ?
  `).bind(id).all<ScanQueueRow>();
  return result.results?.[0] ?? null;
}

// Record the admin's answer on one candidate. Only rows still 'pending' are
// updated: a stale tap arriving after the run moved on matches nothing and is
// a no-op rather than a double-count.
export async function setOutcome(
  db: D1Database,
  id: number,
  outcome: ScanQueueOutcome,
): Promise<boolean> {
  await ensureTable(db);
  const res = await db.prepare(`
    UPDATE scan_queue SET status = 'handled', outcome = ?
     WHERE id = ? AND status = 'pending'
  `).bind(outcome, id).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function setStatus(
  db: D1Database,
  id: number,
  status: ScanQueueStatus,
): Promise<void> {
  await ensureTable(db);
  await db.prepare("UPDATE scan_queue SET status = ? WHERE id = ?")
    .bind(status, id).run();
}

// Store the page built for a candidate that had no link (FR-014). Written
// BEFORE the confirmation is shown so a re-offer, an Edit, or a retry all see
// the same URL and never build a second page for the same song (FR-014c).
export async function setExistingUrl(
  db: D1Database,
  id: number,
  url: string,
): Promise<void> {
  await ensureTable(db);
  await db.prepare("UPDATE scan_queue SET existing_url = ? WHERE id = ?")
    .bind(url, id).run();
}

// Summary counts (FR-031). Skipped rows are excluded from 'offered': a post
// that already had a Lyrics button was never offered to anyone (SC-004).
export async function countByStatus(
  db: D1Database,
  userId: string,
  channelId: string,
): Promise<{ pending: number; handled: number; failed: number }> {
  await ensureTable(db);
  const result = await db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'handled' THEN 1 ELSE 0 END) AS handled,
      SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed
      FROM scan_queue
     WHERE user_id = ? AND channel_id = ?
  `).bind(userId, channelId).all<{
    pending: number | null; handled: number | null; failed: number | null;
  }>();
  const row = result.results?.[0];
  return {
    pending: row?.pending ?? 0,
    handled: row?.handled ?? 0,
    failed: row?.failed ?? 0,
  };
}

// Breakdown of handled rows for the summary line (FR-031).
export async function countByOutcome(
  db: D1Database,
  userId: string,
  channelId: string,
): Promise<{ added: number; declined: number; edited: number }> {
  await ensureTable(db);
  const result = await db.prepare(`
    SELECT
      SUM(CASE WHEN outcome = 'added'    THEN 1 ELSE 0 END) AS added,
      SUM(CASE WHEN outcome = 'declined' THEN 1 ELSE 0 END) AS declined,
      SUM(CASE WHEN outcome = 'edited'   THEN 1 ELSE 0 END) AS edited
      FROM scan_queue
     WHERE user_id = ? AND channel_id = ? AND status = 'handled'
  `).bind(userId, channelId).all<{
    added: number | null; declined: number | null; edited: number | null;
  }>();
  const row = result.results?.[0];
  return {
    added: row?.added ?? 0,
    declined: row?.declined ?? 0,
    edited: row?.edited ?? 0,
  };
}
