-- =============================================================================
-- ACTION'S ODDS — SaaS Platform Schema
-- Migration 01: Initial schema
-- =============================================================================
-- Run this in: Supabase Dashboard → SQL Editor → "New query"
-- After successful run, you'll see 7 tables in Table Editor:
--   profiles, sports, subscriptions, plays, actions_plays,
--   actions_bankroll, settings
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. profiles — extends Supabase's auth.users with app-specific data
-- -----------------------------------------------------------------------------
-- Every row here corresponds 1:1 with a row in auth.users.
-- We don't store password/email here (Supabase Auth handles that).
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  is_admin boolean not null default false,
  starting_bankroll numeric(12,2) not null default 10000.00,
  current_bankroll numeric(12,2) not null default 10000.00,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Per-user app data; 1:1 with auth.users. Holds bankroll, role flag.';

-- -----------------------------------------------------------------------------
-- 2. sports — the 5 sports that can be subscribed to
-- -----------------------------------------------------------------------------
create table public.sports (
  id text primary key,           -- 'mlb', 'nhl', 'nba', 'nfl', 'golf'
  display_name text not null,    -- 'MLB', 'NHL', etc.
  active boolean not null default true,
  sort_order integer not null default 0
);

insert into public.sports (id, display_name, sort_order) values
  ('mlb',  'MLB',  1),
  ('nhl',  'NHL',  2),
  ('nba',  'NBA',  3),
  ('nfl',  'NFL',  4),
  ('golf', 'Golf', 5);

-- -----------------------------------------------------------------------------
-- 3. subscriptions — track what each user has access to
-- -----------------------------------------------------------------------------
-- One row per (user, sport) combination they're subscribed to.
-- Bundle subscribers get 5 rows (one per sport), each tagged is_bundle=true.
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sport_id text not null references public.sports(id),
  cadence text not null check (cadence in ('weekly','monthly','yearly')),
  is_bundle boolean not null default false,
  status text not null check (status in ('active','past_due','canceled','trialing','incomplete')),
  stripe_subscription_id text,
  stripe_customer_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, sport_id)
);

comment on table public.subscriptions is 'Active sport subscriptions per user. Driven by Stripe webhooks.';

create index idx_subscriptions_user on public.subscriptions(user_id);
create index idx_subscriptions_status on public.subscriptions(status) where status = 'active';

-- -----------------------------------------------------------------------------
-- 4. plays — each user's individual betting log
-- -----------------------------------------------------------------------------
create table public.plays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sport_id text not null references public.sports(id),
  play_date date not null,
  game text not null,                                -- "NYY @ HOU"
  bet_type text not null,                            -- "ML", "RL", "Total", etc.
  selection text not null,                           -- "NYY ML", "NYY -1.5", "Over 9.5"
  odds integer not null,                             -- American odds: -150, +130
  stake numeric(10,2) not null,                      -- 200.00
  status text not null default 'pending'
    check (status in ('pending','win','loss','push','void')),
  pnl numeric(10,2) not null default 0,              -- computed when status changes
  bet_category text not null default 'core'
    check (bet_category in ('core','exotic')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_plays_user_date on public.plays(user_id, play_date desc);
create index idx_plays_status on public.plays(user_id, status);
create index idx_plays_sport on public.plays(user_id, sport_id);

comment on table public.plays is 'Per-user bet log. P&L is computed and stored at grade time.';

-- -----------------------------------------------------------------------------
-- 5. actions_plays — the shared "Action's Plays" ledger
-- -----------------------------------------------------------------------------
-- Same recommendations Action would make; visible to all users for comparison.
-- Populated automatically by morning-scan + manually by admin.
create table public.actions_plays (
  id uuid primary key default gen_random_uuid(),
  sport_id text not null references public.sports(id),
  play_date date not null,
  game text not null,
  bet_type text not null,
  selection text not null,
  odds integer not null,
  stake numeric(10,2) not null,
  status text not null default 'pending'
    check (status in ('pending','win','loss','push','void')),
  pnl numeric(10,2) not null default 0,
  bet_category text not null default 'core'
    check (bet_category in ('core','exotic')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_actions_plays_date on public.actions_plays(play_date desc);
create index idx_actions_plays_sport on public.actions_plays(sport_id);

comment on table public.actions_plays is 'Shared Action''s Plays ledger. One source of truth across all users.';

-- -----------------------------------------------------------------------------
-- 6. actions_bankroll — Action's running bankroll, per sport + global
-- -----------------------------------------------------------------------------
-- One row per sport, plus one 'all' row for combined.
create table public.actions_bankroll (
  sport_id text primary key references public.sports(id),
  starting_bankroll numeric(12,2) not null default 10000.00,
  current_bankroll numeric(12,2) not null default 10000.00,
  total_wins integer not null default 0,
  total_losses integer not null default 0,
  total_pushes integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Seed all 5 sports with $10,000 starting bankrolls
insert into public.actions_bankroll (sport_id) values
  ('mlb'), ('nhl'), ('nba'), ('nfl'), ('golf');

-- -----------------------------------------------------------------------------
-- 7. settings — per-user dashboard preferences
-- -----------------------------------------------------------------------------
create table public.settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferences jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.settings is 'Per-user dashboard preferences (theme, default sport, etc.) as JSON.';

-- =============================================================================
-- TRIGGERS — auto-update `updated_at` columns
-- =============================================================================
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_profiles_updated_at        before update on public.profiles
  for each row execute function public.tg_set_updated_at();
create trigger trg_subscriptions_updated_at   before update on public.subscriptions
  for each row execute function public.tg_set_updated_at();
create trigger trg_plays_updated_at           before update on public.plays
  for each row execute function public.tg_set_updated_at();
create trigger trg_actions_plays_updated_at   before update on public.actions_plays
  for each row execute function public.tg_set_updated_at();
create trigger trg_settings_updated_at        before update on public.settings
  for each row execute function public.tg_set_updated_at();

-- =============================================================================
-- TRIGGER — auto-create profile + settings when a new auth.users row appears
-- =============================================================================
-- When someone signs up via Supabase Auth, this fires and creates their
-- profile + settings rows automatically. They start with $10K bankroll.
create or replace function public.tg_handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (user_id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  insert into public.settings (user_id) values (new.id);
  return new;
end;
$$;

create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.tg_handle_new_user();

-- =============================================================================
-- ROW-LEVEL SECURITY (RLS)
-- =============================================================================
-- This is the security model. Without RLS, any logged-in user could read
-- any other user's plays. With RLS, the database itself enforces "you can
-- only see/edit your own rows" at every query.
-- =============================================================================

-- Enable RLS on every user-scoped table
alter table public.profiles      enable row level security;
alter table public.subscriptions enable row level security;
alter table public.plays         enable row level security;
alter table public.settings      enable row level security;

-- Public-readable tables (no RLS needed but enable for safety)
alter table public.sports            enable row level security;
alter table public.actions_plays     enable row level security;
alter table public.actions_bankroll  enable row level security;

-- ─── helper: is current user an admin? ───
create or replace function public.is_admin()
returns boolean language sql stable security definer as $$
  select coalesce(
    (select is_admin from public.profiles where user_id = auth.uid()),
    false
  );
$$;

-- ─── profiles policies ───
create policy "Users can view their own profile"
  on public.profiles for select using (auth.uid() = user_id);

create policy "Users can update their own profile"
  on public.profiles for update using (auth.uid() = user_id);

create policy "Admins can view all profiles"
  on public.profiles for select using (public.is_admin());

create policy "Admins can update all profiles"
  on public.profiles for update using (public.is_admin());

-- ─── subscriptions policies ───
create policy "Users can view their own subscriptions"
  on public.subscriptions for select using (auth.uid() = user_id);

create policy "Admins can view all subscriptions"
  on public.subscriptions for select using (public.is_admin());

-- (No insert/update from users — only the server with service_role key can
--  modify subscriptions, driven by Stripe webhooks.)

-- ─── plays policies ───
create policy "Users can view their own plays"
  on public.plays for select using (auth.uid() = user_id);

create policy "Users can insert their own plays"
  on public.plays for insert with check (auth.uid() = user_id);

create policy "Users can update their own plays"
  on public.plays for update using (auth.uid() = user_id);

create policy "Users can delete their own plays"
  on public.plays for delete using (auth.uid() = user_id);

create policy "Admins can view all plays"
  on public.plays for select using (public.is_admin());

-- ─── settings policies ───
create policy "Users manage their own settings"
  on public.settings for all using (auth.uid() = user_id);

-- ─── public read-only tables ───
create policy "Anyone can read sports"
  on public.sports for select using (true);

create policy "Subscribed users can read actions_plays for their sports"
  on public.actions_plays for select using (
    public.is_admin() or exists (
      select 1 from public.subscriptions s
      where s.user_id = auth.uid()
        and s.sport_id = actions_plays.sport_id
        and s.status = 'active'
    )
  );

create policy "Subscribed users can read actions_bankroll for their sports"
  on public.actions_bankroll for select using (
    public.is_admin() or exists (
      select 1 from public.subscriptions s
      where s.user_id = auth.uid()
        and s.sport_id = actions_bankroll.sport_id
        and s.status = 'active'
    )
  );

-- =============================================================================
-- DONE
-- =============================================================================
-- Next step: deploy the auth pages, sign up your admin account at
--           actionsodds.com/signup.html, then run migration 02 to flag
--           your account as admin and import your existing ledger.
