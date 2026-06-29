// Target-language rules for translating INTO Persian/Farsi. The no-ZWNJ rule
// is critical: zero-width characters break the line-matching in combine.ts.

export const FARSI_TARGET = `TARGET LANGUAGE — PERSIAN (FARSI):
- Write natural, fluent Persian that reads well to a native speaker. Preserve the tone and emotion of the original lyrics.
- Match the register of the original — keep casual lyrics conversational and poetic lyrics lyrical.
- Do NOT use ZWNJ (U+200C) or any zero-width / invisible characters anywhere in the output. Use standard Persian spacing only (a normal space where a ZWNJ would conventionally go).
- Use standard, widely understood Persian vocabulary; avoid obscure or overly classical wording unless the original calls for it.
- Render the meaning idiomatically in Persian rather than translating English/source structure literally.`;
