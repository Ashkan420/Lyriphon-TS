import { Api, RawApi } from "grammy";
import type { InlineKeyboardMarkup, InputRichMessage } from "@grammyjs/types";
import { formatDuration } from "./telegram";
import { isValidImageUrl } from "./urlValidation";
import { warn } from "./logger";

// Rich-message helpers for the track pipeline (src/handlers/callbacks/search.ts).
//
// The whole pipeline lives in ONE persistent rich message: sendRichMessage
// posts the initial checklist state, then every state transition is an
// editMessageText with a new rich_message (Bot API 10.3), so the progress
// bubble extends into the final Telegraph card. Everything degrades
// gracefully: rich failures fall back to plain text edits of the original
// results message, and a failed finalize lets the caller send its plain-HTML
// message instead.

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

// Plain-text states for the non-rich fallback, matching the pre-rich flow.
const PLAIN_STAGE_TEXT: Record<TrackStage, string> = {
  info: "⏳ Fetching track info...",
  metadata: "⏳ Fetching metadata...",
  lyrics: "⏳ Fetching lyrics...",
  telegraph: "⏳ Creating Telegraph page...",
};

// The persisted progress view: stages before the current one are checked off,
// the current one runs under a status line. <tg-thinking> is drafts-only and
// rejected in persisted messages, so the live indicator is a text line.
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

  parts.push(`<p><i>⏳ ${STAGE_ACTION[state.stage]}</i></p>`);

  return parts.join("\n");
}

// Drives progress for one track request. Owns a single persistent rich
// message from selection to the final Telegraph card; if the rich API is
// unavailable it degrades to plain text edits of the original results
// message, exactly like the pre-rich flow.
export class TrackProgressReporter {
  private state: TrackProgressState = { stage: "info" };
  private richMode = false;
  private richBroken = false;
  private dead = false;
  private progressMessageId: number | undefined;

  // True once every visible channel for this request is gone. Mirrors the
  // old first-edit `catch { return; }` liveness gate in
  // handleTrackSelectionCallback.
  get isDead(): boolean {
    return this.dead;
  }

  // The message currently carrying progress — the rich bubble once started,
  // otherwise the original results message being edited in place.
  get activeMessageId(): number | undefined {
    return this.progressMessageId ?? this.fallbackMessageId;
  }

  constructor(
    private readonly api: Api<RawApi>,
    private readonly chatId: number,
    private readonly fallbackMessageId: number | undefined,
  ) {}

  // Post the initial progress message (rich) or start editing the results
  // message (plain fallback). The results message is consumed either way:
  // in rich mode it is deleted, in plain mode it becomes the progress view.
  async start(): Promise<void> {
    if (this.dead) {
      return;
    }
    try {
      const msg = await this.api.sendRichMessage(this.chatId, {
        html: renderTrackProgressHtml(this.state),
        skip_entity_detection: true,
      });
      this.richMode = true;
      this.progressMessageId = msg.message_id;
      if (this.fallbackMessageId !== undefined) {
        try {
          await this.api.deleteMessage(this.chatId, this.fallbackMessageId);
        } catch {
          // leftover results message; harmless
        }
      }
      return;
    } catch (error) {
      warn("rich progress send failed, falling back to plain edits", error);
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
    } else {
      // Nothing to edit and no rich channel — the request is invisible.
      this.dead = true;
    }
  }

  async update(next: Partial<TrackProgressState>): Promise<void> {
    if (this.dead) {
      return;
    }
    const prevState = this.state;
    this.state = { ...this.state, ...next };

    // Identical content would be rejected by the API ("message is not
    // modified") and kill rich mode — skip when nothing changed.
    if (JSON.stringify(prevState) === JSON.stringify(this.state)) {
      return;
    }

    const html = renderTrackProgressHtml(this.state);

    if (this.richMode && this.progressMessageId !== undefined && !this.richBroken) {
      try {
        await this.api.editMessageText(this.chatId, this.progressMessageId, {
          html,
          skip_entity_detection: true,
        } satisfies InputRichMessage);
        return;
      } catch (error) {
        this.richBroken = true;
        warn("rich progress edit failed, falling back to plain text", error);
      }
    }

    const targetId = this.richMode ? this.progressMessageId : this.fallbackMessageId;
    if (targetId === undefined) {
      this.dead = true;
      return;
    }
    try {
      await this.api.editMessageText(this.chatId, targetId, PLAIN_STAGE_TEXT[this.state.stage]);
    } catch {
      this.dead = true;
    }
  }

  // Terminal failure: put the error on the active message.
  async fail(text: string): Promise<void> {
    if (this.dead) {
      return;
    }
    const targetId = this.activeMessageId;
    if (targetId === undefined) {
      return;
    }
    try {
      await this.api.editMessageText(this.chatId, targetId, text);
    } catch {
      // ignore
    }
  }

  // Persist the result by editing the progress message into the final
  // plain-HTML card — the last state IS the result. The Telegraph link rides
  // as a hyperlink in the text and the cover comes from the native link
  // preview, so later Telegraph edits (cover, lyrics) are reflected by
  // Telegram's own preview instead of a baked-in image. Works in fallback
  // mode too (edits the original results message in place). Returns false
  // when no edit target exists or the edit fails, so the caller can send its
  // plain-HTML message instead.
  async finalizeText(text: string, markup: InlineKeyboardMarkup, disablePreview: boolean): Promise<boolean> {
    const targetId = this.progressMessageId ?? this.fallbackMessageId;
    if (this.dead || targetId === undefined) {
      return false;
    }
    try {
      await this.api.editMessageText(this.chatId, targetId, text, {
        parse_mode: "HTML",
        reply_markup: markup,
        link_preview_options: { is_disabled: disablePreview },
      });
      return true;
    } catch (error) {
      warn("finalize edit failed, caller should fall back to HTML", error);
      return false;
    }
  }
}

// Experimental styled rich button. Older Telegram clients don't render it at
// all, so it is opt-in via the "Fancy lyrics buttons" setting (default off);
// the default path is a regular inline-keyboard URL button.
function telegraphButtonRowHtml(url: string, label: string): string {
  return (
    `<tg-button-row align="center">` +
      `<tg-button type="url" style="primary" url="${escapeRichHtml(url)}">${label}</tg-button>` +
    `</tg-button-row>`
  );
}

// The persisted result: old-style HTML card. The Telegraph link is a plain
// hyperlink and the album cover comes from Telegram's native link preview,
// so edits to the page (cover, lyrics) are reflected by the preview instead
// of a baked-in image, and the edit-menu keyboard stays self-contained.
export function buildTrackResultHtml(options: {
  trackName: string;
  artistName: string;
  albumName: string;
  releaseDate: string;
  telegraphUrl: string;
  authorName: string;
  hasAudio: boolean;
}): string {
  const status = options.hasAudio ? "Telegraph Created & Audio Attached" : "Telegraph Created";
  const esc = escapeRichHtml;

  let body =
    `✅ <b>${status}</b>\n\n` +
    `<blockquote>🎵 <b>${esc(options.trackName)}</b>\n` +
    `👤 ${esc(options.artistName)}\n` +
    `💽 ${esc(options.albumName)}\n` +
    `📅 ${esc(options.releaseDate)}</blockquote>\n\n`;

  if (!options.hasAudio) {
    body += "Send a music file to attach the Lyrics button to it.\n\n";
  }

  body += `👇 Edit options below — or tap to open the page:\n<a href="${esc(options.telegraphUrl)}">📖 Open Telegraph Page</a>`;

  return body;
}

// One-line rich message with just the styled Telegraph button, sent under a
// music file when the "Fancy lyrics buttons" setting is on (the audio
// message itself can't carry tg-buttons — captions have no rich content).
export async function sendRichTelegraphButton(
  api: Api<RawApi>,
  chatId: number,
  url: string,
): Promise<boolean> {
  try {
    await api.sendRichMessage(chatId, {
      html: telegraphButtonRowHtml(url, "📖 Lyrics"),
      skip_entity_detection: true,
    });
    return true;
  } catch (error) {
    warn("rich telegraph button send failed", error);
    return false;
  }
}
