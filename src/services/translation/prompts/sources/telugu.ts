// Source-language rules for Telugu lyrics. The gap between literary and
// spoken Telugu, and Sanskrit-heavy film diction, need register-aware
// meaning-first handling.

export const TELUGU_SOURCE = `SOURCE LANGUAGE — TELUGU:
- Telugu has a wide register gap between literary/classical usage (grandhika) and everyday speech (vaaduka). Film lyrics often deliberately alternate — translate the register actually used, line by line.
- Song vocabulary is frequently Sanskrit-heavy and ornate. Render elevated lines with elevated target-language phrasing; render conversational lines conversationally.
- Compound verbs (verb + auxiliary constructions) compress aspect and nuance — convey the completed/ongoing feel naturally rather than mirroring the construction.
- Telugu is agglutinative: case, mood, and politeness attach as suffixes. Unpack them into natural target-language syntax; never translate suffixes literally.
- Preserve vocatives (ఓ, రా, రే) as emotional address and keep refrain repetition intact; the emotional directness matters more than the particle itself.`;
