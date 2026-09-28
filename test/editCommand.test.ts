import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPageOwnership, parseTelegraphLink } from "../src/handlers/editCommand";
import { isBotOwner } from "../src/handlers/admin";
import { buildEditMenu } from "../src/handlers/callbacks/index";
import { createSessionData } from "../src/session/flows";
import { SessionMode } from "../src/session/types";
import { CHANNEL_LINK } from "../src/config";

const OWNER = { authorUrl: "https://t.me/ashkan420", authorName: "Ashkan" };

describe("parseTelegraphLink", () => {
  it("accepts a telegra.ph page link", () => {
    expect(parseTelegraphLink("https://telegra.ph/Shape-of-You-03-09")).toBe("Shape-of-You-03-09");
  });

  it("accepts www.telegra.ph and a trailing slash", () => {
    expect(parseTelegraphLink("https://www.telegra.ph/Page-Name/")).toBe("Page-Name");
  });

  it("decodes a percent-encoded path segment", () => {
    expect(parseTelegraphLink("https://telegra.ph/Shape%20of%20You")).toBe("Shape of You");
  });

  it("rejects an empty or missing argument", () => {
    expect(parseTelegraphLink("")).toBeNull();
    expect(parseTelegraphLink("   ")).toBeNull();
  });

  it("rejects a non-URL", () => {
    expect(parseTelegraphLink("hello")).toBeNull();
  });

  it("rejects a non-Telegraph host", () => {
    expect(parseTelegraphLink("https://example.com/foo")).toBeNull();
    // A lookalike host must not pass.
    expect(parseTelegraphLink("https://telegra.ph.evil.com/foo")).toBeNull();
  });

  it("rejects a non-http protocol", () => {
    expect(parseTelegraphLink("ftp://telegra.ph/foo")).toBeNull();
  });

  it("rejects a link with no path segment", () => {
    expect(parseTelegraphLink("https://telegra.ph/")).toBeNull();
  });

  // Truncating would edit a page the user did not name.
  it("rejects extra path segments rather than truncating", () => {
    expect(parseTelegraphLink("https://telegra.ph/Page/extra")).toBeNull();
  });
});

describe("checkPageOwnership", () => {
  // FR-005: the author link is the primary check — an identity, not a name.
  it("allows when the author link matches the user's username link", () => {
    expect(checkPageOwnership(OWNER, { name: "Someone Else", url: "https://t.me/ashkan420" }, false)).toBe(true);
  });

  it("ignores case and a trailing slash when comparing username links", () => {
    expect(
      checkPageOwnership({ ...OWNER, authorUrl: "https://t.me/Ashkan420/" }, { name: "x", url: "https://t.me/ashkan420" }, false),
    ).toBe(true);
  });

  it("ignores the host casing on both sides", () => {
    expect(
      checkPageOwnership({ ...OWNER, authorUrl: "https://T.me/ashkan420" }, { name: "x", url: "https://t.me/ashkan420" }, false),
    ).toBe(true);
  });

  it("refuses when the author link belongs to someone else", () => {
    expect(checkPageOwnership({ ...OWNER, authorUrl: "https://t.me/someone" }, { name: "Ashkan", url: undefined }, false)).toBe(false);
  });

  it("refuses a user with no username when the page carries a distinct author link", () => {
    expect(checkPageOwnership(OWNER, { name: "Ashkan", url: undefined }, false)).toBe(false);
  });

  // FR-006: a page with the channel link carries no username identity, so the
  // weaker first-name comparison is the only signal available.
  describe("name fallback (page carries the channel link)", () => {
    const fallbackPage = { authorUrl: CHANNEL_LINK, authorName: "Ashkan" };

    it("allows a matching first name", () => {
      expect(checkPageOwnership(fallbackPage, { name: "Ashkan", url: undefined }, false)).toBe(true);
    });

    it("ignores case, whitespace, and a leading @", () => {
      expect(checkPageOwnership(fallbackPage, { name: "  ashkan ", url: undefined }, false)).toBe(true);
      expect(checkPageOwnership(fallbackPage, { name: "@Ashkan", url: undefined }, false)).toBe(true);
    });

    it("refuses a different first name", () => {
      expect(checkPageOwnership(fallbackPage, { name: "Sara", url: undefined }, false)).toBe(false);
    });

    it("treats a page with no author link at all as a fallback page", () => {
      expect(checkPageOwnership({ authorUrl: "", authorName: "Ashkan" }, { name: "Ashkan" }, false)).toBe(true);
    });

    it("refuses when the page author name is empty", () => {
      expect(checkPageOwnership({ authorUrl: CHANNEL_LINK, authorName: "" }, { name: "Ashkan" }, false)).toBe(false);
    });

    it("refuses when the user has no first name", () => {
      expect(checkPageOwnership(fallbackPage, { name: "" }, false)).toBe(false);
    });
  });

  // A malformed author link must NOT fall through to the weak name check.
  it("refuses a page whose author link is neither the channel nor a t.me link", () => {
    expect(
      checkPageOwnership({ ...OWNER, authorUrl: "https://evil.example/ashkan" }, { name: "Ashkan" }, false),
    ).toBe(false);
  });

  // FR-007: the owner override bypasses both checks.
  it("allows the owner regardless of either check", () => {
    expect(checkPageOwnership({ ...OWNER, authorUrl: "https://t.me/someone", authorName: "Someone" }, { name: "x" }, true)).toBe(
      true,
    );
  });
});

// T026: isBotOwner fails closed when BOT_OWNER_ID is unset, so with no owner
// configured there is no bypass at all — every caller goes through the checks.
describe("owner override fails closed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false for everyone when BOT_OWNER_ID is unset", async () => {
    const { isBotOwner } = await import("../src/handlers/admin");
    const ctx = { from: { id: 1 } } as any;
    expect(isBotOwner(ctx, {} as any)).toBe(false);
    // And with the var set to a different user, still not the owner.
    expect(isBotOwner(ctx, { BOT_OWNER_ID: "999" } as any)).toBe(false);
  });
});

// FR-008 / T027: a refusal must not open an edit session. The command never
// transitions on any failure path, so the session stays in whatever mode it
// was in and the exit-mode cleanup has nothing to delete.
describe("failure paths leave the session untouched", () => {
  it("starts a fresh session in IDLE with no edit state", () => {
    const session = createSessionData();
    expect(session.mode).toBe(SessionMode.IDLE);
    expect(session.edit.field).toBeUndefined();
    expect(session.edit.promptId).toBeUndefined();
    expect(session.telegraph.data).toBeUndefined();
  });
});

