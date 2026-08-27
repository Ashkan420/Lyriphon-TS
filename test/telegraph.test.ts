import { afterEach, describe, expect, it, vi } from "vitest";
import { editSongPage } from "../src/services/telegraph";

function mockFetch(impl: (url: string, init?: any) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn((url: any, init: any) => Promise.resolve(impl(String(url), init))));
}

const env = { TELEGRAPH_ACCESS_TOKEN: "test-token" } as any;
const pageData = {
  authorName: "A",
  track: "T",
  trackLink: "l",
  artist: "AR",
  artistLink: "l",
  album: "AL",
  albumLink: "l",
  albumCoverUrl: "",
  releaseDate: "2020",
  path: "p-1",
};

describe("editSongPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves on ok:true response", async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: true, result: { path: "p-1" } }), { status: 200 }));
    const res = await editSongPage(env, pageData as any, "lyrics");
    expect(res.ok).toBe(true);
  });

  it("throws on ok:false with HTTP 200 (Telegraph API error)", async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: false, error: "PAGE_NOT_MODIFIED" }), { status: 200 }));
    await expect(editSongPage(env, pageData as any, "lyrics")).rejects.toThrow("PAGE_NOT_MODIFIED");
  });

  it("throws on HTTP error", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    await expect(editSongPage(env, pageData as any, "lyrics")).rejects.toThrow("500");
  });
});
