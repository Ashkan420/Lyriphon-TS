import { francAll } from "franc";

const FLAG_MAP: Record<string, string> = {
  eng: "🇬🇧", fas: "🇮🇷", jpn: "🇯🇵", kor: "🇰🇷",
  spa: "🇪🇸", fra: "🇫🇷", deu: "🇩🇪", por: "🇧🇷",
  ara: "🇸🇦", tur: "🇹🇷", hin: "🇮🇳", ita: "🇮🇹",
  rus: "🇷🇺", zho: "🇨🇳", pes: "🇮🇷",
};

const FRANC_TO_LANG: Record<string, string> = {
  eng: "en", fas: "fa", pes: "fa"
};

const CONFIDENCE_THRESHOLD = 0.8;
const MIN_LENGTH = 50;

export function detectLanguage(lyrics: string): string | null {
  const results = francAll(lyrics, { minLength: MIN_LENGTH });
  if (!results.length) return null;
  const [code, score] = results[0];
  if (score < CONFIDENCE_THRESHOLD) return null;
  return code;
}

export function getFlag(francCode: string): string {
  return FLAG_MAP[francCode] ?? "";
}

export function isLanguageDetected(
  detectedFranc: string | undefined,
  targetLangCode: string,
): boolean {
  if (!detectedFranc) return false;
  return FRANC_TO_LANG[detectedFranc] === targetLangCode;
}
