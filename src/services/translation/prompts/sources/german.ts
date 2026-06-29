// Source-language rules for German lyrics. German compounds, verb-final word
// order, and modal particles read awkwardly when translated literally.

export const GERMAN_SOURCE = `SOURCE LANGUAGE — GERMAN:

CORE TRANSLATION RULES:
- Translate meaning, not grammar. Do NOT preserve German word order or sentence structure; rebuild each line so it reads naturally in the target language.
- Treat each line as a complete semantic unit before reconstructing it naturally.

COMPOUND NOUNS & ABSTRACT TERMS:
- Unpack compound nouns (e.g. Fernweh, Sehnsucht, Weltschmerz) into the natural phrase, image, or concept the target language would use.
- Do NOT invent literal compound translations if they sound unnatural.

WORD ORDER & CLAUSE STRUCTURE:
- German frequently places verbs at the end of subordinate clauses and separates prefixes from verbs.
- Reconstruct sentences using the target language's natural syntax rather than preserving German structure.

MODAL PARTICLES & EMPHASIS:
- Modal particles (doch, ja, mal, halt, eben, schon, wohl, denn, etc.) express attitude, emphasis, or speaker intent rather than literal meaning.
- Convey their emotional effect through tone when appropriate, or omit them if no natural equivalent exists.

IDIOMS & FIGURATIVE LANGUAGE:
- Render idioms, figurative expressions, and culturally specific phrases by their intended meaning rather than their literal wording.
- Preserve metaphorical imagery when it feels natural in the target language; otherwise adapt it to achieve the same emotional effect.

REGISTER & PRONOUNS:
- Preserve the relationship between speakers (formal "Sie" vs. informal "du") through tone rather than literal wording when the distinction is not expressed in the target language.

EMOTIONAL & LYRICAL PRIORITY:
- German lyrics often use concise wording with dense emotional or philosophical meaning. Preserve the emotional weight rather than the literal wording.
- If a literal translation feels rigid or overly formal, rewrite it into natural, fluent target-language lyrics while preserving meaning.

FINAL OUTPUT BEHAVIOR:
- The output should read as though it was originally written in the target language, not translated.
- Freely restructure lines whenever doing so improves naturalness without changing the intended meaning.
`;


export const GERMAN_HINT = `SOURCE LANGUAGE — GERMAN:
- Focus on natural, meaning-based translation into the target language.
- Do not translate German structure literally; prioritize fluent target-language phrasing.
- Interpret compounds, idioms, and abstract expressions by their intended meaning.
- Treat modal particles as tone and emotional nuance rather than words.
- Preserve emotional intensity and lyrical impact over literal phrasing.
`;