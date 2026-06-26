import { Env } from "../../env";
import { geminiTranslate } from "./gemini";
import { getCachedFinglish, cacheFinglish } from "../../db/transliterations";
import { debug, warn } from "../../utils/logger";

// Persian/Arabic script range. Used as a cheap gate so non-Farsi (e.g. English)
// queries never touch the cache or Gemini.
const FARSI_REGEX = /[؀-ۿ]/;

export function containsFarsi(text: string): boolean {
  return FARSI_REGEX.test(text);
}

const SYSTEM_PROMPT = `You transliterate Persian/Farsi text into phonetic Latin letters ("Finglish").

STRICT RULES:
- Transliterate the SOUND, do NOT translate the meaning. Example: گل → gol (NOT "flower"), دیوار → divar, خیابان → khiaban.
- Insert the natural short vowels that Persian script omits (e.g. گل is "gol", not "gl").
- Output ONLY the transliteration. No quotes, no explanation, no notes, no original script.
- Keep words that are already in Latin letters unchanged.
- Preserve word order and spacing.`;

/**
 * Transliterate a Farsi string to Finglish. Returns null when the input is not
 * Farsi, Gemini is unconfigured/unavailable, or transliteration fails — callers
 * should fall back to the original query in that case.
 */
export async function transliterateFarsi(env: Env, text: string): Promise<string | null> {
  const trimmed = text?.trim();
  if (!trimmed || !containsFarsi(trimmed)) {
    return null;
  }

  if (!env.GEMINI_API_KEY) {
    debug("transliterateFarsi: GEMINI_API_KEY not configured, skipping");
    return null;
  }

  try {
    const cached = await getCachedFinglish(env.DB, trimmed);
    if (cached) {
      debug("transliterateFarsi: cache hit", { text: trimmed, finglish: cached });
      return cached;
    }
  } catch (error) {
    warn("transliterateFarsi: cache read failed", error);
  }

  const result = await geminiTranslate(env, SYSTEM_PROMPT, trimmed);
  if (result.type !== "success") {
    warn("transliterateFarsi: gemini did not succeed", { type: result.type });
    return null;
  }

  const finglish = result.text.trim();
  if (!finglish) {
    return null;
  }

  try {
    await cacheFinglish(env.DB, trimmed, finglish);
  } catch (error) {
    warn("transliterateFarsi: cache write failed", error);
  }

  debug("transliterateFarsi: success", { text: trimmed, finglish });
  return finglish;
}
