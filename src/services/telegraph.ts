import { Env } from "../env";
import { CHANNEL_LINK, DEEZLOAD_BOT } from "../config";
import { formatLyricsForTelegraph } from "./lyricsFormatter";
import { isValidImageUrl, safeLink } from "../utils/urlValidation";

export interface TelegraphPageData {
  authorName: string;
  track: string;
  trackLink: string;
  artist: string;
  artistLink: string;
  album: string;
  albumLink: string;
  albumCoverUrl: string;
  releaseDate: string;
  path: string;
}

export async function createSongTelegraph(env: Env, options: {
  authorName: string;
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
  const { authorName, track, trackId, artist, artistId, album, albumId, albumCoverUrl, releaseDate, lyrics } = options;
  const trackLink = `${DEEZLOAD_BOT}deezerttrack${trackId}`;
  const artistLink = `${DEEZLOAD_BOT}deezertartist${artistId}`;
  const albumLink = `${DEEZLOAD_BOT}deezertalbum${albumId}`;

  const content = buildHtmlPage({
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

  console.log("=== TELEGRAPH OUTPUT ===");
  console.log(content);
  console.log("========================");

  const response = await fetch("https://api.telegra.ph/createPage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: env.TELEGRAPH_ACCESS_TOKEN,
      title: track,
      author_name: authorName,
      author_url: CHANNEL_LINK,
      return_content: true,
      content,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegraph createPage failed ${response.status}`);
  }

  const data = await response.json() as any;
  if (!data.ok || !data.result) {
    throw new Error(`Telegraph API error: ${data.error || "unknown"}`);
  }
  return {
    url: `https://telegra.ph/${data.result.path}`,
    path: data.result.path,
    lastData: {
      authorName,
      track,
      trackLink,
      artist,
      artistLink,
      album,
      albumLink,
      albumCoverUrl,
      releaseDate,
      path: data.result.path,
    } as TelegraphPageData,
  };
}

export async function editSongPage(env: Env, pageData: TelegraphPageData, lyrics: string) {
  const content = buildHtmlPage({
    track: pageData.track,
    artist: pageData.artist,
    album: pageData.album,
    releaseDate: pageData.releaseDate,
    albumCoverUrl: pageData.albumCoverUrl,
    trackLink: pageData.trackLink,
    artistLink: pageData.artistLink,
    albumLink: pageData.albumLink,
    lyrics,
  });

  const response = await fetch("https://api.telegra.ph/editPage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: env.TELEGRAPH_ACCESS_TOKEN,
      path: pageData.path,
      title: pageData.track,
      author_name: pageData.authorName,
      author_url: CHANNEL_LINK,
      content,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegraph editPage failed ${response.status}`);
  }

  return await response.json() as any;
}

function buildHtmlPage(options: {
  track: string;
  artist: string;
  album: string;
  releaseDate: string;
  albumCoverUrl: string;
  trackLink: string;
  artistLink: string;
  albumLink: string;
  lyrics: string;
}) {
  const { track, artist, album, releaseDate, albumCoverUrl, trackLink, artistLink, albumLink, lyrics } = options;
  const coverHtml = isValidImageUrl(albumCoverUrl) ? `<img src="${albumCoverUrl}"><br>` : "";

  const trackHtml = safeLink(track, trackLink);
  const artistHtml = safeLink(artist, artistLink);
  const albumHtml = safeLink(album, albumLink);
  const safeDate = escapeHtml(releaseDate || "");

  const trackSection = track ? `<p><strong>🎧 Track:</strong> ${trackHtml}</p>` : "";
  const artistSection = artist ? `<p><strong>👤 Artist:</strong> ${artistHtml}</p>` : "";
  const albumSection = album ? `<p><strong>💽 Album:</strong> ${albumHtml}</p>` : "";
  const dateSection = releaseDate ? `<p><strong>📅 Date:</strong> ${safeDate}</p>` : "";

  let html = `
${coverHtml}

${trackSection}
${artistSection}
${albumSection}
${dateSection}

${formatLyricsForTelegraph(lyrics)}
`;

  html = html.replace(/<p>(&#8203;|\s)*<\/p>/g, "");

  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
