import { TelegraphNode } from "./telegraph";

export function formatLyricsForTelegraph(lyrics: string): TelegraphNode[] {
  if (!lyrics) {
    return [{ tag: "p", children: ["Lyrics not found."] }];
  }

  const normalized = lyrics.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const segments = normalized.split(/\n\s*\n/);
  const nodes: TelegraphNode[] = [];

  for (const segment of segments) {
    const lines = segment.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      nodes.push({ tag: "p", children: [line] });
    }
  }

  return nodes;
}
