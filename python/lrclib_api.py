"""LRCLIB API client — fetch synced/plain lyrics with automatic retries."""

import httpx
from utils.retry import retry_async

LRCLIB_SEARCH = "https://lrclib.net/api/search"

_client = httpx.AsyncClient(timeout=15.0)


class _NoLyricsFound(Exception):
    """Raised when a search returns no usable lyrics, to trigger a retry."""


async def get_lyrics(track: str, artist: str, retries: int = 2, delay: float = 2.0):
    """Search LRCLIB for lyrics by *track* and *artist* name.

    Returns plain or synced lyrics string, or None if nothing is found
    after all retry attempts.
    """
    async def _fetch():
        r = await _client.get(
            LRCLIB_SEARCH,
            params={"track_name": track, "artist_name": artist},
        )
        r.raise_for_status()
        results = r.json()

        if results:
            best = results[0]
            lyrics = best.get("plainLyrics") or best.get("syncedLyrics")
            if lyrics:
                return lyrics
        raise _NoLyricsFound()

    return await retry_async(_fetch, retries=retries, delay=delay)
