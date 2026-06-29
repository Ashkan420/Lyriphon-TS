// Source-language rules for Korean lyrics. Korean drops subjects, stacks
// honorific/speech-level endings, and leans on idiom — all of which need a
// meaning-first rendering.

export const KOREAN_SOURCE = `SOURCE LANGUAGE — KOREAN:
- Translate the MEANING, not the grammar. Do NOT preserve Korean word order; rebuild each line to flow naturally in the target language.
- Korean often omits subjects and objects. Infer them from context and supply them naturally so the line is complete.
- Honorific and speech-level endings (-요, -습니다, -해, banmal vs. jondaetmal) signal social register, not literal words. Convey closeness or formality through tone — do not translate the endings as words.
- Render Korean idioms and four-character expressions by their meaning rather than their literal images.
- Keep recurring hooks consistent, preferring a natural target-language rendering over romanization unless the phrase is clearly meant to stay in Korean.`;
