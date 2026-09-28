import { Env } from "../env";
import { CHANNEL_LINK, DEEZLOAD_BOT } from "../config";
import { formatLyricsForTelegraph } from "./lyricsFormatter";
import { isValidImageUrl, safeLink } from "../utils/urlValidation";
import { fetchWithTimeout } from "../utils/fetch";
import { warn } from "../utils/logger";

// Telegraph rejects bursts: 13 album pages built concurrently (one per
// bridge-delivery webhook, all within ~5s) lost 3 of 13. This module-level
// promise chain spaces createPage calls ≥ MIN_GAP apart per isolate, which
// serializes the burst; single-track flows see an empty queue and run
// immediately.
const TELEGRAPH_MIN_GAP_MS = 300;
let telegraphQueue: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pacedCreatePage(body: unknown): Promise<any> {
  const run = telegraphQueue.then(async () => {
    const response = await fetch("https://api.telegra.ph/createPage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Telegraph createPage failed ${response.status}`);
    }
    return response.json();
  });
  // Keep the chain alive regardless of the call's outcome, and hold the gap.
  telegraphQueue = run
    .catch(() => {})
    .then(() => sleep(TELEGRAPH_MIN_GAP_MS));
  return run;
}

// Reads share the same queue as writes: a burst of /edit commands is the same
// kind of burst that lost 3 of 13 album pages, and getPage hits the same API.
async function pacedGetPage(url: string): Promise<any> {
  const run = telegraphQueue.then(async () => {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(`Telegraph getPage failed ${response.status}`);
    }
    return response.json();
  });
  telegraphQueue = run
    .catch(() => {})
    .then(() => sleep(TELEGRAPH_MIN_GAP_MS));
  return run;
}

export interface TelegraphPageResult {
  ok: boolean;
  url: string;
  path: string;
  title: string;
  authorName: string;
  authorUrl: string;
  content: TelegraphNode[];
}

// Reads a page's metadata and body. Returns ok:false instead of throwing so
// the caller can answer the user without a try/catch — the command handler
// must not throw out of SessionDO.fetch.
export async function getTelegraphPage(env: Env, path: string): Promise<TelegraphPageResult> {
  const empty: TelegraphPageResult = {
    ok: false,
    url: "",
    path,
    title: "",
    authorName: "",
    authorUrl: "",
    content: [],
  };

  let data: any;
  try {
    // return_content=true is required: without it the API answers with a
    // flattened `description` string and no `content` nodes, so there is
    // nothing to parse and the page looks empty.
    const url =
      `https://api.telegra.ph/getPage?path=${encodeURIComponent(path)}&return_content=true` +
      `&access_token=${encodeURIComponent(env.TELEGRAPH_ACCESS_TOKEN)}`;
    data = await pacedGetPage(url);
  } catch (error) {
    warn("getTelegraphPage: request failed", path, error);
    return empty;
  }

  if (!data?.ok || !data?.result) {
    warn("getTelegraphPage: API error", path, data?.error);
    return empty;
  }

  const result = data.result;
  return {
    ok: true,
    url: typeof result.url === "string" ? result.url : `https://telegra.ph/${path}`,
    path: typeof result.path === "string" && result.path ? result.path : path,
    title: typeof result.title === "string" ? result.title : "",
    authorName: typeof result.author_name === "string" ? result.author_name : "",
    authorUrl: typeof result.author_url === "string" ? result.author_url : "",
    content: Array.isArray(result.content) ? result.content : [],
  };
}

export type TelegraphNode =
  | string
  | {
      tag: string;
      attrs?: Record<string, string>;
      children?: TelegraphNode[];
    };

export interface TelegraphPageData {
  authorName: string;
  // The creator's Telegram link, used as the page's author_url. It doubles as
  // the page's owner marker for /edit. Optional because pages created before
  // it existed — and pages whose creator has no Telegram username — carry the
  // channel link instead, so there is nothing distinct to record.
  authorUrl?: string;
  track: string;
  trackLink: string;
  artist: string;
  artistLink: string;
  album: string;
  albumLink: string;
  albumCoverUrl: string;
  releaseDate: string;
  path: string;
  trackId?: number;
}

export async function createSongTelegraph(env: Env, options: {
  authorName: string;
  // The creator's Telegram link, recorded as the page's author_url. It is the
  // page's owner marker for /edit. Omitted when the creator has no username,
  // in which case the channel link is kept as before.
  authorUrl?: string;
  track: string;
  trackId: number;
  artist: string;
  artistId: number;
  album: string;
  albumId: number;
  albumCoverUrl: string;
  releaseDate: string;
  lyrics: string;
}) {
  const { authorName, authorUrl, track, trackId, artist, artistId, album, albumId, albumCoverUrl, releaseDate, lyrics } = options;
  const trackLink = `${DEEZLOAD_BOT}deezerttrack${trackId}`;
  const artistLink = `${DEEZLOAD_BOT}deezertartist${artistId}`;
  const albumLink = `${DEEZLOAD_BOT}deezertalbum${albumId}`;

  const content = buildPageContent({
    track,
    artist,
    album,
    releaseDate,
    albumCoverUrl,
    trackLink,
    artistLink,
    albumLink,
    lyrics,
  });

  const data = await pacedCreatePage({
    access_token: env.TELEGRAPH_ACCESS_TOKEN,
    title: track,
    author_name: authorName,
    // The creator's own link when they have a username, so /edit can identify
    // them by identity rather than by display name. The author *name* is
    // unchanged, so nothing visible on the page changes.
    author_url: authorUrl ?? CHANNEL_LINK,
    return_content: true,
    content,
  }) as any;

  if (!data.ok || !data.result) {
    throw new Error(`Telegraph API error: ${data.error || "unknown"}`);
  }
  return {
    url: `https://telegra.ph/${data.result.path}`,
    path: data.result.path,
    lastData: {
      authorName,
      authorUrl: authorUrl ?? CHANNEL_LINK,
      track,
      trackLink,
      artist,
      artistLink,
      album,
      albumLink,
      albumCoverUrl,
      releaseDate,
      path: data.result.path,
      trackId,
    } as TelegraphPageData,
  };
}

export async function editSongPage(env: Env, pageData: TelegraphPageData, lyrics: string, opts?: {
  // Invisible-touch count for the AI-summary refresh: appended to the
  // generated "Lyrics" heading as zero-width spaces so the edit always
  // differs from the page's current content without any visible change.
  summaryZwsCount?: number;
}) {
  const content = buildPageContent({
    track: pageData.track,
    artist: pageData.artist,
    album: pageData.album,
    releaseDate: pageData.releaseDate,
    albumCoverUrl: pageData.albumCoverUrl,
    trackLink: pageData.trackLink,
    artistLink: pageData.artistLink,
    albumLink: pageData.albumLink,
    lyrics,
    summaryZwsCount: opts?.summaryZwsCount ?? 0,
  });

  const response = await fetch("https://api.telegra.ph/editPage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: env.TELEGRAPH_ACCESS_TOKEN,
      path: pageData.path,
      title: pageData.track,
      author_name: pageData.authorName,
      // The page's OWN author link, not the channel constant: sending
      // CHANNEL_LINK here would strip the creator's username marker on the
      // first edit and lock the real owner out of their own page.
      author_url: pageData.authorUrl ?? CHANNEL_LINK,
      content,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegraph editPage failed ${response.status}`);
  }

  const data = await response.json() as any;
  if (!data.ok || !data.result) {
    throw new Error(`Telegraph editPage error: ${data.error || "unknown"}`);
  }

  return data;
}

// --- Page read (inverse of buildPageContent) ---------------------------------
//
// /edit must write the whole page back, and buildPageContent omits any field
// that is empty — so a field missing from pageData is DELETED from the page,
// not left alone. These two functions are therefore a matched pair: anything
// buildPageContent can emit, parseTelegraphPage must be able to read back.
// Keep them in this module so they cannot drift.

const FIELD_LABELS: Array<{ prefix: string; key: keyof TelegraphPageData; linkKey?: keyof TelegraphPageData }> = [
  { prefix: "🎧 Track: ", key: "track", linkKey: "trackLink" },
  { prefix: "👤 Artist: ", key: "artist", linkKey: "artistLink" },
  { prefix: "💽 Album: ", key: "album", linkKey: "albumLink" },
  { prefix: "📅 Date: ", key: "releaseDate" },
];

// The generated "Lyrics" heading. Matched on the label only, never on exact
// text: the AI-summary refresh appends zero-width spaces to it, so an exact
// match would miss the heading and swallow the whole body as lyrics.
const LYRICS_HEADING = "Lyrics";

// formatLyricsForTelegraph emits this as the paragraph between lyric blocks.
const BLOCK_SEPARATOR = "​";

function isNodeObject(node: unknown): node is { tag: string; attrs?: Record<string, string>; children?: unknown[] } {
  return typeof node === "object" && node !== null && typeof (node as any).tag === "string";
}

// Concatenates a paragraph's children back into one line: plain strings pass
// through, an <a> contributes its text, and <br> becomes a newline (which is
// how an original line and its [translation] partner were written).
function nodeText(children: unknown[] | undefined): string {
  if (!children) return "";
  let out = "";
  for (const child of children) {
    if (typeof child === "string") {
      out += child;
    } else if (isNodeObject(child)) {
      if (child.tag === "br") {
        out += "\n";
      } else if (child.tag === "a") {
        out += nodeText(child.children);
      } else {
        out += nodeText(child.children);
      }
    }
  }
  return out;
}

function linkHref(children: unknown[] | undefined): string | undefined {
  if (!children) return undefined;
  for (const child of children) {
    if (isNodeObject(child) && child.tag === "a" && child.attrs?.href) {
      return child.attrs.href;
    }
  }
  return undefined;
}

// Recovers the page's song fields and lyrics. Every field buildPageContent
// reads is populated; anything the page does not show becomes "", which
// reproduces the current page rather than inventing or dropping it.
export function parseTelegraphPage(result: TelegraphPageResult): TelegraphPageData & { lyrics: string } {
  const data: TelegraphPageData & { lyrics: string } = {
    authorName: result.authorName,
    authorUrl: result.authorUrl,
    track: result.title,
    trackLink: "",
    artist: "",
    artistLink: "",
    album: "",
    albumLink: "",
    albumCoverUrl: "",
    releaseDate: "",
    path: result.path,
    trackId: undefined,
    lyrics: "",
  };

  const nodes = result.content ?? [];
  let headingSeen = false;
  const lyricBlocks: string[] = [];
  let currentBlock: string[] = [];

  for (const node of nodes) {
    if (typeof node === "string") continue;

    if (node.tag === "img") {
      const src = node.attrs?.src;
      if (src && !data.albumCoverUrl) {
        data.albumCoverUrl = src;
      }
      continue;
    }

    if (node.tag === "h3") {
      // Once the heading is passed, everything after it is lyrics.
      if (!headingSeen && nodeText(node.children).trim().startsWith(LYRICS_HEADING)) {
        headingSeen = true;
      }
      continue;
    }

    if (node.tag !== "p") continue;

    const text = nodeText(node.children);

    if (headingSeen) {
      if (text === BLOCK_SEPARATOR) {
        lyricBlocks.push(currentBlock.join("\n"));
        currentBlock = [];
      } else {
        currentBlock.push(text);
      }
      continue;
    }

    for (const field of FIELD_LABELS) {
      if (!text.startsWith(field.prefix)) continue;
      const value = text.slice(field.prefix.length).trim();
      (data as any)[field.key] = value;
      if (field.linkKey) {
        (data as any)[field.linkKey] = linkHref(node.children) ?? "";
      }
      break;
    }
  }

  if (currentBlock.length) {
    lyricBlocks.push(currentBlock.join("\n"));
  }
  data.lyrics = lyricBlocks.join("\n\n");

  // Recover the Deezer id from the track deep link so the owner-only
  // "Apply to D1" button still works on an /edit-opened page.
  const trackIdMatch = /deezerttrack(\d+)/.exec(data.trackLink);
  if (trackIdMatch) {
    data.trackId = Number(trackIdMatch[1]);
  }

  return data;
}

function buildPageContent(options: {
  track: string;
  artist: string;
  album: string;
  releaseDate: string;
  albumCoverUrl: string;
  trackLink: string;
  artistLink: string;
  albumLink: string;
  lyrics: string;
  summaryZwsCount?: number;
}): TelegraphNode[] {
  const { track, artist, album, releaseDate, albumCoverUrl, trackLink, artistLink, albumLink, lyrics } = options;
  const nodes: TelegraphNode[] = [];

  if (isValidImageUrl(albumCoverUrl)) {
    nodes.push({ tag: "img", attrs: { src: albumCoverUrl } });
  }

  if (track) {
    nodes.push({ tag: "p", children: [{ tag: "strong", children: ["🎧 Track: "] }, safeLink(track, trackLink)] });
  }
  if (artist) {
    nodes.push({ tag: "p", children: [{ tag: "strong", children: ["👤 Artist: "] }, safeLink(artist, artistLink)] });
  }
  if (album) {
    nodes.push({ tag: "p", children: [{ tag: "strong", children: ["💽 Album: "] }, safeLink(album, albumLink)] });
  }
  if (releaseDate) {
    nodes.push({ tag: "p", children: [{ tag: "strong", children: ["📅 Date: "] }, releaseDate] });
  }

  nodes.push({ tag: "hr" });
  // Zero-width spaces here are the AI-summary refresh touch: invisible, and
  // the heading is generated (never user-editable), so the touch can't
  // collide with manually edited fields.
  nodes.push({ tag: "h3", children: ["Lyrics" + "​".repeat(options.summaryZwsCount ?? 0)] });
  nodes.push(...formatLyricsForTelegraph(lyrics));

  return nodes;
}
