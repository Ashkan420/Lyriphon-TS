// Deezload auto-fetch bridge: delivery endpoint for the Telethon relay.
//
// The bridge chat (BRIDGE_CHAT_ID — a private DM with the Telethon account)
// is intercepted in src/index.ts BEFORE per-user DO routing, so this handler
// runs session-free: the audio_requests D1 row is the only state it needs.
// That matters because a file from the Telethon account would otherwise enter
// the account's own (unrelated) session DO.
//
// Auth = chat id + single-use req_token. A file arriving from any other chat
// is ignored here and flows through normal routing; a wrong/expired token
// finds no pending row.
//
// Never throws — a rejection here would surface as a 500 and make Telegram
// redeliver the same update forever (AGENTS.md rule #1).

import { Api, RawApi } from "grammy";
import { Env } from "../env";
import { DEEZLOAD_BOT } from "../config";
import { warn, log } from "../utils/logger";
import { escapeMd } from "../utils/escapeMd";
import { buildAudioCaption } from "../utils/telegram";
import {
  AudioRequestRow,
  getRequestByToken,
  isRequestExpired,
  setRequestStatus,
  expireStalePending,
} from "../db/audioRequests";
import { getSetting, setSetting, SETTING_BRIDGE_LAST_AUDIO, SETTING_PENDING_SEND_PREFIX } from "../db/settings";
import { AUTOFETCH_REQUEST_TTL_SECONDS } from "../config";
import { setTrackFileId } from "../db/tracks";
import { getUserChannels } from "../db/channels";

const PENDING_SEND_PREFIX = SETTING_PENDING_SEND_PREFIX;

// Pairing cache: the DO forwards the audio first, then sends the lyq:file tag
// as a separate message. reply_to_message proved unreliable (Telegram dropped
// it on MTProto-sent tags), so the tag consumes the most recently forwarded
// audio. Safe under the DO's serial job execution — one audio/tag pair in
// flight at a time.
type LastBridgeAudio = { fileId: string; ts: number };

async function rememberBridgeAudio(env: Env, fileId: string): Promise<void> {
  try {
    await setSetting(env.DB, SETTING_BRIDGE_LAST_AUDIO, JSON.stringify({ fileId, ts: Date.now() } satisfies LastBridgeAudio));
  } catch (error) {
    warn("bridge: failed to cache last audio", error);
  }
}

async function takeStashedAudio(env: Env): Promise<string | undefined> {
  try {
    const raw = await getSetting(env.DB, SETTING_BRIDGE_LAST_AUDIO);
    if (!raw) return undefined;
    // Consume on read (single use).
    await setSetting(env.DB, SETTING_BRIDGE_LAST_AUDIO, "");
    const cached = JSON.parse(raw) as LastBridgeAudio;
    if (cached.fileId && Date.now() - cached.ts < AUTOFETCH_REQUEST_TTL_SECONDS * 1000) {
      return cached.fileId;
    }
    return undefined;
  } catch (error) {
    warn("bridge: failed to read last audio cache", error);
    return undefined;
  }
}

export type BridgeMessage = { kind: "file"; token: string } | { kind: "fail"; token: string };

// Matches the two control messages the Telethon script sends back:
//   lyq:file req=<token>  (caption on the audio/document)
//   lyq:fail req=<token> [reason]
// Extra trailing text (the fail reason) is tolerated.
export function parseBridgeMessage(text: string | undefined | null): BridgeMessage | null {
  if (!text) return null;
  const match = text.match(/^lyq:(file|fail) req=(\S+)(?:\s|$)/);
  if (!match) return null;
  return { kind: match[1] as "file" | "fail", token: match[2] };
}

export function isBridgeChat(env: Env, update: any): boolean {
  if (!env.BRIDGE_CHAT_ID) return false;
  const chat = update?.message?.chat;
  if (!chat || chat.type !== "private") return false;
  return String(chat.id) === env.BRIDGE_CHAT_ID;
}

export async function handleBridgeUpdate(env: Env, update: any): Promise<void> {
  try {
    const message = update.message;
    if (!message) return;

    const audio = message.audio ?? message.document;
    const parsed = parseBridgeMessage(message.caption ?? message.text);

    // Bare forward from the DO (no caption): stash it for the lyq:file tag
    // that follows — reply_to_message proved unreliable on MTProto tags.
    if (audio && !parsed) {
      await rememberBridgeAudio(env, audio.file_id);
      log("bridge: forwarded audio stashed", audio.file_id);
      return;
    }

    // Direct caption path: audio carrying the token in its own caption.
    if (audio && parsed?.kind === "file") {
      await deliverFile(env, audio, parsed.token);
      return;
    }

    // Text tag path (BridgeDO): `lyq:file req=<token>` after the forward.
    // The file_id comes from reply_to_message when present, else from the
    // stashed forward.
    if (!audio && parsed?.kind === "file") {
      const replyAudio = message.reply_to_message?.audio ?? message.reply_to_message?.document;
      let fileId = replyAudio?.file_id;
      if (!fileId) {
        fileId = await takeStashedAudio(env);
      }
      if (fileId) {
        await deliverFile(env, { file_id: fileId }, parsed.token);
        return;
      }
      warn("bridge: file tag with neither reply media nor stashed audio", parsed.token);
      return;
    }

    if (parsed?.kind === "fail") {
      await reportFailure(env, parsed.token);
      return;
    }

    if (parsed || audio) {
      log("bridge: unhandled message shape", JSON.stringify({
        hasAudio: Boolean(audio),
        hasCaption: Boolean(message.caption),
        hasText: Boolean(message.text),
      }));
    }
  } catch (error) {
    warn("bridge: update handling failed", error);
  }
}

async function deliverFile(env: Env, audio: any, token: string): Promise<void> {
  const row = await lookupPendingRow(env, token);
  if (!row) return;

  const trackName = row.track_title ?? "Unknown Track";
  const artistName = row.artist_name ?? "Unknown Artist";
  const caption = row.telegraph_url
    ? buildAudioCaption(trackName, artistName, row.telegraph_url)
    : `>\`${escapeMd(trackName)} — ${escapeMd(artistName)}\``;

  const api = new Api(env.BOT_TOKEN) as Api<RawApi>;

  // Inline delivery: the sent inline message IS the destination — morph it
  // into the audio (chat_id is 0 for these rows; no DM copy, no channel
  // prompt, no pending-send stash).
  if (row.inline_message_id) {
    const lyricsKeyboard = row.telegraph_url
      ? { inline_keyboard: [[{ text: "Lyrics", url: row.telegraph_url }]] }
      : undefined;
    try {
      await api.editMessageMediaInline(row.inline_message_id, {
        type: "audio",
        media: audio.file_id,
        caption,
        parse_mode: "MarkdownV2",
      }, lyricsKeyboard ? { reply_markup: lyricsKeyboard } : undefined);
    } catch (error) {
      warn("bridge: inline audio morph failed", { token, inlineMessageId: row.inline_message_id }, error);
      await setRequestStatus(env.DB, token, "failed");
      // The message may be gone (deleted / older than editable) but the file
      // itself was fetched fine — store it so the next pick reuses it.
      try {
        await setTrackFileId(env.DB, row.track_id, audio.file_id);
      } catch (storeError) {
        warn("bridge: failed to store track file_id", storeError);
      }
      return;
    }
    await setRequestStatus(env.DB, token, "delivered");
    // Canonical file_id for the tracks store — enables reuse.
    try {
      await setTrackFileId(env.DB, row.track_id, audio.file_id);
    } catch (error) {
      warn("bridge: failed to store track file_id", error);
    }
    log("bridge: delivered inline", JSON.stringify({ token, trackId: row.track_id }));
    return;
  }

  try {
    await api.sendAudio(row.chat_id, audio.file_id, {
      caption,
      parse_mode: "MarkdownV2",
      reply_markup: row.telegraph_url
        ? { inline_keyboard: [[{ text: "Lyrics", url: row.telegraph_url }]] }
        : undefined,
    });
  } catch (error) {
    warn("bridge: sendAudio to requester failed", { chatId: row.chat_id, token }, error);
    await setRequestStatus(env.DB, token, "failed");
    await deleteQueuedMsg(env, row);
    await notifyRequester(env, row, `❌ Couldn't deliver the audio. Grab it from deezload: ${deezloadLink(row)}`);
    return;
  }

  await setRequestStatus(env.DB, token, "delivered");
  // Canonical file_id for the tracks store — enables reuse + Replace Audio.
  try {
    await setTrackFileId(env.DB, row.track_id, audio.file_id);
  } catch (error) {
    warn("bridge: failed to store track file_id", error);
  }
  await deleteQueuedMsg(env, row);
  await stashPendingSend(env, row, audio.file_id, caption);
  await promptChannelSend(env, row);
  log("bridge: delivered", JSON.stringify({ token, chatId: row.chat_id, trackId: row.track_id }));
}

async function reportFailure(env: Env, token: string): Promise<void> {
  const row = await lookupPendingRow(env, token);
  if (!row) return;

  await setRequestStatus(env.DB, token, "failed");
  await deleteQueuedMsg(env, row);

  // Inline rows have no requester chat — surface the failure on the message.
  if (row.inline_message_id) {
    try {
      const api = new Api(env.BOT_TOKEN) as Api<RawApi>;
      const text = `❌ Couldn't fetch the music file. Grab it from deezload: ${deezloadLink(row)}`;
      await api.editMessageTextInline(row.inline_message_id, text, {
        reply_markup: row.telegraph_url
          ? { inline_keyboard: [[{ text: "Lyrics", url: row.telegraph_url }]] }
          : undefined,
      });
    } catch (error) {
      warn("bridge: inline failure edit failed", { token }, error);
    }
    return;
  }

  await notifyRequester(
    env,
    row,
    `❌ Couldn't fetch this track automatically. Grab it from deezload: ${deezloadLink(row)}`,
  );
}

// The 🎧 queued notice self-destructs once the job reaches a terminal state.
async function deleteQueuedMsg(env: Env, row: AudioRequestRow): Promise<void> {
  try {
    // Fresh read, not the caller's snapshot: the notice is persisted by the
    // track pipeline after enqueue, so it can land while delivery is in
    // flight — a stale id here would leave the notice behind forever.
    const fresh = await getRequestByToken(env.DB, row.req_token);
    if (!fresh?.queued_msg_id) return;
    const api = new Api(env.BOT_TOKEN) as Api<RawApi>;
    await api.deleteMessage(fresh.chat_id, fresh.queued_msg_id);
  } catch (error) {
    warn("bridge: failed to delete queued notice", error);
  }
}

// Session-free pending-send stash: the requester's SessionDO never learns
// about bridge deliveries, but send_channel_ clicks need the audio context.
// handleSendToChannelCallback falls back to this when session fields are
// empty (bridge/README parity: one pending send per user, 1 h freshness).
// `prompts` tracks the "Send to which channel?" prompts this stash sent so a
// later search can delete them — bridge prompts have no session, so without
// this they would linger in the DM forever. Array (capped) because
// back-to-back deliveries overwrite the stash; a single field would orphan
// all but the newest prompt.
type PendingSendPrompt = { chatId: number; messageId: number };
type PendingSend = { fileId: string; caption: string; telegraphUrl: string | null; prompts?: PendingSendPrompt[]; ts: number };

const PENDING_SEND_MAX_PROMPTS = 5;
const PENDING_SEND_FRESH_MS = 3600_000;

function parsePendingSend(raw: string | null): PendingSend | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingSend;
    if (!parsed.fileId || !parsed.caption) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function stashPendingSend(env: Env, row: AudioRequestRow, fileId: string, caption: string): Promise<void> {
  try {
    // Carry forward any prompts tracked by an earlier stash — the audio
    // context is overwritten, but its channel prompts still need cleanup.
    const previous = parsePendingSend(await getSetting(env.DB, `${PENDING_SEND_PREFIX}${row.user_id}`));
    const prompts = (previous?.prompts ?? []).slice(-PENDING_SEND_MAX_PROMPTS);
    await setSetting(
      env.DB,
      `${PENDING_SEND_PREFIX}${row.user_id}`,
      JSON.stringify({ fileId, caption, telegraphUrl: row.telegraph_url, prompts, ts: Date.now() } satisfies PendingSend),
    );
  } catch (error) {
    warn("bridge: failed to stash pending send", error);
  }
}

export async function takePendingSend(env: Env, userId: string): Promise<PendingSend | null> {
  try {
    const key = `${PENDING_SEND_PREFIX}${userId}`;
    const raw = await getSetting(env.DB, key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingSend;
    if (!parsed.fileId || !parsed.caption || Date.now() - parsed.ts > PENDING_SEND_FRESH_MS) {
      await setSetting(env.DB, key, "");
      return null;
    }
    return parsed;
  } catch (error) {
    warn("bridge: failed to read pending send", error);
    return null;
  }
}

// Record a channel prompt so clearPendingSendPrompts can delete it later.
// Read-modify-write; a no-op when the stash is gone (a send_channel_ click
// between prompt send and this write already wiped it — its ✅ edit handled
// that prompt). Failures never break delivery.
async function trackPendingSendPrompt(env: Env, userId: string, prompt: PendingSendPrompt): Promise<void> {
  try {
    const key = `${PENDING_SEND_PREFIX}${userId}`;
    const stash = parsePendingSend(await getSetting(env.DB, key));
    if (!stash) return;
    const prompts = [...(stash.prompts ?? []), prompt].slice(-PENDING_SEND_MAX_PROMPTS);
    await setSetting(env.DB, key, JSON.stringify({ ...stash, prompts } satisfies PendingSend));
  } catch (error) {
    warn("bridge: failed to track channel prompt", error);
  }
}

// Delete channel prompts this user's bridge deliveries left behind. Called
// when a new search starts — the exact moment the old prompt becomes stale.
// Fresh stash keeps its audio context (prompts emptied); expired stash is
// wiped whole (same invalidation as takePendingSend — don't revive it).
export async function clearPendingSendPrompts(bot: Api<RawApi>, env: Env, userId: string): Promise<void> {
  try {
    const key = `${PENDING_SEND_PREFIX}${userId}`;
    const raw = await getSetting(env.DB, key);
    if (!raw) return;
    const stash = JSON.parse(raw) as PendingSend;
    const prompts = stash.prompts ?? [];
    for (const p of prompts) {
      try {
        await bot.deleteMessage(p.chatId, p.messageId);
      } catch {
        // already deleted / stale — nothing to clean up
      }
    }
    if (!prompts.length) return;
    if (!stash.fileId || !stash.caption || Date.now() - stash.ts > PENDING_SEND_FRESH_MS) {
      await setSetting(env.DB, key, "");
    } else {
      await setSetting(env.DB, key, JSON.stringify({ ...stash, prompts: [] } satisfies PendingSend));
    }
  } catch (error) {
    warn("bridge: failed to clear channel prompts", error);
  }
}

export async function clearPendingSend(env: Env, userId: string): Promise<void> {
  try {
    await setSetting(env.DB, `${PENDING_SEND_PREFIX}${userId}`, "");
  } catch (error) {
    warn("bridge: failed to clear pending send", error);
  }
}

// Mirror of attachAudioAndPromptChannel's prompt, for session-free delivery.
// The prompt id is tracked in the pending-send stash (session fields are
// unreachable here) so a later search can delete a stale prompt.
async function promptChannelSend(env: Env, row: AudioRequestRow): Promise<void> {
  try {
    const channels = await getUserChannels(env.DB, row.user_id);
    if (!channels.length) return;
    const api = new Api(env.BOT_TOKEN) as Api<RawApi>;
    const channelButtons = channels.map((ch) => [
      { text: ch.title ?? ch.channel_id, callback_data: `send_channel_${ch.channel_id}` },
    ]);
    const prompt = await api.sendMessage(row.chat_id, "Send to which channel?", {
      reply_markup: { inline_keyboard: channelButtons },
    });
    await trackPendingSendPrompt(env, row.user_id, { chatId: row.chat_id, messageId: prompt.message_id });
  } catch (error) {
    warn("bridge: failed to prompt channel send", error);
  }
}

async function lookupPendingRow(env: Env, token: string): Promise<AudioRequestRow | null> {
  await expireStalePending(env.DB);
  const row = await getRequestByToken(env.DB, token);
  if (!row || row.status !== "pending" || isRequestExpired(row)) {
    warn("bridge: no pending request for token", token, JSON.stringify({
      found: Boolean(row),
      status: row?.status ?? null,
    }));
    return null;
  }
  return row;
}

function deezloadLink(row: AudioRequestRow): string {
  return `${DEEZLOAD_BOT}deezerttrack${row.track_id}`;
}

async function notifyRequester(env: Env, row: AudioRequestRow, text: string): Promise<void> {
  try {
    const api = new Api(env.BOT_TOKEN) as Api<RawApi>;
    await api.sendMessage(row.chat_id, text);
  } catch (error) {
    warn("bridge: failed to notify requester", { chatId: row.chat_id }, error);
  }
}
