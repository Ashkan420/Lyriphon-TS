import { describe, expect, it } from "vitest";
import { adminSettingsText, buildAdminKeyboard } from "../src/handlers/admin";

describe("admin settings UI", () => {
  it("buildAdminKeyboard colors toggles and hides Logs when debug is off", () => {
    const kb = buildAdminKeyboard(false, true);
    expect(kb).toHaveLength(2);
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
  });

  it("buildAdminKeyboard shows unstyled Logs when debug is on", () => {
    const kb = buildAdminKeyboard(true, false);
    expect(kb).toHaveLength(3);
    expect(kb[0][0].style).toBe("success");
    expect(kb[1][0].style).toBe("danger");
    expect(kb[2][0]).toEqual({ text: "📋 Logs", callback_data: "admin_logs" });
    expect(kb[2][0].style).toBeUndefined();
  });

  it("adminSettingsText includes on/off status", () => {
    const text = adminSettingsText(true, false);
    expect(text).toContain("Debug: <b>on</b>");
    expect(text).toContain("Multilingual: <b>off</b>");
  });
});
