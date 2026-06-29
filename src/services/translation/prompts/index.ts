import { SupportedLanguage, LanguageCode } from "../types";
import { BASE_PROMPT } from "./base";
import { GENERAL_SOURCE } from "./sources/general";
import { ENGLISH_TARGET } from "./targets/english";
import { FARSI_TARGET } from "./targets/farsi";
import { LanguageAnalysis, getSourceFragments, getSourceFragmentNames } from "../language-analyzer";

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
 * @param lyrics        The raw source lyrics (used only as the user message).
 * @param target        The target language descriptor (from SUPPORTED_LANGUAGES).
 * @param langAnalysis  Language analysis result (mode, primary, secondary, etc.).
 * @returns { system, user } ready for Gemini (or any LLM).
 */
export function composeTranslationPrompt(
  lyrics: string,
  target: SupportedLanguage,
  langAnalysis?: LanguageAnalysis,
): { system: string; user: string; modules: { base: boolean; source: string; secondary: string[]; target: string } } {
  const targetFragment = TARGET_FRAGMENTS[target.code] ?? "";
  const sourceFragments = getSourceFragments(langAnalysis);
  const { source, secondary } = getSourceFragmentNames(langAnalysis);

  const system = [BASE_PROMPT, ...sourceFragments, targetFragment]
    .filter(Boolean)
    .join("\n\n");

  return { system, user: lyrics, modules: { base: true, source, secondary, target: target.code } };
}
