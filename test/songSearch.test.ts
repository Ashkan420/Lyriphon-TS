import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { handlePlainTextInput, songSearchCommand } from "../src/handlers/songSearch";
import { searchTracks } from "../src/services/deezer";
import { createSessionData } from "../src/session/flows";
import { SessionMode } from "../src/session/types";

vi.mock("../src/services/deezer", () => ({
  searchTracks: vi.fn(),
  getTrack: vi.fn(),
  getAlbum: vi.fn(),
}));

const mockedSearch = vi.mocked(searchTracks);

// Minimal send surface: searchAndShowResults uses api.sendMessage; the
// handlers use ctx.reply for usage/cancel messages. The vi.fn instances are
// returned alongside the ctx so assertions can reach .mock without fighting
// the grammY RawApi typings.
function makeCtx(text: string, chatType: string) {
  const sendMessage = vi.fn(async (_chatId: number, _text: string) => ({ message_id: 12 }));
  const deleteMessage = vi.fn(async (_chatId: number, _messageId: number) => {});
  const reply = vi.fn(async (_text: string) => ({ message_id: 11 }));
  const ctx = {
    chat: { id: 42, type: chatType },
    message: { text, message_id: 10 },
    reply,
    api: { sendMessage, deleteMessage },
  } as unknown as Context & Record<string, any>;
  return { ctx, sendMessage, deleteMessage, reply };
}

const env = {} as any;

beforeEach(() => {
  mockedSearch.mockReset();
});

describe("handlePlainTextInput", () => {
  it("searches with the full message text and presents results", async () => {
    mockedSearch.mockResolvedValue([
      { id: 1, title: "Song A", artist: { name: "Artist X" }, duration: 61 },
    ]);

    const { ctx, sendMessage } = makeCtx("imagine dragons believer", "private");
    await handlePlainTextInput(ctx, createSessionData(), env);

    expect(mockedSearch).toHaveBeenCalledWith("imagine dragons believer");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0];
    expect(call[0]).toBe(42);
    expect(String(call[1])).toContain("Select the track");
  });

  it("reports no results when the search comes back empty", async () => {
    mockedSearch.mockResolvedValue([]);

    const { ctx, sendMessage } = makeCtx("zzzz no such song", "private");
    await handlePlainTextInput(ctx, createSessionData(), env);

    expect(mockedSearch).toHaveBeenCalledWith("zzzz no such song");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0][1])).toContain("No results found");
  });

  it("ignores text that looks like a command", async () => {
    const { ctx, sendMessage } = makeCtx("/foo bar", "private");
    await handlePlainTextInput(ctx, createSessionData(), env);

    expect(mockedSearch).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ignores plain text in group chats", async () => {
    const { ctx, sendMessage } = makeCtx("some song", "group");
    await handlePlainTextInput(ctx, createSessionData(), env);

    expect(mockedSearch).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("never mutates edit buffers, even if handed an edit-mode session", async () => {
    // bot.ts routes edit-mode text to processTextMessage before this runs,
    // so handlePlainTextInput is mode-agnostic by design — but it must not
    // corrupt any lyrics/field edit state either way.
    mockedSearch.mockResolvedValue([]);
    const session = createSessionData();
    session.mode = SessionMode.EDIT_LYRICS;
    session.edit.field = "lyrics";
    session.lyrics.buffer = ["keep me"];

    const { ctx, sendMessage } = makeCtx("some song", "private");
    await handlePlainTextInput(ctx, session, env);

    expect(mockedSearch).toHaveBeenCalledWith("some song");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(session.lyrics.buffer).toEqual(["keep me"]);
    expect(session.edit.field).toBe("lyrics");
  });
});

describe("songSearchCommand (regression)", () => {
  it("still extracts only the part after /song from ctx.match", async () => {
    mockedSearch.mockResolvedValue([]);

    const { ctx } = makeCtx("/song believer", "private");
    // grammY sets ctx.match to the text after the command for bot.command.
    (ctx as any).match = "believer";

    await songSearchCommand(ctx, createSessionData(), env);

    expect(mockedSearch).toHaveBeenCalledWith("believer");
  });

  it("shows usage when no query is given", async () => {
    const { ctx, reply } = makeCtx("/song", "private");
    (ctx as any).match = "";

    await songSearchCommand(ctx, createSessionData(), env);

    expect(mockedSearch).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("❌ Usage: /song <track name>");
  });
});
