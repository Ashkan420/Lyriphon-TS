import { retryAsync } from "../utils/retry";

const LRCLIB_SEARCH = "https://lrclib.net/api/search";

export async function getLyrics(track: string, artist: string, retries = 2, delay = 2.0) {
  async function fetchLyrics() {
    const url = new URL(LRCLIB_SEARCH);
    url.searchParams.set("track_name", track);
    url.searchParams.set("artist_name", artist);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`LRCLIB HTTP ${response.status}`);
    }

    const results = await response.json();
    const best = Array.isArray(results) && results[0];
    const lyrics = best?.plainLyrics ?? best?.syncedLyrics;
    if (!lyrics) {
      throw new Error("No lyrics found");
    }
    return lyrics;
  }

  return await retryAsync(fetchLyrics, retries, delay);
}
