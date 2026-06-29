// Fallback source rules used when the detected language has no dedicated
// fragment, or when language detection failed. Language-agnostic, meaning-first
// guidance.

export const GENERAL_SOURCE = `SOURCE LANGUAGE — GENERAL:

CORE TRANSLATION RULES:
- Translate meaning, tone, and emotional intent rather than literal words or grammar. Reconstruct each line so it reads naturally in the target language.
- Do not preserve source-language word order or sentence structure; always adapt to natural target-language syntax.
- Treat each line as a semantic unit and prioritize clarity and fluency in the target language.

INTERPRETATION & UNCERTAINTY:
- If idioms, cultural references, or expressions are unclear, infer meaning only from strong contextual signals; otherwise prefer a neutral, natural rendering over speculative detail.
- When subjects or objects are omitted, infer them only when clearly implied; otherwise keep phrasing general rather than guessing incorrectly.

IDIOMS & FIGURATIVE LANGUAGE:
- Render idioms, proverbs, and set expressions by meaning, not literal translation.
- Preserve metaphors when they are understandable; otherwise adapt them into equivalent emotional imagery in the target language.

REGISTER & TONE:
- Convey formality, intimacy, and emotional tone through phrasing rather than literal markers.
- Ensure the final output reads as natural lyrics originally written in the target language.

FINAL BEHAVIOR:
- Prioritize fluent, natural target-language lyrics even when the source is ambiguous or structurally unclear.`;