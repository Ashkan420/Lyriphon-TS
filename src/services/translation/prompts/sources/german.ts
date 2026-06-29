// Source-language rules for German lyrics. German compounds, verb-final word
// order, and modal particles read awkwardly when translated literally.

export const GERMAN_SOURCE = `SOURCE LANGUAGE — GERMAN

MEANING RULES:
- Translate meaning, not grammar. Do NOT preserve German word order; reconstruct each line naturally in the target language.
- Treat each line as a complete semantic unit before translation.

INTERPRETATION RULES:
- Compound nouns (e.g. Sehnsucht, Fernweh, Weltschmerz) should be rendered as natural concepts or expressions in the target language, not literal word splits.
- Idioms and figurative language must be translated by intended meaning, not literal wording.
- Modal particles (doch, ja, mal, halt, eben, schon, etc.) express tone or attitude; reflect them through phrasing or omit if no natural equivalent exists.

STRUCTURE & SYNTAX:
- German word order (e.g. verb-final clauses, separable verbs) must NOT be preserved. Always rebuild using target-language syntax.

EMOTIONAL PRIORITY:
- Preserve emotional weight, nuance, and conciseness rather than literal structure.
- If a literal translation sounds rigid, rewrite for natural lyric flow while keeping meaning intact.

OUTPUT BEHAVIOR:
- Output must read like it was originally written in the target language.
- Do not add explanations, commentary, or formatting.
`;