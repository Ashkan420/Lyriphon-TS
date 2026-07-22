import { afterEach, describe, expect, it, vi } from "vitest";
import { getLyrics } from "../src/services/lrclib";

describe("lrclib service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("getLyrics returns lyrics on success", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify([{
      plainLyrics: "Test lyrics"
    }]), { status: 200 }))));
    const result = await getLyrics("track", "artist");
    expect(result).toBe("Test lyrics");
  });

  it("getLyrics returns null when no lyrics found", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))));
    const result = await getLyrics("track", "artist");
    expect(result).toBeNull();
  });

  it("getLyrics handles 429 with Retry-After header", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          code: 429, name: "TooManyRequests", message: "Rate limit exceeded"
        }), { 
          status: 429,
          headers: { "Retry-After": "1" }
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([{
        plainLyrics: "Test lyrics"
      }]), { status: 200 }));
    }));
    const result = await getLyrics("track", "artist");
    expect(result).toBe("Test lyrics");
    expect(callCount).toBe(2);
  });

  it("getLyrics returns null on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("error", { status: 500 }))));
    const result = await getLyrics("track", "artist");
    expect(result).toBeNull();
  });

  it("getLyrics returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network"))));
    const result = await getLyrics("track", "artist");
    expect(result).toBeNull();
  });

  it("getLyrics uses syncedLyrics when plainLyrics not available", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify([{
      syncedLyrics: "[00:00.00] Synced lyrics"
    }]), { status: 200 }))));
    const result = await getLyrics("track", "artist");
    expect(result).toBe("[00:00.00] Synced lyrics");
  });

  it("getLyrics prefers plainLyrics over syncedLyrics", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify([{
      plainLyrics: "Plain lyrics",
      syncedLyrics: "[00:00.00] Synced lyrics"
    }]), { status: 200 }))));
    const result = await getLyrics("track", "artist");
    expect(result).toBe("Plain lyrics");
  });
});