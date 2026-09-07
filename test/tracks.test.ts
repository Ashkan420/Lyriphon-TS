import { describe, expect, it } from "vitest";
import {
  getTrackRecord,
  upsertTrack,
  setTrackFileId,
  setTrackLyrics,
  hasTrackFile,
  clearTrackFileId,
  clearTrackLyrics,
  deleteTrackRow,
  listTrackRows,
  searchTrackRows,
  countTrackRows,
  countTrackStats,
} from "../src/db/tracks";

// Minimal D1 stub: keeps rows in memory, mirrors the real SQL semantics the
// store relies on (upsert COALESCE, direct UPDATE/DELETE, LIKE search).
function fakeTracksDb() {
  const rows = new Map<number, any>();
  let seq = 1;
  const hasWhere = (q: string) => q.includes("WHERE (title LIKE");

  function filterRows(pattern: string | null, sql?: string): any[] {
    let all = [...rows.values()].sort((a, b) => b.updated_at - a.updated_at);
    if (sql?.includes("WHERE lyrics IS NULL")) {
      all = all.filter((r) => r.lyrics === null);
    }
    if (pattern === null || pattern === undefined) {
      return all;
    }
    const raw = pattern.slice(1, -1).replace(/\\%/g, "%").replace(/\\_/g, "_");
    const needle = raw.toLowerCase();
    const asId = /^\d+$/.test(raw) ? Number(raw) : null;
    return all.filter((r) => {
      if (asId !== null && r.track_id === asId) return true;
      return (
        (r.title ?? "").toLowerCase().includes(needle)
        || (r.artist ?? "").toLowerCase().includes(needle)
      );
    });
  }

  function statsRow() {
    const all = [...rows.values()];
    return {
      total: all.length,
      with_file_id: all.filter((r) => r.file_id !== null).length || null,
      with_lyrics: all.filter((r) => r.lyrics !== null).length || null,
    };
  }

  return {
    rows,
    prepare(sql: string) {
      const boundApi = {
        bind(...args: any[]) {
          // Bind layouts: paged list = (limit, offset) or (…binds, limit, offset);
          // count = (…binds). Mirror the store's call sites.
          const pattern = hasWhere(sql) ? (args[0] ?? null) : null;
          const limit = args.length >= 2 ? args[args.length - 2] : undefined;
          const offset = args.length >= 2 ? args[args.length - 1] : undefined;
          return {
            async first<T>(): Promise<T | null> {
              if (sql.includes("SELECT track_id")) {
                const row = rows.get(args[0]);
                return (row as unknown as T) ?? null;
              }
              if (sql.includes("SELECT COUNT(*) AS n FROM tracks")) {
                return { n: filterRows(pattern).length } as unknown as T;
              }
              return null;
            },
            async all<T>(): Promise<{ results: T[] }> {
              if (sql.includes("ORDER BY updated_at DESC")) {
                const matches = filterRows(pattern, sql);
                return { results: matches.slice(offset, offset + limit) } as any;
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO tracks")) {
                const [trackId, title, artist, fileId, lyrics] = args;
                const existing = rows.get(trackId);
                if (!existing) {
                  rows.set(trackId, {
                    track_id: trackId,
                    title,
                    artist,
                    file_id: fileId,
                    lyrics,
                    created_at: 1,
                    updated_at: seq++,
                  });
                } else {
                  // Mirror ON CONFLICT DO UPDATE ... COALESCE
                  rows.set(trackId, {
                    ...existing,
                    title: title ?? existing.title,
                    artist: artist ?? existing.artist,
                    file_id: fileId ?? existing.file_id,
                    lyrics: lyrics ?? existing.lyrics,
                    updated_at: seq++,
                  });
                }
                return;
              }
              if (sql.includes("UPDATE tracks SET file_id = NULL")) {
                const row = rows.get(args[0]);
                if (row) rows.set(args[0], { ...row, file_id: null, updated_at: seq++ });
                return;
              }
              if (sql.includes("UPDATE tracks SET lyrics = NULL")) {
                const row = rows.get(args[0]);
                if (row) rows.set(args[0], { ...row, lyrics: null, updated_at: seq++ });
                return;
              }
              if (sql.includes("DELETE FROM tracks")) {
                rows.delete(args[0]);
                return;
              }
            },
          };
        },
      };
      return {
        // countTrackStats and the unfiltered/missing-lyrics counts call
        // .first() without .bind()
        async first<T>(): Promise<T | null> {
          if (sql.includes("COUNT(*) AS total")) {
            return statsRow() as unknown as T;
          }
          if (sql.includes("SELECT COUNT(*) AS n FROM tracks")) {
            return { n: filterRows(null, sql).length } as unknown as T;
          }
          return null;
        },
        ...boundApi,
        // unbound .all()/.run() for ensureTable probes
        async all() {
          return { results: [] };
        },
        async run() {},
      };
    },
  } as unknown as any;
}

describe("tracks store", () => {
  it("upsert + get roundtrip", async () => {
    const db = fakeTracksDb();
    await upsertTrack(db, { trackId: 1, title: "Song", artist: "Artist", lyrics: "la la" });
    const rec = await getTrackRecord(db, 1);
    expect(rec?.title).toBe("Song");
    expect(rec?.lyrics).toBe("la la");
    expect(rec?.file_id).toBeNull();
  });

  it("partial upsert preserves existing fields (COALESCE semantics)", async () => {
    const db = fakeTracksDb();
    await upsertTrack(db, { trackId: 1, title: "Song", artist: "Artist", lyrics: "la la" });
    await setTrackFileId(db, 1, "file-123");
    const rec = await getTrackRecord(db, 1);
    expect(rec?.file_id).toBe("file-123");
    expect(rec?.lyrics).toBe("la la"); // untouched
    expect(rec?.title).toBe("Song");
  });

  it("setTrackFileId with null leaves the existing value (never blanks)", async () => {
    const db = fakeTracksDb();
    await upsertTrack(db, { trackId: 1, fileId: "keep-me" });
    await setTrackFileId(db, 1, null);
    const rec = await getTrackRecord(db, 1);
    expect(rec?.file_id).toBe("keep-me");
  });

  it("setTrackLyrics overwrites lyrics and preserves the rest", async () => {
    const db = fakeTracksDb();
    await upsertTrack(db, { trackId: 1, title: "Song", artist: "Artist", lyrics: "old", fileId: "f-1" });
    await setTrackLyrics(db, 1, "new lyrics");
    const rec = await getTrackRecord(db, 1);
    expect(rec?.lyrics).toBe("new lyrics");
    expect(rec?.title).toBe("Song");
    expect(rec?.file_id).toBe("f-1");
  });

  it("clearTrackFileId nulls file_id and leaves lyrics", async () => {
    const db = fakeTracksDb();
    await upsertTrack(db, { trackId: 1, fileId: "f-1", lyrics: "words" });
    await clearTrackFileId(db, 1);
    const rec = await getTrackRecord(db, 1);
    expect(rec?.file_id).toBeNull();
    expect(rec?.lyrics).toBe("words");
  });

  it("clearTrackLyrics nulls lyrics and leaves file_id", async () => {
    const db = fakeTracksDb();
    await upsertTrack(db, { trackId: 1, fileId: "f-1", lyrics: "words" });
    await clearTrackLyrics(db, 1);
    const rec = await getTrackRecord(db, 1);
    expect(rec?.lyrics).toBeNull();
    expect(rec?.file_id).toBe("f-1");
  });

  it("deleteTrackRow removes the record", async () => {
    const db = fakeTracksDb();
    await upsertTrack(db, { trackId: 1, title: "Song" });
    await deleteTrackRow(db, 1);
    expect(await getTrackRecord(db, 1)).toBeNull();
  });

  it("hasTrackFile reflects stored state", async () => {
    const db = fakeTracksDb();
    expect(await hasTrackFile(db, 1)).toBe(false);
    await setTrackFileId(db, 1, "file-1");
    expect(await hasTrackFile(db, 1)).toBe(true);
  });

  it("missing record returns null / false", async () => {
    const db = fakeTracksDb();
    expect(await getTrackRecord(db, 999)).toBeNull();
    expect(await hasTrackFile(db, 999)).toBe(false);
  });

  it("listTrackRows pages recents by updated_at desc", async () => {
    const db = fakeTracksDb();
    for (const id of [1, 2, 3]) {
      await upsertTrack(db, { trackId: id, title: `T${id}` });
    }
    const page0 = await listTrackRows(db, 2, 0);
    expect(page0.map((r) => r.track_id)).toEqual([3, 2]);
    const page1 = await listTrackRows(db, 2, 2);
    expect(page1.map((r) => r.track_id)).toEqual([1]);
  });

  it("searchTrackRows matches title/artist substring and reorders", async () => {
    const db = fakeTracksDb();
    await upsertTrack(db, { trackId: 10, title: "Hello", artist: "Adele" });
    await upsertTrack(db, { trackId: 20, title: "Words", artist: "Adele" });
    await upsertTrack(db, { trackId: 30, title: "Runaway", artist: "Kanye" });

    const hits = await searchTrackRows(db, "adele", 10, 0);
    expect(hits.map((r) => r.track_id)).toEqual([20, 10]); // recency order (20 upserted last)
    expect(await countTrackRows(db, "adele")).toBe(2);
    expect(await searchTrackRows(db, "zzz", 10, 0)).toEqual([]);
  });

  it("all-digit queries also match the exact track id", async () => {
    const db = fakeTracksDb();
    await upsertTrack(db, { trackId: 12345, title: "Mystery", artist: "Someone" });
    const hits = await searchTrackRows(db, "12345", 10, 0);
    expect(hits.map((r) => r.track_id)).toEqual([12345]);
    expect(await countTrackRows(db, "12345")).toBe(1);
  });

  it("LIKE wildcards in queries are literal", async () => {
    const db = fakeTracksDb();
    await upsertTrack(db, { trackId: 1, title: "100% Rate", artist: "A" });
    await upsertTrack(db, { trackId: 2, title: "Whatever", artist: "B" });
    expect(await countTrackRows(db, "%")).toBe(1);
    expect((await searchTrackRows(db, "%", 10, 0))[0].track_id).toBe(1);
  });

  it("search SQL binds exactly as many params as its highest placeholder index", async () => {
    // Regression: LIMIT ?3 OFFSET ?4 was hardcoded while text queries bound
    // only 3 params — D1 rejects statements whose ?N has no Nth bind.
    const db = fakeTracksDb();
    let checked = 0;
    const probe = {
      prepare(sql: string) {
        const re = /\?(\d+)/g;
        let maxIdx = 0;
        for (const m of sql.matchAll(re)) {
          maxIdx = Math.max(maxIdx, Number(m[1]));
        }
        return {
          bind(...args: any[]) {
            if (sql.includes("ORDER BY updated_at DESC") && sql.includes("WHERE")) {
              checked += 1;
              expect(args.length).toBe(maxIdx);
            }
            return {
              async first<T>() { return null as unknown as T; },
              async all<T>() { return { results: [] as unknown as T[] }; },
              async run() {},
            };
          },
        };
      },
    } as unknown as any;

    await searchTrackRows(probe, "text query", 5, 0); // 1 pattern bind
    await searchTrackRows(probe, "12345", 5, 0); // 2 binds (pattern + id)
    expect(checked).toBe(2);
  });

  it("missingLyrics filter lists only rows with NULL lyrics", async () => {
    const db = fakeTracksDb();
    await upsertTrack(db, { trackId: 1, title: "Has", lyrics: "words" });
    await upsertTrack(db, { trackId: 2, title: "Missing" });
    const rows = await listTrackRows(db, 10, 0, { missingLyrics: true });
    expect(rows.map((r) => r.track_id)).toEqual([2]);
    expect(await countTrackRows(db, undefined, { missingLyrics: true })).toBe(1);
    expect(await countTrackRows(db, undefined)).toBe(2);
  });

  it("countTrackStats reports cached-value coverage", async () => {
    const db = fakeTracksDb();
    await upsertTrack(db, { trackId: 1, fileId: "f", lyrics: "l" });
    await upsertTrack(db, { trackId: 2, fileId: "f" });
    expect(await countTrackStats(db)).toEqual({ total: 2, withFileId: 2, withLyrics: 1 });
  });
});
