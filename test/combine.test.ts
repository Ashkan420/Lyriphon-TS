import { describe, expect, it } from "vitest";
import { combineLyricsWithTranslation } from "../src/services/translation/combine";

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
