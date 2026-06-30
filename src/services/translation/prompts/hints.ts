// Additional source-language fragments for secondary languages in multilingual
// songs. These are NOT hints — they are full directives that tell the AI to
// translate all text in that language, treating it as a co-equal source.

const LANGUAGE_NOTES: Record<string, string[]> = {
  ja: [
    "Translate ALL Japanese text into the target language. Do not leave any Japanese phrases untranslated.",
    "Sentence-final particles (ね, よ, な, だろう, でしょう) carry emotional tone rather than literal meaning — reflect as nuance.",
    "Honorifics and speech levels (keigo, casual forms) must be expressed through tone, not literal markers.",
    "Make implied meaning explicit when needed for clarity in the target language.",
  ],
  de: [
    "Translate ALL German text into the target language. Do not leave any German phrases untranslated.",
    "Compound nouns (e.g. Sehnsucht, Fernweh, Weltschmerz, Angriff, Befreiung) should be rendered as natural concepts or expressions in the target language, not literal word splits.",
    "Modal particles (doch, ja, mal, halt, eben, schon, etc.) express tone or attitude; reflect them through phrasing or omit if no natural equivalent exists.",
    "German word order (e.g. verb-final clauses, separable verbs) must NOT be preserved. Always rebuild using target-language syntax.",
  ],
  ko: [
    "Translate ALL Korean text into the target language. Do not leave any Korean phrases untranslated.",
    "Honorific and speech-level endings (-요, -습니다, -해, banmal vs. jondaetmal) signal social register, not literal words. Convey closeness or formality through tone.",
    "Render Korean idioms and four-character expressions by their meaning rather than their literal images.",
  ],
  es: [
    "Translate ALL Spanish text into the target language. Do not leave any Spanish phrases untranslated.",
    "Diminutives and augmentatives (-ito/-ita, -ón) carry affection, emphasis, or irony, not literal size. Convey that feeling through tone and word choice.",
    "Preserve the emotional register and rhythm of the original.",
  ],
  fr: [
    "Translate ALL French text into the target language. Do not leave any French phrases untranslated.",
    "The formal/informal distinction (vous vs. tu) usually has no target-language equivalent; convey closeness or distance through register, not invented words.",
    "Preserve the emotional register and any wordplay; French lyrics often rely on double meanings.",
  ],
  fa: [
    "Translate ALL Persian text into the target language. Do not leave any Persian phrases untranslated.",
    "Persian lyrics are rich in metaphor, classical imagery, and idiom. Render these by their emotional meaning, not their literal images.",
    "Preserve the emotional intensity and poetic weight.",
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
  return `ADDITIONAL SOURCE LANGUAGE — ${name}:\n${lines}\n- Treat all text in this language as source material to be fully translated. Do not skip or leave any portion untranslated.`;
}
