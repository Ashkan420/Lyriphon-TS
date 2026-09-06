import { Env } from "../../env";
import { geminiTranslate, GeminiResult } from "./gemini";
import { composeTranslationPrompt } from "./prompts";
import { findLanguage, LanguageCode } from "./types";
import { log, previewText, warn } from "../../utils/logger";
import { normalizeLyrics } from "../../utils/lyrics";
import { LanguageAnalysis, rebaseAnalysisForTarget, countUntranslatedLines, countIdenticalLines } from "./language-analyzer";
import { parseTranslationJson } from "./combine";

export type { GeminiResult };

export type TranslationResult = {
  type: "success";
  rawJson: string;
  lines: string[];
} | {
  type: "rate_limited";
  retryAfterSeconds: number;
} | {
  type: "error";
  reason?: "no_op";
}

const RETRY_HINT = `\n\n⚠️ CRITICAL RETRY INSTRUCTION — YOU FAILED THIS BEFORE:
Your previous attempt had the WRONG number of lines in the output array.
The input has exactly N lines. Your JSON array MUST have exactly N elements.
Count your output carefully before responding. If unsure, re-count.
Line count mismatch is the ONLY reason this retry was triggered.`;

function buildNoOpRetryHint(langAnalysis: LanguageAnalysis | undefined, targetLangCode: LanguageCode): string {
  const rebased = rebaseAnalysisForTarget(langAnalysis, targetLangCode);
  const targetName = findLanguage(targetLangCode)?.name ?? targetLangCode.toUpperCase();
  const sourceName = rebased?.primary.code.toUpperCase() ?? "SOURCE";
  return `\n\n⚠️ CRITICAL RETRY INSTRUCTION — YOU FAILED THIS BEFORE:
Your previous response repeated the original lyrics WITHOUT translating them.
You MUST translate ALL ${sourceName} text into ${targetName}. Never return the original
text unchanged and never transliterate it (e.g. romaji) — output only natural
${targetName}. Lines already entirely in ${targetName} stay unchanged.`;
}

export async function translateLyrics(
  env: Env,
  lyrics: string,
  targetLangCode: LanguageCode,
  langAnalysis?: LanguageAnalysis,
  multilingualEnabled = true,
  retryHint = false,
  noOpRetry = false,
): Promise<TranslationResult> {
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

  // Normalize defensively so the prompt text and the counted line count are
  // always the same string (cache rows predate edge-newline healing).
  const normalizedLyrics = normalizeLyrics(lyrics);

  const lineCount = normalizedLyrics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
  log(
    "translateLyrics:start",
    JSON.stringify({
      target: targetLangCode,
      lineCount,
      retryHint,
      multilingualEnabled,
      primary: langAnalysis?.primary ?? null,
      mode: langAnalysis?.mode ?? null,
    }),
    "preview:",
    previewText(normalizedLyrics),
  );
  // Full text for owner diffing (chunked /logs delivery).
  log("translateLyrics:lyrics", normalizedLyrics);

  const prompt = composeTranslationPrompt(normalizedLyrics, language, langAnalysis, multilingualEnabled);

  if (retryHint) {
    prompt.system += RETRY_HINT.replace(/N/g, String(lineCount));
  }
  if (noOpRetry) {
    prompt.system += buildNoOpRetryHint(langAnalysis, targetLangCode);
  }

  const provider = env.TRANSLATION_PROVIDER ?? "gemini";

  if (provider === "gemini") {
    const geminiResult = await geminiTranslate(env, prompt.system, prompt.user, prompt.modules);

    if (geminiResult.type !== "success") {
      log("translateLyrics: gemini result", geminiResult.type);
      return geminiResult;
    }

    const originalLineCount = lineCount;
    const parsedLines = parseTranslationJson(geminiResult.text, originalLineCount);

    if (!parsedLines) {
      // Full model output for owner diffing — the snippet isn't enough to see
      // which lines the model dropped or merged.
      warn("translateLyrics: failed to parse JSON translation", {
        lineCount: originalLineCount,
      });
      warn("translateLyrics: full model output (parse failure)", geminiResult.text);
      return { type: "error" };
    }

    // No-op guard: a model can echo the lyrics back unchanged (line count
    // then trivially matches, so parseTranslationJson accepts it — observed
    // in production on code-switched songs). Two complementary checks:
    // 1. Script-based: lines carrying source-language script that came back
    //    identical — works for non-Latin sources at any target share.
    // 2. Whole-output echo: nearly every non-blank line identical — catches
    //    echoed Latin-script sources (German → English). Gated on the song
    //    NOT being mainly in the target language: a mostly-target-language
    //    song legitimately keeps most lines unchanged.
    // Pure-target-language songs (rebase → undefined) skip both — an
    // all-English song legitimately echoes itself.
    const rebased = rebaseAnalysisForTarget(langAnalysis, targetLangCode);
    if (rebased) {
      const originalLines = normalizedLyrics.split("\n");
      const translatedLines = parsedLines.split("\n");

      const sourceCodes = [...new Set([rebased.primary.code, ...rebased.meaningful.map(d => d.code)])];
      const { untranslated, scriptLines } = countUntranslatedLines(originalLines, translatedLines, sourceCodes);
      const scriptEcho = scriptLines > 0 && untranslated / scriptLines > 0.5;

      // langAnalysis.all scores are normalized shares; absent target = 0.
      const targetShare = langAnalysis?.all.find(d => d.code === targetLangCode)?.score ?? 0;
      const { identical, nonBlank } = countIdenticalLines(originalLines, translatedLines);
      const wholeEcho = targetShare < 0.5 && nonBlank > 0 && identical / nonBlank >= 0.95;

      if (scriptEcho || wholeEcho) {
        warn("translateLyrics: no-op translation detected (output echoes the original)", {
          untranslated,
          scriptLines,
          identical,
          nonBlank,
          via: scriptEcho ? "script" : "whole_output",
        });
        return { type: "error", reason: "no_op" };
      }
    }

    log(
      "translateLyrics:success",
      JSON.stringify({ target: targetLangCode, lineCount: originalLineCount }),
      "preview:",
      previewText(parsedLines),
    );
    // Full translation for owner diffing.
    log("translateLyrics:translation", parsedLines);

    return {
      type: "success",
      rawJson: geminiResult.text,
      lines: parsedLines.split("\n"),
    };
  }

  warn("translateLyrics: unknown provider", provider);
  return { type: "error" };
}
