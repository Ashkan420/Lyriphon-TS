export const FLAG_MAP: Record<string, string> = {
  en: "🇬🇧", fa: "🇮🇷", ja: "🇯🇵", ko: "🇰🇷",
  es: "🇪🇸", fr: "🇫🇷", de: "🇩🇪", pt: "🇧🇷",
  ar: "🇸🇦", tr: "🇹🇷", hi: "🇮🇳", it: "🇮🇹",
  ru: "🇷🇺", zh: "🇨🇳",
  pa: "🇮🇳", ta: "🇮🇳", te: "🇮🇳", bn: "🇧🇩",
  th: "🇹🇭", he: "🇮🇱", id: "🇮🇩", vi: "🇻🇳",
  tl: "🇵🇭", el: "🇬🇷", pl: "🇵🇱", sv: "🇸🇪",
  sr: "🇷🇸", hr: "🇭🇷",
};

export function getFlag(code: string): string {
  return FLAG_MAP[code] ?? "";
}
