import { Context } from "grammy";
import type { InlineKeyboardButton } from "@grammyjs/types";
import { safeAnswer, safeEdit, safeDelete } from "../../utils/telegram";
import { warn } from "../../utils/logger";
import { translateLyrics } from "../../services/translation/index";
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
import { combineLyricsWithTranslation } from "../../services/translation/combine";
import { Env } from "../../env";
import { SessionData } from "../../session/types";
import {
  chatId,
  hashString,
  tryEditSongPage,
  resetTranslationState,
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
    const pendingLang = session.telegraph.pendingTranslationLang;
    if (!pendingLang) {
      await safeAnswer(ctx, "No pending translation");
      return;
    }

    await safeAnswer(ctx);

    const pickerMsgId = session.telegraph.translateMessageId;
    const cid = chatId(ctx);
    const cooldownUntil = session.telegraph.translationCooldownUntil ?? 0;

    if (Date.now() < cooldownUntil) {
      await showRateLimitCooldown(ctx, cid, pickerMsgId, cooldownUntil);
      return;
    }

    session.telegraph.translationCooldownUntil = undefined;
    await executeTranslation(ctx, session, env, pendingLang, pickerMsgId, cid);
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

    if (session.telegraph.activeLang === langCode) {
      await safeAnswer(ctx, "Already showing this language");
      return;
    }

    const language = findLanguage(langCode);
    if (!language) {
      await safeAnswer(ctx, "Unsupported language");
      return;
    }

    if (isSourceLanguage(session.telegraph.languageAnalysis, langCode)) {
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

    const originalHash = hashString(originalLyrics);
    const cacheKey = `${langCode}:${originalHash}`;
    const cached = session.telegraph.translatedLyrics?.[cacheKey];
    const pickerMsgId = session.telegraph.translateMessageId;
    const cid = chatId(ctx);

    if (cached) {
      const combined = combineLyricsWithTranslation(originalLyrics, cached.text);
      if (combined) {
        const lastData = session.telegraph.data as any;
        if (lastData) {
          if (!(await tryEditSongPage(env, lastData, combined, "cached translation"))) {
            await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Failed to update Telegraph page");
            return;
          }
        }
        session.telegraph.activeLang = langCode;
        await safeEdit(ctx.api, cid!, pickerMsgId!, `✅ ${language.name} lyrics added. `);
        session.telegraph.translateMessageId = undefined;
        return;
      }
    }

    await executeTranslation(ctx, session, env, langCode, pickerMsgId, cid);
    return;
  }
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
      { inline_keyboard: buildRateLimitKeyboard() });
  }
}

type TranslateAttempt =
  | { kind: "rate_limited"; cooldownUntil: number }
  | { kind: "text"; text: string }
  | { kind: "fail" };

// One translateLyrics call, normalized. Swallows unexpected throws (returns
// "fail") so the caller's control flow stays flat across initial + retry.
async function runTranslateAttempt(
  env: Env,
  lyrics: string,
  langCode: string,
  langAnalysis?: LanguageAnalysis,
  multilingualEnabled = true,
): Promise<TranslateAttempt> {
  try {
    const result = await translateLyrics(env, lyrics, langCode as LanguageCode, langAnalysis, multilingualEnabled);
    if (result.type === "rate_limited") {
      return { kind: "rate_limited", cooldownUntil: Date.now() + result.retryAfterSeconds * 1000 };
    }
    if (result.type === "success") {
      return { kind: "text", text: result.text };
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
  const rawResult: string | null = attempt.kind === "text" ? attempt.text : null;

  if (session.telegraph.translationRequestId !== requestId) {
    resetTranslationState(session);
    return;
  }

  if (snapshotOriginal !== session.telegraph.originalLyrics) {
    resetTranslationState(session);
    await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Session changed during translation. Try again.");
    return;
  }

  if (!rawResult) {
    resetTranslationState(session);
    await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Translation failed. try again later.");
    return;
  }

  const originalHash = hashString(originalLyrics);
  const cacheKey = `${langCode}:${originalHash}`;

  if (!session.telegraph.translatedLyrics) {
    session.telegraph.translatedLyrics = {};
  }
  session.telegraph.translatedLyrics[cacheKey] = { originalHash, text: rawResult };

  // combineLyricsWithTranslation only returns null for an empty translation
  // (alignment drift degrades gracefully to a separate block). Retry on that.
  let combined = combineLyricsWithTranslation(snapshotOriginal, rawResult);
  if (!combined) {
    warn("translation empty, retrying", {
      provider: env.TRANSLATION_PROVIDER ?? "gemini",
      lang: langCode,
    });

    await safeEdit(ctx.api, cid!, pickerMsgId!, "🔄 Retrying translation...");

    const retry = await runTranslateAttempt(env, snapshotOriginal, langCode, langAnalysis, multilingualEnabled);
    if (retry.kind === "rate_limited") {
      session.telegraph.isTranslating = false;
      session.telegraph.translationCooldownUntil = retry.cooldownUntil;
      await showRateLimitCooldown(ctx, cid, pickerMsgId, retry.cooldownUntil);
      return;
    }

    if (retry.kind === "text") {
      const retryCombined = combineLyricsWithTranslation(snapshotOriginal, retry.text);
      if (retryCombined) {
        session.telegraph.translatedLyrics[cacheKey] = { originalHash, text: retry.text };
        combined = retryCombined;
      }
    }

    if (!combined) {
      delete session.telegraph.translatedLyrics[cacheKey];
      resetTranslationState(session);
      warn("translation retry also failed to produce matching line count");
      await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Translation format error — try again");
      return;
    }
  }

  const lastData = session.telegraph.data as any;
  if (lastData) {
    if (!(await tryEditSongPage(env, lastData, combined, "after translation"))) {
      resetTranslationState(session);
      await safeEdit(ctx.api, cid!, pickerMsgId!, "❌ Failed to update Telegraph page");
      return;
    }
  }

  session.telegraph.activeLang = langCode;
  resetTranslationState(session);
  await safeEdit(ctx.api, cid!, pickerMsgId!, `✅ Lyrics translated to ${language.name}`);
}

function buildRateLimitKeyboard(): InlineKeyboardButton[][] {
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
