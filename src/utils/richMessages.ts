import { Api, RawApi } from "grammy";
import type { InlineKeyboardMarkup, InputRichMessage } from "@grammyjs/types";
import { formatDuration } from "./telegram";
import { isValidImageUrl } from "./urlValidation";
import { warn } from "./logger";

// Rich-message helpers for the track pipeline (src/handlers/callbacks/search.ts).
//
// Private chats stream progress as rich-message drafts (sendRichMessageDraft):
// each state update animates a diff of a small checklist + <tg-thinking> row,
// the same visual language as Telegram's streamed-AI answers. Final results
// are persisted with sendRichMessage — an album-cover card with a Telegraph
// button. Everything degrades gracefully: draft failures fall back to plain
// text edits, rich-send failures fall back to the caller's HTML message.

// Escape raw track/artist/album text for Rich HTML content. Same rules as
// regular HTML: & < > must be entities; " is escaped for attribute values.
export function escapeRichHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function countLyricLines(lyrics: string): number {
  return lyrics
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.trim()).length;
}

export type TrackStage = "info" | "metadata" | "lyrics" | "telegraph";

export interface TrackProgressState {
  stage: TrackStage;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  releaseDate?: string;
  // Rendered as the Lyrics checklist note, e.g. "42 lines (cached)".
  lyricsNote?: string;
}

const STAGE_ORDER: TrackStage[] = ["info", "metadata", "lyrics", "telegraph"];

const STAGE_LABELS: Record<TrackStage, string> = {
  info: "Track info",
  metadata: "Album metadata",
  lyrics: "Lyrics",
  telegraph: "Telegraph page",
};

const STAGE_ACTION: Record<TrackStage, string> = {
  info: "Fetching track info…",
  metadata: "Fetching album metadata…",
  lyrics: "Fetching lyrics…",
  telegraph: "Creating Telegraph page…",
};

// Plain-text states for non-draft chats (groups), matching the old flow.
const PLAIN_STAGE_TEXT: Record<TrackStage, string> = {
  info: "⏳ Fetching track info...",
  metadata: "⏳ Fetching metadata...",
  lyrics: "⏳ Fetching lyrics...",
  telegraph: "⏳ Creating Telegraph page...",
};

// The streamed checklist: stages before the current one are checked off,
// the current one runs under a <tg-thinking> placeholder. Draft-only API —
// <tg-thinking> must never appear in a persisted sendRichMessage.
export function renderTrackProgressHtml(state: TrackProgressState): string {
  const parts: string[] = [];

  if (state.trackName) {
    parts.push(`<h3>🎵 ${escapeRichHtml(state.trackName)}</h3>`);
  }

  const subBits: string[] = [];
  if (state.artistName) subBits.push(`<b>${escapeRichHtml(state.artistName)}</b>`);
  if (state.albumName) subBits.push(`<i>${escapeRichHtml(state.albumName)}</i>`);
  if (state.releaseDate && state.releaseDate !== "Unknown") {
    subBits.push(escapeRichHtml(state.releaseDate));
  }
  if (subBits.length) {
    parts.push(`<p>${subBits.join(" · ")}</p>`);
  }

  const currentIdx = STAGE_ORDER.indexOf(state.stage);
  const items = STAGE_ORDER.map((stage, i) => {
    let label = STAGE_LABELS[stage];
    if (stage === "lyrics" && state.lyricsNote) {
      label += ` — ${state.lyricsNote}`;
    }
    const checked = i < currentIdx ? " checked" : "";
    return `<li><input type="checkbox"${checked}>${escapeRichHtml(label)}</li>`;
  });
  parts.push(`<ul>${items.join("")}</ul>`);

  parts.push(`<tg-thinking>${STAGE_ACTION[state.stage]}</tg-thinking>`);

  return parts.join("\n");
}

// Drives progress updates for one track request. In private chats every
// update goes to the same draft_id so Telegram animates the transitions;
// elsewhere (or once drafts fail) the original results message is edited
// with plain text, exactly like the pre-rich flow.
export class TrackProgressReporter {
  private state: TrackProgressState = { stage: "info" };
  private draftBroken = false;
  private dead = false;
  private readonly draftId: number;

  // True once every visible channel for this request is gone (results
  // message deleted and drafts failing). Mirrors the old first-edit
  // `catch { return; }` liveness gate in handleTrackSelectionCallback.
  get isDead(): boolean {
    return this.dead;
  }

  constructor(
    private readonly api: Api<RawApi>,
    private readonly chatId: number,
    private readonly fallbackMessageId: number | undefined,
    private readonly useDrafts: boolean,
  ) {
    // Derive the draft id from the results message: stable across all states
    // of one request, distinct between concurrent requests in the same chat.
    this.draftId = fallbackMessageId ?? 1;
  }

  async update(next: Partial<TrackProgressState>): Promise<void> {
    if (this.dead) {
      return;
    }
    this.state = { ...this.state, ...next };

    if (this.useDrafts && !this.draftBroken) {
      try {
        await this.api.sendRichMessageDraft(this.chatId, this.draftId, {
          html: renderTrackProgressHtml(this.state),
          skip_entity_detection: true,
        });
        return;
      } catch (error) {
        this.draftBroken = true;
        warn("rich draft update failed, falling back to plain edits", error);
      }
    }

    if (this.fallbackMessageId !== undefined) {
      try {
        await this.api.editMessageText(
          this.chatId,
          this.fallbackMessageId,
          PLAIN_STAGE_TEXT[this.state.stage],
        );
      } catch {
        this.dead = true;
      }
    } else if (!this.useDrafts) {
      // Nothing to edit and no draft channel — the request is invisible.
      this.dead = true;
    }
  }

  // Terminal failure: put the error on the original message in both modes
  // (a live draft simply expires after its 30s preview window).
  async fail(text: string): Promise<void> {
    if (this.dead) {
      return;
    }
    if (this.fallbackMessageId !== undefined) {
      try {
        await this.api.editMessageText(this.chatId, this.fallbackMessageId, text);
      } catch {
        // ignore
      }
    }
  }
}

// The persisted result card. The album cover takes the role of the old
// link-preview card, so it follows the same user preference (includeCover).
export function buildTrackResultRichHtml(options: {
  trackName: string;
  artistName: string;
  albumName: string;
  releaseDate: string;
  durationSeconds?: number;
  telegraphUrl: string;
  lyricLineCount: number;
  authorName: string;
  coverUrl: string;
  includeCover: boolean;
  hasAudio: boolean;
}): string {
  const parts: string[] = [];

  if (options.includeCover && isValidImageUrl(options.coverUrl)) {
    parts.push(`<img src="${escapeRichHtml(options.coverUrl)}"/>`);
  }

  parts.push(`<h2>🎵 ${escapeRichHtml(options.trackName)}</h2>`);

  const quoteBits: string[] = [`<b>${escapeRichHtml(options.artistName)}</b>`];
  if (options.albumName && options.albumName !== "Unknown Album") {
    quoteBits.push(`<i>${escapeRichHtml(options.albumName)}</i>`);
  }
  const metaBits: string[] = [];
  if (options.releaseDate && options.releaseDate !== "Unknown") {
    metaBits.push(`📅 ${escapeRichHtml(options.releaseDate)}`);
  }
  if (options.durationSeconds && options.durationSeconds > 0) {
    metaBits.push(`⏱ ${formatDuration(options.durationSeconds)}`);
  }
  const quoteLines = [quoteBits.join(" — ")];
  if (metaBits.length) {
    quoteLines.push(metaBits.join(" · "));
  }
  quoteLines.push(`<cite>Created by ${escapeRichHtml(options.authorName)}</cite>`);
  parts.push(`<blockquote>${quoteLines.join("<br>")}</blockquote>`);

  if (options.lyricLineCount > 0) {
    parts.push(`<p>✅ Lyrics attached — <b>${options.lyricLineCount}</b> lines ready.</p>`);
  } else {
    parts.push(`<p>⚠️ No lyrics found for this track.</p>`);
  }

  if (!options.hasAudio) {
    parts.push(`<footer>🎧 Send a music file to attach the Lyrics button to it.</footer>`);
  }

  parts.push(
    `<tg-button-row align="center">` +
      `<tg-button type="url" style="primary" url="${escapeRichHtml(options.telegraphUrl)}">` +
      `📖 Open Telegraph Page` +
      `</tg-button>` +
      `</tg-button-row>`,
  );

  return parts.join("\n");
}

// Persist the rich result card, retrying once without the message effect
// (effects are private-chat only). Returns false so the caller can fall back
// to its plain-HTML message path.
export async function sendRichTrackResult(
  api: Api<RawApi>,
  chatId: number,
  html: string,
  markup: InlineKeyboardMarkup,
  effectId?: string,
): Promise<boolean> {
  const rich: InputRichMessage = { html, skip_entity_detection: true };
  if (effectId) {
    try {
      await api.sendRichMessage(chatId, rich, {
        reply_markup: markup,
        message_effect_id: effectId,
      });
      return true;
    } catch (error) {
      warn("rich result with effect failed, retrying without", error);
    }
  }
  try {
    await api.sendRichMessage(chatId, rich, { reply_markup: markup });
    return true;
  } catch (error) {
    warn("sendRichMessage failed, caller should fall back to HTML", error);
    return false;
  }
}
