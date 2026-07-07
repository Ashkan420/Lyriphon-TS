import { warn } from "../../utils/logger";

const SECTION_LABEL_RE = /^\[.+\]$/;

function isSectionLabel(line: string): boolean {
  return SECTION_LABEL_RE.test(line.trim());
}

function normalizeLine(line: string): string {
  return line.replace(/​/g, "").replace(/‌/g, "").trimEnd();
}

function stripTrailingPunctuation(s: string): string {
  return s.trim().replace(/[.,!?;:'")\]]+$/, "");
}

// Pair original lyrics lines with their translations.
//
// Aligned path (identical line count, matching section labels, aligned blanks):
// interleave verbatim — section labels and blanks pass through, and a line whose
// translation differs from the original is bracketed ([translation]) so it reads
// as an annotation rather than a duplicate.
//
// Misaligned path (Gemini drifted): instead of dropping the whole translation we
// degrade gracefully and append it as a separate block, so the user still gets it.
// Returns null ONLY when the translation is empty.

const CRLF = "\r\n";

function fallbackBlock(original: string, translation: string): string {
  return `${original}\n\n— — —\n\n${translation}`;
}

export function combineLyricsWithTranslation(originalLyrics: string, translatedLyrics: string): string | null {
  if (!translatedLyrics || !translatedLyrics.trim()) {
    return null;
  }

  const originalLines = originalLyrics
    .replace(CRLF, "\n")
    .split("\n")
    .map(normalizeLine);

  const translatedLines = translatedLyrics
    .replace(CRLF, "\n")
    .split("\n")
    .map(normalizeLine);

  while (originalLines.length > 0 && originalLines[originalLines.length - 1].trim() === "") {
    originalLines.pop();
  }
  while (translatedLines.length > 0 && translatedLines[translatedLines.length - 1].trim() === "") {
    translatedLines.pop();
  }

  if (originalLines.length !== translatedLines.length) {
    warn("combineLyrics: line count mismatch, attaching translation as separate block", {
      originalCount: originalLines.length,
      translatedCount: translatedLines.length,
    });
    return fallbackBlock(originalLyrics, translatedLyrics);
  }

  for (let i = 0; i < originalLines.length; i++) {
    const orig = originalLines[i];
    const trans = translatedLines[i];

    if (isSectionLabel(orig)) {
      if (trans.trim() !== orig.trim()) {
        warn("combineLyrics: section label mismatch, attaching translation as separate block", {
          line: i,
          original: orig.trim(),
          translated: trans.trim(),
        });
        return fallbackBlock(originalLyrics, translatedLyrics);
      }
    }

    if (orig.trim() === "" && trans.trim() !== "") {
      warn("combineLyrics: blank line position mismatch, attaching translation as separate block", { line: i });
      return fallbackBlock(originalLyrics, translatedLyrics);
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
      if (stripTrailingPunctuation(trans) !== stripTrailingPunctuation(orig)) {
        parts.push(`[${trans}]`);
      }
    }
  }

  return parts.join("\n");
}