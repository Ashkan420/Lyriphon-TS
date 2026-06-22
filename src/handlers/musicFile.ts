import { Context } from "grammy";
import { searchTracks } from "../services/deezer";
import { SessionData, SessionMode } from "../session/types";
import { clearAudioState } from "../session/flows";
import { inMode, transition } from "../session/transitions";
import { searchAndShowResults, safeDelete } from "../utils/telegram";

export async function handleMusicFile(ctx: Context, session: SessionData) {
  const message = ctx.message;
  const chatId = ctx.chat?.id;
  if (!message || !chatId) {
    return;
  }

  if (message.media_group_id) {
    await ctx.reply("❌ Please send only one music file at a time.");
    return;
  }

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
    session.audio.pendingDecision = {
      fileId: message.audio?.file_id,
      messageId: message.message_id,
      title,
      artist,
    };

    await transition(session, SessionMode.AUDIO_DECISION, ctx.api, chatId);

    await ctx.reply("🎵 What would you like to do with this file?", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📎 Attach to Current Telegraph", callback_data: "audio_decision_attach" }],
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

  const ok = await searchAndShowResults(
    ctx.api,
    chatId,
    session,
    searchQuery,
    displayLabel,
    (results, page) => {
      const start = (page ?? 0) * 5;
      return results.slice(start, start + 5).map((item) => [
        {
          text: `${item?.title ?? "Unknown"} - ${item?.artist?.name ?? "Unknown"} (${Math.floor((item?.duration ?? 0) / 60)}:${String((item?.duration ?? 0) % 60).padStart(2, "0")})`,
          callback_data: `track_${item?.id}`,
        },
      ]);
    },
    searchTracks,
  );

  if (!ok) {
    session.audio.fileId = undefined;
  }
}
