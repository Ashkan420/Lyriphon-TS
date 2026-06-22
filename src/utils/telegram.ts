import { Api, type RawApi } from "grammy";
import { D1Database } from "@cloudflare/workers-types";
import { getUserChannels } from "../db/channels";
import { SessionData, SessionMode } from "../session/types";
import { transition } from "../session/transitions";
import { resetFlow } from "../session/flows";
import { escapeMd as escapeMdUtil } from "./escapeMd";

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${minutes}:${sec.toString().padStart(2, "0")}`;
}

export async function safeDelete(bot: Api<RawApi>, chatId: number, messageId: number) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch {
    // ignore
  }
}

export async function delayedDelete(
  bot: Api<RawApi>,
  chatId: number,
  messageId: number,
  delaySeconds: number,
  scheduleDelete?: (chatId: number, messageId: number, delayMs: number) => void,
) {
  if (scheduleDelete) {
    scheduleDelete(chatId, messageId, Math.round(delaySeconds * 1000));
    return;
  }

  // In Cloudflare Workers, setTimeout is not available.
  // scheduleDelete (DO alarm queue) must be provided.
  console.warn("delayedDelete called without scheduleDelete — message will not be deleted");
}

export async function searchAndShowResults(
  bot: Api<RawApi>,
  chatId: number,
  session: SessionData,
  searchQuery: string,
  displayLabel: string,
  buildTrackButtons: (results: any[], page?: number) => any[][],
  searchTracks: (query: string, limit?: number) => Promise<any[] | null>,
  version?: number,
  isStale?: (session: SessionData, capturedVersion: number) => boolean,
) {
  const results = await searchTracks(searchQuery);
  if (!results) {
    await bot.sendMessage(chatId, "❌ Search failed. Try again later.");
    return false;
  }

  if (version !== undefined && isStale && isStale(session, version)) {
    return false;
  }

  session.search.results = results;
  session.search.page = 0;

  const buttons = buildTrackButtons(results, 0);
  const text = displayLabel
    ? `🎵 Found matches for: ${displayLabel}\nSelect the track:`
    : "🎵 Select the track:";
  await bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: buttons },
  });
  return true;
}

export async function attachAudioAndPromptChannel(
  bot: Api<RawApi>,
  db: D1Database,
  chatId: number,
  userId: string,
  session: SessionData,
  fileId: string,
  telegraphUrl: string,
  trackName: string,
  artistName: string,
) {
  const trackNameMd = escapeMdUtil(trackName);
  const artistNameMd = escapeMdUtil(artistName);
  const hiddenLink = `[‎](${telegraphUrl})`;
  const caption = `>\`${trackNameMd} — ${artistNameMd}\`${hiddenLink}`;

  const inlineKeyboard = [
    [{ text: "Lyrics", url: telegraphUrl }],
  ];

  try {
    await bot.sendAudio(chatId, fileId, {
      caption,
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  } catch {
    await bot.sendMessage(chatId, "❌ Failed to attach audio.");
    return null;
  }

  session.audio.pendingFileId = fileId;
  session.audio.pendingCaption = caption;
  session.audio.pendingTelegraphUrl = telegraphUrl;

  try {
    const channels = await getUserChannels(db, userId);
    if (channels.length) {
      const channelButtons = channels.map((row) => [
        { text: row.title ?? row.channel_id, callback_data: `send_channel_${row.channel_id}` },
      ]);
      const prompt = await bot.sendMessage(chatId, "Send to which channel?", {
        reply_markup: { inline_keyboard: channelButtons },
      });
      session.audio.sendChannelPromptId = prompt.message_id;
    }
  } catch (error) {
    console.warn("Failed to fetch user channels (table may not exist)", error);
  }

  return caption;
}

export async function cancelEdit(bot: Api<RawApi>, chatId: number, session: SessionData) {
  await transition(session, SessionMode.IDLE, bot, chatId);
  resetFlow(session.edit);
  resetFlow(session.lyrics);
}

export { escapeMdUtil as escapeMd };
