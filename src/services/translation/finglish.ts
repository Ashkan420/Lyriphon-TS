import { Env } from "../../env";
import { geminiTranslate } from "./gemini";
import { getCachedFinglish, cacheFinglish } from "../../db/transliterations";
import { debug, warn } from "../../utils/logger";

// Persian/Arabic script range. Used as a cheap gate so non-Farsi (e.g. English)
// queries never touch the cache or Gemini.
const FARSI_REGEX = /[؀-ۿ]/;

export function containsFarsi(text: string): boolean {
  return FARSI_REGEX.test(text);
}

const SYSTEM_PROMPT = `You transliterate Persian/Farsi text into phonetic Latin letters ("Finglish").

STRICT RULES:
- Transliterate the SOUND, do NOT translate the meaning. Example: گل → gol (NOT "flower"), دیوار → divar, خیابان → khiaban.
- Insert the natural short vowels that Persian script omits (e.g. گل is "gol", not "gl").
- Output ONLY the transliteration. No quotes, no explanation, no notes, no original script.
- Keep words that are already in Latin letters unchanged.
- Preserve word order and spacing.`;

/**
 * Pull the Finglish text out of a Gemini response. geminiTranslate forces JSON
 * mode on every call, so the response is {"lines":[{"n":1,"t":"..."}]} — the
 * same envelope the lyrics-translation path parses in combine.ts. Legacy
 * plain-text responses (and mocks) pass through unchanged. Returns null when
 * nothing usable remains: empty, original Farsi script echoed back, or
 * leftover JSON-shaped garbage.
 */
export function extractFinglishText(raw: string): string | null {
  const rawTrimmed = raw?.trim();
  if (!rawTrimmed) {
    return null;
  }

  let text = rawTrimmed;
  try {
    // Strip markdown code fences if Gemini wraps the JSON (same as combine.ts)
    const cleaned = rawTrimmed
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
    const parsed: unknown = JSON.parse(cleaned);
    if (typeof parsed === "string") {
      text = parsed;
    } else if (parsed && typeof parsed === "object") {
      const lines = (parsed as { lines?: unknown }).lines;
      if (!Array.isArray(lines) || lines.length === 0) {
        return null; // JSON object without a usable lines array
      }
      // Join entries and collapse to a single-line search query.
      text = lines
        .map((l: unknown) => {
          const t = (l as { t?: unknown } | null)?.t;
          return typeof t === "string" ? t : "";
        })
        .join("\n");
    }
    // Other parse results (numbers etc.) keep the raw text.
  } catch {
    // Not JSON — plain-text response; keep as-is.
  }

  // A Finglish search query is always single-line, whatever the shape.
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed || FARSI_REGEX.test(collapsed) || /^[{[]/.test(collapsed)) {
    return null;
  }
  return collapsed;
}

/**
 * Transliterate a Farsi string to Finglish. Returns null when the input is not
 * Farsi, Gemini is unconfigured/unavailable, or the output is unusable —
 * callers should fall back to the original query in that case.
 */
export async function transliterateFarsi(env: Env, text: string): Promise<string | null> {
  const trimmed = text?.trim();
  if (!trimmed || !containsFarsi(trimmed)) {
    return null;
  }

  if (!env.GEMINI_API_KEY) {
    debug("transliterateFarsi: GEMINI_API_KEY not configured, skipping");
    return null;
  }

  try {
    const cached = await getCachedFinglish(env.DB, trimmed);
    if (cached) {
      const cleaned = extractFinglishText(cached);
      if (cleaned) {
        debug("transliterateFarsi: cache hit", { text: trimmed, finglish: cleaned });
        if (cleaned !== cached) {
          // Heal rows poisoned by the JSON-mode regression, parsed on read.
          try {
            await cacheFinglish(env.DB, trimmed, cleaned);
          } catch (error) {
            warn("transliterateFarsi: cache heal write failed", error);
          }
        }
        return cleaned;
      }
      warn("transliterateFarsi: cached value unusable, refreshing via Gemini", { text: trimmed });
      // Fall through to a fresh Gemini call; its write replaces the bad row.
    }
  } catch (error) {
    warn("transliterateFarsi: cache read failed", error);
  }

  const result = await geminiTranslate(env, SYSTEM_PROMPT, trimmed);
  if (result.type !== "success") {
    warn("transliterateFarsi: gemini did not succeed", { type: result.type });
    return null;
  }

  const finglish = extractFinglishText(result.text);
  if (!finglish) {
    warn("transliterateFarsi: unusable Gemini output", { snippet: result.text.slice(0, 200) });
    return null;
  }

  try {
    await cacheFinglish(env.DB, trimmed, finglish);
  } catch (error) {
    warn("transliterateFarsi: cache write failed", error);
  }

  debug("transliterateFarsi: success", { text: trimmed, finglish });
  return finglish;
}
