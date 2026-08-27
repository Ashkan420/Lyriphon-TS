// Source-language rules for Russian lyrics. Case-driven free word order,
// diminutives, and tone particles need meaning-first handling because a
// literal rendering produces stilted output.

export const RUSSIAN_SOURCE = `SOURCE LANGUAGE — RUSSIAN:
- Russian word order is free because grammatical roles are marked by case endings. Never mirror Russian word order in the target language — rebuild each line with natural target-language syntax.
- Diminutives (солнышко, малышка, ручки) express affection, tenderness, or irony — not literal smallness. Convey the emotional coloring through word choice and tone.
- Particles and discourse words (же, ведь, ну, вот, уж) carry emphasis and attitude rather than lexical meaning. Reflect them through phrasing or emphasis; do not translate them as words.
- Russian lyrics lean on a strong poetic tradition with strict meter and rhyme. Preserve the rhythmic feel and repetition patterns where possible; do not flatten them into prose.
- Render folk imagery, patronymics, and culturally bound references by their emotional meaning for a Russian reader; make implicit references explicit only when the target language requires it.`;
