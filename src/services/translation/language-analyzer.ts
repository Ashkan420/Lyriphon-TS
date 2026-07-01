import { francAll } from "franc";
import { debug, warn } from "../../utils/logger";
import { getFlag } from "./detect";
import { JAPANESE_SOURCE } from "./prompts/sources/japanese";
import { GERMAN_SOURCE } from "./prompts/sources/german";
import { KOREAN_SOURCE } from "./prompts/sources/korean";
import { SPANISH_SOURCE } from "./prompts/sources/spanish";
import { FRENCH_SOURCE } from "./prompts/sources/french";
import { PERSIAN_SOURCE } from "./prompts/sources/persian";
import { getHintFragment } from "./prompts/hints";
import { Env } from "../../env";

export interface DetectedLanguage {
  code: string;
  score: number;
}

export type LanguageMode = "single" | "bilingual" | "multilingual";
export type DetectionMethod = "franc" | "gemini";

export interface LanguageAnalysis {
  mode: LanguageMode;
  primary: DetectedLanguage;
  secondary?: DetectedLanguage;
  meaningful: DetectedLanguage[];
  all: DetectedLanguage[];
  meta: {
    method: DetectionMethod;
    mode: "single" | "hybrid";
    fallback?: true;
  };
}

// --- Shared classification thresholds (method-aware) ---

export const CLASSIFICATION_THRESHOLDS = {
  franc: {
    singlePrimaryShare: 0.80,
    bilingualSecondaryShare: 0.15,
    meaningfulMinScore: 0.10,
    secondaryMinScore: 0.10,
  },
  gemini: {
    singlePrimaryShare: 0.80,
    bilingualSecondaryShare: 0.15,
    meaningfulMinScore: 0.10,
    secondaryMinScore: 0.10,
  },
} as const;

// --- Single classification function (ONE place, ONE logic) ---

export function classifyScores(
  rawScores: DetectedLanguage[],
  method: DetectionMethod,
): LanguageAnalysis {
  const t = CLASSIFICATION_THRESHOLDS[method];

  const total = rawScores.reduce((sum, d) => sum + d.score, 0);
  const all: DetectedLanguage[] = rawScores
    .map(d => ({ ...d, score: total > 0 ? d.score / total : 0 }))
    .sort((a, b) => b.score - a.score);

  const primary = all[0];
  const secondary = all[1];
  const primaryShare = total > 0 ? primary.score / total : 1;
  const secondaryShare = secondary && total > 0 ? secondary.score / total : 0;

  let mode: LanguageMode;
  if (primaryShare > t.singlePrimaryShare) {
    mode = "single";
  } else if (secondaryShare > t.bilingualSecondaryShare) {
    mode = "bilingual";
  } else {
    mode = "multilingual";
  }

  const meaningful = all.filter(d => d.score >= t.meaningfulMinScore);

  return {
    mode,
    primary: all[0],
    secondary: secondaryShare > t.secondaryMinScore ? all[1] : undefined,
    meaningful,
    all,
    meta: { method, mode: "single" },
  };
}

// --- Franc detection pipeline ---

const FRANC_TO_CANONICAL: Record<string, string> = {
  deu: "de", nds: "de", gsw: "de", bar: "de",
  nld: "nl", afr: "nl",
  dan: "da", swe: "sv", nob: "no", nno: "no",
  eng: "en", jpn: "ja", kor: "ko", spa: "es",
  fra: "fr", fas: "fa", pes: "fa",
  por: "pt", ara: "ar", tur: "tr", hin: "hi",
  ita: "it", rus: "ru", zho: "zh",
};

const SCRIPT_PATTERNS: Array<{ regex: RegExp; code: string }> = [
  { regex: /[\u3040-\u309F\u30A0-\u30FF]/, code: "ja" },
  { regex: /[\uAC00-\uD7AF]/, code: "ko" },
  { regex: /[\u0600-\u06FF]/, code: "fa" },
  { regex: /[\u0900-\u097F]/, code: "hi" },
  { regex: /[\u0400-\u04FF]/, code: "ru" },
];

const DIALECT_CAP = 1.2;
const MIN_LENGTH = 50;
const SCRIPT_RATIO_THRESHOLD = 0.12;

const SOURCE_FRAGMENTS: Record<string, string> = {
  ja: JAPANESE_SOURCE,
  de: GERMAN_SOURCE,
  ko: KOREAN_SOURCE,
  es: SPANISH_SOURCE,
  fr: FRENCH_SOURCE,
  fa: PERSIAN_SOURCE,
};

interface ScriptResult {
  code: string;
  ratio: number;
}

function detectByScript(lyrics: string): ScriptResult | null {
  const totalChars = lyrics.replace(/\s/g, "").length;
  if (totalChars === 0) return null;

  for (const { regex, code } of SCRIPT_PATTERNS) {
    const matches = lyrics.match(new RegExp(regex.source, "g"));
    if (matches) {
      const ratio = matches.length / totalChars;
      if (ratio >= SCRIPT_RATIO_THRESHOLD) {
        return { code, ratio };
      }
    }
  }
  return null;
}

function normalizeFranc(results: readonly (string | number)[][]): Map<string, number> {
  const raw = new Map<string, number>();
  for (const [code, score] of results) {
    const canonical = FRANC_TO_CANONICAL[code as string];
    if (!canonical) continue;
    raw.set(canonical, Math.max(raw.get(canonical) ?? 0, score as number));
  }

  const capped = new Map<string, number>();
  for (const [code, score] of raw) {
    capped.set(code, Math.min(score, DIALECT_CAP));
  }
  return capped;
}

function mergeResults(
  script: ScriptResult | null,
  francScores: Map<string, number>,
): DetectedLanguage[] {
  const FRANC_WEIGHT = script ? 0.4 : 1.0;

  const byCode = new Map<string, number>();
  for (const [code, score] of francScores) {
    byCode.set(code, score * FRANC_WEIGHT);
  }

  if (script) {
    const existing = byCode.get(script.code) ?? 0;
    byCode.set(script.code, Math.max(existing, 1.0));
  }

  return [...byCode.entries()]
    .map(([code, score]) => ({ code, score }))
    .sort((a, b) => b.score - a.score);
}

function hardFilter(languages: DetectedLanguage[]): DetectedLanguage[] {
  const MIN_SCORE = 0.05;
  const MAX_LANGS = 4;
  return languages
    .filter(d => d.score >= MIN_SCORE)
    .slice(0, MAX_LANGS);
}

function francDetect(lyrics: string): DetectedLanguage[] | undefined {
  const script = detectByScript(lyrics);
  debug("francDetect:script", { result: script });

  const francRaw = francAll(lyrics, { minLength: MIN_LENGTH });
  debug("francDetect:francRawTop5", francRaw.slice(0, 5));

  const francScores = normalizeFranc(francRaw);
  debug("francDetect:francNormalized", [...francScores.entries()].slice(0, 5));

  const merged = mergeResults(script, francScores);
  debug("francDetect:merged", merged);

  const filtered = hardFilter(merged);
  debug("francDetect:filtered", filtered);

  if (!filtered.length) return undefined;
  return filtered;
}

export function analyzeLanguagesFranc(lyrics: string): LanguageAnalysis | undefined {
  if (!lyrics?.trim()) return undefined;

  const raw = francDetect(lyrics);
  if (!raw) return undefined;

  const result = classifyScores(raw, "franc");
  debug("analyzeLanguagesFranc:result", {
    mode: result.mode,
    primary: result.primary,
    secondary: result.secondary,
    all: result.all.slice(0, 4),
  });

  return result;
}

// --- Async dispatcher ---

type DetectionMode = "franc" | "ai" | "hybrid";

export async function analyzeLanguages(
  lyrics: string,
  mode?: DetectionMode,
  env?: Env,
): Promise<LanguageAnalysis | undefined> {
  if (!lyrics?.trim()) return undefined;

  const effectiveMode = mode ?? "franc";

  // AI mode: always Gemini
  if (effectiveMode === "ai" && env) {
    debug("analyzeLanguages:mode_ai");
    const { geminiDetectLanguages } = await import("./gemini-detect");
    const result = await geminiDetectLanguages(env, lyrics);
    if (result.type === "success") {
      return result.analysis;
    }
    warn("analyzeLanguages:ai_failed_falling_back_to_franc", { type: result.type });
    const francResult = analyzeLanguagesFranc(lyrics);
    if (francResult) francResult.meta.fallback = true;
    return francResult;
  }

  // Hybrid mode: franc first, Gemini refines if uncertain
  if (effectiveMode === "hybrid" && env) {
    debug("analyzeLanguages:mode_hybrid");
    const raw = francDetect(lyrics);
    if (!raw) return undefined;

    const francAnalysis = classifyScores(raw, "franc");
    francAnalysis.meta.mode = "hybrid";

    // High confidence: single language with no meaningful secondary → skip Gemini
    if (
      francAnalysis.mode === "single" &&
      francAnalysis.meaningful.length === 1
    ) {
      debug("analyzeLanguages:hybrid_franc_confident_skip_ai", {
        primary: francAnalysis.primary,
      });
      return francAnalysis;
    }

    // Low confidence or multilingual → try Gemini
    debug("analyzeLanguages:hybrid_franc_uncertain_try_ai", {
      francMode: francAnalysis.mode,
      meaningfulCount: francAnalysis.meaningful.length,
    });
    const { geminiDetectLanguages } = await import("./gemini-detect");
    const aiResult = await geminiDetectLanguages(env, lyrics);
    if (aiResult.type === "success") {
      aiResult.analysis.meta.mode = "hybrid";
      return aiResult.analysis;
    }
    warn("analyzeLanguages:hybrid_ai_failed_using_franc", { type: aiResult.type });
    francAnalysis.meta.fallback = true;
    return francAnalysis;
  }

  // Franc mode (default)
  debug("analyzeLanguages:mode_franc");
  return analyzeLanguagesFranc(lyrics);
}

// --- Prompt module selection helpers (unchanged) ---

export function isSourceLanguage(
  analysis: LanguageAnalysis | undefined,
  targetLangCode: string,
): boolean {
  if (!analysis) return false;
  return (
    analysis.primary.code === targetLangCode
    && analysis.primary.score > 0.85
  );
}

export function getSourceFragments(analysis: LanguageAnalysis | undefined, multilingualEnabled = true): string[] {
  if (!analysis) return [];

  const primaryFragment = SOURCE_FRAGMENTS[analysis.primary.code];

  if (!primaryFragment || !multilingualEnabled) {
    return primaryFragment ? [primaryFragment] : [];
  }

  switch (analysis.mode) {
    case "single":
      return [primaryFragment];

    case "bilingual":
    case "multilingual": {
      const maxHints = analysis.mode === "bilingual" ? 1 : 2;
      const hints = analysis.meaningful
        .filter(d => d.code !== analysis.primary.code && d.score >= 0.10)
        .slice(0, maxHints)
        .map(d => getHintFragment(d.code))
        .filter(Boolean);
      return [primaryFragment, ...hints];
    }
  }
}

export function getSourceFragmentNames(analysis: LanguageAnalysis | undefined, multilingualEnabled = true): { source: string; secondary: string[] } {
  if (!analysis) return { source: "general", secondary: ["none"] };

  const primaryName = analysis.primary.code;

  if (!multilingualEnabled) return { source: primaryName, secondary: ["none"] };

  switch (analysis.mode) {
    case "single":
      return { source: primaryName, secondary: ["none"] };

    case "bilingual":
    case "multilingual": {
      const maxHints = analysis.mode === "bilingual" ? 1 : 2;
      const hintNames = analysis.meaningful
        .filter(d => d.code !== analysis.primary.code && d.score >= 0.10)
        .slice(0, maxHints)
        .map(d => `${d.code}_hint`);
      return { source: primaryName, secondary: hintNames.length ? hintNames : ["none"] };
    }
  }
}

export function getLanguageUiLabel(analysis: LanguageAnalysis | undefined): string {
  if (!analysis) return "Original";
  const flag = getFlag(analysis.primary.code) ?? "";
  return flag ? `${flag} Original` : "Original";
}
