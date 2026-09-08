import { describe, expect, it } from "vitest";
import {
  escapeRichHtml,
  countLyricLines,
  renderTrackProgressHtml,
  buildTrackResultHtml,
  buildRichAudioDelivery,
  buildRichOptionDemo,
  buildAlbumRichMessage,
  sendRichAudio,
  TrackProgressReporter,
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
  it("renders an all-unchecked checklist with the info status line", () => {
    const html = renderTrackProgressHtml({ stage: "info" });
    expect(html).toContain("⏳ Fetching track info…");
    expect((html.match(/<input type="checkbox">/g) ?? []).length).toBe(5);
    expect(html).not.toContain("checked");
    expect(html).not.toContain("<h3>");
    // tg-thinking is drafts-only and rejected in persisted messages.
    expect(html).not.toContain("tg-thinking");
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
    expect(html).toContain("⏳ Fetching lyrics…");
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
    expect(html).toContain("⏳ Creating Telegraph page…");
  });
});

describe("buildTrackResultHtml", () => {
  const base = {
    trackName: "Song <Vol. 1>",
    artistName: "Artist",
    albumName: "Album",
    releaseDate: "2020-03-20",
    telegraphUrl: "https://telegra.ph/abc",
    authorName: "User",
    hasAudio: false,
  };

  it("renders the hyperlink card with native-preview cover (no baked-in image)", () => {
    const html = buildTrackResultHtml(base);
    expect(html).toContain("✅ <b>Telegraph Created</b>");
    expect(html).toContain("<blockquote>🎵 <b>Song &lt;Vol. 1&gt;</b>");
    expect(html).toContain("👤 Artist");
    expect(html).toContain("💽 Album");
    expect(html).toContain("📅 2020-03-20");
    expect(html).toContain("Send a music file to attach the Lyrics button to it.");
    expect(html).toContain('<a href="https://telegra.ph/abc">📖 Open Telegraph Page</a>');
    // Cover comes from the link preview, not the message body.
    expect(html).not.toContain("<img");
    expect(html).not.toContain("tg-button");
  });

  it("drops the attach hint when audio is already attached", () => {
    const html = buildTrackResultHtml({ ...base, hasAudio: true });
    expect(html).toContain("Telegraph Created & Audio Attached");
    expect(html).not.toContain("Send a music file");
  });
});

describe("buildRichAudioDelivery", () => {
  const base = {
    fileId: "F1LE",
    telegraphUrl: "https://telegra.ph/abc",
  };

  it("layout 1 (default): audio bubble + centered primary Lyrics button", () => {
    const { html, media } = buildRichAudioDelivery(base);
    expect(html).toContain('<audio src="tg://audio?id=music1"></audio>');
    expect(html).toContain('<tg-button type="url" style="primary" url="https://telegra.ph/abc">Lyrics</tg-button>');
    expect(html).toContain('<tg-button-row align="center">');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("reply_markup");
    expect(media).toEqual([{ id: "music1", media: { type: "audio", media: "F1LE" } }]);
  });

  it("layout 2: cover image block on top of the player + Lyrics button", () => {
    const { html } = buildRichAudioDelivery({ ...base, layout: 2, coverUrl: "https://e-cdns.dzcdn.net/cover.jpg" });
    expect(html).toContain('<img src="https://e-cdns.dzcdn.net/cover.jpg"/>');
    expect(html).toContain("tg://audio?id=music1");
    expect(html).toContain(">Lyrics</tg-button>");
  });

  it("layout 2 without a cover degrades to layout 1's body", () => {
    const { html } = buildRichAudioDelivery({ ...base, layout: 2 });
    expect(html).not.toContain("<img");
    expect(html).toContain(">Lyrics</tg-button>");
  });

  it("position and color knobs render as row align + button style", () => {
    const right = buildRichAudioDelivery({ ...base, position: "right", color: "success" }).html;
    expect(right).toContain('<tg-button-row align="right">');
    expect(right).toContain('style="success"');

    const leftDefault = buildRichAudioDelivery({ ...base, position: "left", color: "default" }).html;
    expect(leftDefault).toContain('<tg-button-row align="left">');
    // "default" omits the style attribute entirely.
    expect(leftDefault).not.toContain('style="default"');
    expect(leftDefault).toContain('<tg-button type="url" url=');
  });

  it("escapes the Telegraph URL", () => {
    const { html } = buildRichAudioDelivery({ ...base, telegraphUrl: "https://telegra.ph/x?a=1&b=2" });
    expect(html).toContain('url="https://telegra.ph/x?a=1&amp;b=2"');
  });
});

describe("buildRichOptionDemo", () => {
  it("position demo: one row per position, callback buttons with richpos_ data", () => {
    const { html, media } = buildRichOptionDemo("position", "DEMO");
    expect(html).toContain('<tg-button-row align="left"><tg-button type="callback_data" data="richpos_left">Lyrics ◀️</tg-button></tg-button-row>');
    expect(html).toContain('<tg-button-row align="center"><tg-button type="callback_data" data="richpos_center">Lyrics ⏺</tg-button></tg-button-row>');
    expect(html).toContain('<tg-button-row align="right"><tg-button type="callback_data" data="richpos_right">Lyrics ▶️</tg-button></tg-button-row>');
    expect(media).toEqual([{ id: "music1", media: { type: "audio", media: "DEMO" } }]);
  });

  it("color demo: one row with the four styles and richcol_ data", () => {
    const { html } = buildRichOptionDemo("color", "DEMO");
    expect(html).toContain('data="richcol_default"'); // no style attr
    expect(html).not.toContain('style="default"');
    expect(html).toContain('style="primary" data="richcol_primary"');
    expect(html).toContain('style="success" data="richcol_success"');
    expect(html).toContain('style="danger" data="richcol_danger"');
  });
});

describe("buildAlbumRichMessage", () => {
  const base = {
    albumTitle: "2001",
    artistName: "Dr. Dre",
    coverUrl: "https://e-cdns.dzcdn.net/cover.jpg",
    position: "center" as const,
    color: "primary" as const,
  };

  it("cover + credit on top, one player + Lyrics button per delivered track", () => {
    const { html, media } = buildAlbumRichMessage({
      ...base,
      tracks: [
        { trackName: "Still D.R.E.", trackId: 1, telegraphUrl: "https://telegra.ph/a", fileId: "F1" },
        { trackName: "The Next Episode", trackId: 2, telegraphUrl: "https://telegra.ph/b", fileId: "F2" },
      ],
    });
    expect(html).toContain('<img src="https://e-cdns.dzcdn.net/cover.jpg"/>');
    expect(html).toContain("<figcaption>Dr. Dre — 2001</figcaption>");
    expect(html).toContain("<hr/>");
    expect(html).toContain('tg://audio?id=trk1');
    expect(html).toContain('tg://audio?id=trk2');
    expect(html).toContain('<tg-button type="url" style="primary" url="https://telegra.ph/a">Lyrics</tg-button>');
    expect(html).toContain('<tg-button type="url" style="primary" url="https://telegra.ph/b">Lyrics</tg-button>');
    // Media entries in track order, referencing the file_ids.
    expect(media).toEqual([
      { id: "trk1", media: { type: "audio", media: "F1" } },
      { id: "trk2", media: { type: "audio", media: "F2" } },
    ]);
  });

  it("failed tracks render as deezload note lines, not players", () => {
    const { html, media } = buildAlbumRichMessage({
      ...base,
      tracks: [
        { trackName: "Okay", trackId: 11, telegraphUrl: "https://telegra.ph/ok", fileId: "F1" },
        { trackName: "Broken", trackId: 22, telegraphUrl: "" },
      ],
    });
    expect(html).toContain('tg://audio?id=trk1');
    expect(html).toContain("🎵 Broken — ");
    expect(html).toContain('href="https://t.me/deezload2bot?start=deezerttrack22"');
    expect(html).not.toContain("trk2");
    expect(media).toHaveLength(1);
  });

  it("applies position and color knobs; default color omits the style attr", () => {
    const { html } = buildAlbumRichMessage({
      ...base,
      position: "right",
      color: "default",
      tracks: [{ trackName: "A", trackId: 1, telegraphUrl: "https://telegra.ph/a", fileId: "F1" }],
    });
    expect(html).toContain('<tg-button-row align="right">');
    expect(html).not.toContain('style="default"');
    expect(html).toContain('<tg-button type="url" url="https://telegra.ph/a">Lyrics</tg-button>');
  });

  it("escapes names and URLs", () => {
    const { html } = buildAlbumRichMessage({
      albumTitle: 'A & B <C>',
      artistName: "D>E",
      coverUrl: "https://c/1.jpg",
      tracks: [{ trackName: 'X "Y" & Z', trackId: 1, telegraphUrl: "https://telegra.ph/x?a=1&b=2", fileId: "F" }],
    });
    expect(html).toContain("<figcaption>D&gt;E — A &amp; B &lt;C&gt;</figcaption>");
    expect(html).toContain("<figcaption>X &quot;Y&quot; &amp; Z</figcaption>");
    expect(html).toContain('url="https://telegra.ph/x?a=1&amp;b=2"');
  });
});

describe("sendRichAudio", () => {
  it("sends one rich message with html + media and no reply_markup", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const api: any = {
      sendRichMessage: (...args: unknown[]) => {
        calls.push({ method: "sendRichMessage", args });
        return Promise.resolve({ message_id: 1 });
      },
    };

    const msg = await sendRichAudio(api, 42, "F1LE", "https://telegra.ph/abc");

    expect(msg?.message_id).toBe(1);
    expect(calls).toHaveLength(1);
    const [chatId, payload] = calls[0].args as [number, any];
    expect(chatId).toBe(42);
    expect(payload).toMatchObject({
      html: expect.stringContaining("tg://audio?id=music1"),
      skip_entity_detection: true,
    });
    expect(payload.media).toEqual([{ id: "music1", media: { type: "audio", media: "F1LE" } }]);
    expect(JSON.stringify(payload)).not.toContain("reply_markup");
  });

  it("forwards layout options to the builder", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const api: any = {
      sendRichMessage: (...args: unknown[]) => {
        calls.push({ method: "sendRichMessage", args });
        return Promise.resolve({ message_id: 5 });
      },
    };

    await sendRichAudio(api, 1, "F", "https://t.ph/x", {
      layout: 2,
      coverUrl: "https://c/2.jpg",
    });

    const payload = calls[0].args[1] as any;
    expect(payload.html).toContain('<img src="https://c/2.jpg"/>');
  });

  it("returns null without throwing when the rich send fails", async () => {
    const api: any = {
      sendRichMessage: () => Promise.reject(new Error("can't parse rich message")),
    };
    const msg = await sendRichAudio(api, 42, "F1LE", "https://telegra.ph/abc");
    expect(msg).toBeNull();
  });
});

describe("TrackProgressReporter", () => {
  function makeApi() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const api: any = {
      sendRichMessage: (...args: unknown[]) => {
        calls.push({ method: "sendRichMessage", args });
        return Promise.resolve({ message_id: 777 });
      },
      sendRichMessageDraft: (...args: unknown[]) => {
        calls.push({ method: "sendRichMessageDraft", args });
        return Promise.resolve(true);
      },
      editMessageText: (...args: unknown[]) => {
        calls.push({ method: "editMessageText", args });
        return Promise.resolve(true);
      },
      deleteMessage: (...args: unknown[]) => {
        calls.push({ method: "deleteMessage", args });
        return Promise.resolve(true);
      },
    };
    return { api, calls };
  }

  it("start() posts one persistent rich message and deletes the results message", async () => {
    const { api, calls } = makeApi();
    const reporter = new TrackProgressReporter(api, 1, 10);
    await reporter.start();

    expect(calls[0].method).toBe("sendRichMessage");
    expect(calls[0].args[0]).toBe(1);
    expect(calls[0].args[1]).toMatchObject({ html: expect.stringContaining("Fetch") });
    expect(reporter.activeMessageId).toBe(777);
    expect(calls[1]).toEqual({ method: "deleteMessage", args: [1, 10] });
  });

  it("edits the same message through state updates — one message end to end", async () => {
    const { api, calls } = makeApi();
    const reporter = new TrackProgressReporter(api, 1, 10);
    await reporter.start();
    calls.length = 0;

    await reporter.update({ stage: "metadata", trackName: "Song" });
    await reporter.update({ stage: "lyrics" });

    expect(calls.every((c) => c.method === "editMessageText")).toBe(true);
    // Both edits target the same rich message.
    expect(calls[0].args[1]).toBe(777);
    expect(calls[1].args[1]).toBe(777);
    expect(calls[0].args[2]).toMatchObject({ html: expect.stringContaining("Fetching album metadata") });
  });

  it("skips updates whose content is identical (message-not-modified guard)", async () => {
    const { api, calls } = makeApi();
    const reporter = new TrackProgressReporter(api, 1, 10);
    await reporter.start();
    calls.length = 0;

    await reporter.update({ stage: "info" });
    expect(calls.length).toBe(0);
  });

  it("falls back to plain edits on the original message when the rich send fails", async () => {
    const { api, calls } = makeApi();
    api.sendRichMessage = (...args: unknown[]) => {
      calls.push({ method: "sendRichMessage", args });
      return Promise.reject(new Error("method not found"));
    };
    const reporter = new TrackProgressReporter(api, 1, 10);

    await reporter.start();
    await reporter.update({ stage: "metadata" });

    expect(reporter.activeMessageId).toBe(10);
    expect(calls[1].method).toBe("editMessageText");
    expect(calls[1].args[2]).toBe("⏳ Fetching track info...");
    expect(calls[2].args[2]).toBe("⏳ Fetching metadata...");
  });

  it("marks the request dead once the fallback edit fails and stops updating", async () => {
    const { api, calls } = makeApi();
    api.sendRichMessage = (...args: unknown[]) => {
      calls.push({ method: "sendRichMessage", args });
      return Promise.reject(new Error("method not found"));
    };
    api.editMessageText = (...args: unknown[]) => {
      calls.push({ method: "editMessageText", args });
      return Promise.reject(new Error("message to edit not found"));
    };
    const reporter = new TrackProgressReporter(api, 1, 10);

    await reporter.start();
    expect(reporter.isDead).toBe(true);

    await reporter.update({ stage: "metadata" });
    expect(calls.length).toBe(2);
  });

  it("degrades to plain text edits when a mid-stream rich edit fails", async () => {
    const { api, calls } = makeApi();
    const reporter = new TrackProgressReporter(api, 1, 10);
    await reporter.start();
    calls.length = 0;

    api.editMessageText = (chatId: unknown, messageId: unknown, payload: unknown, ...rest: unknown[]) => {
      calls.push({ method: "editMessageText", args: [chatId, messageId, payload, ...rest] });
      if (payload && typeof payload === "object" && "html" in (payload as any)) {
        return Promise.reject(new Error("can't parse rich message"));
      }
      return Promise.resolve(true);
    };

    await reporter.update({ stage: "metadata" });
    await reporter.update({ stage: "lyrics" });

    // First update: rich edit fails → plain edit succeeds. Second: plain only.
    expect(calls[0].args[2]).toMatchObject({ html: expect.anything() });
    expect(calls[0].args[3]).toBeUndefined();
    expect(calls[1].args[2]).toBe("⏳ Fetching metadata...");
    expect(calls[2].args[2]).toBe("⏳ Fetching lyrics...");
  });

  it("finalizeText() turns the progress message into the result card with preview control", async () => {
    const { api, calls } = makeApi();
    const reporter = new TrackProgressReporter(api, 1, 10);
    await reporter.start();
    calls.length = 0;

    const ok = await reporter.finalizeText("<b>Card</b>", { inline_keyboard: [] }, false);
    expect(ok).toBe(true);
    expect(calls[0].method).toBe("editMessageText");
    expect(calls[0].args[1]).toBe(777);
    expect(calls[0].args[2]).toBe("<b>Card</b>");
    expect(calls[0].args[3]).toMatchObject({
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
      link_preview_options: { is_disabled: false },
    });
  });

  it("finalizeText() works in fallback mode too (edits the original message)", async () => {
    const { api, calls } = makeApi();
    api.sendRichMessage = (...args: unknown[]) => {
      calls.push({ method: "sendRichMessage", args });
      return Promise.reject(new Error("method not found"));
    };
    const reporter = new TrackProgressReporter(api, 1, 10);
    await reporter.start();
    calls.length = 0;

    const ok = await reporter.finalizeText("<b>Card</b>", { inline_keyboard: [] }, true);
    expect(ok).toBe(true);
    expect(calls[0].args[1]).toBe(10);
    expect(calls[0].args[3]).toMatchObject({ link_preview_options: { is_disabled: true } });
  });

  it("finalizeText() returns false when there is no edit target", async () => {
    const { api, calls } = makeApi();
    api.sendRichMessage = (...args: unknown[]) => {
      calls.push({ method: "sendRichMessage", args });
      return Promise.reject(new Error("method not found"));
    };
    const reporter = new TrackProgressReporter(api, 1, undefined);
    await reporter.start();
    expect(reporter.isDead).toBe(true);
    calls.length = 0;

    const ok = await reporter.finalizeText("<b>Card</b>", { inline_keyboard: [] }, false);
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("fail() writes the error to the active message", async () => {
    const { api, calls } = makeApi();
    const reporter = new TrackProgressReporter(api, 1, 10);
    await reporter.start();
    calls.length = 0;

    await reporter.fail("❌ boom");
    expect(calls).toEqual([
      { method: "editMessageText", args: [1, 777, "❌ boom"] },
    ]);
  });
});
