-- Action's Odds — actions_plays brief column
-- Stores server-side generated AI briefs (one per qualifying play).
-- Generated once per scan by server/actions-briefer.js, cached forever
-- (briefs don't change once written — they reflect the scan that produced them).

ALTER TABLE actions_plays
  ADD COLUMN IF NOT EXISTS brief TEXT,
  ADD COLUMN IF NOT EXISTS brief_generated_at TIMESTAMPTZ;

-- Index so we can quickly find plays with no brief yet
CREATE INDEX IF NOT EXISTS actions_plays_no_brief_idx
  ON actions_plays (sport_id, play_date)
  WHERE brief IS NULL;
