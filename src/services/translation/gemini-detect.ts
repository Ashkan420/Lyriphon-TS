import { Env } from "../../env";
import { debug, warn } from "../../utils/logger";
import { geminiTranslate } from "./gemini";
import { VALID_DETECTION_CODES } from "./language-codes";
import { classifyScores, DetectedLanguage, LanguageAnalysis } from "./language-analyzer";

const DETECTION_SYSTEM_PROMPT = `You are a language detection expert. Analyze the provided lyrics and identify ALL languages present.

RULES:
1. Return ONLY valid JSON — no markdown, no code fences, no explanation text
2. Identify languages based on lexical evidence (vocabulary, grammar, script patterns)
3. If uncertain about a language, do not include it
4. Percentages must sum to 100 (±10% tolerance is acceptable)
5. If the text is entirely one language, return just that language at 100%
6. Use ONLY the ISO 639-1 codes listed below — never invent codes

VALID LANGUAGE CODES (use ONLY these):
en (English), fa (Persian), ja (Japanese), ko (Korean),
es (Spanish), fr (French), de (German), pt (Portuguese),
ar (Arabic), tr (Turkish), hi (Hindi), it (Italian),
ru (Russian), zh (Chinese), nl (Dutch), da (Danish),
sv (Swedish), no (Norwegian), pl (Polish), uk (Ukrainian),
th (Thai), vi (Vietnamese), id (Indonesian), ms (Malay),
bn (Bengali), ta (Tamil), te (Telugu), ro (Romanian),
cs (Czech), sk (Slovak), hu (Hungarian), fi (Finnish),
el (Greek), he (Hebrew), bg (Bulgarian), hr (Croatian),
sr (Serbian), sl (Slovenian), lt (Lithuanian), lv (Latvian),
et (Estonian), ca (Catalan), af (Afrikaans), sq (Albanian),
hy (Armenian), ka (Georgian), km (Khmer), ur (Urdu),
ku (Kurdish), cy (Welsh), ga (Irish), is (Icelandic)

RESPONSE FORMAT (JSON only, no other text):
{
  "languages": [
    { "code": "xx", "percentage": NN }
  ]
}`;

// Micro-cache for repeated lyrics (bounded, ephemeral — Workers isolate lifetime only)
const cache = new Map<string, LanguageAnalysis>();
const CACHE_MAX = 200;

function hashLyrics(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return String(h);
}

export type GeminiDetectResult =
  | { type: "success"; analysis: LanguageAnalysis }
  | { type: "rate_limited"; retryAfterSeconds: number }
  | { type: "error" };

export async function geminiDetectLanguages(
  env: Env,
  lyrics: string,
): Promise<GeminiDetectResult> {
  if (!env.GEMINI_API_KEY) return { type: "error" };

  // Cache check (micro-optimization, not a reliability feature)
  const key = hashLyrics(lyrics);
  const cached = cache.get(key);
  if (cached) {
    debug("geminiDetectLanguages:cache_hit");
    return { type: "success", analysis: cached };
  }

  const result = await geminiTranslate(env, DETECTION_SYSTEM_PROMPT, lyrics);

  if (result.type === "rate_limited") {
    return { type: "rate_limited", retryAfterSeconds: result.retryAfterSeconds };
  }
  if (result.type === "error") return { type: "error" };

  // Parse JSON
  let parsed: unknown;
  try {
    const cleaned = result.text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return { type: "error" };
  }

  const languages = (parsed as any)?.languages;
  if (!Array.isArray(languages) || languages.length === 0) {
    return { type: "error" };
  }

  // Validate entries against VALID_DETECTION_CODES
  const validEntries: DetectedLanguage[] = [];
  for (const entry of languages) {
    if (
      typeof entry.code === "string" &&
      VALID_DETECTION_CODES.has(entry.code) &&
      typeof entry.percentage === "number" &&
      entry.percentage >= 0 &&
      entry.percentage <= 100
    ) {
      validEntries.push({ code: entry.code, score: entry.percentage });
    }
  }

  if (validEntries.length === 0) return { type: "error" };

  // Validate sum ≈ 100 (±10%)
  const totalPct = validEntries.reduce((sum, e) => sum + e.score, 0);
  if (totalPct < 90 || totalPct > 110) {
    warn("geminiDetectLanguages:invalid_percentage_sum", { totalPct });
    return { type: "error" };
  }

  // Classification via shared function — no duplicated logic
  const analysis = classifyScores(validEntries, "gemini");

  // Cache
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, analysis);

  debug("geminiDetectLanguages:success", {
    mode: analysis.mode,
    primary: analysis.primary,
  });

  return { type: "success", analysis };
}
