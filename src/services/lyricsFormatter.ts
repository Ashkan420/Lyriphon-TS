import { TelegraphNode } from "./telegraph";

export function formatLyricsForTelegraph(lyrics: string): TelegraphNode[] {
  if (!lyrics) {
    return [{ tag: "p", children: ["Lyrics not found."] }];
  }

  const normalized = lyrics.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const segments = normalized.split(/\n\s*\n/);
  const nodes: TelegraphNode[] = [];

  for (let i = 0; i < segments.length; i++) {
    const lines = segments[i].split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      nodes.push({ tag: "p", children: [line] });
    }
    if (i < segments.length - 1) {
      nodes.push({ tag: "p", children: ["\u200B"] });
    }
  }

  return nodes;
}
