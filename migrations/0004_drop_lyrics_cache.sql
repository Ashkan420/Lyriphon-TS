-- lyrics_cache is fully superseded by tracks (backfilled by migration 0003
-- and now the only lyrics store — see src/db/tracks.ts). Drop the legacy
-- copy once 0003 has been applied.
DROP TABLE IF EXISTS lyrics_cache;
