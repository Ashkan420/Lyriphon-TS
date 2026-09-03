import { Context } from "grammy";
import { searchTracks } from "../services/deezer";
import { Env } from "../env";
import { SessionData, SessionMode } from "../session/types";
import { clearAudioState } from "../session/flows";
import { inMode, transition } from "../session/transitions";
import { searchAndShowResults, clearSendChannelPrompt } from "../utils/telegram";
import { log } from "../utils/logger";
import { buildTrackButtons } from "./songSearch";
import { hasTrackFile } from "../db/tracks";

export async function handleMusicFile(ctx: Context, session: SessionData, env: Env) {
  const message = ctx.message;
  const chatId = ctx.chat?.id;
  if (!message || !chatId) {
    return;
  }

  if (message.media_group_id) {
    await ctx.reply("❌ Please send only one music file at a time.");
    return;
  }

  await clearSendChannelPrompt(ctx.api, chatId, session);

  const titleCandidate = message.audio?.title;
  const artistCandidate = message.audio?.performer;
  const filename = message.audio?.file_name ?? "Unknown";

  let title = titleCandidate || (filename.includes(".") ? filename.slice(0, filename.lastIndexOf(".")) : filename);
  let artist = artistCandidate ?? "";

  if (title.includes(" - ") && !artist) {
    const [maybeArtist, maybeTitle] = title.split(" - ", 2);
    artist = maybeArtist.trim();
    title = maybeTitle.trim();
  } else if (title.includes(" – ") && !artist) {
    const [maybeArtist, maybeTitle] = title.split(" – ", 2);
    artist = maybeArtist.trim();
    title = maybeTitle.trim();
  } else if (title.includes("_-_") && !artist) {
    const [maybeArtist, maybeTitle] = title.split("_-_", 2);
    artist = maybeArtist.trim();
    title = maybeTitle.trim();
  }

  const telegraphUrl = session.telegraph.url;
  const lastData = session.telegraph.data;
  const hasPendingAudio = Boolean(session.audio.fileId);
  const inEdit = inMode(session, SessionMode.EDIT_FIELD) || inMode(session, SessionMode.EDIT_LYRICS);

  if (telegraphUrl && lastData && !hasPendingAudio && !inEdit) {
    log("audio file: pending decision (attach vs search)", JSON.stringify({ title, artist, filename }));
    session.audio.pendingDecision = {
      fileId: message.audio?.file_id,
      messageId: message.message_id,
      title,
      artist,
    };

    await transition(session, SessionMode.AUDIO_DECISION, ctx.api, chatId);

    // When the store already holds a file for this track, attaching swaps
    // the audio in — relabel so the user knows what will happen.
    const trackId = (lastData as any)?.trackId;
    const hasStoredAudio = trackId ? await hasTrackFile(env.DB, trackId) : false;
    const attachLabel = hasStoredAudio ? "🔁 Replace Audio" : "📎 Attach to Current Telegraph";

    await ctx.reply("🎵 What would you like to do with this file?", {
      reply_markup: {
        inline_keyboard: [
          [{ text: attachLabel, callback_data: "audio_decision_attach" }],
          [{ text: "🔍 Search Using This File", callback_data: "audio_decision_search" }],
          [{ text: "❌ Cancel", callback_data: "audio_decision_cancel" }],
        ],
      },
    });
    return;
  }

  if (inEdit) {
    return;
  }

  session.audio.fileId = message.audio?.file_id;
  session.audio.title = title;
  session.audio.artist = artist;
  session.audio.messageId = message.message_id;

  const searchQuery = `${artist} ${title}`.trim();
  const displayLabel = artist ? `${artist} - ${title}` : title;
  log(
    "audio file received:",
    JSON.stringify({
      title,
      artist,
      filename,
      titleTag: titleCandidate ?? null,
      performerTag: artistCandidate ?? null,
      searchQuery,
    }),
  );

  const ok = await searchAndShowResults(
    ctx.api,
    chatId,
    session,
    searchQuery,
    displayLabel,
    buildTrackButtons,
    searchTracks,
  );

  if (!ok) {
    session.audio.fileId = undefined;
  }
}
