// Canonical lyrics normalization. LRCLIB plainLyrics frequently carries
// trailing/leading newlines (verified: メフィスト, One Voice, Subways Of Your
// Mind); those phantom blank lines inflate the translation line count and make
// parseTranslationJson hard-fail against Gemini's (correct) output. Every
// lyrics entry point — LRCLIB fetch, D1 cache read, edit flow, translate —
// funnels through this so the prompt text and the line count are the same
// string everywhere.
export function normalizeLyrics(lyrics: string): string {
  return (lyrics ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n") // 3+ newlines are always accidental
    .trim();                    // strips leading/trailing blank lines
}
