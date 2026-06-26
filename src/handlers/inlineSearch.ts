import { Context } from "grammy";
import type { InlineQueryResultArticle, InputTextMessageContent } from "@grammyjs/types";
import { searchTracks } from "../services/deezer";
import { Env } from "../env";
import { containsFarsi, transliterateFarsi } from "../services/translation/finglish";
import { formatDuration } from "../utils/telegram";

export async function inlineSearch(ctx: Context, env: Env) {
  const queryText = ctx.inlineQuery?.query?.trim();
  if (!queryText) {
    await ctx.answerInlineQuery([], {
      cache_time: 300,
      is_personal: true,
      button: { text: "Type a song name to search", parameter: "help" } as any,
    });
    return;
  }

  // Farsi titles don't match Deezer's Latin-script index. Search the Finglish
  // transliteration first, falling back to the original on no results.
  let results = await searchTracks(
    containsFarsi(queryText)
      ? (await transliterateFarsi(env, queryText)) ?? queryText
      : queryText,
    5,
  );
  if (results && !results.length && containsFarsi(queryText)) {
    const fallback = await searchTracks(queryText, 5);
    if (fallback?.length) {
      results = fallback;
    }
  }
  if (!results) {
    await ctx.answerInlineQuery([], { cache_time: 60, is_personal: true });
    return;
  }

  const articles: InlineQueryResultArticle[] = results.map((item: any) => {
    const trackName = item?.title ?? "Unknown";
    const artistName = item?.artist?.name ?? "Unknown";
    const duration = item?.duration ?? 0;
    const albumCover = item?.album?.cover_medium ?? "";
    const trackId = item?.id;

    const messageText = `🎵 *${trackName}*\n👤 ${artistName}\n⏱ ${formatDuration(duration)}`;

    return {
      type: "article",
      id: String(trackId),
      title: `${trackName} - ${artistName}`,
      description: `${artistName} (${formatDuration(duration)})`,
      thumb_url: albumCover || undefined,
      input_message_content: {
        message_text: messageText,
        parse_mode: "Markdown",
      } as InputTextMessageContent,
      reply_markup: {
        inline_keyboard: [[{ text: "📄 Get Lyrics", callback_data: `track_${trackId}` }]],
      },
    };
  });

  await ctx.answerInlineQuery(articles, {
    cache_time: 300,
    is_personal: true,
  });
}
