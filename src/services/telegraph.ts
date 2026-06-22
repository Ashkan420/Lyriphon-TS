import { Env } from "../env";
import { CHANNEL_LINK, DEEZLOAD_BOT } from "../config";
import { formatLyricsForTelegraph } from "./lyricsFormatter";
import { isValidImageUrl, safeLink } from "../utils/urlValidation";

export type TelegraphNode =
  | string
  | {
      tag: string;
      attrs?: Record<string, string>;
      children?: TelegraphNode[];
    };

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

  //console.log("=== TELEGRAPH OUTPUT ===");
  //console.log(JSON.stringify(content, null, 2));
  //console.log("========================");

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
  nodes.push({ tag: "h3", children: ["Lyrics"] });
  nodes.push(...formatLyricsForTelegraph(lyrics));

  return nodes;
}
