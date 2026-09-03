// Generic settings KV in D1. Used for globally-scoped feature flags (e.g. the
// auto-fetch toggle) that must survive across per-user session DOs.
//
// Default is always "off" — a missing row means the feature is disabled, so
// failures degrade to the pre-feature behavior.

let tableReady = false;

async function ensureTable(db: D1Database) {
  if (tableReady) return;
  try {
    await db.prepare("SELECT 1 FROM settings LIMIT 1").all();
    tableReady = true;
  } catch {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `).run();
    tableReady = true;
  }
}

export const SETTING_AUTOFETCH_ENABLED = "autofetch_enabled";

// Scratch slot for bridge delivery pairing: the most recent audio forwarded
// into the bridge DM, consumed by the lyq:file tag that follows it. Serial
// jobs make the pairing safe (see src/handlers/bridge.ts).
export const SETTING_BRIDGE_LAST_AUDIO = "bridge_last_audio";

// Prefix for per-user session-free pending channel-send context, stashed by
// bridge delivery and consumed by send_channel_ clicks (key:
// <prefix><user_id>, 1 h freshness).
export const SETTING_PENDING_SEND_PREFIX = "bridge_pending_send:";

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  await ensureTable(db);
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await ensureTable(db);
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `)
    .bind(key, value)
    .run();
}

export async function isAutoFetchEnabled(db: D1Database): Promise<boolean> {
  return (await getSetting(db, SETTING_AUTOFETCH_ENABLED)) === "1";
}

export async function setAutoFetchEnabled(db: D1Database, enabled: boolean): Promise<void> {
  await setSetting(db, SETTING_AUTOFETCH_ENABLED, enabled ? "1" : "0");
}
