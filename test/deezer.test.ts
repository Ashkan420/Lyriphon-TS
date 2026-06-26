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
});
