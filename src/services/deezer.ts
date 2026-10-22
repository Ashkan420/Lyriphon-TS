import { DEEZER_MAX_RETRIES, HTTP_TIMEOUT_MS } from "../config";
import { log, warn } from "../utils/logger";
import { retryAsync, BoundedRetryError } from "../utils/retry";
import { fetchWithTimeout } from "../utils/fetch";
import { prepareApiRequest } from "./apiRelay";

const DEEZER_SEARCH_URL = "https://api.deezer.com/search";
const DEEZER_ALBUM_SEARCH_URL = "https://api.deezer.com/search/album";
const DEEZER_TRACK_URL = "https://api.deezer.com/track/";
const DEEZER_ALBUM_URL = "https://api.deezer.com/album/";

// Plain browser-ish fingerprint. The old "compatible; LyriphonBot/1.0; +https://"
// UA is a textbook bot marker and Akamai (which fronts api.deezer.com) scores
// such UAs straight into its WAF. A normal-looking UA keeps the shared-egress
// Worker IPs from being flagged harder than they already are.
const DEEZER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

// HTTP status codes that should trigger a retry
const RETRYABLE_STATUSES = new Set([403, 429, 500, 502, 503, 504]);

// HTML limit pages (Akamai "Access Denied") look like this. 403 + this shape
// is the shared-egress IP being throttled — extra retries make it worse, not
// better, so those get a tight attempt cap instead of the full retry budget.
const EDGE_BLOCK_MARKER = /<title>\s*Access Denied\s*<\/title>/i;
const EDGE_BLOCK_ATTEMPTS = 2;

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

// ── Short-TTL response cache (per isolate) ───────────────────────────────────
//
// The Worker shares egress IPs with every other Cloudflare customer, and Deezer
// rate-scores those IPs. Repeated queries (popular songs, re-taps of the same
// /song query, inline keystrokes re-firing the same prefix) are pure extra
// load. {search|track|album}:{value} → { json, expires } keeps hot responses
// in memory for a couple of minutes instead of re-hitting the API.
//
// Per-isolate like the rest of the module caches; worst case across isolates
// is a duplicate fetch, which is exactly the status quo.
const DEEZER_CACHE_TTL_MS = 120_000;
const deezerCache = new Map<string, { json: any; expires: number }>();

function cacheKey(kind: "search" | "searchAlbums" | "track" | "album", value: string): string {
  return `${kind}:${value}`;
}

function cacheGet(key: string): any | undefined {
  const hit = deezerCache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    deezerCache.delete(key);
    return undefined;
  }
  return hit.json;
}

function cacheSet(key: string, json: any): void {
  // Trim when it grows; the map only ever holds a couple of minutes of traffic.
  if (deezerCache.size > 200) {
    const oldest = deezerCache.keys().next().value;
    if (oldest !== undefined) deezerCache.delete(oldest);
  }
  deezerCache.set(key, { json, expires: Date.now() + DEEZER_CACHE_TTL_MS });
}

// Test hook: the cache is module-level and outlives a single test.
export function resetDeezerCacheForTests(): void {
  deezerCache.clear();
}

function isEdgeBlock(status: number, body: string): boolean {
  return status === 403 && EDGE_BLOCK_MARKER.test(body);
}

async function deezerFetchJson(url: string, label: string): Promise<any | null> {
  try {
    return await retryAsync(async () => {
      const request = prepareApiRequest(
        "deezer",
        url,
        DEEZER_HEADERS,
      );

      const response = await fetchWithTimeout(request.url, {
        headers: request.headers,
        timeoutMs: HTTP_TIMEOUT_MS,
      });

      if (!response.ok) {
        let body = "";
        try {
          body = await response.text();
        } catch {}
        if (RETRYABLE_STATUSES.has(response.status)) {
          if (isEdgeBlock(response.status, body)) {
            // Akamai IP block: one fast retry (a retry may connect through a
            // different edge/IP), then give up — hammering a WAF only deepens
            // the block, and the full 6-attempt budget just delays the user's
            // error banner while the chat is frozen behind it.
            throw new BoundedRetryError(`Deezer ${label} edge-blocked (403)`, EDGE_BLOCK_ATTEMPTS);
          }
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
    }, DEEZER_MAX_RETRIES, 0.4);
  } catch (error) {
    // retryAsync resolves null itself for every exhausted case; the only throw
    // path here is a bug — log it and degrade.
    warn(`Deezer ${label} fetch failed`, error);
    return null;
  }
}

// Cached wrapper around deezerFetchJson.
async function fetchCached(
  kind: "search" | "searchAlbums" | "track" | "album",
  value: string,
  buildUrl: () => string,
  label: string,
): Promise<any | null> {
  const key = cacheKey(kind, value);
  const hit = cacheGet(key);
  if (hit !== undefined) {
    log(`Deezer ${label}: cache hit for`, JSON.stringify(value));
    return hit;
  }
  const data = await deezerFetchJson(buildUrl(), label);
  if (data !== null) {
    cacheSet(key, data);
  }
  return data;
}

export async function searchTracks(query: string, limit = 25) {
  log("Deezer search:", JSON.stringify(query), `limit=${limit}`);
  const data = await fetchCached(
    "search",
    query,
    () => `${DEEZER_SEARCH_URL}?q=${encodeURIComponent(query)}`,
    "search",
  );
  if (!data) {
    log("Deezer search failed (null response) for:", JSON.stringify(query));
    return null;
  }
  const results = (data.data ?? []).slice(0, limit);
  if (!results.length) {
    log("Deezer search: 0 results for:", JSON.stringify(query));
  } else {
    const top = results
      .slice(0, 5)
      .map((t: any) => `${t?.title ?? "?"} — ${t?.artist?.name ?? "?"}`)
      .join("; ");
    const extra = results.length > 5 ? ` (+${results.length - 5} more)` : "";
    log(`Deezer search: ${results.length} result(s) for`, JSON.stringify(query), `→ ${top}${extra}`);
  }
  return results;
}

// Album search for the admin /album picker: results carry id, title,
// artist.name, cover_medium/cover_xl and nb_tracks.
export async function searchAlbums(query: string, limit = 8) {
  log("Deezer album search:", JSON.stringify(query), `limit=${limit}`);
  const data = await fetchCached(
    "searchAlbums",
    query,
    () => `${DEEZER_ALBUM_SEARCH_URL}?q=${encodeURIComponent(query)}`,
    "searchAlbums",
  );
  if (!data) {
    log("Deezer album search failed (null response) for:", JSON.stringify(query));
    return null;
  }
  const results = (data.data ?? []).slice(0, limit);
  if (!results.length) {
    log("Deezer album search: 0 results for:", JSON.stringify(query));
  } else {
    const top = results
      .slice(0, 5)
      .map((a: any) => `${a?.title ?? "?"} — ${a?.artist?.name ?? "?"}`)
      .join("; ");
    const extra = results.length > 5 ? ` (+${results.length - 5} more)` : "";
    log(`Deezer album search: ${results.length} result(s) for`, JSON.stringify(query), `→ ${top}${extra}`);
  }
  return results;
}

export async function getTrack(trackId: number) {
  log("Deezer getTrack:", trackId);
  const track = await fetchCached(
    "track",
    String(trackId),
    () => `${DEEZER_TRACK_URL}${trackId}`,
    "getTrack",
  );
  if (!track) {
    log("Deezer getTrack failed:", trackId);
  } else {
    log(
      "Deezer getTrack ok:",
      trackId,
      `→ "${track.title ?? "?"}" by ${track.artist?.name ?? "?"} (album: ${track.album?.title ?? "?"})`,
    );
  }
  return track;
}

export async function getAlbum(albumId: number) {
  log("Deezer getAlbum:", albumId);
  const album = await fetchCached(
    "album",
    String(albumId),
    () => `${DEEZER_ALBUM_URL}${albumId}`,
    "getAlbum",
  );
  if (!album) {
    log("Deezer getAlbum failed:", albumId);
  } else {
    log("Deezer getAlbum ok:", albumId, `→ "${album.title ?? "?"}" release=${album.release_date ?? "?"}`);
  }
  return album;
}
