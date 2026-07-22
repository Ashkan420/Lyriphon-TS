import { LRCLIB_TIMEOUT_MS, LRCLIB_MAX_RETRIES } from "../config";
import { retryAsync } from "../utils/retry";
import { fetchWithTimeout } from "../utils/fetch";
import { warn } from "../utils/logger";

const LRCLIB_SEARCH = "https://lrclib.net/api/search";

export async function getLyrics(track: string, artist: string, retries = LRCLIB_MAX_RETRIES, delay = 0.4) {
  async function fetchLyrics() {
    const url = new URL(LRCLIB_SEARCH);
    url.searchParams.set("track_name", track);
    url.searchParams.set("artist_name", artist);

    const response = await fetchWithTimeout(url.toString(), {
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
    const best = Array.isArray(results) && results[0];
    const lyrics = best?.plainLyrics ?? best?.syncedLyrics;
    if (!lyrics) {
      return null;
    }
    return lyrics;
  }

  return await retryAsync(fetchLyrics, retries, delay);
}
