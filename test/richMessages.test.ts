import { describe, expect, it } from "vitest";
import {
  escapeRichHtml,
  countLyricLines,
  renderTrackProgressHtml,
  buildTrackResultRichHtml,
  TrackProgressReporter,
  type TrackProgressState,
} from "../src/utils/richMessages";

describe("escapeRichHtml", () => {
  it("escapes HTML-significant characters", () => {
    expect(escapeRichHtml('a & b < c > d "e"')).toBe(
      "a &amp; b &lt; c &gt; d &quot;e&quot;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(escapeRichHtml("Blinding Lights")).toBe("Blinding Lights");
  });
});

describe("countLyricLines", () => {
  it("counts non-empty lines across CRLF and CR", () => {
    expect(countLyricLines("a\r\nb\r\nc")).toBe(3);
  });

  it("skips blank lines", () => {
    expect(countLyricLines("a\n\n  \nb\n")).toBe(2);
  });

  it("returns zero for empty lyrics", () => {
    expect(countLyricLines("")).toBe(0);
  });
});

describe("renderTrackProgressHtml", () => {
  it("renders an all-unchecked checklist with the info thinking block", () => {
    const html = renderTrackProgressHtml({ stage: "info" });
    expect(html).toContain("<tg-thinking>Fetching track info…</tg-thinking>");
    expect((html.match(/<input type="checkbox">/g) ?? []).length).toBe(4);
    expect(html).not.toContain("checked");
    expect(html).not.toContain("<h3>");
  });

  it("checks completed stages and names the current one", () => {
    const html = renderTrackProgressHtml({
      stage: "lyrics",
      trackName: "Song <One>",
      artistName: "Artist",
      albumName: "Album",
      releaseDate: "2020-03-20",
    });
    expect(html).toContain("<h3>🎵 Song &lt;One&gt;</h3>");
    expect(html).toContain("<b>Artist</b> · <i>Album</i> · 2020-03-20");
    expect((html.match(/<input type="checkbox" checked>/g) ?? []).length).toBe(2);
    expect(html).toContain("<tg-thinking>Fetching lyrics…</tg-thinking>");
  });

  it("renders the lyrics note and hides Unknown release dates", () => {
    const html = renderTrackProgressHtml({
      stage: "telegraph",
      trackName: "Song",
      artistName: "Artist",
      releaseDate: "Unknown",
      lyricsNote: "42 lines (cached)",
    });
    expect(html).toContain("Lyrics — 42 lines (cached)");
    expect(html).not.toContain("Unknown");
    expect(html).toContain("<tg-thinking>Creating Telegraph page…</tg-thinking>");
  });
});

describe("buildTrackResultRichHtml", () => {
  const base = {
    trackName: "Song",
    artistName: "Artist",
    albumName: "Album",
    releaseDate: "2020-03-20",
    durationSeconds: 200,
    telegraphUrl: "https://telegra.ph/abc",
    lyricLineCount: 42,
    authorName: "User",
    coverUrl: "https://e-cdns-images.dzcdn.net/cover.jpg",
    includeCover: true,
    hasAudio: false,
  };

  it("renders the full card", () => {
    const html = buildTrackResultRichHtml(base);
    expect(html).toContain('<img src="https://e-cdns-images.dzcdn.net/cover.jpg"/>');
    expect(html).toContain("<h2>🎵 Song</h2>");
    expect(html).toContain("<b>Artist</b> — <i>Album</i>");
    expect(html).toContain("📅 2020-03-20 · ⏱ 3:20");
    expect(html).toContain("<cite>Created by User</cite>");
    expect(html).toContain("✅ Lyrics attached — <b>42</b> lines ready.");
    expect(html).toContain("<footer>🎧 Send a music file to attach the Lyrics button to it.</footer>");
    expect(html).toContain('<tg-button type="url" style="primary" url="https://telegra.ph/abc">');
  });

  it("omits the cover when previews are disabled or the url is not an image", () => {
    expect(buildTrackResultRichHtml({ ...base, includeCover: false })).not.toContain("<img");
    expect(buildTrackResultRichHtml({ ...base, coverUrl: "" })).not.toContain("<img");
  });

  it("renders the no-lyrics warning and drops the footer when audio is attached", () => {
    const html = buildTrackResultRichHtml({ ...base, lyricLineCount: 0, hasAudio: true });
    expect(html).toContain("⚠️ No lyrics found for this track.");
    expect(html).not.toContain("<footer>");
  });
});

describe("TrackProgressReporter", () => {
  function makeApi() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const api: any = {
      sendRichMessageDraft: (...args: unknown[]) => {
        calls.push({ method: "sendRichMessageDraft", args });
        return Promise.resolve(true);
      },
      editMessageText: (...args: unknown[]) => {
        calls.push({ method: "editMessageText", args });
        return Promise.resolve(true);
      },
    };
    return { api, calls };
  }

  it("streams drafts in draft mode", async () => {
    const { api, calls } = makeApi();
    const reporter = new TrackProgressReporter(api, 1, 10, true);
    await reporter.update({ stage: "info" });
    await reporter.update({ stage: "metadata", trackName: "Song" });

    expect(calls.every((c) => c.method === "sendRichMessageDraft")).toBe(true);
    expect(calls.length).toBe(2);
    // Same draft id across states so Telegram animates the diff.
    expect(calls[0].args[1]).toBe(10);
    expect(calls[1].args[1]).toBe(10);
  });

  it("falls back to plain edits when drafts fail", async () => {
    const { api, calls } = makeApi();
    api.sendRichMessageDraft = (...args: unknown[]) => {
      calls.push({ method: "sendRichMessageDraft", args });
      return Promise.reject(new Error("no drafts here"));
    };
    const reporter = new TrackProgressReporter(api, 1, 10, true);

    await reporter.update({ stage: "info" });
    await reporter.update({ stage: "metadata" });

    expect(calls[0].method).toBe("sendRichMessageDraft");
    expect(calls.slice(1).every((c) => c.method === "editMessageText")).toBe(true);
    expect(calls[1].args[2]).toBe("⏳ Fetching track info...");
    expect(calls[2].args[2]).toBe("⏳ Fetching metadata...");
  });

  it("marks the request dead once the fallback edit fails and stops updating", async () => {
    const { api, calls } = makeApi();
    api.editMessageText = (...args: unknown[]) => {
      calls.push({ method: "editMessageText", args });
      return Promise.reject(new Error("message to edit not found"));
    };
    const reporter = new TrackProgressReporter(api, 1, 10, false);

    await reporter.update({ stage: "info" });
    expect(reporter.isDead).toBe(true);

    await reporter.update({ stage: "metadata" });
    expect(calls.length).toBe(1);
  });

  it("uses plain edits in non-private chats", async () => {
    const { api, calls } = makeApi();
    const reporter = new TrackProgressReporter(api, 1, 10, false);
    await reporter.update({ stage: "telegraph" });
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("editMessageText");
    expect(calls[0].args[2]).toBe("⏳ Creating Telegraph page...");
  });

  it("fail() writes the error to the original message", async () => {
    const { api, calls } = makeApi();
    const reporter = new TrackProgressReporter(api, 1, 10, true);
    await reporter.fail("❌ boom");
    expect(calls).toEqual([
      { method: "editMessageText", args: [1, 10, "❌ boom"] },
    ]);
  });
});

// Type-level sanity: the state builder accepts partial updates.
describe("TrackProgressState", () => {
  it("accepts a partial update object", () => {
    const state: TrackProgressState = { stage: "info" };
    expect(state.stage).toBe("info");
  });
});
