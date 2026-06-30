// Source-language rules for Japanese lyrics. Japanese grammar, dropped
// subjects, and sentence-final nuance rarely survive a literal rendering, so
// these rules push toward meaning-first, natural output in the target language.

export const JAPANESE_SOURCE = `SOURCE LANGUAGE — JAPANESE:
- Sentence-final particles (ね, よ, な, だろう, でしょう, わ, ぞ, ぜ) encode tone, speaker attitude, and emotional nuance — not literal meaning. Convert them into natural emotional equivalents in the target language; do not translate them as words.
- Japanese omits pronouns, subjects, and objects far more aggressively than most languages. Resolve the intended referent from context and make it explicit in the target language so the translation reads clearly — but do not guess when context is ambiguous; keep phrasing general.
- Japanese lyrics often favor indirect, suggestive expression over direct statement. When the source circles a feeling without naming it, preserve that evasiveness in the target language rather than spelling out what is only implied.
- Onomatopoeia (擬音語) and mimetic words (擬態語) — e.g. ドキドキ, キラキラ, ユラユラ, ソワソワ — are pervasive in Japanese lyrics and rarely have a direct equivalent. Translate the sensation or imagery they convey, not their sound; use whatever phrasing feels natural in the target language.
- Honorific and speech levels (keigo: 尊敬語, 謙譲語, 丁寧語 vs. casual/da-form) signal social register and emotional distance. Express closeness or formality through tone and word choice — never through literal markers or invented honorifics.
- Seasonal and nature imagery (桜/cherry blossoms, 月/moon, 雪/snow, 落葉/fallen leaves) carries culturally specific emotional weight in Japanese — often evoking mono no aware (the pathos of things). Translate the feeling these images carry for a Japanese reader, not just their literal object.`;
