import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleBridgeUpdate, isBridgeChat, parseBridgeMessage } from "../src/handlers/bridge";
import { Env } from "../src/env";
import { AudioRequestRow } from "../src/db/audioRequests";

// grammy's Api is constructed inside handleBridgeUpdate, so mock the class
// and let each test install the methods it cares about via this holder.
const apiMethods: Record<string, any> = {};
vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  class MockApi {
    constructor(_token: string) {}
    sendMessage = (...args: any[]) => apiMethods.sendMessage(...args);
    sendAudio = (...args: any[]) => apiMethods.sendAudio(...args);
    deleteMessage = (...args: any[]) => apiMethods.deleteMessage?.(...args);
  }
  return { ...actual, Api: MockApi };
});

const TOKEN = "req-token-1";

function row(overrides: Partial<AudioRequestRow> = {}): AudioRequestRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 1,
    req_token: TOKEN,
    user_id: "user-1",
    chat_id: 555,
    track_id: 64321156,
    track_title: "Song",
    artist_name: "Artist",
    telegraph_url: "https://telegra.ph/abc",
    queued_msg_id: null,
    status: "pending",
    created_at: now - 60,
    updated_at: now - 60,
    ...overrides,
  };
}

// Minimal D1 stub covering the prepare().bind().first()/all()/run() chains
// used by the audio_requests module (plus unbound prepare().all() from
// ensureTable). Stores one row returned for SELECT lookups and records
// executed statements for status assertions.
function fakeD1(existing: AudioRequestRow | null) {
  const statements: Array<{ sql: string; bound: any[] }> = [];
  const methods = (sql: string, bound: any[]) => ({
    async first<T>(): Promise<T | null> {
      if (sql.includes("SELECT id, req_token")) {
        return (existing as unknown) as T;
      }
      if (sql.includes("COUNT(*)")) {
        return { n: existing ? 1 : 0 } as unknown as T;
      }
      return null;
    },
    async all(): Promise<{ results: any[] }> {
      return { results: [] };
    },
    async run(): Promise<void> {},
  });
  return {
    statements,
    prepare(sql: string) {
      return {
        ...methods(sql, []),
        bind(...bound: any[]) {
          statements.push({ sql, bound });
          return methods(sql, bound);
        },
      };
    },
  } as unknown as any;
}

// fakeD1 variant with a working KV store for the settings table (SELECT by
// key returns the stored value; INSERT ON CONFLICT writes it) and a channels
// table for the channel-prompt path. Everything else behaves like fakeD1.
function fakeD1WithKv(
  existing: AudioRequestRow | null,
  kv: Map<string, string>,
  opts: { channels?: Array<{ channel_id: string; title: string | null }> } = {},
) {
  const base = fakeD1(existing) as any;
  const innerPrepare = base.prepare.bind(base);
  return {
    ...base,
    statements: base.statements,
    prepare(sql: string) {
      // settings SELECT: SELECT value FROM settings WHERE key = ?
      if (sql.includes("SELECT value FROM settings")) {
        return {
          bind(key: string) {
            return {
              async first(): Promise<{ value: string } | null> {
                const v = kv.get(key);
                return v === undefined ? null : { value: v };
              },
            };
          },
        };
      }
      // settings upsert
      if (sql.includes("INSERT INTO settings")) {
        return {
          bind(key: string, value: string) {
            return {
              async run(): Promise<void> {
                kv.set(key, value);
              },
            };
          },
        };
      }
      // channels listing
      if (sql.includes("FROM channels")) {
        return {
          bind() {
            return {
              async all(): Promise<{ results: any[] }> {
                return { results: opts.channels ?? [] };
              },
            };
          },
          async all(): Promise<{ results: any[] }> {
            return { results: opts.channels ?? [] };
          },
        };
      }
      return innerPrepare(sql);
    },
  };
}

function makeEnv(db: any, bridgeChatId = "777"): Env {
  return {
    BOT_TOKEN: "t",
    TELEGRAPH_ACCESS_TOKEN: "x",
    WEBHOOK_SECRET_TOKEN: "s",
    BRIDGE_CHAT_ID: bridgeChatId,
    DB: db,
    SESSION_DO: {} as any,
  } as Env;
}

function bridgeUpdate(overrides: Record<string, any> = {}) {
  return {
    message: {
      chat: { id: 777, type: "private" },
      caption: `lyq:file req=${TOKEN}`,
      audio: { file_id: "audio-file-id" },
      ...overrides,
    },
  };
}

describe("parseBridgeMessage", () => {
  it("parses file captions and fail texts", () => {
    expect(parseBridgeMessage("lyq:file req=abc-123")).toEqual({ kind: "file", token: "abc-123" });
    expect(parseBridgeMessage("lyq:fail req=abc-123 some reason")).toEqual({ kind: "fail", token: "abc-123" });
  });

  it("returns null for non-bridge or malformed text", () => {
    expect(parseBridgeMessage(undefined)).toBeNull();
    expect(parseBridgeMessage("hello there")).toBeNull();
    expect(parseBridgeMessage("lyq:file req=")).toBeNull();
    expect(parseBridgeMessage("lyq:unknown req=abc")).toBeNull();
  });
});

describe("isBridgeChat", () => {
  it("accepts only the configured private bridge chat", () => {
    const env = makeEnv(fakeD1(null));
    expect(isBridgeChat(env, bridgeUpdate())).toBe(true);
    expect(isBridgeChat(env, bridgeUpdate({ chat: { id: 999, type: "private" } }))).toBe(false);
    expect(isBridgeChat(env, bridgeUpdate({ chat: { id: 777, type: "group" } }))).toBe(false);
    expect(isBridgeChat(makeEnv(fakeD1(null), ""), bridgeUpdate())).toBe(false);
  });
});

// The expiry sweep and the status write both match "SET status"; the real
// status transition is always the LAST such statement.
function lastStatusStatement(db: { statements: Array<{ sql: string; bound: any[] }> }) {
  const matches = db.statements.filter((s: any) => s.sql.includes("SET status"));
  return matches[matches.length - 1];
}

describe("handleBridgeUpdate", () => {
  beforeEach(() => {
    for (const key of Object.keys(apiMethods)) delete apiMethods[key];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers a pending file to the requester and marks it delivered", async () => {
    const sendAudio = vi.fn(async (..._args: any[]) => {});
    apiMethods.sendAudio = sendAudio;
    const db = fakeD1(row());

    await handleBridgeUpdate(makeEnv(db), bridgeUpdate());

    expect(sendAudio).toHaveBeenCalledTimes(1);
    const [chatId, , opts] = sendAudio.mock.calls[0];
    expect(chatId).toBe(555);
    expect(opts.parse_mode).toBe("MarkdownV2");
    expect(opts.caption).toContain("Song");
    expect(opts.reply_markup.inline_keyboard[0][0]).toEqual({ text: "Lyrics", url: "https://telegra.ph/abc" });
    const statusStmt = lastStatusStatement(db);
    expect(statusStmt?.bound).toContain("delivered");
  });

  it("ignores a file whose token has no pending row", async () => {
    const sendAudio = vi.fn(async (..._args: any[]) => {});
    apiMethods.sendAudio = sendAudio;

    await handleBridgeUpdate(makeEnv(fakeD1(null)), bridgeUpdate());

    expect(sendAudio).not.toHaveBeenCalled();
  });

  it("ignores an expired row without sending", async () => {
    const sendAudio = vi.fn(async (..._args: any[]) => {});
    apiMethods.sendAudio = sendAudio;
    const now = Math.floor(Date.now() / 1000);

    await handleBridgeUpdate(makeEnv(fakeD1(row({ created_at: now - 7200 - 5 }))), bridgeUpdate());

    expect(sendAudio).not.toHaveBeenCalled();
  });

  it("delivers via the reply-tag path when the token arrives as text replying to a forwarded audio", async () => {
    const sendAudio = vi.fn(async (..._args: any[]) => {});
    apiMethods.sendAudio = sendAudio;

    await handleBridgeUpdate(makeEnv(fakeD1(row())), bridgeUpdate({
      caption: undefined,
      audio: undefined,
      text: `lyq:file req=${TOKEN}`,
      reply_to_message: { audio: { file_id: "forwarded-file-id" } },
    }));

    expect(sendAudio).toHaveBeenCalledTimes(1);
    const [chatId, fileId] = sendAudio.mock.calls[0] as unknown as any[];
    expect(chatId).toBe(555);
    expect(fileId).toBe("forwarded-file-id");
  });

  it("pairs a bare forward with the following tag when reply_to_message is missing", async () => {
    const sendAudio = vi.fn(async (..._args: any[]) => {});
    apiMethods.sendAudio = sendAudio;
    // KV store backing the settings table for the stash.
    const kv = new Map<string, string>();
    const db = fakeD1WithKv(row(), kv);

    // 1) bare forward arrives (no caption) — stashes the default audio file id
    await handleBridgeUpdate(makeEnv(db), bridgeUpdate({ caption: undefined }));
    expect(sendAudio).not.toHaveBeenCalled();

    // 2) the lyq:file tag follows, without reply_to_message
    await handleBridgeUpdate(makeEnv(db), bridgeUpdate({
      caption: undefined,
      audio: undefined,
      text: `lyq:file req=${TOKEN}`,
    }));

    expect(sendAudio).toHaveBeenCalledTimes(1);
    const [chatId, fileId] = sendAudio.mock.calls[0] as unknown as any[];
    expect(chatId).toBe(555);
    expect(fileId).toBe("audio-file-id"); // the stashed forward's file_id
    // Stash is consumed (single use).
    expect(kv.get("bridge_last_audio")).toBe("");
  });

  it("does not pair a tag when no forward was stashed", async () => {
    const sendAudio = vi.fn(async (..._args: any[]) => {});
    apiMethods.sendAudio = sendAudio;
    const kv = new Map<string, string>();
    const db = fakeD1WithKv(row(), kv);

    await handleBridgeUpdate(makeEnv(db), bridgeUpdate({
      caption: undefined,
      audio: undefined,
      text: `lyq:file req=${TOKEN}`,
    }));

    expect(sendAudio).not.toHaveBeenCalled();
  });

  it("ignores a text tag whose reply carries no audio", async () => {
    const sendAudio = vi.fn(async (..._args: any[]) => {});
    apiMethods.sendAudio = sendAudio;

    await handleBridgeUpdate(makeEnv(fakeD1(row())), bridgeUpdate({
      caption: undefined,
      audio: undefined,
      text: `lyq:file req=${TOKEN}`,
      reply_to_message: { text: "just a message" },
    }));

    expect(sendAudio).not.toHaveBeenCalled();
  });

  it("marks a failed job and notifies the requester with the deezload link", async () => {
    const sendMessage = vi.fn(async (..._args: any[]) => {});
    apiMethods.sendMessage = sendMessage;
    const db = fakeD1(row());

    await handleBridgeUpdate(makeEnv(db), bridgeUpdate({
      caption: undefined,
      audio: undefined,
      text: `lyq:fail req=${TOKEN} timeout`,
    }));

    const statusStmt = lastStatusStatement(db);
    expect(statusStmt?.bound).toContain("failed");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0];
    expect(chatId).toBe(555);
    expect(text).toContain("deezload2bot?start=deezerttrack64321156");
  });

  it("stashes pending-send context and prompts channels after delivery", async () => {
    const sendAudio = vi.fn(async (..._args: any[]) => {});
    const sendMessage = vi.fn(async (..._args: any[]) => ({ message_id: 9 }));
    apiMethods.sendAudio = sendAudio;
    apiMethods.sendMessage = sendMessage;
    const kv = new Map<string, string>();
    const db = fakeD1WithKv(row(), kv, { channels: [{ channel_id: "-100123", title: "My Channel" }] });

    await handleBridgeUpdate(makeEnv(db), bridgeUpdate({
      caption: undefined,
      audio: undefined,
      text: `lyq:file req=${TOKEN}`,
      reply_to_message: { audio: { file_id: "forwarded-file-id" } },
    }));

    // requester gets the audio AND the channel prompt
    expect(sendAudio).toHaveBeenCalledTimes(1);
    const promptCall = sendMessage.mock.calls.find((c: any[]) => c[1] === "Send to which channel?");
    expect(promptCall).toBeDefined();
    expect(JSON.stringify(promptCall?.[2])).toContain("send_channel_-100123");
    // pending-send stash written for the user
    const stash = kv.get("bridge_pending_send:user-1");
    expect(stash).toBeDefined();
    const parsed = JSON.parse(stash!);
    expect(parsed.fileId).toBe("forwarded-file-id");
    expect(parsed.telegraphUrl).toBe("https://telegra.ph/abc");
  });

  it("deletes the queued notice on failure", async () => {
    const sendMessage = vi.fn(async (..._args: any[]) => ({}));
    const deleteMessage = vi.fn(async (..._args: any[]) => ({}));
    apiMethods.sendMessage = sendMessage;
    apiMethods.deleteMessage = deleteMessage;
    const kv = new Map<string, string>();
    const db = fakeD1WithKv(row({ queued_msg_id: 4242, telegraph_url: null }), kv);

    await handleBridgeUpdate(makeEnv(db), bridgeUpdate({
      caption: undefined,
      audio: undefined,
      text: `lyq:fail req=${TOKEN} timeout`,
    }));

    // queued notice deleted, failure notify fires
    expect(deleteMessage).toHaveBeenCalledWith(555, 4242);
    const notify = sendMessage.mock.calls.find((c: any[]) => String(c[1]).includes("Couldn't fetch"));
    expect(notify).toBeDefined();
  });

  it("swallows internal errors without throwing (Telegram would redeliver on 500)", async () => {
    const db = {
      prepare() {
        throw new Error("d1 exploded");
      },
    };
    await expect(handleBridgeUpdate(makeEnv(db), bridgeUpdate())).resolves.toBeUndefined();
  });
});
