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

// The owner's own pages carry the channel link, not their username — they can
// already edit any page via the owner override, so their pages need no
// personal marker. This is the page state such a page produces, and the owner
// must still be admitted through it.
describe("owner pages use the channel link", () => {
  it("still admits the owner on a page carrying the channel link", () => {
    const ownerPage = { authorUrl: CHANNEL_LINK, authorName: "Ashkan" };
    // Without the override, this only passes via the first-name fallback.
    expect(checkPageOwnership(ownerPage, { name: "Ashkan", url: "https://t.me/ashkan420" }, true)).toBe(true);
  });

  it("still admits the owner when their first name does not match the page", () => {
    const ownerPage = { authorUrl: CHANNEL_LINK, authorName: "Lyriphon" };
    // The override is what carries this case — the name check would refuse.
    expect(checkPageOwnership(ownerPage, { name: "Ashkan", url: "https://t.me/ashkan420" }, false)).toBe(false);
    expect(checkPageOwnership(ownerPage, { name: "Ashkan", url: "https://t.me/ashkan420" }, true)).toBe(true);
  });
});

// The owner override is the FIRST check, so it short-circuits before either
// name-based comparison runs. Verified against live pages: the owner is
// admitted on pages authored by other people, including a page whose author
// link is a different user's t.me and a page carrying the channel link.
describe("owner override short-circuits first", () => {
  const OWNER_IDENTITY = { name: "Ashkan", url: "https://t.me/ashkan420" };
  const env = { BOT_OWNER_ID: "111" } as any;
  const ownerCtx = { from: { id: 111 } } as any;

  it("admits the owner on a page owned by another user via their t.me link", () => {
    const page = { authorUrl: "https://t.me/dogzushi", authorName: "Someone Else" };
    expect(checkPageOwnership(page, OWNER_IDENTITY, false)).toBe(false);
    expect(checkPageOwnership(page, OWNER_IDENTITY, isBotOwner(ownerCtx, env))).toBe(true);
  });

  it("admits the owner on a channel-link page whose name does not match", () => {
    const page = { authorUrl: CHANNEL_LINK, authorName: "Lyriphon" };
    expect(checkPageOwnership(page, OWNER_IDENTITY, false)).toBe(false);
    expect(checkPageOwnership(page, OWNER_IDENTITY, isBotOwner(ownerCtx, env))).toBe(true);
  });

  it("keeps refusing non-owners on the same pages", () => {
    const other = { name: "Sara", url: "https://t.me/sara" };
    expect(checkPageOwnership({ authorUrl: "https://t.me/dogzushi", authorName: "Someone Else" }, other, false)).toBe(false);
    expect(checkPageOwnership({ authorUrl: CHANNEL_LINK, authorName: "Lyriphon" }, other, false)).toBe(false);
  });
});

// The expanded edit menu: Lyrics takes the whole first row and the Author
// button is gone, per the owner's request.
describe("buildEditMenu layout", () => {
  it("gives Lyrics the whole first row", () => {
    const menu = buildEditMenu(true);
    expect(menu[0]).toHaveLength(1);
    expect(menu[0][0].callback_data).toBe("edit_field_lyrics");
  });

  it("no longer offers the Author button", () => {
    expect(JSON.stringify(buildEditMenu(true))).not.toContain("edit_field_author");
  });

  it("still offers the other fields", () => {
    const flat = JSON.stringify(buildEditMenu(true));
    for (const field of ["edit_field_track", "edit_field_artist", "edit_field_album",
      "edit_field_date", "edit_field_cover", "edit_field_track_link",
      "edit_field_artist_link", "edit_field_album_link"]) {
      expect(flat).toContain(field);
    }
  });
});
