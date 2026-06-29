import { Env } from "../../env";
import { geminiTranslate, GeminiResult } from "./gemini";
import { composeTranslationPrompt } from "./prompts";
import { findLanguage, LanguageCode } from "./types";
import { warn } from "../../utils/logger";
import { LanguageAnalysis } from "./language-analyzer";

export type { GeminiResult };

export async function translateLyrics(
  env: Env,
  lyrics: string,
  targetLangCode: LanguageCode,
  langAnalysis?: LanguageAnalysis,
  multilingualEnabled = true,
): Promise<GeminiResult> {
  if (!lyrics?.trim()) {
    return { type: "error" };
  }

  if (!env.GEMINI_API_KEY) {
    warn("translateLyrics: GEMINI_API_KEY not configured");
    return { type: "error" };
  }

  const language = findLanguage(targetLangCode);
  if (!language) {
    warn("translateLyrics: unsupported language", targetLangCode);
    return { type: "error" };
  }

  const prompt = composeTranslationPrompt(lyrics, language, langAnalysis, multilingualEnabled);

  const provider = env.TRANSLATION_PROVIDER ?? "gemini";

  if (provider === "gemini") {
    return await geminiTranslate(env, prompt.system, prompt.user, prompt.modules);
  }

  warn("translateLyrics: unknown provider", provider);
  return { type: "error" };
}
