export type LanguageCode = "en" | "fa";

export interface SupportedLanguage {
  code: LanguageCode;
  name: string;
  nativeName: string;
}

export interface TranslationProvider {
  name: string;
  translate(text: string, targetLang: LanguageCode, sourceLang?: LanguageCode): Promise<string | null>;
}

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "fa", name: "Persian", nativeName: "فارسی" },
];

export function findLanguage(code: string): SupportedLanguage | undefined {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code);
}
