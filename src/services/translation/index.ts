import { Env } from "../../env";
import { geminiTranslate, GeminiResult } from "./gemini";
import { buildTranslationPrompt } from "./prompt";
import { findLanguage, LanguageCode } from "./types";

export type { GeminiResult };

export async function translateLyrics(
  env: Env,
  lyrics: string,
  targetLangCode: LanguageCode,
): Promise<GeminiResult> {
  if (!lyrics?.trim()) {
    return { type: "error" };
  }

  if (!env.GEMINI_API_KEY) {
    console.warn("translateLyrics: GEMINI_API_KEY not configured");
    return { type: "error" };
  }

  const language = findLanguage(targetLangCode);
  if (!language) {
    console.warn("translateLyrics: unsupported language", targetLangCode);
    return { type: "error" };
  }

  const prompt = buildTranslationPrompt(lyrics, language);

  const provider = env.TRANSLATION_PROVIDER ?? "gemini";

  if (provider === "gemini") {
    return await geminiTranslate(env, prompt.system, prompt.user);
  }

  console.warn("translateLyrics: unknown provider", provider);
  return { type: "error" };
}
