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

// Inline variant of the result card: the DM card's hints ("edit options
// below", "send a music file") don't apply to a sent inline message, so the
// inline path renders this compact form instead. No edit menu — the DM edit
// menus operate on session state the inline flow deliberately doesn't touch.
export function buildInlineResultHtml(options: {
  trackName: string;
  artistName: string;
  albumName: string;
  releaseDate: string;
  telegraphUrl: string;
}): string {
  const esc = escapeRichHtml;
  return (
    `✅ <b>Telegraph Created</b>\n\n` +
    `<blockquote>🎵 <b>${esc(options.trackName)}</b>\n` +
    `👤 ${esc(options.artistName)}\n` +
    `💽 ${esc(options.albumName)}\n` +
    `📅 ${esc(options.releaseDate)}</blockquote>\n\n` +
    `<a href="${esc(options.telegraphUrl)}">📖 Open Lyrics Page</a>`
  );
}

// Inline message progress driver — session-free sibling of
// TrackProgressReporter for the inline pipeline: the target is a sent inline
// message (no chat), driven entirely through the *Inline edit methods by
// inline_message_id. Same checklist rendering and rich→plain degradation as
// the DM reporter.
export class InlineTrackProgress {
  private state: TrackProgressState = { stage: "info" };
  private richBroken = false;
  private dead = false;

  get isDead(): boolean {
    return this.dead;
  }

  constructor(
    private readonly api: Api<RawApi>,
    private readonly inlineMessageId: string,
  ) {}

  // Render the initial checklist onto the inline message.
  async start(): Promise<void> {
    await this.pushState();
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
    await this.pushState();
  }

  // Terminal failure: put the error on the inline message.
  async fail(text: string): Promise<void> {
    if (this.dead) {
      return;
    }
    try {
      await this.api.editMessageTextInline(this.inlineMessageId, text);
    } catch (error) {
      warn("inline fail edit failed", error);
      this.dead = true;
    }
  }

  // Persist the result by editing the checklist into the final compact card.
  // Returns false when the edit fails, so the caller can just log.
  async finalizeText(text: string, markup: InlineKeyboardMarkup): Promise<boolean> {
    if (this.dead) {
      return false;
    }
    try {
      await this.api.editMessageTextInline(this.inlineMessageId, text, {
        parse_mode: "HTML",
        reply_markup: markup,
      });
      return true;
    } catch (error) {
      warn("inline finalize edit failed", error);
      return false;
    }
  }

  private async pushState(): Promise<void> {
    if (this.dead) {
      return;
    }
    // Rich first, unless a previous rich edit failed (then plain only).
    if (!this.richBroken) {
      try {
        await this.api.editMessageTextInline(this.inlineMessageId, {
          html: renderTrackProgressHtml(this.state),
          skip_entity_detection: true,
        });
        return;
      } catch (error) {
        // A rich parse failure falls back to a plain edit; anything else
        // (message deleted, unknown id) kills the driver.
        if (!looksLikeRichParseError(error)) {
          this.dead = true;
          warn("inline progress edit failed", error);
          return;
        }
        this.richBroken = true;
        warn("inline rich edit failed, falling back to plain", error);
      }
    }
    try {
      await this.api.editMessageTextInline(this.inlineMessageId, PLAIN_STAGE_TEXT[this.state.stage]);
    } catch (error) {
      this.dead = true;
      warn("inline plain edit failed", error);
    }
  }
}

// Rich edits fail with a parse error when the html is rejected; other
// failures (deleted message, expired id) mean no amount of retrying helps.
function looksLikeRichParseError(error: unknown): boolean {
  const text = String((error as any)?.message ?? error);
  return /parse|rich|entity|can't parse/i.test(text);
}
