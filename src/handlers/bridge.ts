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
import { getSetting, setSetting, SETTING_BRIDGE_LAST_AUDIO } from "../db/settings";
import { AUTOFETCH_REQUEST_TTL_SECONDS } from "../config";

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
    await notifyRequester(env, row, `❌ Couldn't deliver the audio. Grab it from deezload: ${deezloadLink(row)}`);
    return;
  }

  await setRequestStatus(env.DB, token, "delivered");
  log("bridge: delivered", JSON.stringify({ token, chatId: row.chat_id, trackId: row.track_id }));
}

async function reportFailure(env: Env, token: string): Promise<void> {
  const row = await lookupPendingRow(env, token);
  if (!row) return;

  await setRequestStatus(env.DB, token, "failed");
  await notifyRequester(
    env,
    row,
    `❌ Couldn't fetch this track automatically. Grab it from deezload: ${deezloadLink(row)}`,
  );
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
