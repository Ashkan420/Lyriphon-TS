// Source-language rules for Japanese lyrics. Japanese grammar, dropped
// subjects, and sentence-final nuance rarely survive a literal rendering, so
// these rules push toward meaning-first, natural output in the target language.

export const JAPANESE_SOURCE = `SOURCE LANGUAGE — JAPANESE:
- Sentence-final particles (ね, よ, な, etc.) encode tone, not meaning; convert into natural emotional equivalents.
- Do NOT transliterate or preserve Japanese onomatopoeia (e.g. ドキドキ); translate into emotion or imagery.
- Honorifics and speech levels (keigo, casual forms) must be expressed through tone, not literal markers.
- Make implied meaning explicit when needed for clarity in the target language.`;
