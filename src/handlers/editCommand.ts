import { Context } from "grammy";
import { Env } from "../env";
import { CHANNEL_LINK } from "../config";
import { getTelegraphPage, parseTelegraphPage } from "../services/telegraph";
import { buildEditMenu, adminToolsOpts } from "./callbacks/index";
import { buildTrackResultHtml } from "../utils/richMessages";
import { isBotOwner } from "./admin";
import { SessionData } from "../session/types";
import { warn } from "../utils/logger";

// /edit <telegraph_link> — reopens the existing edit flow for a page the
// caller owns, without needing the result card that created it.
//
// The command is only a door: it validates the link, reads the page, checks
// ownership, and fills the same session slots the search flow fills. Every
// field handler downstream runs unmodified. Nothing about the edit flow itself
// lives here, and the ownership check applies to this command alone — the
// result-card button keeps its current ungated behavior.

const TELEGRAPH_HOSTS = new Set(["telegra.ph", "www.telegra.ph"]);

export interface AuthorIdentity {
  name: string;
  url?: string;
}

// Returns the page path, or null when the argument is not a Telegraph page
// link. Validated before any network request: a junk argument must cost
// nothing and must never reach the API.
export function parseTelegraphLink(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!TELEGRAPH_HOSTS.has(url.hostname.toLowerCase())) return null;

  // Telegraph pages are a single path segment. Extra segments mean the user
  // passed something that is not a page link; truncating would edit a page
  // they did not name.
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;

  return decodeURIComponent(segments[0]);
}

// Compares two t.me links on the username segment only. The host is ignored
// because both sides are t.me; case, surrounding whitespace, and a trailing
// slash are not meaningful for a username.
function sameUsername(a: string | undefined, b: string | undefined): boolean {
  const usernameOf = (value: string | undefined): string | null => {
    if (!value) return null;
    const match = /^https?:\/\/(?:www\.)?t\.me\/([^/?#]+)/i.exec(value.trim());
    return match ? match[1].replace(/^@/, "").toLowerCase() : null;
  };
  const left = usernameOf(a);
  const right = usernameOf(b);
  return left !== null && left === right;
}

function isChannelLink(value: string | undefined): boolean {
  if (!value) return true;
  return value.trim().replace(/\/+$/, "").toLowerCase() === CHANNEL_LINK.replace(/\/+$/, "").toLowerCase();
}

function normalizeName(value: string): string {
  return value.trim().replace(/^@/, "").trim().toLowerCase();
}

// Three ordered checks, first match wins.
//
// The channel-link test is an equality test against the known constant, not a
// heuristic like "does this look like a username": a page whose author link is
// malformed must NOT fall through to the weaker name comparison.
export function checkPageOwnership(
  page: { authorUrl?: string; authorName: string },
  user: AuthorIdentity,
  isOwner: boolean,
): boolean {
  if (isOwner) return true;

  if (sameUsername(page.authorUrl, user.url)) return true;

  if (isChannelLink(page.authorUrl)) {
    const pageName = normalizeName(page.authorName);
    // An empty author matches nothing: there is no name to compare.
    return pageName.length > 0 && pageName === normalizeName(user.name);
  }

  return false;
}

export async function editCommandHandler(ctx: Context, session: SessionData, env: Env) {
  const path = parseTelegraphLink(typeof ctx.match === "string" ? ctx.match : "");

  if (!path) {
    // No parse_mode here, so plain text — <code> tags would render literally.
    await ctx.reply("❌ Send a Telegraph page link.\n\nUsage:\n/edit https://telegra.ph/Page-Name");
    return;
  }

  const result = await getTelegraphPage(env, path);

  if (!result.ok || !result.content.length) {
    await ctx.reply("❌ Could not load that Telegraph page.");
    return;
  }

  const identity: AuthorIdentity = {
    name: ctx.from?.first_name ?? "",
    url: ctx.from?.username ? `https://t.me/${ctx.from.username}` : undefined,
  };

  if (!checkPageOwnership(result, identity, isBotOwner(ctx, env))) {
    await ctx.reply("❌ You are not the author of that page.");
    return;
  }

  // Fill the same slots the search flow fills. The ownership verdict is
  // deliberately not stored: it decided this reply and nothing reads it
  // again, so persisting it would add dead state to a persisted session.
  const parsed = parseTelegraphPage(result);
  const { lyrics, ...pageData } = parsed;

  session.telegraph.data = pageData;
  session.telegraph.url = result.url || `https://telegra.ph/${path}`;
  session.telegraph.path = result.path || path;
  session.telegraph.originalLyrics = lyrics;

  // From here the existing flow takes over untouched: the card carries the
  // normal edit keyboard, and every field handler is the same one the result
  // card uses. No new mode, no parallel editing path.
  const text = buildTrackResultHtml({
    trackName: pageData.track,
    artistName: pageData.artist,
    albumName: pageData.album,
    releaseDate: pageData.releaseDate,
    telegraphUrl: session.telegraph.url,
    authorName: pageData.authorName,
    hasAudio: false,
  });
  const menu = buildEditMenu(false, adminToolsOpts(pageData.trackId, isBotOwner(ctx, env)));

  try {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: menu } as any,
    });
  } catch (error) {
    // A failed card send must not leave a half-open session behind.
    warn("editCommand: failed to send card", path, error);
    session.telegraph.data = undefined;
    session.telegraph.originalLyrics = undefined;
    await ctx.reply("❌ Could not open that page for editing.");
  }
}
