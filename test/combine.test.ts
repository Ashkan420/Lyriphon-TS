import { describe, expect, it } from "vitest";
import { combineLyricsWithTranslation, parseTranslationJson, combineLyricsFromJson } from "../src/services/translation/combine";

describe("parseTranslationJson", () => {
  // parseTranslationJson takes the ORIGINAL lyrics and uses them as the
  // alignment skeleton, so tests pass text rather than a line count.

  it("parses valid JSON against matching original lines", () => {
    const json = JSON.stringify({ lines: [{ n: 1, t: "hello" }, { n: 2, t: "world" }] });
    const result = parseTranslationJson(json, "hello\nworld");
    expect(result).toBe("hello\nworld");
  });

  it("strips markdown code fences", () => {
    const json = "```json\n" + JSON.stringify({ lines: [{ n: 1, t: "hi" }] }) + "\n```";
    const result = parseTranslationJson(json, "hi");
    expect(result).toBe("hi");
  });

  it("strips plain code fences", () => {
    const json = "```\n" + JSON.stringify({ lines: [{ n: 1, t: "hi" }] }) + "\n```";
    const result = parseTranslationJson(json, "hi");
    expect(result).toBe("hi");
  });

  it("returns null for invalid JSON", () => {
    const result = parseTranslationJson("not json", "anything");
    expect(result).toBeNull();
  });

  it("returns null when the model DROPPED a real lyric", () => {
    const json = JSON.stringify({ lines: [{ n: 1, t: "a" }, { n: 2, t: "b" }] });
    const result = parseTranslationJson(json, "a\nb\nc");
    expect(result).toBeNull();
  });

  it("returns null when the model INVENTED a real lyric", () => {
    const json = JSON.stringify({
      lines: [{ n: 1, t: "a" }, { n: 2, t: "b" }, { n: 3, t: "c" }],
    });
    const result = parseTranslationJson(json, "a\nb");
    expect(result).toBeNull();
  });

  it("returns null when lines array is empty", () => {
    const json = JSON.stringify({ lines: [] });
    const result = parseTranslationJson(json, "");
    expect(result).toBeNull();
  });

  it("returns null when lines key is missing", () => {
    const result = parseTranslationJson(JSON.stringify({ foo: "bar" }), "a");
    expect(result).toBeNull();
  });

  it("returns null when line numbers are out of order", () => {
    const json = JSON.stringify({ lines: [{ n: 2, t: "b" }, { n: 1, t: "a" }] });
    const result = parseTranslationJson(json, "a\nb");
    expect(result).toBeNull();
  });

  it("returns null when entry has invalid t type", () => {
    const json = JSON.stringify({ lines: [{ n: 1, t: 123 }] });
    const result = parseTranslationJson(json, "a");
    expect(result).toBeNull();
  });

  it("returns null when an entry is missing t entirely", () => {
    const json = JSON.stringify({ lines: [{ n: 1 }] });
    expect(parseTranslationJson(json, "a")).toBeNull();
  });

  it("takes blanks from the original, not the model", () => {
    const json = JSON.stringify({
      lines: [{ n: 1, t: "hello" }, { n: 2, t: "" }, { n: 3, t: "world" }],
    });
    const result = parseTranslationJson(json, "hello\n\nworld");
    expect(result).toBe("hello\n\nworld");
  });

  it("accepts a model that emitted an EXTRA blank line", () => {
    // The live failure: a song whose tail repeats one line four times made
    // Gemini emit 64 entries for a 63-line input. The surplus was a blank, so
    // every real line still pairs one-for-one — array length is not what is
    // being checked any more.
    const original = "verse one\n\nverse two\n\nverse three";
    const json = JSON.stringify({
      lines: [
        { n: 1, t: "vers un" },
        { n: 2, t: "" },
        { n: 3, t: "vers deux" },
        { n: 4, t: "" },
        { n: 5, t: "" },              // surplus blank the model invented
        { n: 6, t: "vers trois" },
      ],
    });
    expect(parseTranslationJson(json, original)).toBe("vers un\n\nvers deux\n\nvers trois");
  });

  it("accepts a model that OMITTED the blank lines entirely", () => {
    // The observed retry: blanks collapsed, so a positional compare declared
    // drift even though every real line translated correctly.
    const original = "verse one\n\nverse two\n\nverse three";
    const json = JSON.stringify({
      lines: [
        { n: 1, t: "vers un" },
        { n: 2, t: "vers deux" },
        { n: 3, t: "vers trois" },
      ],
    });
    expect(parseTranslationJson(json, original)).toBe("vers un\n\nvers deux\n\nvers trois");
  });

  it("keeps the original's blank structure when the model puts them elsewhere", () => {
    // Model blank at index 1-2, original blank at index 1 and 3: the original
    // decides where the blanks land, not the model.
    const original = "a\n\nb\n\nc";
    const json = JSON.stringify({
      lines: [
        { n: 1, t: "A" },
        { n: 2, t: "" },
        { n: 3, t: "" },
        { n: 4, t: "B" },
        { n: 5, t: "C" },
      ],
    });
    expect(parseTranslationJson(json, original)).toBe("A\n\nB\n\nC");
  });

  it("normalizes the original before counting (phantom trailing blank)", () => {
    // normalizeLyrics strips a trailing blank, otherwise our count and the
    // model's differ for reasons that have nothing to do with the model.
    const json = JSON.stringify({ lines: [{ n: 1, t: "a" }, { n: 2, t: "b" }] });
    expect(parseTranslationJson(json, "a\nb\n\n")).toBe("a\nb");
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
    const original = "[Verse 1]\nسلام دنیا\n[Chorus]\nخداحافظ";
    const result = parseTranslationJson(json, original);
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

  it("returns null when a non-blank line gets an empty translation (model drift)", () => {
    // The reported Mephisto artifact: one dropped line shifts every following
    // pair, producing bare "[]" brackets under lyric lines.
    const original = "line one\nline two\nline three";
    const lines = ["uno", "", "tres"];
    const result = combineLyricsFromJson(original, lines);
    expect(result).toBeNull();
  });

  it("returns null when a blank line gets a non-empty translation (model drift)", () => {
    const original = "line one\n\nline three";
    const lines = ["uno", "extra", "tres"];
    const result = combineLyricsFromJson(original, lines);
    expect(result).toBeNull();
  });

  it("allows an empty translation for a symbol-only line like ♪", () => {
    const original = "line one\n♪\nline three";
    const lines = ["uno", "", "tres"];
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

describe("combine CRLF and JSON validation edge cases", () => {
  it("normalizes CRLF line endings on every line, not just the first", () => {
    const original = "line one\r\n\r\nline two\r\nline three";
    const result = combineLyricsFromJson(original, ["uno", "", "dos", "tres"]);
    expect(result).not.toBeNull();
    expect(result!.combined).not.toContain("\r");
    expect(result!.combined).toContain("[uno]");
    expect(result!.combined).toContain("[dos]");
    expect(result!.combined).toContain("[tres]");
  });

  it("returns null when an entry is missing t entirely", () => {
    const json = JSON.stringify({ lines: [{ n: 1 }] });
    expect(parseTranslationJson(json, "a")).toBeNull();
  });
});
