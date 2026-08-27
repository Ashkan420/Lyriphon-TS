// Source-language rules for Italian lyrics. Dropped subjects, clitic
// pronouns, and generic endearments need natural meaning-first handling.

export const ITALIAN_SOURCE = `SOURCE LANGUAGE — ITALIAN:
- Italian drops subject pronouns (verb endings mark person) and uses clitic pronouns (mi, ti, lo, la, ne, ci) heavily. Resolve references from context and make them explicit in the target language so each line reads clearly.
- Endearments (amore, cara, bello, tesoro) are often generic affectionate address rather than literal descriptions. Keep them as address where natural; do not translate them as literal attributes.
- The tu/Lei distinction signals intimacy or formality. Convey the relationship through register in the target language — not by inventing formal markers.
- Italian lyrics rely on double meanings and musical phrasing (especially in the cantautore and pop traditions). Preserve wordplay where possible and keep lines singable and rhythmically light.
- Render regional expressions and dialect coloring by their meaning and emotional register, not by transliterating the dialect.`;
