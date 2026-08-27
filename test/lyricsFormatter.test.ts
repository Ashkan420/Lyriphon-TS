import { describe, expect, it } from "vitest";
import { formatLyricsForTelegraph } from "../src/services/lyricsFormatter";

describe("formatLyricsForTelegraph", () => {
  it("renders empty lyrics as a placeholder paragraph", () => {
    expect(formatLyricsForTelegraph("")).toEqual([
      { tag: "p", children: ["Lyrics not found."] },
    ]);
  });

  it("merges an original line with its [translation] into one paragraph", () => {
    // Shape produced by services/translation/combine.ts
    const nodes = formatLyricsForTelegraph("hello world\n[سلام دنیا]");
    expect(nodes).toEqual([
      { tag: "p", children: ["hello world", { tag: "br" }, "[سلام دنیا]"] },
    ]);
  });

  it("merges pairs while keeping section labels standalone", () => {
    // combine output for `[Verse 1]/hello/[Chorus]/goodbye` originals:
    const combined = "[Verse 1]\nhello world\n[سلام دنیا]\n\n[Chorus]\ngoodbye\n[خداحافظ]";
    const nodes = formatLyricsForTelegraph(combined);
    expect(nodes).toEqual([
      { tag: "p", children: ["[Verse 1]"] },
      { tag: "p", children: ["hello world", { tag: "br" }, "[سلام دنیا]"] },
      { tag: "p", children: ["\u200B"] },
      { tag: "p", children: ["[Chorus]"] },
      { tag: "p", children: ["goodbye", { tag: "br" }, "[خداحافظ]"] },
    ]);
  });

  it("keeps a leading bracket-wrapped line (e.g. label) on its own even mid-segment", () => {
    // If a stanza opens with a bracket line, the NEXT lyric after it is still
    // merged only when followed by its own bracket pair.
    const nodes = formatLyricsForTelegraph("[Intro]\nsome line\n[some translation]");
    expect(nodes).toEqual([
      { tag: "p", children: ["[Intro]"] },
      { tag: "p", children: ["some line", { tag: "br" }, "[some translation]"] },
    ]);
  });

  it("preserves duplicate-suppressed lines without brackets", () => {
    // When the translation equals the original (duplicates ruled out),
    // combine emits just the original — no <br> merging may occur.
    const nodes = formatLyricsForTelegraph("hold on.\nlet me go");
    expect(nodes).toEqual([
      { tag: "p", children: ["hold on."] },
      { tag: "p", children: ["let me go"] },
    ]);
  });

  it("separates stanzas with the zero-width spacer paragraph", () => {
    const nodes = formatLyricsForTelegraph("line one\n[line uno]\n\nline two");
    expect(nodes.filter(n => n === "\u200B" || (n as any).children?.[0] === "\u200B")).toHaveLength(1);
  });
});