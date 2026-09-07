import { describe, expect, it } from "vitest";
import {
  analyzeLanguages,
  rebaseAnalysisForTarget,
  countUntranslatedLines,
  countIdenticalLines,
  getSourceFragments,
  getSourceFragmentNames,
  getLanguageUiLabel,
} from "../src/services/translation/language-analyzer";
import { composeTranslationPrompt } from "../src/services/translation/prompts";
import { findLanguage } from "../src/services/translation/types";

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

  it("Japanese-dominant song with a Korean bridge keeps the ko hint", () => {
    // Regression for the tinyld switch: tinyld's full pass returns ja:1 and
    // drops Korean entirely (sparse detections), which lost the ko_hint
    // franc used to provide. The Hangul line partition must recover it.
    const lyrics = [
      "君が笑うたびに 世界が輝く",
      "涙のあとには 優しさが咲く",
      "風が運ぶ命の歌を歌う",
      "君の瞳に映る星を数える",
      "明日への道を歩き出すよ",
      "夜の向こうへと続いている",
      "",
      "밤하늘 별들을 세며 너를 생각해",
      "사랑은 멀리서도 느껴지는 거야",
    ].join("\n");
    const result = analyzeLanguages(lyrics)!;
    expect(result.primary.code).toBe("ja");
    expect(result.all.map(d => d.code)).toContain("ko");
    expect(getSourceFragmentNames(result, true).secondary).toContain("ko_hint");
  });

  it("Korean-dominant song with a Japanese bridge pins ko, not ja", () => {
    // Regression for the pin order: SCRIPT_PATTERNS is declaration-ordered
    // and ja is first — first-match-wins pinned kana over the Hangul
    // majority and misranked a mostly-Korean song as ja-primary. The pin
    // must go to the highest-ratio script.
    const lyrics = [
      "밤하늘 별들을 세며 너를 생각해",
      "사랑은 멀리서도 느껴지는 거야",
      "그대여 내 마음을 알아주오",
      "바람이 불어오면 그대 생각이 나",
      "그대여 다시 한번 나를 봐주오",
      "이 밤이 지나도 우리는 이곳에",
      "",
      "明日への道を歩き出すよ",
      "涙のあとには優しさが咲く",
    ].join("\n");
    const result = analyzeLanguages(lyrics)!;
    expect(result.primary.code).toBe("ko");
    expect(result.all.map(d => d.code)).toContain("ja");
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

describe("rebaseAnalysisForTarget", () => {
  // Wild Side (ALI) shape: Japanese-English mixed, en slightly ahead.
  const wildSide = [
    "Mass に合わせた lifestyle 無理でも楽すりゃ不利",
    "Freedom 謳歌 理不尽吹き飛ばす skill これ違う last minute",
    "Merci, au revoir",
    "Kept walking on the wild side",
    "I don't wanna fall asleep throughout my life",
  ].join("\n");

  it("drops the target language and promotes the remainder to primary", () => {
    const analysis = analyzeLanguages(wildSide)!;
    // Sanity: both languages detected with en ahead.
    expect(analysis.primary.code).toBe("en");
    expect(analysis.all.map(d => d.code)).toContain("ja");
    const rebased = rebaseAnalysisForTarget(analysis, "en")!;
    expect(rebased.primary.code).toBe("ja");
    expect(rebased.all.map(d => d.code)).not.toContain("en");
  });

  it("is symmetric: rebasing a ja-primary mix for ja promotes en", () => {
    const analysis = analyzeLanguages(wildSide)!;
    const rebased = rebaseAnalysisForTarget(analysis, "ja")!;
    expect(rebased.primary.code).toBe("en");
    expect(rebased.all.map(d => d.code)).not.toContain("ja");
  });

  it("renormalizes shares so the remainder sums to 1", () => {
    const analysis = analyzeLanguages(wildSide)!;
    const rebased = rebaseAnalysisForTarget(analysis, "en")!;
    const total = rebased.all.reduce((s, d) => s + d.score, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("mostly-fa song with an Arabic remainder rebases to Arabic primary", () => {
    // Realistic shapes: enough fa and ar lines for each to register.
    const fa = "دلم گرفته گیرم بگیر که خوبی و من بسازم دل من\n".repeat(6);
    const ar = "قلبي معك وروحي في سكون الليل وأنت بعيد والليل طويل\n".repeat(4);
    const analysis = analyzeLanguages(fa + ar)!;
    expect(analysis.primary.code).toBe("fa");
    const rebased = rebaseAnalysisForTarget(analysis, "fa")!;
    expect(rebased.primary.code).toBe("ar");
  });

  it("returns the analysis unchanged when the target is not detected", () => {
    const analysis = analyzeLanguages("君が笑うたびに 世界が輝く\n涙のあとには 優しさが咲く")!;
    expect(rebaseAnalysisForTarget(analysis, "en")).toBe(analysis);
  });

  it("returns undefined when nothing translatable remains", () => {
    const analysis = analyzeLanguages("When the morning comes we will rise again\n".repeat(6))!;
    expect(analysis.primary.code).toBe("en");
    expect(rebaseAnalysisForTarget(analysis, "en")).toBeUndefined();
  });

  it("returns undefined for undefined analysis", () => {
    expect(rebaseAnalysisForTarget(undefined, "en")).toBeUndefined();
  });
});

describe("countUntranslatedLines", () => {
  const jaEnOriginal = [
    "Mass に合わせた lifestyle 無理でも楽すりゃ不利",
    "Freedom 謳歌 理不尽吹き飛ばす skill これ違う last minute",
    "Kept walking on the wild side",
    "I don't wanna fall asleep throughout my life",
    "死んでも意味ある if it's after this",
  ];

  it("counts echoed source-script lines as untranslated", () => {
    // Production failure shape: the model returned the lyrics unchanged.
    const { untranslated, scriptLines } = countUntranslatedLines(
      jaEnOriginal,
      jaEnOriginal,
      ["ja"],
    );
    expect(scriptLines).toBe(3); // the three lines containing kana/kanji
    expect(untranslated).toBe(3);
    expect(untranslated / scriptLines).toBeGreaterThan(0.5);
  });

  it("counts a real translation as fully translated", () => {
    const translated = [
      "A lifestyle tailored to the masses, but taking it easy puts me at a disadvantage",
      "Celebrating freedom, blowing away the absurdity with skills",
      "Kept walking on the wild side",
      "I don't wanna fall asleep throughout my life",
      "Even if I die, it has meaning if it's after this",
    ];
    const { untranslated, scriptLines } = countUntranslatedLines(
      jaEnOriginal,
      translated,
      ["ja"],
    );
    expect(scriptLines).toBe(3);
    expect(untranslated).toBe(0);
  });

  it("ignores whitespace and zero-width differences", () => {
    const translated = [...jaEnOriginal];
    translated[0] = "Mass に合わせた lifestyle 無理でも楽すりゃ不利 ​"; // trailing ZWSP
    const { untranslated } = countUntranslatedLines(jaEnOriginal, translated, ["ja"]);
    expect(untranslated).toBe(3); // still counted — only invisible chars differ
  });

  it("returns zeros when no source script is detectable", () => {
    const latin = ["Der ganze Satz ist hier", "Zweite Zeile auch"];
    const { untranslated, scriptLines } = countUntranslatedLines(latin, latin, ["de"]);
    expect(scriptLines).toBe(0);
    expect(untranslated).toBe(0);
  });
});

describe("countIdenticalLines", () => {
  const german = [
    "Der innere Reichtum der Leute ist",
    "Wie ein warmes Kerzenlicht",
    "",
    "Hoffentlich können wir es irgendwann verstehen",
  ];

  it("detects a full echo of a Latin-script song", () => {
    const { identical, nonBlank } = countIdenticalLines(german, german);
    expect(nonBlank).toBe(3);
    expect(identical).toBe(3);
    expect(identical / nonBlank).toBeGreaterThanOrEqual(0.95);
  });

  it("counts a real translation as not echoed", () => {
    const translated = [
      "The inner wealth of people is",
      "Like a warm candlelight",
      "",
      "Hopefully we can understand it someday",
    ];
    const { identical, nonBlank } = countIdenticalLines(german, translated);
    expect(nonBlank).toBe(3);
    expect(identical).toBe(0);
  });

  it("skips blank lines instead of counting them as identical", () => {
    const { identical, nonBlank } = countIdenticalLines(german, [
      "Der innere Reichtum der Leute ist",
      "Wie ein warmes Kerzenlicht",
      "",
      "The blank line above stays blank",
    ]);
    expect(nonBlank).toBe(3);
    expect(identical).toBe(2); // only the first two lines are unchanged
  });
});

describe("composeTranslationPrompt target rebasing", () => {
  it("Wild Side to English: Japanese becomes the source, no English source fragment", () => {
    // Regression for the production log: modules were {source:'en',
    // secondary:['ja_hint']} with target en — the model was told English was
    // the source language and romaji'd the Japanese on its first attempt.
    const lyrics = [
      "Mass に合わせた lifestyle 無理でも楽すりゃ不利",
      "Freedom 謳歌 理不尽吹き飛ばす skill これ違う last minute",
      "Merci, au revoir",
      "Pride は邪魔する猛者, donc vas-y jete ca",
      "全て tryし困憊, 笛に救われ halftime",
      "",
      "Kept walking on the wild side",
      "I don't wanna fall asleep throughout my life",
    ].join("\n");
    const analysis = analyzeLanguages(lyrics)!;
    const target = findLanguage("en")!;
    const { system, modules } = composeTranslationPrompt(lyrics, target, analysis, true);
    expect(modules.source).toBe("ja");
    expect(system).toContain("SOURCE LANGUAGE — JAPANESE");
    // English is the target — an English source/hint fragment must not appear.
    expect(system).not.toContain("ADDITIONAL SOURCE LANGUAGE — ENGLISH");
    expect(modules.secondary).not.toContain("en_hint");
    // Code-switched song: the target language is IN the lyrics, so the
    // mixed-language directive must be present with the anti-romaji rule.
    expect(system).toContain("MIXED SOURCE AND TARGET LANGUAGE");
    expect(system).toContain("This song mixes English with Japanese");
    expect(system).toContain("do NOT transliterate them into Latin script");
  });

  it("Guren to English: no mixed-language block when the target is not in the lyrics", () => {
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
    const analysis = analyzeLanguages(lyrics)!;
    const target = findLanguage("en")!;
    const { system } = composeTranslationPrompt(lyrics, target, analysis, true);
    expect(system).not.toContain("MIXED SOURCE AND TARGET LANGUAGE");
  });

  it("自由の翼 to English: ja primary with the strengthened de hint", () => {
    // Regression for the production log: German verses survived translation
    // because base rule 24's "iconic phrase" exception outranked the hint.
    // The full song is 64 lines with a kana ratio of ~18% (per the log);
    // these are its actual Japanese verses plus the German ones.
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
      "両手には《鋼刃》",
      "唄うのは《凱歌》",
      "背中には《自由の翼》",
      "(Diese elenden Biester)",
      "握り締めた決意を 左胸に",
      "斬り裂くのは《愚行の螺旋》",
      "(Werden vernichtet!)",
      "蒼穹を舞う《自由の翼》",
      "",
      "鳥は飛ぶ為に 其の殻を破ってきた",
      "無様に 地を這う為じゃないだろ？",
      "お前の翼は 何の為にある",
      "籠の中の空は 狭過ぎるだろう？",
      "",
      "Die Freiheit und der Tod",
      "Die beiden sind Zwillinge",
      "Die Freiheit oder der Tod?",
      "Unser Freund ist ein!",
      "",
      "何の為に 生まれて来たのかなんて",
      "小難しい事は 解らないけど",
      "例え 其れが 過ちだったとしても",
      "何の為に 生きているかは 判る",
      "其れは 理屈じゃない",
      "存在 故の「自由」！",
      "",
      "Rechter Weg? Linker Weg?",
      "Na, ein Weg welcher ist?",
      "Der Freund? Der Feind?",
      "Mensch, Sie welche sind?",
      "",
      "隠された真実は 衝撃の嚆矢だ",
      "鎖された其の 深層と",
      "表層に潜む《巨人達》",
      "崩れ然る 固定観念",
      "迷いを 抱きながら",
      "其れでも尚 「自由」へ進め！",
    ].join("\n");
    const analysis = analyzeLanguages(lyrics)!;
    const target = findLanguage("en")!;
    const { system, modules } = composeTranslationPrompt(lyrics, target, analysis, true);
    expect(modules.source).toBe("ja");
    expect(modules.secondary).toContain("de_hint");
    expect(system).toContain('takes precedence over the "iconic phrase" exception');
    expect(system).toContain("SOURCE LANGUAGE — JAPANESE");
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
