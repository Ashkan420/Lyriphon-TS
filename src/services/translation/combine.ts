const SECTION_LABEL_RE = /^\[.+\]$/;

function isSectionLabel(line: string): boolean {
  return SECTION_LABEL_RE.test(line.trim());
}

function normalizeLine(line: string): string {
  return line.replace(/\u200B/g, "").replace(/\u200C/g, "").trimEnd();
}

export function combineLyricsWithTranslation(
  originalLyrics: string,
  translatedLyrics: string,
): string | null {
  const originalLines = originalLyrics
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(normalizeLine);

  const translatedLines = translatedLyrics
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(normalizeLine);

  while (originalLines.length > 0 && originalLines[originalLines.length - 1].trim() === "") {
    originalLines.pop();
  }
  while (translatedLines.length > 0 && translatedLines[translatedLines.length - 1].trim() === "") {
    translatedLines.pop();
  }

  if (originalLines.length !== translatedLines.length) {
    console.warn("combineLyrics: line count mismatch", {
      originalCount: originalLines.length,
      translatedCount: translatedLines.length,
      originalLines: originalLines.map((l, i) => `${i}: ${l}`),
      translatedLines: translatedLines.map((l, i) => `${i}: ${l}`),
    });
    return null;
  }

  for (let i = 0; i < originalLines.length; i++) {
    const orig = originalLines[i];
    const trans = translatedLines[i];

    if (isSectionLabel(orig)) {
      if (trans.trim() !== orig.trim()) {
        console.warn("combineLyrics: section label mismatch", {
          line: i,
          original: orig.trim(),
          translated: trans.trim(),
        });
        return null;
      }
    }

    if (orig.trim() === "" && trans.trim() !== "") {
      console.warn("combineLyrics: blank line position mismatch", { line: i });
      return null;
    }
  }

  const parts: string[] = [];
  for (let i = 0; i < originalLines.length; i++) {
    const orig = originalLines[i];
    const trans = translatedLines[i];

    if (isSectionLabel(orig)) {
      parts.push(orig);
    } else if (orig.trim() === "") {
      parts.push("");
    } else {
      parts.push(orig);
      parts.push(`[${trans}]`);
    }
  }

  return parts.join("\n");
}
