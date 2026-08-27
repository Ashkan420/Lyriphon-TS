// Source-language rules for Vietnamese lyrics. Tone-based wordplay, the
// age/relationship pronoun system, and Sino-Vietnamese literary compounds
// need meaning-first handling.

export const VIETNAMESE_SOURCE = `SOURCE LANGUAGE — VIETNAMESE:
- Vietnamese pronouns (anh, em, chị, ông, bà, tôi, ta) encode age, gender, and relationship rather than neutral "I/you". Convey the relationship the pronoun choice implies through tone and address in the target language.
- Six tones make homophone wordplay and puns common in lyrics. When a pun cannot survive translation, translate the intended meaning and preserve the playful feel through phrasing.
- Sino-Vietnamese (Hán Việt) compounds give lyrics a literary, elevated register. Match it with elevated target-language phrasing; do not flatten literary lines into everyday speech.
- Vietnamese drops subjects and marks aspect with particles (đã, đang, sẽ). Resolve time and participants from context; express them naturally rather than leaving them ambiguous.
- Render idioms and folk imagery (moon, rice fields, Mandarinate nostalgia) by their emotional meaning; preserve repetition patterns and refrain structure.`;
