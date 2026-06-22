"""Telegraph page creation and editing for song lyrics."""

import html

from telegraph import Telegraph
from config import TELEGRAPH_ACCESS_TOKEN, CHANNEL_LINK, DEEZLOAD_BOT
from utils.url_validation import _is_valid_image_url, _safe_link
from services.lyrics_formatter import format_lyrics_for_telegraph
from utils.retry import retry_sync

telegraph = Telegraph(access_token=TELEGRAPH_ACCESS_TOKEN)


def create_song_telegraph(
    author_name: str,
    track: str,
    track_id: int,
    artist: str,
    artist_id: int,
    album: str,
    album_id: int,
    album_cover_url: str,
    release_date: str,
    lyrics: str,
    retries: int = 2,
    delay: float = 2.0
):
    """
    Create a Telegraph page for a song and return the URL and path.
    """
    track_link = f"{DEEZLOAD_BOT}deezerttrack{track_id}"
    artist_link = f"{DEEZLOAD_BOT}deezertartist{artist_id}"
    album_link = f"{DEEZLOAD_BOT}deezertalbum{album_id}"

    formatted_lyrics = format_lyrics_for_telegraph(lyrics)

    html_content = _build_html_page(
        track,
        artist,
        album,
        release_date,
        album_cover_url,
        track_link,
        artist_link,
        album_link,
        formatted_lyrics
    )

    response = retry_sync(
        lambda: telegraph.create_page(
            title=track,
            author_name=author_name,
            author_url=CHANNEL_LINK,
            html_content=html_content,
        ),
        retries=retries,
        delay=delay,
    )

    url = "https://telegra.ph/" + response["path"]
    path = response["path"]
    
    last_data = {
        "author_name": author_name,
        "track": track,
        "track_link": track_link,
        "artist": artist,
        "artist_link": artist_link,
        "album": album,
        "album_link": album_link,
        "album_cover_url": album_cover_url,
        "release_date": release_date,
        "path": path
    }

    return url, path, last_data


def edit_song_page(last_data: dict, lyrics: str, retries: int = 2, delay: float = 2.0):
    """Update an existing Telegraph page with new lyrics content."""
    formatted_lyrics = format_lyrics_for_telegraph(lyrics)

    html_content = _build_html_page(
        track=last_data["track"],
        artist=last_data["artist"],
        album=last_data["album"],
        release_date=last_data["release_date"],
        album_cover_url=last_data["album_cover_url"],
        track_link=last_data["track_link"],
        artist_link=last_data["artist_link"],
        album_link=last_data["album_link"],
        formatted_lyrics=formatted_lyrics
    )

    _debug_print(html_content)

    retry_sync(
        lambda: telegraph.edit_page(
            path=last_data["path"],
            title=last_data["track"],
            html_content=html_content,
            author_name=last_data["author_name"],
            author_url=CHANNEL_LINK,
        ),
        retries=retries,
        delay=delay,
    )


def _build_html_page(
    track,
    artist,
    album,
    release_date,
    album_cover_url,
    track_link,
    artist_link,
    album_link,
    formatted_lyrics
):
    """Assemble the full HTML body for a Telegraph song page."""
    # Cover image (only if valid image URL)
    cover_html = ""
    if _is_valid_image_url(album_cover_url):
        cover_html = f'<img src="{album_cover_url}"><br>'

    # Safe links (plain text if URL removed)
    track_html = _safe_link(track, track_link)
    artist_html = _safe_link(artist, artist_link)
    album_html = _safe_link(album, album_link)

    safe_date = html.escape(str(release_date)) if release_date else ""

    track_section = f'<p><strong>🎧 Track:</strong> {track_html}</p>' if track else ""
    artist_section = f'<p><strong>👤 Artist:</strong> {artist_html}</p>' if artist else ""
    album_section = f'<p><strong>💽 Album:</strong> {album_html}</p>' if album else ""
    date_section = f'<p><strong>📅 Date:</strong> {safe_date}</p>' if release_date else ""

    return f"""
{cover_html}

{track_section}
{artist_section}
{album_section}
{date_section}

<hr>
<h3>Lyrics</h3>

{formatted_lyrics}
"""


def _debug_print(html_content: str):
    print("\n" + "=" * 40)
    print("TELEGRAPH HTML CONTENT:")
    print("=" * 40)
    print(html_content)
    print("=" * 40 + "\n")
