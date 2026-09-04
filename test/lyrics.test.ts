import { describe, expect, it } from "vitest";
import { normalizeLyrics } from "../src/utils/lyrics";

describe("normalizeLyrics", () => {
  it("strips a trailing newline (LRCLIB plainLyrics, e.g. メフィスト)", () => {
    expect(normalizeLyrics("line one\nline two\n")).toBe("line one\nline two");
  });

  it("strips multiple trailing newlines (e.g. Subways Of Your Mind \\n\\n)", () => {
    expect(normalizeLyrics("a\nb\n\n\n")).toBe("a\nb");
  });

  it("strips a leading newline", () => {
    expect(normalizeLyrics("\nline one\nline two")).toBe("line one\nline two");
  });

  it("normalizes CRLF and lone CR", () => {
    expect(normalizeLyrics("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("collapses 3+ consecutive newlines to one blank line", () => {
    expect(normalizeLyrics("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("leaves interior lines untouched except edge trim and CRLF", () => {
    // Deliberately minimal: only edge trimming + newline normalization —
    // interior per-line trimming is not this helper's job.
    const clean = " verse \n\n chorus ";
    expect(normalizeLyrics(clean)).toBe("verse \n\n chorus");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeLyrics("\n \n\n")).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeLyrics("")).toBe("");
  });

  it("preserves interior single blank lines between stanzas", () => {
    expect(normalizeLyrics("a\n\nb")).toBe("a\n\nb");
  });
});
