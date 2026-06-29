import { francAll } from "franc";
import { warn } from "../../utils/logger";
import { FRANC_TO_LANG, FLAG_MAP, getFlag } from "./detect";
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

export function analyzeLanguages(lyrics: string): LanguageAnalysis | undefined {
  const results = francAll(lyrics, { minLength: MIN_LENGTH });
  const all = results
    .filter(([, score]) => score >= MIN_SCORE)
    .map(([code, score]) => ({ code, score }))
    .sort((a, b) => b.score - a.score);

  if (!all.length) return undefined;

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

  for (const d of all) {
    if (!FRANC_TO_LANG[d.code] && !FLAG_MAP[d.code]) {
      warn("Unknown franc code detected", { code: d.code, score: d.score });
    }
  }

  return { mode, primary, secondary, meaningful, all };
}

export function isSourceLanguage(
  analysis: LanguageAnalysis | undefined,
  targetLangCode: string,
): boolean {
  if (!analysis) return false;
  return analysis.all.some(d => FRANC_TO_LANG[d.code] === targetLangCode);
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
