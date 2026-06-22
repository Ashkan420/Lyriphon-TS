export function formatLyricsForTelegraph(lyrics: string): string {
  if (!lyrics) {
    return "<p>Lyrics not found.</p>";
  }

  let escaped = escapeHtml(lyrics);
  escaped = escaped.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const segments = escaped.split(/\n\s*\n/);

  const htmlParts: string[] = [];
  segments.forEach((segment, i) => {
    const lines = segment.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      htmlParts.push(`<p>${line}</p>`);
    }
  });

  return htmlParts.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
