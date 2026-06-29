// Source-language rules for Japanese lyrics. Japanese grammar, dropped
// subjects, and sentence-final nuance rarely survive a literal rendering, so
// these rules push toward meaning-first, natural output in the target language.

export const JAPANESE_SOURCE = `SOURCE LANGUAGE — JAPANESE

CORE TRANSLATION RULES:
- Translate meaning, not grammar. Do NOT preserve Japanese word order; reconstruct each line naturally in the target language.
- Treat each line as a self-contained unit, then refine using full-song context.
- Infer omitted subjects/objects from context and emotion. If unclear, default to speaker ("I/we") or addressee ("you").
- Never output incomplete sentences in the target language.

TONE & STRUCTURE:
- Sentence-ending particles (ね, よ, な, etc.) encode tone, not meaning; convert into natural emotional equivalents.
- Do NOT transliterate or preserve Japanese onomatopoeia (e.g. ドキドキ); translate into emotion or imagery.
- Honorifics and speech levels (keigo, casual forms) must be expressed through tone, not literal markers.

LEXICAL RULES:
- Preserve proper nouns, titles, and stylistic loanwords unless translation is clearly better.
- Keep translations consistent across repeated phrases and motifs.
- Preserve intentional repetition unless context requires change.

EMOTIONAL PRIORITY:
- Prioritize emotion, atmosphere, and lyrical flow over literal accuracy.
- Make implied meaning explicit when needed for clarity in the target language.
- Output must read like an original lyric, not a translation.

FINAL BEHAVIOR:
- Do not add explanations, commentary, or extra formatting.
`;