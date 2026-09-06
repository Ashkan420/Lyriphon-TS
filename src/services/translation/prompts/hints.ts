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
  ar: [
    "Translate ALL Arabic text into the target language. Do not leave any Arabic phrases untranslated.",
    "Arabic lyrics mix Modern Standard Arabic with sung dialects — match the register actually used.",
    "Render religious and classical expressions by their everyday emotional force, not literally.",
  ],
  hi: [
    "Translate ALL Hindi text into the target language. Do not leave any Hindi phrases untranslated.",
    "Hindi lyrics blend Hindi, Urdu vocabulary, and English — translate embedded English consistently with the whole.",
    "आप/तुम/तू politeness signals the relationship; convey it through tone, not literal markers.",
  ],
  ru: [
    "Translate ALL Russian text into the target language. Do not leave any Russian phrases untranslated.",
    "Never mirror Russian case-driven word order — rebuild each line with natural target-language syntax.",
    "Diminutives (солнышко, малышка) express affection or irony, not literal smallness.",
  ],
  tr: [
    "Translate ALL Turkish text into the target language. Do not leave any Turkish phrases untranslated.",
    "Agglutinative endings carry clause-level meaning (gelemedim = \"I couldn't come\") — unpack them into natural phrasing.",
    "Translate loanwords by their modern Turkish meaning, not their language of origin.",
  ],
  it: [
    "Translate ALL Italian text into the target language. Do not leave any Italian phrases untranslated.",
    "Endearments (amore, cara, tesoro) are usually generic affectionate address, not literal descriptions.",
    "Resolve dropped subjects and clitic pronouns from context so each line reads clearly.",
  ],
  pt: [
    "Translate ALL Portuguese text into the target language. Do not leave any Portuguese phrases untranslated.",
    "Culturally dense words (saudade, oxalá) need equivalent emotional weight, not flat glosses.",
    "Match the variant and register actually used (Brazilian vs. European; colloquial stays colloquial).",
  ],
  zh: [
    "Translate ALL Chinese text into the target language. Do not leave any Chinese phrases untranslated.",
    "Four-character idioms (成语) compress allusions — translate their meaning, never character-by-character.",
    "Chinese verbs carry no tense; resolve time from context and express it naturally.",
  ],
  pa: [
    "Translate ALL Punjabi text into the target language. Do not leave any Punjabi phrases untranslated.",
    "Punjabi pop mixes English slang with village-folk imagery — translate embedded English consistently.",
    "Folk refrains and vocative repetition carry the emotion; keep them intact.",
  ],
  ta: [
    "Translate ALL Tamil text into the target language. Do not leave any Tamil phrases untranslated.",
    "Agglutinative case suffixes pack meaning into word endings — unpack them into natural phrasing.",
    "Sangam-era classical imagery carries conventional emotional weight — translate the feeling, not the literal object.",
  ],
  te: [
    "Translate ALL Telugu text into the target language. Do not leave any Telugu phrases untranslated.",
    "Film lyrics alternate between literary (grandhika) and spoken (vaaduka) registers — match the register sung.",
    "Suffixes mark case, mood, and politeness; unpack them naturally, never literally.",
  ],
  bn: [
    "Translate ALL Bengali text into the target language. Do not leave any Bengali phrases untranslated.",
    "Rain, monsoon, river, and separation (biroho) imagery are conventional emotional codes — render their feeling.",
    "Match literary (sadhu) vs. colloquial (cholito) registers line by line.",
  ],
  th: [
    "Translate ALL Thai text into the target language. Do not leave any Thai phrases untranslated.",
    "Politeness particles (ครับ, ค่ะ, นะ) signal mood and softness — reflect them through tone, never as words.",
    "Pronouns are usually dropped; resolve speaker/addressee relationships from context.",
  ],
  he: [
    "Translate ALL Hebrew text into the target language. Do not leave any Hebrew phrases untranslated.",
    "Biblical allusions in secular songs keep their resonance — don't flatten them into ordinary wording.",
    "Trilateral-root wordplay (like Arabic) conveys a shared semantic echo — render it naturally.",
  ],
  id: [
    "Translate ALL Indonesian text into the target language. Do not leave any Indonesian phrases untranslated.",
    "Poetic particles (-lah, -kah, -pun) add emphasis or softness — reflect through phrasing, never as words.",
    "Match formal Bahasa vs. Jakarta-slang registers actually used in the song.",
  ],
  vi: [
    "Translate ALL Vietnamese text into the target language. Do not leave any Vietnamese phrases untranslated.",
    "Pronouns (anh, em, chị) encode age and relationship — convey the relationship through tone and address.",
    "Tone-based puns rarely survive; translate the intended meaning and keep the playfulness in phrasing.",
  ],
  tl: [
    "Translate ALL Filipino (Tagalog) text into the target language. Do not leave any Filipino phrases untranslated.",
    "Taglish code-switching is expressive — translate embedded English consistently with the whole.",
    "Respect markers (po, opo) signal deference; convey it through register, not literal markers.",
  ],
  el: [
    "Translate ALL Greek text into the target language. Do not leave any Greek phrases untranslated.",
    "Sea, exile (xenitia), and village imagery carry strong cultural nostalgia — render their feeling.",
    "Match demotic-folk vs. entekhno art-song registers actually used.",
  ],
  pl: [
    "Translate ALL Polish text into the target language. Do not leave any Polish phrases untranslated.",
    "Perfective/imperfective aspect choice signals completion or repetition — preserve the nuance naturally.",
    "Gendered past tense reveals the speaker — resolve gender from context.",
  ],
  sv: [
    "Translate ALL Swedish text into the target language. Do not leave any Swedish phrases untranslated.",
    "Swedish understatement and quiet melancholy must not be inflated into dramatic declarations.",
    "Resolve homonyms (visa = song/show/visa document) from context before translating.",
  ],
  sr: [
    "Translate ALL Serbian text into the target language. Do not leave any Serbian phrases untranslated.",
    "Case-driven free word order is poetic — rebuild each line with natural target-language syntax.",
    "Vocatives (brate, dušo) are emotional address — keep them warm and natural.",
  ],
  hr: [
    "Translate ALL Croatian text into the target language. Do not leave any Croatian phrases untranslated.",
    "Dialect color (Dalmatian etc.) is emotional flavor — translate the standard meaning.",
    "Coastal imagery (sea, jugo wind, stone towns) carries nostalgic weight — render the feeling.",
  ],
};

const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  ja: "JAPANESE",
  de: "GERMAN",
  ko: "KOREAN",
  es: "SPANISH",
  fr: "FRENCH",
  fa: "PERSIAN",
  ar: "ARABIC",
  hi: "HINDI",
  ru: "RUSSIAN",
  tr: "TURKISH",
  it: "ITALIAN",
  pt: "PORTUGUESE",
  zh: "CHINESE",
  pa: "PUNJABI",
  ta: "TAMIL",
  te: "TELUGU",
  bn: "BENGALI",
  th: "THAI",
  he: "HEBREW",
  id: "INDONESIAN",
  vi: "VIETNAMESE",
  tl: "FILIPINO",
  el: "GREEK",
  pl: "POLISH",
  sv: "SWEDISH",
  sr: "SERBIAN",
  hr: "CROATIAN",
};

export function getHintFragment(code: string): string {
  const notes = LANGUAGE_NOTES[code];
  if (!notes) return "";
  const name = getLanguageDisplayName(code);
  const lines = notes.map(n => `- ${n}`).join("\n");
  return `ADDITIONAL SOURCE LANGUAGE — ${name}:\n${lines}\n- Treat all text in this language as source material to be fully translated. This directive takes precedence over the "iconic phrase" exception: translate ALL text in this language, including famous catchphrases, title phrases, and recurring refrains. Do not skip or leave any portion untranslated.`;
}

export function getLanguageDisplayName(code: string): string {
  return LANGUAGE_DISPLAY_NAMES[code] ?? code.toUpperCase();
}
