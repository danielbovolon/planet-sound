-- Trim: an entry can be played from trim_start to trim_end (seconds). The audio file itself is never cut.
-- The Worker adds these columns by itself on its first request; this file is here for a fresh setup or by hand:
--   npx wrangler d1 execute planet-sound --remote --file=migrations/0004_trim.sql
ALTER TABLE sounds ADD COLUMN trim_start REAL;
ALTER TABLE sounds ADD COLUMN trim_end REAL;
