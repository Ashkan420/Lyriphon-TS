const LANGUAGE_NOTES: Record<string, string[]> = {
  ja: [
    "Infer omitted subjects and objects where needed so meaning remains clear.",
    "Sentence-final particles (ね, よ, な, だろう, でしょう) carry emotional tone rather than literal meaning — reflect as nuance.",
    "When Japanese appears inside mixed lines, adjust its tone to fit the surrounding language rather than translating in isolation.",
  ],
  de: [
    "Interpret German phrases by meaning rather than structure.",
    "Unpack compound nouns (Sehnsucht, Fernweh, Weltschmerz) into natural equivalents.",
    "Treat modal particles (doch, ja, mal, halt, eben, schon) as tone markers, not words to translate.",
  ],
  ko: [
    "Infer omitted subjects, render implied meaning naturally.",
    "Do not preserve Korean word order or honorific suffixes.",
  ],
  es: [
    "Render Spanish idioms and figurative phrasing by meaning, not literally.",
    "Preserve emotional register.",
  ],
  fr: [
    "Render French idiom and figurative phrasing by meaning, not literally.",
    "Preserve emotional register.",
  ],
  fa: [
    "Render Persian metaphors and idioms into natural target phrasing rather than literal images.",
    "Preserve emotional intensity.",
  ],
};

const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  ja: "JAPANESE",
  de: "GERMAN",
  ko: "KOREAN",
  es: "SPANISH",
  fr: "FRENCH",
  fa: "PERSIAN",
};

export function getHintFragment(code: string): string {
  const notes = LANGUAGE_NOTES[code];
  if (!notes) return "";
  const name = LANGUAGE_DISPLAY_NAMES[code] ?? code.toUpperCase();
  const lines = notes.map(n => `- ${n}`).join("\n");
  return `LANGUAGE HINT — ${name} (secondary):\n${lines}\n- Primary language rules take precedence; this hint only adjusts interpretation and tone.`;
}
