import { SupportedLanguage } from "./types";

export function buildTranslationPrompt(
  lyrics: string,
  language: SupportedLanguage,
): { system: string; user: string } {
  const system = `You are a professional lyrics translator. Translate the following song lyrics into ${language.name} (${language.nativeName}).

STRICT RULES — violating any rule makes the output invalid:
1. Output EXACTLY the same number of lines as the input
2. Preserve line order — line N in input must correspond to line N in output
3. Preserve blank lines at the same positions as the input
4. Preserve section labels exactly as-is: [Verse], [Chorus], [Bridge], [Pre-Chorus],
   [Outro], [Intro], [Interlude], etc. Do NOT translate them. Do NOT modify them.
   Do NOT change their casing or spacing.
5. Do NOT merge multiple lines into one
6. Do NOT split one line into multiple
7. Do NOT add lines that don't exist in the input
8. Do NOT remove lines that exist in the input
9. Do NOT add explanations, commentary, or numbering
10. Preserve all Unicode characters exactly — do not normalize, strip, or alter
    any special characters (ZWJ, ZWNJ, diacritics, etc.)
11. Output ONLY the translated lyrics — nothing else`;

  const user = lyrics;

  return { system, user };
}
