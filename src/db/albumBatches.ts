// Album batch state for the admin-only /album pipeline. One row per album
// run; the per-track jobs live in audio_requests (album_token column links
// them here). The batch row is what assembly reads to know where to send
// the final album rich message, and its status column is the double-send
// guard (pending → complete via a guarded UPDATE; the winner assembles).

export type AlbumBatchStatus = "pending" | "complete";

export type AlbumBatchRow = {
  batch_token: string;
  user_id: string;
  chat_id: number;
  album_id: number;
  title: string;
  artist: string;
  cover_url: string;
  release_date: string;
  track_count: number;
  status: AlbumBatchStatus;
  // JSON array of the selected track_ids (the only ones the rich message
  // includes; unselected album-route files are just cached).
  selected: string | null;
  // The "⏳ Fetching…" status message, edited to the final receipt.
  status_msg_id: number | null;
  album_msg_id: number | null;
  // Why the run failed (bridge failure reason) — the zero-delivered receipt
  // shows this instead of a bare "0 of N".
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
};

let tableReady = false;

async function ensureTable(db: D1Database) {
  if (tableReady) return;
  try {
    await db.prepare("SELECT 1 FROM album_batches LIMIT 1").all();
    // Table predates selected/status_msg_id/failure_reason — add them idempotently.
    for (const col of ["selected", "status_msg_id", "failure_reason"]) {
      try {
        await db.prepare(`SELECT ${col} FROM album_batches LIMIT 1`).all();
      } catch {
        await db.prepare(`ALTER TABLE album_batches ADD COLUMN ${col} TEXT`).run();
      }
    }
    tableReady = true;
  } catch {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS album_batches (
        batch_token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        album_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        cover_url TEXT,
        release_date TEXT,
        track_count INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        selected TEXT,
        status_msg_id INTEGER,
        album_msg_id INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_album_batches_user ON album_batches(user_id, status)").run();
    tableReady = true;
  }
}

export async function createAlbumBatch(
  db: D1Database,
  data: {
    batchToken: string;
    userId: string;
    chatId: number;
    albumId: number;
    title: string;
    artist: string;
    coverUrl: string;
    releaseDate: string;
    trackCount: number;
  },
): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    INSERT INTO album_batches (batch_token, user_id, chat_id, album_id, title, artist, cover_url, release_date, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(data.batchToken, data.userId, data.chatId, data.albumId, data.title, data.artist, data.coverUrl, data.releaseDate, data.trackCount)
    .run();
}

export async function getAlbumBatch(db: D1Database, batchToken: string): Promise<AlbumBatchRow | null> {
  await ensureTable(db);
  const row = await db.prepare(`
    SELECT batch_token, user_id, chat_id, album_id, title, artist, cover_url, release_date,
           track_count, status, selected, status_msg_id, album_msg_id, failure_reason, created_at, updated_at
    FROM album_batches WHERE batch_token = ?
  `)
    .bind(batchToken)
    .first<AlbumBatchRow>();
  return row ?? null;
}

// Only a RECENTLY updated pending batch blocks a new run — and only if it's
// actually alive (has non-expired pending audio_requests rows). A batch whose
// rows all died (bridge reset, failed enqueues, TTL expiry) can never reach
// its terminal flip on its own, so the guard self-heals: those batches are
// flipped complete here instead of blocking GET ALL forever.
const PENDING_BATCH_FRESH_SECONDS = 3 * 3600;

export async function hasPendingBatchForUser(db: D1Database, userId: string): Promise<boolean> {
  await ensureTable(db);
  const result = await db.prepare(`
    SELECT batch_token FROM album_batches
    WHERE user_id = ? AND status = 'pending' AND updated_at >= unixepoch() - ?
  `)
    .bind(userId, PENDING_BATCH_FRESH_SECONDS)
    .all<{ batch_token: string }>();
  const pending = result.results ?? [];
  if (!pending.length) {
    return false;
  }

  const { getRequestsByAlbumToken, isRequestExpired } = await import("./audioRequests");
  for (const row of pending) {
    const reqs = await getRequestsByAlbumToken(db, row.batch_token);
    const alive = reqs.some((r) => r.status === "pending" && !isRequestExpired(r));
    if (alive) {
      return true;
    }
    // Dead batch — flip it so it stops blocking.
    await markBatchComplete(db, row.batch_token);
  }
  return false;
}

// The double-send guard: exactly one caller flips pending → complete and
// proceeds to assemble. Returns false for a loser (already assembled).
export async function markBatchComplete(db: D1Database, batchToken: string): Promise<boolean> {
  await ensureTable(db);
  const result = await db.prepare(`
    UPDATE album_batches SET status = 'complete', updated_at = unixepoch()
    WHERE batch_token = ? AND status = 'pending'
  `)
    .bind(batchToken)
    .run();
  return (result?.meta?.changes ?? 0) > 0;
}

export async function setBatchAlbumMsg(db: D1Database, batchToken: string, messageId: number): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    UPDATE album_batches SET album_msg_id = ?, updated_at = unixepoch() WHERE batch_token = ?
  `)
    .bind(messageId, batchToken)
    .run();
}

export async function setBatchStatusMsg(db: D1Database, batchToken: string, messageId: number): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    UPDATE album_batches SET status_msg_id = ?, updated_at = unixepoch() WHERE batch_token = ?
  `)
    .bind(messageId, batchToken)
    .run();
}

export async function setBatchSelected(db: D1Database, batchToken: string, trackIds: number[]): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    UPDATE album_batches SET selected = ?, updated_at = unixepoch() WHERE batch_token = ?
  `)
    .bind(JSON.stringify(trackIds), batchToken)
    .run();
}

export async function setBatchFailureReason(db: D1Database, batchToken: string, reason: string): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    UPDATE album_batches SET failure_reason = ?, updated_at = unixepoch() WHERE batch_token = ?
  `)
    .bind(reason, batchToken)
    .run();
}
