import { Context } from "grammy";
import { editSongPage } from "../../services/telegraph";
import { safeAnswer } from "../../utils/telegram";
import { combineLyricsWithTranslation, combineLyricsFromJson, parseTranslationJson } from "../../services/translation/combine";
import { warn } from "../../utils/logger";
import { SessionData } from "../../session/types";
import { Env } from "../../env";

export const urlFields = ["track_link", "artist_link", "album_link", "cover"];

// Wraps editSongPage so callers can branch on success without repeating the
// try/catch + warn at every site. Callers handle their own state cleanup and
// user-facing message based on the returned boolean.
export async function tryEditSongPage(
  env: Env,
  lastData: unknown,
  lyrics: string,
  context: string,
): Promise<boolean> {
  try {
    await editSongPage(env, lastData as any, lyrics);
    return true;
  } catch (error) {
    warn(`Failed to update Telegraph page (${context})`, error);
    return false;
  }
}

export function chatId(ctx: Context): number | undefined {
  return ctx.chat?.id;
}

export function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

export function resetTranslationState(session: SessionData) {
  session.telegraph.isTranslating = false;
  session.telegraph.translateMessageId = undefined;
}

export function getDisplayLyrics(session: SessionData): string | null {
  const { originalLyrics, translatedLyrics, activeLang } = session.telegraph;

  if (!originalLyrics) {
    return null;
  }

  if (!activeLang || activeLang === "original") {
    return originalLyrics;
  }

  const cacheKey = `${activeLang}:${hashString(originalLyrics)}`;
  const entry = translatedLyrics?.[cacheKey];
  if (!entry) {
    return null;
  }

  // Cache stores raw JSON from Gemini — parse and combine
  const originalLineCount = originalLyrics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
  const parsedLines = parseTranslationJson(entry.text, originalLineCount);
  if (parsedLines) {
    return combineLyricsFromJson(originalLyrics, parsedLines.split("\n"))?.combined ?? null;
  }

  // Fallback: try text-based combine (handles legacy plain-text cache entries)
  return combineLyricsWithTranslation(originalLyrics, entry.text)?.combined ?? null;
}

export function buildEditMenu(expanded = false) {
  if (!expanded) {
    return [
      [{ text: "✏️ Edit Telegraph", callback_data: "expand_edit_menu" }],
      [{ text: "🌐 Translate Lyrics", callback_data: "translate:open" }],
    ];
  }

  return [
    [
      { text: "✏️ Lyrics", callback_data: "edit_field_lyrics" },
      { text: "👑 Author", callback_data: "edit_field_author" },
    ],
    [
      { text: "📝 Track", callback_data: "edit_field_track" },
      { text: "🔗 Track Link", callback_data: "edit_field_track_link" },
    ],
    [
      { text: "👤 Artist", callback_data: "edit_field_artist" },
      { text: "🔗 Artist Link", callback_data: "edit_field_artist_link" },
    ],
    [
      { text: "💽 Album", callback_data: "edit_field_album" },
      { text: "🔗 Album Link", callback_data: "edit_field_album_link" },
    ],
    [
      { text: "📅 Release Date", callback_data: "edit_field_date" },
      { text: "🖼 Cover URL", callback_data: "edit_field_cover" },
    ],
    [
      { text: "🌐 Translate Lyrics", callback_data: "translate:open" },
    ],
  ];
}

export async function handleExpandEditMenu(ctx: Context) {
  await safeAnswer(ctx);
  try {
    await ctx.editMessageReplyMarkup({
      reply_markup: { inline_keyboard: buildEditMenu(true) },
    });
  } catch {}
}

export { handleCallbackQuery, processTextMessage } from "./dispatcher";
