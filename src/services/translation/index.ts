import { Env } from "../../env";
import { geminiTranslate, GeminiResult } from "./gemini";
import { composeTranslationPrompt, composeRefinerPrompt } from "./prompts";
import { findLanguage, LanguageCode } from "./types";
import { warn, debug } from "../../utils/logger";
import { LanguageAnalysis } from "./language-analyzer";
import { SCORER_SYSTEM, buildScorerUserPrompt } from "./prompts/scorer";

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

export async function refineTranslation(
  env: Env,
  originalLyrics: string,
  currentTranslation: string,
  langCode: LanguageCode,
  langAnalysis?: LanguageAnalysis,
  multilingualEnabled = true,
): Promise<GeminiResult> {
  if (!originalLyrics?.trim() || !currentTranslation?.trim()) {
    return { type: "error" };
  }

  if (!env.GEMINI_API_KEY) {
    warn("refineTranslation: GEMINI_API_KEY not configured");
    return { type: "error" };
  }

  const language = findLanguage(langCode);
  if (!language) {
    warn("refineTranslation: unsupported language", langCode);
    return { type: "error" };
  }

  const prompt = composeRefinerPrompt(originalLyrics, currentTranslation, language, langAnalysis, multilingualEnabled);

  debug("refineTranslation:start", {
    langCode,
    originalLen: originalLyrics.length,
    translationLen: currentTranslation.length,
    systemLen: prompt.system.length,
    userLen: prompt.user.length,
  });

  const result = await geminiTranslate(env, prompt.system, prompt.user);

  if (result.type === "success") {
    debug("refineTranslation:success", {
      outputLen: result.text.length,
      originalLines: originalLyrics.split("\n").length,
      refinedLines: result.text.split("\n").length,
    });
  } else {
    debug("refineTranslation:failed", { type: result.type });
  }

  return result;
}

export async function scoreTranslation(
  env: Env,
  originalLyrics: string,
  translation: string,
): Promise<{ score: number; issues: string[] }> {
  if (!originalLyrics?.trim() || !translation?.trim()) {
    debug("scoreTranslation:empty", { originalLen: originalLyrics?.length, translationLen: translation?.length });
    return { score: 50, issues: ["empty input"] };
  }

  if (!env.GEMINI_API_KEY) {
    warn("scoreTranslation: GEMINI_API_KEY not configured");
    return { score: 50, issues: ["api key missing"] };
  }

  const userPrompt = buildScorerUserPrompt(originalLyrics, translation);
  debug("scoreTranslation:start", { originalLen: originalLyrics.length, translationLen: translation.length });

  const result = await geminiTranslate(env, SCORER_SYSTEM, userPrompt);

  if (result.type !== "success") {
    warn("scoreTranslation: gemini failed", { type: result.type });
    return { score: 50, issues: ["scoring API failed"] };
  }

  try {
    const parsed = JSON.parse(result.text);
    const score = Math.max(0, Math.min(100, Math.round(parsed.score ?? 50)));
    debug("scoreTranslation:parsed", { score, issues: parsed.issues });
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    debug("scoreTranslation:done", { score, issuesCount: issues.length });
    return { score, issues };
  } catch (e) {
    warn("scoreTranslation: JSON parse failed", { text: result.text?.slice(0, 200) });
    return { score: 50, issues: ["parse error"] };
  }
}
