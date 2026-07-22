import { DEEZER_MAX_RETRIES, HTTP_TIMEOUT_MS } from "../config";
import { warn } from "../utils/logger";
import { retryAsync } from "../utils/retry";
import { fetchWithTimeout } from "../utils/fetch";

const DEEZER_SEARCH_URL = "https://api.deezer.com/search";
const DEEZER_TRACK_URL = "https://api.deezer.com/track/";
const DEEZER_ALBUM_URL = "https://api.deezer.com/album/";

const DEEZER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; LyriphonBot/1.0; +https://t.me/lyriphon_bot)",
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
};

// HTTP status codes that should trigger a retry
const RETRYABLE_STATUSES = new Set([403, 429, 500, 502, 503, 504]);

// Deezer JSON error codes that should trigger a retry
const DEEZER_RETRYABLE_ERROR_CODES = new Set([700]); // SERVICE_BUSY

// All Deezer JSON error codes for logging
const DEEZER_ERROR_NAMES: Record<number, string> = {
  4: "QUOTA",
  100: "ITEMS_LIMIT_EXCEEDED",
  200: "PERMISSION",
  300: "TOKEN_INVALID",
  500: "PARAMETER",
  501: "PARAMETER_MISSING",
  600: "QUERY_INVALID",
  700: "SERVICE_BUSY",
  800: "DATA_NOT_FOUND",
  901: "INDIVIDUAL_ACCOUNT_NOT_ALLOWED",
};

async function deezerFetchJson(url: string, label: string): Promise<any | null> {
  return retryAsync(async () => {
    try {
      const response = await fetchWithTimeout(url, {
        headers: DEEZER_HEADERS,
        timeoutMs: HTTP_TIMEOUT_MS,
      });
      
      if (!response.ok) {
        let body = "";
        try {
          body = await response.text();
        } catch {}
        // Retry on retryable status codes
        if (RETRYABLE_STATUSES.has(response.status)) {
          throw new Error(`Deezer ${label} retryable HTTP error ${response.status}: ${body}`);
        }
        // No retry for other errors (404, 400, etc.)
        warn(`Deezer ${label} HTTP error`, response.status, url, body);
        return null;
      }
      
      const json = await response.json();
      
      // Check for Deezer JSON error response
      if (json && typeof json === "object" && "error" in json && json.error) {
        const err = json.error as { code: number; message?: string; type?: string };
        const errCode = err.code;
        const errName = DEEZER_ERROR_NAMES[errCode] ?? "UNKNOWN";
        
        // Retry on retryable error codes
        if (DEEZER_RETRYABLE_ERROR_CODES.has(errCode)) {
          throw new Error(`Deezer ${label} retryable error ${errCode} (${errName})`);
        }
        
        // No retry for other errors
        warn(`Deezer ${label} API error`, errCode, errName, url);
        return null;
      }
      
      return json;
    } catch (error) {
      // Retry on abort/timeout or network errors
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Deezer ${label} timeout`);
      }
      // Rethrow for retryAsync to handle
      throw error;
    }
  }, DEEZER_MAX_RETRIES, 0.4);
}

export async function searchTracks(query: string, limit = 25) {
  const data = await deezerFetchJson(
    `${DEEZER_SEARCH_URL}?q=${encodeURIComponent(query)}`,
    "search",
  );
  if (!data) {
    return null;
  }
  return (data.data ?? []).slice(0, limit);
}

export async function getTrack(trackId: number) {
  return await deezerFetchJson(`${DEEZER_TRACK_URL}${trackId}`, "getTrack");
}

export async function getAlbum(albumId: number) {
  return await deezerFetchJson(`${DEEZER_ALBUM_URL}${albumId}`, "getAlbum");
}
