import { describe, expect, it } from "vitest";
import { parseAlbumTarget, routeForSelection } from "../src/handlers/album";
import {
  bytesStartsWith,
  describeButtons,
  extractButtonAction,
  findGetAllButton,
  isFreshView,
  parseStartParamFor,
  ViewButtonInfo,
} from "../src/bridge/viewMatch";

describe("parseAlbumTarget", () => {
  it("extracts the album id from a deezload deep link", () => {
    expect(parseAlbumTarget("https://t.me/deezload2bot?start=deezertalbum86994002")).toEqual({ albumId: 86994002 });
    expect(parseAlbumTarget("http://t.me/deezload2bot?start=deezertalbum86994002")).toEqual({ albumId: 86994002 });
    expect(parseAlbumTarget("/start deezertalbum86994002")).toEqual({ albumId: 86994002 });
  });

  it("accepts a bare token and a bare id", () => {
    expect(parseAlbumTarget("deezertalbum86994002")).toEqual({ albumId: 86994002 });
    expect(parseAlbumTarget("86994002")).toEqual({ albumId: 86994002 });
  });

  it("treats free text as a query", () => {
    expect(parseAlbumTarget("2001 dr dre")).toEqual({ query: "2001 dr dre" });
    // A track/deezer link with no album token is a query too.
    expect(parseAlbumTarget("https://t.me/deezload2bot?start=deezerttrack123")).toEqual({
      query: "https://t.me/deezload2bot?start=deezerttrack123",
    });
  });
});

describe("routeForSelection", () => {
  it("uses per-track jobs up to the threshold and one album job above it", () => {
    expect(routeForSelection(1)).toBe("tracks");
    expect(routeForSelection(5)).toBe("tracks");
    expect(routeForSelection(6)).toBe("album");
    expect(routeForSelection(20)).toBe("album");
  });

  it("honors a custom threshold", () => {
    expect(routeForSelection(3, 3)).toBe("tracks");
    expect(routeForSelection(4, 3)).toBe("album");
  });
});

// The GET ALL button as a real run showed it: URL deep-link buttons with no
// callback data (track rows are deezer.com/track/<id> links).
function urlButton(text: string, url: string): ViewButtonInfo {
  return { text, url };
}
function dataButton(text: string, data: string): ViewButtonInfo {
  return { text, data: new TextEncoder().encode(data) };
}

describe("findGetAllButton", () => {
  const albumId = 10709540;

  it("prefers callback data starting with the album down-token", () => {
    const buttons = [
      dataButton("🎵 Nangs", "trackpage/1"),
      dataButton("GET ALL⬇️", `album/${albumId}/down`),
      dataButton("ZIP⬇️", `album/${albumId}/zipdown`),
    ];
    const found = findGetAllButton(buttons, albumId);
    expect(found?.how).toBe("data");
    expect(found?.button.text).toBe("GET ALL⬇️");
  });

  it("matches a URL deep-link button containing the down-token", () => {
    const buttons = [
      urlButton("🎵 Nangs", "https://deezer.com/track/1"),
      urlButton("GET ALL⬇️", `https://t.me/deezload2bot?start=album/${albumId}/down`),
      urlButton("⬅️ Albums", "https://t.me/deezload2bot?start=deezertartist230"),
    ];
    const found = findGetAllButton(buttons, albumId);
    expect(found?.how).toBe("url");
    expect(found?.button.text).toBe("GET ALL⬇️");
  });

  it("falls back to a GET ALL label when neither data nor url match", () => {
    const buttons = [urlButton("🎵 Nangs", "https://deezer.com/track/1"), urlButton("GET ALL⬇️", "https://example.com")];
    const found = findGetAllButton(buttons, albumId);
    expect(found?.how).toBe("text");
  });

  it("returns null for a keyboard with no GET ALL anywhere", () => {
    const buttons = [
      urlButton("🎵 Nangs", "https://deezer.com/track/1"),
      urlButton("⬅️ Albums", "https://t.me/deezload2bot?start=deezertartist230"),
    ];
    expect(findGetAllButton(buttons, albumId)).toBeNull();
  });

  it("ignores other albums' down-tokens (data and url), landing on the text fallback", () => {
    const buttons = [
      dataButton("GET ALL⬇️", "album/999/down"),
      urlButton("GET ALL⬇️", "https://t.me/deezload2bot?start=album/999/down"),
    ];
    // Album-specific checks fail; the label fallback still fires — correct,
    // because a FRESH keyboard in deezload's DM is the view for the album
    // just /start'd, so its GET ALL is ours.
    const found = findGetAllButton(buttons, albumId);
    expect(found?.how).toBe("text");
  });
});

describe("isFreshView", () => {
  const startedAt = 1788984999;

  it("accepts a message posted at/after the start second (with 60s skew slack)", () => {
    expect(isFreshView({ date: startedAt }, startedAt)).toBe(true);
    expect(isFreshView({ date: startedAt - 60 }, startedAt)).toBe(true);
    expect(isFreshView({ date: startedAt + 1 }, startedAt)).toBe(true);
  });

  it("rejects older messages", () => {
    expect(isFreshView({ date: startedAt - 61 }, startedAt)).toBe(false);
    expect(isFreshView({}, startedAt)).toBe(false);
  });

  it("accepts an edit of an older view (editDate fresh)", () => {
    const msg = { date: startedAt - 3600, editDate: startedAt + 2 };
    expect(isFreshView(msg, startedAt)).toBe(true);
  });
});

describe("bytesStartsWith", () => {
  it("matches ASCII prefixes of TL callback bytes", () => {
    const bytes = new TextEncoder().encode("album/10709540/down");
    expect(bytesStartsWith(bytes, "album/10709540/down")).toBe(true);
    expect(bytesStartsWith(bytes, "album/10709540/zip")).toBe(false);
    expect(bytesStartsWith(new Uint8Array(2), "album")).toBe(false);
  });
});

describe("parseStartParamFor", () => {
  const username = "deezload2bot";

  it("extracts the start param from t.me deep links", () => {
    expect(parseStartParamFor(`https://t.me/deezload2bot?start=album/123/down`, username)).toBe("album/123/down");
    expect(parseStartParamFor(`https://telegram.me/deezload2bot?start=deezertalbum42`, username)).toBe(
      "deezertalbum42",
    );
  });

  it("handles tg://resolve links", () => {
    expect(parseStartParamFor(`tg://resolve?domain=deezload2bot&start=album/5/down`, username)).toBe("album/5/down");
  });

  it("rejects foreign bots and junk", () => {
    expect(parseStartParamFor("https://t.me/otherbot?start=album/1/down", username)).toBeNull();
    expect(parseStartParamFor("https://deezer.com/track/1", username)).toBeNull();
    expect(parseStartParamFor("not a url", username)).toBeNull();
    expect(parseStartParamFor("https://t.me/deezload2bot", username)).toBeNull();
  });
});

describe("describeButtons", () => {
  it("renders text, data hex and urls without slicing buttons away", () => {
    const out = describeButtons([
      dataButton("ACT", "album/1/down"),
      urlButton("LINK", "https://deezer.com/track/1"),
      { text: "EMPTY" },
    ]);
    expect(out).toContain('"ACT"→data[');
    expect(out).toContain("616c62756d2f312f646f776e");
    expect(out).toContain('"LINK"→url https://deezer.com/track/1');
    expect(out).toContain('"EMPTY"→(no action)');
  });

  it("says none for an empty keyboard", () => {
    expect(describeButtons([])).toBe("none");
  });
});

describe("extractButtonAction", () => {
  it("reads teleproto fork buttons: action nested inside btn.type", () => {
    // The exact shape from the failing runs: KeyboardInlineButton with a
    // InlineButtonTypeCallback — action one level down, invisible to a
    // btn.data read.
    const nested = {
      className: "KeyboardInlineButton",
      text: "GET ALL ⬇️",
      type: {
        className: "InlineButtonTypeCallback",
        data: new TextEncoder().encode("album/10709540/down"),
      },
    };
    expect(extractButtonAction(nested).data).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(extractButtonAction(nested).data!)).toBe("album/10709540/down");

    const urlBtn = { text: "ZIP", type: { className: "InlineButtonTypeUrl", url: "https://deezer.com/x" } };
    expect(extractButtonAction(urlBtn).url).toBe("https://deezer.com/x");

    const switchBtn = { text: "S", type: { className: "InlineButtonTypeSwitchInline", query: "q" } };
    expect(extractButtonAction(switchBtn).switchInline).toBe("q");
  });

  it("reads upstream-shaped buttons: action directly on the button", () => {
    const flat = { text: "GET ALL", data: new TextEncoder().encode("album/1/down") };
    expect(extractButtonAction(flat).data).toBeInstanceOf(Uint8Array);
    expect(extractButtonAction({ text: "L", url: "https://x" }).url).toBe("https://x");
  });

  it("returns no action for a genuinely inert button", () => {
    expect(extractButtonAction({ text: "GET ALL" })).toEqual({});
    // And the fresh-view keyboard then falls to the text-send branch.
  });
});
