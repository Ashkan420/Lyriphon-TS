// Source-language rules for German lyrics. German compounds, verb-final word
// order, and modal particles read awkwardly when translated literally.

export const GERMAN_SOURCE = `SOURCE LANGUAGE — GERMAN:
- Compound nouns (e.g. Sehnsucht, Fernweh, Weltschmerz) should be rendered as natural concepts or expressions in the target language, not literal word splits.
- Modal particles (doch, ja, mal, halt, eben, schon, etc.) express tone or attitude; reflect them through phrasing or omit if no natural equivalent exists.
- German word order (e.g. verb-final clauses, separable verbs) must NOT be preserved. Always rebuild using target-language syntax.`;
