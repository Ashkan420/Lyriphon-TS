import { describe, expect, it } from "vitest";
import { InlineTrackProgress, buildInlineResultHtml } from "../src/utils/richMessages";
import { isInlineStubText } from "../src/handlers/songSearch";

const INLINE_ID = "inline-msg-1";

function makeApi(failMethods: string[] = []) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const api: any = {
    editMessageTextInline: (...args: unknown[]) => {
      calls.push({ method: "editMessageTextInline", args });
      if (failMethods.includes("editMessageTextInline")) {
        return Promise.reject(new Error("message to edit not found"));
      }
      return Promise.resolve(true);
    },
    editMessageMediaInline: (...args: unknown[]) => {
      calls.push({ method: "editMessageMediaInline", args });
      if (failMethods.includes("editMessageMediaInline")) {
        return Promise.reject(new Error("message to edit not found"));
      }
      return Promise.resolve(true);
    },
  };
  return { api, calls };
}

describe("InlineTrackProgress", () => {
  it("start() renders the checklist onto the inline message via the Inline edit method", async () => {
    const { api, calls } = makeApi();
    const progress = new InlineTrackProgress(api, INLINE_ID);
    await progress.start();

    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe(INLINE_ID);
    expect(calls[0].args[1]).toMatchObject({ html: expect.stringContaining("Fetch") });
    expect(progress.isDead).toBe(false);
  });

  it("update() targets the same inline message through state changes", async () => {
    const { api, calls } = makeApi();
    const progress = new InlineTrackProgress(api, INLINE_ID);
    await progress.start();
    calls.length = 0;

    await progress.update({ stage: "metadata", trackName: "Song" });
    await progress.update({ stage: "lyrics", albumName: "Album" });

    expect(calls.every((c) => c.method === "editMessageTextInline")).toBe(true);
    expect(calls.every((c) => c.args[0] === INLINE_ID)).toBe(true);
    expect(calls[0].args[1]).toMatchObject({ html: expect.stringContaining("Fetching album metadata") });
  });

  it("skips updates whose content is identical (message-not-modified guard)", async () => {
    const { api, calls } = makeApi();
    const progress = new InlineTrackProgress(api, INLINE_ID);
    await progress.start();
    calls.length = 0;

    await progress.update({ stage: "info" });
    expect(calls).toHaveLength(0);
  });

  it("finalizeText sends plain HTML with the keyboard and reports success", async () => {
    const { api, calls } = makeApi();
    const progress = new InlineTrackProgress(api, INLINE_ID);
    const ok = await progress.finalizeText("<b>done</b>", {
      inline_keyboard: [[{ text: "Lyrics", url: "https://telegra.ph/x" }]],
    });

    expect(ok).toBe(true);
    expect(calls[0].args[0]).toBe(INLINE_ID);
    expect(calls[0].args[1]).toBe("<b>done</b>");
    const opts: any = calls[0].args[2];
    expect(opts.parse_mode).toBe("HTML");
    expect(opts.reply_markup.inline_keyboard[0][0]).toEqual({ text: "Lyrics", url: "https://telegra.ph/x" });
  });

  it("goes dead after a non-parse failure (deleted/unknown message)", async () => {
    const { api, calls } = makeApi(["editMessageTextInline"]);
    const progress = new InlineTrackProgress(api, INLINE_ID);
    await progress.start();

    expect(progress.isDead).toBe(true);

    calls.length = 0;
    await progress.update({ stage: "lyrics" });
    await progress.fail("boom");
    expect(calls).toHaveLength(0);
  });

  it("markMusicFailed shows the failed Music note", async () => {
    const { api, calls } = makeApi();
    const progress = new InlineTrackProgress(api, INLINE_ID);
    await progress.start();
    calls.length = 0;

    await progress.markMusicFailed();

    expect(calls).toHaveLength(1);
    const html: string = (calls[0].args[1] as any).html;
    expect(html).toContain("Music file");
    expect(html).toContain("failed");
  });

  it("finalizeAsAudio morphs the message into the audio with caption and keyboard", async () => {
    const { api, calls } = makeApi();
    const progress = new InlineTrackProgress(api, INLINE_ID);
    const ok = await progress.finalizeAsAudio(
      "file-id-1",
      "caption text",
      { inline_keyboard: [[{ text: "Lyrics", url: "https://telegra.ph/x" }]] },
    );

    expect(ok).toBe(true);
    expect(calls[0].method).toBe("editMessageMediaInline");
    const [inlineId, media, opts] = calls[0].args as [string, any, any];
    expect(inlineId).toBe(INLINE_ID);
    expect(media).toMatchObject({ type: "audio", media: "file-id-1", caption: "caption text", parse_mode: "MarkdownV2" });
    expect(opts.reply_markup.inline_keyboard[0][0].text).toBe("Lyrics");
  });
});

describe("buildInlineResultHtml", () => {
  it("renders the compact card with the lyrics link", () => {
    const html = buildInlineResultHtml({
      trackName: "Hello",
      artistName: "Adele",
      albumName: "25",
      releaseDate: "2015",
      telegraphUrl: "https://telegra.ph/hello-01",
    });
    expect(html).toContain("Telegraph Created");
    expect(html).toContain("Hello");
    expect(html).toContain("Adele");
    expect(html).toContain("https://telegra.ph/hello-01");
    expect(html).not.toContain("Send a music file");
    expect(html).not.toContain("Edit options");
  });

  it("escapes HTML-significant text", () => {
    const html = buildInlineResultHtml({
      trackName: "<b>Track</b>",
      artistName: "A & B",
      albumName: "25",
      releaseDate: "2015",
      telegraphUrl: "https://telegra.ph/x",
    });
    expect(html).toContain("&lt;b&gt;Track&lt;/b&gt;");
    expect(html).toContain("A &amp; B");
  });
});

describe("renderTrackProgressHtml (music stage)", () => {
  it("renders five checklist items including Music file", () => {
    // Re-imported here to assert the shared renderer's stage list.
    return import("../src/utils/richMessages").then(({ renderTrackProgressHtml }) => {
      const html = renderTrackProgressHtml({ stage: "info" });
      expect(html).toContain("Track info");
      expect(html).toContain("Album metadata");
      expect(html).toContain("Lyrics");
      expect(html).toContain("Telegraph page");
      expect(html).toContain("Music file");
    });
  });
});

describe("isInlineStubText", () => {
  it("detects the picker's stub text", () => {
    expect(isInlineStubText("🎵 Godzilla\n👤 Eminem\n⏱ 3:31")).toBe(true);
    expect(isInlineStubText("   🎵 Godzilla")).toBe(true);
  });

  it("leaves normal queries alone", () => {
    expect(isInlineStubText("godzilla eminem")).toBe(false);
    expect(isInlineStubText("/song hello")).toBe(false);
    expect(isInlineStubText("")).toBe(false);
  });
});
