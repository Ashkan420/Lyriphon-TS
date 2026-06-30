const LANGUAGE_NOTES: Record<string, string[]> = {
  ja: [
    "Translate all Japanese text into the target language. Do not leave Japanese phrases untranslated.",
    "Sentence-final particles (ね, よ, な, だろう, でしょう) carry emotional tone rather than literal meaning — reflect as nuance.",
    "When Japanese appears inside mixed lines, adjust its tone to fit the surrounding language rather than translating in isolation.",
  ],
  de: [
    "Translate all German text into the target language. Do not leave German phrases untranslated.",
    "Unpack compound nouns (Sehnsucht, Fernweh, Weltschmerz) into natural equivalents.",
    "Treat modal particles (doch, ja, mal, halt, eben, schon) as tone markers — convey through phrasing in the target language.",
  ],
  ko: [
    "Translate all Korean text into the target language. Do not leave Korean phrases untranslated.",
    "Do not preserve Korean word order or honorific suffixes.",
  ],
  es: [
    "Translate all Spanish text into the target language. Do not leave Spanish phrases untranslated.",
    "Preserve emotional register.",
  ],
  fr: [
    "Translate all French text into the target language. Do not leave French phrases untranslated.",
    "Preserve emotional register.",
  ],
  fa: [
    "Translate all Persian text into the target language. Do not leave Persian phrases untranslated.",
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
