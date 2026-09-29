import { describe, expect, it } from "vitest";
import { parseBridgeMessage } from "../src/handlers/bridge";

// T018 — the return leg for a /migrate history page (contracts §3).
//
// The bridge is one-way: no DO route may await an MTProto round-trip, so scan
// results travel back as a DM control message plus rows in D1. What matters
// here is that the DM carries COUNTS AND A CHANNEL, never the messages.

describe("lyq:scan parsing", () => {
  it("parses a completed page", () => {
    expect(parseBridgeMessage("lyq:scan user=42 channel=-100123 status=done count=5 offset=900")).toEqual({
      kind: "scan",
      user: "42",
      channel: "-100123",
      status: "done",
      count: 5,
      offset: 900,
      reason: undefined,
    });
  });

  it("parses a partial page (more history remains)", () => {
    expect(parseBridgeMessage("lyq:scan user=42 channel=-100123 status=partial count=50 offset=800")).toMatchObject({
      kind: "scan",
      channel: "-100123",
      status: "partial",
      count: 50,
    });
  });

  it("parses a failure and keeps the reason", () => {
    expect(parseBridgeMessage("lyq:scan user=42 channel=-100123 status=failed count=0 offset=700 reason=FLOOD_WAIT_17"))
      .toMatchObject({
        kind: "scan",
        status: "failed",
        count: 0,
        offset: 700,
        reason: "FLOOD_WAIT_17",
      });
  });

  it("keeps a whole reason intact, spaces and all", () => {
    // The real reason is a Telegram/teleproto error: spaces, a URL and a long
    // indented docs line. An earlier build parsed it as `(\S+)`, which cut it
    // to its first word — so the admin saw "Couldn't finish: Could".
    const reason =
      "Could not find the input entity for {\"channelId\":\"3774439080\"}. " +
      "Please read https://docs.teleproto.dev/concepts/entities";
    const parsed = parseBridgeMessage(
      `lyq:scan user=42 channel=-1001 status=failed count=0 offset=0 reason=${reason}`,
    );
    expect(parsed).toMatchObject({ kind: "scan", status: "failed", count: 0, offset: 0 });
    expect((parsed as any).reason).toBe(reason);
  });

  it("accepts a reason that carries the human-readable precondition message", () => {
    const parsed = parseBridgeMessage(
      "lyq:scan user=42 channel=-1001 status=failed count=0 offset=0 " +
      "reason=the signed-in Telegram account can't read this channel — it needs to be added to it as a member",
    );
    expect((parsed as any).reason).toBe(
      "the signed-in Telegram account can't read this channel — it needs to be added to it as a member",
    );
  });

  it("never carries message payloads — counts and a channel id only", () => {
    const parsed = parseBridgeMessage("lyq:scan user=42 channel=-1001 status=done count=12 offset=55")!;
    expect(Object.keys(parsed).sort()).toEqual(["channel", "count", "kind", "offset", "reason", "status", "user"]);
    // no row data, no captions, no file ids
    expect(JSON.stringify(parsed)).not.toMatch(/telegra\.ph|caption|file_id|message_id/);
  });

  it("is not confused by the existing control messages", () => {
    expect(parseBridgeMessage("lyq:file req=tok")?.kind).toBe("file");
    expect(parseBridgeMessage("lyq:fail req=tok")?.kind).toBe("fail");
    expect(parseBridgeMessage("lyq:albumdone req=tok count=3")?.kind).toBe("albumdone");
  });

  it("rejects a malformed scan line", () => {
    expect(parseBridgeMessage("lyq:scan user=42 channel=-1001 status=maybe count=x offset=1")).toBeNull();
    expect(parseBridgeMessage("lyq:scan")).toBeNull();
    expect(parseBridgeMessage("scan user=42 channel=-1001 status=done count=1 offset=1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error classification: what is retryable, what is a precondition the admin
// has to fix, and what is just broken.
// ---------------------------------------------------------------------------

import { floodWaitSeconds, unreadableReason } from "../src/bridge/scanErrors";

describe("scan error classification", () => {
  it("reads the wait off a FLOOD_WAIT error", () => {
    class FloodWaitError extends Error {
      constructor(public seconds: number) { super("FLOOD_WAIT_17"); }
    }
    expect(floodWaitSeconds(new FloodWaitError(17))).toBe(17);
    expect(floodWaitSeconds(new Error("FLOOD_WAIT_42 wait"))).toBe(1);
    expect(floodWaitSeconds(new Error("RATE_LIMITED"))).toBeNull();
    expect(floodWaitSeconds(null)).toBeNull();
  });

  it("recognises 'the account cannot see this channel'", () => {
    // The exact shape teleproto raised on a cold, non-member run.
    expect(unreadableReason(new Error(
      'Could not find the input entity for {"channelId":"3774439080","className":"PeerChannel"}. ' +
      "Please read https://docs.teleproto.dev/concepts/entities",
    ))).not.toBeNull();

    for (const code of [
      "CHANNEL_PRIVATE", "USER_NOT_PARTICIPANT", "CHAT_ADMIN_REQUIRED",
      "CHANNEL_INVALID", "PEER_ID_INVALID",
    ]) {
      expect(unreadableReason(new Error(code))).not.toBeNull();
    }
  });

  it("does not blame membership for unrelated failures", () => {
    expect(unreadableReason(new Error("Bad Request: message not modified"))).toBeNull();
    expect(unreadableReason(new Error("network unreachable"))).toBeNull();
    expect(unreadableReason(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Message normalisation — the shape that a live run got wrong.
// ---------------------------------------------------------------------------

import {
  extractHistoryButtons,
  normalizeHistoryMessage,
} from "../src/bridge/historyNormalize";
import { classifyScannedMessage } from "../src/handlers/migrate";

// Built to match teleproto's actual classes, not a flat guess:
//   ReplyInlineMarkup → KeyboardInlineButtonRow → KeyboardInlineButton {text, type}
//   → InlineButtonTypeUrl {url}
// `any` because `extra` adds replyMarkup/groupedId, which the base object
// does not declare — the point is reading a foreign shape, not modelling it.
function teleprotoAudioMessage(extra: Record<string, any> = {}): any {
  return {
    id: 42,
    groupedId: null,
    message: ">`Saberoze — Shervin`[‎](https://telegra.ph/Saberoze-01-01)",
    media: {
      document: {
        mimeType: "audio/mpeg",
        attributes: [
          { className: "DocumentAttributeAudio", title: "Saberoze", performer: "Shervin", duration: 232 },
          { className: "DocumentAttributeFilename", fileName: "saberoze.mp3" },
        ],
      },
    },
    ...extra,
  };
}

describe("channel message normalisation", () => {
  it("reads audio tags off the document attributes", () => {
    const m = normalizeHistoryMessage(teleprotoAudioMessage());
    expect(m).toMatchObject({
      messageId: 42,
      kind: "audio",
      groupId: null,
      fromSelf: true,
      audio: { title: "Saberoze", performer: "Shervin", fileName: "saberoze.mp3" },
    });
    expect(m.caption).toContain("telegra.ph");
  });

  it("reads the URL from button.type.url, NOT button.url", () => {
    // Reading button.url (the flat guess) returns nothing — which is what made
    // every keyed post look buttonless on a live run.
    const msg = teleprotoAudioMessage({
      replyMarkup: {
        rows: [
          { buttons: [{ text: "Lyrics", type: { url: "https://telegra.ph/Saberoze-01-01" } }] },
        ],
      },
    });
    const buttons = extractHistoryButtons(msg);
    expect(buttons).toEqual([
      { text: "Lyrics", url: "https://telegra.ph/Saberoze-01-01" },
    ]);
    // a flat `{ text, url }` guess on the button itself must not be the source
    expect(msg.replyMarkup.rows[0].buttons[0].url).toBeUndefined();
  });

  it("drops callback-only buttons (no url, cannot be a Lyrics link)", () => {
    const msg = teleprotoAudioMessage({
      replyMarkup: {
        rows: [
          { buttons: [{ text: "Share", type: { url: "https://t.me/share" } }] },
          { buttons: [{ text: "Remix", type: { data: Buffer.from("x").toString("base64") } }] },
        ],
      },
    });
    expect(extractHistoryButtons(msg)).toEqual([
      { text: "Share", url: "https://t.me/share" },
    ]);
  });

  it("a keyed post classifies as SKIPPED, so it is never offered (FR-013)", () => {
    const m = normalizeHistoryMessage(teleprotoAudioMessage({
      replyMarkup: {
        rows: [
          { buttons: [{ text: "Lyrics", type: { url: "https://telegra.ph/Saberoze-01-01" } }] },
        ],
      },
    }));
    const verdict = classifyScannedMessage(m);
    expect(verdict.kind).toBe("record");
    expect((verdict as any).status).toBe("skipped");
    expect((verdict as any).hasLyricsButton).toBe(true);
    // and the keyboard is captured so an attach can merge rather than replace
    expect(JSON.parse((verdict as any).existingMarkup)).toEqual([
      [{ text: "Lyrics", url: "https://telegra.ph/Saberoze-01-01" }],
    ]);
  });

  it("an unkeyed post is offered, carrying its existing keyboard for the merge (FR-013a)", () => {
    const m = normalizeHistoryMessage(teleprotoAudioMessage({
      replyMarkup: {
        rows: [{ buttons: [{ text: "Share", type: { url: "https://t.me/share" } }] }],
      },
    }));
    const verdict = classifyScannedMessage(m);
    expect((verdict as any).status).toBe("pending");
    expect((verdict as any).existingMarkup).toContain("Share");
  });

  it("treats an album post as not-a-single-file (FR-012)", () => {
    expect(normalizeHistoryMessage(teleprotoAudioMessage({ groupedId: 77 })).groupId).toBe(77);
    expect(classifyScannedMessage(
      normalizeHistoryMessage(teleprotoAudioMessage({ groupedId: 77 })),
    ).kind).toBe("ignore");
  });

  it("ignores non-audio messages", () => {
    const photo = normalizeHistoryMessage({ id: 5, groupedId: null, media: { photo: {} } });
    expect(photo.kind).toBe("other");
    expect(photo.audio).toBeNull();
    expect(classifyScannedMessage(photo).kind).toBe("ignore");
  });

  it("ignores a post made by someone else (FR-011)", () => {
    const m = normalizeHistoryMessage(
      teleprotoAudioMessage({ fromId: { userId: 999 } }),
      { userId: 42 },
    );
    expect(m.fromSelf).toBe(false);
    expect(classifyScannedMessage(m).kind).toBe("ignore");
  });
});
