import { afterEach, describe, expect, it, vi } from "vitest";
import { getLyrics } from "../src/services/lrclib";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

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
    expect(result).toBe("Synced lyrics");
  });

  it("strips LRC timestamps when falling back to syncedLyrics", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify([{
      syncedLyrics: "[00:12.50] First line\n[01:05] Second line\n[01:30.25]"
    }]), { status: 200 }))));
    const result = await getLyrics("track", "artist");
    expect(result).toBe("First line\nSecond line");
  });

  it("returns null when syncedLyrics fallback has no readable content", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify([{
      syncedLyrics: "[00:00.00]\n[00:10.00]"
    }]), { status: 200 }))));
    const result = await getLyrics("track", "artist");
    expect(result).toBeNull();
  });

  it("getLyrics prefers plainLyrics over syncedLyrics", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify([{
      plainLyrics: "Plain lyrics",
      syncedLyrics: "[00:00.00] Synced lyrics"
    }]), { status: 200 }))));
    const result = await getLyrics("track", "artist");
    expect(result).toBe("Plain lyrics");
  });

  it("getLyrics sends identifying User-Agent header", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: any, init: any) => {
      capturedHeaders = init?.headers;
      return Promise.resolve(new Response(JSON.stringify([{ plainLyrics: "x" }]), { status: 200 }));
    }));
    await getLyrics("track", "artist");
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!["User-Agent"]).toContain("LyriphonBot");
  });
});

describe("lrclib fallback order (weird & non-song metadata)", () => {
  const parseUrl = (input: unknown) => new URL(String(input));

  it("prefers any plain lyrics over album-matched synced lyrics", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(jsonResponse([
        { albumName: "Match", syncedLyrics: "[00:01.00] album synced" },
        { albumName: "Other", plainLyrics: "any plain" },
      ])),
    ));
    const result = await getLyrics("track", "artist", "Match");
    expect(result).toBe("any plain");
  });

  it("prefers album-matched plain lyrics over other plain lyrics", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(jsonResponse([
        { albumName: "Weird / Album (Deluxe)", syncedLyrics: "[00:01.00] album synced" },
        { albumName: "Other Album", plainLyrics: "any plain" },
        { albumName: "Weird / Album (Deluxe)", plainLyrics: "album plain" },
      ])),
    ));
    const result = await getLyrics("track", "artist", "Weird / Album (Deluxe)");
    expect(result).toBe("album plain");
  });

  it("falls back to album-matched synced lyrics over any synced lyrics", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(jsonResponse([
        { albumName: "Other", syncedLyrics: "[00:01.00] other synced" },
        { albumName: "Match", syncedLyrics: "[00:02.00] album synced" },
      ])),
    ));
    const result = await getLyrics("track", "artist", "Match");
    expect(result).toBe("album synced");
  });

  it("skips whitespace-only plainLyrics and falls back to synced", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(jsonResponse([
        { plainLyrics: "  \n\t " },
        { syncedLyrics: "[00:01.00] synced" },
      ])),
    ));
    const result = await getLyrics("track", "artist");
    expect(result).toBe("synced");
  });

  it("retries without album_name when the album query has nothing usable", async () => {
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn((input: unknown) => {
      calls.push(parseUrl(input));
      if (calls[calls.length - 1].searchParams.has("album_name")) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(jsonResponse([{ plainLyrics: "found without album" }]));
    }));
    const result = await getLyrics("track", "artist", "REMASTERED ★ VOL.2 (Disc 2)");
    expect(result).toBe("found without album");
    expect(calls).toHaveLength(2);
    expect(calls[0].searchParams.get("album_name")).toBe("REMASTERED ★ VOL.2 (Disc 2)");
    expect(calls[1].searchParams.has("album_name")).toBe(false);
  });

  it("never sends a whitespace-only album and succeeds on the first attempt", async () => {
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn((input: unknown) => {
      calls.push(parseUrl(input));
      return Promise.resolve(jsonResponse([{ plainLyrics: "ok" }]));
    }));
    const result = await getLyrics("track", "artist", "   ");
    expect(result).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.has("album_name")).toBe(false);
  });

  it("exhausts both attempts and returns null for timestamp-only synced results", async () => {
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn((input: unknown) => {
      calls.push(parseUrl(input));
      return Promise.resolve(jsonResponse([{ syncedLyrics: "[00:00.50]" }]));
    }));
    const result = await getLyrics("02 - Intro (Skit) ☠", "N/A", "https://x.test/a?b=1");
    expect(result).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("returns null for non-song JSON payloads on both attempts", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      calls += 1;
      return Promise.resolve(jsonResponse({ message: "No results found" }));
    }));
    const result = await getLyrics("podcast ep. 12", "Nobody");
    expect(result).toBeNull();
    expect(calls).toBe(2);
  });

  it("keeps LRC ID-tag metadata lines when falling back to synced lyrics", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(jsonResponse([
        { syncedLyrics: "[ti:Podcast]\n[ar:Nobody]\n[00:10.00]Real line" },
      ])),
    ));
    const result = await getLyrics("track", "artist");
    expect(result).toBe("[ti:Podcast]\n[ar:Nobody]\nReal line");
  });

  it("encodes unicode and punctuation metadata without breaking the search", async () => {
    let captured = "";
    vi.stubGlobal("fetch", vi.fn((input: unknown) => {
      captured = String(input);
      return Promise.resolve(jsonResponse([{ plainLyrics: "lyrics" }]));
    }));
    const result = await getLyrics("メフィスト", '_artist_ & "co"?=<>#', "Ünïcödé/Album");
    expect(result).toBe("lyrics");
    const url = new URL(captured);
    expect(url.searchParams.get("track_name")).toBe("メフィスト");
    expect(url.searchParams.get("artist_name")).toBe('_artist_ & "co"?=<>#');
    expect(url.searchParams.get("album_name")).toBe("Ünïcödé/Album");
  });
});