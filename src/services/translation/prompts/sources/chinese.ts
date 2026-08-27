// Source-language rules for Chinese (Mandarin) lyrics, applying to both
// simplified and traditional characters. The grammar is uninflected and the
// idiom stock is compressed, so literal rendering loses both time reference
// and imagery.

export const CHINESE_SOURCE = `SOURCE LANGUAGE — CHINESE (MANDARIN):
- Chinese verbs carry no tense or number; time and aspect come from context and markers like 了, 过, 会, 已经, 正在. Resolve the intended time reference from context and express it naturally in the target language instead of leaving it ambiguous.
- Four-character idioms (成语) and set expressions compress a whole story or allusion into a few characters. Render their understood meaning and imagery; do not translate character-by-character.
- Homophone wordplay (谐音) is frequent in modern lyrics. When a pun cannot survive translation, convey the intended meaning and, where possible, the feeling of the play through phrasing.
- Classical allusions and poetic imagery (月/moon, 江/river, 落花/fallen flowers) draw on a long literary tradition. Translate the emotional resonance for a Chinese reader rather than the bare literal object.
- Chinese lines are compact; do not pad translations with filler to match length. Keep each line tight and natural.
- Simplified and traditional characters follow the same rules; script variety never implies a meaning difference.`;
