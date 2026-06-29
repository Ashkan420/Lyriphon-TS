import { SupportedLanguage, LanguageCode } from "../types";
import { BASE_PROMPT } from "./base";
import { JAPANESE_SOURCE } from "./sources/japanese";
import { GERMAN_SOURCE } from "./sources/german";
import { KOREAN_SOURCE } from "./sources/korean";
import { SPANISH_SOURCE } from "./sources/spanish";
import { FRENCH_SOURCE } from "./sources/french";
import { PERSIAN_SOURCE } from "./sources/persian";
import { GENERAL_SOURCE } from "./sources/general";
import { ENGLISH_TARGET } from "./targets/english";
import { FARSI_TARGET } from "./targets/farsi";

/**
 * Maps franc source-language codes to source-prompt fragments.
 * Add a new entry when adding a dedicated source fragment.
 */
const SOURCE_FRAGMENTS: Record<string, string> = {
  jpn: JAPANESE_SOURCE,
  deu: GERMAN_SOURCE,
  kor: KOREAN_SOURCE,
  spa: SPANISH_SOURCE,
  fra: FRENCH_SOURCE,
  fas: PERSIAN_SOURCE,
  pes: PERSIAN_SOURCE, // alternative franc code for Persian
};

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
 * @param sourceFrancCode  franc source-language code (e.g. "jpn", "deu").
 *                         Falls back to GENERAL_SOURCE when absent or unknown.
 * @returns { system, user } ready for Gemini (or any LLM).
 */
export function composeTranslationPrompt(
  lyrics: string,
  target: SupportedLanguage,
  sourceFrancCode?: string,
): { system: string; user: string } {
  const sourceFragment = SOURCE_FRAGMENTS[sourceFrancCode ?? ""] ?? GENERAL_SOURCE;
  const targetFragment = TARGET_FRAGMENTS[target.code] ?? "";

  const system = [BASE_PROMPT, sourceFragment, targetFragment]
    .filter(Boolean)
    .join("\n\n");

  return { system, user: lyrics };
}
