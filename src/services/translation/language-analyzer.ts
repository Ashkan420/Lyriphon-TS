import { francAll } from "franc";
import { debug } from "../../utils/logger";
import { getFlag } from "./detect";
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

const SOURCE_HINTS: Record<string, string> = {
  ja: JAPANESE_HINT,
  de: GERMAN_HINT,
  ko: KOREAN_HINT,
  es: SPANISH_HINT,
  fr: FRENCH_HINT,
  fa: PERSIAN_HINT,
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

  const entries: DetectedLanguage[] = [];
  for (const [code, score] of francScores) {
    entries.push({ code, score: score * FRANC_WEIGHT });
  }

  if (script) {
    entries.push({ code: script.code, score: 1.0 });
  }

  return entries.sort((a, b) => b.score - a.score);
}

function hardFilter(languages: DetectedLanguage[]): DetectedLanguage[] {
  const MIN_SCORE = 0.05;
  const MAX_LANGS = 4;
  return languages
    .filter(d => d.score >= MIN_SCORE)
    .slice(0, MAX_LANGS);
}

function classify(languages: DetectedLanguage[]): LanguageAnalysis {
  const primary = languages[0];
  const secondary = languages[1];

  const total = languages.reduce((sum, d) => sum + d.score, 0);
  const primaryShare = total > 0 ? primary.score / total : 1;
  const secondaryShare = secondary && total > 0 ? secondary.score / total : 0;

  let mode: LanguageMode;
  if (primaryShare > 0.80) {
    mode = "single";
  } else if (secondaryShare > 0.15) {
    mode = "bilingual";
  } else {
    mode = "multilingual";
  }

  const all = languages.map(d => ({
    ...d,
    score: total > 0 ? d.score / total : 0,
  }));

  const meaningful = all.filter(d => d.score >= 0.10);

  return {
    mode,
    primary: all[0],
    secondary: secondaryShare > 0.10 ? all[1] : undefined,
    meaningful,
    all,
  };
}

export function analyzeLanguages(lyrics: string): LanguageAnalysis | undefined {
  const script = detectByScript(lyrics);
  debug("analyzeLanguages:script", { result: script });

  const francRaw = francAll(lyrics, { minLength: MIN_LENGTH });
  debug("analyzeLanguages:francRawTop5", francRaw.slice(0, 5));

  const francScores = normalizeFranc(francRaw);
  debug("analyzeLanguages:francNormalized", [...francScores.entries()].slice(0, 5));

  const merged = mergeResults(script, francScores);
  debug("analyzeLanguages:merged", merged);

  const filtered = hardFilter(merged);
  debug("analyzeLanguages:filtered", filtered);

  if (!filtered.length) return undefined;

  const result = classify(filtered);
  debug("analyzeLanguages:result", {
    mode: result.mode,
    primary: result.primary,
    secondary: result.secondary,
    all: result.all.slice(0, 4),
  });

  return result;
}

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
  if (!analysis) return [GENERAL_SOURCE];

  const primaryFragment = SOURCE_FRAGMENTS[analysis.primary.code] ?? GENERAL_SOURCE;

  if (!multilingualEnabled) return [primaryFragment];

  switch (analysis.mode) {
    case "single":
      return [primaryFragment];

    case "bilingual":
    case "multilingual": {
      const maxHints = analysis.mode === "bilingual" ? 1 : 2;
      const hints = analysis.meaningful
        .filter(d => d.code !== analysis.primary.code && d.score >= 0.10)
        .slice(0, maxHints)
        .map(d => SOURCE_HINTS[d.code] ?? GENERAL_HINT);
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
