export const FLAG_MAP: Record<string, string> = {
  eng: "🇬🇧", fas: "🇮🇷", jpn: "🇯🇵", kor: "🇰🇷",
  spa: "🇪🇸", fra: "🇫🇷", deu: "🇩🇪", por: "🇧🇷",
  ara: "🇸🇦", tur: "🇹🇷", hin: "🇮🇳", ita: "🇮🇹",
  rus: "🇷🇺", zho: "🇨🇳", pes: "🇮🇷",
};

export const FRANC_TO_LANG: Record<string, string> = {
  eng: "en", fas: "fa", pes: "fa"
};

export function getFlag(francCode: string): string {
  return FLAG_MAP[francCode] ?? "";
}
