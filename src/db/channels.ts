export type ChannelRow = {
  id: number;
  user_id: string;
  channel_id: string;
  title: string | null;
  created_at: number;
};

let tableReady = false;

async function ensureTable(db: D1Database) {
  if (tableReady) return;
  try {
    await db.prepare("SELECT 1 FROM channels LIMIT 1").all();
    tableReady = true;
  } catch {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        title TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user_id, channel_id)
      )
    `).run();
    tableReady = true;
  }
}

export async function getUserChannels(db: D1Database, userId: string): Promise<ChannelRow[]> {
  await ensureTable(db);
  const result = await db.prepare("SELECT id, user_id, channel_id, title, created_at FROM channels WHERE user_id = ?")
    .bind(userId)
    .all<ChannelRow>();
  return result.results ?? [];
}

export async function getUsersByChannel(db: D1Database, channelId: string): Promise<string[]> {
  await ensureTable(db);
  const result = await db.prepare("SELECT user_id FROM channels WHERE channel_id = ?")
    .bind(channelId)
    .all<{ user_id: string }>();
  return (result.results ?? []).map((row) => row.user_id);
}

export async function addChannel(db: D1Database, userId: string, channelId: string, title?: string): Promise<void> {
  await ensureTable(db);
  await db.prepare("INSERT OR IGNORE INTO channels (user_id, channel_id, title) VALUES (?, ?, ?)")
    .bind(userId, channelId, title ?? null)
    .run();
}

export async function removeChannel(db: D1Database, userId: string, channelId: string): Promise<void> {
  await ensureTable(db);
  await db.prepare("DELETE FROM channels WHERE user_id = ? AND channel_id = ?")
    .bind(userId, channelId)
    .run();
}
