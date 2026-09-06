import { SupportedLanguage, LanguageCode, findLanguage } from "../types";
import { BASE_PROMPT } from "./base";
import { ENGLISH_TARGET } from "./targets/english";
import { FARSI_TARGET } from "./targets/farsi";
import { LanguageAnalysis, getSourceFragments, getSourceFragmentNames, rebaseAnalysisForTarget } from "../language-analyzer";
import { getLanguageDisplayName } from "./hints";

/**
 * Maps target-language codes to target-prompt fragments.
 */
const TARGET_FRAGMENTS: Record<LanguageCode, string> = {
  en: ENGLISH_TARGET,
  fa: FARSI_TARGET,
};

/**
 * Directive for songs where the translation TARGET also appears in the lyrics
 * (code-switched, e.g. half English / half Japanese targeted at English).
 * Without it, small models see "source: Japanese" but half-English text and
 * take lazy paths — echoing the original or transliterating it (romaji)
 * instead of translating. Says explicitly what stays and what must change.
 */
function composeMixedLanguageBlock(
  rebased: LanguageAnalysis,
  targetCode: LanguageCode,
): string {
  const targetName = findLanguage(targetCode)?.name ?? targetCode.toUpperCase();
  // hints.ts display names are uppercase ("JAPANESE") for fragment headers;
  // in prose they read naturally title-cased.
  const sourceNames = [rebased.primary.code, ...rebased.meaningful.map(d => d.code)]
    .filter((code, idx, arr) => arr.indexOf(code) === idx)
    .map(code => {
      const name = getLanguageDisplayName(code);
      return name.charAt(0) + name.slice(1).toLowerCase();
    })
    .join(", ");
  return `MIXED SOURCE AND TARGET LANGUAGE:
This song mixes ${targetName} with ${sourceNames} — parts of the lyrics are already in ${targetName}.
- Lines or fragments already entirely in ${targetName} stay unchanged.
- ALL other text (${sourceNames}) MUST be fully translated into natural ${targetName}. Do not leave any ${sourceNames} phrases untranslated, and do NOT transliterate them into Latin script — translate their meaning.
- Mixed lines (${sourceNames} + ${targetName} in one line): translate the non-${targetName} parts, keep the ${targetName} parts, so the whole line reads naturally in ${targetName}.`;
}

/**
 * Assemble a translation system prompt from modular fragments.
 *
 * The language analysis is rebased for the target first: the target language
 * needs no translation, so it's dropped from the source analysis and the
 * remaining languages drive the prompt (a 55% EN / 45% JA song targeted at
 * English composes as a Japanese source, not "English source + JA hint").
 * When the target was actually present in the lyrics (the rebase dropped
 * something), a mixed-language directive is appended — see
 * composeMixedLanguageBlock.
 *
 * @param lyrics        The raw source lyrics (used only as the user message).
 * @param target        The target language descriptor (from SUPPORTED_LANGUAGES).
 * @param langAnalysis  Language analysis result (mode, primary, secondary, etc.).
 * @returns { system, user } ready for Gemini (or any LLM).
 */
export function composeTranslationPrompt(
  lyrics: string,
  target: SupportedLanguage,
  langAnalysis?: LanguageAnalysis,
  multilingualEnabled = true,
): { system: string; user: string; modules: { base: boolean; source: string; secondary: string[]; target: string } } {
  const targetFragment = TARGET_FRAGMENTS[target.code] ?? "";
  const rebased = rebaseAnalysisForTarget(langAnalysis, target.code);
  const sourceFragments = getSourceFragments(rebased, multilingualEnabled);
  const { source, secondary } = getSourceFragmentNames(rebased, multilingualEnabled);

  // The rebase returned a NEW object only when it filtered the target out;
  // identity with the input means the target wasn't in the lyrics (or there
  // was no analysis) — no mixed-language block then.
  const mixedBlock = rebased && rebased !== langAnalysis
    ? composeMixedLanguageBlock(rebased, target.code)
    : "";

  const system = [BASE_PROMPT, ...sourceFragments, mixedBlock, targetFragment]
    .filter(Boolean)
    .join("\n\n");

  return { system, user: lyrics, modules: { base: true, source, secondary, target: target.code } };
}
