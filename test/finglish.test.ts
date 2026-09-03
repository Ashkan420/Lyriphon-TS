import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { containsFarsi, extractFinglishText, transliterateFarsi } from "../src/services/translation/finglish";
import * as gemini from "../src/services/translation/gemini";
import * as cache from "../src/db/transliterations";
import { Env } from "../src/env";

function makeEnv(): Env {
  return { GEMINI_API_KEY: "test-key", DB: {} as any } as Env;
}

describe("containsFarsi", () => {
  it("is true for Farsi text", () => {
    expect(containsFarsi("گل")).toBe(true);
    expect(containsFarsi("دیوار")).toBe(true);
  });

  it("is false for Latin text", () => {
    expect(containsFarsi("gol")).toBe(false);
    expect(containsFarsi("hello world")).toBe(false);
  });
});

describe("extractFinglishText", () => {
  it("extracts the text from a JSON-mode response", () => {
    expect(extractFinglishText('{"lines":[{"n":1,"t":"yare dabestani"}]}')).toBe("yare dabestani");
  });

  it("joins multi-entry lines into a single-line query", () => {
    expect(
      extractFinglishText('{"lines":[{"n":1,"t":"bala"},{"n":2,"t":"nishtuni"}]}'),
    ).toBe("bala nishtuni");
  });

  it("unwraps a JSON string body", () => {
    expect(extractFinglishText('"gol"')).toBe("gol");
  });

  it("strips markdown fences around the JSON", () => {
    expect(extractFinglishText('```json\n{"lines":[{"n":1,"t":"gol"}]}\n```')).toBe("gol");
  });

  it("passes plain text through unchanged", () => {
    expect(extractFinglishText(" gol \n")).toBe("gol");
  });

  it("collapses newlines from a multi-line plain-text response", () => {
    expect(extractFinglishText("yare\ndabestani")).toBe("yare dabestani");
  });

  it("returns null for empty input", () => {
    expect(extractFinglishText("")).toBeNull();
    expect(extractFinglishText("   ")).toBeNull();
  });

  it("returns null for JSON without a usable lines array", () => {
    expect(extractFinglishText('{"foo":"bar"}')).toBeNull();
    expect(extractFinglishText('{"lines":[]}')).toBeNull();
  });

  it("returns null when the output still contains Farsi script", () => {
    expect(extractFinglishText('{"lines":[{"n":1,"t":"یار dabestani"}]}')).toBeNull();
    expect(extractFinglishText("گل")).toBeNull();
  });

  it("returns null for leftover JSON-shaped garbage", () => {
    expect(extractFinglishText('{"lines":"nope"}')).toBeNull();
  });
});

describe("transliterateFarsi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for non-Farsi input without touching the cache or Gemini", async () => {
    const getSpy = vi.spyOn(cache, "getCachedFinglish");
    const geminiSpy = vi.spyOn(gemini, "geminiTranslate");
    expect(await transliterateFarsi(makeEnv(), "gol")).toBeNull();
    expect(getSpy).not.toHaveBeenCalled();
    expect(geminiSpy).not.toHaveBeenCalled();
  });

  it("returns null when GEMINI_API_KEY is missing", async () => {
    const geminiSpy = vi.spyOn(gemini, "geminiTranslate");
    const env = { DB: {} as any } as Env;
    expect(await transliterateFarsi(env, "گل")).toBeNull();
    expect(geminiSpy).not.toHaveBeenCalled();
  });

  it("returns cached value without calling Gemini on a cache hit", async () => {
    vi.spyOn(cache, "getCachedFinglish").mockResolvedValue("gol");
    const geminiSpy = vi.spyOn(gemini, "geminiTranslate");
    expect(await transliterateFarsi(makeEnv(), "گل")).toBe("gol");
    expect(geminiSpy).not.toHaveBeenCalled();
  });

  it("calls Gemini on a cache miss and writes the result to the cache", async () => {
    vi.spyOn(cache, "getCachedFinglish").mockResolvedValue(null);
    const writeSpy = vi.spyOn(cache, "cacheFinglish").mockResolvedValue();
    vi.spyOn(gemini, "geminiTranslate").mockResolvedValue({ type: "success", text: " gol \n" });

    expect(await transliterateFarsi(makeEnv(), "گل")).toBe("gol");
    expect(writeSpy).toHaveBeenCalledWith(expect.anything(), "گل", "gol");
  });

  it("extracts Finglish from a JSON-mode Gemini response and caches only the text", async () => {
    vi.spyOn(cache, "getCachedFinglish").mockResolvedValue(null);
    const writeSpy = vi.spyOn(cache, "cacheFinglish").mockResolvedValue();
    vi.spyOn(gemini, "geminiTranslate").mockResolvedValue({
      type: "success",
      text: '{"lines":[{"n":1,"t":"yare dabestani"}]}',
    });

    expect(await transliterateFarsi(makeEnv(), "یار دبستانی")).toBe("yare dabestani");
    expect(writeSpy).toHaveBeenCalledWith(expect.anything(), "یار دبستانی", "yare dabestani");
  });

  it("cleans and heals a poisoned cache hit without calling Gemini", async () => {
    vi.spyOn(cache, "getCachedFinglish").mockResolvedValue('{"lines":[{"n":1,"t":"gol"}]}');
    const writeSpy = vi.spyOn(cache, "cacheFinglish").mockResolvedValue();
    const geminiSpy = vi.spyOn(gemini, "geminiTranslate");

    expect(await transliterateFarsi(makeEnv(), "گل")).toBe("gol");
    expect(geminiSpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(expect.anything(), "گل", "gol");
  });

  it("falls through to Gemini when the cached value is garbage", async () => {
    vi.spyOn(cache, "getCachedFinglish").mockResolvedValue('{"foo":"bar"}');
    vi.spyOn(cache, "cacheFinglish").mockResolvedValue();
    const geminiSpy = vi.spyOn(gemini, "geminiTranslate").mockResolvedValue({
      type: "success",
      text: '{"lines":[{"n":1,"t":"gol"}]}',
    });

    expect(await transliterateFarsi(makeEnv(), "گل")).toBe("gol");
    expect(geminiSpy).toHaveBeenCalled();
  });

  it("returns null and caches nothing when the JSON output is unusable", async () => {
    vi.spyOn(cache, "getCachedFinglish").mockResolvedValue(null);
    const writeSpy = vi.spyOn(cache, "cacheFinglish").mockResolvedValue();
    vi.spyOn(gemini, "geminiTranslate").mockResolvedValue({
      type: "success",
      text: '{"lines":[{"n":1,"t":"گل"}]}',
    });

    expect(await transliterateFarsi(makeEnv(), "گل")).toBeNull();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("returns null when Gemini fails", async () => {
    vi.spyOn(cache, "getCachedFinglish").mockResolvedValue(null);
    vi.spyOn(gemini, "geminiTranslate").mockResolvedValue({ type: "error" });
    expect(await transliterateFarsi(makeEnv(), "گل")).toBeNull();
  });
});
