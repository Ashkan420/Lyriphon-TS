import { Context } from "grammy";
import { getTrack, getAlbum, searchTracks } from "../services/deezer";
import { getLyrics } from "../services/lrclib";
import { createSongTelegraph, editSongPage } from "../services/telegraph";
import { isValidUrl } from "../utils/urlValidation";
import {
  safeDelete,
  searchAndShowResults,
  attachAudioAndPromptChannel,
  cancelEdit,
  escapeMd,
} from "../utils/telegram";
import {
  resetFlow,
  SessionMode,
  captureVersion,
  isStale,
} from "../session/index";
import { clearAudioState } from "../session/flows";
import { SessionData } from "../session/types";
import { transition } from "../session/transitions";
import { Env } from "../env";

const urlFields = ["track_link", "artist_link", "album_link", "cover"];

export async function handleCallbackQuery(ctx: Context, session: SessionData, env: Env) {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    return;
  }

  if (data.startsWith("track_")) {
    await handleTrackSelectionCallback(ctx, session, env);
    return;
  }

  if (data.startsWith("audio_decision_")) {
    await handleAudioDecisionCallback(ctx, session, env);
    return;
  }

  if (data.startsWith("edit_field_")) {
    await handleEditFieldCallback(ctx, session);
    return;
  }

  if (data === "cancel_edit") {
    await handleCancelEditCallback(ctx, session);
    return;
  }

  if (data === "done_lyrics") {
    await handleDoneLyricsCallback(ctx, session, env);
    return;
  }

  if (data.startsWith("send_channel_")) {
    await handleSendToChannelCallback(ctx, session);
    return;
  }
}

export async function processTextMessage(ctx: Context, session: SessionData, env: Env) {
  if (!session.edit.field || !(session.mode === SessionMode.EDIT_FIELD || session.mode === SessionMode.EDIT_LYRICS)) {
    return;
  }

  await handleNewFieldValue(ctx, session, env);
}

async function finalizeLyrics(ctx: Context, session: SessionData, env: Env) {
  if (session.mode !== SessionMode.EDIT_LYRICS) {
    try { await ctx.answerCallbackQuery({ text: "Not in lyrics editing mode", show_alert: true }); } catch {}
    return false;
  }

  const myVersion = captureVersion(session);
  if (session.lyrics.locked) {
    try { await ctx.answerCallbackQuery({ text: "Already finalizing...", show_alert: true }); } catch {}
    return false;
  }

  session.lyrics.locked = true;
  const lastData = session.telegraph.data as any;
  if (!lastData) {
    session.lyrics.locked = false;
    try { await ctx.answerCallbackQuery({ text: "No song data found", show_alert: true }); } catch {}
    return false;
  }

  if (!session.lyrics.buffer.length) {
    session.lyrics.locked = false;
    try { await ctx.answerCallbackQuery({ text: "No lyrics to save", show_alert: true }); } catch {}
    return false;
  }

  try { await ctx.answerCallbackQuery(); } catch {}

  const fullLyrics = session.lyrics.buffer.join("\n");
  const chatId = ctx.chat?.id;
  if (chatId) {
    for (const msgId of session.lyrics.messageIds) {
      await safeDelete(ctx.api as any, chatId, msgId);
    }
    if (session.edit.promptId) {
      await safeDelete(ctx.api as any, chatId, session.edit.promptId);
    }
  }

  try {
    await editSongPage(env, lastData, fullLyrics);
  } catch (error) {
    console.warn("Failed to update Telegraph page during lyrics finalization", error);
    session.lyrics.locked = false;
    await transition(session, SessionMode.IDLE, ctx.api, chatId);
    resetFlow(session.lyrics);
    resetFlow(session.edit);
    try { await ctx.editMessageText("❌ Failed to update Telegraph page"); } catch {}
    return false;
  }

  if (isStale(session, myVersion)) {
    session.lyrics.locked = false;
    return false;
  }

  session.telegraph.currentLyrics = fullLyrics;
  await transition(session, SessionMode.IDLE, ctx.api, chatId);
  resetFlow(session.lyrics);
  resetFlow(session.edit);

  try { await ctx.editMessageText("✅ Lyrics Updated"); } catch {}
  return true;
}

async function handleAudioDecisionCallback(ctx: Context, session: SessionData, env: Env) {
  const data = ctx.callbackQuery?.data;
  try { await ctx.answerCallbackQuery(); } catch {}

  const decision = session.audio.pendingDecision as any;
  if (!decision) {
    await ctx.editMessageText("❌ This selection has expired.");
    return;
  }

  const { fileId, messageId, title, artist } = decision;
  session.audio.pendingDecision = undefined;
  const chatId = ctx.chat?.id;
  if (chatId) {
    await safeDelete(ctx.api as any, chatId, ctx.callbackQuery!.message!.message_id);
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
      chatId!,
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

    session.telegraph.url = undefined;
    if (isStale(session, captureVersion(session))) {
      return;
    }
    await transition(session, SessionMode.IDLE, ctx.api, chatId);

  } else if (data === "audio_decision_search") {
    session.audio.fileId = fileId;
    session.audio.title = title;
    session.audio.artist = artist;
    session.audio.messageId = messageId;

    const searchQuery = `${artist} ${title}`.trim();
    const displayLabel = artist ? `${artist} - ${title}` : title;
    const myVersion = captureVersion(session);
    const ok = await searchAndShowResults(
      ctx.api,
      chatId!,
      session,
      searchQuery,
      displayLabel,
      (results, page = 0) => {
        const start = page * 5;
        return results.slice(start, start + 5).map((item: any) => [
          {
            text: `${item?.title ?? "Unknown"} - ${item?.artist?.name ?? "Unknown"} (${Math.floor((item?.duration ?? 0) / 60)}:${String((item?.duration ?? 0) % 60).padStart(2, "0")})`,
            callback_data: `track_${item?.id}`,
          },
        ]);
      },
      searchTracks,
      myVersion,
      isStale,
    );

    if (!ok && !isStale(session, myVersion)) {
      session.audio.fileId = undefined;
    }

  } else if (data === "audio_decision_cancel") {
    await transition(session, SessionMode.IDLE, ctx.api, chatId);
    await ctx.reply("❌ Cancelled.");
  }
}

async function handleEditFieldCallback(ctx: Context, session: SessionData) {
  if (session.mode === SessionMode.EDIT_FIELD || session.mode === SessionMode.EDIT_LYRICS) {
    try { await ctx.api.answerCallbackQuery({ callback_query_id: ctx.callbackQuery?.id, text: "❌ You already have an active edit session", show_alert: true } as any); } catch {}
    return;
  }

  try { await ctx.answerCallbackQuery(); } catch {}
  const data = ctx.callbackQuery?.data ?? "";
  const field = data.replace("edit_field_", "");
  session.edit.field = field;

  let text = "";
  let markup: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> };

  const cancelButton = [[{ text: "❌ Cancel", callback_data: "cancel_edit" }]];
  const doneCancelButtons = [
    [{ text: "✅ Done", callback_data: "done_lyrics" }],
    [{ text: "❌ Cancel", callback_data: "cancel_edit" }],
  ];

  if (urlFields.includes(field)) {
    text = `✏️ Send new URL for: ${field}\n\n• Must start with http:// or https://\n• Type 'none' to remove it`;
    markup = { inline_keyboard: cancelButton };
    await transition(session, SessionMode.EDIT_FIELD, ctx.api, ctx.chat?.id);
  } else if (field === "lyrics") {
    text = `✏️ Send the new lyrics.\n\n• You can send multiple messages\n• Click Done when finished`;
    markup = { inline_keyboard: cancelButton };
    session.lyrics.buffer = [];
    session.lyrics.messageIds = [];
    await transition(session, SessionMode.EDIT_LYRICS, ctx.api, ctx.chat?.id);
  } else {
    text = `✏️ Send new value for: ${field}`;
    markup = { inline_keyboard: cancelButton };
    await transition(session, SessionMode.EDIT_FIELD, ctx.api, ctx.chat?.id);
  }

  const prompt = await ctx.reply(text, { reply_markup: markup as any });
  session.edit.promptId = prompt.message_id;
}

async function handleNewFieldValue(ctx: Context, session: SessionData, env: Env) {
  const field = session.edit.field;
  if (!field) {
    return;
  }

  if (field === "lyrics") {
    if (session.lyrics.locked) {
      return;
    }

    const text = ctx.message?.text;
    if (!text || text.startsWith("/")) {
      return;
    }

    session.lyrics.buffer.push(text);
    session.lyrics.messageIds.push(ctx.message!.message_id);

    if (session.edit.promptId && ctx.chat?.id) {
      await safeDelete(ctx.api as any, ctx.chat.id, session.edit.promptId);
    }

    const doneCancelButtons = [
      [{ text: "✅ Done", callback_data: "done_lyrics" }],
      [{ text: "❌ Cancel", callback_data: "cancel_edit" }],
    ];

    const prompt = await ctx.reply("✏️ Send more lyrics, or click Done when finished", {
      reply_markup: { inline_keyboard: doneCancelButtons },
    });
    session.edit.promptId = prompt.message_id;
    return;
  }

  const newValue = ctx.message?.text?.trim();
  const lastData = session.telegraph.data as any;
  if (!newValue || !lastData) {
    return;
  }

  if (ctx.chat?.id) {
    await safeDelete(ctx.api as any, ctx.chat.id, ctx.message!.message_id);
  }
  if (session.edit.promptId && ctx.chat?.id) {
    await safeDelete(ctx.api as any, ctx.chat.id, session.edit.promptId);
  }

  if (urlFields.includes(field)) {
    if (newValue.toLowerCase() === "none") {
      if (field === "cover") {
        lastData.album_cover_url = "";
      } else {
        lastData[field] = "";
      }
    } else {
      if (!isValidUrl(newValue)) {
        const msg = await ctx.reply("❌ Invalid URL format");
        return;
      }
      if (field === "cover") {
        lastData.album_cover_url = newValue;
      } else {
        lastData[field] = newValue;
      }
    }
  } else {
    if (field === "track") {
      lastData.track = newValue;
    } else if (field === "artist") {
      lastData.artist = newValue;
    } else if (field === "album") {
      lastData.album = newValue;
    } else if (field === "date") {
      lastData.release_date = newValue;
    } else if (field === "author") {
      lastData.author_name = newValue;
    }
  }

  try {
    await editSongPage(env, lastData, session.telegraph.currentLyrics ?? "");
  } catch (error) {
    console.warn("Failed to update Telegraph page for field", field, error);
    await transition(session, SessionMode.IDLE, ctx.api, ctx.chat?.id);
    resetFlow(session.edit);
    try { await ctx.reply("❌ Failed to update Telegraph page"); } catch {}
    return;
  }

  await transition(session, SessionMode.IDLE, ctx.api, ctx.chat?.id);
  resetFlow(session.edit);
  try { await ctx.reply("✅ Updated"); } catch {}
}

async function handleCancelEditCallback(ctx: Context, session: SessionData) {
  if (session.mode !== SessionMode.EDIT_FIELD && session.mode !== SessionMode.EDIT_LYRICS) {
    try { await ctx.api.answerCallbackQuery({ callback_query_id: ctx.callbackQuery?.id, text: "No active edit session", show_alert: true } as any); } catch {}
    return;
  }

  try { await ctx.answerCallbackQuery(); } catch {}
  await cancelEdit(ctx.api as any, ctx.chat?.id ?? 0, session);
  try { await ctx.editMessageText("❌ Edit cancelled"); } catch {}
}

async function handleDoneLyricsCallback(ctx: Context, session: SessionData, env: Env) {
  if (session.mode !== SessionMode.EDIT_LYRICS) {
    try { await ctx.api.answerCallbackQuery({ callback_query_id: ctx.callbackQuery?.id, text: "No active edit session", show_alert: true } as any); } catch {}
    return;
  }

  await finalizeLyrics(ctx, session, env);
}

async function handleSendToChannelCallback(ctx: Context, session: SessionData) {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("send_channel_")) {
    return;
  }

  try { await ctx.answerCallbackQuery(); } catch {}
  const channelId = data.replace("send_channel_", "");
  const audioFileId = session.audio.pendingFileId;
  const caption = session.audio.pendingCaption;
  const telegraphUrl = session.audio.pendingTelegraphUrl;

  if (!audioFileId || !caption || !telegraphUrl) {
    await ctx.editMessageText("❌ Nothing to send.");
    session.audio.sendChannelPromptId = undefined;
    return;
  }

  try {
    const member = await ctx.api.getChatMember(Number(channelId), Number(ctx.from?.id ?? 0));
    if (member.status !== "administrator" && member.status !== "creator") {
      try { await ctx.answerCallbackQuery({ text: "❌ You are not an admin in this channel.", show_alert: true }); } catch {}
      return;
    }
  } catch (error) {
    console.warn("Failed to verify admin status for channel", channelId, error);
    try { await ctx.answerCallbackQuery({ text: "❌ Can't access this channel.", show_alert: true }); } catch {}
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
    console.warn("Failed to send audio to channel", channelId, error);
    await ctx.editMessageText("❌ Failed to send to channel.");
    return;
  }

  await ctx.editMessageText("✅ Sent to channel!");
  session.audio.pendingFileId = undefined;
  session.audio.pendingCaption = undefined;
  session.audio.pendingTelegraphUrl = undefined;
  session.audio.sendChannelPromptId = undefined;
}

async function handleTrackSelectionCallback(ctx: Context, session: SessionData, env: Env) {
  try { await ctx.answerCallbackQuery(); } catch {}
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("track_")) {
    return;
  }

  const trackId = Number(data.replace("track_", ""));
  if (Number.isNaN(trackId)) {
    await ctx.editMessageText("❌ Invalid track selection.");
    return;
  }

  session.search.results = undefined;
  session.search.page = 0;

  try { await ctx.editMessageText("⏳ Fetching track info..."); } catch { return; }
  const trackData = await getTrack(trackId) as any;
  if (!trackData) {
    try { await ctx.editMessageText("❌ Failed to fetch track info. Try again later."); } catch {}
    return;
  }

  const trackName = trackData.title ?? "Unknown Track";
  const artistName = trackData.artist?.name ?? "Unknown Artist";
  const artistId = trackData.artist?.id;
  const albumName = trackData.album?.title ?? "Unknown Album";
  const albumId = trackData.album?.id;
  const albumCoverUrl = trackData.album?.cover_xl ?? trackData.album?.cover_big ?? "";

  let releaseDate = "Unknown";
  if (albumId) {
    try { await ctx.editMessageText("⏳ Fetching metadata..."); } catch {}
    const albumInfo = await getAlbum(albumId);
    if (albumInfo) {
      releaseDate = (albumInfo as any).release_date ?? "Unknown";
    }
  }

  try { await ctx.editMessageText("⏳ Fetching lyrics..."); } catch {}
  const lyrics = await getLyrics(trackName, artistName);
  const authorName = ctx.from?.first_name ?? "Unknown User";

  try { await ctx.editMessageText("⏳ Creating Telegraph page..."); } catch {}

  let telegraphResult;
  try {
    telegraphResult = await createSongTelegraph(env, {
      authorName,
      track: trackName,
      trackId,
      artist: artistName,
      artistId,
      album: albumName,
      albumId,
      albumCoverUrl,
      releaseDate,
      lyrics,
    });
  } catch (error) {
    console.warn("Failed to create Telegraph page for track", trackName, error);
    await ctx.editMessageText("❌ Failed to create Telegraph page. Try again later.");
    return;
  }

  const myVersion = captureVersion(session);
  if (isStale(session, myVersion)) {
    return;
  }

  session.telegraph.currentLyrics = lyrics;
  session.telegraph.url = telegraphResult.url;
  session.telegraph.path = telegraphResult.path;
  session.telegraph.data = telegraphResult.lastData;

  const pendingAudioFileId = session.audio.fileId;
  const hasAudio = Boolean(pendingAudioFileId);
  if (hasAudio && pendingAudioFileId) {
    const caption = await attachAudioAndPromptChannel(
      ctx.api,
      env.DB,
      ctx.chat!.id,
      String(ctx.from?.id ?? ""),
      session,
      pendingAudioFileId,
      telegraphResult.url,
      trackName,
      artistName,
    );

    if (!caption) {
      await ctx.editMessageText("❌ Failed to attach audio. Try again.");
      session.audio.fileId = undefined;
      return;
    }

    if (ctx.chat?.id && session.audio.messageId) {
      await safeDelete(ctx.api as any, ctx.chat.id, session.audio.messageId);
    }

    clearAudioState(session);
    session.telegraph.url = undefined;
  }

  const status = hasAudio ? "Telegraph Created & Audio Attached" : "Telegraph Created";
  const extra = hasAudio ? "" : "Send a music file to attach the Lyrics button to it.\n\n";

  const replyText = `✅ <b>${status}</b>\n\n<blockquote>🎵 <b>${(trackName)}</b>\n👤 ${(artistName)}\n💽 ${(albumName)}\n📅 ${(releaseDate)}</blockquote>\n\n${extra}👇 Edit options below — or tap to open the page:\n<a href="${telegraphResult.url}">📖 Open Telegraph Page</a>`;

  try {
    await ctx.editMessageText(replyText, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildEditMenu() },
    });
  } catch (error) {
    console.warn("Failed to edit message with final result", error);
  }
}

function buildEditMenu() {
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
  ];
}
