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

  it("detects Arabic by script (Arabic-script text without Persian markers)", () => {
    const lyrics = "قلبي معك وروحي في سكون الليل\nوأنتِ بعيد والليل طويل";
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("ar");
  });

  it("still detects Persian when Persian-exclusive markers are present", () => {
    const lyrics = "دلم گرفته گیرم\nبگیر که خوبی و من بسازم";
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("fa");
  });

  it("detects Mandarin by Han characters only when no kana are present", () => {
    const lyrics = "月光洒在窗台上\n思念像流水一样长\n我望着远方发着呆";
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("zh");
  });

  it("keeps Japanese classification when kana are present alongside kanji", () => {
    // Heavy kanji usage with kana particles — must stay ja, not flip to zh.
    const lyrics = "君の瞳に映る世界は\n静かに時を刻み始める\n風が運ぶ命の歌";
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("ja");
  });

  it("detects Punjabi by Gurmukhi script", () => {
    const lyrics = "ਮੈਨੂੰ ਤੇਰੀ ਲੋੜ ਹੈ ਮੈਨੂੰ ਤੇਰਾ ਪਿਆਰ ਚਾਹੀਦਾ\nਦਿਲ ਦੀਆਂ ਗੱਲਾਂ ਕਰਦੇ ਹਾਂ ਹੌਸਲਾ ਰੱਖ";
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("pa");
  });

  it("detects Tamil by script", () => {
    const lyrics = "நிலவே நிலவே சொல்லாயே\nகாதல் கதை கேட்கிறேன் நான்";
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("ta");
  });

  it("detects Telugu by script", () => {
    const lyrics = "నీ కళ్ళలో నేను చూశాను\nప్రేమ గీతం పాడాను నా హృదయంలో";
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("te");
  });

  it("detects Bengali by script", () => {
    const lyrics = "আমার প্রিয় তুমি কোথায়\nমন ভরে গেছে তোমার স্মৃতিতে";
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("bn");
  });

  it("detects Thai by script", () => {
    const lyrics = "คิดถึงเธอทุกคืนและทุกวัน\nหัวใจของฉันมีแต่เธอเสมอมา";
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("th");
  });

  it("detects Hebrew by script", () => {
    const lyrics = "הלב שלי איתך בכל לילה\nהרוח נושבת לאט בין הצללים";
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("he");
  });

  it("detects Greek via tinyld", () => {
    const lyrics = "Σ' αγαπώ και δεν μπορώ να ζω χωρίς εσένα\n".repeat(6);
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("el");
  });

  it("detects Indonesian via tinyld", () => {
    const lyrics = "Aku mencintaimu dengan sepenuh hatiku\n".repeat(6);
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("id");
  });

  it("detects Polish via tinyld", () => {
    const lyrics = "Kocham cię bardziej niż wczoraj i mniej niż jutro\n".repeat(6);
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    expect(result!.primary.code).toBe("pl");
  });

  it("falls back to tinyld for Latin-script languages", () => {
    const lyrics =
      "When the morning comes we will rise again\n" +
      "Through the shadows and the pouring rain\n".repeat(8);
    const result = analyzeLanguages(lyrics);
    expect(result).toBeDefined();
    // tinyld should identify English given enough repeated Latin text
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

  // ── Real-song regressions (lyrics fetched from LRCLIB) ────────────────────

  it("Vogel Im Käfig: pure German song stays single with no Dutch hint", () => {
    // Regression: franc scored de 1.00 / nl 0.94 (nearly tied Germanic
    // scores), which classified this as bilingual and injected a bogus
    // nl_hint into the translation prompt. tinyld's calibrated scores put
    // da/no at ~0.002 so the MIN_SCORE filter drops them.
    const lyrics = [
      "Der innere Reichtum der Leute ist",
      "Wie Licht bunt, durch Farbgies hereinzuscheinen",
      "Das angeneme tägliche Leben Ist",
      "Wie ein warmes Kerzenlicht",
      "",
      "Die sehr weite grüne Erde",
      "Das reiche schöne Wasser",
      "Die grandjose Natur sorgt immer noch für ihre Kinder",
      "",
      "Hoffentlich können wir es irgendwann verstehen",
      "Dieses sinnerfüllte Leben",
      "",
      "Die Feindseligkeit, die uns trennt",
      "Der 一つの大陸 —— Die Wand",
    ].join("\n");
    const result = analyzeLanguages(lyrics)!;
    expect(result.primary.code).toBe("de");
    expect(result.mode).toBe("single");
    expect(getSourceFragmentNames(result, true)).toEqual({ source: "de", secondary: ["none"] });
  });

  it("Guren no Yumiya: Japanese primary, iconic German opener does not hijack", () => {
    // The song opens with German ("Seid ihr das Essen?") but is overwhelmingly
    // Japanese — script detection pins ja and the model must not flip it.
    const lyrics = [
      "Seid ihr das Essen? Nein, wir sind der Jäger!",
      "Feuerroter pfeil und bogen...",
      "",
      "踏まれた花の 名前も知らずに",
      "地に墜ちた落ちた鳥は 風を待ちわびる",
      "祈ったところで 何も変わらない",
      "《不本意な現状》を変えるのは 戦う覚悟だ...",
      "",
      "屍踏み越えて",
      "進む意思を 嗤う豚よ",
      "家畜の安寧 虚偽の繁栄",
      "死せる餓狼の 自由を!",
    ].join("\n");
    const result = analyzeLanguages(lyrics)!;
    expect(result.primary.code).toBe("ja");
    expect(getSourceFragmentNames(result, true).source).toBe("ja");
  });

  it("自由の翼: Japanese + German verses keep both languages in the analysis", () => {
    // Genuine bilingual song — German opening verses + Japanese body. ja is
    // primary (kana script pin) and German must remain a meaningful secondary
    // so the de hint fragment reaches the prompt.
    const lyrics = [
      "O mein Freund! Jetzt hier ist ein Sieg",
      "Dies ist der grosses Gloria",
      "O, mein Freund! Feiern wir diesen Sieg",
      "Fur den nachsten Kampf!",
      "",
      "「無意味な死であった」と 言わせない",
      "最後の《一矢》になるまで",
      "",
      "Der feind ist grausam Wir bringen",
      "Der feind ist riesig Wir springen",
      "",
      "Jeder von uns ist eine Feder",
      "Fliegt an der Hoffnung",
      "",
      "屑のままの 意思でも",
      "本物の《剣》になるまで",
    ].join("\n");
    const result = analyzeLanguages(lyrics)!;
    expect(result.primary.code).toBe("ja");
    expect(result.all.map(d => d.code)).toContain("de");
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
