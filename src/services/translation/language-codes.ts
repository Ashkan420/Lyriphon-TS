/**
 * Single source of truth for all ISO 639-1 codes the bot recognizes.
 * Imported by: language-analyzer.ts, gemini-detect.ts
 */
export const DETECTION_CODES: Record<string, string> = {
  en: "English", fa: "Persian", ja: "Japanese", ko: "Korean",
  es: "Spanish", fr: "French", de: "German", pt: "Portuguese",
  ar: "Arabic", tr: "Turkish", hi: "Hindi", it: "Italian",
  ru: "Russian", zh: "Chinese", nl: "Dutch", da: "Danish",
  sv: "Swedish", no: "Norwegian", pl: "Polish", uk: "Ukrainian",
  th: "Thai", vi: "Vietnamese", id: "Indonesian", ms: "Malay",
  bn: "Bengali", ta: "Tamil", te: "Telugu", ro: "Romanian",
  cs: "Czech", sk: "Slovak", hu: "Hungarian", fi: "Finnish",
  el: "Greek", he: "Hebrew", bg: "Bulgarian", hr: "Croatian",
  sr: "Serbian", sl: "Slovenian", lt: "Lithuanian", lv: "Latvian",
  et: "Estonian", ca: "Catalan", af: "Afrikaans", sq: "Albanian",
  hy: "Armenian", ka: "Georgian", km: "Khmer", ur: "Urdu",
  ku: "Kurdish", cy: "Welsh", ga: "Irish", is: "Icelandic",
};

export const VALID_DETECTION_CODES = new Set(Object.keys(DETECTION_CODES));
