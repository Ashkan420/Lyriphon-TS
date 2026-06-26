import { warn } from "../utils/logger";

const DEEZER_SEARCH_URL = "https://api.deezer.com/search";
const DEEZER_TRACK_URL = "https://api.deezer.com/track/";
const DEEZER_ALBUM_URL = "https://api.deezer.com/album/";

async function deezerFetchJson(url: string, label: string): Promise<any | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      warn(`Deezer ${label} HTTP error`, response.status, url);
      return null;
    }
    return await response.json();
  } catch (error) {
    warn(`Deezer ${label} failed`, error);
    return null;
  }
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
