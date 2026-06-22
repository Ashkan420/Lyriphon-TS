const DEEZER_SEARCH_URL = "https://api.deezer.com/search";
const DEEZER_TRACK_URL = "https://api.deezer.com/track/";
const DEEZER_ALBUM_URL = "https://api.deezer.com/album/";

export async function searchTracks(query: string, limit = 25) {
  try {
    const response = await fetch(`${DEEZER_SEARCH_URL}?q=${encodeURIComponent(query)}`);
    if (!response.ok) {
      console.warn("Deezer search HTTP error", response.status, query);
      return null;
    }
    const data = await response.json() as any;
    return (data.data ?? []).slice(0, limit);
  } catch (error) {
    console.warn("Deezer search failed", error);
    return null;
  }
}

export async function getTrack(trackId: number) {
  try {
    const response = await fetch(`${DEEZER_TRACK_URL}${trackId}`);
    if (!response.ok) {
      console.warn("Deezer getTrack HTTP error", response.status, trackId);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn("Deezer getTrack failed", error);
    return null;
  }
}

export async function getAlbum(albumId: number) {
  try {
    const response = await fetch(`${DEEZER_ALBUM_URL}${albumId}`);
    if (!response.ok) {
      console.warn("Deezer getAlbum HTTP error", response.status, albumId);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn("Deezer getAlbum failed", error);
    return null;
  }
}
