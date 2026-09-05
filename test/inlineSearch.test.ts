import { describe, expect, it } from "vitest";
import { buildInlineResults, isNewestQuery } from "../src/handlers/inlineSearch";

const deezerResults = [
  {
    id: 1,
    title: "Hello",
    artist: { name: "Adele" },
    duration: 295,
    album: { cover_medium: "https://cdn.deezer/img/1.jpg" },
  },
  {
    id: 2,
    title: "Hello (Single Edit)",
    artist: { name: "Martin Solveig" },
    duration: 205,
  },
];

describe("buildInlineResults", () => {
  it("builds article results with the Get Lyrics button", () => {
    const results = buildInlineResults(deezerResults);

    expect(results).toHaveLength(2);
    const [first] = results;
    expect(first.type).toBe("article");
    expect(first.id).toBe("1");
    expect(first.title).toBe("Hello - Adele");
    expect(first.description).toBe("Adele (4:55)");
    const btn: any = first.reply_markup?.inline_keyboard[0][0];
    expect(btn.text).toBe("📄 Get Lyrics");
    expect(btn.callback_data).toBe("track_1");
    const content: any = first.input_message_content;
    expect(content.message_text).toContain("Hello");
    expect(content.message_text).toContain("Adele");
    expect(content.parse_mode).toBe("Markdown");
  });

  it("sets thumbnail_url when a cover exists and omits it when not", () => {
    const results = buildInlineResults(deezerResults);
    expect(results[0].thumbnail_url).toBe("https://cdn.deezer/img/1.jpg");
    expect(results[1].thumbnail_url).toBeUndefined();
  });

  it("tolerates malformed entries", () => {
    const results = buildInlineResults([{ id: 3 }]);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Unknown - Unknown");
    expect(results[0].id).toBe("3");
  });
});

describe("isNewestQuery (staleness guard)", () => {
  it("answers the newest query and drops the older one", () => {
    const store = new Map<string, string>();
    store.set("42", "q1");
    expect(isNewestQuery(store, "42", "q1")).toBe(true);

    // A newer keystroke replaces the stored id...
    store.set("42", "q2");
    // ...so the in-flight q1 search must drop its answer...
    expect(isNewestQuery(store, "42", "q1")).toBe(false);
    // ...and q2 still owns the picker.
    expect(isNewestQuery(store, "42", "q2")).toBe(true);
  });

  it("tracks users independently", () => {
    const store = new Map<string, string>();
    store.set("1", "q1");
    store.set("2", "q2");
    expect(isNewestQuery(store, "1", "q1")).toBe(true);
    expect(isNewestQuery(store, "2", "q2")).toBe(true);
    expect(isNewestQuery(store, "1", "q2")).toBe(false);
  });
});
