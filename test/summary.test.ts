import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRefreshSummaryCallback } from "../src/handlers/callbacks/summary";
import { createSessionData } from "../src/session/flows";
import { hashString } from "../src/handlers/callbacks/index";
import { SessionData } from "../src/session/types";

function makeCtx() {
  return {
    callbackQuery: { data: "refresh_summary" },
    chat: { id: 1 },
    answerCallbackQuery: vi.fn(async () => {}),
  } as any;
}

function sessionWithPage(lyrics = "a\nb"): SessionData {
  const session = createSessionData();
  session.telegraph.data = { path: "p-1", track: "T", artist: "AR" };
  session.telegraph.originalLyrics = lyrics;
  return session;
}

function okTelegraphResponse() {
  return new Response(JSON.stringify({ ok: true, result: { path: "p-1" } }), { status: 200 });
}

function lastFetchBody(): any {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  const body = calls[calls.length - 1][1].body;
  return JSON.parse(body);
}

function headingOf(content: any[]): any {
  return content.find((n) => n.tag === "h3");
}

describe("handleRefreshSummaryCallback", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("no fetch queued");
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("answers with the no-page alert when there is no active page", async () => {
    const session = createSessionData();
    const ctx = makeCtx();

    await handleRefreshSummaryCallback(ctx, session, {} as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "No active Telegraph page", show_alert: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("increments the counter and touches the heading with zero-width spaces", async () => {
    const session = sessionWithPage();
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => okTelegraphResponse()));

    await handleRefreshSummaryCallback(ctx, session, { TELEGRAPH_ACCESS_TOKEN: "t" } as any);

    expect(session.telegraph.summaryRefreshCount).toBe(1);
    const heading = headingOf(lastFetchBody().content);
    expect(heading.children[0]).toBe("Lyrics​");
    expect(heading.children[0].length).toBe(7);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "✨ AI summary refreshed" });
  });

  it("keeps a cached translation on the page after a refresh", async () => {
    const session = sessionWithPage("hello\nworld");
    session.telegraph.activeLang = "en";
    session.telegraph.translatedLyrics = {
      [`en:${hashString("hello\nworld")}`]: {
        originalHash: hashString("hello\nworld"),
        text: JSON.stringify({ lines: [{ n: 1, t: "hola" }, { n: 2, t: "mundo" }] }),
      },
    };
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => okTelegraphResponse()));

    await handleRefreshSummaryCallback(ctx, session, { TELEGRAPH_ACCESS_TOKEN: "t" } as any);

    const sent = JSON.stringify(lastFetchBody().content);
    expect(sent).toContain("[hola]");
    expect(sent).toContain("[mundo]");
  });

  it("falls back to original lyrics when the active translation has no cache entry", async () => {
    const session = sessionWithPage("hello\nworld");
    session.telegraph.activeLang = "en"; // no translatedLyrics entry
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => okTelegraphResponse()));

    await handleRefreshSummaryCallback(ctx, session, { TELEGRAPH_ACCESS_TOKEN: "t" } as any);

    const sent = JSON.stringify(lastFetchBody().content);
    expect(sent).toContain("hello");
    expect(sent).not.toContain("[hola]");
  });

  it("grows the touch on consecutive refreshes so content always differs", async () => {
    const session = sessionWithPage();
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => okTelegraphResponse()));

    await handleRefreshSummaryCallback(ctx, session, { TELEGRAPH_ACCESS_TOKEN: "t" } as any);
    const first = headingOf(lastFetchBody().content).children[0];

    await handleRefreshSummaryCallback(ctx, session, { TELEGRAPH_ACCESS_TOKEN: "t" } as any);
    const second = headingOf(lastFetchBody().content).children[0];

    expect(first).toBe("Lyrics​");
    expect(second).toBe("Lyrics​​");
    expect(session.telegraph.summaryRefreshCount).toBe(2);
  });

  it("alerts on a failed Telegraph edit", async () => {
    const session = sessionWithPage();
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "PAGE_NOT_FOUND" }), { status: 200 })));

    await handleRefreshSummaryCallback(ctx, session, { TELEGRAPH_ACCESS_TOKEN: "t" } as any);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "❌ Failed to refresh AI summary", show_alert: true });
  });
});
