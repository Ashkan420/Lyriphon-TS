export const FLAG_MAP: Record<string, string> = {
  en: "🇬🇧", fa: "🇮🇷", ja: "🇯🇵", ko: "🇰🇷",
  es: "🇪🇸", fr: "🇫🇷", de: "🇩🇪", pt: "🇧🇷",
  ar: "🇸🇦", tr: "🇹🇷", hi: "🇮🇳", it: "🇮🇹",
  ru: "🇷🇺", zh: "🇨🇳",
};

export function getFlag(code: string): string {
  return FLAG_MAP[code] ?? "";
}
