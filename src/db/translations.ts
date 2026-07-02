import { debug, warn } from "../utils/logger";

let tableReady = false;

async function ensureTable(db: D1Database) {
  if (tableReady) return;
  try {
    await db.prepare("SELECT 1 FROM translations LIMIT 1").all();
    tableReady = true;
  } catch {
    debug("translations: creating table");
    await db.prepare(`
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
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_trans_song_lang ON translations(song_id, language)").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_trans_active ON translations(song_id, language, is_active)").run();
    tableReady = true;
    debug("translations: table created");
  }
}

interface TranslationRow {
  id: string;
  song_id: string;
  language: string;
  original_hash: string;
  original_lyrics: string;
  translation: string;
  score: number | null;
  version: number;
  is_active: number;
  created_at: number;
}

export async function getActiveTranslation(
  db: D1Database,
  songId: string,
  language: string,
): Promise<TranslationRow | null> {
  await ensureTable(db);
  const row = await db.prepare(
    "SELECT * FROM translations WHERE song_id = ? AND language = ? AND is_active = 1 LIMIT 1"
  ).bind(songId, language).first<TranslationRow>() ?? null;
  debug("translations:getActive", { songId, language, found: !!row, score: row?.score, version: row?.version });
  return row;
}

export async function getHighScoreTranslation(
  db: D1Database,
  songId: string,
  language: string,
): Promise<{ translation: string; score: number } | null> {
  await ensureTable(db);
  const row = await db.prepare(
    "SELECT translation, score FROM translations WHERE song_id = ? AND language = ? AND is_active = 1 AND score >= 90 LIMIT 1"
  ).bind(songId, language).first<{ translation: string; score: number }>();
  debug("translations:getHighScore", { songId, language, found: !!row, score: row?.score });
  return row ?? null;
}

export async function insertTranslation(
  db: D1Database,
  songId: string,
  language: string,
  originalHash: string,
  originalLyrics: string,
  translation: string,
  score: number | null,
  version: number,
): Promise<string> {
  await ensureTable(db);
  const id = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO translations (id, song_id, language, original_hash, original_lyrics, translation, score, version, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
  ).bind(id, songId, language, originalHash, originalLyrics, translation, score, version).run();
  debug("translations:insert", { id, songId, language, version, score });
  return id;
}

export async function updateScore(
  db: D1Database,
  id: string,
  score: number,
): Promise<void> {
  await ensureTable(db);
  await db.prepare("UPDATE translations SET score = ? WHERE id = ?").bind(score, id).run();
  debug("translations:updateScore", { id, score });
}

export async function deactivateOldVersions(
  db: D1Database,
  songId: string,
  language: string,
  excludeId: string,
): Promise<void> {
  await ensureTable(db);
  await db.prepare(
    "UPDATE translations SET is_active = 0 WHERE song_id = ? AND language = ? AND id != ?"
  ).bind(songId, language, excludeId).run();
  debug("translations:deactivateOld", { songId, language, excludeId });
}
