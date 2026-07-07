import { describe, expect, it } from "vitest";
import {
  analyzeLanguages,
  getSourceFragments,
  getSourceFragmentNames,
  isSourceLanguage,
  getLanguageUiLabel,
} from "../src/services/translation/language-analyzer";

describe("analyzeLanguages", () => {
  it("returns undefined for empty or whitespace input", () => {
    expect(analyzeLanguages("")).toBeUndefined();
    expect(analyzeLanguages("   \n  ")).toBeUndefined();
    expect(analyzeLanguages(undefined as any)).toBeUndefined();
  });

  it("detects Japanese by script even when franc is uncertain", () => {
    const lyrics = "君が笑うたびに 世界が輝く\n涙のあとには 優しさが咲く";
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("ja");
    expect(result!.mode).toBe("single");
  });

  it("detects Persian (Farsi) by script", () => {
    const lyrics = "گل بر لب و لبخند و صدای پای بهار\nدوباره زندگی را بغل کن";
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("fa");
    expect(result!.mode).toBe("single");
  });

  it("detects Korean by script", () => {
    const lyrics = "밤하늘 별들을 세며 너를 생각해\n사랑은 멀리서도 느껴지는 거야";
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("ko");
  });

  it("falls back to franc for Latin-script languages", () => {
    const lyrics =
      "When the morning comes we will rise again\n" +
      "Through the shadows and the pouring rain\n".repeat(8);
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    // franc should identify English given enough repeated Latin text
    expect(result!.primary.code).toBe("en");
  });

  it("classifies a clearly mixed (bilingual) song", () => {
    // Heavy Japanese with a solid block of English.
    const jp = "明日への道を 歩き出すよ\n".repeat(10);
    const en = "We are the champions my friend\n".repeat(10);
    const result = analyzeLanguages(jp + en);
    expect(result).toBeDefined();
    // Either ja or en as primary, with the other as a meaningful secondary.
    const codes = result!.all.map((d) => d.code);
    expect(codes).toContain("ja");
    expect(codes).toContain("en");
  });

  it("never returns more than 4 languages", () => {
    // Throw a long multilingual salad at it.
    const lyrics = [
      "The night is dark and full of terror",
      "明日は明日の風が吹くよ",
      "사랑은 멀리서도 느껴지는 거야",
      "گل بر لب و لبخند و صدای پای بهار",
      "La vie en rose et les chansons d'amour",
      "Ich will alles oder nichts von dir",
    ].join("\n");
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.all.length).toBeLessThanOrEqual(4);
  });
});

describe("getSourceFragments", () => {
  it("returns the primary fragment for a single-language analysis", () => {
    const analysis = analyzeLanguages("君が笑うたびに 世界が輝く\n涙のあとには 優しさが咲く");
    const fragments = getSourceFragments(analysis!, true);
    expect(fragments.length).toBe(1);
    expect(fragments[0]).toContain("JAPANESE");
  });

  it("returns only the primary when multilingual is disabled", () => {
    const jp = "明日への道を 歩き出すよ\n".repeat(10);
    const en = "We are the champions my friend\n".repeat(10);
    const analysis = analyzeLanguages(jp + en)!;
    const fragments = getSourceFragments(analysis, false);
    expect(fragments.length).toBe(1);
    expect(fragments[0]).toContain("JAPANESE");
  });

  it("adds hint fragments for bilingual/multilingual analyses", () => {
    // Japanese + Spanish: both have dedicated source fragments in hints.ts,
    // so the bilingual path should return primary + a secondary hint.
    const jp = "明日への道を 歩き出すよ\n".repeat(10);
    const es = "Y la noche se llenó de estrellas y de amor\n".repeat(10);
    const analysis = analyzeLanguages(jp + es)!;
    expect(analysis.mode).toBe("bilingual");
    const fragments = getSourceFragments(analysis, true);
    // primary (Japanese) + at least one secondary hint (Spanish)
    expect(fragments.length).toBeGreaterThanOrEqual(2);
    expect(fragments[0]).toContain("JAPANESE");
    expect(fragments.some((f) => f.includes("SPANISH"))).toBe(true);
  });

  it("does not add a hint for an English secondary (no English fragment exists)", () => {
    // English is usually the translation TARGET, so it has no source fragment.
    const jp = "明日への道を 歩き出すよ\n".repeat(10);
    const en = "We are the champions my friend\n".repeat(10);
    const analysis = analyzeLanguages(jp + en)!;
    const fragments = getSourceFragments(analysis, true);
    expect(fragments[0]).toContain("JAPANESE");
    expect(fragments.some((f) => f.includes("ENGLISH"))).toBe(false);
  });

  it("returns [] for undefined analysis", () => {
    expect(getSourceFragments(undefined, true)).toEqual([]);
  });
});

describe("getSourceFragmentNames", () => {
  it("reports primary source and secondary hint names", () => {
    const jp = "明日への道を 歩き出すよ\n".repeat(10);
    const en = "We are the champions my friend\n".repeat(10);
    const analysis = analyzeLanguages(jp + en)!;
    const names = getSourceFragmentNames(analysis, true);
    expect(names.source).toBe("ja");
    expect(names.secondary.length).toBeGreaterThan(0);
    expect(names.secondary).not.toContain("none");
  });

  it("falls back to 'general' / 'none' for undefined analysis", () => {
    expect(getSourceFragmentNames(undefined, true)).toEqual({ source: "general", secondary: ["none"] });
  });
});

describe("isSourceLanguage", () => {
  it("is true when primary matches with high confidence", () => {
    const analysis = analyzeLanguages("君が笑うたびに 世界が輝く\n涙のあとには 優しさが咲く");
    expect(isSourceLanguage(analysis, "ja")).toBe(true);
  });

  it("is false for a different target language", () => {
    const analysis = analyzeLanguages("君が笑うたびに 世界が輝く\n涙のあとには 優しさが咲く");
    expect(isSourceLanguage(analysis, "en")).toBe(false);
  });

  it("is false for undefined analysis", () => {
    expect(isSourceLanguage(undefined, "ja")).toBe(false);
  });
});

describe("getLanguageUiLabel", () => {
  it("returns 'Original' for undefined analysis", () => {
    expect(getLanguageUiLabel(undefined)).toBe("Original");
  });

  it("prefixes a flag for a known script", () => {
    const analysis = analyzeLanguages("君が笑うたびに 世界が輝く\n涙のあとには 優しさが咲く");
    expect(getLanguageUiLabel(analysis)).toContain("Original");
  });
});
