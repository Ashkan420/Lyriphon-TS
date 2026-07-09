import { warn } from "../../utils/logger";

const SECTION_LABEL_RE = /^\[.+\]$/;

function isSectionLabel(line: string): boolean {
  return SECTION_LABEL_RE.test(line.trim());
}

function normalizeLine(line: string): string {
  return line.replace(/\u200B/g, "").replace(/\u200C/g, "").trimEnd();
}

function stripTrailingPunctuation(s: string): string {
  return s.trim().replace(/[.,!?;:'")\]]+$/, "");
}

const CRLF = "\r\n";

// ── JSON translation parsing ────────────────────────────────────────────────

interface JsonLine {
  n: number;
  t: string;
}

interface JsonTranslation {
  lines: JsonLine[];
}

/**
 * Parse a JSON translation response from Gemini. Returns the extracted
 * translation lines joined by newline, or null if the JSON is invalid or
 * the line count doesn't match the original.
 */
export function parseTranslationJson(
  rawJson: string,
  originalLineCount: number,
): string | null {
  let parsed: JsonTranslation;
  try {
    // Strip markdown code fences if Gemini wraps the JSON
    const cleaned = rawJson
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    warn("parseTranslationJson: invalid JSON", { snippet: rawJson.slice(0, 200) });
    return null;
  }

  if (!Array.isArray(parsed?.lines) || parsed.lines.length === 0) {
    warn("parseTranslationJson: missing or empty lines array");
    return null;
  }

  if (parsed.lines.length !== originalLineCount) {
    warn("parseTranslationJson: line count mismatch", {
      expected: originalLineCount,
      got: parsed.lines.length,
    });
    return null;
  }

  // Validate every entry has n and t, and n is sequential
  for (let i = 0; i < parsed.lines.length; i++) {
    const entry = parsed.lines[i];
    if (typeof entry.n !== "number" || typeof entry.t !== "undefined" && typeof entry.t !== "string") {
      warn("parseTranslationJson: invalid entry at index", { index: i, entry });
      return null;
    }
    if (entry.n !== i + 1) {
      warn("parseTranslationJson: out-of-order line number", { expected: i + 1, got: entry.n });
      return null;
    }
  }

  return parsed.lines.map((l) => l.t).join("\n");
}

// ── Text-based combine (legacy, used for cache fallback) ────────────────────

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

export interface CombineResult {
  combined: string;
  mismatch: boolean;
}

function fallbackBlock(original: string, translation: string): string {
  return `${original}\n\n— — —\n\n${translation}`;
}

export function combineLyricsWithTranslation(originalLyrics: string, translatedLyrics: string): CombineResult | null {
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
    return { combined: fallbackBlock(originalLyrics, translatedLyrics), mismatch: true };
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
        return { combined: fallbackBlock(originalLyrics, translatedLyrics), mismatch: true };
      }
    }

    if (orig.trim() === "" && trans.trim() !== "") {
      warn("combineLyrics: blank line position mismatch, attaching translation as separate block", { line: i });
      return { combined: fallbackBlock(originalLyrics, translatedLyrics), mismatch: true };
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

  return { combined: parts.join("\n"), mismatch: false };
}

// ── JSON-based combine ──────────────────────────────────────────────────────

/**
 * Combine original lyrics with a JSON-parsed translation.
 * Since JSON guarantees the correct line count, this never produces a
 * mismatch — it either succeeds or returns null.
 */
export function combineLyricsFromJson(
  originalLyrics: string,
  translatedLines: string[],
): CombineResult | null {
  if (!translatedLines.length) {
    return null;
  }

  const originalLines = originalLyrics
    .replace(CRLF, "\n")
    .split("\n")
    .map(normalizeLine);

  // Trim trailing blanks from both sides before interleaving
  while (originalLines.length > 0 && originalLines[originalLines.length - 1].trim() === "") {
    originalLines.pop();
  }

  const parts: string[] = [];
  for (let i = 0; i < originalLines.length; i++) {
    const orig = originalLines[i];
    const trans = translatedLines[i] ?? "";

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

  return { combined: parts.join("\n"), mismatch: false };
}
