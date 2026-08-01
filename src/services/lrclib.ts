import { LRCLIB_TIMEOUT_MS, LRCLIB_MAX_RETRIES } from "../config";
import { retryAsync } from "../utils/retry";
import { fetchWithTimeout } from "../utils/fetch";
import { log, previewText, warn } from "../utils/logger";

const LRCLIB_SEARCH = "https://lrclib.net/api/search";

// LRCLIB rejects requests without an identifying User-Agent (HTTP 403).
const LRCLIB_HEADERS = {
  "User-Agent": "LyriphonBot/1.0 (https://t.me/lyriphon_bot)",
  "Accept": "application/json",
};

export async function getLyrics(track: string, artist: string, retries = LRCLIB_MAX_RETRIES, delay = 0.4) {
  log("LRCLIB search:", JSON.stringify({ track, artist }));

  async function fetchLyrics() {
    const url = new URL(LRCLIB_SEARCH);
    url.searchParams.set("track_name", track);
    url.searchParams.set("artist_name", artist);

    const response = await fetchWithTimeout(url.toString(), {
      headers: LRCLIB_HEADERS,
      timeoutMs: LRCLIB_TIMEOUT_MS,
    });
    
    // Handle 429 Rate Limiting
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 5;
      warn(`LRCLIB rate limited, waiting ${waitSeconds}s`);
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      throw new Error(`LRCLIB rate limited, waited ${waitSeconds}s`);
    }
    
    if (!response.ok) {
      throw new Error(`LRCLIB HTTP ${response.status}`);
    }

    const results = await response.json();
    if (!Array.isArray(results) || results.length === 0) {
      log("LRCLIB: no results for", JSON.stringify({ track, artist }));
      return null;
    }

    const best = results[0];
    const source = best?.plainLyrics ? "plain" : best?.syncedLyrics ? "synced" : null;
    const lyrics = best?.plainLyrics ?? best?.syncedLyrics;
    if (!lyrics) {
      const topHits = results
        .slice(0, 3)
        .map((r: any) => `"${r?.trackName ?? "?"}" / "${r?.artistName ?? "?"}"`)
        .join("; ");
      log(
        "LRCLIB: results without lyrics text",
        JSON.stringify({ track, artist, count: results.length, topHits }),
      );
      return null;
    }

    log(
      "LRCLIB: found",
      source,
      `lyrics (${results.length} hit(s)) matched`,
      JSON.stringify({
        requested: { track, artist },
        matched: {
          track: best?.trackName ?? "?",
          artist: best?.artistName ?? "?",
          album: best?.albumName ?? "?",
        },
      }),
      "preview:",
      previewText(String(lyrics)),
    );
    return lyrics;
  }

  return await retryAsync(fetchLyrics, retries, delay);
}
