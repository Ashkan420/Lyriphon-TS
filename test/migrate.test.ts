import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyScannedMessage,
  extractLyricsUrl,
  attachLyricsButton,
  applyOutcome,
  confirmationKeyboard,
  nextCandidate,
  type ScannedMessage,
} from "../src/handlers/migrate";
import { migrationOf, resetSessionData } from "../src/session/flows";
import { createSessionData } from "../src/session/flows";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Row = {
  id: number;
  channel_id: string;
  user_id: string;
  message_id: number;
  status: string;
  outcome: string | null;
  has_lyrics_button: number;
  existing_url: string | null;
  existing_markup: string | null;
  title: string | null;
  artist: string | null;
  file_name: string | null;
  created_at: number;
};

// In-memory scan_queue covering the statement shapes src/db/scanQueue.ts
// issues: INSERT OR IGNORE (dedup on channel+message), the pending listing,
// the guarded outcome UPDATE (only pending rows), and the aggregates.
function fakeScanDb(seed: Row[] = []) {
  const rows: Row[] = seed.map((r) => ({ ...r }));
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const statements: string[] = [];

  const make = (sql: string) => {
    let bound: any[] = [];
    const exec = () => {
      statements.push(sql.trim().replace(/\s+/g, " "));

      if (sql.includes("INSERT OR IGNORE INTO scan_queue")) {
        const [channel_id, user_id, message_id, status, has_btn, url, markup, title, artist, file_name] = bound;
        const dup = rows.some((r) => r.channel_id === channel_id && r.message_id === message_id);
        if (!dup) {
          rows.push({
            id: nextId++, channel_id, user_id, message_id, status, outcome: null,
            has_lyrics_button: has_btn, existing_url: url, existing_markup: markup,
            title, artist, file_name, created_at: 1,
          });
        }
        return { changed: !dup };
      }

      if (sql.includes("ORDER BY message_id DESC")) {
        const [user_id, channel_id] = bound;
        return rows
          .filter((r) => r.user_id === user_id && r.channel_id === channel_id && r.status === "pending")
          // Newest post first, matching src/db/scanQueue.ts — a post added
          // after an earlier scan must come first, not last.
          .sort((a, b) => b.message_id - a.message_id);
      }

      if (sql.includes("WHERE id = ?") && sql.includes("SET status = 'handled'")) {
        const [outcome, id] = bound;
        const row = rows.find((r) => r.id === id && r.status === "pending");
        if (row) { row.status = "handled"; row.outcome = outcome; }
        return { changed: !!row };
      }

      if (sql.includes("WHERE id = ?") && sql.includes("SET status = ?")) {
        const [status, id] = bound;
        const row = rows.find((r) => r.id === id);
        if (row) row.status = status;
        return { changed: !!row };
      }

      if (sql.includes("WHERE id = ?")) {
        return rows.filter((r) => r.id === bound[0]);
      }

      if (sql.includes("SUM(CASE")) {
        const [user_id, channel_id] = bound;
        const scope = rows.filter((r) => r.user_id === user_id && r.channel_id === channel_id);
        if (sql.includes("status = 'handled'")) {
          const handled = scope.filter((r) => r.status === "handled");
          return [{
            added: handled.filter((r) => r.outcome === "added").length,
            declined: handled.filter((r) => r.outcome === "declined").length,
            edited: handled.filter((r) => r.outcome === "edited").length,
          }];
        }
        return [{
          pending: scope.filter((r) => r.status === "pending").length,
          handled: scope.filter((r) => r.status === "handled").length,
          failed: scope.filter((r) => r.status === "failed").length,
        }];
      }

      if (sql.includes("SELECT 1 FROM scan_queue")) return [];

      // The channel picker reads the registered-channels table, which the
      // scan fake does not model otherwise.
      if (sql.includes("FROM channels")) {
        return [{
          id: 1,
          user_id: bound[0],
          channel_id: "-1001",
          title: "Test Channel",
          created_at: 1,
        }];
      }

      return [];
    };

    return {
      bind(...b: any[]) { bound = b; return this; },
      async all<T>() { return { results: exec() as unknown as T[] }; },
      async first<T>() { const r = exec(); return ((Array.isArray(r) ? r[0] : r) ?? null) as T; },
      async run() {
        const r = exec();
        const changed = r && typeof r === "object" && "changed" in (r as any)
          ? ((r as any).changed ? 1 : 0)
          : 1;
        return { meta: { changes: changed } };
      },
    };
  };

  return {
    rows,
    statements,
    prepare: (sql: string) => make(sql),
  };
}

function scanRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 1, channel_id: "-1001", user_id: "42", message_id: 7,
    status: "pending", outcome: null, has_lyrics_button: 0, existing_url: null,
    existing_markup: null,
    title: "Saberoze", artist: "Shervin", file_name: "song.mp3", created_at: 1,
    ...overrides,
  };
}

// Recording API: every method a run might reach for is a vi.fn so an
// accidental call is caught rather than silently undefined.
function recordingApi() {
  const api: any = {};
  for (const m of [
    "editMessageReplyMarkup", "sendAudio", "sendRichAudio", "deleteMessage",
    "copyMessage", "editMessageMedia", "editMessageCaption", "sendMessage",
    "editMessageText",
  ]) {
    api[m] = vi.fn(() => Promise.resolve(true));
  }
  return { api, methods: () => Object.keys(api).filter((k) => api[k].mock.calls.length) };
}

function audioMessage(overrides: Partial<ScannedMessage> = {}): ScannedMessage {
  return {
    messageId: 7,
    kind: "audio",
    groupId: null,
    caption: ">`Saberoze — Shervin`[‎](https://telegra.ph/Saberoze-01-01)",
    buttons: [],
    audio: { title: "Saberoze", performer: "Shervin", fileName: "song.mp3" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T016 — candidate classification (FR-012, FR-013, FR-013a, FR-028, SC-004)
// ---------------------------------------------------------------------------

describe("candidate classification", () => {
  it("offers a single music file with no button", () => {
    const r = classifyScannedMessage(audioMessage());
    expect(r.kind).toBe("record");
    expect((r as any).status).toBe("pending");
    expect((r as any).hasLyricsButton).toBe(false);
  });

  it("ignores albums, photos, videos and text (no row at all)", () => {
    expect(classifyScannedMessage(audioMessage({ kind: "other", groupId: null, audio: null })).kind).toBe("ignore");
    // media group — a message in an album is not a single music file
    expect(classifyScannedMessage(audioMessage({ groupId: 99 })).kind).toBe("ignore");
    expect(classifyScannedMessage(audioMessage({ audio: null })).kind).toBe("ignore");
  });

  it("records a Lyrics-button post as skipped, never pending (FR-013)", () => {
    const r = classifyScannedMessage(audioMessage({
      buttons: [{ text: "Lyrics", url: "https://telegra.ph/Saberoze-01-01" }],
    }));
    expect(r.kind).toBe("record");
    expect((r as any).status).toBe("skipped");
    expect((r as any).hasLyricsButton).toBe(true);
  });

  it("still offers a post carrying some OTHER button (FR-013a)", () => {
    const r = classifyScannedMessage(audioMessage({
      // no link in the caption, so the lone URL button is what remains
      caption: "plain caption with no link",
      buttons: [{ text: "Share", url: "https://t.me/share/url" }],
    }));
    expect(r.kind).toBe("record");
    expect((r as any).status).toBe("pending");
    expect((r as any).hasLyricsButton).toBe(false);
    // the unrelated link is still the only link the post carries, so reuse it
    expect((r as any).existingUrl).toBe("https://t.me/share/url");
    // and it is captured for the merge, so adding Lyrics will not drop it
    expect(JSON.parse((r as any).existingMarkup)[0][0].text).toBe("Share");
  });

  it("prefers the page link hidden in the caption over an unrelated button", () => {
    const r = classifyScannedMessage(audioMessage({
      buttons: [{ text: "Share", url: "https://t.me/share/url" }],
    }));
    expect((r as any).existingUrl).toBe("https://telegra.ph/Saberoze-01-01");
  });

  it("ignores a FORWARDED post — it can never be edited (FR-012)", () => {
    // Telegram answers "message can't be edited" for forwards no matter who is
    // admin, so offering one only burns a Yes and reports an unfixable failure.
    const r = classifyScannedMessage(audioMessage({ forwarded: true }));
    expect(r).toEqual({ kind: "ignore", reason: "forwarded" });

    // …and even a forward that carries a button is not a candidate
    const keyed = classifyScannedMessage(audioMessage({
      forwarded: true,
      buttons: [{ text: "Lyrics", url: "https://telegra.ph/x" }],
    }));
    expect(keyed.kind).toBe("ignore");

    // an ordinary post is unaffected
    expect(classifyScannedMessage(audioMessage({ forwarded: false })).kind).toBe("record");
  });

  it("ignores a post from another author (FR-011)", () => {
    expect(classifyScannedMessage(audioMessage({ fromSelf: false })).kind).toBe("ignore");
  });

  it("never duplicates a post already handled, so a re-run offers nothing (FR-028, SC-007)", async () => {
    const db = fakeScanDb();
    const { insertScanCandidates, listPending } = await import("../src/db/scanQueue");

    await insertScanCandidates(db as any, [{
      channel_id: "-1001", user_id: "42", message_id: 7,
      has_lyrics_button: false, existing_url: "https://telegra.ph/x", existing_markup: null,
      title: "T", artist: "A", file_name: "f.mp3",
    }]);
    // same page read twice
    await insertScanCandidates(db as any, [{
      channel_id: "-1001", user_id: "42", message_id: 7,
      has_lyrics_button: false, existing_url: "https://telegra.ph/x", existing_markup: null,
      title: "T", artist: "A", file_name: "f.mp3",
    }]);

    expect(db.rows).toHaveLength(1);

    // once handled, a re-scan still cannot re-offer it: the row is not pending
    await applyOutcome(db as any, db.rows[0].id, "added");
    const pending = await listPending(db as any, "42", "-1001");
    expect(pending).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T017 — existing-link extraction (FR-014c, research S3)
// ---------------------------------------------------------------------------

describe("existing-link extraction", () => {
  it("reads the link from the inline keyboard", () => {
    expect(extractLyricsUrl([{ text: "Lyrics", url: "https://telegra.ph/a" }]))
      .toBe("https://telegra.ph/a");
  });

  it("reads the link from the message body when there is no keyboard (rich delivery)", () => {
    const body = `👇 <a href="https://telegra.ph/b">📖 Open</a>` +
      `<tg-button type="url" url="https://telegra.ph/b">Lyrics</tg-button>`;
    expect(extractLyricsUrl([], body)).toBe("https://telegra.ph/b");
  });

  it("prefers the button labelled Lyrics over other links", () => {
    expect(extractLyricsUrl(
      [{ text: "Other", url: "https://example.com" }, { text: "Lyrics", url: "https://telegra.ph/c" }],
    )).toBe("https://telegra.ph/c");
  });

  it("falls back to a lone URL button", () => {
    expect(extractLyricsUrl([{ text: "Anything", url: "https://telegra.ph/d" }]))
      .toBe("https://telegra.ph/d");
  });

  it("returns null when there is no link anywhere (FR-014 triggers)", () => {
    expect(extractLyricsUrl([])).toBeNull();
    expect(extractLyricsUrl([], "plain caption with no link")).toBeNull();
    expect(extractLyricsUrl([{ text: "Not a link" }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T019 — run transitions (data-model §5)
// ---------------------------------------------------------------------------

describe("run transitions", () => {
  const seed = () => fakeScanDb([
    scanRow({ id: 1, message_id: 101 }),
    scanRow({ id: 2, message_id: 102 }),
  ]);

  it("Yes advances the cursor and records 'added'", async () => {
    const db = seed();
    const m = migrationOf(createSessionData());
    m.phase = "pending";

    // Newest post first: message 102 outranks 101 regardless of row id.
    const row = await nextCandidate(db as any, "42", "-1001", m);
    expect(row?.id).toBe(2);

    expect(await applyOutcome(db as any, row!.id, "added")).toBe(true);
    expect(db.rows[1].status).toBe("handled");
    expect(db.rows[1].outcome).toBe("added");
    expect(db.rows[0].status).toBe("pending");   // older post still queued

    const next = await nextCandidate(db as any, "42", "-1001", m);
    expect(next?.id).toBe(1);
  });

  it("No advances the cursor and records 'declined', changing nothing else", async () => {
    const db = seed();
    const row = await nextCandidate(db as any, "42", "-1001", migrationOf(createSessionData()));
    await applyOutcome(db as any, row!.id, "declined");

    expect(row!.id).toBe(2);            // newest first
    expect(db.rows[1].outcome).toBe("declined");
    expect(db.rows[1].message_id).toBe(102);
    expect(db.rows[0].outcome).toBeNull();      // older post untouched
    const next = await nextCandidate(db as any, "42", "-1001", migrationOf(createSessionData()));
    expect(next?.id).toBe(1);
  });

  it("a tap on a row that is no longer pending is a no-op (stale/double tap)", async () => {
    const db = seed();
    const row = await nextCandidate(db as any, "42", "-1001", migrationOf(createSessionData()));
    await applyOutcome(db as any, row!.id, "added");

    // second tap on the same candidate
    expect(await applyOutcome(db as any, row!.id, "added")).toBe(false);
    const handled = db.rows.find((r) => r.id === row!.id)!;
    expect(handled.outcome).toBe("added"); // not double-counted
  });

  it("ends the run when nothing is pending", async () => {
    const db = fakeScanDb([scanRow({ id: 1, status: "handled" })]);
    const m = migrationOf(createSessionData());
    expect(await nextCandidate(db as any, "42", "-1001", m)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T020 — the ONLY call that may touch the channel (FR-025/026/027, SC-003/005)
// ---------------------------------------------------------------------------

describe("channel writes", () => {
  it("Yes makes exactly one editMessageReplyMarkup and nothing else", async () => {
    const { api, methods } = recordingApi();
    const ok = await attachLyricsButton(api, -1001, 7, "https://telegra.ph/x", []);

    expect(ok).toBe(true);
    expect(methods()).toEqual(["editMessageReplyMarkup"]);
    for (const forbidden of [
      "sendAudio", "sendRichAudio", "deleteMessage", "copyMessage",
      "editMessageMedia", "editMessageCaption",
    ]) {
      expect(methods()).not.toContain(forbidden);
    }

    // Exactly one attempt, and it is the markup-only method.
    expect(api.editMessageReplyMarkup).toHaveBeenCalledTimes(1);
  });

  it("merges with buttons the post already carries instead of replacing them (FR-013a)", async () => {
    const { api } = recordingApi();
    await attachLyricsButton(api, -1001, 7, "https://telegra.ph/x",
      [[{ text: "Share", url: "https://t.me/s" }]]);

    const markup = api.editMessageReplyMarkup.mock.calls[0][2].reply_markup;
    const texts = markup.inline_keyboard.flat().map((b: any) => b.text);
    expect(texts).toContain("Share");
    expect(texts).toContain("Lyrics");
  });

  it("passes no caption and no media fields — they cannot be altered (FR-027)", async () => {
    const { api } = recordingApi();
    await attachLyricsButton(api, -1001, 7, "https://telegra.ph/x", []);
    const args = api.editMessageReplyMarkup.mock.calls[0];
    expect(args[0]).toBe(-1001);
    expect(args[1]).toBe(7);
    const payload = args[2];
    expect(payload).toHaveProperty("reply_markup");
    expect(payload).not.toHaveProperty("caption");
    expect(payload).not.toHaveProperty("media");
    expect(payload).not.toHaveProperty("parse_mode");
  });

  it("No makes no channel call at all", async () => {
    const { methods } = recordingApi();
    expect(methods()).toEqual([]);
  });

  it("reports failure instead of falling back to a media method (FR-029)", async () => {
    const api: any = {
      editMessageReplyMarkup: vi.fn(() => Promise.reject(new Error("MESSAGE_ID_INVALID"))),
      sendAudio: vi.fn(() => Promise.resolve(true)),
      editMessageMedia: vi.fn(() => Promise.resolve(true)),
    };
    const ok = await attachLyricsButton(api, -1001, 7, "https://telegra.ph/x", []);
    expect(ok).toBe(false);
    expect(api.sendAudio).not.toHaveBeenCalled();
    expect(api.editMessageMedia).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T038 / T044 — the Edit path: opens the page, never touches the channel, and
// never advances the run (FR-023, FR-024c).
// ---------------------------------------------------------------------------

// The Telegraph service is the only thing Edit reaches for; everything else in
// the path is exercised for real (session state, the scan queue, the menu).
vi.mock("../src/services/telegraph", () => ({
  getTelegraphPage: vi.fn(async () => ({
    ok: true,
    url: "https://telegra.ph/Saberoze-01-01",
    path: "Saberoze-01-01",
    title: "Saberoze",
    authorName: "Lyriphon",
    authorUrl: "",
    // onEdit rejects an empty page, so the stub must carry one node
    content: [{ className: "paragraph" }],
  })),
  parseTelegraphPage: vi.fn(() => ({
    track: "Saberoze", artist: "Shervin", album: "Test", releaseDate: "2001",
    authorName: "Lyriphon", trackId: 123, path: "Saberoze-01-01",
    trackLink: "", artistLink: "", albumLink: "", albumCoverUrl: "",
    lyrics: "line one\nline two",
  })),
  createSongTelegraph: vi.fn(async () => ({
    url: "https://telegra.ph/Built-01-01",
    path: "Built-01-01",
    lastData: { track: "Built" },
  })),
}));

// The page-creation chain must go through the SAME helpers the normal send
// uses, and must never reach for delivery plumbing.
vi.mock("../src/services/deezer", () => ({
  searchTracks: vi.fn(async () => [
    { id: 123, title: "Built", artist: { name: "Someone" }, album: { id: 7 } },
  ]),
  getTrack: vi.fn(async () => ({
    title: "Built",
    artist: { id: 9, name: "Someone" },
    album: { id: 7, title: "Album", cover_xl: "https://img/cover.jpg" },
  })),
  getAlbum: vi.fn(async () => ({ release_date: "2001-01-01" })),
}));

vi.mock("../src/services/lrclib", () => ({
  getLyrics: vi.fn(async () => "line one\nline two"),
}));

vi.mock("../src/db/tracks", () => ({
  getTrackRecord: vi.fn(async () => null),
  upsertTrack: vi.fn(async () => undefined),
  setTrackFileId: vi.fn(async () => undefined),
}));

vi.mock("../src/db/audioRequests", () => ({
  createAudioRequest: vi.fn(async () => undefined),
}));

import { handleMigrationCallback } from "../src/handlers/callbacks/migrate";
import { buildEditMenu } from "../src/handlers/callbacks/index";

function makeCtx(data: string) {
  const calls: Array<{ method: string; args: any[] }> = [];
  const rec = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    return Promise.resolve({ message_id: 999 });
  };
  const api: any = {};
  for (const m of [
    "copyMessage", "deleteMessage", "sendMessage", "editMessageReplyMarkup",
    "editMessageText", "sendAudio", "sendRichAudio", "editMessageMedia",
    "editMessageCaption", "deleteMessage",
  ]) api[m] = vi.fn(rec(m));
  api.deleteMessage = vi.fn(() => Promise.resolve(true));

  return {
    calls,
    channelWriteCalls: () =>
      calls.filter((c) => ["sendAudio", "sendRichAudio", "editMessageMedia",
        "editMessageCaption"].includes(c.method)),
    ctx: {
      callbackQuery: { data, from: { id: 42, first_name: "A" }, message: { message_id: 5 } },
      from: { id: 42, first_name: "A" },
      chat: { id: 42, type: "private" },
      api,
      reply: vi.fn(async () => ({ message_id: 999 })),
      editMessageReplyMarkup: vi.fn(async () => ({})),
      answerCallbackQuery: vi.fn(async () => ({})),
    } as any,
  };
}

describe("Edit path does not touch the channel or advance the run", () => {
  const seed = () => fakeScanDb([
    scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/Saberoze-01-01" }),
    scanRow({ id: 2, message_id: 102, existing_url: "https://telegra.ph/Two-01-01" }),
  ]);

  it("mig_edit arms the return control, keeps the cursor, and writes nothing to the channel", async () => {
    const db = seed();
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pending";
    m.channelId = "-1001";
    m.cursorId = 1;

    const { ctx, channelWriteCalls } = makeCtx("mig_edit");
    const env: any = { DB: db, BOT_OWNER_ID: "42", BRIDGE_DO: { get: () => ({ fetch: async () => ({ json: async () => ({ ok: true }) }) }), idFromName: () => "x" } };

    await handleMigrationCallback(ctx, session, env);

    expect(m.phase).toBe("editing");
    expect(m.returnArmed).toBe(true);
    // FR-024c — the run does NOT advance
    expect(m.cursorId).toBe(1);
    expect(db.rows[0].status).toBe("pending");
    // FR-023 / T044 — not one channel write
    expect(channelWriteCalls()).toEqual([]);
  });

  it("mig_return returns to the SAME candidate and disarms the control", async () => {
    const db = seed();
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "editing";
    m.channelId = "-1001";
    m.cursorId = 1;
    m.returnArmed = true;
    m.cardMessageId = 777;

    const { ctx, channelWriteCalls } = makeCtx("mig_return");
    const env: any = { DB: db, BOT_OWNER_ID: "42", BRIDGE_DO: { get: () => ({ fetch: async () => ({ json: async () => ({ ok: true }) }) }), idFromName: () => "x" } };

    await handleMigrationCallback(ctx, session, env);

    expect(m.returnArmed).toBe(false);
    expect(m.phase).toBe("pending");
    expect(m.cursorId).toBe(1);          // still the same candidate
    expect(db.rows[0].status).toBe("pending"); // nothing was resolved
    expect(channelWriteCalls()).toEqual([]);
    // the confirmation for that same candidate was re-rendered
    expect(ctx.api.copyMessage).toHaveBeenCalled();
    expect(m.cardMessageId).toBe(999);
  });

  it("a card rendered without the return control keeps its normal shape", () => {
    const plain = buildEditMenu(true, {});
    expect(plain.some((row) => row.some((b) => b.callback_data === "mig_return"))).toBe(false);
    const armed = buildEditMenu(true, {
      extraRows: [[{ text: "↩️ Back to this post", callback_data: "mig_return" }]],
    });
    expect(armed[armed.length - 1][0].callback_data).toBe("mig_return");
  });
});

// ---------------------------------------------------------------------------
// US3 — building a page from the file's own metadata (FR-014, FR-014a–c, T045–T047)
// ---------------------------------------------------------------------------

import {
  buildPageForAudio,
  deriveTitleArtist,
} from "../src/handlers/migrate";
import { upsertTrack, setTrackFileId } from "../src/db/tracks";
import { createAudioRequest } from "../src/db/audioRequests";
import { createSongTelegraph } from "../src/services/telegraph";
import { getLyrics } from "../src/services/lrclib";

describe("title/artist derivation from the file (FR-014b, T050)", () => {
  it("uses the audio tags when they are present", () => {
    expect(deriveTitleArtist({ title: "Saberoze", artist: "Shervin", fileName: "x.mp3" }))
      .toEqual({ title: "Saberoze", artist: "Shervin" });
  });

  it("falls back to the filename, minus its extension", () => {
    expect(deriveTitleArtist({ fileName: "Some Song.mp3" }))
      .toEqual({ title: "Some Song", artist: "" });
  });

  it("splits an 'Artist - Title' filename so the artist is not lost", () => {
    expect(deriveTitleArtist({ fileName: "Shervin - Saberoze.mp3" }))
      .toEqual({ title: "Saberoze", artist: "Shervin" });
    expect(deriveTitleArtist({ fileName: "Shervin – Saberoze.mp3" }))
      .toEqual({ title: "Saberoze", artist: "Shervin" });
    expect(deriveTitleArtist({ fileName: "Shervin_-_Saberoze.mp3" }))
      .toEqual({ title: "Saberoze", artist: "Shervin" });
  });

  it("never splits when the artist tag already says who it is", () => {
    expect(deriveTitleArtist({ title: "A - B", artist: "Real Artist" }))
      .toEqual({ title: "A - B", artist: "Real Artist" });
  });
});

describe("page creation from file metadata (FR-014, FR-014a)", () => {
  const env: any = { DB: fakeScanDb() };

  beforeEach(() => {
    vi.clearAllMocks();
    (getLyrics as any).mockResolvedValue("line one\nline two");
    (createSongTelegraph as any).mockResolvedValue({
      url: "https://telegra.ph/Built-01-01", path: "Built-01-01", lastData: {},
    });
  });

  it("builds a page without touching the audio file", async () => {
    const out = await buildPageForAudio(env, {
      title: "Built", artist: "Someone", fileName: "built.mp3",
    });

    expect(out?.url).toBe("https://telegra.ph/Built-01-01");
    // FR-014a / T045: no file_id write, no bridge job, no delivery anywhere
    expect(setTrackFileId).not.toHaveBeenCalled();
    expect(createAudioRequest).not.toHaveBeenCalled();
    expect((createSongTelegraph as any).mock.calls[0][1]).not.toHaveProperty("fileId");
  });

  it("caches lyrics ONLY when they were found (constitution V, T046)", async () => {
    await buildPageForAudio(env, { title: "Built", artist: "Someone" });
    expect(upsertTrack).toHaveBeenCalledTimes(1);
    expect((upsertTrack as any).mock.calls[0][1]).toMatchObject({
      trackId: 123, title: "Built", artist: "Someone", lyrics: expect.any(String),
    });

    vi.clearAllMocks();
    (getLyrics as any).mockResolvedValue(null);   // a miss
    (createSongTelegraph as any).mockResolvedValue({
      url: "https://telegra.ph/Empty", path: "Empty", lastData: {},
    });

    await buildPageForAudio(env, { title: "Built", artist: "Someone" });
    // Never remember a miss as "no lyrics" — and the page is still built.
    expect(upsertTrack).not.toHaveBeenCalled();
    expect(createSongTelegraph).toHaveBeenCalled();
  });

  it("reports failure instead of inventing a link when nothing matches (T054)", async () => {
    const { searchTracks } = await import("../src/services/deezer");
    (searchTracks as any).mockResolvedValueOnce([]);
    const out = await buildPageForAudio(env, { title: "Nothing", artist: "Nobody" });
    expect(out).toBeNull();
    expect(createSongTelegraph).not.toHaveBeenCalled();
  });

  it("gives the page the run's identity, not a person's (T052)", async () => {
    await buildPageForAudio(env, { title: "Built", artist: "Someone" });
    const opts = (createSongTelegraph as any).mock.calls[0][1];
    expect(opts.authorName).toBe("Lyriphon");
    expect(opts.authorUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T047 — a candidate that already links to a page must never get a second one.
// ---------------------------------------------------------------------------

describe("duplicate-page guard (FR-014c, T047)", () => {
  const envFor = (db: any): any => ({
    DB: db,
    BOT_OWNER_ID: "42",
    BRIDGE_DO: {
      idFromName: () => "bridge",
      get: () => ({ fetch: async () => ({ json: async () => ({ ok: true }) }) }),
    },
  });

  it("reuses the link the post already carries and builds nothing", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/Existing-01-01" }),
    ]);
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pick_channel";          // what mig_resume expects
    m.channelId = "-1001";
    m.nextOffsetId = 0;
    m.scanExhausted = true;

    const { ctx } = makeCtx("mig_resume");
    vi.clearAllMocks();

    await handleMigrationCallback(ctx, session, envFor(db));

    expect(createSongTelegraph).not.toHaveBeenCalled();
    expect(ctx.api.copyMessage).toHaveBeenCalledTimes(1);
    // previewed the original post, in place, with the existing link
    const markup = (ctx.api.copyMessage as any).mock.calls[0][3].reply_markup;
    expect(markup.inline_keyboard[0][0].url).toBe("https://telegra.ph/Existing-01-01");
    expect(m.cursorId).toBe(1);
  });

  it("builds one when the post has no link, then reuses it thereafter", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: null }),
    ]);
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pick_channel";
    m.channelId = "-1001";
    m.nextOffsetId = 0;
    m.scanExhausted = true;

    const { ctx } = makeCtx("mig_resume");
    vi.clearAllMocks();

    await handleMigrationCallback(ctx, session, envFor(db));

    expect(createSongTelegraph).toHaveBeenCalledTimes(1);
    // FR-014c: the built URL is stored on the row before anything else happens
    expect(db.rows[0].existing_url).toBe("https://telegra.ph/Built-01-01");
    // AUDIO FIRST: even a freshly built page is confirmed against the file, not
    // against the card. The card only appears once Edit or Research opens it.
    expect(ctx.api.copyMessage).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
    const markup = (ctx.api.copyMessage as any).mock.calls[0][3].reply_markup;
    expect(markup.inline_keyboard[0][0].url).toBe("https://telegra.ph/Built-01-01");
  });
});

// ---------------------------------------------------------------------------
// T056 — a stale tap must not be applied to whatever the cursor moved to.
// ---------------------------------------------------------------------------

describe("stale and duplicate taps", () => {
  const envFor = (db: any): any => ({
    DB: db,
    BOT_OWNER_ID: "42",
    BRIDGE_DO: {
      idFromName: () => "bridge",
      get: () => ({ fetch: async () => ({ json: async () => ({ ok: true }) }) }),
    },
  });

  it("refuses a Yes carrying a candidate id that is no longer on screen", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/A" }),
      scanRow({ id: 2, message_id: 102, existing_url: "https://telegra.ph/B" }),
    ]);
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pending";
    m.channelId = "-1001";
    m.cursorId = 2;              // run already moved on to candidate 2

    const { ctx } = makeCtx("mig_yes_1"); // stale button from candidate 1
    await handleMigrationCallback(ctx, session, envFor(db));

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      { text: "❌ This choice has expired.", show_alert: true },
    );
    // neither row was touched
    expect(db.rows[0].status).toBe("pending");
    expect(db.rows[1].status).toBe("pending");
    // and nothing reached the channel
    expect(ctx.api.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(ctx.api.copyMessage).not.toHaveBeenCalled();
  });

  it("accepts the button for the candidate that IS on screen", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/A" }),
      scanRow({ id: 2, message_id: 102, existing_url: "https://telegra.ph/B" }),
    ]);
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pending";
    m.channelId = "-1001";
    m.cursorId = 2;

    const { ctx } = makeCtx("mig_yes_2");
    await handleMigrationCallback(ctx, session, envFor(db));

    expect(db.rows[1].status).toBe("handled");
    expect(db.rows[1].outcome).toBe("added");
    expect(db.rows[0].status).toBe("pending");   // candidate 1 untouched
    expect(m.added).toBe(1);
  });

  it("carries the candidate id in the keyboard it renders", () => {
    const kb = confirmationKeyboard(42);
    expect(kb.flat().map((b) => b.callback_data)).toEqual([
      "mig_yes_42", "mig_no_42", "mig_edit_42", "mig_research_42",
    ]);
    // exactly four choices — Yes / No / Edit / Research (FR-017)
    expect(kb.flat()).toHaveLength(4);
  });

  it("an unregistered channel pick is refused without touching state", async () => {
    const db = fakeScanDb();
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pick_channel";

    const { ctx } = makeCtx("mig_pick_-100999");
    await handleMigrationCallback(ctx, session, envFor(db));

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      { text: "❌ That channel isn't one of yours.", show_alert: true },
    );
    expect(db.rows).toHaveLength(0);
    expect(m.channelId).toBeUndefined();
    expect(m.phase).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// T057 — /start resets the session with no cleanup hook; a confirmation left
// on screen must be inert rather than able to change something.
// ---------------------------------------------------------------------------

describe("run destroyed by a session reset", () => {
  it("a tap on a confirmation that outlived /start is refused", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/A" }),
    ]);
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pending";
    m.channelId = "-1001";
    m.cursorId = 1;

    // /start → resetSessionData, which rebuilds every flow including migration
    resetSessionData(session);
    expect(migrationOf(session).phase).toBe("idle");

    const { ctx } = makeCtx("mig_yes_1");
    const env: any = { DB: db, BOT_OWNER_ID: "42" };
    await handleMigrationCallback(ctx, session, env);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      { text: "❌ This choice has expired.", show_alert: true },
    );
    expect(db.rows[0].status).toBe("pending");   // nothing happened to it
    expect(ctx.api.editMessageReplyMarkup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Escape hatch: an open run must always be leavable.
// ---------------------------------------------------------------------------

import { migrateCommandHandler } from "../src/handlers/migrateCommand";

describe("an open run can always be exited", () => {
  const ctxFor = () => ({
    from: { id: 42, first_name: "A" },
    chat: { id: 42, type: "private" },
    api: {},
    reply: vi.fn(async (_text: string, opts?: any) => {
      (ctxFor as any).lastReply = { text: _text, opts };
      return { message_id: 500 };
    }),
  } as any);

  it("/migrate on an open run offers BOTH a way back and a way out", async () => {
    const session = createSessionData();
    migrationOf(session).phase = "pick_channel";

    const ctx = ctxFor();
    const env: any = { DB: fakeScanDb(), BOT_OWNER_ID: "42" };
    await migrateCommandHandler(ctx, session, env);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [, opts] = (ctx.reply as any).mock.calls[0];
    const buttons = opts.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(buttons).toContain("mig_resume");
    expect(buttons).toContain("mig_abandon");
    // and it says which run is open, rather than a bare refusal
    expect((ctx.reply as any).mock.calls[0][0]).toContain("Waiting for the channel scan");
  });

  it("mig_abandon clears the run and leaves the channel alone", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/A" }),
      scanRow({ id: 2, message_id: 102, existing_url: "https://telegra.ph/B", status: "handled", outcome: "added" }),
    ]);
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pending";
    m.channelId = "-1001";
    m.cursorId = 1;
    m.added = 1;

    const { ctx } = makeCtx("mig_abandon");
    const env: any = { DB: db, BOT_OWNER_ID: "42" };
    await handleMigrationCallback(ctx, session, env);

    expect(m.phase).toBe("idle");
    expect(m.channelId).toBeUndefined();
    expect(m.cursorId).toBeUndefined();
    // undecided work is left for a later run; decided work is untouched
    expect(db.rows[0].status).toBe("pending");
    expect(db.rows[1]).toMatchObject({ status: "handled", outcome: "added" });
    // nothing was written to the channel
    expect(ctx.api.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(ctx.api.copyMessage).not.toHaveBeenCalled();
  });

  it("after abandoning, /migrate starts a fresh run", async () => {
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pending";
    m.channelId = "-1001";

    const ctx = ctxFor();
    const env: any = {
      DB: fakeScanDb(),
      BOT_OWNER_ID: "42",
      BRIDGE_DO: {
        idFromName: () => "bridge",
        get: () => ({ fetch: async () => ({ json: async () => ({ ok: true }) }) }),
      },
    };

    // first call: still open → refused with exits
    await migrateCommandHandler(ctx, session, env);
    expect((ctx.reply as any).mock.calls[0][0]).toContain("Resume it");

    // abandon, then /migrate again must reach the picker
    m.phase = "idle";
    ctx.reply = vi.fn(async () => ({ message_id: 501 }));
    (ctx as any).reply.mockResolvedValue({ message_id: 501 });

    await migrateCommandHandler(ctx, session, env);
    const second = (ctx as any).reply.mock.calls.at(-1);
    expect(second[0]).toContain("Which channel should I walk?");
    expect(m.phase).toBe("pick_channel");
  });
});

// ---------------------------------------------------------------------------
// FR-027a — a Yes also normalises the caption, as a SEPARATE call.
// ---------------------------------------------------------------------------

describe("caption normalisation on Yes", () => {
  const envFor = (db: any): any => ({
    DB: db,
    BOT_OWNER_ID: "42",
    BRIDGE_DO: {
      idFromName: () => "bridge",
      get: () => ({ fetch: async () => ({ json: async () => ({ ok: true }) }) }),
    },
  });

  function seededSession(db: any) {
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pending";
    m.channelId = "-1001";
    m.cursorId = 1;
    return { session, m };
  }

  it("sets the caption to the bot's normal `track — artist` form", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/x" }),
    ]);
    const { session } = seededSession(db);
    const { ctx } = makeCtx("mig_yes_1");

    await handleMigrationCallback(ctx, session, envFor(db));

    expect(ctx.api.editMessageCaption).toHaveBeenCalledTimes(1);
    const [cid, mid, opts] = (ctx.api.editMessageCaption as any).mock.calls[0];
    expect(cid).toBe(-1001);
    expect(mid).toBe(101);
    expect(opts.parse_mode).toBe("MarkdownV2");
    expect(opts.caption).toContain("Saberoze");
    expect(opts.caption).toContain("Shervin");
    expect(opts.caption).toContain("https://telegra.ph/x");
    // blockquoted, backticked — the same shape buildAudioCaption produces
    expect(opts.caption.startsWith(">`")).toBe(true);
  });

  it("both the button AND the caption are edited — never one merged call", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/x" }),
    ]);
    const { session } = seededSession(db);
    const { ctx } = makeCtx("mig_yes_1");

    await handleMigrationCallback(ctx, session, envFor(db));

    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledTimes(1);
    expect(ctx.api.editMessageCaption).toHaveBeenCalledTimes(1);
    // media methods stay untouched either way
    for (const m of ["sendAudio", "sendRichAudio", "editMessageMedia", "deleteMessage", "copyMessage"]) {
      expect((ctx.api as any)[m]).not.toHaveBeenCalled();
    }
  });

  it("a caption that is already correct is not treated as a failure", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/x" }),
    ]);
    const { session, m } = seededSession(db);
    const { ctx } = makeCtx("mig_yes_1");
    ctx.api.editMessageCaption = vi.fn(() =>
      Promise.reject(new Error("Bad Request: message is not modified")));

    await handleMigrationCallback(ctx, session, envFor(db));

    // The button landed and the caption was already right, so this is a
    // success — recorded durably. (Session counters reset when the run ends;
    // scan_queue is the authoritative record.)
    expect(db.rows[0].status).toBe("handled");
    expect(db.rows[0].outcome).toBe("added");
    expect(m.failed).toBe(0);
  });

  it("a caption failure does not undo the button", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/x" }),
    ]);
    const { session, m } = seededSession(db);
    const { ctx } = makeCtx("mig_yes_1");
    ctx.api.editMessageCaption = vi.fn(() =>
      Promise.reject(new Error("Bad Request: caption entities are invalid")));

    await handleMigrationCallback(ctx, session, envFor(db));

    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalled();
    expect(db.rows[0].status).toBe("handled");
    expect(db.rows[0].outcome).toBe("added");
    expect(m.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Research — the confirmation's fourth choice.
// ---------------------------------------------------------------------------

import { searchTracks } from "../src/services/deezer";
import { handleResearchQuery } from "../src/handlers/callbacks/migrate";

describe("research", () => {
  // Deezer/Telegraph mocks are module-level and shared with the suites above;
  // without a reset, a call from an earlier test counts against this one.
  beforeEach(() => {
    vi.clearAllMocks();
    (getLyrics as any).mockResolvedValue("line one line two");
    (createSongTelegraph as any).mockResolvedValue({
      url: "https://telegra.ph/Built-01-01", path: "Built-01-01", lastData: {},
    });
    (searchTracks as any).mockResolvedValue([
      { id: 123, title: "Built", artist: { name: "Someone" }, album: { id: 7 }, duration: 200 },
    ]);
  });

  const envFor = (db: any): any => ({
    DB: db,
    BOT_OWNER_ID: "42",
    BRIDGE_DO: {
      idFromName: () => "bridge",
      get: () => ({ fetch: async () => ({ json: async () => ({ ok: true }) }) }),
    },
  });

  function pendingRun(db: any) {
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pending";
    m.channelId = "-1001";
    m.cursorId = 1;
    m.cardMessageId = 777;
    return { session, m };
  }

  it("offers Research as a fourth choice alongside Yes / No / Edit", () => {
    const flat = confirmationKeyboard(9).flat().map((b) => b.callback_data);
    expect(flat).toEqual(["mig_yes_9", "mig_no_9", "mig_edit_9", "mig_research_9"]);
  });

  it("mig_research asks for a query and does not advance the run", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/A" }),
    ]);
    const { session, m } = pendingRun(db);
    const { ctx } = makeCtx("mig_research_1");

    await handleMigrationCallback(ctx, session, envFor(db));

    expect(m.phase).toBe("researching");
    expect(m.cursorId).toBe(1);            // still THIS candidate
    expect(m.cardMessageId).toBeUndefined(); // confirmation cleared while asking
    expect(db.rows[0].status).toBe("pending");
    // nothing reached the channel
    expect(ctx.api.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(ctx.api.copyMessage).not.toHaveBeenCalled();
  });

  it("a query returns Deezer matches as mig_track_ buttons", async () => {
    const db = fakeScanDb([scanRow({ id: 1, message_id: 101 })]);
    const { session, m } = pendingRun(db);
    m.phase = "researching";
    m.researchPromptId = 555;

    const ctx: any = {
      message: { text: "Panchiko Laputa" },
      from: { id: 42, first_name: "A" },
      chat: { id: 42, type: "private" },
      api: { deleteMessage: vi.fn(() => Promise.resolve(true)) },
      reply: vi.fn(async () => ({ message_id: 600 })),
    };

    await handleResearchQuery(ctx, session);

    expect(searchTracks).toHaveBeenCalledWith("Panchiko Laputa");
    const [, opts] = (ctx.reply as any).mock.calls.at(-1);
    const data = opts.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(data).toContain("mig_track_123");   // the mocked Deezer result
    expect(data).toContain("mig_research_cancel");
    expect(m.phase).toBe("researching");       // still choosing
    expect(m.cursorId).toBe(1);
    // the query prompt is gone
    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(42, 555);
  });

  it("picking a track rebuilds the page and re-offers the SAME candidate", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/OLD" }),
    ]);
    const { session, m } = pendingRun(db);
    m.phase = "researching";
    m.researchPromptId = 555;

    const { ctx } = makeCtx("mig_track_123");
    await handleMigrationCallback(ctx, session, envFor(db));

    expect(searchTracks).not.toHaveBeenCalled();       // no second search — track id given
    expect(createSongTelegraph).toHaveBeenCalledTimes(1);
    // this candidate's link is replaced, and only its link
    expect(db.rows[0].existing_url).toBe("https://telegra.ph/Built-01-01");
    expect(db.rows[0].status).toBe("pending");         // not answered yet
    expect(db.rows[0].message_id).toBe(101);
    // Research's result IS the page, so it shows the card — with the control
    // that returns to the audio confirmation where Yes/No are answered.
    expect(m.phase).toBe("editing");
    expect(ctx.reply).toHaveBeenCalled();
    expect(ctx.api.copyMessage).not.toHaveBeenCalled();  // card, not audio copy
    const [, opts] = (ctx.reply as any).mock.calls.at(-1);
    const data = opts.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(data).toContain("mig_yes_1");
    expect(data).toContain("mig_return");        // back to the audio file
    expect(data).toContain("edit_field_track");  // the full field menu
    // still nothing in the channel
    expect(ctx.api.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(ctx.api.editMessageCaption).not.toHaveBeenCalled();
  });

  it("cancel puts the same candidate back without rebuilding anything", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/A" }),
    ]);
    const { session, m } = pendingRun(db);
    m.phase = "researching";

    const { ctx } = makeCtx("mig_research_cancel");

    await handleMigrationCallback(ctx, session, envFor(db));

    expect(m.phase).toBe("pending");
    expect(m.cursorId).toBe(1);
    expect(createSongTelegraph).not.toHaveBeenCalled();   // nothing rebuilt
    expect(db.rows[0].existing_url).toBe("https://telegra.ph/A");
    expect(ctx.api.copyMessage).toHaveBeenCalled();       // back to the audio copy
    expect(ctx.api.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  it("an expired track pick is refused rather than applied to another candidate", async () => {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/A" }),
      scanRow({ id: 2, message_id: 102, existing_url: "https://telegra.ph/B" }),
    ]);
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pending";          // NOT researching — the pick is stale
    m.channelId = "-1001";
    m.cursorId = 2;

    const { ctx } = makeCtx("mig_track_123");
    await handleMigrationCallback(ctx, session, envFor(db));

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      { text: "❌ This choice has expired.", show_alert: true },
    );
    expect(createSongTelegraph).not.toHaveBeenCalled();
    expect(db.rows.every((r) => r.status === "pending")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Call ORDER on a Yes. Both edits succeed individually, so a wrong order is
// silent: editMessageCaption with no reply_markup makes Telegram drop the
// keyboard, which is what turned "attached the button" into "only the caption
// changed" on a live run.
// ---------------------------------------------------------------------------

describe("Yes touches the message in the right order", () => {
  const envFor = (db: any): any => ({
    DB: db,
    BOT_OWNER_ID: "42",
    BRIDGE_DO: {
      idFromName: () => "bridge",
      get: () => ({ fetch: async () => ({ json: async () => ({ ok: true }) }) }),
    },
  });

  function seeded() {
    const db = fakeScanDb([
      scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/x" }),
    ]);
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pending";
    m.channelId = "-1001";
    m.cursorId = 1;
    return { db, session, m };
  }

  it("edits the caption BEFORE the keyboard — never after", async () => {
    const { db, session } = seeded();
    const { ctx } = makeCtx("mig_yes_1");

    await handleMigrationCallback(ctx, session, envFor(db));

    const captionOrder = (ctx.api.editMessageCaption as any).mock.invocationCallOrder[0];
    const markupOrder = (ctx.api.editMessageReplyMarkup as any).mock.invocationCallOrder[0];
    expect(captionOrder).toBeDefined();
    expect(markupOrder).toBeDefined();
    // the markup edit must be LAST, so nothing can strip it afterwards
    expect(captionOrder).toBeLessThan(markupOrder);
  });

  it("the caption edit carries no keyboard of its own to get wrong", async () => {
    const { db, session } = seeded();
    const { ctx } = makeCtx("mig_yes_1");

    await handleMigrationCallback(ctx, session, envFor(db));

    const opts = (ctx.api.editMessageCaption as any).mock.calls[0][2];
    expect(opts).not.toHaveProperty("reply_markup");
    expect(opts.parse_mode).toBe("MarkdownV2");
  });

  it("attaches even when the caption edit fails outright", async () => {
    const { db, session, m } = seeded();
    const { ctx } = makeCtx("mig_yes_1");
    ctx.api.editMessageCaption = vi.fn(() => Promise.reject(new Error("HTTP 400")));

    await handleMigrationCallback(ctx, session, envFor(db));

    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledTimes(1);
    expect(db.rows[0].outcome).toBe("added");
    expect(m.failed).toBe(0);
  });

  it("does not touch the channel at all on No", async () => {
    const { db, session } = seeded();
    const { ctx } = makeCtx("mig_no_1");

    await handleMigrationCallback(ctx, session, envFor(db));

    expect(ctx.api.editMessageCaption).not.toHaveBeenCalled();
    expect(ctx.api.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(db.rows[0].outcome).toBe("declined");
  });
});

// ---------------------------------------------------------------------------
// The research state is what claims the message — not the other way round.
// Outside it, a plain message must never be treated as a query (it would
// otherwise be swallowed, or fall through into a normal /song search).
// ---------------------------------------------------------------------------

describe("research claims text only while it owns the message", () => {
  function ctxWithText(text: string) {
    return {
      message: { text },
      from: { id: 42, first_name: "A" },
      chat: { id: 42, type: "private" },
      api: { deleteMessage: vi.fn(() => Promise.resolve(true)) },
      reply: vi.fn(async () => ({ message_id: 900 })),
    } as any;
  }

  it("refuses a query when the run is not researching", async () => {
    const db = fakeScanDb([scanRow({ id: 1, message_id: 101, existing_url: "https://telegra.ph/x" })]);
    const session = createSessionData();
    const m = migrationOf(session);
    m.phase = "pending";              // confirmation is up, NOT a query prompt
    m.channelId = "-1001";
    m.cursorId = 1;

    vi.clearAllMocks();
    const ctx = ctxWithText("Panchiko Laputa");
    await handleResearchQuery(ctx, session);

    expect(searchTracks).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("No search in progress"),
    );
    // and the run is where it was
    expect(m.phase).toBe("pending");
    expect(db.rows[0].status).toBe("pending");
  });

  it("refuses after the run has ended", async () => {
    const session = createSessionData();   // phase idle, no cursor
    vi.clearAllMocks();
    const ctx = ctxWithText("anything");

    await handleResearchQuery(ctx, session);

    expect(searchTracks).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("No search in progress"),
    );
  });
});
