import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTranslateCallback } from "../src/handlers/callbacks/translate";
import { createSessionData } from "../src/session/flows";
import { hashString } from "../src/handlers/callbacks/index";
import { SessionData } from "../src/session/types";

function geminiSuccess(lines: string[]): Response {
  const payload = {
    candidates: [
      { content: { parts: [{ text: JSON.stringify({ lines: lines.map((t, i) => ({ n: i + 1, t })) }) }] } },
    ],
  };
  return new Response(JSON.stringify(payload), { status: 200 });
}

function makeCtx(data: string) {
  const api = {
    editMessageText: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
  };
  const ctx = {
    callbackQuery: { data },
    chat: { id: 1 },
    api,
    reply: vi.fn(async () => ({ message_id: 777 })),
    // answerCallbackQuery is called with no args for plain acknowledges and
    // with { text, show_alert } for alerts; accept anything and record it.
    answerCallbackQuery: vi.fn(async () => {}),
  } as any;
  return { ctx, api };
}

function envWith(): any {
  return { GEMINI_API_KEY: "test-key", TRANSLATION_PROVIDER: "gemini" };
}

function sessionWithLyrics(): SessionData {
  const session = createSessionData();
  session.telegraph.originalLyrics = "a\nb\nc";
  session.telegraph.translateMessageId = 42;
  return session;
}

function lastEditCall(api: { editMessageText: ReturnType<typeof vi.fn> }): { text: string; markup: any } {
  const calls = api.editMessageText.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const last = calls[calls.length - 1];
  return { text: last[2] as string, markup: last[3] ?? undefined };
}

function retryData(opts: any): string | undefined {
  // safeEdit passes the keyboard as opts.reply_markup.
  const kb = opts?.reply_markup?.inline_keyboard ?? opts?.inline_keyboard;
  return kb?.flat().find((b: any) => b.callback_data === "translate:retry")?.callback_data;
}

describe("translate retry button", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("no fetch queued");
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("attaches a Retry keyboard when translation fails, keeping state actionable", async () => {
    const session = sessionWithLyrics();
    const { ctx, api } = makeCtx("translate:lang:fa");

    // Permanent 400s bail out of the model chain with no backoff delays. The
    // failure now triggers one retry-hint attempt, then the format-error UI.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 400 })));

    await handleTranslateCallback(ctx, session, envWith());

    const { text, markup } = lastEditCall(api);
    expect(text).toContain("Translation format error");
    expect(retryData(markup)).toBe("translate:retry");
    expect(session.telegraph.isTranslating).toBe(false);
    expect(session.telegraph.translateMessageId).toBe(42);
    expect(session.telegraph.pendingTranslationLang).toBe("fa");
  });

  it("retry after failure re-runs translation and succeeds", async () => {
    const session = sessionWithLyrics();
    session.telegraph.pendingTranslationLang = "fa";

    // First call: permanent 400s exhaust the whole model chain and fail;
    // second call: the chain succeeds. Flag-driven rather than a fixed
    // response queue so the test doesn't depend on the chain length.
    let shouldSucceed = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (!shouldSucceed) return new Response("bad key", { status: 400 });
      return geminiSuccess(["۱", "۲", "۳"]);
    }));

    const fail = makeCtx("translate:lang:fa");
    await handleTranslateCallback(fail.ctx, session, envWith());
    expect(session.telegraph.pendingTranslationLang).toBe("fa");

    shouldSucceed = true;
    const retry = makeCtx("translate:retry");
    await handleTranslateCallback(retry.ctx, session, envWith());

    const { text } = lastEditCall(retry.api);
    expect(text).toContain("✅ Lyrics translated");
    expect(session.telegraph.activeLang).toBe("fa");
    expect(session.telegraph.isTranslating).toBe(false);
    expect(session.telegraph.pendingTranslationLang).toBeUndefined();
    expect(session.telegraph.translateMessageId).toBeUndefined();
  });

  it("retry without pending translation answers and does nothing else", async () => {
    const session = sessionWithLyrics();
    const { ctx, api } = makeCtx("translate:retry");

    await handleTranslateCallback(ctx, session, envWith());

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: "No pending translation" }));
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(session.telegraph.isTranslating).toBe(false);
  });

  it("retry during cooldown shows the rate-limit message without calling Gemini", async () => {
    const session = sessionWithLyrics();
    session.telegraph.pendingTranslationLang = "fa";
    session.telegraph.translationCooldownUntil = Date.now() + 30000;

    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, api } = makeCtx("translate:retry");
    await handleTranslateCallback(ctx, session, envWith());

    expect(fetchMock).not.toHaveBeenCalled();
    const { text, markup } = lastEditCall(api);
    expect(text).toContain("rate-limited");
    expect(retryData(markup)).toBe("translate:retry");
    expect(session.telegraph.translationCooldownUntil).toBeGreaterThan(Date.now());
  });

  it("retry re-applies a cached translation without a Gemini call", async () => {
    const session = sessionWithLyrics();
    session.telegraph.pendingTranslationLang = "fa";
    const lyrics = session.telegraph.originalLyrics!;
    const rawJson = JSON.stringify({ lines: [{ n: 1, t: "۱" }, { n: 2, t: "۲" }, { n: 3, t: "۳" }] });
    session.telegraph.translatedLyrics = {
      [`fa:${hashString(lyrics)}`]: { originalHash: hashString(lyrics), text: rawJson },
    };

    const fetchMock = vi.fn(async () => {
      throw new Error("should not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, api } = makeCtx("translate:retry");
    await handleTranslateCallback(ctx, session, envWith());

    expect(fetchMock).not.toHaveBeenCalled();
    const { text } = lastEditCall(api);
    expect(text).toContain("Persian lyrics added");
    expect(session.telegraph.activeLang).toBe("fa");
    expect(session.telegraph.pendingTranslationLang).toBeUndefined();
  });
});
