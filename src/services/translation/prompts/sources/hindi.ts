// Source-language rules for Hindi lyrics. Bollywood and modern Hindi songs
// freely blend Hindi, Urdu vocabulary, and English, and the politeness ladder
// and idioms need meaning-first handling.

export const HINDI_SOURCE = `SOURCE LANGUAGE — HINDI:
- Hindi lyrics freely blend Sanskrit-derived Hindi, Persian/Urdu-derived vocabulary, and English. Translate embedded English words and phrases consistently with the overall translation; do not leave them untranslated unless they are well-known titles or catchphrases.
- The politeness ladder (आप vs. तुम vs. तू) signals respect, intimacy, or distance. Convey the relationship through tone and register in the target language — never by literally marking formality.
- Idioms (मुहावरे) and set phrases must be rendered by their understood meaning, not word-for-word; prefer equivalent target-language expressions of similar weight.
- Film-lyric conventions: vocative particles (ओ, अरे), repeated address of the beloved, and refrain-like repetition carry rhythm and emotion — keep the intensity and musicality without mechanically preserving the particles.
- Do not romanize Hindi words or names unless they are widely recognized in the target language.`;
