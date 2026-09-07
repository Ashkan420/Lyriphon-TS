import { describe, expect, it } from "vitest";
import {
  buildBrowserHomeKeyboard,
  formatBrowserHomeText,
  buildRowButton,
  buildListNavRow,
  buildRecordKeyboard,
  formatRecordText,
  buildConfirmKeyboard,
  formatConfirmText,
  buildCandidateButton,
  formatCandidatePreviewText,
} from "../src/handlers/dbAdmin";
import { buildEditMenu } from "../src/handlers/callbacks/index";
import { toLyricsCandidate } from "../src/services/lrclib";
import { buildApplyD1Keyboard } from "../src/handlers/callbacks/edit";
import { createSessionData } from "../src/session/flows";
import { dbBrowserOf } from "../src/session/flows";

describe("db browser renderers", () => {
  const row = {
    track_id: 123,
    title: "Weird & <Title>",
    artist: "Artist > X",
    file_id: "CQACAgIAAxkBAAIVwGqci7KpcwABX2Cl",
    lyrics: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8",
    updated_at: 1788644275,
  };

  it("home keyboard: admin entry adds Back, /db entry adds Close", () => {
    const kb = buildBrowserHomeKeyboard(true);
    expect(kb[0]).toEqual([
      { text: "🔍 Search", callback_data: "dbview_search" },
      { text: "🕒 Recent", callback_data: "dbview_list_p0" },
    ]);
    expect(kb[1]).toEqual([{ text: "🕳 Missing lyrics", callback_data: "dbview_missing_p0" }]);
    expect(kb[2]).toEqual([{ text: "⬅️ Back", callback_data: "admin_back" }]);
    expect(buildBrowserHomeKeyboard(false)[2]).toEqual([
      { text: "Close", callback_data: "dbview_close", style: "danger" },
    ]);
  });

  it("home text carries stats", () => {
    const text = formatBrowserHomeText({ total: 117, withFileId: 40, withLyrics: 100 });
    expect(text).toContain("Rows: <b>117</b>");
    expect(text).toContain("🎧 With file_id: <b>40</b>");
    expect(text).toContain("📝 With lyrics: <b>100</b>");
  });

  it("row buttons carry 🎧/📝 marks, truncation, and the track id callback", () => {
    const btn = buildRowButton(row);
    expect(btn.callback_data).toBe("dbview_t_123");
    expect(btn.text).toContain("🎧📝");
    expect(btn.text.length).toBeLessThanOrEqual(60);
  });

  it("nav row skips when there is a single page", () => {
    expect(buildListNavRow(0, 1)).toEqual([]);
    const nav = buildListNavRow(1, 3);
    expect(nav).toHaveLength(3);
    expect(nav[0].callback_data).toBe("dbview_p_0");
    expect(nav[1].callback_data).toBe("dbview_p_1");
    expect(nav[2].callback_data).toBe("dbview_p_2");
  });

  it("record text marks cached vs absent values and truncates the lyrics preview", () => {
    const text = formatRecordText(row);
    expect(text).toContain("🎧 file_id: <b>cached</b>");
    expect(text).toContain("📝 lyrics: <b>8 lines</b>");
    expect(text).toContain("line6");
    expect(text).not.toContain("line7");
    expect(text).toContain("Weird &amp; &lt;Title&gt;");
  });

  it("record text handles NULL fields", () => {
    const text = formatRecordText({ ...row, title: null, artist: null, file_id: null, lyrics: null });
    expect(text).toContain("—");
    expect(text).toContain("🎧 file_id: <i>none</i>");
    expect(text).toContain("📝 lyrics: <i>none</i>");
  });

  it("record keyboard exposes all six actions with a 64-byte-safe callback", () => {
    const kb = buildRecordKeyboard(row);
    expect(kb.flat().map((b) => b.callback_data)).toEqual([
      "dbview_cf_123",
      "dbview_cl_123",
      "dbview_rf_123",
      "dbview_set_123",
      "dbview_qs_123",
      "dbview_del_123",
      "dbview_back",
    ]);
    for (const b of kb.flat()) {
      expect(b.callback_data.length).toBeLessThanOrEqual(64);
    }
  });

  it("confirm keyboards wire Confirm/Cancel to the right actions", () => {
    expect(buildConfirmKeyboard("fileid", 7)).toEqual([
      [
        { text: "✅ Confirm", callback_data: "dbview_cfy_7", style: "danger" },
        { text: "⬅️ Cancel", callback_data: "dbview_t_7" },
      ],
    ]);
    expect(buildConfirmKeyboard("lyrics", 7)[0][0].callback_data).toBe("dbview_cly_7");
    expect(buildConfirmKeyboard("delete", 7)[0][0].callback_data).toBe("dbview_dely_7");
    expect(formatConfirmText("delete", row)).toContain("DELETE the whole row");
    expect(formatConfirmText("fileid", row)).toContain("clear the cached file_id");
  });

  it("candidate buttons badge synced results and carry the index", () => {
    const btn = buildCandidateButton(
      { trackName: "Song", albumName: "Album Name That Is Long", source: "synced" },
      3,
    );
    expect(btn.callback_data).toBe("dbview_rc_3");
    expect(btn.text).toContain("🔁");
  });

  it("candidate preview marks the source and truncates", () => {
    const text = formatCandidatePreviewText({
      trackName: "Song",
      artistName: "Artist",
      albumName: "Album",
      source: "plain",
      lyrics: "a\nb",
    });
    expect(text).toContain("📝 plain");
    expect(text).toContain("<blockquote>");
  });

  it("dbBrowserOf lazily materializes on old persisted sessions", () => {
    const s = createSessionData() as any;
    delete s.dbBrowser;
    const db = dbBrowserOf(s);
    expect(db.buffer).toEqual([]);
    expect(s.dbBrowser).toBe(db);
  });
});

describe("LRCLIB candidate mapper", () => {
  it("prefers plain lyrics", () => {
    const c = toLyricsCandidate({
      trackName: "S",
      artistName: "A",
      albumName: "Al",
      plainLyrics: "one\ntwo\n",
      syncedLyrics: "[00:01.00] stamped",
    });
    expect(c?.source).toBe("plain");
    expect(c?.lyrics).toBe("one\ntwo");
  });

  it("strips synced timestamps", () => {
    const c = toLyricsCandidate({
      trackName: "S",
      artistName: "A",
      plainLyrics: null,
      syncedLyrics: "[00:01.00]hello\n[00:02.50]world\n",
    });
    expect(c?.source).toBe("synced");
    expect(c?.lyrics).toBe("hello\nworld");
  });

  it("returns null when nothing usable remains", () => {
    expect(toLyricsCandidate({ trackName: "S", artistName: "A", plainLyrics: "   ", syncedLyrics: null })).toBeNull();
  });
});

describe("buildEditMenu admin tools", () => {
  it("adds the Cache-tools row only for owners with a numeric trackId", () => {
    for (const expanded of [false, true]) {
      const owner = buildEditMenu(expanded, { adminTools: true, trackId: 42 });
      const last = owner[owner.length - 1];
      expect(last[0].callback_data).toBe("dbview_card_42");
      expect(last[0].text).toBe("🛠 Cache tools");

      const nonOwner = buildEditMenu(expanded, { adminTools: false, trackId: 42 });
      expect(JSON.stringify(nonOwner)).not.toContain("dbview_card_");
    }
  });

  it("collapsed menu still has the standard rows when tools are off", () => {
    expect(buildEditMenu(false)).toHaveLength(2);
  });
});

describe("apply-to-D1 keyboard", () => {
  it("wires the track id into the callback", () => {
    const kb = buildApplyD1Keyboard(42);
    expect(kb[0][0]).toMatchObject({
      text: "💾 Apply to D1",
      callback_data: "applyd1_42",
      style: "success",
    });
  });
});
