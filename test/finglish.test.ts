import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { containsFarsi, transliterateFarsi } from "../src/services/translation/finglish";
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

  it("returns null when Gemini fails", async () => {
    vi.spyOn(cache, "getCachedFinglish").mockResolvedValue(null);
    vi.spyOn(gemini, "geminiTranslate").mockResolvedValue({ type: "error" });
    expect(await transliterateFarsi(makeEnv(), "گل")).toBeNull();
  });
});
