import { LRCLIB_TIMEOUT_MS, LRCLIB_MAX_RETRIES } from "../config";
import { retryAsync } from "../utils/retry";
import { fetchWithTimeout } from "../utils/fetch";
import { log, previewText, warn } from "../utils/logger";

const LRCLIB_SEARCH = "https://lrclib.net/api/search";

const LRCLIB_HEADERS = {
  "User-Agent": "LyriphonBot/1.0 (https://t.me/lyriphon_bot)",
  "Accept": "application/json",
};

type LrcLibTrack = {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
};

const LRC_TIMESTAMP_RE = /^\s*\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]\s*/;

/**
 * Convert synced LRC lyrics into displayable plain lyrics by stripping the
 * [mm:ss.xx] timestamps from every line. Returns null when nothing readable
 * remains (e.g. every line was pure metadata).
 */
function syncedToPlain(syncedLyrics: string): string | null {
  const stripped = syncedLyrics
    .split("\n")
    .map((line) => line.replace(LRC_TIMESTAMP_RE, ""))
    .join("\n")
    .replace(/(?:^\n+|\n+$)/g, "");
  return stripped.trim() ? stripped : null;
}

async function searchLyrics(
  track: string,
  artist: string,
  album?: string,
): Promise<LrcLibTrack | null> {
  const url = new URL(LRCLIB_SEARCH);

  url.searchParams.set("track_name", track);
  url.searchParams.set("artist_name", artist);

  if (album?.trim()) {
    url.searchParams.set("album_name", album);
  }

  const response = await fetchWithTimeout(url.toString(), {
    headers: LRCLIB_HEADERS,
    timeoutMs: LRCLIB_TIMEOUT_MS,
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 5;

    warn(`LRCLIB rate limited, waiting ${waitSeconds}s`);

    await new Promise(resolve =>
      setTimeout(resolve, waitSeconds * 1000),
    );

    throw new Error(`LRCLIB rate limited, waited ${waitSeconds}s`);
  }

  if (!response.ok) {
    return null;
  }

  const results = (await response.json()) as LrcLibTrack[];

  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  const hasPlainLyrics = (r: LrcLibTrack) =>
    Boolean(r.plainLyrics && r.plainLyrics.trim());
  const hasSyncedLyrics = (r: LrcLibTrack) =>
    Boolean(r.syncedLyrics && r.syncedLyrics.trim());

  const pickAlbumMatch = (predicate: (r: LrcLibTrack) => boolean) => {
    if (!album) {
      return undefined;
    }
    return results.find(
      r => r.albumName?.toLowerCase() === album.toLowerCase() && predicate(r),
    );
  };

  // Prefer exact album match with plain lyrics, then any result with them.
  const plainMatch = pickAlbumMatch(hasPlainLyrics) ?? results.find(hasPlainLyrics);
  if (plainMatch) {
    return plainMatch;
  }

  // Nothing with plain lyrics — fall back to synced LRC lyrics with the
  // [mm:ss.xx] timestamps stripped so pages stay readable.
  const syncedTrack = pickAlbumMatch(hasSyncedLyrics) ?? results.find(hasSyncedLyrics);
  if (syncedTrack) {
    const plain = syncedToPlain(syncedTrack.syncedLyrics!);
    if (plain) {
      return { ...syncedTrack, plainLyrics: plain };
    }
  }

  return null;
}

export async function getLyrics(
  track: string,
  artist: string,
  album?: string,
  retries = LRCLIB_MAX_RETRIES,
  delay = 0.4,
) {
  return retryAsync(async () => {
    log(
      "LRCLIB search:",
      JSON.stringify({
        track,
        artist,
        album,
      }),
    );

    const attempts = [
      {
        track,
        artist,
        album,
      },
      {
        track,
        artist,
      },
    ];

    for (const attempt of attempts) {
      const result = await searchLyrics(
        attempt.track,
        attempt.artist,
        attempt.album,
      );

      if (!result?.plainLyrics) {
        continue;
      }

      log(
        "LRCLIB: found",
        JSON.stringify({
          requested: {
            track,
            artist,
            album,
          },
          matched: {
            track: result.trackName ?? "?",
            artist: result.artistName ?? "?",
            album: result.albumName ?? "?",
          },
        }),
        "preview:",
        previewText(result.plainLyrics),
      );

      return result.plainLyrics;
    }

    log(
      "LRCLIB: no lyrics",
      JSON.stringify({
        track,
        artist,
        album,
      }),
    );

    return null;
  }, retries, delay);
}