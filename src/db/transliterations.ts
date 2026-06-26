let tableReady = false;

async function ensureTable(db: D1Database) {
  if (tableReady) return;
  try {
    await db.prepare("SELECT 1 FROM transliterations LIMIT 1").all();
    tableReady = true;
  } catch {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS transliterations (
        farsi TEXT PRIMARY KEY,
        finglish TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `).run();
    tableReady = true;
  }
}

export async function getCachedFinglish(db: D1Database, farsi: string): Promise<string | null> {
  await ensureTable(db);
  const row = await db.prepare("SELECT finglish FROM transliterations WHERE farsi = ?")
    .bind(farsi)
    .first<{ finglish: string }>();
  return row?.finglish ?? null;
}

export async function cacheFinglish(db: D1Database, farsi: string, finglish: string): Promise<void> {
  await ensureTable(db);
  await db.prepare("INSERT OR IGNORE INTO transliterations (farsi, finglish) VALUES (?, ?)")
    .bind(farsi, finglish)
    .run();
}
