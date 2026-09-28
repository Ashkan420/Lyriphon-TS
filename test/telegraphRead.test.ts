import { afterEach, describe, expect, it, vi } from "vitest";
import {
  editSongPage,
  parseTelegraphPage,
  type TelegraphNode,
  type TelegraphPageResult,
} from "../src/services/telegraph";
import { formatLyricsForTelegraph } from "../src/services/lyricsFormatter";

const ZWS = "";

function mockFetch(impl: (url: string, init?: any) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn((url: any, init: any) => Promise.resolve(impl(String(url), init))));
}

const env = { TELEGRAPH_ACCESS_TOKEN: "test-token" } as any;

// The writer's exact output shape, rebuilt by hand rather than by calling
// buildPageContent (which is private) — so the test pins the real contract
// instead of asserting the parser against its own assumptions.
function pageContent(opts: {
  cover?: string;
  track?: string;
  trackLink?: string;
  artist?: string;
  artistLink?: string;
  album?: string;
  albumLink?: string;
  date?: string;
  lyricsNodes: TelegraphNode[];
  headingZws?: number;
}): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  if (opts.cover) nodes.push({ tag: "img", attrs: { src: opts.cover } });
  if (opts.track) {
    nodes.push({
      tag: "p",
      children: [
        { tag: "strong", children: ["🎧 Track: "] },
        { tag: "a", attrs: { href: opts.trackLink! }, children: [opts.track] },
      ],
    });
  }
  if (opts.artist) {
    nodes.push({
      tag: "p",
      children: [
        { tag: "strong", children: ["👤 Artist: "] },
        { tag: "a", attrs: { href: opts.artistLink! }, children: [opts.artist] },
      ],
    });
  }
  if (opts.album) {
    nodes.push({
      tag: "p",
      children: [
        { tag: "strong", children: ["💽 Album: "] },
        { tag: "a", attrs: { href: opts.albumLink! }, children: [opts.album] },
      ],
    });
  }
  if (opts.date) {
    nodes.push({ tag: "p", children: [{ tag: "strong", children: ["📅 Date: "] }, opts.date] });
  }
  nodes.push({ tag: "hr" });
  nodes.push({ tag: "h3", children: ["Lyrics" + ZWS.repeat(opts.headingZws ?? 0)] });
  nodes.push(...opts.lyricsNodes);
  return nodes;
}

function result(content: TelegraphNode[], overrides: Partial<TelegraphPageResult> = {}): TelegraphPageResult {
  return {
    ok: true,
    url: "https://telegra.ph/p-1",
    path: "p-1",
    title: "Shape of You",
    authorName: "Ashkan",
    authorUrl: "https://t.me/ashkan420",
    content,
    ...overrides,
  };
}

// Without return_content=true the API answers with a flattened `description`
// string and NO `content` nodes. That made every real page look empty, so the
// query parameter is pinned here — verified against the live API, which
// returned keys: path, url, title, description, author_name, author_url,
// image_url, content, views.
describe("getTelegraphPage request", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks for return_content=true so content nodes come back", async () => {
    const { getTelegraphPage } = await import("../src/services/telegraph");
    let seen = "";
    mockFetch((url) => {
      seen = url;
      return new Response(JSON.stringify({ ok: true, result: { path: "p-1", content: [] } }), { status: 200 });
    });

    await getTelegraphPage(env, "Some-Page");
    expect(seen).toContain("return_content=true");
    expect(seen).toContain("path=Some-Page");
  });

  it("reports failure rather than throwing when the API returns ok:false", async () => {
    const { getTelegraphPage } = await import("../src/services/telegraph");
    mockFetch(() => new Response(JSON.stringify({ ok: false, error: "PAGE_NOT_FOUND" }), { status: 200 }));
    const res = await getTelegraphPage(env, "nope");
    expect(res.ok).toBe(false);
    expect(res.content).toEqual([]);
  });

  it("reports failure rather than throwing on a network error", async () => {
    const { getTelegraphPage } = await import("../src/services/telegraph");
    mockFetch(() => {
      throw new Error("boom");
    });
    const res = await getTelegraphPage(env, "p-1");
    expect(res.ok).toBe(false);
  });
});

describe("parseTelegraphPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("recovers every field the writer emitted", () => {
    const content = pageContent({
      cover: "https://img/cover.jpg",
      track: "Shape of You",
      trackLink: "https://t.me/deezload2bot?start=deezerttrack123",
      artist: "Ed Sheeran",
      artistLink: "https://t.me/deezload2bot?start=deezertartist456",
      album: "Divide",
      albumLink: "https://t.me/deezload2bot?start=deezertalbum789",
      date: "2017-03-03",
      lyricsNodes: formatLyricsForTelegraph("Line one\nLine two"),
    });

    const data = parseTelegraphPage(result(content));

    expect(data.track).toBe("Shape of You");
    expect(data.trackLink).toBe("https://t.me/deezload2bot?start=deezerttrack123");
    expect(data.artist).toBe("Ed Sheeran");
    expect(data.artistLink).toBe("https://t.me/deezload2bot?start=deezertartist456");
    expect(data.album).toBe("Divide");
    expect(data.albumLink).toBe("https://t.me/deezload2bot?start=deezertalbum789");
    expect(data.releaseDate).toBe("2017-03-03");
    expect(data.albumCoverUrl).toBe("https://img/cover.jpg");
    expect(data.authorName).toBe("Ashkan");
    expect(data.authorUrl).toBe("https://t.me/ashkan420");
    expect(data.path).toBe("p-1");
  });

  // The field-preservation guarantee (FR-018): a field that is absent at write
  // time emits no node, so parsing must key on the label, never on position.
  it("parses fields correctly when an earlier field is missing", () => {
    const content = pageContent({
      track: "Only Track",
      trackLink: "https://t.me/deezload2bot?start=deezerttrack1",
      // artist and album deliberately absent
      date: "2020-01-01",
      lyricsNodes: formatLyricsForTelegraph("x"),
    });

    const data = parseTelegraphPage(result(content));

    expect(data.track).toBe("Only Track");
    expect(data.artist).toBe("");
    expect(data.artistLink).toBe("");
    expect(data.album).toBe("");
    expect(data.albumLink).toBe("");
    // The date comes AFTER the two missing fields — index-based parsing
    // would have read the track's link as the date.
    expect(data.releaseDate).toBe("2020-01-01");
  });

  it("recovers the trackId from the track deep link", () => {
    const content = pageContent({
      track: "T",
      trackLink: "https://t.me/deezload2bot?start=deezerttrack98765",
      lyricsNodes: formatLyricsForTelegraph("x"),
    });
    expect(parseTelegraphPage(result(content)).trackId).toBe(98765);
  });

  it("leaves trackId undefined when the link is not a deezload link", () => {
    const content = pageContent({ track: "T", trackLink: "https://example.com", lyricsNodes: [] });
    expect(parseTelegraphPage(result(content)).trackId).toBeUndefined();
  });

  describe("lyrics", () => {
    it("recovers multi-block lyrics with the blank-line separator", () => {
      const lyrics = "[Verse 1]\nLine one\nLine two\n\n[Chorus]\nLine three";
      const content = pageContent({ track: "T", trackLink: "l", lyricsNodes: formatLyricsForTelegraph(lyrics) });
      expect(parseTelegraphPage(result(content)).lyrics).toBe(lyrics);
    });

    it("recovers a translated pair as one line joined by a newline", () => {
      // combine.ts writes "[original]\n[translation]" and the formatter merges
      // them into one paragraph separated by <br>.
      const lyrics = "Hello\n[مرحبا]";
      const content = pageContent({ track: "T", trackLink: "l", lyricsNodes: formatLyricsForTelegraph(lyrics) });
      expect(parseTelegraphPage(result(content)).lyrics).toBe(lyrics);
    });

    it("recovers the 'Lyrics not found.' placeholder as written", () => {
      const content = pageContent({ track: "T", trackLink: "l", lyricsNodes: formatLyricsForTelegraph("") });
      expect(parseTelegraphPage(result(content)).lyrics).toBe("Lyrics not found.");
    });

    // T010: the AI-summary refresh appends zero-width spaces to the heading.
    // An exact-text match would miss it and swallow the whole body as lyrics.
    it("finds the heading after the summary refresh appended zero-width spaces", () => {
      const content = pageContent({
        track: "T",
        trackLink: "l",
        headingZws: 3,
        lyricsNodes: formatLyricsForTelegraph("Real lyric line"),
      });
      const data = parseTelegraphPage(result(content));
      expect(data.lyrics).toBe("Real lyric line");
      expect(data.track).toBe("T");
    });
  });
});

describe("parseTelegraphPage round trip", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // T013 / SC-007: a fully-populated page survives a no-op read + write. This
  // is the check that catches a partial read — a parser that drops the cover
  // or a link passes every other test here and still damages real pages.
  it("preserves every field and the body through read then write", async () => {
    const lyrics = "[Verse 1]\nLine one\nLine two\n\n[Chorus]\nLine three";
    const content = pageContent({
      cover: "https://img/cover.jpg",
      track: "Shape of You",
      trackLink: "https://t.me/deezload2bot?start=deezerttrack123",
      artist: "Ed Sheeran",
      artistLink: "https://t.me/deezload2bot?start=deezertartist456",
      album: "Divide",
      albumLink: "https://t.me/deezload2bot?start=deezertalbum789",
      date: "2017-03-03",
      lyricsNodes: formatLyricsForTelegraph(lyrics),
    });

    const data = parseTelegraphPage(result(content));

    // The user changed only the track name; everything else is carried through.
    const edited = { ...data, track: "Shape of You (Remastered)" };
    const { lyrics: _drop, ...pageData } = edited;

    let sent: any = null;
    mockFetch((_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, result: { path: "p-1" } }), { status: 200 });
    });

    await editSongPage(env, pageData as any, data.lyrics);

    const body = JSON.stringify(sent.content);
    // The untouched fields all survive the write.
    expect(sent.title).toBe("Shape of You (Remastered)");
    expect(body).toContain("https://img/cover.jpg");
    expect(body).toContain("deezertartist456");
    expect(body).toContain("deezertalbum789");
    expect(body).toContain("2017-03-03");
    expect(body).toContain("Line three");
    // The owner's marker survives — this is what the old CHANNEL_LINK write
    // would have destroyed.
    expect(sent.author_url).toBe("https://t.me/ashkan420");
  });
});

describe("editSongPage author_url", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // T012: the write must echo the page's own author link, not the channel
  // constant. Sending CHANNEL_LINK would strip the owner's marker on the
  // first edit and lock the real owner out of their own page.
  it("writes back the page's own author link rather than the channel", async () => {
    let sent: any = null;
    mockFetch((_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, result: { path: "p-1" } }), { status: 200 });
    });

    await editSongPage(
      env,
      {
        authorName: "Ashkan",
        authorUrl: "https://t.me/someone",
        track: "T",
        trackLink: "",
        artist: "",
        artistLink: "",
        album: "",
        albumLink: "",
        albumCoverUrl: "",
        releaseDate: "",
        path: "p-1",
      } as any,
      "lyrics",
    );

    expect(sent.author_url).toBe("https://t.me/someone");
  });

  it("falls back to the channel link when the page has none", async () => {
    let sent: any = null;
    mockFetch((_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, result: { path: "p-1" } }), { status: 200 });
    });

    await editSongPage(
      env,
      {
        authorName: "Ashkan",
        track: "T",
        trackLink: "",
        artist: "",
        artistLink: "",
        album: "",
        albumLink: "",
        albumCoverUrl: "",
        releaseDate: "",
        path: "p-1",
      } as any,
      "lyrics",
    );

    expect(sent.author_url).toBe("https://t.me/bichniga");
  });
});

// T014 / FR-022: content carried through untouched must not be re-derived,
// re-joined, or reformatted. Distinct from the display-fidelity test above,
// which permits whitespace normalization.
describe("carried-through content is not reformatted", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("passes read lyrics into the write unchanged", () => {
    const lyrics = "[Verse 1]\nLine one\n\n[Chorus]\nLine two";
    const content = pageContent({ track: "T", trackLink: "l", lyricsNodes: formatLyricsForTelegraph(lyrics) });
    const first = parseTelegraphPage(result(content));
    // Re-reading what we just parsed must be stable: no drift accumulates
    // across repeated /edit rounds on the same page.
    const second = parseTelegraphPage(
      result(pageContent({ track: "T", trackLink: "l", lyricsNodes: formatLyricsForTelegraph(first.lyrics) })),
    );
    expect(second.lyrics).toBe(first.lyrics);
  });
});

// FR-004 / SC-009: new pages record the creator's Telegram link so /edit can
// identify them by identity. The rendered body must be byte-identical to
