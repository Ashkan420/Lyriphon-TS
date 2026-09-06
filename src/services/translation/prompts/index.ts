import { SupportedLanguage, LanguageCode } from "../types";
import { BASE_PROMPT } from "./base";
import { ENGLISH_TARGET } from "./targets/english";
import { FARSI_TARGET } from "./targets/farsi";
import { LanguageAnalysis, getSourceFragments, getSourceFragmentNames, rebaseAnalysisForTarget } from "../language-analyzer";

/**
 * Maps target-language codes to target-prompt fragments.
 */
const TARGET_FRAGMENTS: Record<LanguageCode, string> = {
  en: ENGLISH_TARGET,
  fa: FARSI_TARGET,
};

/**
 * Assemble a translation system prompt from modular fragments.
 *
 * The language analysis is rebased for the target first: the target language
 * needs no translation, so it's dropped from the source analysis and the
 * remaining languages drive the prompt (a 55% EN / 45% JA song targeted at
 * English composes as a Japanese source, not "English source + JA hint").
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

  const system = [BASE_PROMPT, ...sourceFragments, targetFragment]
    .filter(Boolean)
    .join("\n\n");

  return { system, user: lyrics, modules: { base: true, source, secondary, target: target.code } };
}
