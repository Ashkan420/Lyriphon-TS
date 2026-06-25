import { Env } from "../../env";
import { geminiTranslate } from "./gemini";
import { buildTranslationPrompt } from "./prompt";
import { findLanguage, LanguageCode } from "./types";

export async function translateLyrics(
  env: Env,
  lyrics: string,
  targetLangCode: LanguageCode,
): Promise<string | null> {
  if (!lyrics?.trim()) {
    return null;
  }

  if (!env.GEMINI_API_KEY) {
    console.warn("translateLyrics: GEMINI_API_KEY not configured");
    return null;
  }

  const language = findLanguage(targetLangCode);
  if (!language) {
    console.warn("translateLyrics: unsupported language", targetLangCode);
    return null;
  }

  // ═══ CACHE READ (future — KV/D1) ═══
  // const cacheKey = `${hashLyrics(lyrics)}:${targetLangCode}`;
  // const cached = await env.TRANSLATION_CACHE.get(cacheKey);
  // if (cached) return cached;

  const prompt = buildTranslationPrompt(lyrics, language);

  const provider = env.TRANSLATION_PROVIDER ?? "gemini";

  let result: string | null = null;
  if (provider === "gemini") {
    result = await geminiTranslate(env, prompt.system, prompt.user);
  } else {
    console.warn("translateLyrics: unknown provider", provider);
    return null;
  }

  if (!result || result.trim().length === 0) {
    console.warn("translateLyrics: empty result from provider", {
      provider,
      lang: targetLangCode,
    });
    return null;
  }

  // ═══ CACHE WRITE (future — KV/D1) ═══
  // if (result) {
  //   const cacheKey = `${hashLyrics(lyrics)}:${targetLangCode}`;
  //   await env.TRANSLATION_CACHE.put(cacheKey, result, { expirationTtl: 86400 });
  // }

  return result;
}
