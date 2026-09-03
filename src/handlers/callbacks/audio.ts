import { Context } from "grammy";
import { safeDelete, safeAnswer, attachAudioAndPromptChannel, searchAndShowResults } from "../../utils/telegram";
import { buildTrackButtons } from "../songSearch";
import { log, warn } from "../../utils/logger";
import { transition } from "../../session/transitions";
import { captureVersion, isStale, SessionMode } from "../../session/index";
import { SessionData } from "../../session/types";
import { Env } from "../../env";
import { searchTracks } from "../../services/deezer";
import { chatId } from "./index";
import { takePendingSend, clearPendingSend } from "../bridge";
import { setTrackFileId } from "../../db/tracks";

export async function handleAudioDecisionCallback(ctx: Context, session: SessionData, env: Env) {
  const data = ctx.callbackQuery?.data;
  await safeAnswer(ctx);

  const decision = session.audio.pendingDecision as any;
  if (!decision) {
    await ctx.editMessageText("❌ This selection has expired.");
    return;
  }

  const { fileId, messageId, title, artist } = decision;
  session.audio.pendingDecision = undefined;
  const cid = chatId(ctx);
  if (cid) {
    await safeDelete(ctx.api as any, cid, ctx.callbackQuery!.message!.message_id);
  }

  if (data === "audio_decision_attach") {
    const telegraphUrl = session.telegraph.url;
    const lastData = session.telegraph.data as Record<string, any>;
    if (!telegraphUrl || !lastData) {
      await ctx.reply("❌ Telegraph expired. Send /song to create a new one.");
      return;
    }

    const trackName = lastData.track ?? "Unknown Track";
    const artistName = lastData.artist ?? "Unknown Artist";

    const caption = await attachAudioAndPromptChannel(
      ctx.api,
      env.DB,
      cid!,
      String(ctx.from?.id ?? ""),
      session,
      fileId,
      telegraphUrl,
      trackName,
      artistName,
    );
    if (!caption) {
      return;
    }

    // The attached file becomes canonical for this track (Replace/Attach).
    if (typeof lastData.trackId === "number") {
      try {
        await setTrackFileId(env.DB, lastData.trackId, fileId);
      } catch (error) {
        warn("audio attach: failed to store track file_id", error);
      }
    }

    // Telegraph stays live so the user can still attach a different file.
    if (isStale(session, captureVersion(session))) {
      return;
    }
    await transition(session, SessionMode.IDLE, ctx.api, cid);

  } else if (data === "audio_decision_search") {
    session.audio.fileId = fileId;
    session.audio.title = title;
    session.audio.artist = artist;
    session.audio.messageId = messageId;

    const searchQuery = `${artist} ${title}`.trim();
    const displayLabel = artist ? `${artist} - ${title}` : title;
    log("audio decision: search with", JSON.stringify({ title, artist, searchQuery }));
    const myVersion = captureVersion(session);
    const ok = await searchAndShowResults(
      ctx.api,
      cid!,
      session,
      searchQuery,
      displayLabel,
      buildTrackButtons,
      searchTracks,
      myVersion,
      isStale,
    );

    if (!ok && !isStale(session, myVersion)) {
      session.audio.fileId = undefined;
    }

  } else if (data === "audio_decision_cancel") {
    await transition(session, SessionMode.IDLE, ctx.api, cid);
    await ctx.reply("❌ Cancelled.");
  }
}

export async function handleSendToChannelCallback(ctx: Context, session: SessionData, env: Env) {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("send_channel_")) {
    return;
  }

  await safeAnswer(ctx);
  const channelId = data.replace("send_channel_", "");
  let audioFileId = session.audio.pendingFileId;
  let caption = session.audio.pendingCaption;
  let telegraphUrl = session.audio.pendingTelegraphUrl;

  // Bridge deliveries bypass the requester's SessionDO, so session fields
  // are empty for them — fall back to the D1 pending-send stash.
  if (!audioFileId || !caption || !telegraphUrl) {
    const stashed = await takePendingSend(env, String(ctx.from?.id ?? ""));
    if (stashed) {
      audioFileId = stashed.fileId;
      caption = stashed.caption;
      telegraphUrl = stashed.telegraphUrl ?? undefined;
    }
  }

  if (!audioFileId || !caption || !telegraphUrl) {
    await ctx.editMessageText("❌ Nothing to send.");
    session.audio.sendChannelPromptId = undefined;
    return;
  }

  try {
    const member = await ctx.api.getChatMember(Number(channelId), Number(ctx.from?.id ?? 0));
    if (member.status !== "administrator" && member.status !== "creator") {
      await safeAnswer(ctx, "❌ You are not an admin in this channel.");
      return;
    }
  } catch (error) {
    warn("Failed to verify admin status for channel", channelId, error);
    await safeAnswer(ctx, "❌ Can't access this channel.");
    return;
  }

  const button = { inline_keyboard: [[{ text: "Lyrics", url: telegraphUrl }]] };
  try {
    await ctx.api.sendAudio(channelId, audioFileId, {
      caption,
      parse_mode: "MarkdownV2",
      reply_markup: button,
    });
  } catch (error) {
    warn("Failed to send audio to channel", channelId, error);
    await ctx.editMessageText("❌ Failed to send to channel.");
    return;
  }

  await ctx.editMessageText("✅ Sent to channel!");
  session.audio.pendingFileId = undefined;
  session.audio.pendingCaption = undefined;
  session.audio.pendingTelegraphUrl = undefined;
  session.audio.sendChannelPromptId = undefined;
  await clearPendingSend(env, String(ctx.from?.id ?? ""));
}
