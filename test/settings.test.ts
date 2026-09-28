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
  isUserRichDeliveryEnabled,
  setUserRichDeliveryEnabled,
  isRichDeliveryEnabled,
  setRichDeliveryEnabled,
  isRichDeliveryActive,
  isAlbumSearchEnabled,
  setAlbumSearchEnabled,
  getUserRichStyle,
  setUserRichStyle,
  getUserRichPosition,
  setUserRichPosition,
  getUserRichColor,
  setUserRichColor,
  getSetting,
  setSetting,
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
  it("auto-fetch and previews default ON, rich delivery defaults OFF (opt-in)", async () => {
    const db = fakeKvDb();
    expect(await isUserAutoFetchEnabled(db, "u1")).toBe(true);
    expect(await getUserLinkPreviewEnabled(db, "u1")).toBe(true);
    expect(await isUserRichDeliveryEnabled(db, "u1")).toBe(false);

    await setUserAutoFetchEnabled(db, "u1", false);
    await setUserLinkPreviewEnabled(db, "u1", false);
    await setUserRichDeliveryEnabled(db, "u1", true);
    expect(await isUserAutoFetchEnabled(db, "u1")).toBe(false);
    expect(await getUserLinkPreviewEnabled(db, "u1")).toBe(false);
    expect(await isUserRichDeliveryEnabled(db, "u1")).toBe(true);

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

  it("album search toggle defaults off and flips", async () => {
    const db = fakeKvDb();
    expect(await isAlbumSearchEnabled(db)).toBe(false);
    await setAlbumSearchEnabled(db, true);
    expect(await isAlbumSearchEnabled(db)).toBe(true);
    await setAlbumSearchEnabled(db, false);
    expect(await isAlbumSearchEnabled(db)).toBe(false);
  });

  it("rich delivery gate is global AND per-user (both opt-in, fail closed)", async () => {
    const db = fakeKvDb();
    // Global off (default) → inactive regardless.
    expect(await isRichDeliveryActive(db, "u1")).toBe(false);

    // Global on but user pref missing (default off) → still inactive.
    await setRichDeliveryEnabled(db, true);
    expect(await isRichDeliveryActive(db, "u1")).toBe(false);

    // User opts in → active.
    await setUserRichDeliveryEnabled(db, "u1", true);
    expect(await isRichDeliveryActive(db, "u1")).toBe(true);

    // User opts back out → inactive again.
    await setUserRichDeliveryEnabled(db, "u1", false);
    expect(await isRichDeliveryActive(db, "u1")).toBe(false);
  });

  it("rich layout pref defaults to 1, persists 1|2, migrates old style 3", async () => {
    const db = fakeKvDb();
    expect(await getUserRichStyle(db, "u1")).toBe(1);
    await setUserRichStyle(db, "u1", 2);
    expect(await getUserRichStyle(db, "u1")).toBe(2);
    // Legacy "3" (removed art+credit layout) reads as layout 2.
    await setSetting(db, "pref_richstyle:u1", "3");
    expect(await getUserRichStyle(db, "u1")).toBe(2);
    // Garbage reads as layout 1.
    await setSetting(db, "pref_richstyle:u1", "9");
    expect(await getUserRichStyle(db, "u1")).toBe(1);
  });

  it("rich position and color prefs default and clamp", async () => {
    const db = fakeKvDb();
    expect(await getUserRichPosition(db, "u1")).toBe("center");
    expect(await getUserRichColor(db, "u1")).toBe("primary");

    await setUserRichPosition(db, "u1", "right");
    await setUserRichColor(db, "u1", "success");
    expect(await getUserRichPosition(db, "u1")).toBe("right");
    expect(await getUserRichColor(db, "u1")).toBe("success");

    // Invalid writes are ignored (defaults stand).
    await setUserRichPosition(db, "u1", "diagonal" as any);
    await setUserRichColor(db, "u1", "rainbow" as any);
    expect(await getUserRichPosition(db, "u1")).toBe("right");
    expect(await getUserRichColor(db, "u1")).toBe("success");
  });
});

describe("settings UI", () => {
  it("keyboard uses green when on and red when off, with stable callback ids", () => {
    const on = buildSettingsKeyboard(true, false, true, true);
    expect(on[0][0]).toMatchObject({ text: "🎧 Auto-get music files: ON", style: "success", callback_data: "settings_toggle_autofetch" });
    expect(on[1][0]).toMatchObject({ text: "🎨 Rich music delivery: ON", style: "success", callback_data: "settings_toggle_rich" });
    expect(on[2][0]).toMatchObject({ text: "🖼 Rich styles", callback_data: "settings_richstyles" });
    expect(on[3][0]).toMatchObject({ text: "🔗 Link previews: ON", style: "success", callback_data: "settings_toggle_preview" });

    const off = buildSettingsKeyboard(false, true, false, false);
    expect(off[0][0]).toMatchObject({ text: "🎧 Auto-get music files: OFF", style: "danger" });
    expect(off[1][0]).toMatchObject({ text: "🎨 Rich music delivery: OFF", style: "danger" });
    expect(off[2][0]).toMatchObject({ text: "🖼 Rich styles", callback_data: "settings_richstyles" });
    expect(off[3][0]).toMatchObject({ text: "🔗 Link previews: OFF", style: "danger" });
  });

  it("text is plain-language and carries the global-off notices", () => {
    const normal = buildSettingsText(true, false, true, true, false);
    expect(normal).toContain("Auto-get music files");
    expect(normal).toContain("I fetch the audio for you automatically");
    expect(normal).toContain("Rich music delivery");
    expect(normal).toContain("preview card");

    const globalOff = buildSettingsText(false, true, true, false, true);
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

  it("rich toggle flips the rich pref (default off → on, global on)", async () => {
    await setRichDeliveryEnabled(db, true);
    ctx.callbackQuery.data = "settings_toggle_rich";

    await handleSettingsCallback(ctx, makeEnv(db));

    expect(await isUserRichDeliveryEnabled(db, "555")).toBe(true);
    const render = ctx.editMessageText.mock.calls[0][0] as string;
    expect(render).toContain("Rich music delivery: <b>on</b>");
  });

  it("rich global off: toggle alerts and writes nothing even with user pref on", async () => {
    // User pref on but the admin switch off → the toggle must no-op.
    await setUserRichDeliveryEnabled(db, "555", true);

    ctx.callbackQuery.data = "settings_toggle_rich";
    await handleSettingsCallback(ctx, makeEnv(db));

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: "Rich music delivery is temporarily unavailable." }));
    // The user pref was left untouched (still on).
    expect(await isUserRichDeliveryEnabled(db, "555")).toBe(true);
  });

  it("rich global off: render shows the row OFF plus the global-off notice", async () => {
    await setUserRichDeliveryEnabled(db, "555", true);
    // isRichDeliveryEnabled stays false (default) → richGlobalDisabled.

    await handleSettingsCommand(ctx, makeEnv(db));

    const [text] = (ctx.reply as any).mock.calls[0];
    expect(text).toContain("Rich music delivery: <b>off</b>");
    expect(text).toContain("Rich music delivery is temporarily unavailable");
  });

  it("rich global on + user off: no notice and the toggle flips", async () => {
    await setRichDeliveryEnabled(db, true);

    await handleSettingsCommand(ctx, makeEnv(db));
    const [text] = (ctx.reply as any).mock.calls[0];
    expect(text).toContain("Rich music delivery: <b>off</b>");
    expect(text).not.toContain("Rich music delivery is temporarily unavailable");

    ctx.callbackQuery.data = "settings_toggle_rich";
    await handleSettingsCallback(ctx, makeEnv(db));

    expect(await isUserRichDeliveryEnabled(db, "555")).toBe(true);
  });

  it("command renders current prefs", async () => {
    await handleSettingsCommand(ctx, makeEnv(db));

    // reply called with HTML text containing both settings
    const [text, opts] = (ctx.reply as any).mock.calls[0];
    expect(text).toContain("Your settings");
    expect(JSON.stringify(opts)).toContain("settings_toggle_autofetch");
  });
});
