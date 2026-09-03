import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSettingsKeyboard,
  buildSettingsText,
  handleSettingsCallback,
  handleSettingsCommand,
} from "../src/handlers/settings";
import {
  isUserAutoFetchEnabled,
  setUserAutoFetchEnabled,
  getUserLinkPreviewEnabled,
  setUserLinkPreviewEnabled,
  isAutoFetchEnabled,
  setAutoFetchEnabled,
} from "../src/db/settings";

// D1 stub with a real KV backing the settings table (same pattern as
// fakeD1WithKv in bridge.test.ts, settings-only).
function fakeKvDb() {
  const kv = new Map<string, string>();
  return {
    kv,
    prepare(sql: string) {
      return {
        bind(key: string, value?: string) {
          return {
            async first<T>(): Promise<T | null> {
              if (sql.includes("SELECT value FROM settings")) {
                const v = kv.get(key as string);
                return v === undefined ? null : ({ value: v } as unknown as T);
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO settings") && value !== undefined) {
                kv.set(key as string, value);
              }
            },
          };
        },
        async all() {
          return { results: [] };
        },
        async run() {},
      };
    },
  } as unknown as any;
}

function makeEnv(db: any): any {
  return { DB: db, BOT_TOKEN: "t", TELEGRAPH_ACCESS_TOKEN: "x", WEBHOOK_SECRET_TOKEN: "s" };
}

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    from: { id: 555 },
    callbackQuery: { data: "" },
    reply: vi.fn(async () => ({ message_id: 1 })),
    editMessageText: vi.fn(async () => {}),
    answerCallbackQuery: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

describe("user preference helpers", () => {
  it("default to ON when no row exists, and persist flips", async () => {
    const db = fakeKvDb();
    expect(await isUserAutoFetchEnabled(db, "u1")).toBe(true);
    expect(await getUserLinkPreviewEnabled(db, "u1")).toBe(true);

    await setUserAutoFetchEnabled(db, "u1", false);
    await setUserLinkPreviewEnabled(db, "u1", false);
    expect(await isUserAutoFetchEnabled(db, "u1")).toBe(false);
    expect(await getUserLinkPreviewEnabled(db, "u1")).toBe(false);

    await setUserAutoFetchEnabled(db, "u1", true);
    expect(await isUserAutoFetchEnabled(db, "u1")).toBe(true);
  });

  it("global admin toggle is independent of user prefs", async () => {
    const db = fakeKvDb();
    await setAutoFetchEnabled(db, false);
    expect(await isAutoFetchEnabled(db)).toBe(false);
    // A user row does not affect the global flag.
    await setUserAutoFetchEnabled(db, "u1", true);
    expect(await isAutoFetchEnabled(db)).toBe(false);
  });
});

describe("settings UI", () => {
  it("keyboard uses green when on and red when off, with stable callback ids", () => {
    const on = buildSettingsKeyboard(true, false, true);
    expect(on[0][0]).toMatchObject({ text: "🎧 Auto-get music files: ON", style: "success", callback_data: "settings_toggle_autofetch" });
    expect(on[1][0]).toMatchObject({ text: "🔗 Link previews: ON", style: "success", callback_data: "settings_toggle_preview" });

    const off = buildSettingsKeyboard(false, true, false);
    expect(off[0][0]).toMatchObject({ text: "🎧 Auto-get music files: OFF", style: "danger" });
    expect(off[1][0]).toMatchObject({ text: "🔗 Link previews: OFF", style: "danger" });
  });

  it("text is plain-language and carries the global-off notice", () => {
    const normal = buildSettingsText(true, false, true);
    expect(normal).toContain("Auto-get music files");
    expect(normal).toContain("I fetch the audio for you automatically");
    expect(normal).toContain("preview card");

    const globalOff = buildSettingsText(false, true, true);
    expect(globalOff).toContain("temporarily unavailable");
    expect(globalOff).toContain("turned off for everyone");
  });
});

describe("settings callbacks", () => {
  let db: any;
  let ctx: any;

  beforeEach(() => {
    db = fakeKvDb();
    ctx = makeCtx({ callbackQuery: { data: "settings_toggle_autofetch" } });
  });

  it("global off: button answers an alert and does nothing", async () => {
    await setAutoFetchEnabled(db, false);

    await handleSettingsCallback(ctx, makeEnv(db));

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: "Auto-get is temporarily unavailable." }));
    // No user pref was written.
    expect([...db.kv.keys()].filter((k: string) => k.startsWith("pref_autofetch:"))).toHaveLength(0);
  });

  it("global on: toggling flips the user pref and re-renders", async () => {
    await setAutoFetchEnabled(db, true);
    expect(await isUserAutoFetchEnabled(db, "555")).toBe(true);

    await handleSettingsCallback(ctx, makeEnv(db));

    expect(await isUserAutoFetchEnabled(db, "555")).toBe(false);
    expect(ctx.editMessageText).toHaveBeenCalled();
    const render = ctx.editMessageText.mock.calls[0][0] as string;
    expect(render).toContain("Auto-get music files: <b>off</b>");
  });

  it("preview toggle flips the preview pref", async () => {
    ctx.callbackQuery.data = "settings_toggle_preview";

    await handleSettingsCallback(ctx, makeEnv(db));

    expect(await getUserLinkPreviewEnabled(db, "555")).toBe(false);
    const render = ctx.editMessageText.mock.calls[0][0] as string;
    expect(render).toContain("Link previews: <b>off</b>");
  });

  it("command renders current prefs", async () => {
    await handleSettingsCommand(ctx, makeEnv(db));

    // reply called with HTML text containing both settings
    const [text, opts] = (ctx.reply as any).mock.calls[0];
    expect(text).toContain("Your settings");
    expect(JSON.stringify(opts)).toContain("settings_toggle_autofetch");
  });
});
