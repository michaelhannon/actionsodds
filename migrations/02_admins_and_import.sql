-- =============================================================================
-- ACTION'S ODDS — Migration 02
-- Flag admin accounts + import Kenny's existing ledger
-- =============================================================================
-- WHEN TO RUN: AFTER both Kenny and Mike have signed up via /auth/signup.html
-- This script is idempotent — safe to re-run.
-- =============================================================================

-- ─────────── 1. Flag Kenny + Mike as admins ───────────
update public.profiles
set is_admin = true
where user_id in (
  select id from auth.users
  where email in ('actionkg@aol.com', 'mike@programmaticpartners.com')
);

-- Verify
select u.email, p.is_admin, p.display_name, p.starting_bankroll
from auth.users u
join public.profiles p on p.user_id = u.id
where u.email in ('actionkg@aol.com', 'mike@programmaticpartners.com');

-- =============================================================================
-- ─────────── 2. Set Kenny's starting bankroll to match existing ledger ────
-- Existing season totals through Apr 24 2026:
--   Core P&L:     +$5,024  (25W-9L straight bets)
--   Exotic P&L:   +$899
--   Combined:     +$5,923
--   NHL P&L:      -$336
-- Setting starting bankroll to $10,000 (clean reference); current bankroll
-- reflects the real running total: $10,000 + $5,923 = $15,923.
-- =============================================================================
update public.profiles
set
  starting_bankroll = 10000.00,
  current_bankroll  = 15923.00
where user_id = (select id from auth.users where email = 'actionkg@aol.com');

-- =============================================================================
-- ─────────── 3. Import existing season summary as a single rollup play ────
-- Rather than re-creating every individual play (which we don't have detail
-- for), we create one summary "play" per sport per category capturing the
-- season's net result. This preserves the P&L without inventing fake data.
--
-- These can be edited or deleted later as more granular history comes in.
-- =============================================================================

-- MLB Core (+$5,024, 25W-9L straight bets)
insert into public.plays (
  user_id, sport_id, play_date, game, bet_type, selection,
  odds, stake, status, pnl, bet_category, notes
)
select
  u.id, 'mlb', '2026-04-24', 'Season-to-date rollup',
  'Summary', 'Core straight bets (25W-9L)',
  -100, 0.00, 'win', 5024.00, 'core',
  'Imported summary through Apr 24 2026. Replace with individual plays as logged.'
from auth.users u where u.email = 'actionkg@aol.com'
on conflict do nothing;

-- MLB Exotic (+$899)
insert into public.plays (
  user_id, sport_id, play_date, game, bet_type, selection,
  odds, stake, status, pnl, bet_category, notes
)
select
  u.id, 'mlb', '2026-04-24', 'Season-to-date rollup',
  'Summary', 'Exotic / parlay / round robin',
  -100, 0.00, 'win', 899.00, 'exotic',
  'Imported summary through Apr 24 2026. Replace with individual plays as logged.'
from auth.users u where u.email = 'actionkg@aol.com'
on conflict do nothing;

-- NHL (-$336)
insert into public.plays (
  user_id, sport_id, play_date, game, bet_type, selection,
  odds, stake, status, pnl, bet_category, notes
)
select
  u.id, 'nhl', '2026-04-24', 'Playoffs rollup',
  'Summary', 'Round 1 totals + series + hedges',
  -100, 0.00, 'loss', -336.00, 'core',
  'Imported summary through Apr 24 2026. NHL playoff R1 running total.'
from auth.users u where u.email = 'actionkg@aol.com'
on conflict do nothing;

-- =============================================================================
-- ─────────── 4. Action's Plays — seed each sport's running bankroll ───────
-- Action's Plays bankroll uses the same starting reference ($10,000 each
-- sport) and accumulates from there as morning-scan inserts qualifying picks.
-- For now: leave the seed values from migration 01 ($10K each). The morning
-- scan will start populating actions_plays going forward.
-- =============================================================================

-- (No update needed — migration 01 already seeded all 5 sports at $10,000)

-- =============================================================================
-- DONE
-- =============================================================================
-- Verify final state:
select 'profiles' as table_name, count(*) as rows from public.profiles
union all select 'plays', count(*) from public.plays
union all select 'sports', count(*) from public.sports
union all select 'actions_bankroll', count(*) from public.actions_bankroll;

-- Should show: profiles=2, plays=3, sports=5, actions_bankroll=5
