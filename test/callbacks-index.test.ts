import { describe, expect, it } from "vitest";
import { buildEditMenu, getDisplayLyrics, hashString, resetTranslationState } from "../src/handlers/callbacks/index";
import { createSessionData } from "../src/session/flows";

describe("getDisplayLyrics", () => {
  it("returns original lyrics when activeLang is original/undefined", () => {
    const s = createSessionData();
    s.telegraph.originalLyrics = "a\nb";
    expect(getDisplayLyrics(s)).toBe("a\nb");
  });

  it("returns null when no lyrics", () => {
    expect(getDisplayLyrics(createSessionData())).toBeNull();
  });

  it("recombines a cached JSON translation", () => {
    const s = createSessionData();
    const original = "hello\nworld";
    s.telegraph.originalLyrics = original;
    s.telegraph.activeLang = "en";
    const rawJson = JSON.stringify({ lines: [{ n: 1, t: "hola" }, { n: 2, t: "mundo" }] });
    s.telegraph.translatedLyrics = {
      [`en:${hashString(original)}`]: { originalHash: hashString(original), text: rawJson },
    };
    const display = getDisplayLyrics(s)!;
    expect(display).toContain("hello");
    expect(display).toContain("[hola]");
    expect(display).toContain("[mundo]");
  });
});

describe("buildEditMenu", () => {
  it("collapsed menu has 2 rows; expanded has field rows plus translate", () => {
    expect(buildEditMenu(false)).toHaveLength(2);
    const expanded = buildEditMenu(true);
    expect(expanded[0][0].callback_data).toBe("edit_field_lyrics");
    expect(expanded[expanded.length - 1][0].callback_data).toBe("translate:open");
  });

  it("includes the AI-summary refresh button in both variants", () => {
    const collapsed = buildEditMenu(false);
    expect(collapsed[1].some((b) => b.callback_data === "refresh_summary")).toBe(true);

    const expanded = buildEditMenu(true);
    expect(expanded[expanded.length - 1].some((b) => b.callback_data === "refresh_summary")).toBe(true);
  });

  // FR-024a — extraRows is the additive hook the /migrate return control uses.
  describe("extraRows", () => {
    const extra = [[{ text: "↩️ Back to this post", callback_data: "mig_return" }]];

    it("appends the row UNDER everything else in both variants", () => {
      for (const expanded of [false, true]) {
        const menu = buildEditMenu(expanded, { extraRows: extra });
        const last = menu[menu.length - 1];
        expect(last[0].callback_data).toBe("mig_return");
        // and it did not displace anything that was already there
        expect(menu.some((row) => row.some((b) => b.callback_data === "refresh_summary"))).toBe(true);
        expect(menu[0][0].callback_data).toBe(expanded ? "edit_field_lyrics" : "expand_edit_menu");
      }
    });

    it("lands after the owner-only Cache tools row when both are present", () => {
      const menu = buildEditMenu(true, { adminTools: true, trackId: 42, extraRows: extra });
      expect(menu[menu.length - 2][0].callback_data).toBe("dbview_card_42");
      expect(menu[menu.length - 1][0].callback_data).toBe("mig_return");
    });

    it("changes nothing for callers that do not pass it", () => {
      // Every existing call site passes an opts object without extraRows.
      expect(buildEditMenu(false)).toEqual(buildEditMenu(false, {}));
      expect(buildEditMenu(true)).toEqual(buildEditMenu(true, { adminTools: false }));
      expect(buildEditMenu(false).some((row) => row.some((b) => b.callback_data === "mig_return")))
        .toBe(false);
      expect(buildEditMenu(false)).toHaveLength(2);
      expect(buildEditMenu(true)).toHaveLength(6);
    });
  });
});

describe("resetTranslationState", () => {
  it("clears isTranslating and translateMessageId", () => {
    const s = createSessionData();
    s.telegraph.isTranslating = true;
    s.telegraph.translateMessageId = 5;
    resetTranslationState(s);
    expect(s.telegraph.isTranslating).toBe(false);
    expect(s.telegraph.translateMessageId).toBeUndefined();
  });
});
