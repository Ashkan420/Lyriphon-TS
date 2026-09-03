import { describe, expect, it } from "vitest";
import { getTrackRecord, upsertTrack, setTrackFileId, hasTrackFile } from "../src/db/tracks";

// Minimal D1 stub: keeps one row in memory, executes the upsert's COALESCE
// semantics so the tests exercise the real merge behavior.
function fakeTracksDb() {
  let row: any = null;
  return {
    get row() {
      return row;
    },
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (sql.includes("SELECT track_id")) {
                return (row as unknown as T) ?? null;
              }
              return null;
            },
            async all() {
              return { results: row ? [row] : [] };
            },
            async run() {
              if (sql.includes("INSERT INTO tracks")) {
                const [trackId, title, artist, fileId, lyrics] = args;
                if (!row || row.track_id !== trackId) {
                  row = {
                    track_id: trackId,
                    title,
                    artist,
                    file_id: fileId,
                    lyrics,
                    created_at: 1,
                    updated_at: 2,
                  };
                } else {
                  // Mirror ON CONFLICT DO UPDATE ... COALESCE
                  row = {
                    ...row,
                    title: title ?? row.title,
                    artist: artist ?? row.artist,
                    file_id: fileId ?? row.file_id,
                    lyrics: lyrics ?? row.lyrics,
                    updated_at: 2,
                  };
                }
              }
            },
          };
        },
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
});
