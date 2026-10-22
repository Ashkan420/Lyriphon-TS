import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchTracks, getTrack, getAlbum, resetDeezerCacheForTests } from "../src/services/deezer";
import { retryOptions } from "../src/utils/retry";

function mockFetch(impl: (url: string) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn((url: any) => Promise.resolve(impl(String(url)))));
}

describe("deezer service", () => {
  beforeEach(() => {
    retryOptions.delayScale = 0;
    resetDeezerCacheForTests();
  });

  afterEach(() => {
    retryOptions.delayScale = 1;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("searchTracks returns sliced results on success", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }), { status: 200 }),
    );
    const result = await searchTracks("query", 2);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  // Full Deezer retry budget (5 retries + exponential backoff) exceeds the
  // default 5s vitest timeout — give these room so they finish cleanly and
  // don't leave in-flight retries that pollute later mocks.
  it("searchTracks returns null on HTTP error", async () => {
    mockFetch(() => new Response("nope", { status: 500 }));
    expect(await searchTracks("query")).toBeNull();
  });

  it("searchTracks returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network"))));
    expect(await searchTracks("query")).toBeNull();
  });

  it("getTrack returns parsed JSON on success", async () => {
    mockFetch(() => new Response(JSON.stringify({ id: 42, title: "x" }), { status: 200 }));
    expect(await getTrack(42)).toEqual({ id: 42, title: "x" });
  });

  it("getTrack returns null on HTTP error", async () => {
    mockFetch(() => new Response("nope", { status: 404 }));
    expect(await getTrack(42)).toBeNull();
  });

  it("getAlbum returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network"))));
    expect(await getAlbum(7)).toBeNull();
  });

  it("searchTracks retries on 403 and succeeds", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response("Forbidden", { status: 403 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 1 }] }), { status: 200 }));
    }));
    const result = await searchTracks("query");
    expect(result).toEqual([{ id: 1 }]);
    expect(callCount).toBe(2);
  });

  // An Akamai "Access Denied" HTML page (the edge/IP block) gets the tight
  // EDGE_BLOCK_ATTEMPTS cap, not the default retry budget.
  it("searchTracks caps retries on the Akamai Access Denied block page", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      callCount++;
      return Promise.resolve(new Response(
        "<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1></BODY></HTML>",
        { status: 403 },
      ));
    }));
    const result = await searchTracks("query");
    expect(result).toBeNull();
    expect(callCount).toBe(2);
  });

  it("getTrack does not share the cache across different ids", async () => {
    const responses: Record<string, any> = {
      "1": { id: 1, title: "one" },
      "2": { id: 2, title: "two" },
    };
    vi.stubGlobal("fetch", vi.fn((url: any) => {
      const id = String(url).split("/").filter(Boolean).pop() ?? "";
      return Promise.resolve(new Response(JSON.stringify(responses[id] ?? null), { status: 200 }));
    }));
    expect(await getTrack(1)).toMatchObject({ id: 1 });
    expect(await getTrack(2)).toMatchObject({ id: 2 });
  });

  it("getTrack serves a repeat id from the cache without a second fetch", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      callCount++;
      return Promise.resolve(new Response(JSON.stringify({ id: 42, title: "x" }), { status: 200 }));
    }));
    expect(await getTrack(42)).toMatchObject({ id: 42 });
    expect(await getTrack(42)).toMatchObject({ id: 42 });
    expect(callCount).toBe(1);
  });

  it("searchTracks serves a repeat query from the cache without a second fetch", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      callCount++;
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 9 }] }), { status: 200 }));
    }));
    expect(await searchTracks("same query")).toEqual([{ id: 9 }]);
    expect(await searchTracks("same query")).toEqual([{ id: 9 }]);
    expect(callCount).toBe(1);
  });

  it("a failed (null) response is not cached", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        // Non-retryable API error → immediate null.
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 800, message: "DATA_NOT_FOUND", type: "DataException" },
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 1 }] }), { status: 200 }));
    }));
    expect(await searchTracks("flaky query")).toBeNull();
    expect(await searchTracks("flaky query")).toEqual([{ id: 1 }]);
    expect(callCount).toBe(2);
  });

  it("searchTracks does not retry on 404", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      callCount++;
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }));
    const result = await searchTracks("query");
    expect(result).toBeNull();
    expect(callCount).toBe(1);
  });

  it("searchTracks sends a browser-style User-Agent (not a bot fingerprint)", async () => {
    let capturedHeaders: any;
    vi.stubGlobal("fetch", vi.fn((url: any, init: any) => {
      capturedHeaders = init?.headers;
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }));
    await searchTracks("query");
    expect(capturedHeaders).toBeDefined();
    const ua = String(capturedHeaders["User-Agent"]);
    expect(ua).toMatch(/^Mozilla\/5\.0/);
    expect(ua).not.toContain("LyriphonBot");
    expect(ua).not.toContain("bot");
  });

  it("searchTracks returns null on Deezer JSON error 800", async () => {
    mockFetch(() => new Response(JSON.stringify({
      error: { code: 800, message: "DATA_NOT_FOUND", type: "DataException" }
    }), { status: 200 }));
    const result = await searchTracks("query");
    expect(result).toBeNull();
  });

  it("searchTracks retries on Deezer JSON error 700 and succeeds", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 700, message: "SERVICE_BUSY", type: "Exception" }
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 1 }] }), { status: 200 }));
    }));
    const result = await searchTracks("query");
    expect(result).toEqual([{ id: 1 }]);
    expect(callCount).toBe(2);
  });

  it("searchTracks returns null on Deezer JSON error 4", async () => {
    mockFetch(() => new Response(JSON.stringify({
      error: { code: 4, message: "QUOTA", type: "Exception" }
    }), { status: 200 }));
    const result = await searchTracks("query");
    expect(result).toBeNull();
  });

  it("searchTracks returns null on Deezer JSON error 600", async () => {
    mockFetch(() => new Response(JSON.stringify({
      error: { code: 600, message: "QUERY_INVALID", type: "InvalidQueryException" }
    }), { status: 200 }));
    const result = await searchTracks("query");
    expect(result).toBeNull();
  });
});
