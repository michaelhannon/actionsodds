-- ============================================================================
-- Action's Odds — Phase 2c
-- ----------------------------------------------------------------------------
-- Admin review queue for sharing_flags + tracking row for the cron run.
-- ============================================================================

-- ─── 1. Track when the sharing-cron last ran ─────────────────────────────
-- Single-row table holding a cursor for the cron. Avoids redundant scanning —
-- only re-analyze users with login activity since last run.
CREATE TABLE IF NOT EXISTS public.sharing_cron_state (
  id INT PRIMARY KEY DEFAULT 1,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (id = 1)
);

INSERT INTO public.sharing_cron_state (id, last_run_at)
VALUES (1, NOW())
ON CONFLICT (id) DO NOTHING;

-- ─── 2. Admin review view — easy SQL access to the queue ─────────────────
-- Joins sharing_flags with profile (display_name) and auth.users (email).
-- Note: the user's email lives in auth.users (Supabase managed), not profiles.
CREATE OR REPLACE VIEW public.unreviewed_sharing_flags AS
SELECT
  sf.id,
  sf.user_id,
  p.display_name,
  u.email,
  sf.flag_type,
  sf.severity,
  sf.evidence,
  sf.created_at,
  sf.reviewed,
  sf.reviewed_by,
  sf.reviewed_at,
  sf.resolution
FROM public.sharing_flags sf
LEFT JOIN public.profiles p ON p.user_id = sf.user_id
LEFT JOIN auth.users u ON u.id = sf.user_id
WHERE sf.reviewed = FALSE
ORDER BY
  CASE sf.severity
    WHEN 'high' THEN 1
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 3
  END,
  sf.created_at DESC;

-- ─── 3. All-flags view (for history queries) ────────────────────────────
CREATE OR REPLACE VIEW public.all_sharing_flags AS
SELECT
  sf.id,
  sf.user_id,
  p.display_name,
  u.email,
  sf.flag_type,
  sf.severity,
  sf.evidence,
  sf.created_at,
  sf.reviewed,
  sf.reviewed_by,
  sf.reviewed_at,
  sf.resolution
FROM public.sharing_flags sf
LEFT JOIN public.profiles p ON p.user_id = sf.user_id
LEFT JOIN auth.users u ON u.id = sf.user_id
ORDER BY sf.created_at DESC;

-- Done.
