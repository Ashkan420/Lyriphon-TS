// Source-language rules for Japanese lyrics. Japanese grammar, dropped
// subjects, and sentence-final nuance rarely survive a literal rendering, so
// these rules push toward meaning-first, natural output in the target language.

export const JAPANESE_SOURCE = `SOURCE LANGUAGE — JAPANESE:

CORE TRANSLATION RULES:
- Translate MEANING, not grammar. Do NOT preserve Japanese word order or sentence structure; rebuild each line so it reads naturally in the target language.
- Treat each line as a self-contained semantic unit first, then reconstruct fluently in the target language.

SUBJECT & OBJECT INFERENCE:
- Japanese frequently omits subjects, objects, and sometimes verbs.
- Infer missing elements from context, previous lines, and implied speaker perspective.
- Default rule:
  - If unclear, assume the speaker ("I / we") or addressee ("you") based on emotional context.
- NEVER leave a line structurally incomplete in the target language.

NUANCE & SENTENCE ENDINGS:
- Sentence-final particles (ね, よ, な, ぞ, だろう, でしょう, etc.) and elongated endings encode tone, not meaning.
- Convert them into natural equivalents in the target language such as:
  - certainty / insistence
  - softness / hesitation
  - emphasis / emotional weight
- NEVER translate particles literally or preserve them as words.

ONOMATOPOEIA & SOUND SYMBOLISM:
- Japanese giongo/gitaigo (e.g. ドキドキ, キラキラ, ふわふわ) must NOT be transliterated.
- Convert them into:
  - equivalent emotional descriptions, or
  - natural sensory imagery in the target language
- If no equivalent exists, prioritize emotional effect over literal sound imitation.

REGISTER & SPEECH LEVELS:
- Honorifics and speech styles (keigo, casual form, -です / -だ / -よ / -ね distinctions) do NOT map directly into most languages.
- Preserve their social/emotional function (polite, intimate, distant, assertive) through tone and wording only.
- Do NOT invent honorific markers in the target language.

LEXICAL CONSISTENCY:
- Maintain consistent translations for recurring phrases, hooks, and repeated lyrical motifs.
- If a phrase is intentionally repeated in Japanese, reflect that repetition naturally in the target language.

WORDS THAT SHOULD REMAIN UNCHANGED:
- Keep proper nouns, artist-specific terms, and intentional English/Japanese loanwords if they are stylistically meaningful in the original.
- If a phrase is commonly known in Japanese pop culture (catchphrases, hooks), prefer consistency over variation.

EMOTIONAL PRIORITY:
- Always prioritize emotional intent, atmosphere, and lyrical rhythm over literal meaning.
- Japanese lyrics often rely on implication and silence; ensure the translation makes implicit meaning explicit when necessary for clarity.

FINAL OUTPUT BEHAVIOR:
- Output must always be fully grammatical and natural in the target language.
- Do NOT preserve ambiguity that exists only due to Japanese ellipsis unless ambiguity is intentional and meaningful in the original.
`;
