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
