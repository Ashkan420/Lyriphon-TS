import { detectAll } from "tinyld";
import { debug } from "../../utils/logger";
import { getFlag } from "./detect";
import { JAPANESE_SOURCE } from "./prompts/sources/japanese";
import { GERMAN_SOURCE } from "./prompts/sources/german";
import { KOREAN_SOURCE } from "./prompts/sources/korean";
import { SPANISH_SOURCE } from "./prompts/sources/spanish";
import { FRENCH_SOURCE } from "./prompts/sources/french";
import { PERSIAN_SOURCE } from "./prompts/sources/persian";
import { ARABIC_SOURCE } from "./prompts/sources/arabic";
import { HINDI_SOURCE } from "./prompts/sources/hindi";
import { RUSSIAN_SOURCE } from "./prompts/sources/russian";
import { TURKISH_SOURCE } from "./prompts/sources/turkish";
import { ITALIAN_SOURCE } from "./prompts/sources/italian";
import { PORTUGUESE_SOURCE } from "./prompts/sources/portuguese";
import { CHINESE_SOURCE } from "./prompts/sources/chinese";
import { PUNJABI_SOURCE } from "./prompts/sources/punjabi";
import { TAMIL_SOURCE } from "./prompts/sources/tamil";
import { TELUGU_SOURCE } from "./prompts/sources/telugu";
import { BENGALI_SOURCE } from "./prompts/sources/bengali";
import { THAI_SOURCE } from "./prompts/sources/thai";
import { HEBREW_SOURCE } from "./prompts/sources/hebrew";
import { INDONESIAN_SOURCE } from "./prompts/sources/indonesian";
import { VIETNAMESE_SOURCE } from "./prompts/sources/vietnamese";
import { FILIPINO_SOURCE } from "./prompts/sources/filipino";
import { GREEK_SOURCE } from "./prompts/sources/greek";
import { POLISH_SOURCE } from "./prompts/sources/polish";
import { SWEDISH_SOURCE } from "./prompts/sources/swedish";
import { SERBIAN_SOURCE } from "./prompts/sources/serbian";
import { CROATIAN_SOURCE } from "./prompts/sources/croatian";
import { getHintFragment } from "./prompts/hints";

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

// tinyld emits canonical 2-letter codes for its supported set (de en fr es pt
// it tr ru zh ja ko ar fa he id vi tl el pl sv sr no th bn hi ta te …), so no
// ISO-639-3 mapping is needed. Only folds live here. Croatian is NOT in
// tinyld's language set — hr songs lean on the sibling Serbian prompt when
// script detection doesn't fire. Urdu folds into the Persian prompt: it shares
// most Persian Arabic-script markers and its poetic tradition is
// Persian-derived (same rationale as the PERSIAN_MARKERS_RE comment below).
// Afrikaans folds into the Dutch prompt (parity with the old franc map).
const TINYLD_FOLDS: Record<string, string> = {
  ur: "fa",
  af: "nl",
};

// Latin + Latin-Extended + Latin Extended Additional. Used to project the
// lyrics onto their Latin-script subset for a second detection pass.
const NON_LATIN_RE = /[^\u0020-\u024F\u1E00-\u1EFF]+/g;

// excludeIf: skip the pattern when this regex matches anywhere in the text.
// Used for Han characters, which are shared with Japanese — kana presence
// means the text is Japanese, so zh must never win over ja.
type ScriptPattern = { regex: RegExp; code: string; excludeIf?: RegExp };

const SCRIPT_PATTERNS: ScriptPattern[] = [
  { regex: /[\u3040-\u309F\u30A0-\u30FF]/, code: "ja" },
  { regex: /[\uAC00-\uD7AF]/, code: "ko" },
  { regex: /[\u0900-\u097F]/, code: "hi" },
  { regex: /[\u0400-\u04FF]/, code: "ru" },
  { regex: /[\u4E00-\u9FFF]/, code: "zh", excludeIf: /[\u3040-\u30FF]/ },
  { regex: /[\u0A00-\u0A7F]/, code: "pa" },  // Gurmukhi
  { regex: /[\u0B80-\u0BFF]/, code: "ta" },  // Tamil
  { regex: /[\u0C00-\u0C7F]/, code: "te" },  // Telugu
  { regex: /[\u0980-\u09FF]/, code: "bn" },  // Bengali (incl. Assamese)
  { regex: /[\u0E00-\u0E7F]/, code: "th" },  // Thai
  { regex: /[\u0590-\u05FF]/, code: "he" },  // Hebrew
];

// Persian, Arabic, and Urdu share the Arabic block (\u0600-\u06FF), so the
// block alone can't identify the language. Persian is recognized by its
// exclusive letters (پ چ ژ گ) and its distinct ye/kaf forms (ی U+06CC,
// ک U+06A9); Arabic-script text without those markers is treated as Arabic.
// (Urdu shares most Persian markers and is therefore treated as fa — its
// poetic tradition is Persian-derived, making PERSIAN_SOURCE the better fit.)
const ARABIC_BLOCK_RE = /[\u0600-\u06FF]/;
const PERSIAN_MARKERS_RE = /[\u067E\u0686\u0698\u06AF\u06CC\u06A9]/;

const SCRIPT_RATIO_THRESHOLD = 0.12;

// Projection thresholds (see mergeResults): PROJ_SIGNAL_MIN separates real
// subset detections from gram-noise; PROJ_FLOOR compensates tinyld's
// miscalibrated absolute accuracy on repetitive lyric text (a correct
// repetitive English chorus scores 0.15) so a confident identification still
// earns its subset's share.
const PROJ_SIGNAL_MIN = 0.10;
const PROJ_FLOOR = 0.45;

const SOURCE_FRAGMENTS: Record<string, string> = {
  ja: JAPANESE_SOURCE,
  de: GERMAN_SOURCE,
  ko: KOREAN_SOURCE,
  es: SPANISH_SOURCE,
  fr: FRENCH_SOURCE,
  fa: PERSIAN_SOURCE,
  ar: ARABIC_SOURCE,
  hi: HINDI_SOURCE,
  ru: RUSSIAN_SOURCE,
  tr: TURKISH_SOURCE,
  it: ITALIAN_SOURCE,
  pt: PORTUGUESE_SOURCE,
  zh: CHINESE_SOURCE,
  pa: PUNJABI_SOURCE,
  ta: TAMIL_SOURCE,
  te: TELUGU_SOURCE,
  bn: BENGALI_SOURCE,
  th: THAI_SOURCE,
  he: HEBREW_SOURCE,
  id: INDONESIAN_SOURCE,
  vi: VIETNAMESE_SOURCE,
  tl: FILIPINO_SOURCE,
  el: GREEK_SOURCE,
  pl: POLISH_SOURCE,
  sv: SWEDISH_SOURCE,
  sr: SERBIAN_SOURCE,
  hr: CROATIAN_SOURCE,
};

interface ScriptResult {
  code: string;
  ratio: number;
}

function detectByScript(lyrics: string): ScriptResult | null {
  const totalChars = lyrics.replace(/\s/g, "").length;
  if (totalChars === 0) return null;

  // Highest ratio wins, not first past the threshold: SCRIPT_PATTERNS order
  // is arbitrary, and first-match-wins pinned kana over a dominant Hangul
  // majority in mixed ja/ko songs, overriding the model's preference.
  let best: ScriptResult | null = null;
  for (const { regex, code, excludeIf } of SCRIPT_PATTERNS) {
    if (excludeIf && excludeIf.test(lyrics)) {
      continue;
    }
    const matches = lyrics.match(new RegExp(regex.source, "g"));
    if (matches) {
      const ratio = matches.length / totalChars;
      if (ratio >= SCRIPT_RATIO_THRESHOLD && (!best || ratio > best.ratio)) {
        best = { code, ratio };
      }
    }
  }
  if (best) return best;

  // Arabic block last: it never overlaps kana/Hangul/Devanagari/Cyrillic,
  // so checking it after the unambiguous scripts is safe.
  if (ARABIC_BLOCK_RE.test(lyrics)) {
    const matches = lyrics.match(new RegExp(ARABIC_BLOCK_RE.source, "g"));
    const ratio = matches ? matches.length / totalChars : 0;
    if (ratio >= SCRIPT_RATIO_THRESHOLD) {
      return { code: PERSIAN_MARKERS_RE.test(lyrics) ? "fa" : "ar", ratio };
    }
  }

  return null;
}

// Fold tinyld's raw detections into prompt-language codes. detectAll returns
// { lang, accuracy } with calibrated accuracies (confusable neighbors score
// near 0), so no dialect de-duplication is required — unlike franc, whose
// Germanic-family scores came back nearly tied (de 1.00 / nl 0.94) and
// poisoned the bilingual classifier with phantom secondaries.
function foldDetections(
  detections: Array<{ lang: string; accuracy: number }>,
  into: Map<string, number>,
): void {
  for (const det of detections) {
    const code = TINYLD_FOLDS[det.lang] ?? det.lang;
    into.set(code, Math.max(into.get(code) ?? 0, det.accuracy));
  }
}

function nonSpaceLength(text: string): number {
  return text.replace(/\s/g, "").length;
}

// A projection pass: detections over a subset of the lyrics, weighted by how
// much of the song that subset is. partitionFired records whether any
// non-trivial subset existed — two scripts coexisting is itself evidence of
// bilingualism (see mergeResults' mode floor).
interface Projection {
  scores: Map<string, number>;
  share: number;
  partitionFired: boolean;
}

// Per-script subsets for the projection passes, as line partitions. Lines are
// assigned to the FIRST matching script (a Latin-heavy mixed line belongs to
// its CJK lead-in); subsets smaller than PARTITION_MIN_SHARE are skipped.
// Latin uses a character-strip (not lines) so embedded English fragments
// inside CJK lines are also captured. The Arabic partition splits the Arabic
// block by Persian markers: lines WITHOUT Persian-exclusive letters (پ چ ژ گ
// ی ک) are re-detected so an Arabic remainder surfaces next to a Persian
// majority.
interface ScriptPartition {
  code: string;
  regex: RegExp;
  byLine: boolean;
}
const SCRIPT_PARTITIONS: ScriptPartition[] = [
  { code: "ko", regex: /[가-힯]/, byLine: true },
  { code: "ja", regex: /[぀-ヿ]/, byLine: true },
  { code: "zh", regex: /[一-鿿]/, byLine: true },
  { code: "ru", regex: /[Ѐ-ӿ]/, byLine: true },
  { code: "hi", regex: /[ऀ-ॿ]/, byLine: true },
  { code: "bn", regex: /[ঀ-৿]/, byLine: true },
  { code: "pa", regex: /[਀-੿]/, byLine: true },
  { code: "ta", regex: /[஀-௿]/, byLine: true },
  { code: "te", regex: /[ఀ-౿]/, byLine: true },
  { code: "th", regex: /[฀-๿]/, byLine: true },
  { code: "he", regex: /[֐-׿]/, byLine: true },
];
const PARTITION_MIN_SHARE = 0.05;

// tinyld's gram model is dominated by the script-pinned language: on a 50/50
// Japanese + English text it returns ja:1 and drops English entirely; a
// Korean-dominant song with a Japanese bridge returns ko:1 and drops ja.
// Projection passes recover what the full-text pass hides: for each script
// subset, re-detect the subset on its own and credit the detected language
// with the subset's share of the song. Script presence is structural evidence
// (a Hangul line is near-certain Korean), so the share is credited directly —
// no accuracy flooring, tinyld's absolute accuracy is miscalibrated on
// repetitive lyric text anyway (correct French ID scores 0.52). Projections
// are only consumed when a script pin exists (see mergeResults) — otherwise
// they'd re-detect the same text the full pass already covered.
function detectByModel(lyrics: string): { full: Map<string, number>; projections: Projection[] } {
  const full = new Map<string, number>();
  foldDetections(detectAll(lyrics), full);

  const projections: Projection[] = [];
  const totalChars = Math.max(1, nonSpaceLength(lyrics));
  const lines = lyrics.split("\n");

  // Latin: character strip, catching English fragments inside CJK lines too.
  const latinOnly = lyrics.replace(NON_LATIN_RE, " ");
  const latinShare = nonSpaceLength(latinOnly) / totalChars;
  if (latinShare < 1 && latinOnly.trim().length > 0) {
    const scores = new Map<string, number>();
    foldDetections(detectAll(latinOnly), scores);
    projections.push({ scores, share: latinShare, partitionFired: true });
  }

  // Arabic block: split by Persian markers (char-level within lines).
  if (PERSIAN_MARKERS_RE.test(lyrics)) {
    const arabicOnlyLines = lines
      .filter(line => ARABIC_BLOCK_RE.test(line) && !PERSIAN_MARKERS_RE.test(line));
    const arabicOnly = arabicOnlyLines.join("\n");
    const arabicShare = nonSpaceLength(arabicOnly) / totalChars;
    if (arabicShare > 0 && arabicShare < 1) {
      const scores = new Map<string, number>();
      foldDetections(detectAll(arabicOnly), scores);
      projections.push({ scores, share: arabicShare, partitionFired: true });
    }
  }

  // Remaining scripts: line partitions.
  const assigned = new Set<number>();
  for (const { code, regex, byLine } of SCRIPT_PARTITIONS) {
    if (!byLine) continue;
    const subsetLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (assigned.has(i)) continue;
      if (regex.test(lines[i])) {
        subsetLines.push(lines[i]);
        assigned.add(i);
      }
    }
    const subset = subsetLines.join("\n");
    const share = nonSpaceLength(subset) / totalChars;
    if (share < PARTITION_MIN_SHARE || share >= 1) continue;
    const scores = new Map<string, number>();
    foldDetections(detectAll(subset), scores);
    projections.push({ scores, share, partitionFired: true });
  }

  return { full, projections };
}

function mergeResults(
  script: ScriptResult | null,
  model: { full: Map<string, number>; projections: Projection[] },
): { ranked: DetectedLanguage[]; partitionFired: boolean } {
  const MODEL_WEIGHT = script ? 0.4 : 1.0;

  const byCode = new Map<string, number>();
  for (const [code, score] of model.full) {
    byCode.set(code, score * MODEL_WEIGHT);
  }

  // Projection passes: credit each projection's top-1 detection (excluding
  // the script-pinned language) with its subset's share of the song, floored
  // at PROJ_FLOOR for the reasons above. Skipped entirely without a script
  // pin — then the projections re-detected near-identical text and would
  // double-count the full pass.
  let partitionFired = false;
  if (script) {
    for (const projection of model.projections) {
      partitionFired ||= projection.partitionFired && projection.share >= PARTITION_MIN_SHARE;
      const top = [...projection.scores.entries()]
        .filter(([code]) => code !== script.code)
        .sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] >= PROJ_SIGNAL_MIN) {
        const score = Math.max(top[1], PROJ_FLOOR) * projection.share;
        byCode.set(top[0], Math.max(byCode.get(top[0]) ?? 0, score));
      }
    }
  }

  if (script) {
    const existing = byCode.get(script.code) ?? 0;
    byCode.set(script.code, Math.max(existing, 1.0));
  }

  const sorted = [...byCode.entries()]
    .map(([code, score]) => ({ code, score }))
    .sort((a, b) => b.score - a.score);

  // The script pin is structural evidence (kana ⇒ Japanese, Hangul ⇒ Korean
  // …); it must lead the ranking even when a model score ties at 1.0.
  if (script) {
    const idx = sorted.findIndex(d => d.code === script.code);
    if (idx > 0) {
      sorted.unshift(...sorted.splice(idx, 1));
    }
  }

  return { ranked: sorted, partitionFired };
}

function hardFilter(languages: DetectedLanguage[]): DetectedLanguage[] {
  const MIN_SCORE = 0.05;
  const MAX_LANGS = 4;
  return languages
    .filter(d => d.score >= MIN_SCORE)
    .slice(0, MAX_LANGS);
}

function classify(languages: DetectedLanguage[], partitionFired = false): LanguageAnalysis {
  const total = languages.reduce((sum, d) => sum + d.score, 0);
  const all = languages.map(d => ({
    ...d,
    score: total > 0 ? d.score / total : 0,
  }));

  const meaningful = all.filter(d => d.score >= 0.10);

  // Two scripts coexisting is structural bilingualism: a 20% bridge language
  // must not collapse the mode to "single" under the primaryShare threshold,
  // or the translator loses the bridge's hint fragment.
  const mode = partitionFired && all.length > 1
    ? (classifyModes(all) === "single" ? "bilingual" : classifyModes(all))
    : classifyModes(all);

  return {
    mode,
    primary: all[0],
    secondary: (all[1]?.score ?? 0) > 0.10 ? all[1] : undefined,
    meaningful,
    all,
  };
}

export function analyzeLanguages(lyrics: string): LanguageAnalysis | undefined {
  if (!lyrics?.trim()) return undefined;

  const script = detectByScript(lyrics);
  const modelScores = detectByModel(lyrics);

  const { ranked, partitionFired } = mergeResults(script, modelScores);
  const filtered = hardFilter(ranked);
  if (!filtered.length) return undefined;

  const result = classify(filtered, partitionFired);
  debug("analyzeLanguages", {
    chars: lyrics.length,
    script: script ? `${script.code}:${script.ratio.toFixed(2)}` : null,
    mode: result.mode,
    primary: `${result.primary.code}:${result.primary.score.toFixed(2)}`,
    secondary: result.secondary ? `${result.secondary.code}:${result.secondary.score.toFixed(2)}` : null,
    all: result.all.slice(0, 4).map(d => `${d.code}:${d.score.toFixed(2)}`),
  });

  return result;
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

// Script regexes for spotting untranslated source lines. Latin-script source
// languages can't be told apart from a Latin-script target this way — an
// accepted gap; the real-world echo failures are non-Latin sources (ja etc.).
const SOURCE_SCRIPT_RES: Record<string, RegExp> = {
  ja: /[\u3040-\u30FF\u4E00-\u9FFF]/, // kana or kanji
  zh: /[\u4E00-\u9FFF]/,
  ko: /[\uAC00-\uD7AF]/,
  ru: /[\u0400-\u04FF]/,
  ar: /[\u0600-\u06FF]/,
  fa: /[\u0600-\u06FF]/,
  he: /[\u0590-\u05FF]/,
  th: /[\u0E00-\u0E7F]/,
  hi: /[\u0900-\u097F]/,
  bn: /[\u0980-\u09FF]/,
  pa: /[\u0A00-\u0A7F]/,
  ta: /[\u0B80-\u0BFF]/,
  te: /[\u0C00-\u0C7F]/,
};

function normalizeForCompare(line: string): string {
  return line
    .replace(/[\u200B\u200C\uFEFF]/g, "") // zero-width / invisible chars
    .trim();
}

/**
 * No-op detection for translations: count lines that carry source-language
 * script but came back identical after normalization — the model echoed them
 * instead of translating. A real translation leaves ~0% of script lines
 * untouched; an echo is ~100%.
 */
export function countUntranslatedLines(
  originalLines: readonly string[],
  translatedLines: readonly string[],
  sourceCodes: readonly string[],
): { untranslated: number; scriptLines: number } {
  const regexes = sourceCodes
    .map(code => SOURCE_SCRIPT_RES[code])
    .filter((re): re is RegExp => Boolean(re));
  if (!regexes.length) {
    return { untranslated: 0, scriptLines: 0 };
  }

  let scriptLines = 0;
  let untranslated = 0;
  for (let i = 0; i < originalLines.length; i++) {
    const original = originalLines[i];
    if (!regexes.some(re => re.test(original))) continue;
    scriptLines++;
    const translated = translatedLines[i];
    if (translated !== undefined && normalizeForCompare(original) === normalizeForCompare(translated)) {
      untranslated++;
    }
  }
  return { untranslated, scriptLines };
}

/**
 * Whole-output echo detection: count non-blank lines that came back identical
 * after normalization, regardless of script. Catches echoed Latin-script
 * sources (German → English), which the script-based countUntranslatedLines
 * can't see. Callers gate this on the lyrics not being mainly in the target
 * language — a mostly-target-language song legitimately keeps most lines.
 */
export function countIdenticalLines(
  originalLines: readonly string[],
  translatedLines: readonly string[],
): { identical: number; nonBlank: number } {
  let identical = 0;
  let nonBlank = 0;
  for (let i = 0; i < originalLines.length; i++) {
    const original = normalizeForCompare(originalLines[i]);
    if (!original) continue;
    nonBlank++;
    const translated = normalizeForCompare(translatedLines[i] ?? "");
    if (original === translated) {
      identical++;
    }
  }
  return { identical, nonBlank };
}

// Re-rank an analysis for a specific translation target. The target language
// needs no translation, so drop it and rebuild the ranking from what remains:
// a 55% English / 45% Japanese song targeted at English becomes a single-
// language Japanese prompt instead of "English source + Japanese hint".
// `all` scores are already normalized shares (classify renormalized them), so
// the rebuild only renormalizes what's left. Returns undefined when nothing
// translatable remains (100% English lyrics targeted at English), and the
// analysis unchanged when the target isn't among the detected languages.
export function rebaseAnalysisForTarget(
  analysis: LanguageAnalysis | undefined,
  targetLangCode: string,
): LanguageAnalysis | undefined {
  if (!analysis) return undefined;

  const remaining = analysis.all.filter(d => d.code !== targetLangCode);
  if (remaining.length === analysis.all.length) return analysis;
  if (!remaining.length) return undefined;

  const total = remaining.reduce((sum, d) => sum + d.score, 0);
  const renormalized = remaining.map(d => ({ ...d, score: total > 0 ? d.score / total : 0 }));

  return {
    mode: classifyModes(renormalized),
    primary: renormalized[0],
    secondary: (renormalized[1]?.score ?? 0) > 0.10 ? renormalized[1] : undefined,
    meaningful: renormalized.filter(d => d.score >= 0.10),
    all: renormalized,
  };
}

// Mode thresholds shared by classify() and rebaseAnalysisForTarget().
function classifyModes(renormalized: DetectedLanguage[]): LanguageMode {
  const primary = renormalized[0];
  const secondary = renormalized[1];

  const total = renormalized.reduce((sum, d) => sum + d.score, 0);
  const primaryShare = total > 0 ? primary.score / total : 1;
  const secondaryShare = secondary && total > 0 ? secondary.score / total : 0;

  if (primaryShare > 0.80) return "single";
  if (secondaryShare > 0.15) return "bilingual";
  return "multilingual";
}
