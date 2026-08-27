import { TelegraphNode } from "./telegraph";

// Lines fully wrapped in square brackets following a plain lyric line are
// translation pairs emitted by services/translation/combine.ts. Section
// labels ([Verse 1], ...) pass through combine standalone, so they never
// appear right after another lyric line.
const BRACKETED_LINE_RE = /^\[.+\]$/;

export function formatLyricsForTelegraph(lyrics: string): TelegraphNode[] {
  if (!lyrics) {
    return [{ tag: "p", children: ["Lyrics not found."] }];
  }

  const normalized = lyrics.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const segments = normalized.split(/\n\s*\n/);
  const nodes: TelegraphNode[] = [];

  for (let i = 0; i < segments.length; i++) {
    const lines = segments[i].split("\n").map(l => l.trim()).filter(Boolean);

    let j = 0;
    while (j < lines.length) {
      const line = lines[j];
      const next = lines[j + 1];

      // Merge an original line and its [translation] into ONE paragraph,
      // separated by an embedded line break, instead of two separate ones.
      if (
        next !== undefined &&
        !BRACKETED_LINE_RE.test(line) &&
        BRACKETED_LINE_RE.test(next)
      ) {
        nodes.push({ tag: "p", children: [line, { tag: "br" }, next] });
        j += 2;
        continue;
      }

      nodes.push({ tag: "p", children: [line] });
      j += 1;
    }

    if (i < segments.length - 1) {
      nodes.push({ tag: "p", children: ["\u200B"] });
    }
  }

  return nodes;
}
