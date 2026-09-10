import { Api, RawApi } from "grammy";
import type { InlineKeyboardMarkup, InputMediaAudio, InputRichMessage } from "@grammyjs/types";
import { formatDuration } from "./telegram";
import { isValidImageUrl } from "./urlValidation";
import { warn } from "./logger";
import { DEEZLOAD_BOT } from "../config";

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

export type TrackStage = "info" | "metadata" | "lyrics" | "telegraph" | "music";

export interface TrackProgressState {
  stage: TrackStage;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  releaseDate?: string;
  // Rendered as the Lyrics checklist note, e.g. "42 lines (cached)".
  lyricsNote?: string;
  // Rendered as the Music file checklist note (inline auto-fetch), e.g.
  // "queued" / "failed".
  musicNote?: string;
}

const STAGE_ORDER: TrackStage[] = ["info", "metadata", "lyrics", "telegraph", "music"];

const STAGE_LABELS: Record<TrackStage, string> = {
  info: "Track info",
  metadata: "Album metadata",
  lyrics: "Lyrics",
  telegraph: "Telegraph page",
  music: "Music file",
};

const STAGE_ACTION: Record<TrackStage, string> = {
  info: "Fetching track info…",
  metadata: "Fetching album metadata…",
  lyrics: "Fetching lyrics…",
  telegraph: "Creating Telegraph page…",
  music: "Fetching music file…",
};

// Plain-text states for the non-rich fallback, matching the pre-rich flow.
const PLAIN_STAGE_TEXT: Record<TrackStage, string> = {
  info: "⏳ Fetching track info...",
  metadata: "⏳ Fetching metadata...",
  lyrics: "⏳ Fetching lyrics...",
  telegraph: "⏳ Creating Telegraph page...",
  music: "⏳ Fetching music file...",
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
    if (stage === "music" && state.musicNote) {
      label += ` — ${state.musicNote}`;
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

// Experimental rich-message music delivery: the song as ONE rich message —
// native audio bubble + a Lyrics button rendered in the body (tg-button-row)
// instead of a reply_markup keyboard. Per-user knobs (all chosen in
// /settings): layout (plain vs album-cover card), button position
// (tg-button-row align) and button color (tg-button style).
//
// The media[] field on InputRichMessage and the tg-button tags are newer than
// the pinned @grammyjs/types (3.28.0), so the payload is sent through a loose
// cast (same precedent as the `style` button attribute in handlers/admin.ts).

const RICH_AUDIO_MEDIA_ID = "music1";

export type RichLayoutId = 1 | 2;
export type RichPosition = "left" | "center" | "right";
export type RichColor = "default" | "primary" | "success" | "danger";

export const RICH_LAYOUTS: Record<RichLayoutId, { name: string; description: string }> = {
  1: {
    name: "Lyrics button",
    description: "audio player + Lyrics button",
  },
  2: {
    name: "Cover + Lyrics",
    description: "album art on top, player, Lyrics button",
  },
};

export function buildRichAudioDelivery(options: {
  fileId: string;
  telegraphUrl: string;
  layout?: RichLayoutId;
  position?: RichPosition;
  color?: RichColor;
  coverUrl?: string;
}): { html: string; media: Array<{ id: string; media: { type: "audio"; media: string } }> } {
  const esc = escapeRichHtml;
  const layout = options.layout ?? 1;
  const position = options.position ?? "center";
  const color = options.color ?? "primary";
  const audioBlock = `<figure><audio src="tg://audio?id=${RICH_AUDIO_MEDIA_ID}"></audio></figure>`;
  const styleAttr = color === "default" ? "" : ` style="${color}"`;
  const lyricsButton =
    `<tg-button type="url"${styleAttr} url="${esc(options.telegraphUrl)}">Lyrics</tg-button>`;

  // Layout 2 without a cover degrades to layout 1's body (the audio bubble
  // renders the file's own title/performer natively, so no text blocks).
  const html =
    layout === 2 && options.coverUrl
      ? `<img src="${esc(options.coverUrl)}"/>\n${audioBlock}\n` +
        `<tg-button-row align="${position}">${lyricsButton}</tg-button-row>`
      : `${audioBlock}\n<tg-button-row align="${position}">${lyricsButton}</tg-button-row>`;

  return {
    html,
    // InputRichMessage.media[] — newer than the pinned @grammyjs/types, hence
    // the loose shape; the tg://audio?id ref above resolves to it. The API
    // requires the InputMedia object NESTED under `media` (verified live:
    // a flattened entry fails with `Field "media" must be of type Object`).
    media: [{ id: RICH_AUDIO_MEDIA_ID, media: { type: "audio", media: options.fileId } }],
  };
}

// Interactive option demos for the /settings picker: the Lyrics button is
// rendered once per option as a clickable callback tg-button, so the user
// taps the look they want. The demo needs a player bubble to anchor the
// buttons; any valid file_id works.
export function buildRichOptionDemo(kind: "position" | "color", demoFileId: string): {
  html: string;
  media: Array<{ id: string; media: { type: "audio"; media: string } }>;
} {
  const audioBlock = `<figure><audio src="tg://audio?id=${RICH_AUDIO_MEDIA_ID}"></audio></figure>`;
  let rows: string;
  if (kind === "position") {
    const row = (align: RichPosition, data: string, mark: string) =>
      `<tg-button-row align="${align}">` +
      `<tg-button type="callback_data" data="${data}">Lyrics ${mark}</tg-button></tg-button-row>`;
    rows = [
      row("left", "richpos_left", "◀️"),
      row("center", "richpos_center", "⏺"),
      row("right", "richpos_right", "▶️"),
    ].join("\n");
  } else {
    const btn = (style: RichColor, data: string) =>
      `<tg-button type="callback_data"${style === "default" ? "" : ` style="${style}"`} data="${data}">Lyrics</tg-button>`;
    rows =
      `<tg-button-row align="center">` +
      btn("default", "richcol_default") +
      btn("primary", "richcol_primary") +
      btn("success", "richcol_success") +
      btn("danger", "richcol_danger") +
      `</tg-button-row>`;
  }
  return {
    html: `${audioBlock}\n${rows}`,
    media: [{ id: RICH_AUDIO_MEDIA_ID, media: { type: "audio", media: demoFileId } }],
  };
}

// Options every delivery site resolves once and hands to sendRichAudio.
export interface RichAudioOpts {
  layout?: RichLayoutId;
  position?: RichPosition;
  color?: RichColor;
  coverUrl?: string;
}

// The assembled admin /album result: cover + credit on top, then one audio
// player + Lyrics button per delivered track, with failed tracks as plain
// deezload lines. The cover is a plain HTTP <img> (no media entry needed);
// each player resolves its own media[] entry (trk1…trkN in order).
export function buildAlbumRichMessage(options: {
  albumTitle: string;
  artistName: string;
  coverUrl: string;
  tracks: Array<{
    trackName: string;
    trackId: number;
    telegraphUrl: string;
    fileId?: string;
  }>;
  position?: RichPosition;
  color?: RichColor;
}): { html: string; media: Array<{ id: string; media: { type: "audio"; media: string } }> } {
  const esc = escapeRichHtml;
  const position = options.position ?? "center";
  const color = options.color ?? "primary";
  const styleAttr = color === "default" ? "" : ` style="${color}"`;

  const media: Array<{ id: string; media: { type: "audio"; media: string } }> = [];
  const sections: string[] = [
    `<figure><img src="${esc(options.coverUrl)}"/>` +
    `<figcaption>${esc(options.artistName)} — ${esc(options.albumTitle)}</figcaption></figure>`,
    "<hr/>",
  ];

  options.tracks.forEach((track, i) => {
    const name = esc(track.trackName);
    if (track.fileId) {
      const mediaId = `trk${i + 1}`;
      media.push({ id: mediaId, media: { type: "audio", media: track.fileId } });
      sections.push(
        `<figure><audio src="tg://audio?id=${mediaId}"></audio>` +
        `<figcaption>${name}</figcaption></figure>` +
        // Page build failed — a url="" tg-button is rejected by the rich API
        // and would poison the WHOLE album message; render the player alone.
        (track.telegraphUrl
          ? `\n<tg-button-row align="${position}">` +
            `<tg-button type="url"${styleAttr} url="${esc(track.telegraphUrl)}">Lyrics</tg-button>` +
            `</tg-button-row>`
          : ""),
      );
    } else {
      sections.push(
        `<p>🎵 ${name} — <a href="${DEEZLOAD_BOT}deezerttrack${track.trackId}">grab from deezload</a></p>`,
      );
    }
  });

  return { html: sections.join("\n"), media };
}

// Send the rich audio delivery. Returns the sent message, or null on any
// failure so callers keep their existing plain sendAudio path (truthiness
// check) — a rich rejection must never block a delivery. The message object
// is what the /settings demo picker tracks for its delete-previous flow.
export async function sendRichAudio(
  api: Api<RawApi>,
  chatId: number,
  fileId: string,
  telegraphUrl: string,
  opts?: RichAudioOpts,
): Promise<{ message_id: number } | null> {
  const { html, media } = buildRichAudioDelivery({ fileId, telegraphUrl, ...opts });
  try {
    const msg = await (api as any).sendRichMessage(chatId, {
      html,
      media,
      skip_entity_detection: true,
    });
    return msg ?? null;
  } catch (error) {
    warn("rich audio delivery failed, falling back to plain sendAudio", error);
    return null;
  }
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

  // Flip the Music file item to its failed state (inline auto-fetch).
  async markMusicFailed(): Promise<void> {
    if (this.dead) {
      return;
    }
    await this.update({ stage: "music", musicNote: "failed" });
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

  // Morph the message into the delivered audio (song + caption + Lyrics
  // button — the DM flow's end state). Inline edits can't upload files, so
  // this only accepts previously-uploaded file_ids (cache or bridge forward).
  async finalizeAsAudio(fileId: string, caption: string, markup: InlineKeyboardMarkup): Promise<boolean> {
    if (this.dead) {
      return false;
    }
    try {
      await this.api.editMessageMediaInline(this.inlineMessageId, {
        type: "audio",
        media: fileId,
        caption,
        parse_mode: "MarkdownV2",
      } satisfies InputMediaAudio<any>, { reply_markup: markup });
      return true;
    } catch (error) {
      warn("inline audio morph failed", error);
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
