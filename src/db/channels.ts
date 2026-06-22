export type ChannelRow = {
  id: number;
  user_id: string;
  channel_id: string;
  title: string | null;
  created_at: number;
};

export async function getUserChannels(db: D1Database, userId: string): Promise<ChannelRow[]> {
  const result = await db.prepare("SELECT id, user_id, channel_id, title, created_at FROM channels WHERE user_id = ?")
    .bind(userId)
    .all<ChannelRow>();
  return result.results ?? [];
}

export async function getUsersByChannel(db: D1Database, channelId: string): Promise<string[]> {
  const result = await db.prepare("SELECT user_id FROM channels WHERE channel_id = ?")
    .bind(channelId)
    .all<{ user_id: string }>();
  return (result.results ?? []).map((row) => row.user_id);
}

export async function addChannel(db: D1Database, userId: string, channelId: string, title?: string): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO channels (user_id, channel_id, title) VALUES (?, ?, ?)")
    .bind(userId, channelId, title ?? null)
    .run();
}

export async function removeChannel(db: D1Database, userId: string, channelId: string): Promise<void> {
  await db.prepare("DELETE FROM channels WHERE user_id = ? AND channel_id = ?")
    .bind(userId, channelId)
    .run();
}
