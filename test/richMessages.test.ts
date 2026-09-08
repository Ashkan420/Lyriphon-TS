import { describe, expect, it } from "vitest";
import {
  escapeRichHtml,
  countLyricLines,
  renderTrackProgressHtml,
  buildTrackResultHtml,
  buildRichAudioDelivery,
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
    trackName: "Song",
    artistName: "Artist",
    telegraphUrl: "https://telegra.ph/abc",
  };

  it("style 1 (default): audio bubble + song-named button, no extra blocks", () => {
    const { html, media } = buildRichAudioDelivery(base);
    expect(html).toContain('<audio src="tg://audio?id=music1"></audio>');
    expect(html).not.toContain("<code>");
    expect(html).toContain('<tg-button type="url" style="primary" url="https://telegra.ph/abc">Song — Artist</tg-button>');
    expect(html).toContain('<tg-button-row align="center">');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("reply_markup");
    expect(media).toEqual([{ id: "music1", media: { type: "audio", media: "F1LE" } }]);
  });

  it("style 2: cover image block on top of the player + Lyrics button", () => {
    const { html } = buildRichAudioDelivery({ ...base, style: 2, coverUrl: "https://e-cdns.dzcdn.net/cover.jpg" });
    expect(html).toContain('<img src="https://e-cdns.dzcdn.net/cover.jpg"/>');
    expect(html).toContain("tg://audio?id=music1");
    expect(html).toContain(">Lyrics</tg-button>");
    expect(html).not.toContain("Song — Artist"); // player shows the title natively
  });

  it("style 3: cover with the song name as figcaption credit", () => {
    const { html } = buildRichAudioDelivery({ ...base, style: 3, coverUrl: "https://e-cdns.dzcdn.net/cover.jpg" });
    expect(html).toContain("<figcaption>Song — Artist</figcaption>");
    expect(html).toContain("<img");
    expect(html).toContain(">Lyrics</tg-button>");
  });

  it("style 4: Lyrics + album deezload dual buttons", () => {
    const { html } = buildRichAudioDelivery({ ...base, style: 4, deezerUrl: "https://t.me/deezload2bot?start=deezertalbum1020904331" });
    expect(html).toContain(">Lyrics</tg-button>");
    expect(html).toContain('url="https://t.me/deezload2bot?start=deezertalbum1020904331"');
    expect(html).toContain("💽 Album</tg-button>");
    expect(html).not.toContain("<img");
  });

  it("degrades 2/3 without a cover and 4 without an album link to the style-1 body", () => {
    const noCover2 = buildRichAudioDelivery({ ...base, style: 2 });
    const noCover3 = buildRichAudioDelivery({ ...base, style: 3 });
    const noDeezer4 = buildRichAudioDelivery({ ...base, style: 4 });
    for (const { html } of [noCover2, noCover3, noDeezer4]) {
      expect(html).toContain(">Song — Artist</tg-button>");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("💽");
    }
  });

  it("escapes rich-HTML-significant characters in names and URL (all styles)", () => {
    const nasty = {
      fileId: "F",
      trackName: 'A & B <C> "D"',
      artistName: "E>F",
      telegraphUrl: "https://telegra.ph/x?a=1&b=2",
    };
    const s1 = buildRichAudioDelivery(nasty).html;
    expect(s1).toContain('url="https://telegra.ph/x?a=1&amp;b=2"');
    expect(s1).toContain(">A &amp; B &lt;C&gt; &quot;D&quot; — E&gt;F</tg-button>");

    const s3 = buildRichAudioDelivery({ ...nasty, style: 3, coverUrl: "https://c/1.jpg" }).html;
    expect(s3).toContain("<figcaption>A &amp; B &lt;C&gt; &quot;D&quot; — E&gt;F</figcaption>");
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

    const msg = await sendRichAudio(api, 42, "F1LE", "Song", "Artist", "https://telegra.ph/abc");

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

  it("forwards style options to the builder", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const api: any = {
      sendRichMessage: (...args: unknown[]) => {
        calls.push({ method: "sendRichMessage", args });
        return Promise.resolve({ message_id: 5 });
      },
    };

    await sendRichAudio(api, 1, "F", "S", "A", "https://t.ph/x", {
      style: 2,
      coverUrl: "https://c/2.jpg",
    });

    const payload = calls[0].args[1] as any;
    expect(payload.html).toContain('<img src="https://c/2.jpg"/>');
  });

  it("returns null without throwing when the rich send fails", async () => {
    const api: any = {
      sendRichMessage: () => Promise.reject(new Error("can't parse rich message")),
    };
    const msg = await sendRichAudio(api, 42, "F1LE", "Song", "Artist", "https://telegra.ph/abc");
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
