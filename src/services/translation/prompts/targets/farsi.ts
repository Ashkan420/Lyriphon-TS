// Target-language rules for translating INTO Persian/Farsi. The no-ZWNJ rule
// is critical: zero-width characters break the line-matching in combine.ts.

export const FARSI_TARGET = `TARGET LANGUAGE — PERSIAN (FARSI):

- Write natural, fluent Persian that reads like original lyrics, not a translation.
- Preserve tone, emotion, and poetic intensity of the original.
- Do NOT use ZWNJ (U+200C) or any invisible characters. Use normal spacing only (a normal space where a ZWNJ would conventionally go)..
- Do NOT translate source syntax literally. Avoid copying structures like “X is Y” or word-for-word word order from German, Japanese, or English.
- Reorder sentences freely to match natural Persian lyric flow, even if it differs from the source structure.
- Prefer idiomatic Persian expressions over literal equivalents, especially in poetic or emotional lines.
- In lyrical or poetic contexts, allow omission of the copula (است) when natural, and use more compressed phrasing where appropriate.
- Match register carefully:
  - poetic lines → lyrical / elevated Persian
  - casual lines → conversational Persian
- Use standard, widely understood Persian vocabulary; avoid overly classical or archaic wording unless clearly intended.
- Maintain line-by-line structure exactly, but each line should feel naturally written in Persian rather than translated.`;