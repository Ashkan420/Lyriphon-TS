// Inline mode: Deezer search served as inline results.
//
// Handled SESSION-FREE in the worker (src/index.ts), not inside the user's
// SessionDO: Telegram fires one inline_query per keystroke, and the SessionDO
// serializes updates (blockConcurrencyWhile) — queued queries expire
// ("query is too old") and inline mode appears broken. Direct worker handling
// lets every keystroke's query run in parallel and answer within the window.
//
// Staleness guard: a slow answer for an earlier keystroke prefix ("hel") can
// land after the final one ("hello") and overwrite it. Only the user's newest
// query id is answered; a search that finishes after a newer keystroke is
// dropped. The map is per-isolate — across isolates the worst case is a rare
// duplicate answer, which is harmless.

import { Api } from "grammy";
import type { InlineQueryResultArticle, InputTextMessageContent } from "@grammyjs/types";
import { searchTracks } from "../services/deezer";
import { Env } from "../env";
import { formatDuration } from "../utils/telegram";
import { log } from "../utils/logger";

// user id → the newest inline query id seen for that user (per-isolate).
const newestQueryIds = new Map<string, string>();

// Pure guard (testable): only the newest query of a burst may answer.
export function isNewestQuery(store: Map<string, string>, userKey: string, queryId: string): boolean {
  return store.get(userKey) === queryId;
}

// Pure builder so the article shape is testable without grammY.
export function buildInlineResults(results: any[]): InlineQueryResultArticle[] {
  return results.map((item: any): InlineQueryResultArticle => {
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
      thumbnail_url: albumCover || undefined,
      input_message_content: {
        message_text: messageText,
        parse_mode: "Markdown",
      } as InputTextMessageContent,
      reply_markup: {
        inline_keyboard: [[{ text: "📄 Get Lyrics", callback_data: `track_${trackId}` }]],
      },
    };
  });
}

// Session-free inline_query handler, called straight from the worker webhook.
// Never throws — a rejection would surface as a 500 and make Telegram
// redeliver the update (same rule as handleBridgeUpdate).
export async function handleInlineQueryUpdate(env: Env, inlineQuery: any): Promise<void> {
  try {
    const queryId = inlineQuery?.id as string | undefined;
    if (!queryId) {
      return;
    }
    const userKey = String(inlineQuery?.from?.id ?? "unknown");
    const queryText = String(inlineQuery?.query ?? "").trim();

    const api = new Api(env.BOT_TOKEN);

    if (!queryText) {
      // start_parameter is the only valid companion field of the results
      // button (alongside web_app) — `parameter` is rejected by the API.
      await api.answerInlineQuery(queryId, [], {
        cache_time: 300,
        is_personal: true,
        button: { text: "Type a song name to search", start_parameter: "help" },
      }).catch((error) => log("inline search: empty-answer failed", error));
      return;
    }

    // Register this as the user's newest query; an in-flight search for an
    // older id becomes stale and drops its answer.
    newestQueryIds.set(userKey, queryId);

    log("inline search:", JSON.stringify(queryText));
    const results = await searchTracks(queryText, 50);
    if (!results) {
      log("inline search failed for", JSON.stringify(queryText));
      await answerEmpty(api, queryId, 60);
      return;
    }
    log("inline search: returning", results.length, "result(s)");

    if (!isNewestQuery(newestQueryIds, userKey, queryId)) {
      log("inline search: dropping stale answer for", JSON.stringify(queryText));
      return;
    }

    const articles = buildInlineResults(results);
    await api.answerInlineQuery(queryId, articles, {
      cache_time: 300,
      is_personal: true,
    }).catch((error) => log("inline search: answer failed (query may have expired)", error));
  } catch (error) {
    log("inline search: update handling failed", error);
  }
}

async function answerEmpty(api: Api<any>, queryId: string, cacheTime: number): Promise<void> {
  try {
    await api.answerInlineQuery(queryId, [], {
      cache_time: cacheTime,
      is_personal: true,
    });
  } catch {
    // query already expired — nothing to do
  }
}
