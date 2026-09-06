import { Context } from "grammy";
import type { InlineKeyboardButton } from "@grammyjs/types";
import { safeAnswer, safeEdit, safeDelete } from "../../utils/telegram";
import { warn } from "../../utils/logger";
import { translateLyrics, TranslationResult } from "../../services/translation/index";
import {
  isSourceLanguage,
  getLanguageUiLabel,
  LanguageAnalysis,
} from "../../services/translation/language-analyzer";
import {
  findLanguage,
  SUPPORTED_LANGUAGES,
  LanguageCode,
} from "../../services/translation/types";
import { combineLyricsWithTranslation, combineLyricsFromJson, parseTranslationJson } from "../../services/translation/combine";
import { log } from "../../utils/logger";
import { Env } from "../../env";
import { SessionData } from "../../session/types";
import {
  chatId,
  hashString,
  tryEditSongPage,
  resetTranslationState,
  failTranslationState,
} from "./index";

export async function handleTranslateCallback(ctx: Context, session: SessionData, env: Env) {
  const data = ctx.callbackQuery?.data ?? "";

  if (data === "translate:open") {
    if (!session.telegraph.originalLyrics) {
      await safeAnswer(ctx, "No lyrics to translate");
      return;
    }
    if (session.telegraph.isTranslating) {
      await safeAnswer(ctx, "Translation in progress");
      return;
    }
    await safeAnswer(ctx);

    const cid = ctx.chat?.id;
    if (!cid) return;

    const buttons = buildLanguagePickerKeyboard(session);
    const msg = await ctx.reply("Select target language:", { reply_markup: { inline_keyboard: buttons } });
    session.telegraph.translateMessageId = msg.message_id;
    session.telegraph.pendingTranslationLang = undefined;
    return;
  }

  if (data === "translate:cancel") {
    await safeAnswer(ctx);
    const msgId = session.telegraph.translateMessageId;
    const cid = chatId(ctx);
    if (msgId && cid) {
      await safeDelete(ctx.api as any, cid, msgId);
    }
    session.telegraph.translateMessageId = undefined;
    session.telegraph.translationCooldownUntil = undefined;
    session.telegraph.pendingTranslationLang = undefined;
    session.telegraph.isTranslating = false;
    return;
  }

  if (data === "translate:retry") {
    if (session.telegraph.isTranslating) {
      await safeAnswer(ctx, "Translation in progress");
      return;
    }
    const pendingLang = session.telegraph.pendingTranslationLang;
    if (!pendingLang) {
      await safeAnswer(ctx, "No pending translation");
      return;
    }
    const cid = chatId(ctx);
    if (!cid) {
      await safeAnswer(ctx);
      return;
    }

    await safeAnswer(ctx);

    let pickerMsgId = session.telegraph.translateMessageId;
    const cooldownUntil = session.telegraph.translationCooldownUntil ?? 0;

    if (Date.now() < cooldownUntil) {
      await showRateLimitCooldown(ctx, cid, pickerMsgId, cooldownUntil);
      return;
    }

    // Pre-fix failures cleared translateMessageId; the status message is gone,
    // so start a fresh one for this retry instead of editing nothing.
    if (!pickerMsgId) {
      const msg = await ctx.reply("🌐 Retrying translation...");
      pickerMsgId = msg.message_id;
      session.telegraph.translateMessageId = pickerMsgId;
    }

    session.telegraph.translationCooldownUntil = undefined;
    await applyCachedOrTranslate(ctx, session, env, pendingLang, pickerMsgId, cid);
    return;
  }

  if (data === "translate:lang:original") {
    await safeAnswer(ctx);
    const lastData = session.telegraph.data as any;
    if (!lastData || !session.telegraph.originalLyrics) {
      const msgId = session.telegraph.translateMessageId;
      const cid = chatId(ctx);
      if (msgId && cid) {
        await safeEdit(ctx.api, cid, msgId, "❌ No song data found.");
      }
      return;
    }
    if (!(await tryEditSongPage(env, lastData, session.telegraph.originalLyrics, "original lyrics"))) {
      const msgId = session.telegraph.translateMessageId;
      const cid = chatId(ctx);
      if (msgId && cid) {
        await safeEdit(ctx.api, cid, msgId, "❌ Failed to update Telegraph page");
      }
      return;
    }
    session.telegraph.activeLang = "original";
    session.telegraph.pendingTranslationLang = undefined;
    const msgId = session.telegraph.translateMessageId;
    const cid = chatId(ctx);
    if (msgId && cid) {
      await safeEdit(ctx.api, cid, msgId, "✅ Restored original lyrics");
    }
    session.telegraph.translateMessageId = undefined;
    return;
  }

  if (data.startsWith("translate:lang:")) {
    const langCode = data.replace("translate:lang:", "");

    if (session.telegraph.isTranslating) {
      await safeAnswer(ctx, "Translation in progress");
      return;
    }

    // Clicking the currently displayed language re-runs the translation
    // (fresh Gemini output replaces the cached one) instead of no-op'ing.
    const isRetranslate = session.telegraph.activeLang === langCode;

    const language = findLanguage(langCode);
    if (!language) {
      await safeAnswer(ctx, "Unsupported language");
      return;
    }

    // English stays selectable even when detection flags English — franc /
    // script detection produces false positives (mixed or transliterated
    // lyrics), so users can force an English translation regardless.
    if (
      langCode !== "en" &&
      isSourceLanguage(session.telegraph.languageAnalysis, langCode)
    ) {
      await safeAnswer(ctx, "Lyrics already appear to be in this language.");
      return;
    }
    await safeAnswer(ctx);

    const originalLyrics = session.telegraph.originalLyrics;
    if (!originalLyrics) {
      const msgId = session.telegraph.translateMessageId;
      const cid = chatId(ctx);
      if (msgId && cid) {
        await safeEdit(ctx.api, cid, msgId, "❌ No lyrics to translate.");
      }
      return;
    }

    const pickerMsgId = session.telegraph.translateMessageId;
    const cid = chatId(ctx);

    await applyCachedOrTranslate(ctx, session, env, langCode, pickerMsgId, cid, isRetranslate);
    return;
  }
}

// Cache-hit path shared by the language picker and translate:retry: when a
// valid translation is already cached for this lang + lyrics, re-apply it to
// the Telegraph page without a second Gemini call; otherwise run a fresh
// executeTranslation. forceFresh (re-translate of the active language) skips
// the cache so the fresh result replaces the old one.
async function applyCachedOrTranslate(
  ctx: Context,
  session: SessionData,
  env: Env,
  langCode: string,
  pickerMsgId: number | undefined,
  cid: number | undefined,
  forceFresh = false,
) {
  const language = findLanguage(langCode);
  if (!language) return;

  const originalLyrics = session.telegraph.originalLyrics;
  if (!originalLyrics) {
    if (cid && pickerMsgId) {
      await safeEdit(ctx.api, cid, pickerMsgId, "❌ No lyrics to translate.");
    }
    return;
  }

  const originalHash = hashString(originalLyrics);
  const cacheKey = `${langCode}:${originalHash}`;
  const cached = forceFresh ? undefined : session.telegraph.translatedLyrics?.[cacheKey];

  if (cached) {
    const originalLineCount = originalLyrics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
    const parsedLines = parseTranslationJson(cached.text, originalLineCount);
    if (parsedLines) {
      log("translate:cache-hit", "original:", originalLyrics, "translation:", parsedLines);
      const result = combineLyricsFromJson(originalLyrics, parsedLines.split("\n"));
      if (result) {
        const lastData = session.telegraph.data as any;
        if (lastData) {
          if (!(await tryEditSongPage(env, lastData, result.combined, "cached translation"))) {
            if (cid && pickerMsgId) {
              await safeEdit(ctx.api, cid, pickerMsgId, "❌ Failed to update Telegraph page");
            }
            return;
          }
        }
        session.telegraph.activeLang = langCode;
        session.telegraph.pendingTranslationLang = undefined;
        if (cid && pickerMsgId) {
          await safeEdit(ctx.api, cid, pickerMsgId, `✅ ${language.name} lyrics added. `);
        }
        session.telegraph.translateMessageId = undefined;
        return;
      }
    }
    // parse failed or combine returned null → fall through to fresh translation
  }

  await executeTranslation(ctx, session, env, langCode, pickerMsgId, cid);
}

async function showRateLimitCooldown(
  ctx: Context,
  cid: number | undefined,
  pickerMsgId: number | undefined,
  cooldownUntil: number,
) {
  const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  if (pickerMsgId && cid) {
    await safeEdit(ctx.api, cid, pickerMsgId,
      `⏳ Gemini is rate-limited.\nPlease wait ${remaining}s and try again.`,
      { inline_keyboard: buildRetryKeyboard() });
  }
}

type TranslateAttempt =
  | { kind: "rate_limited"; cooldownUntil: number }
  | { kind: "json"; rawJson: string; lines: string[] }
  | { kind: "fail" };

// One translateLyrics call, normalized. Swallows unexpected throws (returns
// "fail") so the caller's control flow stays flat across initial + retry.
async function runTranslateAttempt(
  env: Env,
  lyrics: string,
  langCode: string,
  langAnalysis?: LanguageAnalysis,
  multilingualEnabled = true,
  retryHint = false,
): Promise<TranslateAttempt> {
  try {
    const result = await translateLyrics(env, lyrics, langCode as LanguageCode, langAnalysis, multilingualEnabled, retryHint);
    if (result.type === "rate_limited") {
      return { kind: "rate_limited", cooldownUntil: Date.now() + result.retryAfterSeconds * 1000 };
    }
    if (result.type === "success") {
      return { kind: "json", rawJson: result.rawJson, lines: result.lines };
    }
  } catch (error) {
    warn("translateLyrics threw unexpectedly", error);
  }
  return { kind: "fail" };
}

async function executeTranslation(
  ctx: Context,
  session: SessionData,
  env: Env,
  langCode: string,
  pickerMsgId: number | undefined,
  cid: number | undefined,
) {
  const language = findLanguage(langCode);
  if (!language) return;

  const originalLyrics = session.telegraph.originalLyrics;
  if (!originalLyrics) {
    await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ No lyrics to translate.");
    return;
  }

  const cooldownUntil = session.telegraph.translationCooldownUntil ?? 0;
  if (Date.now() < cooldownUntil) {
    await showRateLimitCooldown(ctx, cid, pickerMsgId, cooldownUntil);
    return;
  }

  session.telegraph.pendingTranslationLang = langCode;
  session.telegraph.isTranslating = true;
  const requestId = crypto.randomUUID();
  session.telegraph.translationRequestId = requestId;
  const snapshotOriginal = originalLyrics;

  // Read detected source language for prompt composition
  const langAnalysis = session.telegraph.languageAnalysis;
  const multilingualEnabled = session.telegraph.multilingualEnabled ?? true;

  await safeEdit(ctx.api, cid!, pickerMsgId!, "🌐 Translating lyrics...\nPlease wait (~10–20s)");

  const attempt = await runTranslateAttempt(env, snapshotOriginal, langCode, langAnalysis, multilingualEnabled);
  if (attempt.kind === "rate_limited") {
    session.telegraph.isTranslating = false;
    session.telegraph.translationCooldownUntil = attempt.cooldownUntil;
    await showRateLimitCooldown(ctx, cid, pickerMsgId, attempt.cooldownUntil);
    return;
  }

  if (session.telegraph.translationRequestId !== requestId) {
    resetTranslationState(session);
    return;
  }

  if (snapshotOriginal !== session.telegraph.originalLyrics) {
    session.telegraph.pendingTranslationLang = undefined;
    resetTranslationState(session);
    await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Session changed during translation. Try again.");
    return;
  }

  const originalHash = hashString(originalLyrics);
  const cacheKey = `${langCode}:${originalHash}`;

  if (attempt.kind !== "json") {
    // The dominant failure is a line-count mismatch from parseTranslationJson
    // (model dropped/merged a line). Retry once with the count hint before
    // surfacing the error — the bare retryHint path was previously unreachable
    // because parse failures short-circuited here.
    const combined = await retryWithHint(
      ctx, session, env, cid, pickerMsgId, snapshotOriginal, langCode, langAnalysis, multilingualEnabled,
    );
    if (combined) {
      session.telegraph.translatedLyrics ??= {};
      session.telegraph.translatedLyrics[cacheKey] = { originalHash, text: combined.rawJson };
      await finishTranslation(ctx, session, env, langCode, cid, pickerMsgId, combined.text);
      return;
    }

    failTranslationState(session);
    warn("translation attempt and retry both failed to produce valid output");
    await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Translation format error — try again", { inline_keyboard: buildRetryKeyboard() });
    return;
  }

  const { rawJson, lines } = attempt;

  if (!session.telegraph.translatedLyrics) {
    session.telegraph.translatedLyrics = {};
  }
  // Cache the raw JSON so we can re-parse on cache hits
  session.telegraph.translatedLyrics[cacheKey] = { originalHash, text: rawJson };

  // JSON output guarantees correct line count — combine directly
  const combinedResult = combineLyricsFromJson(snapshotOriginal, lines);

  let combined: string | null = combinedResult?.combined ?? null;

  if (!combined) {
    // Fallback: try text-based combine on the joined lines (shouldn't happen
    // if JSON was valid, but defensive)
    warn("combineLyricsFromJson returned null, trying text fallback");
    const textFallback = combineLyricsWithTranslation(snapshotOriginal, lines.join("\n"));
    if (textFallback && !textFallback.mismatch) {
      combined = textFallback.combined;
    }
  }

  if (!combined) {
    // Last resort: retry once
    warn("translation combine failed, retrying", {
      provider: env.TRANSLATION_PROVIDER ?? "gemini",
      lang: langCode,
    });

    const retry = await retryWithHint(
      ctx, session, env, cid, pickerMsgId, snapshotOriginal, langCode, langAnalysis, multilingualEnabled,
    );
    if (retry) {
      session.telegraph.translatedLyrics[cacheKey] = { originalHash, text: retry.rawJson };
      combined = retry.text;
    }

    if (!combined) {
      delete session.telegraph.translatedLyrics[cacheKey];
      failTranslationState(session);
      warn("translation retry also failed to produce valid output");
      await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Translation format error — try again", { inline_keyboard: buildRetryKeyboard() });
      return;
    }
  }

  await finishTranslation(ctx, session, env, langCode, cid, pickerMsgId, combined);
}

// One retry with the line-count hint attached. Returns the retry's raw JSON
// and combined text on success, null when still unusable (rate-limited, error,
// or drift-detected combine). The caller owns caching and the error UI.
async function retryWithHint(
  ctx: Context,
  session: SessionData,
  env: Env,
  cid: number | undefined,
  pickerMsgId: number | undefined,
  snapshotOriginal: string,
  langCode: string,
  langAnalysis?: LanguageAnalysis,
  multilingualEnabled = true,
): Promise<{ rawJson: string; text: string } | null> {
  await safeEdit(ctx.api, cid!, pickerMsgId!, "🔄 Retrying translation...");

  const retry = await runTranslateAttempt(env, snapshotOriginal, langCode, langAnalysis, multilingualEnabled, true);
  if (retry.kind === "rate_limited") {
    session.telegraph.isTranslating = false;
    session.telegraph.translationCooldownUntil = retry.cooldownUntil;
    await showRateLimitCooldown(ctx, cid, pickerMsgId, retry.cooldownUntil);
    return null;
  }
  if (retry.kind !== "json") {
    return null;
  }

  const combined = combineLyricsFromJson(snapshotOriginal, retry.lines);
  if (!combined) {
    warn("translation retry output rejected by combine (drift or misalignment)");
    return null;
  }
  return { rawJson: retry.rawJson, text: combined.combined };
}

// Apply a successfully combined translation to the Telegraph page and finish
// the session state. Failure paths set the retry keyboard themselves.
async function finishTranslation(
  ctx: Context,
  session: SessionData,
  env: Env,
  langCode: string,
  cid: number | undefined,
  pickerMsgId: number | undefined,
  combined: string,
): Promise<void> {
  const language = findLanguage(langCode);

  const lastData = session.telegraph.data as any;
  if (lastData) {
    if (!(await tryEditSongPage(env, lastData, combined, "after translation"))) {
      failTranslationState(session);
      await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Failed to update Telegraph page", { inline_keyboard: buildRetryKeyboard() });
      return;
    }
  }

  session.telegraph.activeLang = langCode;
  session.telegraph.pendingTranslationLang = undefined;
  resetTranslationState(session);
  await safeEdit(ctx.api, cid!, pickerMsgId!, `✅ Lyrics translated to ${language?.name ?? langCode}`);
}

function buildRetryKeyboard(): InlineKeyboardButton[][] {
  return [
    [
      { text: "🔄 Retry", callback_data: "translate:retry" },
      { text: "❌ Cancel", callback_data: "translate:cancel" },
    ],
  ];
}

function buildLanguagePickerKeyboard(session: SessionData): InlineKeyboardButton[][] {
  const analysis = session.telegraph.languageAnalysis;
  const buttons: InlineKeyboardButton[][] = [[]];

  for (const lang of SUPPORTED_LANGUAGES) {
    buttons[0].push({ text: lang.nativeName, callback_data: `translate:lang:${lang.code}` });
  }

  const hasCachedTranslation = session.telegraph.translatedLyrics &&
    Object.keys(session.telegraph.translatedLyrics).length > 0;
  if (hasCachedTranslation && session.telegraph.activeLang !== "original") {
    const label = getLanguageUiLabel(analysis);
    buttons.unshift([{ text: label, callback_data: "translate:lang:original" }]);
  }

  buttons.push([{ text: "❌ Cancel", callback_data: "translate:cancel" }]);
  return buttons;
}
