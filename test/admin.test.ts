import { describe, expect, it } from "vitest";
import { adminSettingsText, buildAdminKeyboard, isBotOwner } from "../src/handlers/admin";

describe("admin settings UI", () => {
  it("buildAdminKeyboard colors toggles and hides Logs when debug is off", () => {
    const kb = buildAdminKeyboard(false, true, false);
    expect(kb).toHaveLength(4);
    expect(kb[0][0]).toMatchObject({
      text: "🐛 Debugging: OFF",
      callback_data: "admin_toggle_debug",
      style: "danger",
    });
    expect(kb[1][0]).toMatchObject({
      text: "🌐 Multilingual: ON",
      callback_data: "admin_toggle_multilingual",
      style: "success",
    });
    expect(kb[2][0]).toMatchObject({
      text: "🎧 Auto-fetch: OFF",
      callback_data: "admin_toggle_autofetch",
      style: "danger",
    });
  });

  it("buildAdminKeyboard shows unstyled Logs when debug is on", () => {
    const kb = buildAdminKeyboard(true, false, true);
    expect(kb).toHaveLength(5);
    expect(kb[0][0].style).toBe("success");
    expect(kb[1][0].style).toBe("danger");
    expect(kb[2][0]).toMatchObject({ text: "🎧 Auto-fetch: ON", style: "success" });
    expect(kb[3][0]).toEqual({ text: "📋 Logs", callback_data: "admin_logs" });
    expect(kb[3][0].style).toBeUndefined();
  });

  it("buildAdminKeyboard always offers the Track cache browser", () => {
    const kbOff = buildAdminKeyboard(false, true, false);
    const kbOn = buildAdminKeyboard(true, false, true);
    expect(kbOff[3][0]).toEqual({ text: "🗄 Track cache", callback_data: "admin_db" });
    expect(kbOn[4][0]).toEqual({ text: "🗄 Track cache", callback_data: "admin_db" });
  });

  it("adminSettingsText includes on/off status", () => {
    const text = adminSettingsText(true, false, true);
    expect(text).toContain("Debug: <b>on</b>");
    expect(text).toContain("Multilingual: <b>off</b>");
    expect(text).toContain("Auto-fetch: <b>on</b>");
  });
});

describe("isBotOwner", () => {
  const ctx = (id?: number) => ({ from: id ? { id } : undefined }) as any;

  it("returns false for everyone when BOT_OWNER_ID is unset (fail closed)", () => {
    expect(isBotOwner(ctx(123), {} as any)).toBe(false);
    expect(isBotOwner(ctx(undefined), {} as any)).toBe(false);
  });

  it("matches only the configured owner id", () => {
    expect(isBotOwner(ctx(42), { BOT_OWNER_ID: "42" } as any)).toBe(true);
    expect(isBotOwner(ctx(43), { BOT_OWNER_ID: "42" } as any)).toBe(false);
  });
});
