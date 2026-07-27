import { Env } from "../../env";
import { geminiTranslate, GeminiResult } from "./gemini";
import { composeTranslationPrompt } from "./prompts";
import { findLanguage, LanguageCode } from "./types";
import { log, previewText, warn } from "../../utils/logger";
import { LanguageAnalysis } from "./language-analyzer";
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
}

const RETRY_HINT = `\n\n⚠️ CRITICAL RETRY INSTRUCTION — YOU FAILED THIS BEFORE:
Your previous attempt had the WRONG number of lines in the output array.
The input has exactly N lines. Your JSON array MUST have exactly N elements.
Count your output carefully before responding. If unsure, re-count.
Line count mismatch is the ONLY reason this retry was triggered.`;

export async function translateLyrics(
  env: Env,
  lyrics: string,
  targetLangCode: LanguageCode,
  langAnalysis?: LanguageAnalysis,
  multilingualEnabled = true,
  retryHint = false,
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

  const lineCount = lyrics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
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
    previewText(lyrics),
  );

  const prompt = composeTranslationPrompt(lyrics, language, langAnalysis, multilingualEnabled);

  if (retryHint) {
    prompt.system += RETRY_HINT.replace(/N/g, String(lineCount));
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
      warn("translateLyrics: failed to parse JSON translation", {
        lineCount: originalLineCount,
        snippet: geminiResult.text.slice(0, 200),
      });
      return { type: "error" };
    }

    log(
      "translateLyrics:success",
      JSON.stringify({ target: targetLangCode, lineCount: originalLineCount }),
      "preview:",
      previewText(parsedLines),
    );

    return {
      type: "success",
      rawJson: geminiResult.text,
      lines: parsedLines.split("\n"),
    };
  }

  warn("translateLyrics: unknown provider", provider);
  return { type: "error" };
}
