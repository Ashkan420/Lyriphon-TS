import { Context } from "grammy";
import type { InlineKeyboardButton } from "@grammyjs/types";
import { searchTracks } from "../services/deezer";
import { Env } from "../env";
import { containsFarsi, transliterateFarsi } from "../services/translation/finglish";
import { SessionData, SessionMode } from "../session/types";
import { clearAudioState } from "../session/flows";
import { inMode } from "../session/transitions";
import { searchAndShowResults, safeAnswer, formatDuration, clearSendChannelPrompt } from "../utils/telegram";

const PAGE_SIZE = 5;

export function buildTrackButtons(results: any[], page = 0) {
  const start = page * PAGE_SIZE;
  const pageResults = results.slice(start, start + PAGE_SIZE);

  const buttons: Array<Array<InlineKeyboardButton>> = [];
  for (const item of pageResults) {
    const trackName = item?.title ?? "Unknown";
    const artistName = item?.artist?.name ?? "Unknown";
    const duration = item?.duration ?? 0;
    const trackId = item?.id;
    const durText = formatDuration(duration);

    buttons.push([
      {
        text: `${trackName} - ${artistName} (${durText})`,
        callback_data: `track_${trackId}`,
      },
    ]);
  }

  const navButtons: InlineKeyboardButton[] = [];
  if (page > 0) {
    navButtons.push({ text: "⬅️ Previous", callback_data: `search_page_${page - 1}` });
  }
  if (results.length > start + PAGE_SIZE) {
    navButtons.push({ text: "Next ➡️", callback_data: `search_page_${page + 1}` });
  }
  if (navButtons.length) {
    buttons.push(navButtons);
  }

  return buttons;
}

export async function songSearchCommand(ctx: Context, session: SessionData, env: Env) {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  clearAudioState(session);

  await clearSendChannelPrompt(ctx.api, chatId, session);

  const query = (typeof ctx.match === 'string' ? ctx.match : ctx.match?.[0]) ?? ctx.message?.text?.split(" ").slice(1).join(" ");
  if (!query) {
    await ctx.reply("❌ Usage: /song <track name>");
    return;
  }

  // Farsi titles don't match Deezer's Latin-script index. Transliterate to
  // Finglish and search with that, falling back to the original on no results.
  let searchQuery = query;
  let displayLabel = query;
  let fallbackQuery: string | undefined;
  if (containsFarsi(query)) {
    const finglish = await transliterateFarsi(env, query);
    if (finglish) {
      searchQuery = finglish;
      displayLabel = `${query} → ${finglish}`;
      fallbackQuery = query;
    }
  }

  await searchAndShowResults(
    ctx.api,
    chatId,
    session,
    searchQuery,
    displayLabel,
    buildTrackButtons,
    searchTracks,
    undefined,
    undefined,
    fallbackQuery,
  );
}

export async function handleSearchPageCallback(ctx: Context, session: SessionData) {
  await safeAnswer(ctx);

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("search_page_")) {
    return;
  }

  const page = Number(data.replace("search_page_", ""));
  if (Number.isNaN(page)) {
    await ctx.editMessageText("❌ Invalid page.");
    return;
  }

  const results = session.search.results;
  if (!Array.isArray(results) || results.length === 0) {
    await ctx.editMessageText("❌ Search expired. Try again with /song.");
    return;
  }

  session.search.page = page;
  const buttons = buildTrackButtons(results, page);
  await ctx.editMessageText("🎵 Select the track:", {
    reply_markup: { inline_keyboard: buttons },
  });
}
