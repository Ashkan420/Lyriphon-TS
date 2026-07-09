import { describe, expect, it } from "vitest";
import { combineLyricsWithTranslation, parseTranslationJson, combineLyricsFromJson } from "../src/services/translation/combine";

describe("parseTranslationJson", () => {
  it("parses valid JSON with correct line count", () => {
    const json = JSON.stringify({ lines: [{ n: 1, t: "hello" }, { n: 2, t: "world" }] });
    const result = parseTranslationJson(json, 2);
    expect(result).toBe("hello\nworld");
  });

  it("strips markdown code fences", () => {
    const json = "```json\n" + JSON.stringify({ lines: [{ n: 1, t: "hi" }] }) + "\n```";
    const result = parseTranslationJson(json, 1);
    expect(result).toBe("hi");
  });

  it("strips plain code fences", () => {
    const json = "```\n" + JSON.stringify({ lines: [{ n: 1, t: "hi" }] }) + "\n```";
    const result = parseTranslationJson(json, 1);
    expect(result).toBe("hi");
  });

  it("returns null for invalid JSON", () => {
    const result = parseTranslationJson("not json", 1);
    expect(result).toBeNull();
  });

  it("returns null when line count mismatches", () => {
    const json = JSON.stringify({ lines: [{ n: 1, t: "a" }, { n: 2, t: "b" }] });
    const result = parseTranslationJson(json, 3);
    expect(result).toBeNull();
  });

  it("returns null when lines array is empty", () => {
    const json = JSON.stringify({ lines: [] });
    const result = parseTranslationJson(json, 0);
    expect(result).toBeNull();
  });

  it("returns null when lines key is missing", () => {
    const result = parseTranslationJson(JSON.stringify({ foo: "bar" }), 1);
    expect(result).toBeNull();
  });

  it("returns null when line numbers are out of order", () => {
    const json = JSON.stringify({ lines: [{ n: 2, t: "b" }, { n: 1, t: "a" }] });
    const result = parseTranslationJson(json, 2);
    expect(result).toBeNull();
  });

  it("returns null when entry has invalid t type", () => {
    const json = JSON.stringify({ lines: [{ n: 1, t: 123 }] });
    const result = parseTranslationJson(json, 1);
    expect(result).toBeNull();
  });

  it("handles blank lines as empty t values", () => {
    const json = JSON.stringify({ lines: [{ n: 1, t: "hello" }, { n: 2, t: "" }, { n: 3, t: "world" }] });
    const result = parseTranslationJson(json, 3);
    expect(result).toBe("hello\n\nworld");
  });

  it("handles section labels preserved as-is", () => {
    const json = JSON.stringify({
      lines: [
        { n: 1, t: "[Verse 1]" },
        { n: 2, t: "سلام دنیا" },
        { n: 3, t: "[Chorus]" },
        { n: 4, t: "خداحافظ" },
      ],
    });
    const result = parseTranslationJson(json, 4);
    expect(result).toBe("[Verse 1]\nسلام دنیا\n[Chorus]\nخداحافظ");
  });
});

describe("combineLyricsFromJson", () => {
  it("interleaves JSON-parsed translation lines", () => {
    const original = "line one\nline two\nline three";
    const lines = ["خط یک", "خط دو", "خط سه"];
    const result = combineLyricsFromJson(original, lines);
    expect(result?.combined).toBe("line one\n[خط یک]\nline two\n[خط دو]\nline three\n[خط سه]");
    expect(result?.mismatch).toBe(false);
  });

  it("passes section labels through verbatim", () => {
    const original = "[Verse 1]\nhello world\n[Chorus]\ngoodbye";
    const lines = ["[Verse 1]", "سلام دنیا", "[Chorus]", "خداحافظ"];
    const result = combineLyricsFromJson(original, lines);
    expect(result?.combined).toBe(
      "[Verse 1]\nhello world\n[سلام دنیا]\n[Chorus]\ngoodbye\n[خداحافظ]",
    );
    expect(result?.mismatch).toBe(false);
  });

  it("preserves blank lines that align", () => {
    const original = "verse one\n\nverse two";
    const lines = ["بند یک", "", "بند دو"];
    const result = combineLyricsFromJson(original, lines);
    expect(result?.combined).toBe("verse one\n[بند یک]\n\nverse two\n[بند دو]");
    expect(result?.mismatch).toBe(false);
  });

  it("does not duplicate a line whose translation matches after punctuation stripping", () => {
    const original = "hold on.\nlet me go";
    const lines = ["hold on", "let me go"];
    const result = combineLyricsFromJson(original, lines);
    expect(result?.combined).toBe("hold on.\nlet me go");
    expect(result?.mismatch).toBe(false);
  });

  it("returns null for empty lines array", () => {
    const result = combineLyricsFromJson("hello", []);
    expect(result).toBeNull();
  });

  it("trims trailing blank lines from original before combining", () => {
    const original = "line one\nline two\n\n";
    const lines = ["خط یک", "خط دو"];
    const result = combineLyricsFromJson(original, lines);
    expect(result?.combined).toBe("line one\n[خط یک]\nline two\n[خط دو]");
    expect(result?.mismatch).toBe(false);
  });

  it("always returns mismatch: false since JSON guarantees alignment", () => {
    const original = "a\nb\nc";
    const lines = ["x", "y", "z"];
    const result = combineLyricsFromJson(original, lines);
    expect(result?.mismatch).toBe(false);
  });
});

describe("combineLyricsWithTranslation", () => {
  it("interleaves translation as [bracketed] lines under each original", () => {
    const original = "line one\nline two\nline three";
    const translated = "خط یک\nخط دو\nخط سه";
    const result = combineLyricsWithTranslation(original, translated);
    expect(result?.combined).toBe("line one\n[خط یک]\nline two\n[خط دو]\nline three\n[خط سه]");
    expect(result?.mismatch).toBe(false);
  });

  it("attaches translation as a separate block when line counts differ", () => {
    const original = "a\nb\nc";
    const translated = "x\ny";
    const result = combineLyricsWithTranslation(original, translated);
    expect(result?.combined).toBe("a\nb\nc\n\n— — —\n\nx\ny");
    expect(result?.mismatch).toBe(true);
  });

  it("does not duplicate a line whose translation matches after punctuation stripping", () => {
    // When the translated text equals the original (minus trailing punctuation),
    // it should NOT be wrapped in brackets again.
    const original = "hold on.\nlet me go";
    const translated = "hold on\nlet me go";
    const result = combineLyricsWithTranslation(original, translated);
    expect(result?.combined).toBe("hold on.\nlet me go");
    expect(result?.mismatch).toBe(false);
  });

  it("passes section labels through verbatim and does not wrap them", () => {
    const original = "[Verse 1]\nhello world\n[Chorus]\ngoodbye";
    const translated = "[Verse 1]\nسلام دنیا\n[Chorus]\nخداحافظ";
    const result = combineLyricsWithTranslation(original, translated);
    expect(result?.combined).toBe(
      "[Verse 1]\nhello world\n[سلام دنیا]\n[Chorus]\ngoodbye\n[خداحافظ]",
    );
    expect(result?.mismatch).toBe(false);
  });

  it("attaches translation as a separate block when a section label is mismatched", () => {
    const original = "[Verse 1]\nhello";
    const translated = "[Bridge]\nسلام";
    const result = combineLyricsWithTranslation(original, translated);
    expect(result?.combined).toBe("[Verse 1]\nhello\n\n— — —\n\n[Bridge]\nسلام");
    expect(result?.mismatch).toBe(true);
  });

  it("attaches translation as a separate block on blank-line position mismatch", () => {
    const original = "hello\n\nworld";
    const translated = "سلام\nخوبی\nدنیا";
    const result = combineLyricsWithTranslation(original, translated);
    expect(result?.combined).toBe("hello\n\nworld\n\n— — —\n\nسلام\nخوبی\nدنیا");
    expect(result?.mismatch).toBe(true);
  });

  it("preserves blank lines that align between both sides", () => {
    // Each non-blank translated line differs from its original, so it is
    // bracketed; the blank line in the middle is preserved verbatim.
    const original = "verse one\n\nverse two";
    const translated = "بند یک\n\nبند دو";
    const result = combineLyricsWithTranslation(original, translated);
    expect(result?.combined).toBe("verse one\n[بند یک]\n\nverse two\n[بند دو]");
    expect(result?.mismatch).toBe(false);
  });

  it("trims trailing blank lines before comparing", () => {
    const original = "line one\nline two\n\n";
    const translated = "خط یک\nخط دو";
    const result = combineLyricsWithTranslation(original, translated);
    expect(result?.combined).toBe("line one\n[خط یک]\nline two\n[خط دو]");
    expect(result?.mismatch).toBe(false);
  });

  it("normalizes zero-width characters and CRLF", () => {
    const original = "hello\r\nworld";
    const translated = "سلام‌‌\r\nدنیا"; // includes ZWSP/ZWNJ
    const result = combineLyricsWithTranslation(original, translated);
    expect(result?.combined).toBe("hello\n[سلام]\nworld\n[دنیا]");
    expect(result?.mismatch).toBe(false);
  });

  it("returns null for empty translation", () => {
    const result = combineLyricsWithTranslation("hello", "");
    expect(result).toBeNull();
  });

  it("returns null for whitespace-only translation", () => {
    const result = combineLyricsWithTranslation("hello", "  \n  ");
    expect(result).toBeNull();
  });
});
