-- Action's Odds — actions_plays indexes
-- Run in Supabase SQL editor BEFORE deploying the publisher.
--
-- 1. Unique index makes publishScanPlays() idempotent. Re-running the same
--    scan inserts no duplicate rows. The publisher uses upsert with
--    onConflict='play_date,game,selection'.
-- 2. (status, sport_id) speeds up the grader's "find pending MLB plays" query.
-- 3. (play_date) speeds up the head-to-head widget's date-range queries.

-- 1) Idempotency for the publisher
CREATE UNIQUE INDEX IF NOT EXISTS actions_plays_unique_play
  ON actions_plays (play_date, game, selection);

-- 2) Grader: pending plays by sport
CREATE INDEX IF NOT EXISTS actions_plays_status_sport_idx
  ON actions_plays (status, sport_id)
  WHERE status = 'pending';

-- 3) Date-range queries from the front-end
CREATE INDEX IF NOT EXISTS actions_plays_play_date_idx
  ON actions_plays (play_date DESC);

-- Sanity: confirm the indexes
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'actions_plays';
