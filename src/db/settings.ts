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

// Experimental rich-message music delivery: audio + Lyrics button inside one
// rich message instead of sendAudio + reply_markup. Two-layer gate like
// auto-fetch — global admin switch AND per-user pref — but both default OFF
// (opt-in): a missing row means the user gets the plain delivery.
export const SETTING_RICH_DELIVERY_ENABLED = "rich_delivery_enabled";
export const SETTING_USER_RICH_PREFIX = "pref_rich:";

export async function isRichDeliveryEnabled(db: D1Database): Promise<boolean> {
  return (await getSetting(db, SETTING_RICH_DELIVERY_ENABLED)) === "1";
}

export async function setRichDeliveryEnabled(db: D1Database, enabled: boolean): Promise<void> {
  await setSetting(db, SETTING_RICH_DELIVERY_ENABLED, enabled ? "1" : "0");
}

export async function isUserRichDeliveryEnabled(db: D1Database, userId: string): Promise<boolean> {
  return (await getSetting(db, `${SETTING_USER_RICH_PREFIX}${userId}`)) === "1";
}

export async function setUserRichDeliveryEnabled(db: D1Database, userId: string, enabled: boolean): Promise<void> {
  await setSetting(db, `${SETTING_USER_RICH_PREFIX}${userId}`, enabled ? "1" : "0");
}

// Per-user rich layout choice ("1".."4"). Missing/garbage row = style 1, so
// users who never open the picker keep the original delivery look.
export const SETTING_USER_RICHSTYLE_PREFIX = "pref_richstyle:";

export async function getUserRichStyle(db: D1Database, userId: string): Promise<1 | 2 | 3 | 4> {
  const raw = await getSetting(db, `${SETTING_USER_RICHSTYLE_PREFIX}${userId}`);
  return raw === "2" || raw === "3" || raw === "4" ? (Number(raw) as 1 | 2 | 3 | 4) : 1;
}

export async function setUserRichStyle(db: D1Database, userId: string, style: 1 | 2 | 3 | 4): Promise<void> {
  const clamped = style === 2 || style === 3 || style === 4 ? style : 1;
  await setSetting(db, `${SETTING_USER_RICHSTYLE_PREFIX}${userId}`, String(clamped));
}

// The effective gate all delivery sites use. D1 failure degrades to plain
// delivery (fail closed) rather than blocking the send.
export async function isRichDeliveryActive(db: D1Database, userId: string): Promise<boolean> {
  try {
    return (await isRichDeliveryEnabled(db)) && (await isUserRichDeliveryEnabled(db, userId));
  } catch {
    return false;
  }
}

// ── Per-user preferences ────────────────────────────────────────────────────
//
// Stored on the same KV, keyed by user id. Defaults live in the getters so a
// missing row means "on" — both prefs are opt-out.

export const SETTING_USER_AUTOFETCH_PREFIX = "pref_autofetch:";
export const SETTING_USER_PREVIEW_PREFIX = "pref_preview:";

export async function isUserAutoFetchEnabled(db: D1Database, userId: string): Promise<boolean> {
  return (await getSetting(db, `${SETTING_USER_AUTOFETCH_PREFIX}${userId}`)) !== "0";
}

export async function setUserAutoFetchEnabled(db: D1Database, userId: string, enabled: boolean): Promise<void> {
  await setSetting(db, `${SETTING_USER_AUTOFETCH_PREFIX}${userId}`, enabled ? "1" : "0");
}

export async function getUserLinkPreviewEnabled(db: D1Database, userId: string): Promise<boolean> {
  return (await getSetting(db, `${SETTING_USER_PREVIEW_PREFIX}${userId}`)) !== "0";
}

export async function setUserLinkPreviewEnabled(db: D1Database, userId: string, enabled: boolean): Promise<void> {
  await setSetting(db, `${SETTING_USER_PREVIEW_PREFIX}${userId}`, enabled ? "1" : "0");
}
