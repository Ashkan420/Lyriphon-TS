// Source-language rules for Arabic lyrics. Arabic diglossia (Modern Standard
// Arabic vs. sung dialects), root-based wordplay, and religious/classical
// resonance need meaning-first handling to avoid stilted output.

export const ARABIC_SOURCE = `SOURCE LANGUAGE — ARABIC:
- Arabic diglossia: lyrics may mix Modern Standard Arabic with Egyptian, Levantine, Gulf, or Maghrebi dialect. Translate the register actually being sung — colloquial lyrics must not be upgraded to formal prose, and formal lyrics must not be flattened into slang.
- Root-based wordplay: Arabic derives whole word families from trilateral roots (ك-ت-ب → كتاب، كاتب، مكتبة). When a lyric plays on related root forms, convey the shared semantic echo naturally instead of translating each word in isolation.
- Religious and classical expressions (إن شاء الله، الحمد لله، والله, Quranic echoes) are cultural commonplaces, not theological statements — render their everyday emotional force, keeping their weight without over-literalizing.
- The vocative particle يا and poetic oaths carry emotional emphasis; reflect the intensity in the target language rather than translating the particle itself.
- Arabic proverbs and set expressions should be rendered by their understood meaning, using equivalent target-language expressions of similar gravity when available.`;
