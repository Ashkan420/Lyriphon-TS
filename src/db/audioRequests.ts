// Queue for deezload auto-fetch jobs. One row per requested track; the
// Telethon bridge (bridge/telethon_bridge.py) is the serial consumer and
// reports back by req_token. The table IS the queue — pending rows in FIFO
// id order — so there is no separate queue infrastructure to operate.

import { AUTOFETCH_REQUEST_TTL_SECONDS } from "../config";

export type AudioRequestStatus = "pending" | "delivered" | "failed" | "expired";

export type AudioRequestRow = {
  id: number;
  req_token: string;
  user_id: string;
  chat_id: number;
  track_id: number;
  track_title: string | null;
  artist_name: string | null;
  telegraph_url: string | null;
  queued_msg_id: number | null;
  // Set for inline-mode requests: the sent inline message this job should
  // edit itself into (audio + Lyrics button) on delivery. DM requests stay
  // NULL; inline rows use chat_id 0.
  inline_message_id: string | null;
  status: AudioRequestStatus;
  created_at: number;
  updated_at: number;
};

let tableReady = false;

async function ensureTable(db: D1Database) {
  if (tableReady) return;
  try {
    await db.prepare("SELECT 1 FROM audio_requests LIMIT 1").all();
    // Table predates queued_msg_id — add it idempotently.
    try {
      await db.prepare("SELECT queued_msg_id FROM audio_requests LIMIT 1").all();
    } catch {
      await db.prepare("ALTER TABLE audio_requests ADD COLUMN queued_msg_id INTEGER").run();
    }
    // Table predates inline_message_id — add it idempotently.
    try {
      await db.prepare("SELECT inline_message_id FROM audio_requests LIMIT 1").all();
    } catch {
      await db.prepare("ALTER TABLE audio_requests ADD COLUMN inline_message_id TEXT").run();
    }
    tableReady = true;
  } catch {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS audio_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        req_token TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        track_id INTEGER NOT NULL,
        track_title TEXT,
        artist_name TEXT,
        telegraph_url TEXT,
        queued_msg_id INTEGER,
        inline_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_audio_requests_user ON audio_requests(user_id, status)").run();
    tableReady = true;
  }
}

export async function createAudioRequest(
  db: D1Database,
  data: {
    reqToken: string;
    userId: string;
    chatId: number;
    trackId: number;
    trackTitle: string;
    artistName: string;
    inlineMessageId?: string;
  },
): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    INSERT INTO audio_requests (req_token, user_id, chat_id, track_id, track_title, artist_name, inline_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(data.reqToken, data.userId, data.chatId, data.trackId, data.trackTitle, data.artistName, data.inlineMessageId ?? null)
    .run();
}

export async function getRequestByToken(db: D1Database, reqToken: string): Promise<AudioRequestRow | null> {
  await ensureTable(db);
  const row = await db.prepare(`
    SELECT id, req_token, user_id, chat_id, track_id, track_title, artist_name,
           telegraph_url, queued_msg_id, inline_message_id, status, created_at, updated_at
    FROM audio_requests WHERE req_token = ?
  `)
    .bind(reqToken)
    .first<AudioRequestRow>();
  return row ?? null;
}

export async function countPendingByUser(db: D1Database, userId: string): Promise<number> {
  await ensureTable(db);
  const row = await db.prepare(`
    SELECT COUNT(*) AS n FROM audio_requests WHERE user_id = ? AND status = 'pending'
  `)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function setRequestTelegraphUrl(db: D1Database, reqToken: string, telegraphUrl: string): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    UPDATE audio_requests SET telegraph_url = ?, updated_at = unixepoch() WHERE req_token = ?
  `)
    .bind(telegraphUrl, reqToken)
    .run();
}

export async function setRequestQueuedMsg(db: D1Database, reqToken: string, messageId: number): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    UPDATE audio_requests SET queued_msg_id = ?, updated_at = unixepoch() WHERE req_token = ?
  `)
    .bind(messageId, reqToken)
    .run();
}

export async function setRequestStatus(db: D1Database, reqToken: string, status: AudioRequestStatus): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    UPDATE audio_requests SET status = ?, updated_at = unixepoch() WHERE req_token = ?
  `)
    .bind(status, reqToken)
    .run();
}

// Expiry is applied at lookup time rather than by a sweeper: a stale row
// simply stops matching delivery. Rows are only ever expired-out of the
// pending state here; explicit failed/delivered transitions are permanent.
export function isRequestExpired(row: AudioRequestRow): boolean {
  return row.created_at + AUTOFETCH_REQUEST_TTL_SECONDS <= Math.floor(Date.now() / 1000);
}

// Materialize TTL expiry for pending rows so per-user caps reflect reality
// (rows whose jobs are long gone stop counting toward AUTOFETCH_MAX_PENDING).
export async function expireStalePending(db: D1Database): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    UPDATE audio_requests SET status = 'expired', updated_at = unixepoch()
    WHERE status = 'pending' AND created_at <= unixepoch() - ?
  `)
    .bind(AUTOFETCH_REQUEST_TTL_SECONDS)
    .run();
}

// Owner escape hatch: expire every pending row regardless of age. Used by
// /bridge_reset — pending rows only ever block; expiring them can't undo a
// delivery (those are already 'delivered'). Returns the number of rows cleared.
export async function expireAllPending(db: D1Database): Promise<number> {
  await ensureTable(db);
  const result = await db.prepare(`
    UPDATE audio_requests SET status = 'expired', updated_at = unixepoch()
    WHERE status = 'pending'
  `).run();
  return result?.meta?.changes ?? 0;
}
