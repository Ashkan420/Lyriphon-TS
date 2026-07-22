import { afterEach, describe, expect, it, vi } from "vitest";
import { searchTracks, getTrack, getAlbum } from "../src/services/deezer";

function mockFetch(impl: (url: string) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn((url: any) => Promise.resolve(impl(String(url)))));
}

describe("deezer service", () => {
  afterEach(() => {
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

  it("searchTracks sends User-Agent header", async () => {
    let capturedHeaders: any;
    vi.stubGlobal("fetch", vi.fn((url: any, init: any) => {
      capturedHeaders = init?.headers;
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }));
    await searchTracks("query");
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders["User-Agent"]).toContain("LyriphonBot");
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
