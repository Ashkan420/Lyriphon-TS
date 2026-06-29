import { francAll } from "franc";
import { debug } from "../../utils/logger";
import { FRANC_TO_LANG, getFlag } from "./detect";
import { GENERAL_SOURCE } from "./prompts/sources/general";
import { JAPANESE_SOURCE } from "./prompts/sources/japanese";
import { GERMAN_SOURCE } from "./prompts/sources/german";
import { KOREAN_SOURCE } from "./prompts/sources/korean";
import { SPANISH_SOURCE } from "./prompts/sources/spanish";
import { FRENCH_SOURCE } from "./prompts/sources/french";
import { PERSIAN_SOURCE } from "./prompts/sources/persian";
import { JAPANESE_HINT } from "./prompts/sources/japanese_hint";
import { GERMAN_HINT } from "./prompts/sources/german_hint";
import { KOREAN_HINT } from "./prompts/sources/korean_hint";
import { SPANISH_HINT } from "./prompts/sources/spanish_hint";
import { FRENCH_HINT } from "./prompts/sources/french_hint";
import { PERSIAN_HINT } from "./prompts/sources/persian_hint";
import { GENERAL_HINT } from "./prompts/sources/general_hint";

export interface DetectedLanguage {
  code: string;
  score: number;
}

export type LanguageMode = "single" | "bilingual" | "multilingual";

export interface LanguageAnalysis {
  mode: LanguageMode;
  primary: DetectedLanguage;
  secondary?: DetectedLanguage;
  meaningful: DetectedLanguage[];
  all: DetectedLanguage[];
}

const DOMINANCE_THRESHOLD = 0.35;
const MIN_SCORE = 0.10;
const MEANINGFUL_SCORE = 0.20;
const MIN_LENGTH = 50;
const SCRIPT_MIN_RATIO = 0.15;

const SCRIPT_PATTERNS: Array<{ regex: RegExp; code: string }> = [
  { regex: /[\u3040-\u309F\u30A0-\u30FF]/, code: "jpn" },
  { regex: /[\uAC00-\uD7AF]/, code: "kor" },
  { regex: /[\u0600-\u06FF]/, code: "fas" },
  { regex: /[\u0900-\u097F]/, code: "hin" },
  { regex: /[\u0400-\u04FF]/, code: "rus" },
];

const SOURCE_FRAGMENTS: Record<string, string> = {
  jpn: JAPANESE_SOURCE,
  deu: GERMAN_SOURCE,
  kor: KOREAN_SOURCE,
  spa: SPANISH_SOURCE,
  fra: FRENCH_SOURCE,
  fas: PERSIAN_SOURCE,
  pes: PERSIAN_SOURCE,
};

const SOURCE_HINTS: Record<string, string> = {
  jpn: JAPANESE_HINT,
  deu: GERMAN_HINT,
  kor: KOREAN_HINT,
  spa: SPANISH_HINT,
  fra: FRENCH_HINT,
  fas: PERSIAN_HINT,
  pes: PERSIAN_HINT,
};

const SUPPORTED_FRANC_CODES = new Set([
  ...Object.keys(SOURCE_FRAGMENTS),
  "eng",
]);

function detectByScript(lyrics: string): DetectedLanguage | null {
  const totalChars = lyrics.replace(/\s/g, "").length;
  if (totalChars === 0) return null;

  for (const { regex, code } of SCRIPT_PATTERNS) {
    const matches = lyrics.match(new RegExp(regex.source, "g"));
    if (matches) {
      const ratio = matches.length / totalChars;
      if (ratio > SCRIPT_MIN_RATIO) {
        return { code, score: Math.min(ratio * 2, 0.95) };
      }
    }
  }
  return null;
}

export function analyzeLanguages(lyrics: string): LanguageAnalysis | undefined {
  const scriptResult = detectByScript(lyrics);
  debug("analyzeLanguages:script", { result: scriptResult });

  const francResults = francAll(lyrics, { minLength: MIN_LENGTH });
  const supported = francResults
    .filter(([code, score]) => score >= MIN_SCORE && SUPPORTED_FRANC_CODES.has(code))
    .map(([code, score]) => ({ code, score }));

  debug("analyzeLanguages:franc_supported", {
    total: francResults.length,
    supportedCount: supported.length,
    supported: supported.slice(0, 10),
  });

  const all = scriptResult
    ? [scriptResult, ...supported.filter(r => r.code !== scriptResult.code)]
        .sort((a, b) => b.score - a.score)
    : supported;

  if (!all.length) {
    debug("analyzeLanguages:no_results");
    return undefined;
  }

  const primary = all[0];
  const meaningful = all.filter(d => d.score >= MEANINGFUL_SCORE);
  const secondary = meaningful.length >= 2 ? meaningful[1] : undefined;

  let mode: LanguageMode;
  if (meaningful.length >= 3) {
    mode = "multilingual";
  } else if (secondary && (primary.score - secondary.score) < DOMINANCE_THRESHOLD) {
    mode = "bilingual";
  } else {
    mode = "single";
  }

  debug("analyzeLanguages:result", {
    mode,
    primary,
    secondary,
    meaningfulCount: meaningful.length,
    allCount: all.length,
    all: all.slice(0, 5),
  });

  return { mode, primary, secondary, meaningful, all };
}

export function isSourceLanguage(
  analysis: LanguageAnalysis | undefined,
  targetLangCode: string,
): boolean {
  if (!analysis) return false;
  return (
    FRANC_TO_LANG[analysis.primary.code] === targetLangCode
    && analysis.primary.score >= 0.75
  );
}

export function getSourceFragments(analysis: LanguageAnalysis | undefined): string[] {
  if (!analysis) return [GENERAL_SOURCE];

  const primaryFragment = SOURCE_FRAGMENTS[analysis.primary.code] ?? GENERAL_SOURCE;

  switch (analysis.mode) {
    case "single":
      return [primaryFragment];

    case "bilingual": {
      const hintFragment = analysis.secondary
        ? (SOURCE_HINTS[analysis.secondary.code] ?? GENERAL_HINT)
        : GENERAL_HINT;
      return [primaryFragment, hintFragment];
    }

    case "multilingual": {
      const hints = analysis.meaningful
        .filter(d => d.code !== analysis.primary.code && d.score >= 0.25)
        .slice(0, 1)
        .map(d => SOURCE_HINTS[d.code] ?? GENERAL_HINT);
      return [GENERAL_SOURCE, ...hints];
    }
  }
}

export function getLanguageUiLabel(analysis: LanguageAnalysis | undefined): string {
  if (!analysis) return "Original";

  const flag = getFlag(analysis.primary.code) ?? "";

  switch (analysis.mode) {
    case "single":
      return flag ? `${flag} Original` : "Original";
    case "bilingual": {
      const sFlag = analysis.secondary ? getFlag(analysis.secondary.code) : "";
      return sFlag
        ? `${flag} Original (${analysis.primary.code.toUpperCase()} + ${analysis.secondary!.code.toUpperCase()})`
        : `${flag} Original · Mixed`;
    }
    case "multilingual":
      return flag ? `${flag} Original · Mixed` : "Original";
  }
}
